//! FLYBOX virtual camera (OBS win-dshow based filter DLL + shared-memory frames).

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::ffmpeg_util;

/// Must match `virtualcam-guid.h` / filter registration.
const DEVICE_CLSID: &str = "{A8E7F6D5-C4B3-4A29-9E1D-8C7B6A594837}";
const DEVICE_NAME: &str = "FLYBOX Camera";
/// Must match `shared-memory-queue.c` VIDEO_NAME.
const SHM_NAME: &str = "FLYBOXVirtualCamVideo";

/// How the camera image is fitted into the virtual-cam canvas.
/// Mirrors OBS source transform **Bounding Box Type** (no stretch — always keep aspect):
/// - Contain ≈ Scale to inner bounds (keep ratio, black bars)
/// - Cover ≈ Scale to outer bounds (keep ratio, crop)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum FitMode {
  #[default]
  Contain,
  Cover,
}

impl FitMode {
  fn parse(s: Option<&str>) -> Self {
    match s.map(|x| x.trim().to_ascii_lowercase()).as_deref() {
      Some("cover") | Some("crop") | Some("outer") => FitMode::Cover,
      // Legacy "stretch" maps to contain (never distort people).
      _ => FitMode::Contain,
    }
  }

  fn as_str(self) -> &'static str {
    match self {
      FitMode::Contain => "contain",
      FitMode::Cover => "cover",
    }
  }
}

/// Output geometry/timing for SHM + capture (OBS negotiates this; we expose presets).
#[derive(Debug, Clone, Copy)]
struct OutputSpec {
  w: u32,
  h: u32,
  fps: u32,
  /// Frame interval in 100ns units (OBS / DirectShow).
  interval: u64,
}

impl OutputSpec {
  /// Canvas size like OBS Settings → Video (aspect comes from w×h).
  /// Supports 720p / 1K / 2K / 4K × common ratios (even dims for NV12).
  fn resolve(width: Option<u32>, height: Option<u32>, fps: Option<u32>) -> Self {
    let w0 = width.unwrap_or(1920);
    let h0 = height.unwrap_or(1080);
    // Up to 4K; keep even width/height for NV12.
    let (w, h) = match (w0, h0) {
      (ww, hh) if (320..=3840).contains(&ww) && (240..=3840).contains(&hh) => {
        (ww & !1, hh & !1)
      }
      _ => (1920, 1080),
    };
    let fps = match fps.unwrap_or(30) {
      60 => 60,
      _ => 30,
    };
    let interval = 10_000_000u64 / u64::from(fps);
    Self { w, h, fps, interval }
  }

  fn aspect_label(self) -> &'static str {
    let w = self.w as f64;
    let h = self.h as f64;
    if h <= 0.0 {
      return "?";
    }
    let r = w / h;
    if (r - 16.0 / 9.0).abs() < 0.08 {
      "16:9"
    } else if (r - 4.0 / 3.0).abs() < 0.08 {
      "4:3"
    } else if (r - 3.0 / 4.0).abs() < 0.08 {
      "3:4"
    } else if (r - 9.0 / 16.0).abs() < 0.08 {
      "9:16"
    } else if (r - 1.0).abs() < 0.08 {
      "1:1"
    } else {
      "自定义"
    }
  }

  fn frame_bytes(self) -> usize {
    (self.w as usize) * (self.h as usize) * 3 / 2
  }

  fn sleep_ms(self) -> u64 {
    (1000 / self.fps.max(1)) as u64
  }

  fn label(self) -> String {
    format!("{} {}x{}@{}fps", self.aspect_label(), self.w, self.h, self.fps)
  }
}

/// Default when UI omits params (1080p30 — full HD, not the old 720p lock-in).
const DEFAULT_SPEC: OutputSpec = OutputSpec {
  w: 1920,
  h: 1080,
  fps: 30,
  interval: 333_333,
};

pub struct VcamState {
  inner: Mutex<VcamInner>,
}

struct VcamInner {
  running: bool,
  /// Physical camera name currently feeding SHM, or None = test pattern.
  source: Option<String>,
  /// Active SHM / companion output size/fps.
  spec: OutputSpec,
  /// Warning shown when we had to fall back (should stay empty if start fails hard).
  warn: Option<String>,
  stop: Option<Arc<AtomicBool>>,
  join: Option<thread::JoinHandle<()>>,
  /// Frames successfully written to SHM (companion needs this > 0).
  frames: Arc<AtomicU64>,
  /// Latest UI preview (RGBA, half-res).
  preview: Arc<Mutex<Option<PreviewRgba>>>,
  /// `mf` | `ffmpeg` | `test` while running.
  capture_backend: Option<String>,
  /// OBS-style bounding-box fit into output canvas.
  fit_mode: FitMode,
}

struct PreviewRgba {
  width: u32,
  height: u32,
  rgba: Vec<u8>,
}

