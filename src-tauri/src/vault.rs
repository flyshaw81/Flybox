//! Local password vault: AES-256-GCM + Argon2id.
//! Progressive lock after every 5 wrong unlocks; after 9 stages (45 fails) permanent wipe.
//! Anti-tamper: sealed guard + exe fingerprint + debugger trip → wipe ALL app data.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 每错满 5 次升一档锁定；第 9 档（累计 45 次）永久销毁。
const FAILS_PER_STAGE: u32 = 5;
/// 各档锁定秒数：10m, 30m, 2h, 12h, 24h, 72h, 168h, 360h；下一档炸箱
const LOCK_SECS: &[u64] = &[
    10 * 60,
    30 * 60,
    2 * 3600,
    12 * 3600,
    24 * 3600,
    72 * 3600,
    168 * 3600,
    360 * 3600,
];
const DESTROY_AFTER_FAILS: u32 = (LOCK_SECS.len() as u32 + 1) * FAILS_PER_STAGE; // 45
const VAULT_FILE: &str = "passbox.vault.json";
const GUARD_FILE: &str = "passbox.guard";
const DESTROYED_FLAG: &str = "passbox.destroyed";
/// 守卫加密胡椒（二进制内常量；抬高改 JSON 的门槛，不能防住完整逆向）
const GUARD_PEPPER: &[u8] = b"FLYBOX/v2/guard-pepper/7f3a9c2e1b8d4f06a5e9c3b7d1f4a8e2";
const VAULT_FORMAT_VERSION: u32 = 2;

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
    /// 邮箱账号密码
    Email,
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
    /// 自上次成功解锁以来的累计错误次数
    fail_count: u32,
    /// 冷却截止时间（Unix 毫秒）；0 表示未冷却
    #[serde(default)]
    lock_until_ms: i64,
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
    /// 冷却截止 Unix 毫秒；0 表示可尝试解锁
    pub lock_until_ms: i64,
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

fn hex_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn secure_shred_file(path: &Path) {
    if !path.is_file() {
        return;
    }
    let len = fs::metadata(path)
        .map(|m| m.len() as usize)
        .unwrap_or(4096)
        .clamp(64, 4 * 1024 * 1024);
    for _ in 0..3 {
        let mut junk = vec![0u8; len];
        rand::thread_rng().fill_bytes(&mut junk);
        let _ = fs::write(path, &junk);
    }
    let _ = fs::write(path, []);
    let _ = fs::remove_file(path);
}

fn secure_shred_tree(dir: &Path) {
    if !dir.is_dir() {
        return;
    }
    if let Ok(rd) = fs::read_dir(dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                secure_shred_tree(&p);
                let _ = fs::remove_dir_all(&p);
            } else {
                secure_shred_file(&p);
            }
        }
    }
}

/// 炸干净：密码箱 + 整个应用数据目录（记事本/配置等）全部覆写删除，无备份。
fn wipe_all_app_data(app: &AppHandle) -> Result<(), String> {
    // 先清会话
    // session cleared by callers when they hold state

    if let Ok(root) = app.path().app_data_dir() {
        // 保留根目录本身，清空内容
        if root.is_dir() {
            if let Ok(rd) = fs::read_dir(&root) {
                for ent in rd.flatten() {
                    let p = ent.path();
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    // destroyed 标记稍后写在 passbox/ 下
                    if p.is_dir() {
                        secure_shred_tree(&p);
                        let _ = fs::remove_dir_all(&p);
                    } else if name != DESTROYED_FLAG {
                        secure_shred_file(&p);
                    }
                }
            }
        }
        let _ = fs::create_dir_all(root.join("passbox"));
    } else if let Ok(dir) = vault_dir(app) {
        secure_shred_tree(&dir);
    }

    let flag = destroyed_path(app)?;
    if let Some(parent) = flag.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&flag, b"destroyed-tamper-or-fails").map_err(|e| format!("写入销毁标记失败：{e}"))?;
    Ok(())
}

fn guard_key() -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(GUARD_PEPPER);
    h.update(b"|flybox.guard.v2|");
    let out = h.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

fn guard_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vault_dir(app)?.join(GUARD_FILE))
}

fn vault_fingerprint(disk: &VaultDisk) -> String {
    let mut h = Sha256::new();
    h.update(disk.salt_b64.as_bytes());
    h.update(b"|");
    h.update(disk.nonce_b64.as_bytes());
    h.update(b"|");
    h.update(disk.ciphertext_b64.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn current_exe_hash() -> String {
    // 开发版每次编译 exe 都会变，debug 不绑死指纹，避免误炸
    if cfg!(debug_assertions) {
        return "DEBUG".into();
    }
    match std::env::current_exe().and_then(|p| fs::read(p)) {
        Ok(bytes) => hex_sha256(&bytes),
        Err(_) => "UNKNOWN".into(),
    }
}

#[cfg(windows)]
fn debugger_present() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn IsDebuggerPresent() -> i32;
    }
    unsafe { IsDebuggerPresent() != 0 }
}

