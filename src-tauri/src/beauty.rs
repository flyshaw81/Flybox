//! Face / skin beauty for virtual camera (NOT full-frame color filters).
//!
//! Product definition:
//! - 美颜 = face + skin (detect face, only beautify that region)
//! - 滤镜 = full-frame grade (we do NOT implement that here)
//!
//! Virtual cam: prefer Python face worker (MediaPipe mask + GPUPixel on face only).
//! Preview: frontend MediaPipe face mask + beauty composite (see beautyCanvas.ts).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const MAGIC: &[u8; 4] = b"FB01";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeautyParams {
  pub enabled: bool,
  pub smooth: f32,
  pub whiten: f32,
  pub slim: f32,
}

impl Default for BeautyParams {
  fn default() -> Self {
    Self {
      enabled: false,
      smooth: 0.35,
      whiten: 0.35,
      slim: 0.0,
    }
  }
}

impl BeautyParams {
  pub fn clamp(mut self) -> Self {
    self.smooth = self.smooth.clamp(0.0, 1.0);
    self.whiten = self.whiten.clamp(0.0, 1.0);
    self.slim = self.slim.clamp(0.0, 1.0);
    self
  }

  pub fn active(&self) -> bool {
    self.enabled && (self.smooth > 0.015 || self.whiten > 0.015)
  }
}

pub struct BeautyState {
  params: Mutex<BeautyParams>,
  worker: Mutex<Option<BeautyWorker>>,
}

impl Default for BeautyState {
  fn default() -> Self {
    Self {
      params: Mutex::new(BeautyParams::default()),
      worker: Mutex::new(None),
    }
  }
}

pub fn global() -> &'static BeautyState {
  use std::sync::OnceLock;
  static G: OnceLock<BeautyState> = OnceLock::new();
  G.get_or_init(BeautyState::default)
}

impl BeautyState {
  pub fn get(&self) -> BeautyParams {
    *self.params.lock().unwrap_or_else(|e| e.into_inner())
  }

  pub fn set(&self, p: BeautyParams) {
    let p = p.clamp();
    *self.params.lock().unwrap_or_else(|e| e.into_inner()) = p;
    if !p.active() {
      if let Ok(mut w) = self.worker.lock() {
        if let Some(worker) = w.take() {
          worker.shutdown();
        }
      }
    } else {
      // Warm GPUPixel in background (no UI freeze)
      std::thread::spawn(|| {
        let g = global();
        let p = g.get();
        if !p.active() {
          return;
        }
        let dummy = vec![128u8; 64 * 64 * 4];
        let _ = g.process_rgba(&dummy, 64, 64, p);
      });
    }
  }

  pub fn process_nv12(&self, nv12: &[u8], w: u32, h: u32) -> Vec<u8> {
    let p = self.get();
    if !p.active() || w < 16 || h < 16 {
      return nv12.to_vec();
    }
    // Prefer native resolution — old 640→upscale made beauty look soft even at 磨皮=0.
    // Only shrink when very large (keeps face worker realtime on 1080p/4K).
    let max_w = 1280u32;
    let (pw, ph) = if w > max_w {
      let ph = ((h as u64 * max_w as u64) / w as u64).max(2) as u32 & !1;
      (max_w & !1, ph)
    } else {
      (w & !1, h & !1)
    };

    let rgba_full = nv12_to_rgba(nv12, w, h);
    let Some(full_img) = image::RgbaImage::from_raw(w, h, rgba_full) else {
      return nv12.to_vec();
    };
    let (work, work_w, work_h) = if pw != w || ph != h {
      let small =
        image::imageops::resize(&full_img, pw, ph, image::imageops::FilterType::CatmullRom);
      let sw = small.width();
      let sh = small.height();
      (small.into_raw(), sw, sh)
    } else {
      (full_img.into_raw(), w, h)
    };

    let out_rgba = self.process_rgba(&work, work_w, work_h, p);

    let final_rgba = if work_w != w || work_h != h {
      match image::RgbaImage::from_raw(work_w, work_h, out_rgba) {
        Some(img) => {
          image::imageops::resize(&img, w, h, image::imageops::FilterType::CatmullRom)
            .into_raw()
        }
        None => return nv12.to_vec(),
      }
    } else {
      out_rgba
    };
    rgba_to_nv12(&final_rgba, w, h)
  }

