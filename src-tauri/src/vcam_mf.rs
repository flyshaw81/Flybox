//! In-process webcam capture via Windows Media Foundation → packed NV12.
//! COM / MFStartup / ReadSample / Drop must stay on the **same thread** (the capture worker).

use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::{
  IMF2DBuffer, IMFActivate, IMFAttributes, IMFMediaBuffer, IMFSample,
  IMFSourceReader, MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromMediaSource,
  MFEnumDeviceSources, MFMediaType_Video, MFShutdown, MFStartup, MFVideoFormat_NV12,
  MFSTARTUP_LITE, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
  MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE,
  MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_READWRITE_DISABLE_CONVERTERS,
  MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::System::Com::{
  CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED,
};

struct MfGuard;

impl Drop for MfGuard {
  fn drop(&mut self) {
    unsafe {
      let _ = MFShutdown();
      CoUninitialize();
    }
  }
}

fn start_mf() -> Result<MfGuard, String> {
  unsafe {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION, MFSTARTUP_LITE).map_err(|e| format!("MFStartup 失败: {e}"))?;
  }
  Ok(MfGuard)
}

unsafe fn vidcap_attrs() -> Result<IMFAttributes, String> {
  let mut attrs: Option<IMFAttributes> = None;
  MFCreateAttributes(&mut attrs, 2).map_err(|e| format!("MFCreateAttributes: {e}"))?;
  let attrs = attrs.ok_or_else(|| "MFCreateAttributes null".to_string())?;
  attrs
    .SetGUID(
      &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
      &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
    )
    .map_err(|e| format!("SetGUID: {e}"))?;
  Ok(attrs)
}

unsafe fn activate_name(act: &IMFActivate) -> Result<String, String> {
  let mut raw = windows::core::PWSTR::null();
  let mut len = 0u32;
  act
    .GetAllocatedString(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &mut raw, &mut len)
    .map_err(|e| format!("friendly name: {e}"))?;
  if raw.is_null() {
    return Err("empty name".into());
  }
  let s = raw.to_string().unwrap_or_default();
  CoTaskMemFree(Some(raw.0 as *const _));
  Ok(s)
}

/// Prefer exact name, then case-insensitive, then longest contains match.
pub fn match_device_name<'a>(wanted: &str, candidates: &'a [String]) -> Option<&'a str> {
  if let Some(c) = candidates.iter().find(|c| c.as_str() == wanted) {
    return Some(c.as_str());
  }
  if let Some(c) = candidates
    .iter()
    .find(|c| c.eq_ignore_ascii_case(wanted))
  {
    return Some(c.as_str());
  }
  let mut best: Option<&str> = None;
  let mut best_len = 0usize;
  for c in candidates {
    if c.contains(wanted) || wanted.contains(c.as_str()) {
      if c.len() > best_len {
        best = Some(c.as_str());
        best_len = c.len();
      }
    }
  }
  best
}

/// Friendly names of video devices (excludes FLYBOX virtual camera).
pub fn list_video_device_names() -> Result<Vec<String>, String> {
  let _guard = start_mf()?;
  unsafe {
    let attrs = vidcap_attrs()?;
    let mut devices: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    MFEnumDeviceSources(&attrs, &mut devices, &mut count)
      .map_err(|e| format!("枚举摄像头失败: {e}"))?;
    if devices.is_null() || count == 0 {
      return Ok(Vec::new());
    }
    let mut names = Vec::new();
    let slice = std::slice::from_raw_parts_mut(devices, count as usize);
    for slot in slice.iter_mut() {
      if let Some(act) = slot.take() {
        if let Ok(name) = activate_name(&act) {
          if !name.eq_ignore_ascii_case("FLYBOX Camera") {
            names.push(name);
          }
        }
        drop(act);
      }
    }
    CoTaskMemFree(Some(devices as *const _));
    Ok(names)
  }
}

/// Opened MF reader producing **packed** NV12 at `cx×cy` (stride de-pitched).
/// Create, use, and drop on the **same** OS thread.
pub struct MfCamera {
  _guard: MfGuard,
  reader: IMFSourceReader,
  pub cx: u32,
  pub cy: u32,
  /// Default stride in bytes for Y plane (may be > cx).
  stride: i32,
  pub frame_size: usize,
  pub first_frame: Vec<u8>,
}

