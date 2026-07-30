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

const DEFAULT_W: u32 = 1280;
const DEFAULT_H: u32 = 720;
const DEFAULT_INTERVAL: u64 = 333333; // 30fps in 100ns units

pub struct VcamState {
  inner: Mutex<VcamInner>,
}

struct VcamInner {
  running: bool,
  /// Physical camera dshow name currently feeding SHM, or None = test pattern.
  source: Option<String>,
  /// Warning shown when we had to fall back (should stay empty if start fails hard).
  warn: Option<String>,
  stop: Option<Arc<AtomicBool>>,
  join: Option<thread::JoinHandle<()>>,
  /// Frames successfully written to SHM (companion needs this > 0).
  frames: Arc<AtomicU64>,
  /// Latest UI preview (RGBA, half-res).
  preview: Arc<Mutex<Option<PreviewRgba>>>,
  /// Frontend-fed NV12 frames (when source is a real camera).
  feed: Arc<Mutex<Option<Vec<u8>>>>,
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
        warn: None,
        stop: None,
        join: None,
        frames: Arc::new(AtomicU64::new(0)),
        preview: Arc::new(Mutex::new(None)),
        feed: Arc::new(Mutex::new(None)),
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
  /// Non-empty when output is test bars after a camera problem (or similar).
  pub warn: Option<String>,
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
      out.push(dir.join("flybox-virtualcam-module64.dll"));
      out.push(dir.join("vcam").join("flybox-virtualcam-module64.dll"));
    }
  }
  let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
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

fn write_res_file(w: u32, h: u32, interval: u64) {
  if let Ok(base) = std::env::var("APPDATA") {
    let path = PathBuf::from(base).join("flybox-virtualcam.txt");
    let body = format!("{w}x{h}x{interval}");
    let _ = fs::write(path, body);
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

/* ---- shared memory writer (layout matches OBS shared-memory-queue.c) ---- */

#[repr(C)]
struct QueueHeader {
  write_idx: u32,
  read_idx: u32,
  state: u32,
  offsets: [u32; 3],
  qtype: u32,
  cx: u32,
  cy: u32,
  interval: u64,
  reserved: [u32; 8],
}

const SHARED_QUEUE_STATE_STARTING: u32 = 1;
const SHARED_QUEUE_STATE_READY: u32 = 2;
const SHARED_QUEUE_STATE_STOPPING: u32 = 3;
const FRAME_HEADER_SIZE: u32 = 32;

struct ShmWriter {
  map: *mut std::ffi::c_void,
  view: *mut u8,
  frame_size: u32,
  offsets: [u32; 3],
}

unsafe impl Send for ShmWriter {}

#[link(name = "kernel32")]
extern "system" {
  fn CreateFileMappingW(
    h: *mut std::ffi::c_void,
    attr: *const std::ffi::c_void,
    protect: u32,
    max_high: u32,
    max_low: u32,
    name: *const u16,
  ) -> *mut std::ffi::c_void;
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

const INVALID_HANDLE_VALUE: *mut std::ffi::c_void = -1isize as *mut std::ffi::c_void;
const PAGE_READWRITE: u32 = 0x04;
const FILE_MAP_ALL_ACCESS: u32 = 0xF001F;

impl ShmWriter {
  fn create(cx: u32, cy: u32, interval: u64) -> Result<Self, String> {
    let frame_size = cx * cy * 3 / 2;
    let mut size = std::mem::size_of::<QueueHeader>() as u32;
    size = (size + 31) & !31;
    let mut offsets = [0u32; 3];
    for i in 0..3 {
      offsets[i] = size;
      size += frame_size + FRAME_HEADER_SIZE;
      size = (size + 31) & !31;
    }

    let wide: Vec<u16> = SHM_NAME.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
      let existing = OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, wide.as_ptr());
      if !existing.is_null() {
        CloseHandle(existing);
        return Err("虚拟摄像头共享内存已被占用，请先停止其他输出".into());
      }

      let map = CreateFileMappingW(
        INVALID_HANDLE_VALUE,
        std::ptr::null(),
        PAGE_READWRITE,
        0,
        size,
        wide.as_ptr(),
      );
      if map.is_null() {
        return Err("CreateFileMapping 失败".into());
      }
      let view = MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, 0) as *mut u8;
      if view.is_null() {
        CloseHandle(map);
        return Err("MapViewOfFile 失败".into());
      }

      // Zero entire mapping then fill header with volatile stores.
      std::ptr::write_bytes(view, 0, size as usize);
      // layout: write/read/state @0/4/8, offsets@12, type@24, cx@28, cy@32, interval@40
      std::ptr::write_volatile(view.add(8) as *mut u32, SHARED_QUEUE_STATE_STARTING);
      for (i, off) in offsets.iter().enumerate() {
        std::ptr::write_volatile(view.add(12 + i * 4) as *mut u32, *off);
      }
      std::ptr::write_volatile(view.add(28) as *mut u32, cx);
      std::ptr::write_volatile(view.add(32) as *mut u32, cy);
      std::ptr::write_volatile(view.add(40) as *mut u64, interval);

      Ok(Self {
        map,
        view,
        frame_size,
        offsets,
      })
    }
  }

  fn write_nv12(&mut self, yuv: &[u8], timestamp: u64) {
    unsafe {
      // Use raw byte offsets + write_volatile so the companion process
      // (another address space) reliably observes READY + frame data.
      let base = self.view;
      let write_idx = std::ptr::read_volatile(base as *const u32).wrapping_add(1);
      let idx = (write_idx as usize) % 3;
      let off = self.offsets[idx] as usize;
      let ts_ptr = base.add(off) as *mut u64;
      std::ptr::write_volatile(ts_ptr, timestamp);
      let frame = base.add(off + FRAME_HEADER_SIZE as usize);
      let n = (self.frame_size as usize).min(yuv.len());
      std::ptr::copy_nonoverlapping(yuv.as_ptr(), frame, n);
      // Publish indices then READY last (release-like order).
      std::ptr::write_volatile(base as *mut u32, write_idx); // write_idx
      std::ptr::write_volatile(base.add(4) as *mut u32, write_idx); // read_idx
      std::sync::atomic::fence(std::sync::atomic::Ordering::Release);
      std::ptr::write_volatile(base.add(8) as *mut u32, SHARED_QUEUE_STATE_READY);
    }
  }
}

