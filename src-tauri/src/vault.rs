//! Local password vault: AES-256-GCM + Argon2id, 50 wrong unlocks → permanent wipe.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const MAX_FAILS: u32 = 50;
const VAULT_FILE: &str = "passbox.vault.json";
const DESTROYED_FLAG: &str = "passbox.destroyed";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryType {
    Api,
    Bank,
    Account,
    /// 游戏账号密码
    Game,
    /// 抖音账号密码
    Douyin,
    /// X（Twitter）账号密码
    X,
    /// 谷歌账号密码
    Google,
    /// Apple ID
    Apple,
    Note,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub entry_type: EntryType,
    pub title: String,
    /// Type-specific fields (url/key, cardNumber, username/password, body, …).
    pub fields: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub note: String,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultDisk {
    version: u32,
    salt_b64: String,
    nonce_b64: String,
    ciphertext_b64: String,
    hint1: String,
    hint2: String,
    fail_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// none | locked | unlocked | destroyed
    pub state: String,
    pub hint1: String,
    pub hint2: String,
    pub fail_count: u32,
    pub entry_count: u32,
}

struct Session {
    key: [u8; 32],
    entries: Vec<VaultEntry>,
    hint1: String,
    hint2: String,
}

pub struct VaultState {
    session: Mutex<Option<Session>>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

fn vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录：{e}"))?
        .join("passbox");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建密码箱目录：{e}"))?;
    Ok(dir)
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vault_dir(app)?.join(VAULT_FILE))
}

fn destroyed_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vault_dir(app)?.join(DESTROYED_FLAG))
}

fn is_destroyed(app: &AppHandle) -> bool {
    destroyed_path(app).map(|p| p.is_file()).unwrap_or(false)
}

fn load_disk(app: &AppHandle) -> Result<Option<VaultDisk>, String> {
    let path = vault_path(app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取密码箱失败：{e}"))?;
    let disk: VaultDisk =
        serde_json::from_str(&raw).map_err(|e| format!("密码箱文件损坏：{e}"))?;
    Ok(Some(disk))
}

fn save_disk(app: &AppHandle, disk: &VaultDisk) -> Result<(), String> {
    let path = vault_path(app)?;
    let raw = serde_json::to_string_pretty(disk).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(&path, raw).map_err(|e| format!("写入密码箱失败：{e}"))
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("密钥派生失败：{e}"))?;
    Ok(key)
}

fn encrypt_entries(key: &[u8; 32], entries: &[VaultEntry]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let plain = serde_json::to_vec(entries).map_err(|e| format!("编码条目失败：{e}"))?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("加密初始化失败：{e}"))?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plain.as_ref())
        .map_err(|e| format!("加密失败：{e}"))?;
    Ok((nonce_bytes.to_vec(), ciphertext))
}

/// Ok(entries) | Err((is_wrong_password, message))
fn decrypt_entries(
    key: &[u8; 32],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<VaultEntry>, (bool, String)> {
    if nonce.len() != 12 {
        return Err((false, "密码箱数据损坏".into()));
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| (false, format!("解密初始化失败：{e}")))?;
    let nonce = Nonce::from_slice(nonce);
    let plain = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| (true, "密码错误".to_string()))?;
    // 解密成功但 JSON 解析失败：绝不当「密码错误」计次，否则会误销毁
    serde_json::from_slice(&plain).map_err(|e| (false, format!("条目数据损坏：{e}")))
}