impl MfCamera {
  pub fn open(device_name: &str, cx: u32, cy: u32, fps: u32) -> Result<Self, String> {
    let guard = start_mf()?;
    unsafe {
      let attrs = vidcap_attrs()?;
      let mut devices: *mut Option<IMFActivate> = std::ptr::null_mut();
      let mut count = 0u32;
      MFEnumDeviceSources(&attrs, &mut devices, &mut count)
        .map_err(|e| format!("枚举摄像头失败: {e}"))?;
      if devices.is_null() || count == 0 {
        return Err("未找到任何摄像头".into());
      }

      let slice = std::slice::from_raw_parts_mut(devices, count as usize);
      let mut names = Vec::new();
      let mut activates: Vec<IMFActivate> = Vec::new();
      for slot in slice.iter_mut() {
        if let Some(act) = slot.take() {
          let name = activate_name(&act).unwrap_or_default();
          names.push(name);
          activates.push(act);
        }
      }
      CoTaskMemFree(Some(devices as *const _));

      let pick = match_device_name(device_name, &names)
        .ok_or_else(|| format!("找不到摄像头「{device_name}」"))?
        .to_string();
      let idx = names.iter().position(|n| n == &pick).unwrap();
      let activate = activates.swap_remove(idx);
      drop(activates);

      let source = activate
        .ActivateObject::<windows::Win32::Media::MediaFoundation::IMFMediaSource>()
        .map_err(|e| format!("打开摄像头失败: {e}"))?;

      let mut reader_attrs: Option<IMFAttributes> = None;
      let _ = MFCreateAttributes(&mut reader_attrs, 1);
      if let Some(ref a) = reader_attrs {
        // Allow MF converters so we can request NV12 even if the cam is MJPEG/YUY2.
        let _ = a.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 0);
      }

      let reader = MFCreateSourceReaderFromMediaSource(&source, reader_attrs.as_ref())
        .map_err(|e| format!("创建 SourceReader 失败: {e}"))?;

      set_nv12_type(&reader, cx, cy, fps)?;
      let stride = current_stride(&reader, cx)?;

      let frame_size = (cx as usize) * (cy as usize) * 3 / 2;
      let mut first = vec![0u8; frame_size];
      let mut got = false;
      for _ in 0..40 {
        match read_nv12_frame(&reader, cx, cy, stride, &mut first) {
          Ok(()) => {
            got = true;
            break;
          }
          Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
      }
      if !got {
        return Err(format!(
          "Media Foundation 无法从「{device_name}」读出 NV12 画面"
        ));
      }

      Ok(Self {
        _guard: guard,
        reader,
        cx,
        cy,
        stride,
        frame_size,
        first_frame: first,
      })
    }
  }

  pub fn read_nv12(&mut self, buf: &mut [u8]) -> Result<(), String> {
    unsafe { read_nv12_frame(&self.reader, self.cx, self.cy, self.stride, buf) }
  }
}

unsafe fn set_nv12_type(
  reader: &IMFSourceReader,
  cx: u32,
  cy: u32,
  fps: u32,
) -> Result<(), String> {
  let mt = MFCreateMediaType().map_err(|e| format!("MFCreateMediaType: {e}"))?;
  mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
    .map_err(|e| format!("MAJOR_TYPE: {e}"))?;
  mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
    .map_err(|e| format!("SUBTYPE NV12: {e}"))?;
  let frame_size = ((cx as u64) << 32) | (cy as u64);
  mt.SetUINT64(&MF_MT_FRAME_SIZE, frame_size)
    .map_err(|e| format!("FRAME_SIZE: {e}"))?;
  let fps_n = u64::from(fps.max(1));
  let frame_rate = (fps_n << 32) | 1u64;
  let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, frame_rate);

  let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
  if reader.SetCurrentMediaType(stream, None, &mt).is_err() {
    let _ = mt.DeleteItem(&MF_MT_FRAME_RATE);
    reader
      .SetCurrentMediaType(stream, None, &mt)
      .map_err(|e| format!("设置 NV12 输出失败: {e}"))?;
  }
  let _ = reader.SetStreamSelection(stream, true);

  // Confirm negotiated size is what we asked for.
  if let Ok(t) = reader.GetCurrentMediaType(stream) {
    if let Ok(sz) = t.GetUINT64(&MF_MT_FRAME_SIZE) {
      let w = (sz >> 32) as u32;
      let h = sz as u32;
      if w != cx || h != cy {
        return Err(format!("摄像头协商尺寸为 {w}x{h}，不是 {cx}x{cy}"));
      }
    }
  }
  Ok(())
}

