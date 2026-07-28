//! Thin dynamic loader for BASS + BASS_FX (+ format plugins) on Windows.

#![allow(non_snake_case, dead_code)]

use libloading::{Library, Symbol};
use std::ffi::c_void;
use std::os::raw::{c_char, c_float, c_int};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub type HSTREAM = u32;
pub type HPLUGIN = u32;
pub type BOOL = i32;
pub type DWORD = u32;
pub type QWORD = u64;

pub const BASS_ERROR_ALREADY: i32 = 14;
pub const BASS_DEVICE_ENABLED: DWORD = 1;
pub const BASS_DEVICE_DEFAULT: DWORD = 2;
pub const BASS_SAMPLE_FLOAT: DWORD = 256;
pub const BASS_SAMPLE_LOOP: DWORD = 4;
pub const BASS_STREAM_DECODE: DWORD = 0x200000;
pub const BASS_STREAM_AUTOFREE: DWORD = 0x40000;
pub const BASS_POS_BYTE: DWORD = 0;
pub const BASS_ACTIVE_STOPPED: DWORD = 0;
pub const BASS_ACTIVE_PLAYING: DWORD = 1;
pub const BASS_ACTIVE_PAUSED: DWORD = 3;
pub const BASS_ATTRIB_VOL: DWORD = 2;
pub const BASS_ATTRIB_TEMPO: DWORD = 0x10000;
pub const BASS_ATTRIB_TEMPO_PITCH: DWORD = 0x10001;
pub const BASS_FX_FREESOURCE: DWORD = 0x10000;
pub const BASS_UNICODE: DWORD = 0x80000000;

type FnInit = unsafe extern "C" fn(c_int, DWORD, DWORD, *mut c_void, *mut c_void) -> BOOL;
type FnFree = unsafe extern "C" fn();
type FnErrorGetCode = unsafe extern "C" fn() -> c_int;
type FnGetDeviceInfo = unsafe extern "C" fn(DWORD, *mut BASS_DEVICEINFO) -> BOOL;
type FnSetDevice = unsafe extern "C" fn(DWORD) -> BOOL;
type FnPluginLoad = unsafe extern "C" fn(*const c_void, DWORD) -> HPLUGIN;
type FnStreamCreateFile =
    unsafe extern "C" fn(BOOL, *const c_void, QWORD, QWORD, DWORD) -> HSTREAM;
type FnStreamFree = unsafe extern "C" fn(HSTREAM) -> BOOL;
type FnChannelPlay = unsafe extern "C" fn(DWORD, BOOL) -> BOOL;
type FnChannelPause = unsafe extern "C" fn(DWORD) -> BOOL;
type FnChannelStop = unsafe extern "C" fn(DWORD) -> BOOL;
type FnChannelIsActive = unsafe extern "C" fn(DWORD) -> DWORD;
type FnChannelBytes2Seconds = unsafe extern "C" fn(DWORD, QWORD) -> f64;
type FnChannelSeconds2Bytes = unsafe extern "C" fn(DWORD, f64) -> QWORD;
type FnChannelGetLength = unsafe extern "C" fn(DWORD, DWORD) -> QWORD;
type FnChannelGetPosition = unsafe extern "C" fn(DWORD, DWORD) -> QWORD;
type FnChannelSetPosition = unsafe extern "C" fn(DWORD, QWORD, DWORD) -> BOOL;
type FnChannelSetAttribute = unsafe extern "C" fn(DWORD, DWORD, c_float) -> BOOL;
type FnChannelSlideAttribute = unsafe extern "C" fn(DWORD, DWORD, c_float, DWORD) -> BOOL;
type FnChannelIsSliding = unsafe extern "C" fn(DWORD, DWORD) -> BOOL;
type FnChannelGetLevel = unsafe extern "C" fn(DWORD) -> DWORD;
type FnRecordGetDeviceInfo = unsafe extern "C" fn(DWORD, *mut BASS_DEVICEINFO) -> BOOL;
type FnRecordInit = unsafe extern "C" fn(c_int) -> BOOL;
type FnRecordStart =
    unsafe extern "C" fn(DWORD, DWORD, DWORD, Option<RecordProc>, *mut c_void) -> HSTREAM;
