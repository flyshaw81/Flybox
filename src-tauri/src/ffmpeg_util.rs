//! Locate bundled ffmpeg/ffprobe and run probe/transcode helpers.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("ffmpeg"));
            // NSIS/正式安装：resources 落在 exe 旁的 vendor/ffmpeg/
            dirs.push(dir.join("vendor").join("ffmpeg"));
            if let Some(target) = dir.parent() {
                if let Some(src_tauri) = target.parent() {
                    dirs.push(src_tauri.join("vendor").join("ffmpeg"));
                }
            }
        }
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        dirs.push(PathBuf::from(manifest).join("vendor").join("ffmpeg"));
    }
    dirs
}

pub fn find_tool(name: &str) -> Option<PathBuf> {
    for dir in search_dirs() {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Spawn ffmpeg/ffprobe without flashing a console window on Windows GUI apps.
fn tool_cmd(program: impl AsRef<OsStr>) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub duration_ms: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub format: Option<String>,
}

pub fn probe(path: &Path) -> Result<ProbeInfo, String> {
    let ffprobe = find_tool("ffprobe.exe").or_else(|| find_tool("ffprobe"))
        .ok_or_else(|| "找不到 ffprobe.exe（请放到 vendor/ffmpeg）".to_string())?;
    let out = tool_cmd(ffprobe)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("运行 ffprobe 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe 失败: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("解析 ffprobe JSON: {e}"))?;
    let duration_ms = v
        .pointer("/format/duration")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .map(|s| (s * 1000.0) as u64);
    let audio = v
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|s| s.get("codec_type").and_then(|t| t.as_str()) == Some("audio"))
        });
    let sample_rate = audio
        .and_then(|s| s.get("sample_rate"))
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok());
    let channels = audio
        .and_then(|s| s.get("channels"))
        .and_then(|x| x.as_u64())
        .map(|n| n as u32);
    let format = v
        .pointer("/format/format_name")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok(ProbeInfo {
        duration_ms,
        sample_rate,
        channels,
        format,
    })
}

/// Export a time range to 44.1kHz stereo WAV via ffmpeg.
/// Optional afade in/out, linear gain, speed (atempo), pitch (asetrate) on the *exported* clip.
pub fn export_range(
    src: &Path,
    start_ms: u64,
    end_ms: u64,
    dest: &Path,
    fade_in_ms: u64,
    fade_out_ms: u64,
    volume: f32,
) -> Result<(), String> {
    export_range_fx(
        src, start_ms, end_ms, dest, fade_in_ms, fade_out_ms, volume, 1.0, 0.0,
    )
}