unsafe fn current_stride(reader: &IMFSourceReader, cx: u32) -> Result<i32, String> {
  let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
  let mt = reader
    .GetCurrentMediaType(stream)
    .map_err(|e| format!("GetCurrentMediaType: {e}"))?;
  match mt.GetUINT32(&MF_MT_DEFAULT_STRIDE) {
    Ok(s) => {
      let s = s as i32;
      // Stride may be negative (bottom-up); use absolute for row pitch.
      Ok(if s == 0 { cx as i32 } else { s })
    }
    Err(_) => Ok(cx as i32),
  }
}

/// Copy Y + UV from possibly strided source into packed NV12.
fn pack_nv12_from_strided(src: *const u8, stride: i32, cx: u32, cy: u32, out: &mut [u8]) {
  let cx = cx as usize;
  let cy = cy as usize;
  let pitch = stride.unsigned_abs() as usize;
  let y_out = cx * cy;
  let need = y_out + y_out / 2;
  if out.len() < need || src.is_null() || pitch < cx {
    return;
  }
  unsafe {
    // Y plane
    for row in 0..cy {
      let src_row = if stride >= 0 {
        src.add(row * pitch)
      } else {
        // Bottom-up: first row is last in buffer.
        src.add((cy - 1 - row) * pitch)
      };
      std::ptr::copy_nonoverlapping(src_row, out.as_mut_ptr().add(row * cx), cx);
    }
    // UV plane (NV12 interleaved, height/2)
    let uv_src_base = if stride >= 0 {
      src.add(cy * pitch)
    } else {
      // For bottom-up full buffer layout, UV follows Y with same pitch convention.
      src.add(cy * pitch)
    };
    let uv_h = cy / 2;
    let uv_dst = out.as_mut_ptr().add(y_out);
    for row in 0..uv_h {
      let src_row = if stride >= 0 {
        uv_src_base.add(row * pitch)
      } else {
        uv_src_base.add((uv_h - 1 - row) * pitch)
      };
      std::ptr::copy_nonoverlapping(src_row, uv_dst.add(row * cx), cx);
    }
  }
}

unsafe fn read_nv12_frame(
  reader: &IMFSourceReader,
  cx: u32,
  cy: u32,
  stride: i32,
  out: &mut [u8],
) -> Result<(), String> {
  let need = (cx as usize) * (cy as usize) * 3 / 2;
  if out.len() < need {
    return Err("缓冲区太小".into());
  }

  let mut stream_index = 0u32;
  let mut flags = 0u32;
  let mut timestamp = 0i64;
  let mut sample: Option<IMFSample> = None;

  reader
    .ReadSample(
      MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
      0,
      Some(&mut stream_index as *mut u32),
      Some(&mut flags as *mut u32),
      Some(&mut timestamp as *mut i64),
      Some(&mut sample as *mut Option<IMFSample>),
    )
    .map_err(|e| format!("ReadSample: {e}"))?;

  if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
    return Err("摄像头流结束".into());
  }
  let sample = sample.ok_or_else(|| "空帧".to_string())?;
  let buffer: IMFMediaBuffer = sample
    .ConvertToContiguousBuffer()
    .map_err(|e| format!("ConvertToContiguousBuffer: {e}"))?;

  // Prefer 2D lock for accurate pitch.
  if let Ok(buf2d) = buffer.cast::<IMF2DBuffer>() {
    let mut scan0: *mut u8 = std::ptr::null_mut();
    let mut pitch = 0i32;
    buf2d
      .Lock2D(&mut scan0, &mut pitch)
      .map_err(|e| format!("Lock2D: {e}"))?;
    if scan0.is_null() {
      let _ = buf2d.Unlock2D();
      return Err("空 2D 缓冲".into());
    }
    pack_nv12_from_strided(scan0, pitch, cx, cy, out);
    let _ = buf2d.Unlock2D();
    return Ok(());
  }

  let mut raw: *mut u8 = std::ptr::null_mut();
  let mut max_len = 0u32;
  let mut cur_len = 0u32;
  buffer
    .Lock(&mut raw, Some(&mut max_len), Some(&mut cur_len))
    .map_err(|e| format!("Lock: {e}"))?;
  if raw.is_null() || cur_len == 0 {
    let _ = buffer.Unlock();
    return Err("空缓冲区".into());
  }
  let pitch = if stride.abs() as u32 >= cx {
    stride
  } else {
    cx as i32
  };
  // If buffer is already tightly packed, fast path.
  if pitch.unsigned_abs() == cx && cur_len as usize >= need {
    std::ptr::copy_nonoverlapping(raw, out.as_mut_ptr(), need);
  } else {
    pack_nv12_from_strided(raw, pitch, cx, cy, out);
  }
  let _ = buffer.Unlock();
  Ok(())
}