type FnRecordFree = unsafe extern "C" fn() -> BOOL;
type FnFXTempoCreate = unsafe extern "C" fn(DWORD, DWORD) -> HSTREAM;
type RecordProc = unsafe extern "C" fn(HSTREAM, *const c_void, DWORD, *mut c_void) -> BOOL;

#[repr(C)]
pub struct BASS_DEVICEINFO {
    pub name: *const c_char,
    pub driver: *const c_char,
    pub flags: DWORD,
}

struct BassApi {
    init: Symbol<'static, FnInit>,
    free: Symbol<'static, FnFree>,
    error_get_code: Symbol<'static, FnErrorGetCode>,
    get_device_info: Symbol<'static, FnGetDeviceInfo>,
    set_device: Symbol<'static, FnSetDevice>,
    plugin_load: Symbol<'static, FnPluginLoad>,
    stream_create_file: Symbol<'static, FnStreamCreateFile>,
    stream_free: Symbol<'static, FnStreamFree>,
    channel_play: Symbol<'static, FnChannelPlay>,
    channel_pause: Symbol<'static, FnChannelPause>,
    channel_stop: Symbol<'static, FnChannelStop>,
    channel_is_active: Symbol<'static, FnChannelIsActive>,
    channel_bytes2seconds: Symbol<'static, FnChannelBytes2Seconds>,
    channel_seconds2bytes: Symbol<'static, FnChannelSeconds2Bytes>,
    channel_get_length: Symbol<'static, FnChannelGetLength>,
    channel_get_position: Symbol<'static, FnChannelGetPosition>,
    channel_set_position: Symbol<'static, FnChannelSetPosition>,
    channel_set_attribute: Symbol<'static, FnChannelSetAttribute>,
    channel_slide_attribute: Symbol<'static, FnChannelSlideAttribute>,
    channel_is_sliding: Symbol<'static, FnChannelIsSliding>,
    channel_get_level: Symbol<'static, FnChannelGetLevel>,
    record_get_device_info: Symbol<'static, FnRecordGetDeviceInfo>,
    record_init: Symbol<'static, FnRecordInit>,
    record_start: Symbol<'static, FnRecordStart>,
    record_free: Symbol<'static, FnRecordFree>,
    fx_tempo_create: Option<Symbol<'static, FnFXTempoCreate>>,
}

unsafe impl Send for BassApi {}
unsafe impl Sync for BassApi {}

static API: OnceLock<Result<BassApi, String>> = OnceLock::new();

fn dll_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("bass"));
            // NSIS/正式安装：resources 落在 exe 旁的 vendor/bass/
            dirs.push(dir.join("vendor").join("bass"));
            // target/debug -> src-tauri/vendor/bass
            if let Some(target) = dir.parent() {
                if let Some(src_tauri) = target.parent() {
                    dirs.push(src_tauri.join("vendor").join("bass"));
                }
            }
        }
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        dirs.push(PathBuf::from(manifest).join("vendor").join("bass"));
    }
    dirs.push(PathBuf::from("vendor/bass"));
    dirs
}