#[cfg(not(windows))]
fn debugger_present() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GuardBlob {
    version: u32,
    exe_hash: String,
    fail_count: u32,
    lock_until_ms: i64,
    vault_fp: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct GuardDisk {
    nonce_b64: String,
    ciphertext_b64: String,
}

fn write_guard(app: &AppHandle, disk: &VaultDisk) -> Result<(), String> {
    let blob = GuardBlob {
        version: 1,
        exe_hash: current_exe_hash(),
        fail_count: disk.fail_count,
        lock_until_ms: disk.lock_until_ms,
        vault_fp: vault_fingerprint(disk),
    };
    let plain = serde_json::to_vec(&blob).map_err(|e| format!("守卫序列化失败：{e}"))?;
    let key = guard_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("守卫加密初始化失败：{e}"))?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plain.as_ref())
        .map_err(|e| format!("守卫加密失败：{e}"))?;
    let g = GuardDisk {
        nonce_b64: B64.encode(nonce_bytes),
        ciphertext_b64: B64.encode(&ciphertext),
    };
    let path = guard_path(app)?;
    let raw = serde_json::to_string(&g).map_err(|e| format!("守卫写入失败：{e}"))?;
    fs::write(&path, raw).map_err(|e| format!("守卫写入失败：{e}"))
}

fn read_guard(app: &AppHandle) -> Result<Option<GuardBlob>, String> {
    let path = guard_path(app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取守卫失败：{e}"))?;
    let g: GuardDisk =
        serde_json::from_str(&raw).map_err(|_| "守卫损坏".to_string())?;
    let nonce = B64
        .decode(&g.nonce_b64)
        .map_err(|_| "守卫损坏".to_string())?;
    let ct = B64
        .decode(&g.ciphertext_b64)
        .map_err(|_| "守卫损坏".to_string())?;
    if nonce.len() != 12 {
        return Err("守卫损坏".into());
    }
    let key = guard_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("守卫解密初始化失败：{e}"))?;
    let nonce = Nonce::from_slice(&nonce);
    let plain = cipher
        .decrypt(nonce, ct.as_ref())
        .map_err(|_| "守卫损坏".to_string())?;
    let blob: GuardBlob =
        serde_json::from_slice(&plain).map_err(|_| "守卫损坏".to_string())?;
    Ok(Some(blob))
}

/// 完整性校验；篡改 / 调试器 → 清空全部应用数据并返回 VAULT_DESTROYED。
fn integrity_check(app: &AppHandle, state: &VaultState) -> Result<(), String> {
    if is_destroyed(app) {
        return Ok(());
    }

    if debugger_present() {
        let _ = state.session.lock().map(|mut s| *s = None);
        let _ = wipe_all_app_data(app);
        return Err("VAULT_DESTROYED".into());
    }

    let vault = load_disk(app)?;
    let guard = match read_guard(app) {
        Ok(g) => g,
        Err(_) => {
            // 守卫被改坏 = 视为破解
            let _ = state.session.lock().map(|mut s| *s = None);
            let _ = wipe_all_app_data(app);
            return Err("VAULT_DESTROYED".into());
        }
    };

    match (vault, guard) {
        (None, None) => Ok(()),
        (None, Some(_)) => {
            // 有守卫无箱：异常
            let _ = state.session.lock().map(|mut s| *s = None);
            let _ = wipe_all_app_data(app);
            Err("VAULT_DESTROYED".into())
        }
        (Some(disk), None) => {
            // 缺守卫：补写即可（升级/迁移常见），绝不因缺守卫销毁
            let mut d = disk;
            if d.version < VAULT_FORMAT_VERSION {
                d.version = VAULT_FORMAT_VERSION;
                save_disk(app, &d)?;
            }
            write_guard(app, &d)?;
            Ok(())
        }
        (Some(disk), Some(g)) => {
            let fp = vault_fingerprint(&disk);
            // 只有「箱子内容 / 失败次数被改」才当篡改。exe 指纹变化 = 正常升级/重装，只重封守卫。
            let meta_ok = g.fail_count == disk.fail_count
                && g.lock_until_ms == disk.lock_until_ms
                && g.vault_fp == fp;
            if !meta_ok {
                let _ = state.session.lock().map(|mut s| *s = None);
                let _ = wipe_all_app_data(app);
                return Err("VAULT_DESTROYED".into());
            }
            let exe = current_exe_hash();
            let exe_ok = g.exe_hash == "DEBUG"
                || exe == "DEBUG"
                || g.exe_hash == exe
                || g.exe_hash == "UNKNOWN"
                || exe == "UNKNOWN";
            if !exe_ok {
                // 正式版安装包每次编译 hash 都不同；绑死 exe 会在「打包安装最新版」时误炸用户数据
                write_guard(app, &disk)?;
            }
            Ok(())
        }
    }
}