impl Default for VcamState {
  fn default() -> Self {
    Self {
      inner: Mutex::new(VcamInner {
        running: false,
        source: None,
        spec: DEFAULT_SPEC,
        warn: None,
        stop: None,
        join: None,
        frames: Arc::new(AtomicU64::new(0)),
        preview: Arc::new(Mutex::new(None)),
        capture_backend: None,
        fit_mode: FitMode::Contain,
      }),
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamPreview {
  pub width: u32,
  pub height: u32,
  /// `data:image/jpeg;base64,...` for direct `<img>` / canvas draw.
  pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamStatus {
  pub device_name: String,
  pub installed: bool,
  pub running: bool,
  /// True when SHM is live and frames are being written.
  pub pushing: bool,
  pub frames: u64,
  /// Active capture source name (physical cam) or null for test bars.
  pub source: Option<String>,
  pub width: u32,
  pub height: u32,
  pub fps: u32,
  /// e.g. `16:9` / `4:3` / `9:16` / `1:1` (from canvas size).
  pub aspect: String,
  /// Non-empty when output is test bars after a camera problem (or similar).
  pub warn: Option<String>,
  /// `mf` | `ffmpeg` | `test` while running; null when idle.
  pub capture_backend: Option<String>,
  /// `contain` | `cover` (OBS bounding-box style; always keep aspect).
  pub fit_mode: String,
  pub message: String,
  pub source_note: String,
  pub dll_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamSource {
  pub name: String,
  /// Highest native mode width (0 = unknown).
  pub max_width: u32,
  /// Highest native mode height (0 = unknown).
  pub max_height: u32,
}

fn lock(state: &VcamState) -> Result<std::sync::MutexGuard<'_, VcamInner>, String> {
  state
    .inner
    .lock()
    .map_err(|_| "vcam state lock poisoned".into())
}

fn dll_candidates() -> Vec<PathBuf> {
  let mut out = Vec::new();
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      // Dev (build.rs copy) + installed layout.
      out.push(dir.join("flybox-virtualcam-module64.dll"));
      out.push(dir.join("vcam").join("flybox-virtualcam-module64.dll"));
      // Tauri NSIS resources preserve path under resources/.
      out.push(
        dir
          .join("resources")
          .join("vcam")
          .join("flybox-virtualcam-module64.dll"),
      );
      out.push(dir.join("resources").join("flybox-virtualcam-module64.dll"));
    }
  }
  let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  out.push(
    manifest
      .join("resources")
      .join("vcam")
      .join("flybox-virtualcam-module64.dll"),
  );
  out.push(
    manifest
      .join("..")
      .join("src-vcam")
      .join("dist")
      .join("flybox-virtualcam-module64.dll"),
  );
  out.push(
    manifest
      .join("..")
      .join("src-vcam")
      .join("build")
      .join("flybox-virtualcam-module64.dll"),
  );
  out
}

fn resolve_dll() -> Option<PathBuf> {
  dll_candidates().into_iter().find(|p| p.is_file())
}

fn is_filter_registered() -> bool {
  let key = format!(r"HKLM\SOFTWARE\Classes\CLSID\{DEVICE_CLSID}");
  let ok = Command::new("reg")
    .args(["query", &key])
    .output()
    .map(|o| o.status.success())
    .unwrap_or(false);
  if ok {
    return true;
  }
  let key32 = format!(r"HKLM\SOFTWARE\Classes\WOW6432Node\CLSID\{DEVICE_CLSID}");
  Command::new("reg")
    .args(["query", &key32])
    .output()
    .map(|o| o.status.success())
    .unwrap_or(false)
}

fn elevate_regsvr32(dll: &Path, uninstall: bool) -> Result<(), String> {
  let dll_s = dll
    .canonicalize()
    .unwrap_or_else(|_| dll.to_path_buf())
    .to_string_lossy()
    .to_string();
  let dll_s = dll_s
    .strip_prefix(r"\\?\")
    .unwrap_or(&dll_s)
    .replace('\'', "''");
  // Prefer DllInstall (/i) like OBS; fall back is still /i|/u.
  let args = if uninstall {
    format!("/u /s \"{dll_s}\"")
  } else {
    format!("/i /s \"{dll_s}\"")
  };
  // Try without elevation first (already admin / portable lab), then UAC.
  let direct = Command::new("regsvr32")
    .args(if uninstall {
      vec!["/u", "/s", &dll_s]
    } else {
      vec!["/i", "/s", &dll_s]
    })
    .status();
  if let Ok(st) = direct {
    if st.success() {
      return Ok(());
    }
  }
  let status = Command::new("powershell")
    .args([
      "-NoProfile",
      "-Command",
      &format!(
        "Start-Process -FilePath regsvr32.exe -ArgumentList '{args}' -Verb RunAs -Wait"
      ),
    ])
    .status()
    .map_err(|e| format!("无法启动注册: {e}"))?;
  if !status.success() {
    return Err("注册可能被取消或失败（需要管理员权限）".into());
  }
  Ok(())
}

/// OBS uses os_quick_write_utf8_file_safe (tmp + replace). Same idea here so
/// companion never reads a half-written size string.
fn write_res_file(w: u32, h: u32, interval: u64) {
  if let Ok(base) = std::env::var("APPDATA") {
    let dir = PathBuf::from(base);
    let path = dir.join("flybox-virtualcam.txt");
    let tmp = dir.join("flybox-virtualcam.txt.tmp");
    let body = format!("{w}x{h}x{interval}");
    if fs::write(&tmp, body.as_bytes()).is_ok() {
      let _ = fs::rename(&tmp, &path).or_else(|_| {
        let _ = fs::remove_file(&path);
        fs::rename(&tmp, &path)
      });
    }
  }
}

/// Decode ffmpeg stderr (often system ANSI/GBK on Chinese Windows).
fn decode_ffmpeg_bytes(bytes: &[u8]) -> String {
  if let Ok(s) = std::str::from_utf8(bytes) {
    return s.to_string();
  }
  #[cfg(windows)]
  {
    #[link(name = "kernel32")]
    extern "system" {
      fn MultiByteToWideChar(
        cp: u32,
        flags: u32,
        bytes: *const u8,
        nbytes: i32,
        wide: *mut u16,
        nwide: i32,
      ) -> i32;
    }
    // CP_ACP = 0 (system ANSI, GBK on zh-CN)
    unsafe {
      let n = MultiByteToWideChar(0, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
      if n > 0 {
        let mut wide = vec![0u16; n as usize];
        MultiByteToWideChar(0, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), n);
        return String::from_utf16_lossy(&wide);
      }
    }
  }
  String::from_utf8_lossy(bytes).into_owned()
}

/* ---- OBS video_queue (same C as filter; linked via build.rs) ---- */

#[repr(C)]
struct video_queue_t {
  _opaque: [u8; 0],
}

// Linked by build.rs (`cc` → static lib `flybox_video_queue`).
extern "C" {
  fn video_queue_create(cx: u32, cy: u32, interval: u64) -> *mut video_queue_t;
  fn video_queue_close(vq: *mut video_queue_t);
  fn video_queue_write(
    vq: *mut video_queue_t,
    data: *mut *mut u8,
    linesize: *mut u32,
    timestamp: u64,
  );
}

#[link(name = "kernel32")]
extern "system" {
  fn OpenFileMappingW(access: u32, inherit: i32, name: *const u16) -> *mut std::ffi::c_void;
  fn MapViewOfFile(
    h: *mut std::ffi::c_void,
    access: u32,
    off_high: u32,
    off_low: u32,
    bytes: usize,
  ) -> *mut std::ffi::c_void;
  fn UnmapViewOfFile(p: *const std::ffi::c_void) -> i32;
  fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
}

const FILE_MAP_ALL_ACCESS: u32 = 0xF001F;
const FILE_MAP_READ: u32 = 0x0004;

fn shm_is_open() -> bool {
  let wide: Vec<u16> = SHM_NAME.encode_utf16().chain(std::iter::once(0)).collect();
  unsafe {
    let h = OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, wide.as_ptr());
    if h.is_null() {
      false
    } else {
      CloseHandle(h);
      true
    }
  }
}

/// Read OBS queue header `cx`/`cy` from live SHM (ground truth for quality tier).
/// Layout matches `shared-memory-queue.c` struct queue_header: cx@28, cy@32.
fn read_shm_geometry() -> Option<(u32, u32)> {
  let wide: Vec<u16> = SHM_NAME.encode_utf16().chain(std::iter::once(0)).collect();
  unsafe {
    let h = OpenFileMappingW(FILE_MAP_READ, 0, wide.as_ptr());
    if h.is_null() {
      return None;
    }
    let view = MapViewOfFile(h, FILE_MAP_READ, 0, 0, 64);
    if view.is_null() {
      CloseHandle(h);
      return None;
    }
    let base = view as *const u8;
    let cx = std::ptr::read_unaligned(base.add(28) as *const u32);
    let cy = std::ptr::read_unaligned(base.add(32) as *const u32);
    UnmapViewOfFile(view);
    CloseHandle(h);
    if cx >= 160 && cy >= 120 {
      Some((cx, cy))
    } else {
      None
    }
  }
}

fn read_res_file_geometry() -> Option<(u32, u32)> {
  let base = std::env::var("APPDATA").ok()?;
  let body = fs::read_to_string(PathBuf::from(base).join("flybox-virtualcam.txt")).ok()?;
  // format: {w}x{h}x{interval}
  let mut parts = body.trim().split('x');
  let w: u32 = parts.next()?.parse().ok()?;
  let h: u32 = parts.next()?.parse().ok()?;
  Some((w, h))
}

/// Thin Rust owner around OBS `video_queue_create` / `write` / `close`.
struct VideoQueueWriter {
  ptr: *mut video_queue_t,
  cx: u32,
  cy: u32,
}

unsafe impl Send for VideoQueueWriter {}

impl VideoQueueWriter {
  fn create(cx: u32, cy: u32, interval: u64) -> Result<Self, String> {
    let ptr = unsafe { video_queue_create(cx, cy, interval) };
    if ptr.is_null() {
      return Err("虚拟摄像头共享内存已被占用，请先停止其他输出".into());
    }
    Ok(Self { ptr, cx, cy })
  }

  /// Contiguous NV12 → OBS two-plane `video_queue_write` (Y + UV).
  fn write_nv12(&mut self, yuv: &[u8], timestamp: u64) {
    let y_size = (self.cx as usize).saturating_mul(self.cy as usize);
    let need = y_size + y_size / 2;
    if yuv.len() < need || y_size == 0 {
      return;
    }
    // SAFETY: C only reads data[0]/data[1] for the duration of the call.
    let y_ptr = yuv.as_ptr() as *mut u8;
    let uv_ptr = unsafe { yuv.as_ptr().add(y_size) as *mut u8 };
    let mut data = [y_ptr, uv_ptr];
    let mut linesize = [self.cx, self.cx];
    unsafe {
      video_queue_write(
        self.ptr,
        data.as_mut_ptr(),
        linesize.as_mut_ptr(),
        timestamp,
      );
    }
  }
}

impl Drop for VideoQueueWriter {
  fn drop(&mut self) {
    if !self.ptr.is_null() {
      unsafe { video_queue_close(self.ptr) };
      self.ptr = std::ptr::null_mut();
    }
  }
}

/// Color bars + moving highlight so apps show a clear "live" signal.
fn make_nv12_test(cx: u32, cy: u32, tick: u64) -> Vec<u8> {
  let y_size = (cx * cy) as usize;
  let mut buf = vec![0u8; y_size + y_size / 2];
  let bands = 8u32;
  let band_w = (cx / bands).max(1);
  // Approximate Y for white/yellow/cyan/green/magenta/red/blue/black bars
  let y_levels = [235u8, 210, 170, 145, 106, 81, 41, 16];
  for x in 0..cx {
    let bi = ((x / band_w) as usize).min(7);
    let yv = y_levels[bi];
    for y in 0..cy {
      buf[(y * cx + x) as usize] = yv;
    }
  }
  // UV: mild tint per band (U,V interleaved)
  let uv = &mut buf[y_size..];
  let uv_h = cy / 2;
  let uv_levels: [(u8, u8); 8] = [
    (128, 128),
    (16, 146),
    (166, 16),
    (54, 34),
    (202, 222),
    (90, 240),
    (240, 110),
    (128, 128),
  ];
  for row in 0..uv_h {
    for x in 0..cx {
      let bi = ((x / band_w) as usize).min(7);
      let (u, v) = uv_levels[bi];
      let i = (row * cx + x) as usize;
      if i + 1 < uv.len() {
        if x % 2 == 0 {
          uv[i] = u;
        } else {
          uv[i] = v;
        }
      }
    }
  }
  // Moving white bar
  let bar_x = ((tick as u32 * 6) % cx.saturating_sub(48).max(1)) as usize;
  for row in (cy / 3)..(cy * 2 / 3) {
    let start = row as usize * cx as usize + bar_x;
    let end = (start + 48).min(y_size);
    if start < y_size {
      for b in &mut buf[start..end] {
        *b = 235;
      }
    }
  }
  buf
}

fn ffmpeg_no_window(program: impl AsRef<std::ffi::OsStr>) -> Command {
  let mut c = Command::new(program);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    c.creation_flags(CREATE_NO_WINDOW);
  }
  c
}

/// Fit requested canvas inside the camera's max native box (keep aspect, even dims).
/// Only clamps when caps are **plausible** (see `is_plausible_cam_max`).
fn clamp_canvas_to_camera(requested: OutputSpec, cam_w: u32, cam_h: u32) -> (OutputSpec, bool) {
  if !is_plausible_cam_max(cam_w, cam_h) {
    return (requested, false);
  }
  if requested.w <= cam_w && requested.h <= cam_h {
    return (requested, false);
  }
  let scale = (cam_w as f64 / requested.w as f64).min(cam_h as f64 / requested.h as f64);
  let w = ((requested.w as f64 * scale).floor() as u32).max(2) & !1;
  let h = ((requested.h as f64 * scale).floor() as u32).max(2) & !1;
  let clamped = OutputSpec::resolve(Some(w), Some(h), Some(requested.fps));
  (clamped, true)
}

/// Real webcams expose ≥720p-class modes. Tiny "max" (e.g. 800×448) is a bad
/// partial probe (busy device / wrong pin) — never use it to down-clamp product tiers.
fn is_plausible_cam_max(w: u32, h: u32) -> bool {
  w >= 640 && h >= 480 && (u64::from(w) * u64::from(h) >= 1280 * 720)
}

fn cam_caps_cache() -> &'static Mutex<HashMap<String, (u32, u32)>> {
  static CACHE: OnceLock<Mutex<HashMap<String, (u32, u32)>>> = OnceLock::new();
  CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_cam_caps(name: &str, w: u32, h: u32) {
  if !is_plausible_cam_max(w, h) {
    return;
  }
  if let Ok(mut g) = cam_caps_cache().lock() {
    // Keep the larger of old/new (never regress to a tinier wrong probe).
    let entry = g.entry(name.to_string()).or_insert((0, 0));
    let old_pix = u64::from(entry.0) * u64::from(entry.1);
    let new_pix = u64::from(w) * u64::from(h);
    if new_pix >= old_pix {
      *entry = (w, h);
    }
  }
}

fn cached_cam_caps(name: &str) -> Option<(u32, u32)> {
  cam_caps_cache()
    .lock()
    .ok()
    .and_then(|g| g.get(name).copied())
    .filter(|(w, h)| is_plausible_cam_max(*w, *h))
}

/// OBS-aligned: enumerate DirectShow pin options via ffmpeg `dshow -list_options`
/// (same IAMStreamConfig / GetStreamCaps data OBS uses through libdshowcapture).
fn probe_dshow_max_via_ffmpeg(device: &str) -> Option<(u32, u32)> {
  let ffmpeg = ffmpeg_util::find_tool("ffmpeg.exe").or_else(|| ffmpeg_util::find_tool("ffmpeg"))?;
  let input = format!("video={device}");
  let out = ffmpeg_no_window(ffmpeg)
    .args([
      "-hide_banner",
      "-f",
      "dshow",
      "-list_options",
      "true",
      "-i",
      &input,
    ])
    .output()
    .ok()?;
  let text = decode_ffmpeg_bytes(&out.stderr);
  let text2 = decode_ffmpeg_bytes(&out.stdout);
  parse_dshow_list_options_max(&format!("{text}\n{text2}"))
}

/// Largest `s=WxH` / `max s=WxH` from ffmpeg dshow -list_options output.
fn parse_dshow_list_options_max(text: &str) -> Option<(u32, u32)> {
  let mut best_w = 0u32;
  let mut best_h = 0u32;
  let mut best_pix = 0u64;
  let bytes = text.as_bytes();
  let mut i = 0usize;
  while i + 2 < bytes.len() {
    if bytes[i] == b's' && bytes[i + 1] == b'=' {
      if let Some((w, h, consumed)) = parse_wxh_at(&text[i + 2..]) {
        let pix = u64::from(w) * u64::from(h);
        if w >= 160 && h >= 120 && pix > best_pix {
          best_pix = pix;
          best_w = w;
          best_h = h;
        }
        i += 2 + consumed;
        continue;
      }
    }
    i += 1;
  }
  if is_plausible_cam_max(best_w, best_h) {
    Some((best_w, best_h))
  } else {
    None
  }
}

fn parse_wxh_at(s: &str) -> Option<(u32, u32, usize)> {
  let mut w_str = String::new();
  let mut h_str = String::new();
  let mut chars = s.char_indices();
  for (_, c) in chars.by_ref() {
    if c.is_ascii_digit() {
      w_str.push(c);
    } else if c == 'x' || c == 'X' {
      break;
    } else {
      return None;
    }
  }
  if w_str.is_empty() {
    return None;
  }
  for (idx, c) in chars {
    if c.is_ascii_digit() {
      h_str.push(c);
    } else {
      let w: u32 = w_str.parse().ok()?;
      let h: u32 = h_str.parse().ok()?;
      return Some((w, h, idx));
    }
  }
  if h_str.is_empty() {
    return None;
  }
  let w: u32 = w_str.parse().ok()?;
  let h: u32 = h_str.parse().ok()?;
  Some((w, h, s.len()))
}

/// Resolve camera max: DShow list_options first (OBS), then trusted cache; never junk.
fn resolve_cam_max(name: &str, hint_w: Option<u32>, hint_h: Option<u32>) -> Option<(u32, u32)> {
  if let Some(v) = cached_cam_caps(name) {
    return Some(v);
  }
  if let (Some(w), Some(h)) = (hint_w, hint_h) {
    if is_plausible_cam_max(w, h) {
      cache_cam_caps(name, w, h);
      return Some((w, h));
    }
  }
  if let Some((w, h)) = probe_dshow_max_via_ffmpeg(name) {
    cache_cam_caps(name, w, h);
    return Some((w, h));
  }
  #[cfg(windows)]
  {
    if let Ok((w, h)) = crate::vcam_mf::probe_device_max_size(name) {
      if is_plausible_cam_max(w, h) {
        cache_cam_caps(name, w, h);
        return Some((w, h));
      }
    }
  }
  None
}

/// List devices + real max res (DirectShow pin caps via ffmpeg, OBS-aligned).
pub fn list_video_sources() -> Result<Vec<VcamSource>, String> {
  let mut names: Vec<String> = Vec::new();
  #[cfg(windows)]
  {
    if let Ok(list) = crate::vcam_mf::list_video_device_names() {
      names = list;
    }
  }
  if names.is_empty() {
    names = list_video_source_names_ffmpeg()?;
  }
  let mut out = Vec::new();
  for name in names {
    let (max_width, max_height) = resolve_cam_max(&name, None, None).unwrap_or((0, 0));
    out.push(VcamSource {
      name,
      max_width,
      max_height,
    });
  }
  Ok(out)
}

fn list_video_source_names_ffmpeg() -> Result<Vec<String>, String> {
  let ffmpeg = ffmpeg_util::find_tool("ffmpeg.exe")
    .or_else(|| ffmpeg_util::find_tool("ffmpeg"))
    .ok_or_else(|| "找不到 ffmpeg.exe，无法列出摄像头".to_string())?;
  let out = ffmpeg_no_window(ffmpeg)
    .args([
      "-hide_banner",
      "-list_devices",
      "true",
      "-f",
      "dshow",
      "-i",
      "dummy",
    ])
    .output()
    .map_err(|e| format!("列出摄像头失败: {e}"))?;
  let text = decode_ffmpeg_bytes(&out.stderr);
  let mut names = Vec::new();
  for line in text.lines() {
    if !line.contains("(video)") {
      continue;
    }
    let Some(start) = line.find('"') else {
      continue;
    };
    let rest = &line[start + 1..];
    let Some(end) = rest.find('"') else {
      continue;
    };
    let name = rest[..end].trim();
    if name.is_empty() {
      continue;
    }
    if name.eq_ignore_ascii_case(DEVICE_NAME) || name.contains("FLYBOX Camera") {
      continue;
    }
    if names.iter().any(|s: &String| s == name) {
      continue;
    }
    names.push(name.to_string());
  }
  Ok(names)
}

/// Half-res NV12 → RGBA for in-app preview (no extra crate).
fn nv12_to_rgba_half(nv12: &[u8], w: u32, h: u32) -> PreviewRgba {
  let pw = (w / 2).max(1);
  let ph = (h / 2).max(1);
  let y_size = (w * h) as usize;
  let mut rgba = vec![0u8; (pw * ph * 4) as usize];
  if nv12.len() < y_size + y_size / 2 {
    return PreviewRgba {
      width: pw,
      height: ph,
      rgba,
    };
  }
  let y_plane = &nv12[..y_size];
  let uv_plane = &nv12[y_size..];
  for py in 0..ph {
    for px in 0..pw {
      let x = px * 2;
      let y = py * 2;
      let yi = (y * w + x) as usize;
      let yv = y_plane.get(yi).copied().unwrap_or(0) as i32;
      let uv_row = (y / 2) * w;
      let u_i = (uv_row + (x & !1)) as usize;
      let u = uv_plane.get(u_i).copied().unwrap_or(128) as i32;
      let v = uv_plane.get(u_i + 1).copied().unwrap_or(128) as i32;
      // BT.601 limited range → RGB
      let c = yv - 16;
      let d = u - 128;
      let e = v - 128;
      let r = ((298 * c + 409 * e + 128) >> 8).clamp(0, 255) as u8;
      let g = ((298 * c - 100 * d - 208 * e + 128) >> 8).clamp(0, 255) as u8;
      let b = ((298 * c + 516 * d + 128) >> 8).clamp(0, 255) as u8;
      let o = ((py * pw + px) * 4) as usize;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
  PreviewRgba {
    width: pw,
    height: ph,
    rgba,
  }
}

fn publish_preview(preview: &Mutex<Option<PreviewRgba>>, nv12: &[u8], w: u32, h: u32, frame_n: u64) {
  // UI thumbnail only (~10fps). SHM already received every frame at full rate.
  if frame_n > 1 && frame_n % 3 != 0 {
    return;
  }
  let p = nv12_to_rgba_half(nv12, w, h);
  if let Ok(mut g) = preview.lock() {
    *g = Some(p);
  }
}

fn preview_to_data_url(p: &PreviewRgba) -> Option<String> {
  use base64::{engine::general_purpose::STANDARD as B64, Engine};
  use image::{ImageBuffer, RgbaImage};
  if p.rgba.len() != (p.width * p.height * 4) as usize {
    return None;
  }
  let img: RgbaImage = ImageBuffer::from_raw(p.width, p.height, p.rgba.clone())?;
  let mut jpeg = Vec::with_capacity(64 * 1024);
  {
    let mut cursor = std::io::Cursor::new(&mut jpeg);
    // Slightly higher quality so room detail is visible in the UI panel.
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 80);
    img.write_with_encoder(enc).ok()?;
  }
  if jpeg.is_empty() {
    return None;
  }
  Some(format!("data:image/jpeg;base64,{}", B64.encode(&jpeg)))
}

fn push_test_loop(
  writer: &mut VideoQueueWriter,
  stop: &AtomicBool,
  frames: &AtomicU64,
  preview: &Mutex<Option<PreviewRgba>>,
  spec: OutputSpec,
  mut tick: u64,
) {
  while !stop.load(Ordering::SeqCst) {
    let ts = tick.saturating_mul(spec.interval);
    let frame = make_nv12_test(spec.w, spec.h, tick);
    writer.write_nv12(&frame, ts);
    let n = frames.fetch_add(1, Ordering::Relaxed) + 1;
    publish_preview(preview, &frame, spec.w, spec.h, n);
    tick += 1;
    thread::sleep(Duration::from_millis(spec.sleep_ms()));
  }
}

/// Test-pattern only push (no physical camera / no ffmpeg).
fn spawn_push_thread(
  stop: Arc<AtomicBool>,
  frames: Arc<AtomicU64>,
  preview: Arc<Mutex<Option<PreviewRgba>>>,
  spec: OutputSpec,
) -> Result<thread::JoinHandle<()>, String> {
  write_res_file(spec.w, spec.h, spec.interval);
  for _ in 0..10 {
    if !shm_is_open() {
      break;
    }
    thread::sleep(Duration::from_millis(50));
  }
  let mut writer = VideoQueueWriter::create(spec.w, spec.h, spec.interval)?;
  {
    let frame = make_nv12_test(spec.w, spec.h, 0);
    writer.write_nv12(&frame, 0);
    frames.store(1, Ordering::Relaxed);
    publish_preview(&preview, &frame, spec.w, spec.h, 1);
  }
  let handle = thread::spawn(move || {
    push_test_loop(
      &mut writer,
      &stop,
      &frames,
      &preview,
      spec,
      frames.load(Ordering::Relaxed),
    );
  });
  Ok(handle)
}

fn collect_status(state: &VcamState) -> Result<VcamStatus, String> {
  let g = lock(state)?;
  let dll = resolve_dll();
  let installed = is_filter_registered();
  let frame_n = g.frames.load(Ordering::Relaxed);
  let pushing = g.running && shm_is_open() && frame_n > 0;
  let message = if let Some(ref w) = g.warn {
    w.clone()
  } else if g.running && !pushing {
    "输出线程异常：尚未向系统送帧。请点「停止」再「开始输出」。".into()
  } else if g.running {
    let geo = g.spec.label();
    // Always spell out raw pixels so quality tier changes are obvious in UI.
    let px = format!("{}×{}", g.spec.w, g.spec.h);
    if let Some(ref src) = g.source {
      format!(
        "正在输出「{src}」→ FLYBOX Camera {geo}（画布 {px}，已送 {frame_n} 帧）。伴侣请选 {px}。"
      )
    } else {
      format!(
        "正在输出测试彩条 → FLYBOX Camera {geo}（画布 {px}，已送 {frame_n} 帧）。"
      )
    }
  } else if installed {
    "设备已注册。选输入摄像头后点「开始输出」，再在直播伴侣选 FLYBOX Camera。".into()
  } else if dll.is_some() {
    "已就绪：点「安装设备」（需管理员确认）即可注册系统摄像头。".into()
  } else {
    "未找到 flybox-virtualcam-module64.dll，请先编译 src-vcam。".into()
  };
  Ok(VcamStatus {
    device_name: DEVICE_NAME.into(),
    installed,
    running: g.running,
    pushing,
    frames: frame_n,
    source: g.source.clone(),
    width: g.spec.w,
    height: g.spec.h,
    fps: g.spec.fps,
    aspect: g.spec.aspect_label().into(),
    warn: g.warn.clone(),
    capture_backend: g.capture_backend.clone(),
    fit_mode: g.fit_mode.as_str().into(),
    message,
    source_note:
      "基于 OBS plugins/win-dshow 虚拟摄像头（GPL）。源码：src-vcam/；上架前公开本模块。"
        .into(),
    dll_path: dll.map(|p| p.display().to_string()),
  })
}

/// High-quality scale to canvas with OBS-style fit (bounding box).
/// bt709 + limited (tv) range matches typical live encode / companion expectations.
fn scale_vf_hq(spec: OutputSpec, fit: FitMode) -> String {
  let geo = match fit {
    // OBS: Scale to inner bounds
    FitMode::Contain => format!(
      "scale={w}:{h}:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp:\
       force_original_aspect_ratio=decrease,\
       pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black",
      w = spec.w,
      h = spec.h
    ),
    // OBS: Scale to outer bounds
    FitMode::Cover => format!(
      "scale={w}:{h}:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp:\
       force_original_aspect_ratio=increase,\
       crop={w}:{h}",
      w = spec.w,
      h = spec.h
    ),
  };
  format!("{geo},setsar=1,format=nv12,colorspace=bt709:iall=bt709:fast=1")
}

/// Capture session → packed NV12 frames (MF in-process preferred; ffmpeg fallback).
enum CameraCapture {
  #[cfg(windows)]
  Mf {
    cam: crate::vcam_mf::MfCamera,
  },
  Ffmpeg {
    child: std::process::Child,
    stdout: std::process::ChildStdout,
    frame_size: usize,
    first_frame: Vec<u8>,
  },
}

impl CameraCapture {
  fn frame_size(&self) -> usize {
    match self {
      #[cfg(windows)]
      CameraCapture::Mf { cam } => cam.frame_size,
      CameraCapture::Ffmpeg { frame_size, .. } => *frame_size,
    }
  }

  fn take_first_frame(&mut self) -> Vec<u8> {
    match self {
      #[cfg(windows)]
      CameraCapture::Mf { cam } => std::mem::take(&mut cam.first_frame),
      CameraCapture::Ffmpeg { first_frame, .. } => std::mem::take(first_frame),
    }
  }

  fn read_frame(&mut self, buf: &mut [u8]) -> Result<(), String> {
    match self {
      #[cfg(windows)]
      CameraCapture::Mf { cam } => cam.read_nv12(buf),
      CameraCapture::Ffmpeg { stdout, child, .. } => {
        stdout.read_exact(buf).map_err(|e| {
          let _ = child.kill();
          let _ = child.wait();
          format!("读摄像头帧失败: {e}")
        })
      }
    }
  }

  fn backend(&self) -> &'static str {
    match self {
      #[cfg(windows)]
      CameraCapture::Mf { .. } => "mf",
      CameraCapture::Ffmpeg { .. } => "ffmpeg",
    }
  }

  fn capture_size(&self) -> (u32, u32) {
    match self {
      #[cfg(windows)]
      CameraCapture::Mf { cam } => (cam.cx, cam.cy),
      CameraCapture::Ffmpeg { .. } => (0, 0), // filled by caller via OutputSpec
    }
  }
}

/// Sample one Y pixel (nearest).
fn nv12_y(src: &[u8], sw: usize, sh: usize, x: usize, y: usize) -> u8 {
  let x = x.min(sw.saturating_sub(1));
  let y = y.min(sh.saturating_sub(1));
  src[y * sw + x]
}

/// Sample NV12 UV (interleaved) at luma coords (even-aligned).
fn nv12_uv(src_uv: &[u8], sw: usize, sh: usize, x: usize, y: usize) -> (u8, u8) {
  let x = (x.min(sw.saturating_sub(1))) & !1;
  let y = (y.min(sh.saturating_sub(1))) / 2;
  let uv_h = sh / 2;
  let y = y.min(uv_h.saturating_sub(1));
  let i = y * sw + x;
  if i + 1 < src_uv.len() {
    (src_uv[i], src_uv[i + 1])
  } else {
    (128, 128)
  }
}

/// Packed NV12 scale with OBS-style fit into `dw×dh`.
fn scale_nv12_fit(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32, fit: FitMode) -> Vec<u8> {
  let sw = sw.max(1) as usize;
  let sh = sh.max(1) as usize;
  let dw = dw.max(1) as usize;
  let dh = dh.max(1) as usize;
  let src_y_sz = sw * sh;
  let need_src = src_y_sz + src_y_sz / 2;
  let mut out = vec![16u8; dw * dh]; // limited-range black Y
  out.resize(dw * dh + dw * dh / 2, 128u8); // neutral UV
  if src.len() < need_src {
    return out;
  }
  let src_uv = &src[src_y_sz..];

  let (src_x0, src_y0, map_w, map_h) = match fit {
    FitMode::Contain => {
      // Fit entire source into dest; letterbox/pillarbox (handled via content rect).
      (0.0, 0.0, sw as f64, sh as f64)
    }
    FitMode::Cover => {
      // Fill dest; crop source.
      let scale = (dw as f64 / sw as f64).max(dh as f64 / sh as f64);
      let mw = dw as f64 / scale;
      let mh = dh as f64 / scale;
      let sx0 = (sw as f64 - mw) / 2.0;
      let sy0 = (sh as f64 - mh) / 2.0;
      (sx0, sy0, mw, mh)
    }
  };

  let content = match fit {
    FitMode::Contain => {
      let scale = (dw as f64 / sw as f64).min(dh as f64 / sh as f64);
      let mw = (sw as f64 * scale).round().max(1.0) as usize;
      let mh = (sh as f64 * scale).round().max(1.0) as usize;
      let ox = (dw.saturating_sub(mw)) / 2;
      let oy = (dh.saturating_sub(mh)) / 2;
      Some((ox, oy, mw, mh))
    }
    FitMode::Cover => None,
  };

  for y in 0..dh {
    for x in 0..dw {
      let (sx, sy) = match fit {
        FitMode::Cover => {
          let sx = (src_x0 + (x as f64 + 0.5) * map_w / dw as f64) as usize;
          let sy = (src_y0 + (y as f64 + 0.5) * map_h / dh as f64) as usize;
          (sx, sy)
        }
        FitMode::Contain => {
          let (ox, oy, mw, mh) = content.unwrap();
          if x < ox || y < oy || x >= ox + mw || y >= oy + mh {
            continue; // leave black
          }
          let sx = (x - ox) * sw / mw.max(1);
          let sy = (y - oy) * sh / mh.max(1);
          (sx, sy)
        }
      };
      out[y * dw + x] = nv12_y(src, sw, sh, sx, sy);
    }
  }

  let dst_y = dw * dh;
  let uv_dh = dh / 2;
  for y in 0..uv_dh {
    for x in (0..dw).step_by(2) {
      let ly = y * 2;
      let (sx, sy, write) = match fit {
        FitMode::Cover => {
          let sx = (src_x0 + (x as f64 + 0.5) * map_w / dw as f64) as usize;
          let sy = (src_y0 + (ly as f64 + 0.5) * map_h / dh as f64) as usize;
          (sx, sy, true)
        }
        FitMode::Contain => {
          let (ox, oy, mw, mh) = content.unwrap();
          if x < ox || ly < oy || x >= ox + mw || ly >= oy + mh {
            (0, 0, false)
          } else {
            let sx = (x - ox) * sw / mw.max(1);
            let sy = (ly - oy) * sh / mh.max(1);
            (sx, sy, true)
          }
        }
      };
      if !write {
        continue;
      }
      let (u, v) = nv12_uv(src_uv, sw, sh, sx, sy);
      let di = y * dw + x;
      if di + 1 < out.len() - dst_y {
        out[dst_y + di] = u;
        out[dst_y + di + 1] = v;
      }
    }
  }
  out
}

impl Drop for CameraCapture {
  fn drop(&mut self) {
    if let CameraCapture::Ffmpeg { child, .. } = self {
      let _ = child.kill();
      let _ = child.wait();
    }
  }
}

#[cfg(windows)]
fn bump_thread_priority() {
  #[link(name = "kernel32")]
  extern "system" {
    fn GetCurrentThread() -> *mut std::ffi::c_void;
    fn SetThreadPriority(thread: *mut std::ffi::c_void, priority: i32) -> i32;
  }
  // THREAD_PRIORITY_HIGHEST = 2 (stable; TIME_CRITICAL can starve UI)
  unsafe {
    SetThreadPriority(GetCurrentThread(), 2);
  }
}

#[cfg(not(windows))]
fn bump_thread_priority() {}

fn spawn_ffmpeg_raw(
  ffmpeg: &Path,
  device: &str,
  spec: OutputSpec,
  mode: u8,
  fit: FitMode,
) -> Result<std::process::Child, String> {
  let input = format!("video={device}");
  let fps_s = spec.fps.to_string();
  let size_s = format!("{}x{}", spec.w, spec.h);
  let vf = scale_vf_hq(spec, fit);
  let mut cmd = ffmpeg_no_window(ffmpeg);
  cmd.arg("-hide_banner")
    .arg("-loglevel")
    .arg("error")
    .arg("-fflags")
    .arg("nobuffer+discardcorrupt")
    .arg("-flags")
    .arg("low_delay")
    .arg("-thread_queue_size")
    .arg("512")
    .arg("-f")
    .arg("dshow")
    .arg("-rtbufsize")
    .arg("300M");

  // Mode ladder (C930c-class cams often cannot do 1080p60 natively):
  // 0 exact size@fps, 1 mjpeg size@fps, 2 any input + HQ scale + output fps,
  // 3 any input @30 + scale + output fps (best for 1080p60 from 30fps sensors).
  // All modes use OBS-style fit (contain/cover, keep aspect) via scale_vf_hq.
  match mode {
    0 => {
      cmd
        .arg("-framerate")
        .arg(&fps_s)
        .arg("-video_size")
        .arg(&size_s)
        .arg("-i")
        .arg(&input)
        .arg("-an")
        .arg("-vf")
        .arg(&vf)
        .arg("-r")
        .arg(&fps_s);
    }
    1 => {
      cmd
        .arg("-framerate")
        .arg(&fps_s)
        .arg("-video_size")
        .arg(&size_s)
        .arg("-vcodec")
        .arg("mjpeg")
        .arg("-i")
        .arg(&input)
        .arg("-an")
        .arg("-vf")
        .arg(&vf)
        .arg("-r")
        .arg(&fps_s);
    }
    2 => {
      // Do not force input size/fps — let dshow pick a working mode.
      cmd
        .arg("-i")
        .arg(&input)
        .arg("-an")
        .arg("-vf")
        .arg(&vf)
        .arg("-r")
        .arg(&fps_s);
    }
    _ => {
      // Prefer a reliable 30fps input graph, then raise/lower output fps.
      cmd
        .arg("-framerate")
        .arg("30")
        .arg("-i")
        .arg(&input)
        .arg("-an")
        .arg("-vf")
        .arg(&vf)
        .arg("-r")
        .arg(&fps_s);
    }
  }

  cmd
    .arg("-pix_fmt")
    .arg("nv12")
    .arg("-f")
    .arg("rawvideo")
    .arg("pipe:1")
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("启动摄像头采集失败: {e}"))
}