fn find_dll(name: &str) -> Option<PathBuf> {
    for dir in dll_search_dirs() {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn set_dll_directory(dir: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn SetDllDirectoryW(lpPathName: *const u16) -> i32;
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe { SetDllDirectoryW(wide.as_ptr()) != 0 }
}

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn load_api() -> Result<BassApi, String> {
    let bass_path = find_dll("bass.dll").ok_or_else(|| {
        "找不到 bass.dll。请放到应用目录或 src-tauri/vendor/bass/".to_string()
    })?;
    if let Some(dir) = bass_path.parent() {
        let _ = set_dll_directory(dir);
    }

    unsafe {
        let bass: &'static Library = Box::leak(Box::new(
            Library::new(&bass_path).map_err(|e| format!("加载 bass.dll 失败: {e}"))?,
        ));
        let fx: Option<&'static Library> = match find_dll("bass_fx.dll") {
            Some(p) => Some(Box::leak(Box::new(
                Library::new(&p).map_err(|e| format!("加载 bass_fx.dll 失败: {e}"))?,
            ))),
            None => None,
        };

        macro_rules! sym {
            ($lib:expr, $name:expr) => {
                $lib.get($name)
                    .map_err(|e| format!("缺少 BASS 符号: {e}"))?
            };
        }

        Ok(BassApi {
            init: sym!(bass, b"BASS_Init\0"),
            free: sym!(bass, b"BASS_Free\0"),
            error_get_code: sym!(bass, b"BASS_ErrorGetCode\0"),
            get_device_info: sym!(bass, b"BASS_GetDeviceInfo\0"),
            set_device: sym!(bass, b"BASS_SetDevice\0"),
            plugin_load: sym!(bass, b"BASS_PluginLoad\0"),
            stream_create_file: sym!(bass, b"BASS_StreamCreateFile\0"),
            stream_free: sym!(bass, b"BASS_StreamFree\0"),
            channel_play: sym!(bass, b"BASS_ChannelPlay\0"),
            channel_pause: sym!(bass, b"BASS_ChannelPause\0"),
            channel_stop: sym!(bass, b"BASS_ChannelStop\0"),
            channel_is_active: sym!(bass, b"BASS_ChannelIsActive\0"),
            channel_bytes2seconds: sym!(bass, b"BASS_ChannelBytes2Seconds\0"),
            channel_seconds2bytes: sym!(bass, b"BASS_ChannelSeconds2Bytes\0"),
            channel_get_length: sym!(bass, b"BASS_ChannelGetLength\0"),
            channel_get_position: sym!(bass, b"BASS_ChannelGetPosition\0"),
            channel_set_position: sym!(bass, b"BASS_ChannelSetPosition\0"),
            channel_set_attribute: sym!(bass, b"BASS_ChannelSetAttribute\0"),
            channel_slide_attribute: sym!(bass, b"BASS_ChannelSlideAttribute\0"),
            channel_is_sliding: sym!(bass, b"BASS_ChannelIsSliding\0"),
            channel_get_level: sym!(bass, b"BASS_ChannelGetLevel\0"),
            record_get_device_info: sym!(bass, b"BASS_RecordGetDeviceInfo\0"),
            record_init: sym!(bass, b"BASS_RecordInit\0"),
            record_start: sym!(bass, b"BASS_RecordStart\0"),
            record_free: sym!(bass, b"BASS_RecordFree\0"),
            fx_tempo_create: match fx {
                Some(lib) => Some(sym!(lib, b"BASS_FX_TempoCreate\0")),
                None => None,
            },
        })
    }
}

fn api() -> Result<&'static BassApi, String> {
    API.get_or_init(load_api).as_ref().map_err(|e| e.clone())
}

pub fn init(device: i32, freq: u32) -> Result<(), String> {
    let a = api()?;
    unsafe {
        let ok = (a.init)(device, freq, 0, std::ptr::null_mut(), std::ptr::null_mut());
        if ok == 0 {
            let err = (a.error_get_code)();
            if err != BASS_ERROR_ALREADY {
                return Err(format!("BASS_Init 失败 (err={err})"));
            }
        }
    }
    load_plugins();
    Ok(())
}

pub fn free() {
    if let Ok(a) = api() {
        unsafe { (a.free)() }
    }
}

fn load_plugins() {
    let Ok(a) = api() else { return };
    for name in [
        "bassflac.dll",
        "bassopus.dll",
        "basswebm.dll",
        "bassalac.dll",
        "bass_aac.dll",
        "basswma.dll",
    ] {
        if let Some(p) = find_dll(name) {
            let wide = wide_path(&p);
            unsafe {
                let _ = (a.plugin_load)(wide.as_ptr() as *const c_void, BASS_UNICODE);
            }
        }
    }
}

pub struct DeviceInfo {
    pub index: i32,
    pub name: String,
    pub is_default: bool,
    pub enabled: bool,
}

