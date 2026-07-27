mod bass_ffi;
mod ffmpeg_util;
mod midi_mtc;
mod obs_ctrl;
mod sfx;
mod vault;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use include_dir::{include_dir, Dir};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tiny_http::{Header, Response, Server, StatusCode};
use midi_mtc::MidiState;
use obs_ctrl::ObsState;
use sfx::SfxState;
use vault::VaultState;

/// Frontend assets baked into the binary at compile time (from ../dist).
/// Served from 127.0.0.1 so Clash/TUN never sees tauri.localhost.
static UI: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist");

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "jfif", "tif", "tiff",
];
/// 优先 WebView 能硬解的常见格式；mkv 仍列出，播不了会失败但不炸列表
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mov", "m4v", "mkv", "avi"];

const THUMB_MAX: u32 = 280;
const MAX_THUMB_BYTES: u64 = 25 * 1024 * 1024;
/// 视频不整文件解码；封面用绘制占位，超大文件也安全
const MAX_VIDEO_LIST_BYTES: u64 = 40 * 1024 * 1024 * 1024; // 40GB 列表仍可出现

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
    pub path: String,
    pub name: String,
    /// Pixel size from file headers (for waterfall aspect-ratio slots).
    pub width: u32,
    pub height: u32,
    /// "image" | "video"
    pub kind: String,
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

fn is_image(path: &Path) -> bool {
    ext_lower(path)
        .map(|e| IMAGE_EXTS.iter().any(|x| *x == e))
        .unwrap_or(false)
}

fn is_video(path: &Path) -> bool {
    ext_lower(path)
        .map(|e| VIDEO_EXTS.iter().any(|x| *x == e))
        .unwrap_or(false)
}

