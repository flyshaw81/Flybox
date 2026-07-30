//! FLYBOX virtual camera (OBS win-dshow based filter DLL + shared-memory frames).

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::ffmpeg_util;

/// Must match `virtualcam-guid.h` / filter registration.
const DEVICE_CLSID: &str = "{A8E7F6D5-C4B3-4A29-9E1D-8C7B6A594837}";
const DEVICE_NAME: &str = "FLYBOX Camera";
/// Must match `shared-memory-queue.c` VIDEO_NAME.
const SHM_NAME: &str = "FLYBOXVirtualCamVideo";

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
  fn resolve(width: Option<u32>, height: Option<u32>, fps: Option<u32>) -> Self {
    let (w, h) = match (width.unwrap_or(1920), height.unwrap_or(1080)) {
      (1920, 1080) => (1920, 1080),
      (1280, 720) => (1280, 720),
      (640, 360) => (640, 360),
      (ww, _) if ww >= 1600 => (1920, 1080),
      (ww, _) if ww >= 1000 => (1280, 720),
      _ => (1920, 1080),
    };
    let fps = match fps.unwrap_or(30) {
      60 => 60,
      _ => 30,
    };
    let interval = 10_000_000u64 / u64::from(fps);
    Self { w, h, fps, interval }
  }

  fn frame_bytes(self) -> usize {
    (self.w as usize) * (self.h as usize) * 3 / 2
  }

  fn sleep_ms(self) -> u64 {
    (1000 / self.fps.max(1)) as u64
  }

  fn label(self) -> String {
    format!("{}x{}@{}fps", self.w, self.h, self.fps)
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
  /// Non-empty when output is test bars after a camera problem (or similar).
  pub warn: Option<String>,
  /// `mf` | `ffmpeg` | `test` while running; null when idle.
  pub capture_backend: Option<String>,
  pub message: String,
  pub source_note: String,
  pub dll_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamSource {
  pub name: String,
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
  fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
}

const FILE_MAP_ALL_ACCESS: u32 = 0xF001F;

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

/// List video capture devices (MF first, ffmpeg dshow fallback). Excludes FLYBOX.
pub fn list_video_sources() -> Result<Vec<VcamSource>, String> {
  #[cfg(windows)]
  {
    if let Ok(mf_names) = crate::vcam_mf::list_video_device_names() {
      if !mf_names.is_empty() {
        return Ok(
          mf_names
            .into_iter()
            .map(|name| VcamSource { name })
            .collect(),
        );
      }
    }
  }
  list_video_sources_ffmpeg()
}

fn list_video_sources_ffmpeg() -> Result<Vec<VcamSource>, String> {
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
  // ffmpeg prints device list to stderr and exits non-zero; still parse it.
  let text = decode_ffmpeg_bytes(&out.stderr);
  let mut names = Vec::new();
  for line in text.lines() {
    // e.g. [dshow @ ...] "Device Name" (video)
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
    // Do not offer our own virtual device as a capture source.
    if name.eq_ignore_ascii_case(DEVICE_NAME) || name.contains("FLYBOX Camera") {
      continue;
    }
    if names.iter().any(|s: &VcamSource| s.name == name) {
      continue;
    }
    names.push(VcamSource {
      name: name.to_string(),
    });
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
    if let Some(ref src) = g.source {
      format!(
        "正在输出「{src}」→ FLYBOX Camera {geo}（已送 {frame_n} 帧）。直播伴侣选同分辨率。"
      )
    } else {
      format!(
        "正在输出测试彩条 → FLYBOX Camera {geo}（已送 {frame_n} 帧）。"
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
    warn: g.warn.clone(),
    capture_backend: g.capture_backend.clone(),
    message,
    source_note:
      "基于 OBS plugins/win-dshow 虚拟摄像头（GPL）。源码：src-vcam/；上架前公开本模块。"
        .into(),
    dll_path: dll.map(|p| p.display().to_string()),
  })
}

/// High-quality scale to target NV12 (lanczos + full chroma — closer to OBS quality).
/// bt709 + limited (tv) range matches typical live encode / companion expectations.
fn scale_vf_hq(spec: OutputSpec) -> String {
  format!(
    "scale={w}:{h}:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp:\
     force_original_aspect_ratio=decrease,\
     pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,\
     setsar=1,\
     format=nv12,\
     colorspace=bt709:iall=bt709:fast=1",
    w = spec.w,
    h = spec.h
  )
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

/// Nearest-neighbor scale packed NV12 → packed NV12 (L2 reconfigure fallback).
fn scale_nv12_nearest(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
  let sw = sw.max(1) as usize;
  let sh = sh.max(1) as usize;
  let dw = dw.max(1) as usize;
  let dh = dh.max(1) as usize;
  let src_y = sw * sh;
  let need_src = src_y + src_y / 2;
  let mut out = vec![0u8; dw * dh + dw * dh / 2];
  if src.len() < need_src {
    return out;
  }
  for y in 0..dh {
    let sy = y * sh / dh;
    for x in 0..dw {
      let sx = x * sw / dw;
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  let dst_y = dw * dh;
  let src_uv = &src[src_y..];
  let uv_dh = dh / 2;
  let uv_sh = sh / 2;
  for y in 0..uv_dh {
    let sy = y * uv_sh / uv_dh.max(1);
    for x in 0..dw {
      // UV is interleaved; sample even x for U pair start.
      let sx = (x * sw / dw) & !1;
      let si = sy * sw + sx.min(sw - 1);
      let di = y * dw + x;
      if si < src_uv.len() && di < out.len() - dst_y {
        out[dst_y + di] = src_uv[si];
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
) -> Result<std::process::Child, String> {
  let input = format!("video={device}");
  let fps_s = spec.fps.to_string();
  let size_s = format!("{}x{}", spec.w, spec.h);
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
        .arg(format!(
          "scale={w}:{h}:flags=bicubic,format=nv12",
          w = spec.w,
          h = spec.h
        ))
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
        .arg(scale_vf_hq(spec))
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
        .arg(scale_vf_hq(spec))
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
        .arg(scale_vf_hq(spec))
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

fn open_camera_capture(device: &str, spec: OutputSpec) -> Result<CameraCapture, String> {
  // D1: prefer in-process Media Foundation (no ffmpeg child).
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
  open_camera_capture_ffmpeg(device, spec)
}

fn open_camera_capture_ffmpeg(device: &str, spec: OutputSpec) -> Result<CameraCapture, String> {
  let ffmpeg = ffmpeg_util::find_tool("ffmpeg.exe")
    .or_else(|| ffmpeg_util::find_tool("ffmpeg"))
    .ok_or_else(|| "找不到 ffmpeg.exe，无法采集摄像头".to_string())?;

  let frame_size = spec.frame_bytes();
  let mut last_err = String::new();

  // Try capture modes best→fallback (OBS also negotiates formats, not a single fixed path).
  for mode in [0u8, 1u8, 2u8, 3u8] {
    let mut child = match spawn_ffmpeg_raw(&ffmpeg, device, spec, mode) {
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
) -> Result<u64, String> {
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
      scale_nv12_nearest(raw, cap_spec.w, cap_spec.h, out_spec.w, out_spec.h)
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
) -> Result<(CameraCapture, OutputSpec, Option<String>), String> {
  let mut attempts = vec![requested];
  for fb in [
    OutputSpec::resolve(Some(1920), Some(1080), Some(30)),
    OutputSpec::resolve(Some(1280), Some(720), Some(30)),
  ] {
    if !attempts
      .iter()
      .any(|s| s.w == fb.w && s.h == fb.h && s.fps == fb.fps)
    {
      attempts.push(fb);
    }
  }
  let mut last_err = String::new();
  for (i, try_spec) in attempts.iter().enumerate() {
    if i > 0 {
      thread::sleep(Duration::from_millis(350));
    } else {
      thread::sleep(Duration::from_millis(150));
    }
    write_res_file(try_spec.w, try_spec.h, try_spec.interval);
    match open_camera_capture(device, *try_spec) {
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
        return Ok((cam, *try_spec, warn));
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
  ready_tx: std::sync::mpsc::Sender<Result<OpenReady, String>>,
) -> thread::JoinHandle<()> {
  thread::spawn(move || {
    bump_thread_priority();

    let open = match open_camera_with_fallback(&device, requested) {
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

    let out_spec = force_out_spec.unwrap_or(cap_spec);
    write_res_file(out_spec.w, out_spec.h, out_spec.interval);
    wait_shm_free(500);

    let mut writer = match VideoQueueWriter::create(out_spec.w, out_spec.h, out_spec.interval) {
      Ok(w) => w,
      Err(e) => {
        let _ = ready_tx.send(Err(e));
        return;
      }
    };

    if force_out_spec.is_some() && (cap_spec.w != out_spec.w || cap_spec.h != out_spec.h) {
      let msg = format!(
        "直播伴侣仍占用虚拟摄像头，已按 {} 缩放输出到 {}。若要原生分辨率，请在伴侣中取消/重选 FLYBOX 后再切一次。",
        cap_spec.label(),
        out_spec.label()
      );
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
    let active_cap = cap_spec;

    while !stop.load(Ordering::SeqCst) {
      let cam = match next.take() {
        Some(c) => c,
        None => match open_camera_capture(&device, active_cap) {
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
      // MF reports real size; ffmpeg uses active_cap.
      let (cw, ch) = match cam.capture_size() {
        (0, 0) => (active_cap.w, active_cap.h),
        (w, h) => (w, h),
      };
      let this_cap = OutputSpec::resolve(Some(cw), Some(ch), Some(active_cap.fps));

      match pump_camera_to_shm(
        &stop,
        &frames,
        &preview_tx,
        &mut writer,
        cam,
        frame_i,
        out_spec,
        this_cap,
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
) -> Result<(), String> {
  start_output_ex(state, source, width, height, fps, None)
}

/// `force_out_spec`: L2 path — SHM geometry forced (scale capture into it).
fn start_output_ex(
  state: &VcamState,
  source: Option<String>,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
  force_out_spec: Option<OutputSpec>,
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

  let requested = OutputSpec::resolve(width, height, fps);
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
        g.warn = info.warn;
        g.capture_backend = Some(info.backend);
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
    wait_shm_free(500);
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
  g.frames = Arc::new(AtomicU64::new(0));
  if let Ok(mut p) = g.preview.lock() {
    *p = None;
  }
  g.preview = Arc::new(Mutex::new(None));
  Ok(())
}

/// Hot-switch resolution/fps. L1: recreate SHM. L2: keep old SHM size + scale if companion holds mapping.
fn reconfigure_output(
  state: &VcamState,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
) -> Result<(), String> {
  let (source, old_spec) = {
    let g = lock(state)?;
    if !g.running {
      return Err("请先开始输出，再切换分辨率".into());
    }
    (g.source.clone(), g.spec)
  };
  let new_spec = OutputSpec::resolve(width, height, fps);
  if new_spec.w == old_spec.w && new_spec.h == old_spec.h && new_spec.fps == old_spec.fps {
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

  // L1: wait longer for companion/filter to release the mapping.
  let free = wait_shm_free(3000);
  if free {
    match start_output_ex(
      state,
      source.clone(),
      Some(new_spec.w),
      Some(new_spec.h),
      Some(new_spec.fps),
      None,
    ) {
      Ok(()) => return Ok(()),
      Err(e) => {
        // Fall through to L2 / restore.
        eprintln!("[vcam] reconfigure L1 failed: {e}");
      }
    }
  }

  // L2: force SHM to old size, capture at new request, scale into SHM (stay live).
  match start_output_ex(
    state,
    source.clone(),
    Some(new_spec.w),
    Some(new_spec.h),
    Some(new_spec.fps),
    Some(old_spec),
  ) {
    Ok(()) => {
      let mut g = lock(state)?;
      let extra = "直播伴侣仍占用虚拟摄像头，已用缩放维持输出。若要原生分辨率，请在伴侣中重选/取消 FLYBOX 后再切一次。";
      g.warn = Some(match g.warn.take() {
        Some(w) if w.contains("缩放") => w,
        Some(w) => format!("{w} {extra}"),
        None => extra.into(),
      });
      Ok(())
    }
    Err(e2) => {
      // Last resort: restore old preset exactly.
      let _ = start_output_ex(
        state,
        source,
        Some(old_spec.w),
        Some(old_spec.h),
        Some(old_spec.fps),
        None,
      );
      Err(format!("切换分辨率失败：{e2}"))
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
#[tauri::command]
pub fn vcam_start(
  state: tauri::State<'_, VcamState>,
  source: Option<String>,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
) -> Result<(), String> {
  start_output(&state, source, width, height, fps)
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

/// Change output resolution/fps while already running (companion may need reselect).
#[tauri::command]
pub fn vcam_reconfigure(
  state: tauri::State<'_, VcamState>,
  width: Option<u32>,
  height: Option<u32>,
  fps: Option<u32>,
) -> Result<(), String> {
  reconfigure_output(&state, width, height, fps)
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
      let err = start_output(&state, None, None, None, None)
        .expect_err("start must fail when unregistered");
      assert!(err.contains("安装") || err.contains("注册"), "{err}");
      return;
    }
    if shm_is_open() {
      eprintln!("skip start_stop: SHM already held by another process");
      return;
    }

    start_output(&state, None, Some(1280), Some(720), Some(30))
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

  #[test]
  fn reconfigure_requires_running() {
    let state = VcamState::default();
    let err = reconfigure_output(&state, Some(1280), Some(720), Some(30))
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
    start_output(&state, None, Some(1280), Some(720), Some(30)).expect("start 720");
    thread::sleep(Duration::from_millis(150));
    reconfigure_output(&state, Some(1920), Some(1080), Some(30)).expect("to 1080");
    thread::sleep(Duration::from_millis(200));
    let s = collect_status(&state).expect("status");
    assert!(s.running);
    assert_eq!(s.width, 1920);
    assert_eq!(s.height, 1080);
    assert!(s.frames > 0 || s.pushing);
    stop_output(&state).expect("stop");
  }
}