/// BASS on Windows returns ANSI device names unless `BASS_UNICODE` is OR'd into
/// the device index — then `name` is a UTF-16 C string (avoids GBK mojibake).
fn device_name_utf16(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let wide = ptr as *const u16;
    let mut len = 0usize;
    unsafe {
        while *wide.add(len) != 0 {
            len += 1;
            if len > 512 {
                break;
            }
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(wide, len))
    }
}

fn collect_devices(get_info: &Symbol<'static, FnGetDeviceInfo>) -> Vec<DeviceInfo> {
    let mut out = Vec::new();
    let mut i: DWORD = 0;
    loop {
        let mut info = BASS_DEVICEINFO {
            name: std::ptr::null(),
            driver: std::ptr::null(),
            flags: 0,
        };
        let ok = unsafe { get_info(i | BASS_UNICODE, &mut info) };
        if ok == 0 {
            break;
        }
        if !info.name.is_null() {
            let name = device_name_utf16(info.name);
            out.push(DeviceInfo {
                index: i as i32,
                name,
                is_default: info.flags & BASS_DEVICE_DEFAULT != 0,
                enabled: info.flags & BASS_DEVICE_ENABLED != 0,
            });
        }
        i += 1;
    }
    out
}

pub fn list_output_devices() -> Result<Vec<DeviceInfo>, String> {
    let a = api()?;
    Ok(collect_devices(&a.get_device_info))
}

pub fn list_input_devices() -> Result<Vec<DeviceInfo>, String> {
    let a = api()?;
    Ok(collect_devices(&a.record_get_device_info))
}

pub fn set_device(index: i32) -> Result<(), String> {
    let a = api()?;
    unsafe {
        if (a.set_device)(index as DWORD) == 0 {
            return Err(format!("BASS_SetDevice 失败 (err={})", (a.error_get_code)()));
        }
    }
    Ok(())
}

pub fn create_stream(path: &Path, loop_it: bool) -> Result<HSTREAM, String> {
    let a = api()?;
    let wide = wide_path(path);
    let mut flags = BASS_SAMPLE_FLOAT | BASS_STREAM_AUTOFREE | BASS_UNICODE;
    if loop_it {
        flags |= BASS_SAMPLE_LOOP;
    }
    let h = unsafe { (a.stream_create_file)(0, wide.as_ptr() as *const c_void, 0, 0, flags) };
    if h == 0 {
        return Err(format!(
            "无法打开音频 (err={}): {}",
            unsafe { (a.error_get_code)() },
            path.display()
        ));
    }
    Ok(h)
}

pub fn create_decode_stream(path: &Path, loop_it: bool) -> Result<HSTREAM, String> {
    let a = api()?;
    let wide = wide_path(path);
    let mut flags = BASS_SAMPLE_FLOAT | BASS_STREAM_DECODE | BASS_UNICODE;
    if loop_it {
        flags |= BASS_SAMPLE_LOOP;
    }
    let h = unsafe { (a.stream_create_file)(0, wide.as_ptr() as *const c_void, 0, 0, flags) };
    if h == 0 {
        return Err(format!(
            "无法解码音频 (err={}): {}",
            unsafe { (a.error_get_code)() },
            path.display()
        ));
    }
    Ok(h)
}

pub fn tempo_create(decode: HSTREAM) -> Result<HSTREAM, String> {
    let a = api()?;
    let Some(fx) = &a.fx_tempo_create else {
        return Err("缺少 bass_fx.dll".into());
    };
    let h = unsafe { fx(decode, BASS_FX_FREESOURCE | BASS_STREAM_AUTOFREE) };
    if h == 0 {
        return Err(format!("BASS_FX_TempoCreate 失败 (err={})", unsafe {
            (a.error_get_code)()
        }));
    }
    Ok(h)
}

pub fn play(handle: HSTREAM, restart: bool) -> Result<(), String> {
    let a = api()?;
    unsafe {
        if (a.channel_play)(handle, i32::from(restart)) == 0 {
            return Err(format!("播放失败 (err={})", (a.error_get_code)()));
        }
    }
    Ok(())
}

