mod vault;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use include_dir::{include_dir, Dir};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tiny_http::{Header, Response, Server};
use vault::VaultState;

/// Frontend assets baked into the binary at compile time (from ../dist).
/// Served from 127.0.0.1 so Clash/TUN never sees tauri.localhost.
static UI: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist");

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "jfif", "tif", "tiff",
];

const THUMB_MAX: u32 = 280;
const MAX_THUMB_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
    pub path: String,
    pub name: String,
    /// Pixel size from file headers (for waterfall aspect-ratio slots).
    pub width: u32,
    pub height: u32,
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

/// Read dimensions from headers only (no full decode) — used by masonry packing.
fn image_dimensions(path: &Path) -> (u32, u32) {
    image::ImageReader::open(path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok())
        .filter(|(w, h)| *w > 0 && *h > 0)
        .unwrap_or((1, 1))
}

fn collect_images(dir: &Path, out: &mut Vec<ImageEntry>, depth: u32) -> Result<(), String> {
    if depth > 3 {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => return Err(format!("无法读取目录：{e}")),
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            let _ = collect_images(&path, out, depth + 1);
        } else if path.is_file() && is_image(&path) {
            let (width, height) = image_dimensions(&path);
            out.push(ImageEntry {
                path: path.to_string_lossy().to_string(),
                name,
                width,
                height,
            });
        }
    }
    Ok(())
}

#[tauri::command]
fn list_images(root: String) -> Result<Vec<ImageEntry>, String> {
    let root = PathBuf::from(root.trim());
    if !root.is_dir() {
        return Err("图库路径不是有效文件夹".into());
    }
    let mut images = Vec::new();
    collect_images(&root, &mut images, 0)?;
    images.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });
    if images.len() > 3000 {
        images.truncate(3000);
    }
    Ok(images)
}

#[tauri::command]
fn delete_image(path: String) -> Result<(), String> {
    let path = PathBuf::from(path.trim());
    if !path.is_file() {
        return Err("文件不存在".into());
    }
    if !is_image(&path) {
        return Err("不是支持的图片文件".into());
    }
    fs::remove_file(&path).map_err(|e| format!("删除失败：{e}"))
}

fn file_stamp(path: &Path) -> String {
    let meta = fs::metadata(path).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{len}:{modified}")
}

fn cache_key(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(b"|");
    hasher.update(file_stamp(path).as_bytes());
    hasher.update(b"|v4");
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn thumbs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法定位缓存目录：{e}"))?
        .join("thumbs");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建缩略图目录：{e}"))?;
    Ok(dir)
}

fn flatten_to_rgb(img: image::DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = image::RgbImage::new(w, h);
    let bg = [0x17u8, 0x1a, 0x21];
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as f32 / 255.0;
        let inv = 1.0 - a;
        let r = (p[0] as f32 * a + bg[0] as f32 * inv).round() as u8;
        let g = (p[1] as f32 * a + bg[1] as f32 * inv).round() as u8;
        let b = (p[2] as f32 * a + bg[2] as f32 * inv).round() as u8;
        out.put_pixel(x, y, image::Rgb([r, g, b]));
    }
    out
}

fn make_thumbnail_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if meta.len() > MAX_THUMB_BYTES {
        return Err("文件过大，跳过缩略图".into());
    }

    let img = image::ImageReader::open(path)
        .map_err(|e| format!("打开图片失败：{e}"))?
        .with_guessed_format()
        .map_err(|e| format!("识别图片格式失败：{e}"))?
        .decode()
        .map_err(|e| format!("解码图片失败：{e}"))?;

    if img.width() > 12000 || img.height() > 12000 {
        return Err("尺寸过大，跳过缩略图".into());
    }

    let thumb = img.thumbnail(THUMB_MAX, THUMB_MAX);
    let rgb = flatten_to_rgb(thumb);
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 70);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("编码缩略图失败：{e}"))?;
    Ok(buf.into_inner())
}

fn bytes_to_data_url(jpeg: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", B64.encode(jpeg))
}