  /// Prefer GPUPixel worker; fall back to light CPU.
  pub fn process_rgba(&self, rgba: &[u8], w: u32, h: u32, p: BeautyParams) -> Vec<u8> {
    if !p.active() {
      return rgba.to_vec();
    }
    // Map UI → GPUPixel ranges (moderate, not full-frame bleach)
    // smooth 0..1 → blur alpha 0..1; whiten 0..1 → white 0..0.35
    match self.with_worker(rgba, w, h, p) {
      Ok(v) => v,
      Err(e) => {
        eprintln!("[beauty] gpupixel: {e}; cpu fallback");
        beauty_cpu_light(rgba, w, h, p.smooth, p.whiten)
      }
    }
  }

  fn with_worker(
    &self,
    rgba: &[u8],
    w: u32,
    h: u32,
    p: BeautyParams,
  ) -> Result<Vec<u8>, String> {
    let mut guard = self.worker.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
      *guard = Some(BeautyWorker::spawn()?);
    }
    let worker = guard.as_mut().ok_or_else(|| "no worker".to_string())?;
    // GPUPixel SetWhite: pass whiten*0.35 via protocol (worker multiplies by 0.45 already)
    // Our worker uses: SetBlurAlpha(s), SetWhite(wh*0.45) — send UI values as-is
    match worker.process(rgba, w, h, p) {
      Ok(v) => Ok(v),
      Err(e) => {
        let _ = guard.take().map(|w| w.shutdown());
        *guard = Some(BeautyWorker::spawn()?);
        guard
          .as_mut()
          .ok_or_else(|| "no worker".to_string())?
          .process(rgba, w, h, p)
          .map_err(|e2| format!("{e}; retry: {e2}"))
      }
    }
  }
}

struct BeautyWorker {
  child: Child,
  stdin: ChildStdin,
  stdout: ChildStdout,
}