pub fn export_range_fx(
    src: &Path,
    start_ms: u64,
    end_ms: u64,
    dest: &Path,
    fade_in_ms: u64,
    fade_out_ms: u64,
    volume: f32,
    speed: f32,
    pitch_semitones: f32,
) -> Result<(), String> {
    let ffmpeg = find_tool("ffmpeg.exe")
        .or_else(|| find_tool("ffmpeg"))
        .ok_or_else(|| "找不到 ffmpeg.exe（请放到 vendor/ffmpeg）".to_string())?;
    if end_ms <= start_ms {
        return Err("无效的裁剪区间".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let start_s = format!("{:.3}", start_ms as f64 / 1000.0);
    let dur_ms = end_ms - start_ms;
    let dur_s = format!("{:.3}", dur_ms as f64 / 1000.0);
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-ss".into(),
        start_s,
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-t".into(),
        dur_s,
        "-vn".into(),
    ];
    let speed = speed.clamp(0.25, 4.0);
    let out_dur_ms = ((dur_ms as f64) / speed as f64).round().max(1.0) as u64;
    let fi = fade_in_ms.min(out_dur_ms);
    let fo = fade_out_ms.min(out_dur_ms);
    let fo_use = if fi + fo > out_dur_ms {
        out_dur_ms.saturating_sub(fi)
    } else {
        fo
    };
    if let Some(f) = build_af_chain(fi, fo_use, out_dur_ms, volume, speed, pitch_semitones) {
        args.push("-af".into());
        args.push(f);
    }
    args.extend([
        "-ac".into(),
        "2".into(),
        "-ar".into(),
        "44100".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        dest.to_string_lossy().into_owned(),
    ]);
    let out = tool_cmd(ffmpeg)
        .args(&args)
        .output()
        .map_err(|e| format!("运行 ffmpeg 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "裁剪导出失败: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn push_atempo(parts: &mut Vec<String>, speed: f32) {
    let mut s = speed.clamp(0.25, 4.0);
    // atempo 单次只能 0.5～2.0，链式拼接
    while s > 2.0 + 1e-4 {
        parts.push("atempo=2.0".into());
        s /= 2.0;
    }
    while s < 0.5 - 1e-4 {
        parts.push("atempo=0.5".into());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 0.01 {
        parts.push(format!("atempo={s:.4}"));
    }
}

fn build_af_chain(
    fade_in_ms: u64,
    fade_out_ms: u64,
    out_dur_ms: u64,
    volume: f32,
    speed: f32,
    pitch_semitones: f32,
) -> Option<String> {
    let mut parts = Vec::new();
    let vol = volume.clamp(0.0, 8.0);
    if (vol - 1.0).abs() > 0.001 {
        parts.push(format!("volume={vol:.4}"));
    }
    // 变调（简易）：asetrate + aresample，会连带时长微变，再 atempo 压回
    if pitch_semitones.abs() > 0.05 {
        let rate = 44100.0 * (2f64).powf(pitch_semitones as f64 / 12.0);
        parts.push(format!("asetrate={rate:.2},aresample=44100"));
    }
    push_atempo(&mut parts, speed);
    if fade_in_ms > 0 {
        parts.push(format!(
            "afade=t=in:st=0:d={:.3}",
            fade_in_ms as f64 / 1000.0
        ));
    }
    if fade_out_ms > 0 && out_dur_ms > fade_out_ms {
        let d = fade_out_ms as f64 / 1000.0;
        let st = (out_dur_ms - fade_out_ms) as f64 / 1000.0;
        parts.push(format!("afade=t=out:st={st:.3}:d={d:.3}"));
    } else if fade_out_ms > 0 {
        let d = fade_out_ms.min(out_dur_ms) as f64 / 1000.0;
        parts.push(format!("afade=t=out:st=0:d={d:.3}"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// Mix trimmed WAV parts onto one timeline. `parts` = (wav_path, delay_ms on timeline).
pub fn mix_timeline(parts: &[(PathBuf, u64)], dest: &Path) -> Result<(), String> {
    if parts.is_empty() {
        return Err("没有可混音的片段".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if parts.len() == 1 && parts[0].1 == 0 {
        std::fs::copy(&parts[0].0, dest).map_err(|e| format!("复制片段失败: {e}"))?;
        return Ok(());
    }
    let ffmpeg = find_tool("ffmpeg.exe")
        .or_else(|| find_tool("ffmpeg"))
        .ok_or_else(|| "找不到 ffmpeg.exe（请放到 vendor/ffmpeg）".to_string())?;

    let mut args: Vec<String> = vec!["-y".into()];
    for (p, _) in parts {
        args.push("-i".into());
        args.push(p.to_string_lossy().into_owned());
    }

    // [i]adelay=ms|ms[a_i]; ... [a0][a1]...amix=inputs=N:duration=longest
    let mut filter = String::new();
    for (i, (_, delay)) in parts.iter().enumerate() {
        let d = *delay;
        filter.push_str(&format!("[{i}]adelay={d}|{d}:all=1[a{i}];"));
    }
    for i in 0..parts.len() {
        filter.push_str(&format!("[a{i}]"));
    }
    filter.push_str(&format!(
        "amix=inputs={}:duration=longest:dropout_transition=0:normalize=0",
        parts.len()
    ));

    args.extend([
        "-filter_complex".into(),
        filter,
        "-ac".into(),
        "2".into(),
        "-ar".into(),
        "44100".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        dest.to_string_lossy().into_owned(),
    ]);

    let out = tool_cmd(ffmpeg)
        .args(&args)
        .output()
        .map_err(|e| format!("运行 ffmpeg 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "多轨混音失败: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

/// Concatenate same-format WAV parts (44100 stereo PCM) into one file.
pub fn concat_wavs(parts: &[PathBuf], dest: &Path) -> Result<(), String> {
    if parts.is_empty() {
        return Err("没有可拼接的片段".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if parts.len() == 1 {
        std::fs::copy(&parts[0], dest).map_err(|e| format!("复制片段失败: {e}"))?;
        return Ok(());
    }
    let ffmpeg = find_tool("ffmpeg.exe")
        .or_else(|| find_tool("ffmpeg"))
        .ok_or_else(|| "找不到 ffmpeg.exe（请放到 vendor/ffmpeg）".to_string())?;
    let list_path = dest.with_extension("concat.txt");
    let mut list = String::new();
    for p in parts {
        let s = p
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        list.push_str("file '");
        list.push_str(&s);
        list.push_str("'\n");
    }
    std::fs::write(&list_path, list).map_err(|e| format!("写拼接列表失败: {e}"))?;
    let out = tool_cmd(ffmpeg)
        .args([
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_path.to_string_lossy().as_ref(),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            dest.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("运行 ffmpeg 失败: {e}"))?;
    let _ = std::fs::remove_file(&list_path);
    if !out.status.success() {
        return Err(format!(
            "拼接失败: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

/// Transcode to 44.1kHz stereo mp3 beside source (or into dest).
pub fn transcode_to_mp3(src: &Path, dest: &Path) -> Result<(), String> {
    let ffmpeg = find_tool("ffmpeg.exe")
        .or_else(|| find_tool("ffmpeg"))
        .ok_or_else(|| "找不到 ffmpeg.exe（请放到 vendor/ffmpeg）".to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let out = tool_cmd(ffmpeg)
        .args([
            "-y",
            "-i",
            src.to_string_lossy().as_ref(),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-b:a",
            "192k",
            dest.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("运行 ffmpeg 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "转码失败: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn peaks_cache_file(path: &Path, buckets: usize) -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))?;
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{}|{}|{}", path.to_string_lossy(), mtime, buckets);
    let mut hash: u64 = 1469598103934665603;
    for b in key.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(1099511628211);
    }
    Some(
        PathBuf::from(base)
            .join("FLYBOX")
            .join("sfx-peaks")
            .join(format!("{hash:016x}.json")),
    )
}

/// Generate peak samples (0..1) for waveform UI via ffmpeg (cached on disk).
/// Downsamples to 8kHz mono so long clips stay fast; buckets up to 4k for zoom.
pub fn waveform_peaks(path: &Path, buckets: usize) -> Result<Vec<f32>, String> {
    let buckets = buckets.clamp(16, 4096);
    if let Some(cache) = peaks_cache_file(path, buckets) {
        if let Ok(raw) = std::fs::read_to_string(&cache) {
            if let Ok(peaks) = serde_json::from_str::<Vec<f32>>(&raw) {
                if peaks.len() == buckets {
                    return Ok(peaks);
                }
            }
        }
    }
    let ffmpeg = find_tool("ffmpeg.exe")
        .or_else(|| find_tool("ffmpeg"))
        .ok_or_else(|| "找不到 ffmpeg.exe".to_string())?;
    // 8kHz mono：包络够用，比全采样解码快一个数量级
    let out = tool_cmd(ffmpeg)
        .args([
            "-v",
            "error",
            "-i",
            path.to_string_lossy().as_ref(),
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-",
        ])
        .output()
        .map_err(|e| format!("波形提取失败: {e}"))?;
    if !out.status.success() && out.stdout.is_empty() {
        return Err("无法提取波形".into());
    }
    let bytes = out.stdout;
    let n = bytes.len() / 4;
    if n == 0 {
        return Ok(vec![0.0; buckets]);
    }
    let chunk = (n / buckets).max(1);
    // 块内再抽样，避免超长文件在 Rust 里逐样本扫
    let stride = (chunk / 64).max(1);
    let mut peaks = Vec::with_capacity(buckets);
    let mut global_peak = 0.0001f32;
    for i in 0..buckets {
        let start = i * chunk;
        if start >= n {
            peaks.push(0.0);
            continue;
        }
        let end = (start + chunk).min(n);
        let mut p = 0.0f32;
        let mut j = start;
        while j < end {
            let o = j * 4;
            if o + 4 > bytes.len() {
                break;
            }
            let v = f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]).abs();
            if v > p {
                p = v;
            }
            j += stride;
        }
        if p > global_peak {
            global_peak = p;
        }
        peaks.push(p);
    }
    let inv = 1.0 / global_peak;
    for p in &mut peaks {
        *p = (*p * inv).min(1.0);
    }
    if let Some(cache) = peaks_cache_file(path, buckets) {
        if let Some(parent) = cache.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = serde_json::to_string(&peaks) {
            let _ = std::fs::write(cache, s);
        }
    }
    Ok(peaks)
}