fn wipe_vault(app: &AppHandle) -> Result<(), String> {
    let path = vault_path(app)?;
    if path.is_file() {
        // Overwrite then remove (best-effort local wipe).
        if let Ok(meta) = fs::metadata(&path) {
            let len = meta.len() as usize;
            let junk = vec![0u8; len.min(4 * 1024 * 1024)];
            let _ = fs::write(&path, &junk);
        }
        let _ = fs::remove_file(&path);
    }
    let flag = destroyed_path(app)?;
    fs::write(&flag, b"destroyed").map_err(|e| format!("写入销毁标记失败：{e}"))?;
    Ok(())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[tauri::command]
pub fn vault_status(app: AppHandle, state: State<'_, VaultState>) -> Result<VaultStatus, String> {
    if is_destroyed(&app) {
        return Ok(VaultStatus {
            state: "destroyed".into(),
            hint1: String::new(),
            hint2: String::new(),
            fail_count: MAX_FAILS,
            entry_count: 0,
        });
    }

    {
        let session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
        if let Some(s) = session.as_ref() {
            return Ok(VaultStatus {
                state: "unlocked".into(),
                hint1: s.hint1.clone(),
                hint2: s.hint2.clone(),
                fail_count: 0,
                entry_count: s.entries.len() as u32,
            });
        }
    }

    match load_disk(&app)? {
        None => Ok(VaultStatus {
            state: "none".into(),
            hint1: String::new(),
            hint2: String::new(),
            fail_count: 0,
            entry_count: 0,
        }),
        Some(disk) => Ok(VaultStatus {
            state: "locked".into(),
            hint1: disk.hint1,
            hint2: disk.hint2,
            fail_count: disk.fail_count,
            entry_count: 0,
        }),
    }
}

#[tauri::command]
pub fn vault_setup(
    app: AppHandle,
    state: State<'_, VaultState>,
    password: String,
    hint1: String,
    hint2: String,
) -> Result<VaultStatus, String> {
    if is_destroyed(&app) {
        // Allow starting over only after explicit clear of destroyed flag is not offered —
        // but user may want a new box after wipe. Spec: content destroyed permanently.
        // Re-creating a fresh empty vault is fine; remove destroyed flag.
        let _ = fs::remove_file(destroyed_path(&app)?);
    }

    if load_disk(&app)?.is_some() {
        return Err("密码箱已存在，请先解锁".into());
    }

    let password = password.trim().to_string();
    if password.len() < 4 {
        return Err("密码至少 4 位".into());
    }

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(&password, &salt)?;
    let entries: Vec<VaultEntry> = Vec::new();
    let (nonce, ciphertext) = encrypt_entries(&key, &entries)?;

    let disk = VaultDisk {
        version: 1,
        salt_b64: B64.encode(salt),
        nonce_b64: B64.encode(&nonce),
        ciphertext_b64: B64.encode(&ciphertext),
        hint1: hint1.trim().to_string(),
        hint2: hint2.trim().to_string(),
        fail_count: 0,
    };
    save_disk(&app, &disk)?;

    let mut session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
    *session = Some(Session {
        key,
        entries,
        hint1: disk.hint1.clone(),
        hint2: disk.hint2.clone(),
    });

    Ok(VaultStatus {
        state: "unlocked".into(),
        hint1: disk.hint1,
        hint2: disk.hint2,
        fail_count: 0,
        entry_count: 0,
    })
}

#[tauri::command]
pub fn vault_unlock(
    app: AppHandle,
    state: State<'_, VaultState>,
    password: String,
) -> Result<Vec<VaultEntry>, String> {
    if is_destroyed(&app) {
        return Err("密码箱已销毁".into());
    }

    let mut disk = load_disk(&app)?.ok_or_else(|| "尚未创建密码箱".to_string())?;
    let salt = B64
        .decode(&disk.salt_b64)
        .map_err(|_| "密码箱数据损坏".to_string())?;
    let nonce = B64
        .decode(&disk.nonce_b64)
        .map_err(|_| "密码箱数据损坏".to_string())?;
    let ciphertext = B64
        .decode(&disk.ciphertext_b64)
        .map_err(|_| "密码箱数据损坏".to_string())?;

    let key = derive_key(password.trim(), &salt)?;
    match decrypt_entries(&key, &nonce, &ciphertext) {
        Ok(entries) => {
            disk.fail_count = 0;
            // Re-save with reset fail count (same ciphertext).
            save_disk(&app, &disk)?;
            let mut session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
            *session = Some(Session {
                key,
                entries: entries.clone(),
                hint1: disk.hint1,
                hint2: disk.hint2,
            });
            Ok(entries)
        }
        Err((true, _)) => {
            // 仅「密码错误」计次；数据损坏不计次、不销毁
            disk.fail_count = disk.fail_count.saturating_add(1);
            if disk.fail_count >= MAX_FAILS {
                {
                    let mut session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
                    *session = None;
                }
                wipe_vault(&app)?;
                // 固定文案，供前端精确识别（勿在普通错误提示里写「已永久销毁」）
                return Err("VAULT_DESTROYED".into());
            }
            save_disk(&app, &disk)?;
            Err(format!(
                "密码错误 · {} / {} 次 · 再错 {} 次将清空箱内全部数据",
                disk.fail_count,
                MAX_FAILS,
                MAX_FAILS.saturating_sub(disk.fail_count)
            ))
        }
        Err((false, msg)) => Err(msg),
    }
}

#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
    *session = None;
    Ok(())
}

