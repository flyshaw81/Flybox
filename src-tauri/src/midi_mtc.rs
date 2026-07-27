//! MIDI-MTC quarter-frame timecode output synced to BGM position.

use midir::{MidiOutput, MidiOutputConnection};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub struct MidiState {
    inner: Arc<Mutex<MidiInner>>,
    ticker_stop: Arc<AtomicBool>,
}

struct MidiInner {
    enabled: bool,
    port_name: Option<String>,
    fps: u8,
    offset_ms: i64,
    conn: Option<MidiOutputConnection>,
    /// Last locked playhead (already offset-applied).
    pos_ms: u64,
    pos_at: Instant,
    qf_index: u8,
}

impl Default for MidiState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(MidiInner {
                enabled: false,
                port_name: None,
                fps: 30,
                offset_ms: 0,
                conn: None,
                pos_ms: 0,
                pos_at: Instant::now(),
                qf_index: 0,
            })),
            ticker_stop: Arc::new(AtomicBool::new(true)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiStatus {
    pub enabled: bool,
    pub ports: Vec<String>,
    pub port_name: Option<String>,
    pub fps: u8,
    pub offset_ms: i64,
}

fn list_ports() -> Result<Vec<String>, String> {
    let midi = MidiOutput::new("FLYBOX MTC").map_err(|e| e.to_string())?;
    Ok(midi
        .ports()
        .iter()
        .filter_map(|p| midi.port_name(p).ok())
        .collect())
}

fn fps_code(fps: u8) -> u8 {
    match fps {
        24 => 0,
        25 => 1,
        29 => 2,
        _ => 3,
    }
}

fn smpte_parts(ms: u64, fps: u8) -> (u8, u8, u8, u8, u8) {
    let fps = if fps == 0 { 30 } else { fps };
    let total_frames = (ms as f64 / 1000.0 * f64::from(fps)) as u64;
    let ff = (total_frames % u64::from(fps)) as u8;
    let total_secs = total_frames / u64::from(fps);
    let ss = (total_secs % 60) as u8;
    let total_mins = total_secs / 60;
    let mm = (total_mins % 60) as u8;
    let hh = (total_mins / 60 % 24) as u8;
    (hh, mm, ss, ff, fps_code(fps))
}

fn mtc_nibbles(hh: u8, mm: u8, ss: u8, ff: u8, fps_code: u8) -> [u8; 8] {
    let hr = (hh & 0x1f) | (fps_code << 5);
    [
        ff & 0x0f,
        (ff >> 4) & 0x01,
        ss & 0x0f,
        (ss >> 4) & 0x03,
        mm & 0x0f,
        (mm >> 4) & 0x03,
        hr & 0x0f,
        (hr >> 4) & 0x07,
    ]
}

fn send_full_frame(conn: &mut MidiOutputConnection, ms: u64, fps: u8) {
    let (hh, mm, ss, ff, code) = smpte_parts(ms, fps);
    let hr = (hh & 0x1f) | (code << 5);
    let msg = [0xF0, 0x7F, 0x7F, 0x01, 0x01, hr, mm, ss, ff, 0xF7];
    let _ = conn.send(&msg);
}

fn send_quarter_frame(conn: &mut MidiOutputConnection, ms: u64, fps: u8, index: u8) {
    let (hh, mm, ss, ff, code) = smpte_parts(ms, fps);
    let nibbles = mtc_nibbles(hh, mm, ss, ff, code);
    let i = (index % 8) as usize;
    let msg = [0xF1, (i as u8) << 4 | nibbles[i]];
    let _ = conn.send(&msg);
}

fn start_ticker(stop: Arc<AtomicBool>, inner: Arc<Mutex<MidiInner>>) {
    stop.store(false, Ordering::SeqCst);
    thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            let sleep_ms = {
                let Ok(mut g) = inner.lock() else {
                    break;
                };
                if !g.enabled || g.conn.is_none() {
                    drop(g);
                    thread::sleep(Duration::from_millis(40));
                    continue;
                }
                let fps = if g.fps == 0 { 30 } else { g.fps };
                let elapsed = g.pos_at.elapsed().as_millis() as u64;
                let ms = g.pos_ms.saturating_add(elapsed);
                let idx = g.qf_index;
                if let Some(conn) = g.conn.as_mut() {
                    send_quarter_frame(conn, ms, fps, idx);
                }
                g.qf_index = (idx + 1) % 8;
                (1000.0 / (f64::from(fps) * 4.0)).max(1.0) as u64
            };
            thread::sleep(Duration::from_millis(sleep_ms));
        }
    });
}

#[tauri::command]
pub fn midi_list_ports() -> Result<Vec<String>, String> {
    list_ports()
}

#[tauri::command]
pub fn midi_status(state: tauri::State<'_, MidiState>) -> Result<MidiStatus, String> {
    let g = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(MidiStatus {
        enabled: g.enabled,
        ports: list_ports().unwrap_or_default(),
        port_name: g.port_name.clone(),
        fps: g.fps,
        offset_ms: g.offset_ms,
    })
}

#[tauri::command]
pub fn midi_configure(
    state: tauri::State<'_, MidiState>,
    enabled: bool,
    port_name: Option<String>,
    fps: Option<u8>,
    offset_ms: Option<i64>,
) -> Result<(), String> {
    state.ticker_stop.store(true, Ordering::SeqCst);
    thread::sleep(Duration::from_millis(30));

    {
        let mut g = state.inner.lock().map_err(|e| e.to_string())?;
        g.enabled = enabled;
        g.port_name = port_name;
        if let Some(f) = fps {
            g.fps = f;
        }
        if let Some(o) = offset_ms {
            g.offset_ms = o;
        }
        g.conn = None;
        g.qf_index = 0;
        if enabled {
            let midi = MidiOutput::new("FLYBOX MTC").map_err(|e| e.to_string())?;
            let ports = midi.ports();
            let target = g.port_name.clone();
            let port = ports
                .iter()
                .find(|p| {
                    midi.port_name(p)
                        .ok()
                        .as_ref()
                        .map(|n| Some(n) == target.as_ref())
                        .unwrap_or(false)
                })
                .or_else(|| ports.first())
                .cloned()
                .ok_or_else(|| "没有可用的 MIDI 输出端口".to_string())?;
            let name = midi.port_name(&port).unwrap_or_else(|_| "MIDI".into());
            g.port_name = Some(name);
            g.conn = Some(
                midi.connect(&port, "FLYBOX MTC out")
                    .map_err(|e| format!("打开 MIDI 失败: {e}"))?,
            );
        }
    }

    if enabled {
        start_ticker(state.ticker_stop.clone(), state.inner.clone());
    }
    Ok(())
}

/// Call when BGM playhead updates. Sends full-frame lock; ticker continues QF.
#[tauri::command]
pub fn midi_send_position(state: tauri::State<'_, MidiState>, position_ms: u64) -> Result<(), String> {
    let mut g = state.inner.lock().map_err(|e| e.to_string())?;
    if !g.enabled {
        return Ok(());
    }
    let ms = (position_ms as i64 + g.offset_ms).max(0) as u64;
    let fps = g.fps;
    g.pos_ms = ms;
    g.pos_at = Instant::now();
    g.qf_index = 0;
    if let Some(conn) = g.conn.as_mut() {
        send_full_frame(conn, ms, fps);
    }
    Ok(())
}