pub fn pause(handle: HSTREAM) {
    if let Ok(a) = api() {
        unsafe {
            let _ = (a.channel_pause)(handle);
        }
    }
}

pub fn stop(handle: HSTREAM) {
    if let Ok(a) = api() {
        unsafe {
            let _ = (a.channel_stop)(handle);
            let _ = (a.stream_free)(handle);
        }
    }
}

pub fn is_active(handle: HSTREAM) -> DWORD {
    match api() {
        Ok(a) => unsafe { (a.channel_is_active)(handle) },
        Err(_) => BASS_ACTIVE_STOPPED,
    }
}

pub fn duration_ms(handle: HSTREAM) -> Option<u64> {
    let a = api().ok()?;
    unsafe {
        let len = (a.channel_get_length)(handle, BASS_POS_BYTE);
        if len == u64::MAX {
            return None;
        }
        let secs = (a.channel_bytes2seconds)(handle, len);
        if secs < 0.0 {
            None
        } else {
            Some((secs * 1000.0) as u64)
        }
    }
}

pub fn position_ms(handle: HSTREAM) -> u64 {
    let Ok(a) = api() else { return 0 };
    unsafe {
        let pos = (a.channel_get_position)(handle, BASS_POS_BYTE);
        let secs = (a.channel_bytes2seconds)(handle, pos);
        if secs < 0.0 {
            0
        } else {
            (secs * 1000.0) as u64
        }
    }
}

pub fn seek_ms(handle: HSTREAM, ms: u64) -> Result<(), String> {
    let a = api()?;
    unsafe {
        let bytes = (a.channel_seconds2bytes)(handle, ms as f64 / 1000.0);
        if (a.channel_set_position)(handle, bytes, BASS_POS_BYTE) == 0 {
            return Err(format!("seek 失败 (err={})", (a.error_get_code)()));
        }
    }
    Ok(())
}

pub fn set_volume(handle: HSTREAM, vol: f32) {
    if let Ok(a) = api() {
        unsafe {
            // Allow >1 for clip boost (montage gain). BASS accepts amplification.
            let _ = (a.channel_set_attribute)(handle, BASS_ATTRIB_VOL, vol.clamp(0.0, 4.0));
        }
    }
}

pub fn slide_volume(handle: HSTREAM, vol: f32, ms: u32) {
    if let Ok(a) = api() {
        unsafe {
            let _ = (a.channel_slide_attribute)(handle, BASS_ATTRIB_VOL, vol.clamp(0.0, 4.0), ms);
        }
    }
}

pub fn is_sliding_vol(handle: HSTREAM) -> bool {
    match api() {
        Ok(a) => unsafe { (a.channel_is_sliding)(handle, BASS_ATTRIB_VOL) != 0 },
        Err(_) => false,
    }
}

pub fn set_tempo_percent(handle: HSTREAM, percent: f32) {
    if let Ok(a) = api() {
        unsafe {
            let _ = (a.channel_set_attribute)(handle, BASS_ATTRIB_TEMPO, percent);
        }
    }
}

pub fn set_pitch_semitones(handle: HSTREAM, semitones: f32) {
    if let Ok(a) = api() {
        unsafe {
            let _ = (a.channel_set_attribute)(handle, BASS_ATTRIB_TEMPO_PITCH, semitones);
        }
    }
}

static mut REC_PEAK: f32 = 0.0;
static REC_CAPTURE: OnceLock<std::sync::Mutex<Vec<f32>>> = OnceLock::new();
static REC_CAPTURING: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();

fn rec_buf() -> &'static std::sync::Mutex<Vec<f32>> {
    REC_CAPTURE.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

fn rec_capturing() -> &'static std::sync::atomic::AtomicBool {
    REC_CAPTURING.get_or_init(|| std::sync::atomic::AtomicBool::new(false))
}

/// Max float samples (~3 min stereo @ 44.1k).
const REC_MAX_FLOATS: usize = 44100 * 2 * 60 * 3;

