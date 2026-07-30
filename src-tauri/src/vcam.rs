//! FLYBOX virtual camera (OBS win-dshow based filter DLL + shared-memory frames).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
  stop: Option<Arc<AtomicBool>>,
  join: Option<thread::JoinHandle<()>>,
}

impl Default for VcamState {
  fn default() -> Self {
    Self {
      inner: Mutex::new(VcamInner {
        running: false,
        stop: None,
        join: None,
      }),
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamStatus {
  pub device_name: String,
  pub installed: bool,
  pub running: bool,
  pub message: String,
  pub source_note: String,
  pub dll_path: Option<String>,
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

      let header = view as *mut QueueHeader;
      std::ptr::write_bytes(header, 0, 1);
      (*header).state = SHARED_QUEUE_STATE_STARTING;
      (*header).cx = cx;
      (*header).cy = cy;
      (*header).interval = interval;
      (*header).offsets = offsets;

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
      let header = self.view as *mut QueueHeader;
      let inc = (*header).write_idx.wrapping_add(1);
      (*header).write_idx = inc;
      let idx = (inc as usize) % 3;
      let off = self.offsets[idx] as usize;
      let ts_ptr = self.view.add(off) as *mut u64;
      *ts_ptr = timestamp;
      let frame = self.view.add(off + FRAME_HEADER_SIZE as usize);
      let n = (self.frame_size as usize).min(yuv.len());
      std::ptr::copy_nonoverlapping(yuv.as_ptr(), frame, n);
      (*header).read_idx = inc;
      (*header).state = SHARED_QUEUE_STATE_READY;
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

fn spawn_push_thread(stop: Arc<AtomicBool>) -> Result<thread::JoinHandle<()>, String> {
  write_res_file(DEFAULT_W, DEFAULT_H, DEFAULT_INTERVAL);
  let mut writer = ShmWriter::create(DEFAULT_W, DEFAULT_H, DEFAULT_INTERVAL)?;
  let handle = thread::spawn(move || {
    let start = Instant::now();
    let mut tick = 0u64;
    while !stop.load(Ordering::SeqCst) {
      let ts = start.elapsed().as_nanos() as u64 / 100;
      let frame = make_nv12_test(DEFAULT_W, DEFAULT_H, tick);
      writer.write_nv12(&frame, ts);
      tick += 1;
      thread::sleep(Duration::from_millis(33));
    }
  });
  Ok(handle)
}

fn collect_status(state: &VcamState) -> Result<VcamStatus, String> {
  let g = lock(state)?;
  let dll = resolve_dll();
  let installed = is_filter_registered();
  let message = if g.running {
    "正在输出测试画面到 FLYBOX Camera。可在直播伴侣/系统相机中预览。".into()
  } else if installed {
    "设备已注册。点「开始输出」，再到直播伴侣选择 FLYBOX Camera。".into()
  } else if dll.is_some() {
    "已就绪：点「安装设备」（需管理员确认）即可注册系统摄像头。".into()
  } else {
    "未找到 flybox-virtualcam-module64.dll，请先编译 src-vcam。".into()
  };
  Ok(VcamStatus {
    device_name: DEVICE_NAME.into(),
    installed,
    running: g.running,
    message,
    source_note:
      "基于 OBS plugins/win-dshow 虚拟摄像头（GPL）。源码：src-vcam/；上架前公开本模块。"
        .into(),
    dll_path: dll.map(|p| p.display().to_string()),
  })
}

fn start_output(state: &VcamState) -> Result<(), String> {
  if !is_filter_registered() {
    return Err("请先安装/注册虚拟摄像头设备".into());
  }
  let mut g = lock(state)?;
  if g.running {
    return Ok(());
  }
  let stop = Arc::new(AtomicBool::new(false));
  let join = spawn_push_thread(stop.clone())?;
  g.stop = Some(stop);
  g.join = Some(join);
  g.running = true;
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
  Ok(())
}

#[cfg(test)]
fn shm_mapping_open() -> bool {
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

#[tauri::command]
pub fn vcam_status(state: tauri::State<'_, VcamState>) -> Result<VcamStatus, String> {
  collect_status(&state)
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

#[tauri::command]
pub fn vcam_start(state: tauri::State<'_, VcamState>) -> Result<(), String> {
  start_output(&state)
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
      let err = start_output(&state).expect_err("start must fail when unregistered");
      assert!(err.contains("安装") || err.contains("注册"), "{err}");
      return;
    }

    start_output(&state).expect("start_output");
    let mid = collect_status(&state).expect("status while running");
    assert!(mid.running, "running should be true after start");
    assert_eq!(mid.device_name, "FLYBOX Camera");
    // Give writer a moment to create SHM and first frames.
    thread::sleep(Duration::from_millis(120));
    assert!(
      shm_mapping_open(),
      "SHM {SHM_NAME} should exist while pushing"
    );

    stop_output(&state).expect("stop_output");
    let after = collect_status(&state).expect("status after stop");
    assert!(!after.running, "running should be false after stop");
    // Mapping should release shortly after stop (Drop closes handle).
    thread::sleep(Duration::from_millis(80));
    assert!(
      !shm_mapping_open(),
      "SHM should be gone after stop"
    );
  }
}