fn read_exact_timeout(
  stdout: &mut impl Read,
  buf: &mut [u8],
  deadline: Instant,
  child: &mut std::process::Child,
  stderr: &mut Option<std::process::ChildStderr>,
  device: &str,
) -> Result<(), String> {
  let mut filled = 0usize;
  while filled < buf.len() {
    if Instant::now() > deadline {
      let mut err = String::new();
      if let Some(ref mut e) = stderr {
        let _ = e.read_to_string(&mut err);
      }
      let _ = child.kill();
      let _ = child.wait();
      return Err(if err.trim().is_empty() {
        format!(
          "无法打开摄像头「{device}」。请先关掉系统相机/其它占用，停止输出后再试。"
        )
      } else {
        format!("无法打开摄像头「{device}」: {}", err.trim())
      });
    }
    match stdout.read(&mut buf[filled..]) {
      Ok(0) => {
        let mut err = String::new();
        if let Some(ref mut e) = stderr {
          let _ = e.read_to_string(&mut err);
        }
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("摄像头「{device}」采集中断。{}", err.trim()));
      }
      Ok(n) => filled += n,
      Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
      Err(e) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("读摄像头帧失败: {e}"));
      }
    }
  }
  Ok(())
}

fn open_camera_capture(
  device: &str,
  spec: OutputSpec,
  fit: FitMode,
) -> Result<CameraCapture, String> {
  // D1: prefer in-process Media Foundation (no ffmpeg child).
  // MF opens near-native size; we software-scale with FitMode (OBS bounding box).
  #[cfg(windows)]
  {
    match crate::vcam_mf::MfCamera::open(device, spec.w, spec.h, spec.fps) {
      Ok(cam) => {
        return Ok(CameraCapture::Mf { cam });
      }
      Err(e) => {
        eprintln!("[vcam] MF capture failed, fallback ffmpeg: {e}");
      }
    }
  }
  open_camera_capture_ffmpeg(device, spec, fit)
}