impl Drop for ShmWriter {
  fn drop(&mut self) {
    unsafe {
      if !self.view.is_null() {
        let header = self.view as *mut QueueHeader;
        (*header).state = SHARED_QUEUE_STATE_STOPPING;
        UnmapViewOfFile(self.view as *const _);
      }
      if !self.map.is_null() {
        CloseHandle(self.map);
      }
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

/// List DirectShow video capture devices (excludes FLYBOX virtual cam itself).
pub fn list_video_sources() -> Result<Vec<VcamSource>, String> {
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

fn publish_preview(preview: &Mutex<Option<PreviewRgba>>, nv12: &[u8], frame_n: u64) {
  // ~10fps UI preview is enough; skip most frames for CPU.
  if frame_n % 3 != 0 {
    return;
  }
  let p = nv12_to_rgba_half(nv12, DEFAULT_W, DEFAULT_H);
  if let Ok(mut g) = preview.lock() {
    *g = Some(p);
  }
}

fn preview_to_data_url(p: &PreviewRgba) -> Option<String> {
  use base64::{engine::general_purpose::STANDARD as B64, Engine};
  use image::{ImageBuffer, ImageFormat, Rgba};
  let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
    ImageBuffer::from_raw(p.width, p.height, p.rgba.clone())?;
  let mut jpeg = Vec::new();
  {
    let mut cursor = std::io::Cursor::new(&mut jpeg);
    img
      .write_to(&mut cursor, ImageFormat::Jpeg)
      .ok()?;
  }
  Some(format!("data:image/jpeg;base64,{}", B64.encode(&jpeg)))
}

fn push_test_loop(
  writer: &mut ShmWriter,
  stop: &AtomicBool,
  frames: &AtomicU64,
  preview: &Mutex<Option<PreviewRgba>>,
  start: Instant,
  mut tick: u64,
) {
  while !stop.load(Ordering::SeqCst) {
    let ts = start.elapsed().as_nanos() as u64 / 100;
    let frame = make_nv12_test(DEFAULT_W, DEFAULT_H, tick);
    writer.write_nv12(&frame, ts);
    let n = frames.fetch_add(1, Ordering::Relaxed) + 1;
    publish_preview(preview, &frame, n);
    tick += 1;
    thread::sleep(Duration::from_millis(33));
  }
}

/// Test-pattern only push (no physical camera / no ffmpeg).
fn spawn_push_thread(
  stop: Arc<AtomicBool>,
  frames: Arc<AtomicU64>,
  preview: Arc<Mutex<Option<PreviewRgba>>>,
) -> Result<thread::JoinHandle<()>, String> {
  write_res_file(DEFAULT_W, DEFAULT_H, DEFAULT_INTERVAL);
  for _ in 0..10 {
    if !shm_is_open() {
      break;
    }
    thread::sleep(Duration::from_millis(50));
  }
  let mut writer = ShmWriter::create(DEFAULT_W, DEFAULT_H, DEFAULT_INTERVAL)?;
  {
    let frame = make_nv12_test(DEFAULT_W, DEFAULT_H, 0);
    writer.write_nv12(&frame, 0);
    frames.store(1, Ordering::Relaxed);
    publish_preview(&preview, &frame, 1);
  }
  let handle = thread::spawn(move || {
    let start = Instant::now();
    push_test_loop(
      &mut writer,
      &stop,
      &frames,
      &preview,
      start,
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
    if let Some(ref src) = g.source {
      format!(
        "正在输出「{src}」→ FLYBOX Camera（已送 {frame_n} 帧）。直播伴侣选 FLYBOX Camera。"
      )
    } else {
      format!(
        "正在输出测试彩条 → FLYBOX Camera（已送 {frame_n} 帧）。要真人画面请选摄像头后点「开始输出」。"
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
    warn: g.warn.clone(),
    message,
    source_note:
      "基于 OBS plugins/win-dshow 虚拟摄像头（GPL）。源码：src-vcam/；上架前公开本模块。"
        .into(),
    dll_path: dll.map(|p| p.display().to_string()),
  })
}

fn rgb_to_nv12(rgb: &[u8], w: u32, h: u32) -> Vec<u8> {
  let y_size = (w * h) as usize;
  let mut out = vec![0u8; y_size + y_size / 2];
  // Y plane
  for y in 0..h {
    for x in 0..w {
      let i = ((y * w + x) * 3) as usize;
      let r = rgb[i] as i32;
      let g = rgb[i + 1] as i32;
      let b = rgb[i + 2] as i32;
      let yy = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
      out[(y * w + x) as usize] = yy.clamp(0, 255) as u8;
    }
  }
  // UV plane (NV12 interleaved), 2x2 subsample
  let uv = &mut out[y_size..];
  for y in (0..h).step_by(2) {
    for x in (0..w).step_by(2) {
      let mut rs = 0i32;
      let mut gs = 0i32;
      let mut bs = 0i32;
      let mut n = 0i32;
      for dy in 0..2 {
        for dx in 0..2 {
          let xx = (x + dx).min(w - 1);
          let yy = (y + dy).min(h - 1);
          let i = ((yy * w + xx) * 3) as usize;
          rs += rgb[i] as i32;
          gs += rgb[i + 1] as i32;
          bs += rgb[i + 2] as i32;
          n += 1;
        }
      }
      let r = rs / n;
      let g = gs / n;
      let b = bs / n;
      let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
      let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
      let ui = ((y / 2) * w + x) as usize;
      if ui + 1 < uv.len() {
        uv[ui] = u.clamp(0, 255) as u8;
        uv[ui + 1] = v.clamp(0, 255) as u8;
      }
    }
  }
  out
}

fn start_output(state: &VcamState, source: Option<String>) -> Result<(), String> {
  if !is_filter_registered() {
    return Err("请先安装/注册虚拟摄像头设备".into());
  }
  let source = source
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty() && s != "__test__");

  if let Some(ref name) = source {
    if name.eq_ignore_ascii_case(DEVICE_NAME) {
      return Err("不能把 FLYBOX Camera 自己当作输入源".into());
    }
  }

  let mut g = lock(state)?;
  if g.running {
    return Ok(());
  }
  let stop = Arc::new(AtomicBool::new(false));
  let frames = Arc::new(AtomicU64::new(0));
  let preview = Arc::new(Mutex::new(None));
  let feed = Arc::new(Mutex::new(None));

  // Real camera: UI holds getUserMedia and pushes JPEG frames (no ffmpeg exclusive grab).
  // Test pattern: backend generates bars.
  let join = if source.is_some() {
    spawn_feed_thread(stop.clone(), frames.clone(), preview.clone(), feed.clone())?
  } else {
    spawn_push_thread(stop.clone(), frames.clone(), preview.clone())?
  };

  g.stop = Some(stop);
  g.join = Some(join);
  g.frames = frames;
  g.preview = preview;
  g.feed = feed;
  g.source = source;
  g.warn = None;
  g.running = true;
  Ok(())
}

fn spawn_feed_thread(
  stop: Arc<AtomicBool>,
  frames: Arc<AtomicU64>,
  preview: Arc<Mutex<Option<PreviewRgba>>>,
  feed: Arc<Mutex<Option<Vec<u8>>>>,
) -> Result<thread::JoinHandle<()>, String> {
  write_res_file(DEFAULT_W, DEFAULT_H, DEFAULT_INTERVAL);
  for _ in 0..10 {
    if !shm_is_open() {
      break;
    }
    thread::sleep(Duration::from_millis(50));
  }
  let mut writer = ShmWriter::create(DEFAULT_W, DEFAULT_H, DEFAULT_INTERVAL)?;
  // Placeholder until first frontend frame arrives (avoids companion gray).
  {
    let frame = make_nv12_test(DEFAULT_W, DEFAULT_H, 0);
    writer.write_nv12(&frame, 0);
    frames.store(1, Ordering::Relaxed);
    publish_preview(&preview, &frame, 1);
  }

  let handle = thread::spawn(move || {
    let start = Instant::now();
    let mut last = make_nv12_test(DEFAULT_W, DEFAULT_H, 0);
    let mut got_real = false;
    while !stop.load(Ordering::SeqCst) {
      if let Ok(guard) = feed.lock() {
        if let Some(ref f) = *guard {
          if f.len() == last.len() {
            last.copy_from_slice(f);
            got_real = true;
          }
        }
      }
      let ts = start.elapsed().as_nanos() as u64 / 100;
      writer.write_nv12(&last, ts);
      let n = frames.fetch_add(1, Ordering::Relaxed) + 1;
      if got_real {
        publish_preview(&preview, &last, n);
      }
      thread::sleep(Duration::from_millis(33));
    }
  });
  Ok(handle)
}

/// Frontend pushes a JPEG snapshot of the live camera preview (~15fps).
pub fn push_jpeg_frame(state: &VcamState, jpeg: Vec<u8>) -> Result<(), String> {
  let g = lock(state)?;
  if !g.running {
    return Err("请先开始输出".into());
  }
  if g.source.is_none() {
    return Ok(()); // test pattern mode ignores pushes
  }
  let img = image::load_from_memory(&jpeg).map_err(|e| format!("预览帧解码失败: {e}"))?;
  let rgb = img
    .resize_exact(
      DEFAULT_W,
      DEFAULT_H,
      image::imageops::FilterType::Triangle,
    )
    .to_rgb8();
  let nv12 = rgb_to_nv12(rgb.as_raw(), DEFAULT_W, DEFAULT_H);
  if let Ok(mut feed) = g.feed.lock() {
    *feed = Some(nv12);
  }
  Ok(())
}

fn stop_output(state: &VcamState) -> Result<(), String> {
  let mut g = lock(state)?;
  if let Some(s) = g.stop.take() {
    s.store(true, Ordering::SeqCst);
  }
  if let Some(j) = g.join.take() {
    let _ = j.join();
  }
  g.running = false;
  g.source = None;
  g.warn = None;
  g.frames = Arc::new(AtomicU64::new(0));
  if let Ok(mut p) = g.preview.lock() {
    *p = None;
  }
  g.preview = Arc::new(Mutex::new(None));
  if let Ok(mut f) = g.feed.lock() {
    *f = None;
  }
  g.feed = Arc::new(Mutex::new(None));
  Ok(())
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
  let g = lock(&state)?;
  let guard = g
    .preview
    .lock()
    .map_err(|_| "preview lock poisoned".to_string())?;
  Ok(guard.as_ref().and_then(|p| {
    let data_url = preview_to_data_url(p)?;
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
#[tauri::command]
pub fn vcam_start(
  state: tauri::State<'_, VcamState>,
  source: Option<String>,
) -> Result<(), String> {
  start_output(&state, source)
}

#[tauri::command]
pub fn vcam_push_jpeg(
  state: tauri::State<'_, VcamState>,
  jpeg: Vec<u8>,
) -> Result<(), String> {
  push_jpeg_frame(&state, jpeg)
}

#[tauri::command]
pub fn vcam_stop(state: tauri::State<'_, VcamState>) -> Result<(), String> {
  stop_output(&state)
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
      let err = start_output(&state, None).expect_err("start must fail when unregistered");
      assert!(err.contains("安装") || err.contains("注册"), "{err}");
      return;
    }

    start_output(&state, None).expect("start_output test pattern");
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
}