fn is_media(path: &Path) -> bool {
    is_image(path) || is_video(path)
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

fn file_mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// recursive=false：只扫当前文件夹；true：无限深扫所有子文件夹
fn collect_images(
    dir: &Path,
    out: &mut Vec<(u64, ImageEntry)>,
    recursive: bool,
) -> Result<(), String> {
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
            if recursive {
                let _ = collect_images(&path, out, true);
            }
        } else if path.is_file() && is_media(&path) {
            let meta_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if is_video(&path) && meta_len > MAX_VIDEO_LIST_BYTES {
                continue;
            }
            let (width, height, kind) = if is_video(&path) {
                // 未知真实分辨率时用 16:9 槽位，避免瀑布流塌成一条线
                (1920u32, 1080u32, "video".to_string())
            } else {
                let (w, h) = image_dimensions(&path);
                (w, h, "image".to_string())
            };
            let mtime = file_mtime_secs(&path);
            out.push((
                mtime,
                ImageEntry {
                    path: path.to_string_lossy().to_string(),
                    name,
                    width,
                    height,
                    kind,
                },
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn list_images(root: String, recursive: bool) -> Result<Vec<ImageEntry>, String> {
    let root = PathBuf::from(root.trim());
    if !root.is_dir() {
        return Err("图库路径不是有效文件夹".into());
    }
    let mut images: Vec<(u64, ImageEntry)> = Vec::new();
    collect_images(&root, &mut images, recursive)?;
    // 按修改时间从新到旧
    images.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
    let mut images: Vec<ImageEntry> = images.into_iter().map(|(_, e)| e).collect();
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
    if !is_media(&path) {
        return Err("不是支持的图片/视频文件".into());
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
    hasher.update(b"|v5-media");
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 无 FFmpeg 时的视频封面：深色底 + 播放三角（缓存后网格滚动仍丝滑）
fn make_video_placeholder_jpeg() -> Result<Vec<u8>, String> {
    let w = THUMB_MAX;
    let h = (THUMB_MAX as f32 * 9.0 / 16.0).round() as u32;
    let h = h.max(1);
    let mut rgb = image::RgbImage::new(w, h);
    let bg = image::Rgb([0x14u8, 0x14, 0x18]);
    for p in rgb.pixels_mut() {
        *p = bg;
    }
    // 居中播放三角
    let cx = (w / 2) as i32;
    let cy = (h / 2) as i32;
    let size = (h.min(w) as i32) / 5;
    let tri = image::Rgb([0xeeu8, 0xee, 0xf0]);
    for y in -size..=size {
        let row = cy + y;
        if row < 0 || row >= h as i32 {
            continue;
        }
        // 向右的等腰三角：x 从 left 到 left+width
        let half = size - y.abs();
        let x0 = cx - size / 3;
        let x1 = x0 + half + size / 2;
        for x in x0..=x1 {
            if x >= 0 && x < w as i32 {
                // 简单斜边：右侧边界随 y 收窄
                let progress = (x - x0) as f32 / (half + size / 2).max(1) as f32;
                let max_y = (1.0 - progress) * size as f32;
                if (y as f32).abs() <= max_y + 0.5 {
                    rgb.put_pixel(x as u32, row as u32, tri);
                }
            }
        }
    }
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 75);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("编码视频封面失败：{e}"))?;
    Ok(buf.into_inner())
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
    if !path_buf.is_file() || !is_media(&path_buf) {
        return Err("无效媒体文件".into());
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
    let video = is_video(&src);
    tauri::async_runtime::spawn_blocking(move || {
        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            if video {
                make_video_placeholder_jpeg()
            } else {
                make_thumbnail_jpeg(&src)
            }
        }));
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

/// 解析 `bytes=start-end` / `bytes=start-`
fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    let s = header.trim();
    let s = s.strip_prefix("bytes=")?;
    // 只取第一段（Chrome 有时带多个，忽略）
    let s = s.split(',').next()?.trim();
    let (a, b) = s.split_once('-')?;
    if a.is_empty() {
        return None;
    }
    let start: u64 = a.parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if b.is_empty() {
        total.saturating_sub(1)
    } else {
        b.parse::<u64>().ok()?.min(total.saturating_sub(1))
    };
    if end < start {
        return None;
    }
    // 单段过大时截断防 OOM；返回正确 Content-Range，播放器会继续要下一段
    let max_chunk = 32 * 1024 * 1024u64;
    let end = end.min(start + max_chunk - 1).min(total.saturating_sub(1));
    Some((start, end))
}

fn header_str(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header")
}

fn media_mime(path: &Path) -> String {
    match ext_lower(path).as_deref() {
        Some("mp4") | Some("m4v") => "video/mp4".into(),
        Some("webm") => "video/webm".into(),
        Some("mov") => "video/quicktime".into(),
        Some("mkv") => "video/webm".into(), // WebView 更认 webm 标签；真 mkv 仍可能失败
        Some("avi") => "video/x-msvideo".into(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string(),
    }
}

fn respond_media_file(request: tiny_http::Request, path: &Path) {
    let mime = media_mime(path);
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => {
            let _ = request.respond(Response::empty(404));
            return;
        }
    };
    let total = meta.len();
    let range_hdr = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let common = || {
        vec![
            header_str("Content-Type", &mime),
            header_str("Accept-Ranges", "bytes"),
            header_str("Cache-Control", "public, max-age=0"),
            header_str("Access-Control-Allow-Origin", "*"),
            header_str("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length"),
        ]
    };

    if let Some(rh) = range_hdr.as_deref() {
        if let Some((start, end)) = parse_byte_range(rh, total) {
            let len = (end - start + 1) as usize;
            let mut file = match File::open(path) {
                Ok(f) => f,
                Err(_) => {
                    let _ = request.respond(Response::empty(404));
                    return;
                }
            };
            if file.seek(SeekFrom::Start(start)).is_err() {
                let _ = request.respond(Response::empty(416));
                return;
            }
            let mut buf = vec![0u8; len];
            if file.read_exact(&mut buf).is_err() {
                let _ = request.respond(Response::empty(500));
                return;
            }
            let content_range = format!("bytes {start}-{end}/{total}");
            let mut headers = common();
            headers.push(header_str("Content-Range", &content_range));
            headers.push(header_str("Content-Length", &len.to_string()));
            let response = Response::new(
                StatusCode(206),
                headers,
                Cursor::new(buf),
                Some(len),
                None,
            );
            let _ = request.respond(response);
            return;
        }
        let _ = request.respond(Response::empty(416));
        return;
    }

    // 完整 GET：始终声明 Accept-Ranges，小文件读内存，大文件流式
    if total <= 24 * 1024 * 1024 {
        match fs::read(path) {
            Ok(bytes) => {
                let mut headers = common();
                headers.push(header_str("Content-Length", &bytes.len().to_string()));
                let response = Response::new(
                    StatusCode(200),
                    headers,
                    Cursor::new(bytes),
                    Some(total as usize),
                    None,
                );
                let _ = request.respond(response);
            }
            Err(_) => {
                let _ = request.respond(Response::empty(404));
            }
        }
        return;
    }

    match File::open(path) {
        Ok(file) => {
            let mut headers = common();
            headers.push(header_str("Content-Length", &total.to_string()));
            let response = Response::new(
                StatusCode(200),
                headers,
                file,
                Some(total as usize),
                None,
            );
            let _ = request.respond(response);
        }
        Err(_) => {
            let _ = request.respond(Response::empty(404));
        }
    }
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

                // Stream real disk media for lightbox / video (Range = 拖进度丝滑).
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
                    if path.is_file() && is_media(&path) {
                        respond_media_file(request, &path);
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
    // Always host /__file (+ release UI) on 127.0.0.1 tiny_http.
    // Dev window loads Vite for hot reload; __FLYPHOTO_ORIGIN__ still points at tiny_http for media.
    let file_origin = {
        let ui_port = spawn_local_ui_server();
        format!("http://127.0.0.1:{ui_port}")
    };
    #[cfg(debug_assertions)]
    let ui_origin = "http://localhost:1420".to_string();
    #[cfg(not(debug_assertions))]
    let ui_origin = file_origin.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::Builder::new().app_name("FLYBOX").build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(VaultState::default())
        .manage(SfxState::default())
        .manage(ObsState::default())
        .manage(MidiState::default())
        .setup(move |app| {
            let page_origin = ui_origin.clone();
            let media_origin = file_origin.clone();
            let url: url::Url = format!("{page_origin}/").parse().expect("UI URL");

            // Allow IPC from the UI origin (not tauri.localhost).
            let mut cap = tauri::ipc::CapabilityBuilder::new("local-ui")
                    .remote(page_origin.clone())
                    .remote(format!("{page_origin}/*"))
                    .remote(media_origin.clone())
                    .remote(format!("{media_origin}/*"));
            #[cfg(debug_assertions)]
            {
                cap = cap
                    .remote("http://127.0.0.1:1420".into())
                    .remote("http://127.0.0.1:1420/*".into())
                    .remote("http://localhost:1420".into())
                    .remote("http://localhost:1420/*".into());
            }
            app.add_capability(
                cap
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
                    .permission("allow-sfx-list-devices")
                    .permission("allow-sfx-list-input-devices")
                    .permission("allow-sfx-set-device")
                    .permission("allow-sfx-set-master-volume")
                    .permission("allow-sfx-set-bgm-volume")
                    .permission("allow-sfx-set-sfx-volume")
                    .permission("allow-sfx-set-tagged-volume")
                    .permission("allow-sfx-set-bgm-speed")
                    .permission("allow-sfx-set-bgm-pitch")
                    .permission("allow-sfx-set-fade-ms")
                    .permission("allow-sfx-set-interrupt")
                    .permission("allow-sfx-set-duck")
                    .permission("allow-sfx-set-voice-duck")
                    .permission("allow-sfx-set-loop-mode")
                    .permission("allow-sfx-set-playlist")
                    .permission("allow-sfx-stop-all")
                    .permission("allow-sfx-stop-sfx")
                    .permission("allow-sfx-stop-bgm")
                    .permission("allow-sfx-pause-bgm")
                    .permission("allow-sfx-resume-bgm")
                    .permission("allow-sfx-seek-bgm")
                    .permission("allow-sfx-play")
                    .permission("allow-sfx-play-bgm")
                    .permission("allow-sfx-bgm-status")
                    .permission("allow-sfx-probe")
                    .permission("allow-sfx-transcode")
                    .permission("allow-sfx-waveform")
                    .permission("allow-sfx-scan-library")
                    .permission("allow-sfx-import-files")
                    .permission("allow-sfx-delete-file")
                    .permission("allow-sfx-category-create")
                    .permission("allow-sfx-category-rename")
                    .permission("allow-sfx-category-delete")
                    .permission("allow-sfx-move-file")
                    .permission("allow-sfx-record-start")
                    .permission("allow-sfx-record-stop")
                    .permission("allow-sfx-record-status")
                    .permission("allow-sfx-export-range")
                    .permission("allow-obs-configure")
                    .permission("allow-obs-connect")
                    .permission("allow-obs-status")
                    .permission("allow-obs-set-scene")
                    .permission("allow-obs-sync-media-seek")
                    .permission("allow-obs-disconnect")
                    .permission("allow-midi-list-ports")
                    .permission("allow-midi-status")
                    .permission("allow-midi-configure")
                    .permission("allow-midi-send-position")
                    .permission("dialog:default")
                    .permission("clipboard-manager:allow-write-text")
                    .permission("clipboard-manager:allow-read-text")
                    .permission("store:default")
                    .permission("fs:default")
                    .permission("opener:default")
                    .permission("autostart:default")
                    .permission("global-shortcut:allow-is-registered")
                    .permission("global-shortcut:allow-register")
                    .permission("global-shortcut:allow-unregister")
                    .permission("global-shortcut:allow-unregister-all"),
            )?;

            let init_script = format!(
                "window.__FLYPHOTO_ORIGIN__={};",
                serde_json::to_string(&media_origin).unwrap()
            );

            let window_title = if cfg!(debug_assertions) {
                "FLYBOX Dev"
            } else {
                "FLYBOX"
            };
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(window_title)
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
            sfx::sfx_list_devices,
            sfx::sfx_list_input_devices,
            sfx::sfx_set_device,
            sfx::sfx_set_master_volume,
            sfx::sfx_set_bgm_volume,
            sfx::sfx_set_sfx_volume,
            sfx::sfx_set_bgm_speed,
            sfx::sfx_set_bgm_pitch,
            sfx::sfx_set_fade_ms,
            sfx::sfx_set_interrupt,
            sfx::sfx_set_duck,
            sfx::sfx_set_voice_duck,
            sfx::sfx_set_loop_mode,
            sfx::sfx_set_playlist,
            sfx::sfx_stop_all,
            sfx::sfx_stop_sfx,
            sfx::sfx_stop_bgm,
            sfx::sfx_pause_bgm,
            sfx::sfx_resume_bgm,
            sfx::sfx_seek_bgm,
            sfx::sfx_play,
            sfx::sfx_set_tagged_volume,
            sfx::sfx_play_bgm,
            sfx::sfx_bgm_status,
            sfx::sfx_probe,
            sfx::sfx_transcode,
            sfx::sfx_waveform,
            sfx::sfx_scan_library,
            sfx::sfx_import_files,
            sfx::sfx_delete_file,
            sfx::sfx_category_create,
            sfx::sfx_category_rename,
            sfx::sfx_category_delete,
            sfx::sfx_move_file,
            sfx::sfx_record_start,
            sfx::sfx_record_stop,
            sfx::sfx_record_status,
            sfx::sfx_export_range,
            sfx::sfx_export_montage,
            obs_ctrl::obs_configure,
            obs_ctrl::obs_connect,
            obs_ctrl::obs_status,
            obs_ctrl::obs_set_scene,
            obs_ctrl::obs_sync_media_seek,
            obs_ctrl::obs_disconnect,
            midi_mtc::midi_list_ports,
            midi_mtc::midi_status,
            midi_mtc::midi_configure,
            midi_mtc::midi_send_position,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Always silence BASS before the process dies — otherwise playback
            // can keep going after the window is gone (zombie audio).
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<SfxState>() {
                        state.shutdown();
                    }
                }
                _ => {}
            }
        });
}