fn open_camera_capture_ffmpeg(
  device: &str,
  spec: OutputSpec,
  fit: FitMode,
) -> Result<CameraCapture, String> {
  let ffmpeg = ffmpeg_util::find_tool("ffmpeg.exe")
    .or_else(|| ffmpeg_util::find_tool("ffmpeg"))
    .ok_or_else(|| "找不到 ffmpeg.exe，无法采集摄像头".to_string())?;

  let frame_size = spec.frame_bytes();
  let mut last_err = String::new();

  // Try capture modes best→fallback (OBS also negotiates formats, not a single fixed path).
  for mode in [0u8, 1u8, 2u8, 3u8] {
    let mut child = match spawn_ffmpeg_raw(&ffmpeg, device, spec, mode, fit) {
      Ok(c) => c,
      Err(e) => {
        last_err = e;
        continue;
      }
    };
    let mut stdout = match child.stdout.take() {
      Some(s) => s,
      None => {
        let _ = child.kill();
        last_err = "ffmpeg 无 stdout".into();
        continue;
      }
    };
    let mut stderr = child.stderr.take();
    let mut buf = vec![0u8; frame_size];
    let deadline = Instant::now() + Duration::from_secs(5);
    match read_exact_timeout(
      &mut stdout,
      &mut buf,
      deadline,
      &mut child,
      &mut stderr,
      device,
    ) {
      Ok(()) => {
        return Ok(CameraCapture::Ffmpeg {
          child,
          stdout,
          frame_size,
          first_frame: buf,
        });
      }
      Err(e) => {
        last_err = e;
        // child already killed inside timeout helper on error
      }
    }
  }

  Err(if last_err.is_empty() {
    format!("无法打开摄像头「{device}」")
  } else {
    last_err
  })
}