fn save_disk_and_guard(app: &AppHandle, disk: &VaultDisk) -> Result<(), String> {
    save_disk(app, disk)?;
    write_guard(app, disk)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn format_duration_zh(secs: u64) -> String {
    if secs >= 3600 {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        if m == 0 {
            format!("{h} 小时")
        } else {
            format!("{h} 小时 {m} 分钟")
        }
    } else if secs >= 60 {
        format!("{} 分钟", (secs + 59) / 60)
    } else {
        format!("{secs} 秒")
    }
}

/// 错满 5/10/…/40 次时返回应施加的锁定秒数；错满 45 次返回 None（应销毁）。
fn stage_lock_secs_after_fail(fail_count: u32) -> Option<Option<u64>> {
    if fail_count == 0 || fail_count % FAILS_PER_STAGE != 0 {
        return Some(None); // 未到档位，不改锁定
    }
    let stage = fail_count / FAILS_PER_STAGE; // 1..=9
    if stage as usize > LOCK_SECS.len() {
        return None; // 销毁
    }
    Some(Some(LOCK_SECS[(stage as usize) - 1]))
}

fn remaining_lock_secs(lock_until_ms: i64) -> u64 {
    let now = now_ms();
    if lock_until_ms <= now {
        return 0;
    }
    ((lock_until_ms - now) as u64).div_ceil(1000)
}

fn new_id() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[tauri::command]
pub fn vault_status(app: AppHandle, state: State<'_, VaultState>) -> Result<VaultStatus, String> {
    if let Err(e) = integrity_check(&app, &state) {
        if e == "VAULT_DESTROYED" {
            return Ok(VaultStatus {
                state: "destroyed".into(),
                hint1: String::new(),
                hint2: String::new(),
                fail_count: DESTROY_AFTER_FAILS,
                entry_count: 0,
                lock_until_ms: 0,
            });
        }
        return Err(e);
    }

    if is_destroyed(&app) {
        return Ok(VaultStatus {
            state: "destroyed".into(),
            hint1: String::new(),
            hint2: String::new(),
            fail_count: DESTROY_AFTER_FAILS,
            entry_count: 0,
            lock_until_ms: 0,
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
                lock_until_ms: 0,
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
            lock_until_ms: 0,
        }),
        Some(disk) => Ok(VaultStatus {
            state: "locked".into(),
            hint1: disk.hint1,
            hint2: disk.hint2,
            fail_count: disk.fail_count,
            entry_count: 0,
            lock_until_ms: disk.lock_until_ms,
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

    integrity_check(&app, &state)?;

    let disk = VaultDisk {
        version: VAULT_FORMAT_VERSION,
        salt_b64: B64.encode(salt),
        nonce_b64: B64.encode(&nonce),
        ciphertext_b64: B64.encode(&ciphertext),
        hint1: hint1.trim().to_string(),
        hint2: hint2.trim().to_string(),
        fail_count: 0,
        lock_until_ms: 0,
    };
    save_disk_and_guard(&app, &disk)?;

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
        lock_until_ms: 0,
    })
}

#[tauri::command]
pub fn vault_unlock(
    app: AppHandle,
    state: State<'_, VaultState>,
    password: String,
) -> Result<Vec<VaultEntry>, String> {
    integrity_check(&app, &state)?;

    if is_destroyed(&app) {
        return Err("密码箱已销毁".into());
    }

    let mut disk = load_disk(&app)?.ok_or_else(|| "尚未创建密码箱".to_string())?;

    // 冷却期内禁止尝试（不计次）
    let rem = remaining_lock_secs(disk.lock_until_ms);
    if rem > 0 {
        return Err(format!(
            "输错次数过多，已锁定 · 请 {} 后再试 · 累计错误 {} / {}",
            format_duration_zh(rem),
            disk.fail_count,
            DESTROY_AFTER_FAILS
        ));
    }
    // 冷却已过，清掉过期时间戳（次数保留，继续阶梯）
    if disk.lock_until_ms != 0 {
        disk.lock_until_ms = 0;
        let _ = save_disk_and_guard(&app, &disk);
    }

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
            disk.lock_until_ms = 0;
            disk.version = VAULT_FORMAT_VERSION;
            save_disk_and_guard(&app, &disk)?;
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

            match stage_lock_secs_after_fail(disk.fail_count) {
                None => {
                    // 第 9 档：累计 45 次 → 彻底炸箱（全部应用数据）
                    {
                        let mut session =
                            state.session.lock().map_err(|_| "内部锁错误".to_string())?;
                        *session = None;
                    }
                    wipe_all_app_data(&app)?;
                    return Err("VAULT_DESTROYED".into());
                }
                Some(Some(secs)) => {
                    disk.lock_until_ms = now_ms() + (secs as i64) * 1000;
                    save_disk_and_guard(&app, &disk)?;
                    let left = DESTROY_AFTER_FAILS.saturating_sub(disk.fail_count);
                    return Err(format!(
                        "密码错误 · 累计 {} 次 · 已锁定 {} · 再错 {} 次将永久销毁",
                        disk.fail_count,
                        format_duration_zh(secs),
                        left
                    ));
                }
                Some(None) => {
                    save_disk_and_guard(&app, &disk)?;
                    let next_stage_at =
                        ((disk.fail_count / FAILS_PER_STAGE) + 1) * FAILS_PER_STAGE;
                    let until_lock = next_stage_at.saturating_sub(disk.fail_count);
                    let left_destroy = DESTROY_AFTER_FAILS.saturating_sub(disk.fail_count);
                    Err(format!(
                        "密码错误 · 累计 {} 次 · 再错 {} 次将加长锁定 · 距销毁还剩 {} 次",
                        disk.fail_count, until_lock, left_destroy
                    ))
                }
            }
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

fn persist_session(app: &AppHandle, session: &Session) -> Result<(), String> {
    let mut disk = load_disk(app)?.ok_or_else(|| "密码箱不存在".to_string())?;
    let (nonce, ciphertext) = encrypt_entries(&session.key, &session.entries)?;
    disk.nonce_b64 = B64.encode(&nonce);
    disk.ciphertext_b64 = B64.encode(&ciphertext);
    disk.fail_count = 0;
    disk.lock_until_ms = 0;
    disk.version = VAULT_FORMAT_VERSION;
    save_disk_and_guard(app, &disk)
}

#[tauri::command]
pub fn vault_upsert(
    app: AppHandle,
    state: State<'_, VaultState>,
    entry: VaultEntry,
) -> Result<Vec<VaultEntry>, String> {
    integrity_check(&app, &state)?;
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
    integrity_check(&app, &state)?;
    let mut session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
    let s = session.as_mut().ok_or_else(|| "密码箱未解锁".to_string())?;
    s.entries.retain(|x| x.id != id);
    persist_session(&app, s)?;
    Ok(s.entries.clone())
}

#[tauri::command]
pub fn vault_list(app: AppHandle, state: State<'_, VaultState>) -> Result<Vec<VaultEntry>, String> {
    integrity_check(&app, &state)?;
    let session = state.session.lock().map_err(|_| "内部锁错误".to_string())?;
    let s = session.as_ref().ok_or_else(|| "密码箱未解锁".to_string())?;
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
    fn destroy_after_is_45() {
        assert_eq!(DESTROY_AFTER_FAILS, 45);
        assert_eq!(LOCK_SECS.len(), 8);
    }

    #[test]
    fn stage_lock_ladder() {
        assert_eq!(stage_lock_secs_after_fail(1), Some(None));
        assert_eq!(stage_lock_secs_after_fail(4), Some(None));
        assert_eq!(stage_lock_secs_after_fail(5), Some(Some(10 * 60)));
        assert_eq!(stage_lock_secs_after_fail(10), Some(Some(30 * 60)));
        assert_eq!(stage_lock_secs_after_fail(15), Some(Some(2 * 3600)));
        assert_eq!(stage_lock_secs_after_fail(20), Some(Some(12 * 3600)));
        assert_eq!(stage_lock_secs_after_fail(25), Some(Some(24 * 3600)));
        assert_eq!(stage_lock_secs_after_fail(30), Some(Some(72 * 3600)));
        assert_eq!(stage_lock_secs_after_fail(35), Some(Some(168 * 3600)));
        assert_eq!(stage_lock_secs_after_fail(40), Some(Some(360 * 3600)));
        assert_eq!(stage_lock_secs_after_fail(45), None);
        assert_eq!(stage_lock_secs_after_fail(50), None);
    }

    #[test]
    fn format_duration_basic() {
        assert_eq!(format_duration_zh(30), "30 秒");
        assert_eq!(format_duration_zh(600), "10 分钟");
        assert_eq!(format_duration_zh(7200), "2 小时");
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
