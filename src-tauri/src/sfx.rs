//! Live soundboard on BASS(+FX). Dual-lane: looping BGM + one-shot SFX.

mod engine {
    use crate::bass_ffi::{self, HSTREAM, BASS_ACTIVE_PAUSED, BASS_ACTIVE_PLAYING};
    use serde::{Deserialize, Serialize};
    use std::path::Path;
    use std::sync::mpsc::{self, RecvTimeoutError, Sender};
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, Instant};

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AudioDeviceInfo {
        pub name: String,
        pub is_default: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BgmStatus {
        pub path: Option<String>,
        pub playing: bool,
        pub paused: bool,
        pub position_ms: u64,
        pub duration_ms: Option<u64>,
        pub speed: f32,
        pub pitch: f32,
        pub fade_ms: u64,
        pub fading: bool,
        pub loop_mode: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RecordStatus {
        pub recording: bool,
        pub elapsed_ms: u64,
        pub peak: f32,
    }

    pub enum AudioCmd {
        PlaySfx {
            path: String,
            volume: f32,
            fade_ms: u64,
            fade_out_ms: u64,
            pitch: f32,
            range_start_ms: Option<u64>,
            range_end_ms: Option<u64>,
            /// Optional id so UI can live-adjust this voice (montage clip id).
            tag: Option<String>,
            reply: Sender<Result<(), String>>,
        },
        /// Update item gain for voices matching `tag` and apply immediately.
        SetSfxTaggedVolume {
            tag: String,
            volume: f32,
        },
        PlayBgm {
            path: String,
            volume: f32,
            reply: Sender<Result<(), String>>,
        },
        StopSfx,
        StopBgm {
            soft: bool,
        },
        StopAll,
        PauseBgm,
        ResumeBgm,
        SeekBgm {
            position_ms: u64,
        },
        SetDevice(Option<String>),
        SetMaster(f32),
        SetBgmVolume(f32),
        SetSfxVolume(f32),
        SetBgmSpeed(f32),
        SetBgmPitch(f32),
        SetFadeMs(u64),
        SetInterrupt(bool),
        SetDuck {
            enabled: bool,
            factor: f32,
        },
        SetVoiceDuck {
            enabled: bool,
            device: Option<String>,
            threshold: f32,
            attack_ms: u64,
            release_ms: u64,
            factor: f32,
        },
        SetLoopMode(String),
        SetPlaylist(Vec<String>),
        QueryBgm(Sender<BgmStatus>),
        BgmEndedCheck,
        RecordStart {
            device: Option<String>,
            reply: Sender<Result<(), String>>,
        },
        RecordStop {
            reply: Sender<Result<Vec<f32>, String>>,
        },
        QueryRecord(Sender<RecordStatus>),
        /// Stop everything and free BASS; audio thread exits after this.
        Shutdown,
    }

    struct SfxVoice {
        handle: HSTREAM,
        end_ms: Option<u64>,
        /// Per-clip gain before master/sfx bus.
        item_volume: f32,
        /// Ignore range-end checks briefly after start (seek settle).
        armed_at: Instant,
        fade_out_ms: u64,
        fade_out_started: bool,
        tag: Option<String>,
    }

    struct Player {
        device_index: i32,
        sfx: Vec<SfxVoice>,
        bgm: Option<HSTREAM>,
        bgm_path: Option<String>,
        bgm_item_volume: f32,
        bgm_duration_ms: Option<u64>,
        bgm_speed: f32,
        bgm_pitch: f32,
        master_volume: f32,
        bgm_volume: f32,
        sfx_volume: f32,
        interrupt: bool,
        duck_enabled: bool,
        duck_factor: f32,
        fade_ms: u64,
        fading_out: bool,
        loop_mode: String, // loopOne | loopList | shuffle
        playlist: Vec<String>,
        voice_duck_enabled: bool,
        voice_threshold: f32,
        voice_attack_ms: u64,
        voice_release_ms: u64,
        voice_factor: f32,
        voice_rec: Option<HSTREAM>,
        voice_open_until: Option<Instant>,
        sfx_duck_active: bool,
        file_rec: Option<HSTREAM>,
        file_rec_started: Option<Instant>,
        /// Input device name to restore after file recording.
        voice_device: Option<String>,
    }

    impl Player {
        fn new() -> Self {
            let _ = bass_ffi::init(-1, 44100);
            Self {
                device_index: -1,
                sfx: Vec::new(),
                bgm: None,
                bgm_path: None,
                bgm_item_volume: 1.0,
                bgm_duration_ms: None,
                bgm_speed: 1.0,
                bgm_pitch: 0.0,
                master_volume: 1.0,
                bgm_volume: 0.7,
                sfx_volume: 1.0,
                interrupt: true,
                duck_enabled: true,
                duck_factor: 0.28,
                fade_ms: 450,
                fading_out: false,
                loop_mode: "loopOne".into(),
                playlist: Vec::new(),
                voice_duck_enabled: false,
                voice_threshold: 0.08,
                voice_attack_ms: 80,
                voice_release_ms: 600,
                voice_factor: 0.22,
                voice_rec: None,
                voice_open_until: None,
                sfx_duck_active: false,
                file_rec: None,
                file_rec_started: None,
                voice_device: None,
            }
        }

        fn gain_bgm(&self) -> f32 {
            let mut duck = 1.0f32;
            if self.duck_enabled && self.sfx_duck_active {
                duck = duck.min(self.duck_factor);
            }
            if self.voice_duck_enabled {
                if let Some(until) = self.voice_open_until {
                    if Instant::now() < until {
                        duck = duck.min(self.voice_factor);
                    }
                }
            }
            (self.master_volume * self.bgm_volume * self.bgm_item_volume * duck).clamp(0.0, 1.0)
        }

        fn gain_sfx(&self, item_volume: f32) -> f32 {
            // Allow >1 so montage clip boost (e.g. +6dB) is audible in preview.
            (self.master_volume * self.sfx_volume * item_volume.clamp(0.0, 4.0)).clamp(0.0, 4.0)
        }

        fn apply_bgm_vol_now(&self) {
            if let Some(h) = self.bgm {
                bass_ffi::set_volume(h, self.gain_bgm());
            }
        }

        fn apply_sfx_vol_now(&self) {
            for s in &self.sfx {
                if bass_ffi::is_active(s.handle) != bass_ffi::BASS_ACTIVE_STOPPED {
                    bass_ffi::set_volume(s.handle, self.gain_sfx(s.item_volume));
                }
            }
        }

        fn apply_bgm_vol_slide(&self, ms: u32) {
            if let Some(h) = self.bgm {
                bass_ffi::slide_volume(h, self.gain_bgm(), ms);
            }
        }

        fn apply_tempo_pitch(&self) {
            if let Some(h) = self.bgm {
                // speed 1.0 -> tempo 0%; 1.25 -> +25%
                let tempo = (self.bgm_speed - 1.0) * 100.0;
                bass_ffi::set_tempo_percent(h, tempo);
                bass_ffi::set_pitch_semitones(h, self.bgm_pitch);
            }
        }

        fn hard_stop_bgm(&mut self) {
            if let Some(h) = self.bgm.take() {
                bass_ffi::stop(h);
            }
            self.bgm_path = None;
            self.bgm_duration_ms = None;
            self.fading_out = false;
        }

        /// Hard-stop all playback/recording and release the audio device.
        fn shutdown(&mut self) {
            self.stop_sfx();
            self.hard_stop_bgm();
            if let Some(h) = self.file_rec.take() {
                self.file_rec_started = None;
                let _ = bass_ffi::record_take_pcm();
                bass_ffi::record_stop(h);
            }
            if let Some(h) = self.voice_rec.take() {
                bass_ffi::record_stop(h);
            }
            bass_ffi::free();
        }

        fn open_sfx_stream(path: &Path, pitch: f32) -> Result<HSTREAM, String> {
            let h = if pitch.abs() > 0.01 {
                match bass_ffi::create_decode_stream(path, false) {
                    Ok(dec) => bass_ffi::tempo_create(dec)
                        .or_else(|_| bass_ffi::create_stream(path, false))?,
                    Err(_) => bass_ffi::create_stream(path, false)?,
                }
            } else {
                bass_ffi::create_stream(path, false)?
            };
            if pitch.abs() > 0.01 {
                bass_ffi::set_pitch_semitones(h, pitch);
            }
            Ok(h)
        }

        fn play_sfx(
            &mut self,
            path: &str,
            volume: f32,
            fade_ms: u64,
            fade_out_ms: u64,
            pitch: f32,
            range_start_ms: Option<u64>,
            range_end_ms: Option<u64>,
            tag: Option<String>,
        ) -> Result<(), String> {
            self.sfx
                .retain(|s| bass_ffi::is_active(s.handle) != bass_ffi::BASS_ACTIVE_STOPPED);
            if self.interrupt {
                for s in self.sfx.drain(..) {
                    bass_ffi::stop(s.handle);
                }
            }
            let h = Self::open_sfx_stream(Path::new(path), pitch)
                .map_err(|e| format!("无法播放（可尝试转码）：{e}"))?;
            let item_volume = volume.clamp(0.0, 4.0);
            let vol = self.gain_sfx(item_volume);
            // Seek before play. play(restart=true) would wipe the seek position.
            if let Some(start) = range_start_ms {
                if let Some(end) = range_end_ms {
                    if end <= start + 20 {
                        bass_ffi::stop(h);
                        return Err("裁剪区间太短".into());
                    }
                }
                bass_ffi::seek_ms(h, start).map_err(|e| format!("定位失败：{e}"))?;
            }
            if fade_ms > 0 {
                bass_ffi::set_volume(h, 0.0);
                let _ = bass_ffi::play(h, false);
                bass_ffi::slide_volume(h, vol, fade_ms as u32);
            } else {
                bass_ffi::set_volume(h, vol);
                let _ = bass_ffi::play(h, false);
            }
            self.sfx.push(SfxVoice {
                handle: h,
                end_ms: range_end_ms,
                item_volume,
                armed_at: Instant::now(),
                fade_out_ms,
                fade_out_started: false,
                tag,
            });
            self.sfx_duck_active = true;
            self.apply_bgm_vol_slide(80);
            Ok(())
        }

        fn set_tagged_volume(&mut self, tag: &str, volume: f32) {
            let item_volume = volume.clamp(0.0, 4.0);
            let vol = self.gain_sfx(item_volume);
            for s in &mut self.sfx {
                if s.tag.as_deref() != Some(tag) {
                    continue;
                }
                s.item_volume = item_volume;
                if bass_ffi::is_active(s.handle) != bass_ffi::BASS_ACTIVE_STOPPED {
                    bass_ffi::set_volume(s.handle, vol);
                }
            }
        }

        fn play_bgm(&mut self, path: &str, volume: f32) -> Result<(), String> {
            self.hard_stop_bgm();
            let p = Path::new(path);
            // loopOne: BASS 单曲循环；loopList/shuffle: 播完由 tick 切下一首
            let loop_it = self.loop_mode == "loopOne";
            let h = match bass_ffi::create_decode_stream(p, loop_it) {
                Ok(dec) => match bass_ffi::tempo_create(dec) {
                    Ok(h) => h,
                    Err(_) => bass_ffi::create_stream(p, loop_it)?,
                },
                Err(_) => bass_ffi::create_stream(p, loop_it)?,
            };

            self.bgm_item_volume = volume.clamp(0.0, 2.0);
            self.bgm_path = Some(path.to_string());
            self.bgm_duration_ms = bass_ffi::duration_ms(h);
            self.bgm = Some(h);
            self.apply_tempo_pitch();
            if self.fade_ms > 0 {
                bass_ffi::set_volume(h, 0.0);
                let _ = bass_ffi::play(h, true);
                bass_ffi::slide_volume(h, self.gain_bgm(), self.fade_ms as u32);
            } else {
                bass_ffi::set_volume(h, self.gain_bgm());
                let _ = bass_ffi::play(h, true);
            }
            Ok(())
        }

        fn rebuild_bgm_if_playing(&mut self) {
            if let Some(path) = self.bgm_path.clone() {
                let vol = self.bgm_item_volume;
                let pos = self.bgm.map(bass_ffi::position_ms).unwrap_or(0);
                let playing = self
                    .bgm
                    .map(|h| bass_ffi::is_active(h) == BASS_ACTIVE_PLAYING)
                    .unwrap_or(false);
                let paused = self
                    .bgm
                    .map(|h| bass_ffi::is_active(h) == BASS_ACTIVE_PAUSED)
                    .unwrap_or(false);
                if playing || paused {
                    if self.play_bgm(&path, vol).is_ok() {
                        if let Some(h) = self.bgm {
                            let _ = bass_ffi::seek_ms(h, pos);
                            if paused {
                                bass_ffi::pause(h);
                            }
                        }
                    }
                }
            }
        }

        fn stop_sfx(&mut self) {
            for s in self.sfx.drain(..) {
                bass_ffi::stop(s.handle);
            }
            self.sfx_duck_active = false;
            self.apply_bgm_vol_slide(120);
        }

        fn stop_bgm(&mut self, soft: bool) {
            if soft && self.fade_ms > 0 {
                if let Some(h) = self.bgm {
                    self.fading_out = true;
                    bass_ffi::slide_volume(h, 0.0, self.fade_ms as u32);
                    return;
                }
            }
            self.hard_stop_bgm();
        }

        fn set_device_by_name(&mut self, name: Option<&str>) {
            let devices = bass_ffi::list_output_devices().unwrap_or_default();
            let idx = if let Some(n) = name {
                devices
                    .iter()
                    .find(|d| d.name == n)
                    .map(|d| d.index)
                    .unwrap_or(-1)
            } else {
                devices
                    .iter()
                    .find(|d| d.is_default)
                    .map(|d| d.index)
                    .unwrap_or(-1)
            };
            let resume = self.bgm_path.clone();
            let vol = self.bgm_item_volume;
            self.hard_stop_bgm();
            self.stop_sfx();
            bass_ffi::free();
            let _ = bass_ffi::init(idx, 44100);
            self.device_index = idx;
            if let Some(p) = resume {
                let _ = self.play_bgm(&p, vol);
            }
        }

        fn ensure_voice_rec(&mut self, device_name: Option<&str>) {
            if let Some(n) = device_name {
                self.voice_device = Some(n.to_string());
            }
            if !self.voice_duck_enabled || self.file_rec.is_some() {
                if let Some(h) = self.voice_rec.take() {
                    bass_ffi::record_stop(h);
                }
                return;
            }
            if self.voice_rec.is_some() {
                return;
            }
            let devices = bass_ffi::list_input_devices().unwrap_or_default();
            let name = device_name.or(self.voice_device.as_deref());
            let idx = name
                .and_then(|n| devices.iter().find(|d| d.name == n).map(|d| d.index))
                .or_else(|| devices.iter().find(|d| d.is_default).map(|d| d.index))
                .unwrap_or(-1);
            if bass_ffi::record_init(idx).is_ok() {
                if let Ok(h) = bass_ffi::record_start_monitor() {
                    self.voice_rec = Some(h);
                }
            }
        }

        fn start_file_rec(&mut self, device_name: Option<&str>) -> Result<(), String> {
            if self.file_rec.is_some() {
                return Err("已在录音中".into());
            }
            // Yield voice-duck monitor so we can own BASS_Record*
            if let Some(h) = self.voice_rec.take() {
                bass_ffi::record_stop(h);
            }
            let devices = bass_ffi::list_input_devices().unwrap_or_default();
            let idx = device_name
                .and_then(|n| devices.iter().find(|d| d.name == n).map(|d| d.index))
                .or_else(|| {
                    self.voice_device
                        .as_deref()
                        .and_then(|n| devices.iter().find(|d| d.name == n).map(|d| d.index))
                })
                .or_else(|| devices.iter().find(|d| d.is_default).map(|d| d.index))
                .unwrap_or(-1);
            bass_ffi::record_init(idx)?;
            let h = bass_ffi::record_start_capture()?;
            self.file_rec = Some(h);
            self.file_rec_started = Some(Instant::now());
            Ok(())
        }

        fn stop_file_rec(&mut self) -> Result<Vec<f32>, String> {
            let Some(h) = self.file_rec.take() else {
                return Err("当前没有在录音".into());
            };
            self.file_rec_started = None;
            // Drain callback buffer before freeing the device.
            let pcm = bass_ffi::record_take_pcm();
            bass_ffi::record_stop(h);
            // Restore voice duck monitor if still enabled.
            self.ensure_voice_rec(self.voice_device.clone().as_deref());
            if pcm.is_empty() {
                return Err("录音为空（请检查输入设备）".into());
            }
            Ok(pcm)
        }

        fn record_status(&self) -> RecordStatus {
            let recording = self.file_rec.is_some();
            let elapsed_ms = self
                .file_rec_started
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);
            let peak = if recording {
                bass_ffi::record_peak_take()
            } else {
                0.0
            };
            RecordStatus {
                recording,
                elapsed_ms,
                peak,
            }
        }

        fn tick(&mut self) {
            // range end + optional fade-out for sfx
            self.sfx.retain_mut(|s| {
                let active = bass_ffi::is_active(s.handle) != bass_ffi::BASS_ACTIVE_STOPPED;
                if active {
                    if let Some(end) = s.end_ms {
                        // Give seek/play a moment to settle before enforcing the out-point.
                        if s.armed_at.elapsed() < Duration::from_millis(50) {
                            return true;
                        }
                        let pos = bass_ffi::position_ms(s.handle);
                        if s.fade_out_ms > 0 && !s.fade_out_started {
                            let start_fo = end.saturating_sub(s.fade_out_ms);
                            if pos >= start_fo {
                                let remain = end.saturating_sub(pos).max(1) as u32;
                                bass_ffi::slide_volume(s.handle, 0.0, remain);
                                s.fade_out_started = true;
                            }
                        }
                        if pos >= end {
                            bass_ffi::stop(s.handle);
                            return false;
                        }
                    }
                }
                active
            });
            let sfx_on = !self.sfx.is_empty();
            if sfx_on != self.sfx_duck_active {
                self.sfx_duck_active = sfx_on;
                self.apply_bgm_vol_slide(100);
            }

            if self.voice_duck_enabled && self.file_rec.is_none() {
                let peak = bass_ffi::record_peak_take();
                if peak >= self.voice_threshold {
                    self.voice_open_until =
                        Some(Instant::now() + Duration::from_millis(self.voice_release_ms.max(50)));
                    self.apply_bgm_vol_slide(self.voice_attack_ms.min(500) as u32);
                } else if self.voice_open_until.map(|t| Instant::now() >= t).unwrap_or(false) {
                    self.voice_open_until = None;
                    self.apply_bgm_vol_slide(200);
                }
            }

            if self.fading_out {
                if let Some(h) = self.bgm {
                    if !bass_ffi::is_sliding_vol(h)
                        || bass_ffi::is_active(h) == bass_ffi::BASS_ACTIVE_STOPPED
                    {
                        self.hard_stop_bgm();
                    }
                } else {
                    self.fading_out = false;
                }
            }

            // playlist advance when not looping single forever via BASS loop —
            // for loopList we disable bass loop and chain; currently streams loop via flag.
            // When loopList: if near end, jump next — handled in status poll via ended.
            if self.loop_mode == "loopList" || self.loop_mode == "shuffle" {
                if let Some(h) = self.bgm {
                    if let Some(dur) = self.bgm_duration_ms {
                        let pos = bass_ffi::position_ms(h);
                        if dur > 200 && pos + 120 >= dur && bass_ffi::is_active(h) == BASS_ACTIVE_PLAYING
                        {
                            if let Some(cur) = self.bgm_path.clone() {
                                if let Some(i) = self.playlist.iter().position(|p| p == &cur) {
                                    let len = self.playlist.len();
                                    if len > 0 {
                                        let next_i = if self.loop_mode == "shuffle" && len > 1 {
                                            let seed = std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .map(|d| d.as_nanos() as usize)
                                                .unwrap_or(0);
                                            let mut n = seed % len;
                                            if n == i {
                                                n = (n + 1) % len;
                                            }
                                            n
                                        } else {
                                            (i + 1) % len
                                        };
                                        let next = self.playlist[next_i].clone();
                                        let vol = self.bgm_item_volume;
                                        let _ = self.play_bgm(&next, vol);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        fn status(&self) -> BgmStatus {
            let playing = self
                .bgm
                .map(|h| bass_ffi::is_active(h) == BASS_ACTIVE_PLAYING)
                .unwrap_or(false);
            let paused = self
                .bgm
                .map(|h| bass_ffi::is_active(h) == BASS_ACTIVE_PAUSED)
                .unwrap_or(false);
            let position_ms = self.bgm.map(bass_ffi::position_ms).unwrap_or(0);
            BgmStatus {
                path: self.bgm_path.clone(),
                playing,
                paused,
                position_ms,
                duration_ms: self.bgm_duration_ms,
                speed: self.bgm_speed,
                pitch: self.bgm_pitch,
                fade_ms: self.fade_ms,
                fading: self.fading_out
                    || self
                        .bgm
                        .map(bass_ffi::is_sliding_vol)
                        .unwrap_or(false),
                loop_mode: self.loop_mode.clone(),
            }
        }
    }

    pub struct SfxState {
        tx: Mutex<Option<Sender<AudioCmd>>>,
        join: Mutex<Option<thread::JoinHandle<()>>>,
    }

    impl Default for SfxState {
        fn default() -> Self {
            let (tx, rx) = mpsc::channel::<AudioCmd>();
            let join = thread::spawn(move || {
                let mut player = Player::new();
                loop {
                    match rx.recv_timeout(Duration::from_millis(40)) {
                        Ok(cmd) => match cmd {
                            AudioCmd::Shutdown => {
                                player.shutdown();
                                break;
                            }
                            AudioCmd::SetDevice(name) => {
                                player.set_device_by_name(name.as_deref());
                            }
                            AudioCmd::SetMaster(v) => {
                                player.master_volume = v.clamp(0.0, 1.5);
                                player.apply_bgm_vol_now();
                                player.apply_sfx_vol_now();
                            }
                            AudioCmd::SetBgmVolume(v) => {
                                player.bgm_volume = v.clamp(0.0, 1.5);
                                player.apply_bgm_vol_now();
                            }
                            AudioCmd::SetSfxVolume(v) => {
                                player.sfx_volume = v.clamp(0.0, 1.5);
                                player.apply_sfx_vol_now();
                            }
                            AudioCmd::SetBgmSpeed(v) => {
                                player.bgm_speed = v.clamp(0.5, 2.0);
                                player.apply_tempo_pitch();
                            }
                            AudioCmd::SetBgmPitch(v) => {
                                player.bgm_pitch = v.clamp(-12.0, 12.0);
                                player.apply_tempo_pitch();
                            }
                            AudioCmd::SetFadeMs(ms) => player.fade_ms = ms.min(5000),
                            AudioCmd::SetInterrupt(v) => player.interrupt = v,
                            AudioCmd::SetDuck { enabled, factor } => {
                                player.duck_enabled = enabled;
                                player.duck_factor = factor.clamp(0.05, 1.0);
                                player.apply_bgm_vol_slide(80);
                            }
                            AudioCmd::SetVoiceDuck {
                                enabled,
                                device,
                                threshold,
                                attack_ms,
                                release_ms,
                                factor,
                            } => {
                                player.voice_duck_enabled = enabled;
                                player.voice_threshold = threshold.clamp(0.01, 1.0);
                                player.voice_attack_ms = attack_ms;
                                player.voice_release_ms = release_ms;
                                player.voice_factor = factor.clamp(0.05, 1.0);
                                if let Some(ref d) = device {
                                    player.voice_device = Some(d.clone());
                                }
                                if player.file_rec.is_none() {
                                    if let Some(h) = player.voice_rec.take() {
                                        bass_ffi::record_stop(h);
                                    }
                                    player.ensure_voice_rec(device.as_deref());
                                }
                            }
                            AudioCmd::SetLoopMode(m) => {
                                if player.loop_mode != m {
                                    player.loop_mode = m;
                                    player.rebuild_bgm_if_playing();
                                }
                            }
                            AudioCmd::SetPlaylist(p) => player.playlist = p,
                            AudioCmd::StopSfx => player.stop_sfx(),
                            AudioCmd::StopBgm { soft } => player.stop_bgm(soft),
                            AudioCmd::StopAll => {
                                player.stop_sfx();
                                player.hard_stop_bgm();
                            }
                            AudioCmd::PauseBgm => {
                                if let Some(h) = player.bgm {
                                    bass_ffi::pause(h);
                                }
                            }
                            AudioCmd::ResumeBgm => {
                                if let Some(h) = player.bgm {
                                    let _ = bass_ffi::play(h, false);
                                }
                            }
                            AudioCmd::SeekBgm { position_ms } => {
                                if let Some(h) = player.bgm {
                                    let _ = bass_ffi::seek_ms(h, position_ms);
                                }
                            }
                            AudioCmd::PlaySfx {
                                path,
                                volume,
                                fade_ms,
                                fade_out_ms,
                                pitch,
                                range_start_ms,
                                range_end_ms,
                                tag,
                                reply,
                            } => {
                                let r = player.play_sfx(
                                    &path,
                                    volume,
                                    fade_ms,
                                    fade_out_ms,
                                    pitch,
                                    range_start_ms,
                                    range_end_ms,
                                    tag,
                                );
                                let _ = reply.send(r);
                            }
                            AudioCmd::SetSfxTaggedVolume { tag, volume } => {
                                player.set_tagged_volume(&tag, volume);
                            }
                            AudioCmd::PlayBgm { path, volume, reply } => {
                                let r = player
                                    .play_bgm(&path, volume)
                                    .map_err(|e| format!("无法播放（可尝试转码）：{e}"));
                                let _ = reply.send(r);
                            }
                            AudioCmd::QueryBgm(reply) => {
                                let _ = reply.send(player.status());
                            }
                            AudioCmd::BgmEndedCheck => {}
                            AudioCmd::RecordStart { device, reply } => {
                                let r = player.start_file_rec(device.as_deref());
                                let _ = reply.send(r);
                            }
                            AudioCmd::RecordStop { reply } => {
                                let r = player.stop_file_rec();
                                let _ = reply.send(r);
                            }
                            AudioCmd::QueryRecord(reply) => {
                                let _ = reply.send(player.record_status());
                            }
                        },
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => {
                            player.shutdown();
                            break;
                        }
                    }
                    player.tick();
                }
            });
            Self {
                tx: Mutex::new(Some(tx)),
                join: Mutex::new(Some(join)),
            }
        }
    }

    impl SfxState {
        pub fn send(&self, cmd: AudioCmd) -> Result<(), String> {
            let guard = self.tx.lock().map_err(|e| e.to_string())?;
            let tx = guard.as_ref().ok_or_else(|| "音频引擎已关闭".to_string())?;
            tx.send(cmd).map_err(|e| e.to_string())
        }

        /// Stop audio and join the engine thread. Safe to call more than once.
        pub fn shutdown(&self) {
            if let Ok(mut guard) = self.tx.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(AudioCmd::Shutdown);
                    drop(tx);
                }
            }
            if let Ok(mut join) = self.join.lock() {
                if let Some(handle) = join.take() {
                    let _ = handle.join();
                }
            }
        }
    }

    pub use AudioCmd::*;
}

pub use engine::{AudioDeviceInfo, AudioCmd, BgmStatus, RecordStatus, SfxState};

use crate::ffmpeg_util;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const AUDIO_EXTS: &[&str] = &[
    "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus", "webm", "aiff", "ape", "ac3", "mka",
];

/// Formats that usually need FFmpeg before BASS can play reliably.
const TRANSCODE_ON_IMPORT: &[&str] = &["ape", "ac3", "mka", "aiff"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SfxEntry {
    pub path: String,
    pub name: String,
    pub category: String,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryIndexEntry {
    path: String,
    mtime: u64,
    name: String,
    category: String,
    duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LibraryIndex {
    entries: Vec<LibraryIndexEntry>,
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

fn stem_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio")
        .to_string()
}

fn file_mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn library_index_path(root: &Path) -> PathBuf {
    root.join("library-index.json")
}

fn load_library_index(root: &Path) -> LibraryIndex {
    let p = library_index_path(root);
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_library_index(root: &Path, index: &LibraryIndex) {
    let p = library_index_path(root);
    if let Ok(s) = serde_json::to_string_pretty(index) {
        let _ = fs::write(p, s);
    }
}

fn update_index_duration(path: &Path, duration_ms: Option<u64>) {
    let Some(duration_ms) = duration_ms else { return };
    let path_s = path.to_string_lossy();
    let mut dir = path.parent();
    while let Some(root) = dir {
        let idx_path = library_index_path(root);
        if idx_path.is_file() {
            let mut index = load_library_index(root);
            let mut changed = false;
            for e in &mut index.entries {
                if e.path == path_s {
                    if e.duration_ms != Some(duration_ms) {
                        e.duration_ms = Some(duration_ms);
                        changed = true;
                    }
                    break;
                }
            }
            if changed {
                save_library_index(root, &index);
            }
            return;
        }
        dir = root.parent();
    }
}

#[tauri::command]
pub fn sfx_list_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let _ = crate::bass_ffi::init(-1, 44100);
    Ok(crate::bass_ffi::list_output_devices()?
        .into_iter()
        .filter(|d| d.enabled && d.index >= 0)
        .map(|d| AudioDeviceInfo {
            name: d.name,
            is_default: d.is_default,
        })
        .collect())
}

#[tauri::command]
pub fn sfx_list_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let _ = crate::bass_ffi::init(-1, 44100);
    Ok(crate::bass_ffi::list_input_devices()?
        .into_iter()
        .filter(|d| d.enabled)
        .map(|d| AudioDeviceInfo {
            name: d.name,
            is_default: d.is_default,
        })
        .collect())
}

#[tauri::command]
pub fn sfx_set_device(state: tauri::State<'_, SfxState>, name: Option<String>) -> Result<(), String> {
    state.send(AudioCmd::SetDevice(name))
}

#[tauri::command]
pub fn sfx_set_master_volume(state: tauri::State<'_, SfxState>, volume: f32) -> Result<(), String> {
    state.send(AudioCmd::SetMaster(volume))
}

#[tauri::command]
pub fn sfx_set_bgm_volume(state: tauri::State<'_, SfxState>, volume: f32) -> Result<(), String> {
    state.send(AudioCmd::SetBgmVolume(volume))
}

#[tauri::command]
pub fn sfx_set_sfx_volume(state: tauri::State<'_, SfxState>, volume: f32) -> Result<(), String> {
    state.send(AudioCmd::SetSfxVolume(volume))
}

#[tauri::command]
pub fn sfx_set_bgm_speed(state: tauri::State<'_, SfxState>, speed: f32) -> Result<(), String> {
    state.send(AudioCmd::SetBgmSpeed(speed))
}

#[tauri::command]
pub fn sfx_set_bgm_pitch(state: tauri::State<'_, SfxState>, pitch: f32) -> Result<(), String> {
    state.send(AudioCmd::SetBgmPitch(pitch))
}

#[tauri::command]
pub fn sfx_set_fade_ms(state: tauri::State<'_, SfxState>, fade_ms: u64) -> Result<(), String> {
    state.send(AudioCmd::SetFadeMs(fade_ms))
}

#[tauri::command]
pub fn sfx_set_interrupt(state: tauri::State<'_, SfxState>, interrupt: bool) -> Result<(), String> {
    state.send(AudioCmd::SetInterrupt(interrupt))
}

#[tauri::command]
pub fn sfx_set_duck(
    state: tauri::State<'_, SfxState>,
    enabled: bool,
    factor: f32,
) -> Result<(), String> {
    state.send(AudioCmd::SetDuck { enabled, factor })
}

#[tauri::command]
pub fn sfx_set_voice_duck(
    state: tauri::State<'_, SfxState>,
    enabled: bool,
    device: Option<String>,
    threshold: f32,
    attack_ms: u64,
    release_ms: u64,
    factor: f32,
) -> Result<(), String> {
    state.send(AudioCmd::SetVoiceDuck {
        enabled,
        device,
        threshold,
        attack_ms,
        release_ms,
        factor,
    })
}

#[tauri::command]
pub fn sfx_set_loop_mode(state: tauri::State<'_, SfxState>, mode: String) -> Result<(), String> {
    state.send(AudioCmd::SetLoopMode(mode))
}

#[tauri::command]
pub fn sfx_set_playlist(state: tauri::State<'_, SfxState>, paths: Vec<String>) -> Result<(), String> {
    state.send(AudioCmd::SetPlaylist(paths))
}

#[tauri::command]
pub fn sfx_stop_all(state: tauri::State<'_, SfxState>) -> Result<(), String> {
    state.send(AudioCmd::StopAll)
}

#[tauri::command]
pub fn sfx_stop_sfx(state: tauri::State<'_, SfxState>) -> Result<(), String> {
    state.send(AudioCmd::StopSfx)
}

#[tauri::command]
pub fn sfx_stop_bgm(state: tauri::State<'_, SfxState>) -> Result<(), String> {
    state.send(AudioCmd::StopBgm { soft: true })
}

#[tauri::command]
pub fn sfx_pause_bgm(state: tauri::State<'_, SfxState>) -> Result<(), String> {
    state.send(AudioCmd::PauseBgm)
}

#[tauri::command]
pub fn sfx_resume_bgm(state: tauri::State<'_, SfxState>) -> Result<(), String> {
    state.send(AudioCmd::ResumeBgm)
}

#[tauri::command]
pub fn sfx_seek_bgm(state: tauri::State<'_, SfxState>, position_ms: u64) -> Result<(), String> {
    state.send(AudioCmd::SeekBgm { position_ms })
}

#[tauri::command]
pub fn sfx_play(
    state: tauri::State<'_, SfxState>,
    path: String,
    volume: f32,
    fade_ms: Option<u64>,
    fade_out_ms: Option<u64>,
    pitch: Option<f32>,
    range_start_ms: Option<u64>,
    range_end_ms: Option<u64>,
    tag: Option<String>,
) -> Result<(), String> {
    if !PathBuf::from(&path).is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let (tx, rx) = mpsc::channel();
    state.send(AudioCmd::PlaySfx {
        path,
        volume,
        fade_ms: fade_ms.unwrap_or(40),
        fade_out_ms: fade_out_ms.unwrap_or(0),
        pitch: pitch.unwrap_or(0.0),
        range_start_ms,
        range_end_ms,
        tag,
        reply: tx,
    })?;
    rx.recv_timeout(Duration::from_millis(2500))
        .map_err(|_| "播放超时".to_string())?
}

#[tauri::command]
pub fn sfx_set_tagged_volume(
    state: tauri::State<'_, SfxState>,
    tag: String,
    volume: f32,
) -> Result<(), String> {
    state.send(AudioCmd::SetSfxTaggedVolume { tag, volume })
}

#[tauri::command]
pub fn sfx_play_bgm(
    state: tauri::State<'_, SfxState>,
    path: String,
    volume: f32,
) -> Result<(), String> {
    if !PathBuf::from(&path).is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let (tx, rx) = mpsc::channel();
    state.send(AudioCmd::PlayBgm {
        path,
        volume,
        reply: tx,
    })?;
    rx.recv_timeout(Duration::from_millis(4000))
        .map_err(|_| "播放超时".to_string())?
}

#[tauri::command]
pub fn sfx_bgm_status(state: tauri::State<'_, SfxState>) -> Result<BgmStatus, String> {
    let (tx, rx) = mpsc::channel();
    state.send(AudioCmd::QueryBgm(tx))?;
    rx.recv_timeout(Duration::from_millis(500))
        .map_err(|_| "读取音乐状态超时".to_string())
}

#[tauri::command]
pub fn sfx_probe(path: String) -> Result<ffmpeg_util::ProbeInfo, String> {
    let info = ffmpeg_util::probe(Path::new(&path))?;
    update_index_duration(Path::new(&path), info.duration_ms);
    Ok(info)
}

#[tauri::command]
pub fn sfx_transcode(path: String, dest: Option<String>) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let dest = dest.map(PathBuf::from).unwrap_or_else(|| {
        let mut d = src.clone();
        d.set_extension("mp3");
        if d == src {
            d = src.with_extension("converted.mp3");
        }
        d
    });
    ffmpeg_util::transcode_to_mp3(&src, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn sfx_waveform(path: String, buckets: Option<usize>) -> Result<Vec<f32>, String> {
    ffmpeg_util::waveform_peaks(Path::new(&path), buckets.unwrap_or(64))
}

#[tauri::command]
pub fn sfx_scan_library(root: String) -> Result<Vec<SfxEntry>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("曲库文件夹不存在".into());
    }
    let prev = load_library_index(&root);
    let by_path: std::collections::HashMap<String, &LibraryIndexEntry> = prev
        .entries
        .iter()
        .map(|e| (e.path.clone(), e))
        .collect();

    let mut scanned: Vec<(PathBuf, String)> = Vec::new();
    for ent in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        let path = ent.path();
        if path.is_file() && is_audio(&path) {
            scanned.push((path, "未分类".into()));
        }
    }
    for ent in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if name.starts_with('.') || name.eq_ignore_ascii_case("library-index.json") {
            continue;
        }
        let cat = if name.is_empty() {
            "未分类".into()
        } else {
            name.to_string()
        };
        for file in fs::read_dir(&path).map_err(|e| e.to_string())? {
            let file = file.map_err(|e| e.to_string())?;
            let fp = file.path();
            if fp.is_file() && is_audio(&fp) {
                scanned.push((fp, cat.clone()));
            }
        }
    }

    let mut index = LibraryIndex {
        entries: Vec::with_capacity(scanned.len()),
    };
    let mut entries = Vec::with_capacity(scanned.len());
    let mut probe_budget = 48usize;
    for (path, category) in scanned {
        let path_s = path.to_string_lossy().into_owned();
        let mtime = file_mtime_secs(&path);
        let name = stem_name(&path);
        let mut duration_ms = by_path
            .get(&path_s)
            .filter(|e| e.mtime == mtime)
            .and_then(|e| e.duration_ms);
        if duration_ms.is_none() && probe_budget > 0 {
            if let Ok(info) = ffmpeg_util::probe(&path) {
                duration_ms = info.duration_ms;
            }
            probe_budget = probe_budget.saturating_sub(1);
        }
        index.entries.push(LibraryIndexEntry {
            path: path_s.clone(),
            mtime,
            name: name.clone(),
            category: category.clone(),
            duration_ms,
        });
        entries.push(SfxEntry {
            path: path_s,
            name,
            category,
            duration_ms,
        });
    }
    entries.sort_by(|a, b| {
        a.category
            .cmp(&b.category)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    save_library_index(&root, &index);
    Ok(entries)
}

#[tauri::command]
pub fn sfx_import_files(
    library_root: String,
    category: String,
    files: Vec<String>,
) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("请先选择曲库文件夹".into());
    }
    let cat = category.trim();
    let dest_dir = if cat.is_empty() || cat == "未分类" {
        root.clone()
    } else {
        let d = root.join(cat);
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        d
    };
    let mut imported = Vec::new();
    for src in files {
        let src_path = PathBuf::from(&src);
        if !src_path.is_file() || !is_audio(&src_path) {
            continue;
        }
        let stem = src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let ext = src_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("mp3")
            .to_ascii_lowercase();
        let force_tc = TRANSCODE_ON_IMPORT.iter().any(|x| x.eq_ignore_ascii_case(&ext));
        let probe = ffmpeg_util::probe(&src_path);
        let need_tc = force_tc || probe.is_err();

        let mut dest = if need_tc {
            dest_dir.join(format!("{stem}.mp3"))
        } else {
            dest_dir.join(src_path.file_name().unwrap())
        };
        if dest.exists() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            dest = if need_tc {
                dest_dir.join(format!("{stem}_{ts}.mp3"))
            } else {
                dest_dir.join(format!("{stem}_{ts}.{ext}"))
            };
        }

        if need_tc {
            ffmpeg_util::transcode_to_mp3(&src_path, &dest)?;
        } else {
            fs::copy(&src_path, &dest).map_err(|e| e.to_string())?;
        }
        if let Ok(info) = ffmpeg_util::probe(&dest) {
            update_index_duration(&dest, info.duration_ms);
        } else if let Ok(info) = probe {
            update_index_duration(&dest, info.duration_ms);
        }
        imported.push(dest.to_string_lossy().into_owned());
    }
    Ok(imported)
}

#[tauri::command]
pub fn sfx_delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("文件不存在".into());
    }
    fs::remove_file(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sfx_category_create(library_root: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("分类名无效".into());
    }
    let dir = PathBuf::from(library_root).join(name);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sfx_category_rename(
    library_root: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("分类名无效".into());
    }
    let root = PathBuf::from(library_root);
    let from = root.join(&old_name);
    let to = root.join(new_name);
    if !from.is_dir() {
        return Err("原分类不存在".into());
    }
    if to.exists() {
        return Err("目标分类已存在".into());
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sfx_category_delete(library_root: String, name: String) -> Result<(), String> {
    let dir = PathBuf::from(library_root).join(&name);
    if !dir.is_dir() {
        return Err("分类不存在".into());
    }
    fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sfx_move_file(path: String, library_root: String, category: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let root = PathBuf::from(library_root);
    let dest_dir = if category.is_empty() || category == "未分类" {
        root
    } else {
        let d = root.join(&category);
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        d
    };
    let dest = dest_dir.join(src.file_name().unwrap());
    fs::rename(&src, &dest).or_else(|_| {
        fs::copy(&src, &dest).and_then(|_| fs::remove_file(&src))
    }).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn sfx_record_start(
    state: tauri::State<'_, SfxState>,
    device_name: Option<String>,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    state.send(AudioCmd::RecordStart {
        device: device_name,
        reply: tx,
    })?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "录音启动超时".to_string())?
}

#[tauri::command]
pub fn sfx_record_stop(
    state: tauri::State<'_, SfxState>,
    library_root: String,
    category: String,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel();
    state.send(AudioCmd::RecordStop { reply: tx })?;
    let pcm = rx
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "停止录音超时".to_string())??;

    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("请先选择曲库文件夹".into());
    }
    let cat = category.trim();
    let dest_dir = if cat.is_empty() || cat == "未分类" || cat == "__recent__" {
        root.clone()
    } else {
        let d = root.join(cat);
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        d
    };
    let ts = chrono_stamp();
    let mut dest = dest_dir.join(format!("录制_{ts}.wav"));
    if dest.exists() {
        dest = dest_dir.join(format!("录制_{ts}_{}.wav", pcm.len() % 997));
    }
    crate::bass_ffi::write_wav_f32(&dest, &pcm, 44100, 2)?;
    if let Ok(info) = ffmpeg_util::probe(&dest) {
        update_index_duration(&dest, info.duration_ms);
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn sfx_record_status(state: tauri::State<'_, SfxState>) -> Result<RecordStatus, String> {
    let (tx, rx) = mpsc::channel();
    state.send(AudioCmd::QueryRecord(tx))?;
    rx.recv_timeout(Duration::from_millis(800))
        .map_err(|_| "读取录音状态超时".to_string())
}

fn chrono_stamp() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Local-ish YYYYMMDD_HHMMSS via offset-naive UTC+8 for China users
    let total = secs as i64 + 8 * 3600;
    let days = total / 86400;
    let tod = (total % 86400) as u32;
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}{m:02}{d:02}_{hh:02}{mm:02}{ss:02}")
}

/// Howard Hinnant civil_from_days (proleptic Gregorian).
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

#[tauri::command]
pub fn sfx_export_range(
    path: String,
    start_ms: u64,
    end_ms: u64,
    dest: Option<String>,
    fade_in_ms: Option<u64>,
    fade_out_ms: Option<u64>,
    library_root: Option<String>,
    category: Option<String>,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    if end_ms <= start_ms + 20 {
        return Err("裁剪区间太短".into());
    }
    let fade_in = fade_in_ms.unwrap_or(0).min(30_000);
    let fade_out = fade_out_ms.unwrap_or(0).min(30_000);
    let out = if let Some(d) = dest {
        PathBuf::from(d)
    } else if let Some(root) = library_root.filter(|s| !s.trim().is_empty()) {
        let root = PathBuf::from(root);
        if !root.is_dir() {
            return Err("曲库文件夹无效".into());
        }
        let cat = category
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "未分类" && *s != "__recent__")
            .unwrap_or("我制作的");
        let parent = root.join(cat);
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let stem = stem_name(&src);
        let mut p = parent.join(format!("{stem}_裁剪.wav"));
        if p.exists() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            p = parent.join(format!("{stem}_裁剪_{ts}.wav"));
        }
        p
    } else {
        let parent = src.parent().unwrap_or_else(|| Path::new("."));
        let stem = stem_name(&src);
        let mut p = parent.join(format!("{stem}_裁剪.wav"));
        if p.exists() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            p = parent.join(format!("{stem}_裁剪_{ts}.wav"));
        }
        p
    };
    ffmpeg_util::export_range(&src, start_ms, end_ms, &out, fade_in, fade_out, 1.0)?;
    if let Ok(info) = ffmpeg_util::probe(&out) {
        update_index_duration(&out, info.duration_ms);
    }
    Ok(out.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MontageClipIn {
    pub path: String,
    /// Trim start inside source file.
    pub start_ms: u64,
    /// Trim end inside source file.
    pub end_ms: u64,
    /// Where this clip starts on the shared timeline (ms).
    pub timeline_ms: u64,
    pub fade_in_ms: Option<u64>,
    pub fade_out_ms: Option<u64>,
    /// Linear gain (1.0 = 0dB). Optional for older callers.
    pub volume: Option<f32>,
}

/// Cut each clip, place on a shared timeline (adelay), then amix to one WAV.
/// If `dest` is set, write there; otherwise save under library `category` (default「我制作的」).
#[tauri::command]
pub fn sfx_export_montage(
    clips: Vec<MontageClipIn>,
    library_root: String,
    category: Option<String>,
    dest: Option<String>,
) -> Result<String, String> {
    if clips.is_empty() {
        return Err("请先在时间线上放至少一段素材".into());
    }
    if clips.len() > 40 {
        return Err("一次最多混音 40 段".into());
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let planned_out = if let Some(d) = dest.filter(|s| !s.trim().is_empty()) {
        let p = PathBuf::from(d);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        p
    } else {
        let root = PathBuf::from(&library_root);
        if !root.is_dir() {
            return Err("曲库文件夹无效".into());
        }
        let cat = category
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "未分类" && *s != "__recent__")
            .unwrap_or("我制作的");
        let parent = root.join(cat);
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let mut out = parent.join(format!("混剪_{ts}.wav"));
        if out.exists() {
            out = parent.join(format!("混剪_{ts}_{}.wav", clips.len()));
        }
        out
    };

    let tmp_dir = std::env::temp_dir().join(format!("flyphoto_montage_{ts}"));
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let result = (|| -> Result<PathBuf, String> {
        let mut parts: Vec<(PathBuf, u64)> = Vec::with_capacity(clips.len());
        for (i, c) in clips.iter().enumerate() {
            let src = PathBuf::from(&c.path);
            if !src.is_file() {
                return Err(format!("片段不存在：{}", c.path));
            }
            if c.end_ms <= c.start_ms + 20 {
                return Err(format!("第 {} 段裁剪区间太短", i + 1));
            }
            let part = tmp_dir.join(format!("part_{i:02}.wav"));
            ffmpeg_util::export_range(
                &src,
                c.start_ms,
                c.end_ms,
                &part,
                c.fade_in_ms.unwrap_or(0).min(30_000),
                c.fade_out_ms.unwrap_or(0).min(30_000),
                c.volume.unwrap_or(1.0).clamp(0.0, 8.0),
            )?;
            parts.push((part, c.timeline_ms.min(3_600_000)));
        }
        let mut out = planned_out;
        if out.exists() {
            let stem = out
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("混剪")
                .to_string();
            let parent = out.parent().unwrap_or_else(|| Path::new("."));
            out = parent.join(format!("{stem}_{}.wav", parts.len()));
        }
        ffmpeg_util::mix_timeline(&parts, &out)?;
        if let Ok(info) = ffmpeg_util::probe(&out) {
            update_index_duration(&out, info.duration_ms);
        }
        Ok(out)
    })();

    let _ = fs::remove_dir_all(&tmp_dir);
    let out = result?;
    Ok(out.to_string_lossy().into_owned())
}