/// Run one open capture until stop or pipe error. Returns frame index.
/// `out_spec` is SHM geometry; capture may be scaled to match (L2 reconfigure).
fn pump_camera_to_shm(
  stop: &AtomicBool,
  frames: &AtomicU64,
  preview_tx: &std::sync::mpsc::SyncSender<Vec<u8>>,
  writer: &mut VideoQueueWriter,
  mut cam: CameraCapture,
  frame_i0: u64,
  out_spec: OutputSpec,
  cap_spec: OutputSpec,
  fit: FitMode,
) -> Result<u64, String> {
  // Software fit when capture geometry ≠ canvas (MF native / L2). Ffmpeg already fits in vf.
  let need_scale = cap_spec.w != out_spec.w || cap_spec.h != out_spec.h;
  let frame_size = cam.frame_size();
  let mut buf_a = cam.take_first_frame();
  if buf_a.len() != frame_size {
    buf_a.resize(frame_size, 0);
  }
  let mut buf_b = vec![0u8; frame_size];
  let mut use_a = true;

  let publish = |writer: &mut VideoQueueWriter,
                 frames: &AtomicU64,
                 preview_tx: &std::sync::mpsc::SyncSender<Vec<u8>>,
                 raw: &[u8],
                 frame_i: u64|
   -> u64 {
    let out = if need_scale {
      scale_nv12_fit(
        raw,
        cap_spec.w,
        cap_spec.h,
        out_spec.w,
        out_spec.h,
        fit,
      )
    } else {
      raw.to_vec()
    };
    let ts = frame_i.saturating_mul(out_spec.interval);
    writer.write_nv12(&out, ts);
    let n = frames.fetch_add(1, Ordering::Relaxed) + 1;
    if n % 10 == 0 {
      let _ = preview_tx.try_send(out);
    }
    frame_i + 1
  };

  let mut frame_i = frame_i0;
  frame_i = publish(writer, frames, preview_tx, &buf_a, frame_i);

  while !stop.load(Ordering::SeqCst) {
    let read_buf = if use_a {
      buf_b.as_mut_slice()
    } else {
      buf_a.as_mut_slice()
    };
    match cam.read_frame(read_buf) {
      Ok(()) => {
        frame_i = publish(writer, frames, preview_tx, read_buf, frame_i);
        use_a = !use_a;
      }
      Err(_) => return Ok(frame_i),
    }
  }
  Ok(frame_i)
}