#[tauri::command]
async fn get_thumbnail(app: AppHandle, path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(path.trim());
    if !path_buf.is_file() || !is_image(&path_buf) {
        return Err("无效图片".into());
    }

    let key = cache_key(&path_buf);
    let cache_file = thumbs_dir(&app)?.join(format!("{key}.jpg"));

    if cache_file.is_file() {
        match fs::read(&cache_file) {
            Ok(jpeg) if !jpeg.is_empty() => return Ok(bytes_to_data_url(&jpeg)),
            _ => {
                let _ = fs::remove_file(&cache_file);
            }
        }
    }

    let src = path_buf;
    let dest = cache_file;
    tauri::async_runtime::spawn_blocking(move || {
        let result = panic::catch_unwind(AssertUnwindSafe(|| make_thumbnail_jpeg(&src)));
        match result {
            Ok(Ok(jpeg)) => {
                let _ = fs::write(&dest, &jpeg);
                Ok(bytes_to_data_url(&jpeg))
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("缩略图生成崩溃，已跳过".into()),
        }
    })
    .await
    .map_err(|e| format!("缩略图任务失败：{e}"))?
}

/// Pure local UI server on 127.0.0.1 (never leaves the machine, never needs system proxy).
fn spawn_local_ui_server() -> u16 {
    let server = Server::http("127.0.0.1:0").expect("无法绑定本地界面服务 127.0.0.1");
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
    };

    std::thread::Builder::new()
        .name("flyphoto-ui".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                let raw = request.url().to_string();
                let (path_part, query) = match raw.split_once('?') {
                    Some((p, q)) => (p, q),
                    None => (raw.as_str(), ""),
                };

                // Stream real disk images for the lightbox (avoid asset.localhost + proxy).
                if path_part == "/__file" {
                    let file_path = query
                        .split('&')
                        .find_map(|pair| {
                            let (k, v) = pair.split_once('=')?;
                            if k == "p" {
                                Some(urlencoding_decode(v))
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default();
                    let path = PathBuf::from(&file_path);
                    if path.is_file() && is_image(&path) {
                        match fs::read(&path) {
                            Ok(bytes) => {
                                let mime = mime_guess::from_path(&path)
                                    .first_or_octet_stream()
                                    .essence_str()
                                    .to_string();
                                let header =
                                    Header::from_bytes("Content-Type", mime.as_bytes()).unwrap();
                                let _ = request.respond(Response::from_data(bytes).with_header(header));
                            }
                            Err(_) => {
                                let _ = request.respond(Response::empty(404));
                            }
                        }
                    } else {
                        let _ = request.respond(Response::empty(404));
                    }
                    continue;
                }

                let rel = if path_part == "/" || path_part.is_empty() {
                    "index.html"
                } else {
                    path_part.trim_start_matches('/')
                };

                if let Some(file) = UI.get_file(rel) {
                    let mime = mime_guess::from_path(rel)
                        .first_or_octet_stream()
                        .essence_str()
                        .to_string();
                    let header = Header::from_bytes("Content-Type", mime.as_bytes()).unwrap();
                    let _ = request.respond(
                        Response::from_data(file.contents()).with_header(header),
                    );
                } else {
                    let _ = request.respond(Response::empty(404));
                }
            }
        })
        .expect("无法启动本地界面线程");

    port
}

/// Minimal URL decode for path query (handles %XX and +).
fn urlencoding_decode(s: &str) -> String {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let h = || {
                    let hi = (bytes[i + 1] as char).to_digit(16)?;
                    let lo = (bytes[i + 2] as char).to_digit(16)?;
                    Some((hi * 16 + lo) as u8)
                };
                if let Some(b) = h() {
                    out.push(b);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Start pure-local UI host before the window opens.
    let ui_port = spawn_local_ui_server();
    let ui_origin = format!("http://127.0.0.1:{ui_port}");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(VaultState::default())
        .setup(move |app| {
            let origin = ui_origin.clone();
            let url: url::Url = format!("{origin}/").parse().expect("UI URL");

            // Allow IPC from 127.0.0.1 origin (not tauri.localhost).
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("local-ui")
                    .remote(origin.clone())
                    .remote(format!("{origin}/*"))
                    .window("main")
                    .permission("core:default")
                    .permission("core:window:allow-minimize")
                    .permission("core:window:allow-maximize")
                    .permission("core:window:allow-unmaximize")
                    .permission("core:window:allow-toggle-maximize")
                    .permission("core:window:allow-close")
                    .permission("core:window:allow-is-maximized")
                    .permission("core:window:allow-start-dragging")
                    .permission("allow-list-images")
                    .permission("allow-delete-image")
                    .permission("allow-get-thumbnail")
                    .permission("allow-vault-status")
                    .permission("allow-vault-setup")
                    .permission("allow-vault-unlock")
                    .permission("allow-vault-lock")
                    .permission("allow-vault-list")
                    .permission("allow-vault-upsert")
                    .permission("allow-vault-delete")
                    .permission("allow-vault-clear-destroyed")
                    .permission("dialog:default")
                    .permission("clipboard-manager:default")
                    .permission("store:default")
                    .permission("fs:default")
                    .permission("opener:default"),
            )?;

            let init_script = format!(
                "window.__FLYPHOTO_ORIGIN__={};",
                serde_json::to_string(&origin).unwrap()
            );

            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("FLYPHOTO")
                .inner_size(1280.0, 840.0)
                .min_inner_size(720.0, 480.0)
                .center()
                .focused(true)
                // Single custom title bar only (min / max / close drawn in UI).
                .decorations(false)
                .initialization_script(&init_script);

            #[cfg(windows)]
            {
                builder = builder.additional_browser_args(
                    "--no-proxy-server --proxy-server=direct:// --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
                );
            }

            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_images,
            delete_image,
            get_thumbnail,
            vault::vault_status,
            vault::vault_setup,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_list,
            vault::vault_upsert,
            vault::vault_delete,
            vault::vault_clear_destroyed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