impl BeautyWorker {
  fn spawn_process(mut cmd: Command, label: &str) -> Result<Self, String> {
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      const CREATE_NO_WINDOW: u32 = 0x0800_0000;
      cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|e| format!("spawn {label}: {e}"))?;
    let stdin = child.stdin.take().ok_or("stdin")?;
    let stdout = child.stdout.take().ok_or("stdout")?;
    let tag = label.to_string();
    if let Some(mut err) = child.stderr.take() {
      std::thread::spawn(move || {
        let mut buf = [0u8; 512];
        loop {
          match err.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => eprint!("[{tag}] {}", String::from_utf8_lossy(&buf[..n])),
          }
        }
      });
    }
    eprintln!("[beauty] engine={label}");
    Ok(Self {
      child,
      stdin,
      stdout,
    })
  }

  fn spawn() -> Result<Self, String> {
    // 1) Face beauty: MediaPipe face mask + GPUPixel only on face (correct product)
    if let (Some(script), Some((py, extra))) = (face_worker_script_path(), find_python()) {
      if gpupixel_worker_path().is_some() {
        let mut cmd = Command::new(&py);
        for a in &extra {
          cmd.arg(a);
        }
        cmd.arg("-u").arg(&script);
        cmd.env("PYTHONUNBUFFERED", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        if let Some(dir) = script.parent() {
          cmd.current_dir(dir);
        }
        match Self::spawn_process(cmd, "face+gpupixel") {
          Ok(w) => return Ok(w),
          Err(e) => eprintln!("[beauty] face worker spawn failed: {e}"),
        }
      }
    }

    // 2) Last resort: GPUPixel full-frame (NOT ideal — logs warning)
    let exe = gpupixel_worker_path().ok_or_else(|| {
      "无美颜引擎：需要 beauty_face_worker.py + mediapipe + gpupixel_worker.exe".to_string()
    })?;
    eprintln!(
      "[beauty] WARN: face worker unavailable — full-frame GPUPixel (not face-only)"
    );
    let mut cmd = Command::new(&exe);
    if let Some(dir) = exe.parent() {
      cmd.current_dir(dir);
    }
    Self::spawn_process(cmd, &format!("gpupixel-fullframe ({})", exe.display()))
  }

  fn process(
    &mut self,
    rgba: &[u8],
    w: u32,
    h: u32,
    p: BeautyParams,
  ) -> Result<Vec<u8>, String> {
    let expect = (w as usize) * (h as usize) * 4;
    if rgba.len() != expect {
      return Err(format!("rgba size {} != {expect}", rgba.len()));
    }
    // Cap GPUPixel white strength in the wire values
    let smooth = p.smooth.clamp(0.0, 1.0);
    let whiten = (p.whiten * 0.55).clamp(0.0, 0.55); // worker does *0.45 → max ~0.25
    let slim = 0.0f32;
    self.stdin.write_all(MAGIC).map_err(|e| e.to_string())?;
    self.stdin.write_all(&w.to_le_bytes()).map_err(|e| e.to_string())?;
    self.stdin.write_all(&h.to_le_bytes()).map_err(|e| e.to_string())?;
    self
      .stdin
      .write_all(&smooth.to_le_bytes())
      .map_err(|e| e.to_string())?;
    self
      .stdin
      .write_all(&whiten.to_le_bytes())
      .map_err(|e| e.to_string())?;
    self
      .stdin
      .write_all(&slim.to_le_bytes())
      .map_err(|e| e.to_string())?;
    self.stdin.write_all(rgba).map_err(|e| e.to_string())?;
    self.stdin.flush().map_err(|e| e.to_string())?;

    let mut magic = [0u8; 4];
    self.stdout.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != MAGIC {
      return Err(format!("bad magic {magic:?}"));
    }
    let mut wh = [0u8; 8];
    self.stdout.read_exact(&mut wh).map_err(|e| e.to_string())?;
    let rw = u32::from_le_bytes(wh[0..4].try_into().unwrap());
    let rh = u32::from_le_bytes(wh[4..8].try_into().unwrap());
    if rw != w || rh != h {
      return Err(format!("size {rw}x{rh}"));
    }
    let mut out = vec![0u8; expect];
    self.stdout.read_exact(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
  }

  fn shutdown(mut self) {
    let _ = self.stdin.write_all(b"QUIT");
    let _ = self.stdin.flush();
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

fn resolve_resource(rel: &[&str]) -> Option<PathBuf> {
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      let mut p = dir.join("resources");
      for s in rel {
        p = p.join(s);
      }
      if p.is_file() {
        return Some(p);
      }
      let mut p2 = dir.join("..").join("..").join("resources");
      for s in rel {
        p2 = p2.join(s);
      }
      if p2.is_file() {
        return Some(p2.canonicalize().unwrap_or(p2));
      }
    }
  }
  let mut dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
  for s in rel {
    dev = dev.join(s);
  }
  if dev.is_file() {
    Some(dev)
  } else {
    None
  }
}

fn gpupixel_worker_path() -> Option<PathBuf> {
  resolve_resource(&["beauty", "gpupixel", "gpupixel_worker.exe"])
}

fn face_worker_script_path() -> Option<PathBuf> {
  resolve_resource(&["beauty", "beauty_face_worker.py"])
}

/// Python with mediapipe (for face-only beauty worker).
fn find_python() -> Option<(PathBuf, Vec<String>)> {
  let candidates: Vec<(PathBuf, Vec<String>)> = vec![
    (PathBuf::from("py"), vec!["-3.12".into()]),
    (PathBuf::from("py"), vec!["-3".into()]),
    (PathBuf::from("python"), vec![]),
    (PathBuf::from("python3"), vec![]),
  ];
  for (exe, args) in candidates {
    let mut cmd = Command::new(&exe);
    for a in &args {
      cmd.arg(a);
    }
    let ok = cmd
      .args(["-c", "import mediapipe, cv2, numpy; print('ok')"])
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .output()
      .map(|o| o.status.success())
      .unwrap_or(false);
    if ok {
      return Some((exe, args));
    }
  }
  None
}

// ——— CPU fallback (light, not used when GPUPixel works) ———

fn beauty_cpu_light(rgba: &[u8], w: u32, h: u32, smooth: f32, whiten: f32) -> Vec<u8> {
  let w = w as usize;
  let h = h as usize;
  let n = w * h * 4;
  if rgba.len() < n {
    return rgba.to_vec();
  }
  let s = smooth.clamp(0.0, 1.0);
  let wh = whiten.clamp(0.0, 1.0) * 0.4;
  if s < 0.01 && wh < 0.01 {
    return rgba.to_vec();
  }
  let mut out = rgba.to_vec();
  let rad = if s > 0.5 { 2 } else { 1 };
  let src = rgba;
  for j in rad..(h.saturating_sub(rad)) {
    for i in rad..(w.saturating_sub(rad)) {
      let o = (j * w + i) * 4;
      let r0 = src[o] as f32;
      let g0 = src[o + 1] as f32;
      let b0 = src[o + 2] as f32;
      // simple 3x3/5x5 mean for smooth
      if s > 0.01 {
        let mut sr = 0u32;
        let mut sg = 0u32;
        let mut sb = 0u32;
        let mut c = 0u32;
        for dj in -(rad as i32)..=(rad as i32) {
          for di in -(rad as i32)..=(rad as i32) {
            let t = ((j as i32 + dj) as usize * w + (i as i32 + di) as usize) * 4;
            sr += src[t] as u32;
            sg += src[t + 1] as u32;
            sb += src[t + 2] as u32;
            c += 1;
          }
        }
        let k = s * 0.55;
        out[o] = (r0 * (1.0 - k) + (sr as f32 / c as f32) * k) as u8;
        out[o + 1] = (g0 * (1.0 - k) + (sg as f32 / c as f32) * k) as u8;
        out[o + 2] = (b0 * (1.0 - k) + (sb as f32 / c as f32) * k) as u8;
      }
      if wh > 0.01 {
        // only mild mid lift — chroma check
        let y = 0.299 * out[o] as f32 + 0.587 * out[o + 1] as f32 + 0.114 * out[o + 2] as f32;
        let cr = out[o] as f32 - y;
        if cr > 8.0 {
          let lift = (wh * 22.0) as u8;
          out[o] = out[o].saturating_add(lift);
          out[o + 1] = out[o + 1].saturating_add(lift.saturating_mul(95) / 100);
          out[o + 2] = out[o + 2].saturating_add(lift.saturating_mul(80) / 100);
        }
      }
    }
  }
  out
}

fn nv12_to_rgba(nv12: &[u8], w: u32, h: u32) -> Vec<u8> {
  let w = w as usize;
  let h = h as usize;
  let y_size = w * h;
  let mut rgba = vec![0u8; w * h * 4];
  if nv12.len() < y_size + y_size / 2 {
    return rgba;
  }
  let y_plane = &nv12[..y_size];
  let uv_plane = &nv12[y_size..];
  for j in 0..h {
    for i in 0..w {
      let y = y_plane[j * w + i] as i32;
      let uv_i = (j / 2) * w + (i & !1);
      let u = uv_plane[uv_i] as i32;
      let v = uv_plane[uv_i + 1] as i32;
      let c = y - 16;
      let d = u - 128;
      let e = v - 128;
      let r = (298 * c + 409 * e + 128) >> 8;
      let g = (298 * c - 100 * d - 208 * e + 128) >> 8;
      let b = (298 * c + 516 * d + 128) >> 8;
      let o = (j * w + i) * 4;
      rgba[o] = r.clamp(0, 255) as u8;
      rgba[o + 1] = g.clamp(0, 255) as u8;
      rgba[o + 2] = b.clamp(0, 255) as u8;
      rgba[o + 3] = 255;
    }
  }
  rgba
}

fn rgba_to_nv12(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
  let w = w as usize;
  let h = h as usize;
  let mut nv12 = vec![0u8; w * h * 3 / 2];
  let y_size = w * h;
  for j in 0..h {
    for i in 0..w {
      let o = (j * w + i) * 4;
      let r = rgba[o] as i32;
      let g = rgba[o + 1] as i32;
      let b = rgba[o + 2] as i32;
      let y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
      nv12[j * w + i] = y.clamp(16, 235) as u8;
      if j % 2 == 0 && i % 2 == 0 {
        let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
        let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
        let uv = y_size + (j / 2) * w + i;
        if uv + 1 < nv12.len() {
          nv12[uv] = u.clamp(0, 255) as u8;
          nv12[uv + 1] = v.clamp(0, 255) as u8;
        }
      }
    }
  }
  nv12
}

// ——— Tauri ———

#[tauri::command]
pub fn beauty_get() -> BeautyParams {
  global().get()
}

#[tauri::command]
pub fn beauty_set(params: BeautyParams) -> BeautyParams {
  let p = params.clamp();
  global().set(p);
  p
}

#[tauri::command]
pub fn beauty_status() -> serde_json::Value {
  let face = face_worker_script_path().is_some() && find_python().is_some();
  let gpu = gpupixel_worker_path().is_some();
  serde_json::json!({
    "product": "face_skin_beauty", // not full-frame filter
    "engine": if face && gpu {
      "face_mask+gpupixel"
    } else if gpu {
      "gpupixel_fullframe_fallback"
    } else {
      "cpu_fallback"
    },
    "faceWorkerReady": face,
    "gpupixelReady": gpu,
  })
}

#[tauri::command]
pub fn beauty_warmup() -> Result<String, String> {
  let g = global();
  let p = g.get();
  if !p.enabled {
    return Ok("idle".into());
  }
  let dummy = vec![128u8; 64 * 64 * 4];
  let _ = g.process_rgba(&dummy, 64, 64, p);
  Ok("ready".into())
}

#[tauri::command]
pub fn beauty_process_rgba(
  width: u32,
  height: u32,
  rgba_base64: String,
) -> Result<String, String> {
  use base64::{engine::general_purpose::STANDARD as B64, Engine};
  let p = global().get();
  let rgba = B64
    .decode(rgba_base64.trim())
    .map_err(|e| format!("base64: {e}"))?;
  let expect = (width as usize)
    .checked_mul(height as usize)
    .and_then(|n| n.checked_mul(4))
    .ok_or_else(|| "overflow".to_string())?;
  if rgba.len() != expect {
    return Err(format!("len {}", rgba.len()));
  }
  Ok(B64.encode(global().process_rgba(&rgba, width, height, p)))
}

#[tauri::command]
pub fn beauty_process_jpeg(jpeg_base64: String) -> Result<String, String> {
  use base64::{engine::general_purpose::STANDARD as B64, Engine};
  use image::ImageEncoder;
  let p = global().get();
  let bytes = B64
    .decode(jpeg_base64.trim())
    .map_err(|e| format!("base64: {e}"))?;
  let img = image::load_from_memory(&bytes).map_err(|e| format!("jpeg: {e}"))?;
  let rgba_img = img.to_rgba8();
  let w = rgba_img.width();
  let h = rgba_img.height();
  let out = global().process_rgba(&rgba_img.into_raw(), w, h, p);
  let out_img =
    image::RgbaImage::from_raw(w, h, out).ok_or_else(|| "rgba".to_string())?;
  let rgb = image::DynamicImage::ImageRgba8(out_img).to_rgb8();
  let mut jpeg_out = Vec::new();
  let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_out, 90);
  enc
    .write_image(
      rgb.as_raw(),
      rgb.width(),
      rgb.height(),
      image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| e.to_string())?;
  Ok(format!("data:image/jpeg;base64,{}", B64.encode(jpeg_out)))
}