unsafe extern "C" fn record_proc(
    _handle: HSTREAM,
    buffer: *const c_void,
    length: DWORD,
    _user: *mut c_void,
) -> BOOL {
    if buffer.is_null() || length == 0 {
        return 1;
    }
    let n = (length as usize) / 4;
    let slice = std::slice::from_raw_parts(buffer as *const f32, n.max(1));
    let mut peak = 0.0f32;
    for s in slice {
        peak = peak.max(s.abs());
    }
    REC_PEAK = REC_PEAK.max(peak);
    if rec_capturing().load(std::sync::atomic::Ordering::Relaxed) {
        if let Ok(mut buf) = rec_buf().lock() {
            if buf.len() < REC_MAX_FLOATS {
                let room = REC_MAX_FLOATS - buf.len();
                buf.extend_from_slice(&slice[..slice.len().min(room)]);
            }
        }
    }
    1
}

pub fn record_init(device: i32) -> Result<(), String> {
    let a = api()?;
    unsafe {
        let _ = (a.record_free)();
        if (a.record_init)(device) == 0 {
            let err = (a.error_get_code)();
            if err != BASS_ERROR_ALREADY {
                return Err(format!("BASS_RecordInit 失败 (err={err})"));
            }
        }
    }
    Ok(())
}

pub fn record_start_monitor() -> Result<HSTREAM, String> {
    let a = api()?;
    unsafe {
        REC_PEAK = 0.0;
        rec_capturing().store(false, std::sync::atomic::Ordering::Relaxed);
        let h = (a.record_start)(
            44100,
            1,
            BASS_SAMPLE_FLOAT,
            Some(record_proc),
            std::ptr::null_mut(),
        );
        if h == 0 {
            return Err(format!("BASS_RecordStart 失败 (err={})", (a.error_get_code)()));
        }
        Ok(h)
    }
}

/// Stereo float capture for writing to WAV.
pub fn record_start_capture() -> Result<HSTREAM, String> {
    let a = api()?;
    unsafe {
        REC_PEAK = 0.0;
        if let Ok(mut buf) = rec_buf().lock() {
            buf.clear();
            buf.reserve(44100 * 2 * 10);
        }
        rec_capturing().store(true, std::sync::atomic::Ordering::Relaxed);
        let h = (a.record_start)(
            44100,
            2,
            BASS_SAMPLE_FLOAT,
            Some(record_proc),
            std::ptr::null_mut(),
        );
        if h == 0 {
            rec_capturing().store(false, std::sync::atomic::Ordering::Relaxed);
            return Err(format!("BASS_RecordStart 失败 (err={})", (a.error_get_code)()));
        }
        Ok(h)
    }
}

pub fn record_peak_take() -> f32 {
    unsafe {
        let p = REC_PEAK;
        REC_PEAK *= 0.65;
        p
    }
}

pub fn record_is_capturing() -> bool {
    rec_capturing().load(std::sync::atomic::Ordering::Relaxed)
}

pub fn record_take_pcm() -> Vec<f32> {
    rec_capturing().store(false, std::sync::atomic::Ordering::Relaxed);
    rec_buf()
        .lock()
        .map(|mut b| std::mem::take(&mut *b))
        .unwrap_or_default()
}

pub fn record_stop(handle: HSTREAM) {
    stop(handle);
    rec_capturing().store(false, std::sync::atomic::Ordering::Relaxed);
    if let Ok(a) = api() {
        unsafe {
            let _ = (a.record_free)();
        }
    }
}

/// Write mono/stereo float PCM as 16-bit WAV.
pub fn write_wav_f32(path: &Path, samples: &[f32], sample_rate: u32, channels: u16) -> Result<(), String> {
    if samples.is_empty() {
        return Err("录音为空".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut pcm = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        pcm.extend_from_slice(&v.to_le_bytes());
    }
    let data_len = pcm.len() as u32;
    let byte_rate = sample_rate * u32::from(channels) * 2;
    let block_align = channels * 2;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&pcm);
    std::fs::write(path, out).map_err(|e| format!("写 WAV 失败: {e}"))
}