#[tauri::command]
pub fn vault_list(state: State<'_, VaultState>) -> Result<Vec<VaultEntry>, String> {
    let session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
    let s = session.as_ref().ok_or_else(|| "密码箱未解锁".to_string())?;
    Ok(s.entries.clone())
}

fn persist_session(app: &AppHandle, session: &Session) -> Result<(), String> {
    let mut disk = load_disk(app)?.ok_or_else(|| "密码箱不存在".to_string())?;
    let (nonce, ciphertext) = encrypt_entries(&session.key, &session.entries)?;
    disk.nonce_b64 = B64.encode(&nonce);
    disk.ciphertext_b64 = B64.encode(&ciphertext);
    disk.fail_count = 0;
    save_disk(app, &disk)
}

#[tauri::command]
pub fn vault_upsert(
    app: AppHandle,
    state: State<'_, VaultState>,
    entry: VaultEntry,
) -> Result<Vec<VaultEntry>, String> {
    let mut session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
    let s = session.as_mut().ok_or_else(|| "密码箱未解锁".to_string())?;

    let mut e = entry;
    if e.id.trim().is_empty() {
        e.id = new_id();
    }
    e.title = e.title.trim().to_string();
    if e.title.is_empty() {
        return Err("标题不能为空".into());
    }
    e.updated_at = now_ms();

    if let Some(pos) = s.entries.iter().position(|x| x.id == e.id) {
        s.entries[pos] = e;
    } else {
        s.entries.insert(0, e);
    }

    persist_session(&app, s)?;
    Ok(s.entries.clone())
}

#[tauri::command]
pub fn vault_delete(
    app: AppHandle,
    state: State<'_, VaultState>,
    id: String,
) -> Result<Vec<VaultEntry>, String> {
    let mut session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
    let s = session.as_mut().ok_or_else(|| "密码箱未解锁".to_string())?;
    s.entries.retain(|x| x.id != id);
    persist_session(&app, s)?;
    Ok(s.entries.clone())
}