/// Result of opening capture on the worker thread (COM-safe for MF).
struct OpenReady {
  backend: String,
  /// Spec used for SHM writer.
  out_spec: OutputSpec,
  warn: Option<String>,
}

fn wait_shm_free(max_ms: u64) -> bool {
  let steps = (max_ms / 50).max(1);
  for _ in 0..steps {
    if !shm_is_open() {
      return true;
    }
    thread::sleep(Duration::from_millis(50));
  }
  !shm_is_open()
}

fn open_camera_with_fallback(
  device: &str,
  requested: OutputSpec,
  fit: FitMode,
) -> Result<(CameraCapture, OutputSpec, Option<String>), String> {
  // Fallback ladder stays in the same aspect family (like lowering OBS canvas res).
  let mut attempts = vec![requested];
  let family: &[(u32, u32)] = if requested.w > requested.h {
    // landscape: prefer 16:9 then 4:3-ish
    &[(1920, 1080), (1280, 720), (1440, 1080), (640, 480)]
  } else if requested.w < requested.h {
    // portrait 9:16
    &[(1080, 1920), (720, 1280), (540, 960)]
  } else {
    &[(1080, 1080), (720, 720)]
  };
  for &(fw, fh) in family {
    let fb = OutputSpec::resolve(Some(fw), Some(fh), Some(30));
    if !attempts
      .iter()
      .any(|s| s.w == fb.w && s.h == fb.h && s.fps == fb.fps)
    {
      attempts.push(fb);
    }
  }
  let mut last_err = String::new();
  for (i, try_spec) in attempts.iter().enumerate() {
    // Only pause between retries (first open: no artificial delay — faster start).
    if i > 0 {
      thread::sleep(Duration::from_millis(200));
    }
    write_res_file(try_spec.w, try_spec.h, try_spec.interval);
    match open_camera_capture(device, *try_spec, fit) {
      Ok(cam) => {
        let warn = if i > 0 {
          Some(format!(
            "摄像头不支持 {}，已自动改用 {}。直播伴侣请选 {}×{} / {}fps / NV12。",
            requested.label(),
            try_spec.label(),
            try_spec.w,
            try_spec.h,
            try_spec.fps
          ))
        } else {
          None
        };
        // Report true capture geometry (MF native), not canvas size — avoids stretch bugs.
        let (cw, ch) = cam.capture_size();
        let cap_spec = if cw > 0 && ch > 0 {
          OutputSpec {
            w: cw,
            h: ch,
            fps: try_spec.fps,
            interval: try_spec.interval,
          }
        } else {
          *try_spec
        };
        return Ok((cam, cap_spec, warn));
      }
      Err(e) => last_err = e,
    }
  }
  Err(if last_err.is_empty() {
    format!("无法打开摄像头「{device}」")
  } else {
    format!(
      "{last_err}（若提示设备占用：请点停止输出，关掉系统相机，再重试。1080p60 多数摄像头不支持，请改用 1080p30。）"
    )
  })
}