#[tauri::command]
pub fn vault_clear_destroyed(app: AppHandle) -> Result<(), String> {
    // After destroy screen, user may create a new empty vault — drop flag only.
    let flag = destroyed_path(&app)?;
    if flag.is_file() {
        fs::remove_file(&flag).map_err(|e| format!("清除销毁标记失败：{e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_entries() -> Vec<VaultEntry> {
        vec![
            VaultEntry {
                id: "a1".into(),
                entry_type: EntryType::Api,
                title: "OpenAI".into(),
                fields: {
                    let mut m = serde_json::Map::new();
                    m.insert("url".into(), json!("https://api.openai.com/v1"));
                    m.insert("keys".into(), json!(["sk-test-1", "sk-test-2"]));
                    m
                },
                note: "prod".into(),
                updated_at: 1,
            },
            VaultEntry {
                id: "b1".into(),
                entry_type: EntryType::Bank,
                title: "招行".into(),
                fields: {
                    let mut m = serde_json::Map::new();
                    m.insert("cardNumber".into(), json!("622200001111"));
                    m
                },
                note: "".into(),
                updated_at: 2,
            },
            VaultEntry {
                id: "g1".into(),
                entry_type: EntryType::Game,
                title: "Steam".into(),
                fields: {
                    let mut m = serde_json::Map::new();
                    m.insert("username".into(), json!("player"));
                    m.insert("password".into(), json!("secret"));
                    m
                },
                note: "".into(),
                updated_at: 3,
            },
            VaultEntry {
                id: "d1".into(),
                entry_type: EntryType::Douyin,
                title: "抖音".into(),
                fields: {
                    let mut m = serde_json::Map::new();
                    m.insert("username".into(), json!("dy_user"));
                    m.insert("password".into(), json!("dy_pass"));
                    m
                },
                note: "".into(),
                updated_at: 4,
            },
            VaultEntry {
                id: "x1".into(),
                entry_type: EntryType::X,
                title: "X".into(),
                fields: {
                    let mut m = serde_json::Map::new();
                    m.insert("username".into(), json!("@me"));
                    m.insert("password".into(), json!("xpass"));
                    m
                },
                note: "".into(),
                updated_at: 5,
            },
            VaultEntry {
                id: "go1".into(),
                entry_type: EntryType::Google,
                title: "Gmail".into(),
                fields: {
                    let mut m = serde_json::Map::new();
                    m.insert("username".into(), json!("a@gmail.com"));
                    m.insert("password".into(), json!("gpw"));
                    m
                },
                note: "".into(),
                updated_at: 6,
            },
            VaultEntry {
                id: "ap1".into(),
                entry_type: EntryType::Apple,
                title: "Apple ID".into(),
                fields: {
                    let mut m = serde_json::Map::new();
                    m.insert("username".into(), json!("a@icloud.com"));
                    m.insert("password".into(), json!("apw"));
                    m
                },
                note: "".into(),
                updated_at: 7,
            },
        ]
    }

    #[test]
    fn argon2_same_password_same_salt_same_key() {
        let salt = [7u8; 16];
        let k1 = derive_key("test-pass-1234", &salt).unwrap();
        let k2 = derive_key("test-pass-1234", &salt).unwrap();
        assert_eq!(k1, k2);
    }

    #[test]
    fn argon2_different_password_different_key() {
        let salt = [9u8; 16];
        let k1 = derive_key("password-a", &salt).unwrap();
        let k2 = derive_key("password-b", &salt).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn encrypt_decrypt_roundtrip_all_types() {
        let salt = [1u8; 16];
        let key = derive_key("correct-horse-battery", &salt).unwrap();
        let entries = sample_entries();
        let (nonce, ct) = encrypt_entries(&key, &entries).unwrap();
        assert_eq!(nonce.len(), 12);
        assert!(!ct.is_empty());
        let out = decrypt_entries(&key, &nonce, &ct).unwrap();
        assert_eq!(out.len(), entries.len());
        assert_eq!(out[0].title, "OpenAI");
        assert_eq!(out[0].entry_type, EntryType::Api);
        assert_eq!(out[1].entry_type, EntryType::Bank);
        assert_eq!(out[2].entry_type, EntryType::Game);
        assert_eq!(out[6].entry_type, EntryType::Apple);
        let keys = out[0].fields.get("keys").unwrap().as_array().unwrap();
        assert_eq!(keys.len(), 2);
    }

    #[test]
    fn wrong_password_is_flagged_wrong_password() {
        let salt = [2u8; 16];
        let good = derive_key("right-password", &salt).unwrap();
        let bad = derive_key("wrong-password", &salt).unwrap();
        let (nonce, ct) = encrypt_entries(&good, &sample_entries()).unwrap();
        let err = decrypt_entries(&bad, &nonce, &ct).unwrap_err();
        assert!(err.0, "wrong password must set is_wrong_password=true");
        assert!(err.1.contains("密码错误"));
    }

    #[test]
    fn corrupt_nonce_is_not_wrong_password() {
        let salt = [3u8; 16];
        let key = derive_key("pw", &salt).unwrap();
        let (_nonce, ct) = encrypt_entries(&key, &[]).unwrap();
        let err = decrypt_entries(&key, &[0u8; 8], &ct).unwrap_err();
        assert!(!err.0, "corrupt data must NOT count as wrong password");
    }

    #[test]
    fn ciphertext_not_plaintext() {
        let salt = [4u8; 16];
        let key = derive_key("secret", &salt).unwrap();
        let entries = sample_entries();
        let plain = serde_json::to_vec(&entries).unwrap();
        let (_n, ct) = encrypt_entries(&key, &entries).unwrap();
        assert_ne!(ct, plain);
        // 密文里不应直接出现明文标题（AES-GCM 输出像随机）
        let ct_str = String::from_utf8_lossy(&ct);
        assert!(!ct_str.contains("OpenAI"));
        assert!(!ct_str.contains("sk-test-1"));
    }

    #[test]
    fn entry_type_json_camel_case() {
        let e = VaultEntry {
            id: "1".into(),
            entry_type: EntryType::Douyin,
            title: "t".into(),
            fields: serde_json::Map::new(),
            note: "".into(),
            updated_at: 0,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "douyin");
        assert_eq!(v["updatedAt"], 0);
        let back: VaultEntry = serde_json::from_value(v).unwrap();
        assert_eq!(back.entry_type, EntryType::Douyin);
    }

    #[test]
    fn max_fails_constant() {
        assert_eq!(MAX_FAILS, 50);
    }

    #[test]
    fn empty_vault_roundtrip() {
        let salt = [5u8; 16];
        let key = derive_key("empty-box", &salt).unwrap();
        let (nonce, ct) = encrypt_entries(&key, &[]).unwrap();
        let out = decrypt_entries(&key, &nonce, &ct).unwrap();
        assert!(out.is_empty());
    }
}