/// Capture worker: open camera **on this thread** (MF COM affinity), write SHM, reconnect.
fn spawn_camera_thread(
  stop: Arc<AtomicBool>,
  frames: Arc<AtomicU64>,
  preview: Arc<Mutex<Option<PreviewRgba>>>,
  device: String,
  requested: OutputSpec,
  // If set, SHM is forced to this size (L2 scale path); capture still uses `requested`.
  force_out_spec: Option<OutputSpec>,
  fit: FitMode,
  ready_tx: std::sync::mpsc::Sender<Result<OpenReady, String>>,
) -> thread::JoinHandle<()> {
  thread::spawn(move || {
    bump_thread_priority();

    let open = match open_camera_with_fallback(&device, requested, fit) {
      Ok(v) => v,
      Err(e) => {
        let _ = ready_tx.send(Err(e));
        return;
      }
    };
    let (first_cam, cap_spec, mut warn) = open;
    let backend = first_cam.backend().to_string();
    if backend == "ffmpeg" {
      let msg = "已使用兼容采集模式（ffmpeg）。".to_string();
      warn = Some(match warn {
        Some(w) => format!("{w} {msg}"),
        None => msg,
      });
    }

    // Canvas = user quality×aspect (`requested`), NOT camera native size.
    // Previously used cap_spec here → 清晰度档位形同虚设（输出永远跟摄像头分辨率）。
    let out_spec = force_out_spec.unwrap_or(requested);
    write_res_file(out_spec.w, out_spec.h, out_spec.interval);
    wait_shm_free(200);

    let mut writer = match VideoQueueWriter::create(out_spec.w, out_spec.h, out_spec.interval) {
      Ok(w) => w,
      Err(e) => {
        let _ = ready_tx.send(Err(e));
        return;
      }
    };

    if cap_spec.w != out_spec.w || cap_spec.h != out_spec.h {
      let msg = if force_out_spec.is_some() {
        format!(
          "直播伴侣仍占用虚拟摄像头，已按 {} 缩放输出到 {}。若要原生分辨率，请在伴侣中取消/重选 FLYBOX 后再切一次。",
          cap_spec.label(),
          out_spec.label()
        )
      } else {
        format!(
          "摄像头采集 {}，画布输出 {}（清晰度/比例已生效，按画面适配缩放）。",
          cap_spec.label(),
          out_spec.label()
        )
      };
      warn = Some(match warn {
        Some(w) => format!("{w} {msg}"),
        None => msg,
      });
    }

    let _ = ready_tx.send(Ok(OpenReady {
      backend: backend.clone(),
      out_spec,
      warn,
    }));

    let (preview_tx, preview_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(1);
    let preview_stop = stop.clone();
    let preview_for_worker = preview.clone();
    let pw = out_spec.w;
    let ph = out_spec.h;
    let _preview_worker = thread::spawn(move || {
      while !preview_stop.load(Ordering::SeqCst) {
        match preview_rx.recv_timeout(Duration::from_millis(200)) {
          Ok(nv12) => {
            let p = nv12_to_rgba_half(&nv12, pw, ph);
            if let Ok(mut g) = preview_for_worker.lock() {
              *g = Some(p);
            }
          }
          Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
          Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
      }
    });

    let mut frame_i = 0u64;
    let mut next = Some(first_cam);
    // Re-open at canvas request size (ffmpeg ladder); MF ignores size and stays native.
    let reopen_spec = requested;

    while !stop.load(Ordering::SeqCst) {
      let cam = match next.take() {
        Some(c) => c,
        None => match open_camera_capture(&device, reopen_spec, fit) {
          Ok(c) => c,
          Err(_) => {
            if stop.load(Ordering::SeqCst) {
              break;
            }
            thread::sleep(Duration::from_millis(400));
            continue;
          }
        },
      };
          // MF = native cam size → software-fit to canvas (contain/cover).
      // Ffmpeg = already canvas-sized via vf; capture_size (0,0) means packed = copy.
      let (cw, ch) = match cam.capture_size() {
        (0, 0) => (out_spec.w, out_spec.h),
        (w, h) => (w, h),
      };
      let this_cap = OutputSpec {
        w: cw,
        h: ch,
        fps: out_spec.fps,
        interval: out_spec.interval,
      };

      match pump_camera_to_shm(
        &stop,
        &frames,
        &preview_tx,
        &mut writer,
        cam,
        frame_i,
        out_spec,
        this_cap,
        fit,
      ) {
        Ok(fi) => {
          frame_i = fi;
          if stop.load(Ordering::SeqCst) {
            break;
          }
          thread::sleep(Duration::from_millis(200));
        }
        Err(_) => thread::sleep(Duration::from_millis(300)),
      }
    }
    drop(preview_tx);
    drop(writer);
  })
}

fn start_output(
  state: &VcamState,
  source: Option<String>,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
  fit_mode: Option<String>,
  max_width: Option<u32>,
  max_height: Option<u32>,
) -> Result<(), String> {
  start_output_ex(
    state,
    source,
    width,
    height,
    fps,
    None,
    FitMode::parse(fit_mode.as_deref()),
    max_width,
    max_height,
  )
}

/// `force_out_spec`: L2 path — SHM geometry forced (scale capture into it).
fn start_output_ex(
  state: &VcamState,
  source: Option<String>,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
  force_out_spec: Option<OutputSpec>,
  fit: FitMode,
  max_width: Option<u32>,
  max_height: Option<u32>,
) -> Result<(), String> {
  if !is_filter_registered() {
    return Err("请先安装/注册虚拟摄像头设备".into());
  }
  {
    let g = lock(state)?;
    if g.running {
      return Ok(());
    }
  }

  let source = source
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty() && s != "__test__");

  if let Some(ref name) = source {
    if name.eq_ignore_ascii_case(DEVICE_NAME) {
      return Err("不能把 FLYBOX Camera 自己当作输入源".into());
    }
  }

  let mut requested = OutputSpec::resolve(width, height, fps);
  let mut start_warn: Option<String> = None;

  // Product rule: canvas adapts to camera max. Prefer UI/list cache — avoid slow re-probe on start.
  if let Some(ref name) = source {
    if let Some((mw, mh)) = resolve_cam_max(name, max_width, max_height) {
      let (clamped, did) = clamp_canvas_to_camera(requested, mw, mh);
      if did {
        start_warn = Some(format!(
          "本摄像头最高约 {}×{}，已按硬件能力输出 {}（不会假升清晰度）。",
          mw,
          mh,
          clamped.label()
        ));
        requested = clamped;
      }
    }
  }
  write_res_file(requested.w, requested.h, requested.interval);

  let stop = Arc::new(AtomicBool::new(false));
  let frames = Arc::new(AtomicU64::new(0));
  let preview = Arc::new(Mutex::new(None));

  if let Some(name) = source.clone() {
    // Camera open happens **on the capture thread** (MF COM affinity).
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let join = spawn_camera_thread(
      stop.clone(),
      frames.clone(),
      preview.clone(),
      name,
      requested,
      force_out_spec,
      fit,
      ready_tx,
    );
    let ready = match ready_rx.recv_timeout(Duration::from_secs(15)) {
      Ok(r) => r,
      Err(_) => {
        stop.store(true, Ordering::SeqCst);
        let _ = join.join();
        return Err("打开摄像头超时，请重试".into());
      }
    };
    match ready {
      Ok(info) => {
        let mut g = lock(state)?;
        if g.running {
          stop.store(true, Ordering::SeqCst);
          drop(g);
          let _ = join.join();
          return Ok(());
        }
        g.stop = Some(stop);
        g.join = Some(join);
        g.frames = frames;
        g.preview = preview;
        g.source = source;
        g.spec = info.out_spec;
        g.warn = match (start_warn, info.warn) {
          (Some(a), Some(b)) => Some(format!("{a} {b}")),
          (Some(a), None) => Some(a),
          (None, b) => b,
        };
        g.capture_backend = Some(info.backend);
        g.fit_mode = fit;
        g.running = true;
        Ok(())
      }
      Err(e) => {
        stop.store(true, Ordering::SeqCst);
        let _ = join.join();
        Err(e)
      }
    }
  } else {
    // Test pattern — no COM/camera.
    let spec = force_out_spec.unwrap_or(requested);
    write_res_file(spec.w, spec.h, spec.interval);
    wait_shm_free(200);
    let join = spawn_push_thread(stop.clone(), frames.clone(), preview.clone(), spec)?;
    let mut g = lock(state)?;
    g.stop = Some(stop);
    g.join = Some(join);
    g.frames = frames;
    g.preview = preview;
    g.source = None;
    g.spec = spec;
    g.warn = None;
    g.capture_backend = Some("test".into());
    g.fit_mode = fit;
    g.running = true;
    Ok(())
  }
}

fn stop_worker(state: &VcamState) -> Result<(), String> {
  let (stop_flag, join) = {
    let mut g = lock(state)?;
    (g.stop.take(), g.join.take())
  };
  if let Some(s) = stop_flag {
    s.store(true, Ordering::SeqCst);
  }
  if let Some(j) = join {
    let _ = j.join();
  }
  Ok(())
}

fn stop_output(state: &VcamState) -> Result<(), String> {
  stop_worker(state)?;
  let mut g = lock(state)?;
  g.running = false;
  g.source = None;
  g.spec = DEFAULT_SPEC;
  g.warn = None;
  g.capture_backend = None;
  g.fit_mode = FitMode::Contain;
  g.frames = Arc::new(AtomicU64::new(0));
  if let Ok(mut p) = g.preview.lock() {
    *p = None;
  }
  g.preview = Arc::new(Mutex::new(None));
  Ok(())
}

/// Hot-switch resolution/fps/fit. L1: recreate SHM. L2: keep old SHM size + scale if companion holds mapping.
fn reconfigure_output(
  state: &VcamState,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
  fit_mode: Option<String>,
  max_width: Option<u32>,
  max_height: Option<u32>,
) -> Result<(), String> {
  let (source, old_spec, old_fit) = {
    let g = lock(state)?;
    if !g.running {
      return Err("请先开始输出，再切换分辨率".into());
    }
    (g.source.clone(), g.spec, g.fit_mode)
  };
  let mut new_spec = OutputSpec::resolve(width, height, fps);
  let new_fit = fit_mode
    .as_deref()
    .map(|s| FitMode::parse(Some(s)))
    .unwrap_or(old_fit);

  // Apply camera-max clamp before compare (same as start).
  let caps = if let Some(ref name) = source {
    resolve_cam_max(name, max_width, max_height).map(|(w, h)| (Some(w), Some(h)))
  } else {
    None
  }
  .unwrap_or((None, None));
  if let (Some(mw), Some(mh)) = (caps.0, caps.1) {
    let (clamped, _) = clamp_canvas_to_camera(new_spec, mw, mh);
    new_spec = clamped;
  }

  if new_spec.w == old_spec.w
    && new_spec.h == old_spec.h
    && new_spec.fps == old_spec.fps
    && new_fit == old_fit
  {
    return Ok(());
  }

  // Tear down writer (STOPPING) but remember we are reconfiguring.
  stop_worker(state)?;
  {
    let mut g = lock(state)?;
    g.running = false;
    g.stop = None;
    g.join = None;
    g.capture_backend = None;
  }

  // Clarity/aspect MUST change SHM size. Never keep old canvas (old L2 made every
  // quality tier look identical while companion held the mapping).
  let free = wait_shm_free(4000);

  if !free {
    // Restore previous output so user is not left stopped.
    let _ = start_output_ex(
      state,
      source.clone(),
      Some(old_spec.w),
      Some(old_spec.h),
      Some(old_spec.fps),
      None,
      old_fit,
      caps.0,
      caps.1,
    );
    return Err(
      "无法切换清晰度/比例：共享内存仍被占用。请先在直播伴侣中取消选择 FLYBOX Camera，再切换。"
        .into(),
    );
  }

  match start_output_ex(
    state,
    source.clone(),
    Some(new_spec.w),
    Some(new_spec.h),
    Some(new_spec.fps),
    None, // always new canvas size — never force old_spec
    new_fit,
    caps.0,
    caps.1,
  ) {
    Ok(()) => Ok(()),
    Err(e) => {
      let _ = start_output_ex(
        state,
        source,
        Some(old_spec.w),
        Some(old_spec.h),
        Some(old_spec.fps),
        None,
        old_fit,
        caps.0,
        caps.1,
      );
      Err(format!(
        "切换到 {} 失败：{e}。若伴侣正开着 FLYBOX，请先取消选择后再试。",
        new_spec.label()
      ))
    }
  }
}

#[tauri::command]
pub fn vcam_status(state: tauri::State<'_, VcamState>) -> Result<VcamStatus, String> {
  collect_status(&state)
}

#[tauri::command]
pub fn vcam_list_sources() -> Result<Vec<VcamSource>, String> {
  list_video_sources()
}

/// Latest half-res JPEG preview of what is being pushed to FLYBOX Camera.
#[tauri::command]
pub fn vcam_preview(state: tauri::State<'_, VcamState>) -> Result<Option<VcamPreview>, String> {
  // Clone pixels under a short lock, then encode outside the mutex.
  let snap = {
    let g = lock(&state)?;
    let guard = g
      .preview
      .lock()
      .map_err(|_| "preview lock poisoned".to_string())?;
    guard.as_ref().map(|p| PreviewRgba {
      width: p.width,
      height: p.height,
      rgba: p.rgba.clone(),
    })
  };
  Ok(snap.and_then(|p| {
    let data_url = preview_to_data_url(&p)?;
    Some(VcamPreview {
      width: p.width,
      height: p.height,
      data_url,
    })
  }))
}

#[tauri::command]
pub fn vcam_install(_state: tauri::State<'_, VcamState>) -> Result<(), String> {
  let dll = resolve_dll().ok_or_else(|| {
    "找不到 flybox-virtualcam-module64.dll。请编译 src-vcam 后使用 dist/ 下的 DLL。"
      .to_string()
  })?;
  elevate_regsvr32(&dll, false)?;
  thread::sleep(Duration::from_millis(500));
  if !is_filter_registered() {
    return Err(
      "注册后仍未检测到设备。请右键管理员运行 src-vcam/dist/flybox-vcam-install.bat".into(),
    );
  }
  Ok(())
}

#[tauri::command]
pub fn vcam_uninstall(state: tauri::State<'_, VcamState>) -> Result<(), String> {
  stop_output(&state)?;
  let dll = resolve_dll().ok_or_else(|| "找不到 DLL，无法注销。".to_string())?;
  elevate_regsvr32(&dll, true)?;
  Ok(())
}

/// `source`: physical camera dshow name. Empty / null = test pattern bars.
/// `width`/`height`/`fps`: output preset (default 1920×1080@30).
/// `fit_mode`: OBS bounding-box style — `contain` | `cover` (keep aspect; no stretch).
/// `max_width`/`max_height`: camera caps from list (avoids slow re-probe on start).
#[tauri::command]
pub fn vcam_start(
  state: tauri::State<'_, VcamState>,
  source: Option<String>,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
  fit_mode: Option<String>,
  max_width: Option<u32>,
  max_height: Option<u32>,
) -> Result<(), String> {
  start_output(
    &state,
    source,
    width,
    height,
    fps,
    fit_mode,
    max_width,
    max_height,
  )
}

/// Kept for compatibility; camera path is native ffmpeg (OBS-style), not UI JPEG.
#[tauri::command]
pub fn vcam_push_jpeg(
  _state: tauri::State<'_, VcamState>,
  _jpeg: Option<Vec<u8>>,
  _jpeg_base64: Option<String>,
) -> Result<(), String> {
  Ok(())
}

#[tauri::command]
pub fn vcam_stop(state: tauri::State<'_, VcamState>) -> Result<(), String> {
  stop_output(&state)
}

/// Change output resolution/fps/fit while already running (companion may need reselect).
#[tauri::command]
pub fn vcam_reconfigure(
  state: tauri::State<'_, VcamState>,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
  fit_mode: Option<String>,
  max_width: Option<u32>,
  max_height: Option<u32>,
) -> Result<(), String> {
  reconfigure_output(
    &state,
    width,
    height,
    fps,
    fit_mode,
    max_width,
    max_height,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn dll_resolves_from_src_vcam_dist() {
    let p = resolve_dll().expect("DLL should exist under src-vcam/dist or build");
    assert!(p.is_file(), "missing {:?}", p);
    assert!(
      p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .contains("flybox-virtualcam-module64"),
      "unexpected dll name {:?}",
      p
    );
  }

  #[test]
  fn status_device_name_is_flybox_camera() {
    let state = VcamState::default();
    let s = collect_status(&state).expect("status");
    assert_eq!(s.device_name, "FLYBOX Camera");
    assert_eq!(s.device_name, DEVICE_NAME);
    assert!(!s.running);
    assert!(s.dll_path.is_some(), "dll_path should resolve for status");
  }

  #[test]
  fn start_stop_push_when_registered() {
    let state = VcamState::default();
    if !is_filter_registered() {
      // Still prove unregistered path refuses start.
      let err = start_output(&state, None, None, None, None, None, None, None)
        .expect_err("start must fail when unregistered");
      assert!(err.contains("安装") || err.contains("注册"), "{err}");
      return;
    }
    if shm_is_open() {
      eprintln!("skip start_stop: SHM already held by another process");
      return;
    }

    start_output(
      &state,
      None,
      Some(1280),
      Some(720),
      Some(30),
      None,
      None,
      None,
    )
    .expect("start_output test pattern");
    let mid = collect_status(&state).expect("status while running");
    assert!(mid.running, "running should be true after start");
    assert!(mid.source.is_none(), "test pattern has no physical source");
    assert_eq!(mid.device_name, "FLYBOX Camera");
    // Give writer a moment to create SHM and first frames.
    thread::sleep(Duration::from_millis(200));
    assert!(shm_is_open(), "SHM {SHM_NAME} should exist while pushing");
    let mid2 = collect_status(&state).expect("status2");
    assert!(mid2.pushing, "pushing should be true");
    assert!(mid2.frames > 0, "should have written frames");

    stop_output(&state).expect("stop_output");
    let after = collect_status(&state).expect("status after stop");
    assert!(!after.running, "running should be false after stop");
    // Mapping should release shortly after stop (Drop closes handle).
    thread::sleep(Duration::from_millis(80));
    assert!(!shm_is_open(), "SHM should be gone after stop");
  }

  #[test]
  fn list_sources_excludes_flybox_virtual() {
    let list = list_video_sources().unwrap_or_default();
    for s in &list {
      assert!(
        !s.name.eq_ignore_ascii_case("FLYBOX Camera"),
        "must not list self: {}",
        s.name
      );
    }
  }

  #[test]
  fn video_queue_ffi_create_write_close() {
    // If another session holds the mapping, skip rather than fail the suite.
    if shm_is_open() {
      return;
    }
    let mut w = VideoQueueWriter::create(64, 48, 333_333).expect("create queue");
    let frame = make_nv12_test(64, 48, 0);
    w.write_nv12(&frame, 0);
    assert!(shm_is_open(), "mapping should exist while writer lives");
    drop(w);
    // Do not assert mapping gone: parallel tests / running tauri dev share SHM name.
  }

  /// Deep check: quality tier must change real SHM + status + res file (not just UI labels).
  #[test]
  fn quality_tier_changes_real_shm_geometry() {
    if !is_filter_registered() {
      eprintln!("skip: filter not registered");
      return;
    }
    if shm_is_open() {
      eprintln!("skip: SHM held by another process (close FLYBOX/companion first)");
      return;
    }

    let state = VcamState::default();

    // --- 720p ---
    start_output(
      &state,
      None, // test pattern — pure canvas size, no camera clamp
      Some(1280),
      Some(720),
      Some(30),
      None,
      None,
      None,
    )
    .expect("start 720p");
    thread::sleep(Duration::from_millis(250));

    let st720 = collect_status(&state).expect("status 720");
    assert!(st720.running, "should be running at 720p");
    assert_eq!(st720.width, 1280, "status width must be 1280 at 720p");
    assert_eq!(st720.height, 720, "status height must be 720 at 720p");

    let shm720 = read_shm_geometry().expect("SHM must exist at 720p");
    assert_eq!(shm720, (1280, 720), "SHM header must be 1280x720, got {shm720:?}");

    let res720 = read_res_file_geometry().expect("res file after 720p");
    assert_eq!(res720, (1280, 720), "res file must be 1280x720, got {res720:?}");

    stop_output(&state).expect("stop 720p");
    thread::sleep(Duration::from_millis(200));
    assert!(!shm_is_open(), "SHM should release after stop");

    // --- 1080p ---
    start_output(
      &state,
      None,
      Some(1920),
      Some(1080),
      Some(30),
      None,
      None,
      None,
    )
    .expect("start 1080p");
    thread::sleep(Duration::from_millis(250));

    let st1080 = collect_status(&state).expect("status 1080");
    assert!(st1080.running, "should be running at 1080p");
    assert_eq!(st1080.width, 1920, "status width must be 1920 at 1080p");
    assert_eq!(st1080.height, 1080, "status height must be 1080 at 1080p");

    let shm1080 = read_shm_geometry().expect("SHM must exist at 1080p");
    assert_eq!(
      shm1080,
      (1920, 1080),
      "SHM header must be 1920x1080, got {shm1080:?}"
    );

    let res1080 = read_res_file_geometry().expect("res file after 1080p");
    assert_eq!(res1080, (1920, 1080), "res file must be 1920x1080, got {res1080:?}");

    // Prove the two tiers are not the same geometry.
    assert_ne!(
      shm720, shm1080,
      "720p and 1080p SHM geometry must differ"
    );

    stop_output(&state).expect("stop 1080p");
    eprintln!("OK: SHM 720p={shm720:?} → 1080p={shm1080:?} (quality tier is real)");
  }

  #[test]
  fn dshow_list_options_picks_real_1080_not_tiny() {
    let sample = r#"
[dshow @ 0] DirectShow video device options
[dshow @ 0]  Pin "Capture"
[dshow @ 0]   pixel_format=yuyv422  min s=160x120 fps=5 max s=1920x1080 fps=30
[dshow @ 0]   vcodec=mjpeg  min s=320x240 fps=5 max s=1920x1080 fps=30
[dshow @ 0]   s=800x448 fps=30
"#;
    let (w, h) = parse_dshow_list_options_max(sample).expect("should find 1080p");
    assert_eq!((w, h), (1920, 1080));
    assert!(is_plausible_cam_max(w, h));
    assert!(!is_plausible_cam_max(800, 448));
  }

  #[test]
  fn fit_contain_letterboxes_wide_into_tall() {
    // 4x2 white Y into 4x4 contain → top/bottom dark bars.
    let sw = 4u32;
    let sh = 2u32;
    let mut src = vec![235u8; (sw * sh) as usize];
    src.resize((sw * sh + sw * sh / 2) as usize, 128);
    let out = scale_nv12_fit(&src, sw, sh, 4, 4, FitMode::Contain);
    // Corners of canvas should stay near black (letterbox).
    assert!(out[0] < 40, "top-left should be bar, got {}", out[0]);
    assert!(out[4 * 3] < 40, "bottom row should be bar, got {}", out[4 * 3]);
    // Middle content row should be bright.
    assert!(out[4 * 1 + 1] > 200, "content should be bright");
  }

  #[test]
  fn reconfigure_requires_running() {
    let state = VcamState::default();
    let err =
      reconfigure_output(&state, Some(1280), Some(720), Some(30), None, None, None)
        .expect_err("must fail when idle");
    assert!(err.contains("开始输出") || err.contains("切换"), "{err}");
  }

  #[test]
  fn reconfigure_test_pattern_when_registered() {
    let state = VcamState::default();
    if !is_filter_registered() {
      return;
    }
    if shm_is_open() {
      eprintln!("skip reconfigure: SHM already held by another process");
      return;
    }
    start_output(
      &state,
      None,
      Some(1280),
      Some(720),
      Some(30),
      None,
      None,
      None,
    )
    .expect("start 720");
    thread::sleep(Duration::from_millis(150));
    reconfigure_output(
      &state,
      Some(1920),
      Some(1080),
      Some(30),
      Some("contain".into()),
      None,
      None,
    )
    .expect("to 1080");
    thread::sleep(Duration::from_millis(200));
    let s = collect_status(&state).expect("status");
    assert!(s.running);
    assert_eq!(s.width, 1920);
    assert_eq!(s.height, 1080);
    assert!(s.frames > 0 || s.pushing);
    stop_output(&state).expect("stop");
  }
}
