import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { load } from "@tauri-apps/plugin-store";
import {
  register,
  unregister,
  unregisterAll,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import {
  Clapperboard,
  FolderOpen,
  FolderPlus,
  Keyboard,
  Library,
  Music2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Repeat1,
  Settings2,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import ContextMenu, { openCtxMenu, type CtxItem, type CtxMenuState } from "./ContextMenu";
import DarkVeil from "./DarkVeil";
import ImageCropModal from "./ImageCropModal";
import SfxHotkeysPanel from "./SfxHotkeysPanel";
import SfxStudioMontage, {
  type StudioDropApi,
  type StudioIncoming,
} from "./SfxStudioMontage";
import SfxMenuSelect from "./SfxMenuSelect";
import SfxVolumeButton from "./SfxVolumeButton";
import { useI18n } from "./i18n";
import type { ModuleChrome } from "./App";

type SfxEntry = {
  path: string;
  name: string;
  category: string;
  durationMs?: number | null;
};

type AudioDeviceInfo = {
  name: string;
  isDefault: boolean;
};

type ItemMeta = {
  hotkey?: string;
  volume?: number;
  pitch?: number;
  color?: string;
  displayName?: string;
  range?: { startMs: number; endMs: number };
};

const PAD_COLORS: { id: string; keys: string[] }[] = [
  { id: "", keys: ["—", "-", "default", "默认"] },
  { id: "#3cb371", keys: ["绿", "green"] },
  { id: "#4a90d9", keys: ["蓝", "blue"] },
  { id: "#d4a017", keys: ["金", "gold"] },
  { id: "#c45c5c", keys: ["红", "red"] },
  { id: "#9b6bce", keys: ["紫", "purple"] },
  { id: "#e07a3d", keys: ["橙", "orange"] },
];

/** 顶部：素材库 / 背景音乐 / 我的音效 / 音效制作 */
type Tab = "library" | "bgm" | "mysfx" | "studio";

type BgmStatus = {
  path: string | null;
  playing: boolean;
  paused: boolean;
  positionMs: number;
  durationMs: number | null;
  speed: number;
  pitch: number;
  fadeMs: number;
  fading: boolean;
  loopMode: string;
};

type SfxSettings = {
  libraryPath: string | null;
  masterVolume: number;
  bgmVolume: number;
  sfxVolume: number;
  bgmSpeed: number;
  bgmPitch: number;
  fadeMs: number;
  sfxFadeMs: number;
  padCols: number;
  loopMode: "loopOne" | "loopList" | "shuffle";
  interrupt: boolean;
  duckEnabled: boolean;
  duckFactor: number;
  voiceDuckEnabled: boolean;
  voiceDevice: string | null;
  voiceThreshold: number;
  voiceAttackMs: number;
  voiceReleaseMs: number;
  voiceFactor: number;
  outputDevice: string | null;
  stopHotkey: string;
  itemMeta: Record<string, ItemMeta>;
  mySfx: string[];
  myBgm: string[];
  recent: string[];
  lastCategory: string | null;
  tab: Tab;
  obsHost: string;
  obsPort: number;
  obsPassword: string;
  obsMediaInput: string;
  obsSeekCompensateMs: number;
  midiEnabled: boolean;
  midiPort: string | null;
  midiFps: number;
  midiOffsetMs: number;
  /** 唱片封面（裁剪后的 JPEG dataURL） */
  vinylArtDataUrl: string | null;
  /** settings schema rev — bump when changing defaults for existing installs */
  sfxSettingsRev?: number;
  /** @deprecated migrated into mySfx */
  favorites?: string[];
  lane?: string;
};

const STORE_FILE = "sfx.json";
/** 与 App 设置面板改曲库路径同步 */
const SFX_LIBRARY_EVENT = "flybox-sfx-library";
const ICO = 16;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac|wma|opus|webm|aiff|ape|ac3|mka)$/i;
const RECENT_MAX = 40;
const RECENT_CAT = "__recent__";
/** 录音固定入库的曲库子分类（文件夹名） */
const STUDIO_CAT = "我制作的";
/** 批量/拖入导入固定进这里，左侧常驻，方便管理 */
const IMPORT_CAT = "我导入的";

const DEFAULT_SETTINGS: SfxSettings = {
  libraryPath: null,
  masterVolume: 1,
  bgmVolume: 0.7,
  sfxVolume: 1,
  bgmSpeed: 1,
  bgmPitch: 0,
  fadeMs: 450,
  sfxFadeMs: 40,
  padCols: 4,
  loopMode: "loopOne",
  interrupt: true,
  sfxSettingsRev: 1,
  duckEnabled: true,
  duckFactor: 0.28,
  voiceDuckEnabled: false,
  voiceDevice: null,
  voiceThreshold: 0.08,
  voiceAttackMs: 80,
  voiceReleaseMs: 600,
  voiceFactor: 0.22,
  outputDevice: null,
  stopHotkey: "Ctrl+Shift+Space",
  itemMeta: {},
  mySfx: [],
  myBgm: [],
  recent: [],
  lastCategory: null,
  tab: "bgm",
  obsHost: "127.0.0.1",
  obsPort: 4455,
  obsPassword: "",
  obsMediaInput: "",
  obsSeekCompensateMs: 0,
  midiEnabled: false,
  midiPort: null,
  midiFps: 30,
  midiOffsetMs: 0,
  vinylArtDataUrl: null,
};

const EMPTY_BGM: BgmStatus = {
  path: null,
  playing: false,
  paused: false,
  positionMs: 0,
  durationMs: null,
  speed: 1,
  pitch: 0,
  fadeMs: 450,
  fading: false,
  loopMode: "loopOne",
};

function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function toShortcutId(hotkey: string): string {
  return hotkey
    .replace(/\bControl\b/gi, "Ctrl")
    .replace(/\bCommandOrControl\b/gi, "Ctrl")
    .replace(/\s*\+\s*/g, "+")
    .trim();
}

function formatHotkeyEvent(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  else if (key.startsWith("Arrow")) key = key.replace("Arrow", "");
  parts.push(key);
  return parts.join("+");
}

function migrateSettings(saved: Partial<SfxSettings>): SfxSettings {
  const legacyFav = saved.favorites ?? [];
  const mySfx = saved.mySfx?.length ? saved.mySfx : legacyFav;
  const rawTab = saved.tab as string | undefined;
  // legacy "hotkeys" tab folded into 我的音效
  const tab: Tab =
    rawTab === "hotkeys"
      ? "mysfx"
      : rawTab === "bgm" ||
          rawTab === "mysfx" ||
          rawTab === "library" ||
          rawTab === "studio"
        ? rawTab
        : "bgm";
  const rev = typeof saved.sfxSettingsRev === "number" ? saved.sfxSettingsRev : 0;
  // rev<1: old default was interrupt=false (stack). Live use expects cut-on-switch.
  const interrupt = rev < 1 ? true : (saved.interrupt ?? true);
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    itemMeta: saved.itemMeta ?? {},
    mySfx,
    myBgm: saved.myBgm ?? [],
    recent: saved.recent ?? [],
    lastCategory: saved.lastCategory ?? null,
    bgmVolume: saved.bgmVolume ?? DEFAULT_SETTINGS.bgmVolume,
    sfxVolume: saved.sfxVolume ?? DEFAULT_SETTINGS.sfxVolume,
    masterVolume: saved.masterVolume ?? DEFAULT_SETTINGS.masterVolume,
    bgmSpeed: saved.bgmSpeed ?? DEFAULT_SETTINGS.bgmSpeed,
    bgmPitch: saved.bgmPitch ?? DEFAULT_SETTINGS.bgmPitch,
    fadeMs: saved.fadeMs ?? DEFAULT_SETTINGS.fadeMs,
    sfxFadeMs: saved.sfxFadeMs ?? DEFAULT_SETTINGS.sfxFadeMs,
    padCols: [3, 4, 5, 6].includes(saved.padCols ?? 0)
      ? (saved.padCols as number)
      : DEFAULT_SETTINGS.padCols,
    loopMode:
      saved.loopMode === "loopList"
        ? "loopList"
        : saved.loopMode === "shuffle"
          ? "shuffle"
          : "loopOne",
    interrupt,
    sfxSettingsRev: Math.max(rev, 1),
    duckEnabled: saved.duckEnabled ?? DEFAULT_SETTINGS.duckEnabled,
    duckFactor: saved.duckFactor ?? DEFAULT_SETTINGS.duckFactor,
    voiceDuckEnabled: saved.voiceDuckEnabled ?? false,
    // 以前误存成舞台背景的图，迁到唱片封面
    vinylArtDataUrl:
      saved.vinylArtDataUrl ??
      (saved as { stageBgDataUrl?: string | null }).stageBgDataUrl ??
      null,
    tab,
  };
}

export default function Soundboard({
  embedded,
  onChromeChange,
}: {
  embedded?: boolean;
  onChromeChange?: (chrome: ModuleChrome | null) => void;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SfxSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [entries, setEntries] = useState<SfxEntry[]>([]);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [category, setCategory] = useState<string>("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CtxMenuState>(null);
  const [capturingPath, setCapturingPath] = useState<string | null>(null);
  const [capturingStop, setCapturingStop] = useState(false);
  const [hotkeySelectedId, setHotkeySelectedId] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Record<string, number>>({});
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const audioSettingsRef = useRef<HTMLDivElement | null>(null);
  const [vinylCropSrc, setVinylCropSrc] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [bgm, setBgm] = useState<BgmStatus>(EMPTY_BGM);
  const [seekDrag, setSeekDrag] = useState<number | null>(null);
  const [inputDevices, setInputDevices] = useState<AudioDeviceInfo[]>([]);
  const [midiPorts, setMidiPorts] = useState<string[]>([]);
  const [obsScenes, setObsScenes] = useState<string[]>([]);
  const [obsConnected, setObsConnected] = useState(false);
  const [studioIncoming, setStudioIncoming] = useState<StudioIncoming | null>(
    null,
  );
  const [studioQuery, setStudioQuery] = useState("");
  const [studioKind, setStudioKind] = useState<"sfx" | "bgm">("sfx");
  const [recording, setRecording] = useState(false);
  const [recElapsedMs, setRecElapsedMs] = useState(0);
  const [recPeak, setRecPeak] = useState(0);
  const settingsRef = useRef(settings);
  const entriesRef = useRef(entries);
  const playTimers = useRef<Map<string, number>>(new Map());
  const studioDropApiRef = useRef<StudioDropApi | null>(null);
  settingsRef.current = settings;
  entriesRef.current = entries;

  useEffect(() => {
    if (!showAudioSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowAudioSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showAudioSettings]);

  const onStudioIncomingConsumed = useCallback(() => {
    setStudioIncoming(null);
  }, []);

  const persist = useCallback(async (next: SfxSettings) => {
    setSettings(next);
    const store = await load(STORE_FILE, { autoSave: true });
    await store.set("sfx", next);
  }, []);

  const pickVinylArt = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Image",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
          },
        ],
      });
      if (typeof selected !== "string" || !selected) return;
      // 读成本地 blob，避免 canvas 跨域导致「用这块」点了没反应
      const bytes = await readFile(selected);
      const blob = new Blob([bytes]);
      setVinylCropSrc(URL.createObjectURL(blob));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const reloadLibrary = useCallback(async (root: string | null) => {
    if (!root) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<SfxEntry[]>("sfx_scan_library", { root });
      setEntries(list);
      setCategory((prev) => {
        if (prev && list.some((e) => e.category === prev)) return prev;
        const last = settingsRef.current.lastCategory;
        if (last && list.some((e) => e.category === last)) return last;
        const cats = [...new Set(list.map((e) => e.category))];
        return cats[0] ?? "";
      });
    } catch (e) {
      setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const markPlaying = useCallback((path: string) => {
    const token = Date.now();
    // Interrupt mode cuts previous voices — only the latest row should stay lit.
    if (settingsRef.current.interrupt) {
      for (const [p, timer] of playTimers.current) {
        if (p !== path) window.clearTimeout(timer);
      }
      playTimers.current.clear();
      setPlaying({ [path]: token });
    } else {
      setPlaying((prev) => ({ ...prev, [path]: token }));
      const prevTimer = playTimers.current.get(path);
      if (prevTimer) window.clearTimeout(prevTimer);
    }
    const dur = entriesRef.current.find((e) => e.path === path)?.durationMs;
    const holdMs = Math.min(120_000, Math.max(1800, (dur ?? 1800) + 200));
    const timer = window.setTimeout(() => {
      setPlaying((prev) => {
        if (prev[path] !== token) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
      playTimers.current.delete(path);
    }, holdMs);
    playTimers.current.set(path, timer);
  }, []);

  const refreshBgm = useCallback(async () => {
    try {
      const st = await invoke<BgmStatus>("sfx_bgm_status");
      setBgm(st);
      if (settingsRef.current.midiEnabled && (st.playing || st.paused) && st.path) {
        void invoke("midi_send_position", { positionMs: st.positionMs }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, []);

  const pushRecent = useCallback(
    (path: string) => {
      const recent = [path, ...settingsRef.current.recent.filter((p) => p !== path)].slice(
        0,
        RECENT_MAX,
      );
      void persist({ ...settingsRef.current, recent });
    },
    [persist],
  );

  const replacePathInCollections = useCallback(
    async (from: string, to: string) => {
      const next = { ...settingsRef.current };
      next.mySfx = next.mySfx.map((p) => (p === from ? to : p));
      next.myBgm = next.myBgm.map((p) => (p === from ? to : p));
      next.recent = next.recent.map((p) => (p === from ? to : p));
      if (next.itemMeta[from]) {
        next.itemMeta = { ...next.itemMeta, [to]: next.itemMeta[from] };
        delete next.itemMeta[from];
      }
      await persist(next);
    },
    [persist],
  );

  const playSfx = useCallback(
    async (path: string) => {
      const meta = settingsRef.current.itemMeta[path];
      const volume = meta?.volume ?? 1;
      const fadeMs = settingsRef.current.sfxFadeMs;
      try {
        await invoke("sfx_play", {
          path,
          volume,
          fadeMs,
          pitch: meta?.pitch ?? 0,
          rangeStartMs: meta?.range?.startMs,
          rangeEndMs: meta?.range?.endMs,
        });
        markPlaying(path);
        pushRecent(path);
      } catch (e) {
        const msg = String(e);
        const askTranscode = window.confirm(`${msg}\n\n${t("sfxTranscodeAsk")}`);
        if (askTranscode) {
          try {
            const dest = await invoke<string>("sfx_transcode", { path, dest: null });
            await replacePathInCollections(path, dest);
            await reloadLibrary(settingsRef.current.libraryPath);
            await invoke("sfx_play", {
              path: dest,
              volume,
              fadeMs,
              pitch: meta?.pitch ?? 0,
            });
            markPlaying(dest);
            pushRecent(dest);
            return;
          } catch (te) {
            return;
          }
        }
      }
    },
    [markPlaying, pushRecent, reloadLibrary, replacePathInCollections, t],
  );

  const playBgm = useCallback(
    async (path: string) => {
      const volume = settingsRef.current.itemMeta[path]?.volume ?? 1;
      try {
        await invoke("sfx_set_playlist", { paths: settingsRef.current.myBgm });
        await invoke("sfx_set_loop_mode", { mode: settingsRef.current.loopMode });
        await invoke("sfx_play_bgm", { path, volume });
        markPlaying(path);
        pushRecent(path);
        await refreshBgm();
      } catch (e) {
        const msg = String(e);
        const askTranscode = window.confirm(`${msg}\n\n${t("sfxTranscodeAsk")}`);
        if (askTranscode) {
          try {
            const dest = await invoke<string>("sfx_transcode", { path, dest: null });
            await replacePathInCollections(path, dest);
            await reloadLibrary(settingsRef.current.libraryPath);
            await invoke("sfx_set_playlist", { paths: settingsRef.current.myBgm });
            await invoke("sfx_play_bgm", { path: dest, volume });
            markPlaying(dest);
            pushRecent(dest);
            await refreshBgm();
            return;
          } catch (te) {
            return;
          }
        }
      }
    },
    [
      markPlaying,
      pushRecent,
      refreshBgm,
      reloadLibrary,
      replacePathInCollections,
      t,
    ],
  );

  const stopAll = useCallback(async () => {
    try {
      await invoke("sfx_stop_all");
      for (const t of playTimers.current.values()) window.clearTimeout(t);
      playTimers.current.clear();
      setPlaying({});
      setBgm(EMPTY_BGM);
    } catch (e) {
    }
  }, []);

  useEffect(() => {
    if (!ready || !settings.libraryPath) return;
    void refreshBgm();
    const ms = settings.tab === "bgm" ? 250 : 900;
    const id = window.setInterval(() => void refreshBgm(), ms);
    return () => window.clearInterval(id);
  }, [ready, settings.libraryPath, settings.tab, refreshBgm]);

  const syncHotkeys = useCallback(async () => {
    try {
      await unregisterAll();
    } catch {
      /* ignore */
    }
    const s = settingsRef.current;
    const bind = async (hotkey: string, fn: () => void) => {
      const id = toShortcutId(hotkey);
      if (!id) return;
      try {
        if (await isRegistered(id)) await unregister(id);
        await register(id, (event) => {
          if (event.state === "Pressed") fn();
        });
      } catch {
        /* conflict / unsupported */
      }
    };
    if (s.stopHotkey) {
      await bind(s.stopHotkey, () => void stopAll());
    }
    for (const path of s.mySfx) {
      const hk = s.itemMeta[path]?.hotkey;
      if (!hk) continue;
      const p = path;
      await bind(hk, () => void playSfx(p));
    }
  }, [playSfx, stopAll]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await load(STORE_FILE, { autoSave: true });
        const saved = (await store.get<Partial<SfxSettings>>("sfx")) ?? {};
        const merged = migrateSettings(saved);
        const prevRev =
          typeof saved.sfxSettingsRev === "number" ? saved.sfxSettingsRev : 0;
        if (merged.sfxSettingsRev !== prevRev || merged.interrupt !== saved.interrupt) {
          await store.set("sfx", merged);
        }
        if (merged.lastCategory) setCategory(merged.lastCategory);
        if (cancelled) return;
        // 点进音效模块：默认落在「背景音乐」
        setSettings({ ...merged, tab: "bgm" });
        try {
          const devs = await invoke<AudioDeviceInfo[]>("sfx_list_devices");
          if (!cancelled) setDevices(devs);
        } catch {
          /* ignore */
        }
        try {
          const inputs = await invoke<AudioDeviceInfo[]>("sfx_list_input_devices");
          if (!cancelled) setInputDevices(inputs);
        } catch {
          /* ignore */
        }
        try {
          const ports = await invoke<string[]>("midi_list_ports");
          if (!cancelled) setMidiPorts(ports);
        } catch {
          /* ignore */
        }
        await invoke("sfx_set_master_volume", { volume: merged.masterVolume });
        await invoke("sfx_set_bgm_volume", { volume: merged.bgmVolume });
        await invoke("sfx_set_sfx_volume", { volume: merged.sfxVolume });
        await invoke("sfx_set_bgm_speed", { speed: merged.bgmSpeed });
        await invoke("sfx_set_bgm_pitch", { pitch: merged.bgmPitch });
        await invoke("sfx_set_fade_ms", { fadeMs: merged.fadeMs });
        await invoke("sfx_set_loop_mode", { mode: merged.loopMode });
        await invoke("sfx_set_playlist", { paths: merged.myBgm });
        await invoke("sfx_set_interrupt", { interrupt: merged.interrupt });
        await invoke("sfx_set_duck", {
          enabled: merged.duckEnabled,
          factor: merged.duckFactor,
        });
        await invoke("sfx_set_voice_duck", {
          enabled: merged.voiceDuckEnabled,
          device: merged.voiceDevice,
          threshold: merged.voiceThreshold,
          attackMs: merged.voiceAttackMs,
          releaseMs: merged.voiceReleaseMs,
          factor: merged.voiceFactor,
        });
        try {
          await invoke("obs_configure", {
            host: merged.obsHost,
            port: merged.obsPort,
            password: merged.obsPassword,
            seekCompensateMs: merged.obsSeekCompensateMs,
            mediaInput: merged.obsMediaInput || null,
          });
        } catch {
          /* ignore */
        }
        try {
          await invoke("midi_configure", {
            enabled: merged.midiEnabled,
            portName: merged.midiPort,
            fps: merged.midiFps,
            offsetMs: merged.midiOffsetMs,
          });
        } catch {
          /* ignore */
        }
        if (merged.outputDevice) {
          try {
            await invoke("sfx_set_device", { name: merged.outputDevice });
          } catch {
            /* device gone */
          }
        }
        await reloadLibrary(merged.libraryPath);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      void unregisterAll();
    };
  }, [reloadLibrary]);

  useEffect(() => {
    if (!ready) return;
    void syncHotkeys();
  }, [ready, settings.itemMeta, settings.stopHotkey, settings.mySfx, entries, syncHotkeys]);

  useEffect(() => {
    if (!ready) return;
    void invoke("sfx_set_playlist", { paths: settings.myBgm }).catch(() => {});
  }, [ready, settings.myBgm]);

  useEffect(() => {
    if (!query.trim()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (capturingPath || capturingStop) return;
      e.preventDefault();
      setQuery("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [query, capturingPath, capturingStop]);

  const padLabel = useCallback(
    (e: SfxEntry) => settings.itemMeta[e.path]?.displayName?.trim() || e.name,
    [settings.itemMeta],
  );

  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);

  const categories = useMemo(() => [...new Set(entries.map((e) => e.category))], [entries]);

  const catCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries) map.set(e.category, (map.get(e.category) ?? 0) + 1);
    return map;
  }, [entries]);

  const recentEntries = useMemo(() => {
    const map = byPath;
    return settings.recent.map((p) => map.get(p)).filter(Boolean) as SfxEntry[];
  }, [settings.recent, byPath]);

  const libraryVisible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return entries.filter((e) => {
        const label = (settings.itemMeta[e.path]?.displayName || e.name).toLowerCase();
        return label.includes(q) || e.category.toLowerCase().includes(q);
      });
    }
    if (category === RECENT_CAT) return recentEntries;
    if (!category) return entries;
    return entries.filter((e) => e.category === category);
  }, [entries, category, query, settings.itemMeta, recentEntries]);

  /** 制作页：按音效 / BGM 分流；有搜索词才列，避免一进来铺满曲库 */
  const studioVisible = useMemo(() => {
    const q = studioQuery.trim().toLowerCase();
    if (!q) return [];
    const bgmSet = new Set(settings.myBgm);
    const pool =
      studioKind === "bgm"
        ? entries.filter((e) => bgmSet.has(e.path))
        : entries.filter((e) => !bgmSet.has(e.path));
    return pool.filter((e) => {
      const label = (
        settings.itemMeta[e.path]?.displayName || e.name
      ).toLowerCase();
      return label.includes(q) || e.category.toLowerCase().includes(q);
    });
  }, [entries, studioQuery, studioKind, settings.itemMeta, settings.myBgm]);

  const mySfxEntries = useMemo(
    () => settings.mySfx.map((p) => byPath.get(p)).filter(Boolean) as SfxEntry[],
    [settings.mySfx, byPath],
  );

  const myBgmEntries = useMemo(
    () => settings.myBgm.map((p) => byPath.get(p)).filter(Boolean) as SfxEntry[],
    [settings.myBgm, byPath],
  );

  const hotkeyBindings = useMemo(() => {
    const list: {
      id: string;
      label: string;
      hotkey: string;
      kind: "stop" | "sfx";
    }[] = [
      {
        id: "__stop__",
        label: t("sfxStopHotkey"),
        hotkey: settings.stopHotkey || "",
        kind: "stop",
      },
    ];
    for (const path of settings.mySfx) {
      const e = byPath.get(path);
      const label = e
        ? padLabel(e)
        : path.split(/[/\\]/).pop() || path;
      list.push({
        id: path,
        label,
        hotkey: settings.itemMeta[path]?.hotkey || "",
        kind: "sfx",
      });
    }
    return list;
  }, [settings.stopHotkey, settings.mySfx, settings.itemMeta, byPath, padLabel, t]);

  const applyHotkey = useCallback(
    (id: string, hk: string) => {
      const next = { ...settingsRef.current };
      // 同一快捷键只保留一个主人
      if (next.stopHotkey === hk && id !== "__stop__") next.stopHotkey = "";
      const itemMeta = { ...next.itemMeta };
      for (const [path, meta] of Object.entries(itemMeta)) {
        if (path === id || meta?.hotkey !== hk) continue;
        const cleared = { ...meta };
        delete cleared.hotkey;
        itemMeta[path] = cleared;
      }
      if (id === "__stop__") {
        next.stopHotkey = hk;
        next.itemMeta = itemMeta;
        void persist(next);
        setCapturingStop(false);
        setCapturingPath(null);
        return;
      }
      itemMeta[id] = { ...itemMeta[id], hotkey: hk };
      next.itemMeta = itemMeta;
      void persist(next);
      setCapturingPath(null);
      setCapturingStop(false);
    },
    [persist],
  );

  const clearHotkeyBinding = useCallback(
    (id: string) => {
      if (id === "__stop__") {
        void persist({ ...settingsRef.current, stopHotkey: "" });
        return;
      }
      // 删 = 移出「我的音效」并清掉快捷键
      const next = { ...settingsRef.current };
      next.mySfx = next.mySfx.filter((p) => p !== id);
      const meta = { ...(next.itemMeta[id] ?? {}) };
      delete meta.hotkey;
      next.itemMeta = { ...next.itemMeta, [id]: meta };
      void persist(next);
      setHotkeySelectedId((cur) => (cur === id ? null : cur));
    },
    [persist],
  );

  const toggleMinePlay = useCallback(
    (path: string) => {
      void (async () => {
        if (playing[path]) {
          try {
            await invoke("sfx_stop_sfx");
            for (const timer of playTimers.current.values()) {
              window.clearTimeout(timer);
            }
            playTimers.current.clear();
            setPlaying({});
          } catch {
            /* ignore */
          }
          return;
        }
        await playSfx(path);
      })();
    },
    [playing, playSfx],
  );

  useEffect(() => {
    if (!capturingPath && !capturingStop) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturingPath(null);
        setCapturingStop(false);
        return;
      }
      const hk = formatHotkeyEvent(e);
      if (!hk) return;
      if (capturingStop) {
        applyHotkey("__stop__", hk);
        return;
      }
      if (capturingPath) applyHotkey(capturingPath, hk);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingPath, capturingStop, applyHotkey]);

  const searching = query.trim().length > 0;

  const setTab = useCallback(
    (tab: Tab) => {
      setQuery("");
      void persist({ ...settingsRef.current, tab });
    },
    [persist],
  );

  const selectCategory = useCallback(
    (c: string) => {
      setCategory(c);
      setQuery("");
      void persist({ ...settingsRef.current, lastCategory: c });
    },
    [persist],
  );

  const toggleCollect = useCallback(
    async (path: string, kind: "sfx" | "bgm") => {
      const next = { ...settingsRef.current };
      if (kind === "sfx") {
        const set = new Set(next.mySfx);
        if (set.has(path)) set.delete(path);
        else set.add(path);
        next.mySfx = [...set];
      } else {
        const set = new Set(next.myBgm);
        if (set.has(path)) set.delete(path);
        else set.add(path);
        next.myBgm = [...set];
      }
      await persist(next);
    },
    [persist, t],
  );

  const renamePad = useCallback(
    async (entry: SfxEntry) => {
      const cur = settingsRef.current.itemMeta[entry.path]?.displayName || entry.name;
      const name = window.prompt(t("sfxRenamePrompt"), cur);
      if (name == null) return;
      const trimmed = name.trim();
      const next = { ...settingsRef.current };
      const meta = { ...next.itemMeta[entry.path] };
      if (trimmed && trimmed !== entry.name) meta.displayName = trimmed;
      else delete meta.displayName;
      next.itemMeta = { ...next.itemMeta, [entry.path]: meta };
      await persist(next);
    },
    [persist, t],
  );

  const pickLibrary = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;
    const next = { ...settingsRef.current, libraryPath: dir };
    await persist(next);
    await reloadLibrary(dir);
    window.dispatchEvent(new CustomEvent(SFX_LIBRARY_EVENT, { detail: dir }));
  }, [persist, reloadLibrary]);

  useEffect(() => {
    const onLib = (e: Event) => {
      const dir = (e as CustomEvent<string>).detail;
      if (typeof dir !== "string" || !dir) return;
      if (dir === settingsRef.current.libraryPath) return;
      const next = { ...settingsRef.current, libraryPath: dir };
      settingsRef.current = next;
      setSettings(next);
      void reloadLibrary(dir);
    };
    window.addEventListener(SFX_LIBRARY_EVENT, onLib);
    return () => window.removeEventListener(SFX_LIBRARY_EVENT, onLib);
  }, [reloadLibrary]);

  const importAudioPaths = useCallback(
    async (
      files: string[],
      dropClient?: { x: number; y: number } | null,
    ) => {
      const root = settingsRef.current.libraryPath;
      if (!root) {
        setError(t("sfxNeedLibrary"));
        return [];
      }
      const audio = files.filter((f) => AUDIO_EXT.test(f));
      if (audio.length === 0) {
        setError(t("sfxStudioDropNeedAudio"));
        return [];
      }
      const tabNow = settingsRef.current.tab;
      // 制作页进「我制作的」；其余导入一律进「我导入的」
      const cat = tabNow === "studio" ? STUDIO_CAT : IMPORT_CAT;
      try {
        const imported = await invoke<string[]>("sfx_import_files", {
          libraryRoot: root,
          category: cat,
          files: audio,
        });
        await reloadLibrary(root);
        if (tabNow === "studio" && imported.length > 0) {
          let trackId: string | undefined;
          let atMs: number | undefined;
          if (dropClient && studioDropApiRef.current) {
            const hit = studioDropApiRef.current.hitTest(
              dropClient.x,
              dropClient.y,
            );
            trackId = hit.trackId;
            atMs = hit.atMs;
          }
          setStudioIncoming({ paths: imported, trackId, atMs });
        } else if (imported.length > 0) {
          setTab("library");
          selectCategory(IMPORT_CAT);
        }
        setError(null);
        return imported;
      } catch (e) {
        setError(String(e));
        return [];
      }
    },
    [reloadLibrary, selectCategory, setTab, t],
  );

  const importFiles = useCallback(async () => {
    if (!settingsRef.current.libraryPath) {
      return;
    }
    const picked = await open({
      multiple: true,
      filters: [
        {
          name: "Audio",
          extensions: [
            "mp3",
            "wav",
            "flac",
            "ogg",
            "m4a",
            "aac",
            "wma",
            "opus",
            "webm",
            "aiff",
            "ape",
            "ac3",
            "mka",
          ],
        },
      ],
    });
    if (!picked) return;
    await importAudioPaths(Array.isArray(picked) ? picked : [picked]);
  }, [importAudioPaths, t]);

  useEffect(() => {
    if (!ready || !settings.libraryPath) return;
    let unlisten: (() => void) | undefined;
    const toClient = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      return { x: pos.x / dpr, y: pos.y / dpr };
    };
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragOver(true);
          if (
            settingsRef.current.tab === "studio" &&
            "position" in p &&
            p.position
          ) {
            const c = toClient(p.position);
            studioDropApiRef.current?.setOsHover({
              clientX: c.x,
              clientY: c.y,
            });
          }
          return;
        }
        if (p.type === "leave") {
          setDragOver(false);
          studioDropApiRef.current?.setOsHover(null);
          return;
        }
        if (p.type === "drop") {
          setDragOver(false);
          const c = toClient(p.position);
          studioDropApiRef.current?.setOsHover(null);
          void importAudioPaths(
            p.paths,
            settingsRef.current.tab === "studio" ? c : null,
          );
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
      setDragOver(false);
      studioDropApiRef.current?.setOsHover(null);
    };
  }, [ready, settings.libraryPath, importAudioPaths]);

  const onMasterVolume = useCallback(
    async (v: number) => {
      const next = { ...settingsRef.current, masterVolume: v };
      await persist(next);
      await invoke("sfx_set_master_volume", { volume: v });
    },
    [persist],
  );

  const onBgmVolume = useCallback(
    async (v: number) => {
      const next = { ...settingsRef.current, bgmVolume: v };
      await persist(next);
      await invoke("sfx_set_bgm_volume", { volume: v });
    },
    [persist],
  );

  const onSfxVolume = useCallback(
    async (v: number) => {
      const next = { ...settingsRef.current, sfxVolume: v };
      await persist(next);
      await invoke("sfx_set_sfx_volume", { volume: v });
    },
    [persist],
  );

  const onBgmSpeed = useCallback(
    async (speed: number) => {
      const next = { ...settingsRef.current, bgmSpeed: speed };
      await persist(next);
      await invoke("sfx_set_bgm_speed", { speed });
      await refreshBgm();
    },
    [persist, refreshBgm],
  );

  const onBgmPitch = useCallback(
    async (pitch: number) => {
      const next = { ...settingsRef.current, bgmPitch: pitch };
      await persist(next);
      await invoke("sfx_set_bgm_pitch", { pitch });
      await refreshBgm();
    },
    [persist, refreshBgm],
  );

  const onLoopMode = useCallback(
    async (loopMode: "loopOne" | "loopList" | "shuffle") => {
      const next = { ...settingsRef.current, loopMode };
      await persist(next);
      await invoke("sfx_set_loop_mode", { mode: loopMode });
      await invoke("sfx_set_playlist", { paths: next.myBgm });
      await refreshBgm();
    },
    [persist, refreshBgm],
  );

  const skipBgm = useCallback(
    async (dir: -1 | 1) => {
      const list = settingsRef.current.myBgm;
      if (!list.length) return;
      const cur = bgm.path;
      let i = cur ? list.indexOf(cur) : -1;
      if (settingsRef.current.loopMode === "shuffle" && list.length > 1) {
        let n = Math.floor(Math.random() * list.length);
        if (n === i) n = (n + 1) % list.length;
        await playBgm(list[n]);
        return;
      }
      if (i < 0) i = dir > 0 ? -1 : 0;
      i = (i + dir + list.length) % list.length;
      await playBgm(list[i]);
    },
    [bgm.path, playBgm],
  );

  const onFadeMs = useCallback(
    async (fadeMs: number) => {
      const next = { ...settingsRef.current, fadeMs };
      await persist(next);
      await invoke("sfx_set_fade_ms", { fadeMs });
    },
    [persist],
  );

  const seekBgm = useCallback(
    async (positionMs: number) => {
      try {
        await invoke("sfx_seek_bgm", { positionMs });
        if (settingsRef.current.obsMediaInput) {
          void invoke("obs_sync_media_seek", { positionMs }).catch(() => {});
        }
        if (settingsRef.current.midiEnabled) {
          void invoke("midi_send_position", { positionMs }).catch(() => {});
        }
        await refreshBgm();
      } catch (e) {
      }
    },
    [refreshBgm],
  );

  const applyVoiceDuck = useCallback(async (patch: Partial<SfxSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    await persist(next);
    await invoke("sfx_set_voice_duck", {
      enabled: next.voiceDuckEnabled,
      device: next.voiceDevice,
      threshold: next.voiceThreshold,
      attackMs: next.voiceAttackMs,
      releaseMs: next.voiceReleaseMs,
      factor: next.voiceFactor,
    });
  }, [persist]);

  const createCategory = useCallback(async () => {
    const root = settingsRef.current.libraryPath;
    if (!root) return;
    const name = window.prompt(t("sfxCatCreatePrompt"));
    if (!name?.trim()) return;
    try {
      await invoke("sfx_category_create", { libraryRoot: root, name: name.trim() });
      await reloadLibrary(root);
      selectCategory(name.trim());
    } catch (e) {
    }
  }, [reloadLibrary, selectCategory, t]);

  const renameCategory = useCallback(
    async (catName?: string) => {
      const root = settingsRef.current.libraryPath;
      const cat = catName ?? category;
      if (!root || !cat || cat === RECENT_CAT || cat === IMPORT_CAT) return;
      const name = window.prompt(t("sfxCatRenamePrompt"), cat);
      if (!name?.trim() || name.trim() === cat) return;
      try {
        await invoke("sfx_category_rename", {
          libraryRoot: root,
          oldName: cat,
          newName: name.trim(),
        });
        await reloadLibrary(root);
        selectCategory(name.trim());
      } catch (e) {
      }
    },
    [category, reloadLibrary, selectCategory, t],
  );

  const deleteCategory = useCallback(
    async (catName?: string) => {
      const root = settingsRef.current.libraryPath;
      const cat = catName ?? category;
      if (!root || !cat || cat === RECENT_CAT || cat === IMPORT_CAT) return;
      const ok = await ask(`${t("sfxCatDeleteConfirm")}\n${cat}`, {
        title: t("sfxboard"),
        kind: "warning",
      });
      if (!ok) return;
      try {
        await invoke("sfx_category_delete", { libraryRoot: root, name: cat });
        if (category === cat) {
          setCategory("");
          await persist({ ...settingsRef.current, lastCategory: null });
        }
        await reloadLibrary(root);
      } catch (e) {
      }
    },
    [category, persist, reloadLibrary, t],
  );

  const onDevice = useCallback(
    async (name: string) => {
      const value = name || null;
      await persist({ ...settingsRef.current, outputDevice: value });
      try {
        await invoke("sfx_set_device", { name: value });
        await refreshBgm();
      } catch (e) {
      }
    },
    [persist, refreshBgm],
  );

  const onInterrupt = useCallback(
    async (interrupt: boolean) => {
      await persist({ ...settingsRef.current, interrupt });
      await invoke("sfx_set_interrupt", { interrupt });
    },
    [persist],
  );

  const onDuck = useCallback(
    async (patch: Partial<Pick<SfxSettings, "duckEnabled" | "duckFactor">>) => {
      const next = { ...settingsRef.current, ...patch };
      await persist(next);
      await invoke("sfx_set_duck", { enabled: next.duckEnabled, factor: next.duckFactor });
    },
    [persist],
  );

  const startRecording = useCallback(async () => {
    const root = settingsRef.current.libraryPath;
    if (!root) {
      setError(t("sfxNeedLibrary"));
      return;
    }
    try {
      await invoke("sfx_record_start", {
        deviceName: settingsRef.current.voiceDevice,
      });
      setRecording(true);
      setRecElapsedMs(0);
      setRecPeak(0);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [t]);

  const stopRecording = useCallback(async () => {
    const root = settingsRef.current.libraryPath;
    if (!root) {
      setRecording(false);
      return;
    }
    try {
      const dest = await invoke<string>("sfx_record_stop", {
        libraryRoot: root,
        category: STUDIO_CAT,
      });
      setRecording(false);
      setRecPeak(0);
      await reloadLibrary(root);
      setStudioIncoming({ paths: [dest] });
      const addMine = await ask(t("sfxRecordAddMineAsk"), {
        title: t("sfxboard"),
        kind: "info",
      });
      if (addMine) {
        const next = { ...settingsRef.current };
        if (!next.mySfx.includes(dest)) next.mySfx = [...next.mySfx, dest];
        await persist(next);
      }
    } catch (e) {
      setRecording(false);
      setError(String(e));
    }
  }, [persist, reloadLibrary, t]);

  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      void invoke<{ recording: boolean; elapsedMs: number; peak: number }>("sfx_record_status")
        .then((st) => {
          setRecElapsedMs(st.elapsedMs);
          setRecPeak(st.peak);
          if (!st.recording) setRecording(false);
        })
        .catch(() => {});
    }, 120);
    return () => window.clearInterval(id);
  }, [recording]);

  const tools: ReactNode = (
    <>
      <button type="button" className="icon-btn" title={t("sfxStopAll")} onClick={() => void stopAll()}>
        <Square size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        className={
          showAudioSettings
            ? "icon-btn on sfx-audio-settings-btn"
            : "icon-btn sfx-audio-settings-btn"
        }
        title={t("sfxAudioSettings")}
        onClick={() => setShowAudioSettings((v) => !v)}
      >
        <Settings2 size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
    </>
  );

  const tab = settings.tab;

  const chromeTabs: ReactNode = (
    <nav className="sfx-chrome-tabs" role="tablist" aria-label={t("sfxboard")}>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "library"}
        className={tab === "library" ? "icon-btn on" : "icon-btn"}
        title={t("sfxTabLibrary")}
        onClick={() => setTab("library")}
      >
        <Library size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "bgm"}
        className={tab === "bgm" ? "icon-btn on" : "icon-btn"}
        title={t("sfxTabBgm")}
        onClick={() => setTab("bgm")}
      >
        <Music2 size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "mysfx"}
        className={tab === "mysfx" ? "icon-btn on" : "icon-btn"}
        title={t("sfxTabMine")}
        onClick={() => setTab("mysfx")}
      >
        <Keyboard size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "studio"}
        className={tab === "studio" ? "icon-btn on" : "icon-btn"}
        title={t("sfxTabStudio")}
        onClick={() => setTab("studio")}
      >
        <Clapperboard size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
    </nav>
  );

  useEffect(() => {
    if (!onChromeChange) return;
    if (!settings.libraryPath) {
      onChromeChange({ title: t("sfxEmptyTitle"), tools });
      return;
    }
    onChromeChange({
      context: chromeTabs,
      tools,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    onChromeChange,
    settings.libraryPath,
    showAudioSettings,
    entries.length,
    myBgmEntries.length,
    mySfxEntries.length,
    tab,
    loading,
    t,
  ]);

  const openPadMenu = (e: ReactMouseEvent, entry: SfxEntry, scope: Tab) => {
    const meta = settings.itemMeta[entry.path] ?? {};
    const items: CtxItem[] = [
      {
        id: "play-sfx",
        label: t("sfxPlayOnce"),
        onClick: () => void playSfx(entry.path),
      },
      {
        id: "play-bgm",
        label: t("sfxPlayLoop"),
        onClick: () => void playBgm(entry.path),
      },
      {
        id: "to-sfx",
        label: settings.mySfx.includes(entry.path) ? t("sfxRemoveFromMine") : t("sfxAddToMine"),
        onClick: () => void toggleCollect(entry.path, "sfx"),
      },
      {
        id: "to-bgm",
        label: settings.myBgm.includes(entry.path) ? t("sfxRemoveFromBgm") : t("sfxAddToBgm"),
        onClick: () => void toggleCollect(entry.path, "bgm"),
      },
      {
        id: "rename",
        label: t("sfxRename"),
        onClick: () => void renamePad(entry),
      },
    ];
    if (scope === "mysfx") {
      items.push(
        {
          id: "hotkey",
          label: meta.hotkey
            ? `${t("sfxSetHotkey")} (${meta.hotkey})`
            : t("sfxSetHotkey"),
          onClick: () => setCapturingPath(entry.path),
        },
        {
          id: "clear-hotkey",
          label: t("sfxClearHotkey"),
          disabled: !meta.hotkey,
          onClick: () => {
            const next = { ...settingsRef.current };
            const m = { ...next.itemMeta[entry.path] };
            delete m.hotkey;
            next.itemMeta = { ...next.itemMeta, [entry.path]: m };
            void persist(next);
          },
        },
        {
          id: "volume",
          label: `${t("sfxItemVolume")}: ${Math.round((meta.volume ?? 1) * 100)}%`,
          onClick: () => {
            const cur = String(Math.round((meta.volume ?? 1) * 100));
            const raw = window.prompt(t("sfxItemVolumePrompt"), cur);
            if (raw == null) return;
            const pct = Number(raw);
            if (!Number.isFinite(pct)) return;
            const next = { ...settingsRef.current };
            next.itemMeta = {
              ...next.itemMeta,
              [entry.path]: {
                ...next.itemMeta[entry.path],
                volume: Math.min(1.5, Math.max(0, pct / 100)),
              },
            };
            void persist(next);
          },
        },
        {
          id: "pitch",
          label: `${t("sfxPitch")}: ${meta.pitch ?? 0}`,
          onClick: () => {
            const raw = window.prompt(t("sfxItemPitchPrompt"), String(meta.pitch ?? 0));
            if (raw == null) return;
            const pitch = Math.min(12, Math.max(-12, Number(raw) || 0));
            const next = { ...settingsRef.current };
            next.itemMeta = {
              ...next.itemMeta,
              [entry.path]: { ...next.itemMeta[entry.path], pitch },
            };
            void persist(next);
          },
        },
        {
          id: "color",
          label: t("sfxPadColor"),
          onClick: () => {
            const raw = window.prompt(t("sfxPadColorPrompt"), meta.color ?? "");
            if (raw == null) return;
            const key = raw.trim().toLowerCase();
            const hit =
              PAD_COLORS.find((c) => c.id.toLowerCase() === key) ||
              PAD_COLORS.find((c) => c.keys.some((k) => k.toLowerCase() === key));
            const color = hit ? hit.id : key.startsWith("#") ? raw.trim() : "";
            const next = { ...settingsRef.current };
            const m = { ...next.itemMeta[entry.path] };
            if (color) m.color = color;
            else delete m.color;
            next.itemMeta = { ...next.itemMeta, [entry.path]: m };
            void persist(next);
          },
        },
      );
    }
    items.push({
      id: "range",
      label: meta.range
        ? `${t("sfxRangeEdit")} (${meta.range.startMs}-${meta.range.endMs}ms)`
        : t("sfxRangeSet"),
      onClick: () => {
        setStudioIncoming({ paths: [entry.path] });
        setTab("studio");
        void (async () => {
          try {
            const info = await invoke<{ durationMs?: number | null }>("sfx_probe", {
              path: entry.path,
            });
            if (info.durationMs != null) {
              setEntries((prev) =>
                prev.map((e) =>
                  e.path === entry.path ? { ...e, durationMs: info.durationMs } : e,
                ),
              );
            }
          } catch {
            /* optional */
          }
        })();
      },
    });
    if (scope === "library" && settings.libraryPath) {
      const moveCats = [
        "未分类",
        IMPORT_CAT,
        ...categories.filter((x) => x !== "未分类" && x !== IMPORT_CAT),
      ];
      for (const c of moveCats) {
        if (c === entry.category) continue;
        items.push({
          id: `move-${c}`,
          label: `${t("sfxMoveTo")} ${c}`,
          onClick: () => {
            void (async () => {
              try {
                const dest = await invoke<string>("sfx_move_file", {
                  path: entry.path,
                  libraryRoot: settingsRef.current.libraryPath,
                  category: c === "未分类" ? "" : c,
                });
                await replacePathInCollections(entry.path, dest);
                await reloadLibrary(settingsRef.current.libraryPath);
              } catch (err) {
              }
            })();
          },
        });
      }
    }
    items.push(
      {
        id: "transcode",
        label: t("sfxTranscode"),
        onClick: () => {
          void (async () => {
            try {
              const dest = await invoke<string>("sfx_transcode", {
                path: entry.path,
                dest: null,
              });
              await replacePathInCollections(entry.path, dest);
              await reloadLibrary(settingsRef.current.libraryPath);
            } catch (err) {
            }
          })();
        },
      },
      { id: "sep", separator: true },
      {
        id: "delete",
        label: t("delete"),
        danger: true,
        onClick: () => {
          void (async () => {
            const ok = await ask(`${t("sfxDeleteConfirm")}\n${entry.name}`, {
              title: t("sfxboard"),
              kind: "warning",
            });
            if (!ok) return;
            try {
              await invoke("sfx_delete_file", { path: entry.path });
              const next = { ...settingsRef.current };
              const metaMap = { ...next.itemMeta };
              delete metaMap[entry.path];
              next.itemMeta = metaMap;
              next.mySfx = next.mySfx.filter((p) => p !== entry.path);
              next.myBgm = next.myBgm.filter((p) => p !== entry.path);
              await persist(next);
              await reloadLibrary(next.libraryPath);
            } catch (err) {
            }
          })();
        },
      },
    );
    openCtxMenu(e, items, setCtx);
  };

  if (!ready) {
    return (
      <div className={embedded ? "sfx-embedded" : undefined}>
        <div className="empty">
          <p className="muted">{t("booting")}</p>
        </div>
      </div>
    );
  }

  const bgmEntry = bgm.path ? byPath.get(bgm.path) : undefined;
  const bgmName = bgmEntry
    ? padLabel(bgmEntry)
    : bgm.path?.split(/[/\\]/).pop() || t("sfxBgmIdle");

  return (
    <div
      className={[embedded ? "sfx-embedded" : "", dragOver ? "sfx-drag-over" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {error && <div className="banner error">{error}</div>}

      {!settings.libraryPath ? (
        <div className="empty">
          <h2>{t("sfxEmptyTitle")}</h2>
          <p className="muted">{t("sfxEmptyDesc")}</p>
          <button type="button" className="empty-pick" onClick={() => void pickLibrary()}>
            {t("sfxPickLibrary")}
          </button>
        </div>
      ) : (
        <div className="sfx-shell">
          {tab === "library" && (
            <div className="sfx-layout">
              <aside className="sfx-cats">
                <div className="sfx-cat-tools" role="toolbar" aria-label={t("sfxCatCreate")}>
                  <button
                    type="button"
                    className="sfx-cat-tool"
                    title={t("sfxCatCreate")}
                    onClick={() => void createCategory()}
                  >
                    <Plus size={15} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                  <button
                    type="button"
                    className="sfx-cat-tool"
                    title={t("sfxImport")}
                    onClick={() => void importFiles()}
                  >
                    <FolderPlus size={15} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                  <button
                    type="button"
                    className="sfx-cat-tool"
                    title={t("refresh")}
                    disabled={loading}
                    onClick={() => void reloadLibrary(settings.libraryPath)}
                  >
                    <RefreshCw size={15} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                </div>
                <button
                  type="button"
                  className={!searching && !category ? "sfx-cat on" : "sfx-cat"}
                  onClick={() => {
                    setCategory("");
                    setQuery("");
                    void persist({ ...settingsRef.current, lastCategory: null });
                  }}
                >
                  <span className="sfx-cat-label">{t("sfxAllMaterials")}</span>
                  <span className="sfx-cat-count">{entries.length}</span>
                </button>
                <button
                  type="button"
                  className={
                    !searching && category === RECENT_CAT
                      ? "sfx-cat special on"
                      : "sfx-cat special"
                  }
                  onClick={() => selectCategory(RECENT_CAT)}
                >
                  <span className="sfx-cat-label">{t("sfxRecent")}</span>
                  <span className="sfx-cat-count">{settings.recent.length}</span>
                </button>
                <button
                  type="button"
                  className={
                    !searching && category === IMPORT_CAT
                      ? "sfx-cat special on"
                      : "sfx-cat special"
                  }
                  onClick={() => selectCategory(IMPORT_CAT)}
                >
                  <span className="sfx-cat-label">{t("sfxImportCat")}</span>
                  <span className="sfx-cat-count">{catCounts.get(IMPORT_CAT) ?? 0}</span>
                </button>
                {categories
                  .filter((c) => c !== IMPORT_CAT)
                  .map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={!searching && category === c ? "sfx-cat on" : "sfx-cat"}
                    onClick={() => selectCategory(c)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openCtxMenu(
                        e,
                        [
                          {
                            id: "rename-cat",
                            label: t("sfxCatRename"),
                            onClick: () => void renameCategory(c),
                          },
                          {
                            id: "delete-cat",
                            label: t("sfxCatDelete"),
                            onClick: () => void deleteCategory(c),
                          },
                        ],
                        setCtx,
                      );
                    }}
                  >
                    <span className="sfx-cat-label">{c}</span>
                    <span className="sfx-cat-count">{catCounts.get(c) ?? 0}</span>
                  </button>
                ))}
              </aside>
              <div className="sfx-main">
                <div className="sfx-toolbar">
                  <input
                    className="sfx-search"
                    type="search"
                    value={query}
                    placeholder={t("sfxSearchLibrary")}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                  />
                  <span className="sfx-count muted">
                    {libraryVisible.length}/{entries.length}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("sfxOpenLibraryFolder")}
                    disabled={!settings.libraryPath}
                    onClick={() => {
                      void (async () => {
                        const root = settingsRef.current.libraryPath;
                        if (!root) return;
                        const cat = category;
                        const searching = Boolean(query.trim());
                        const target =
                          !searching &&
                          cat &&
                          cat !== RECENT_CAT &&
                          cat !== "未分类"
                            ? `${root.replace(/[/\\]+$/, "")}\\${cat}`
                            : root;
                        try {
                          await revealItemInDir(target);
                        } catch {
                          try {
                            await revealItemInDir(root);
                          } catch (e) {
                            setError(String(e));
                          }
                        }
                      })();
                    }}
                  >
                    <FolderOpen size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                </div>
                {libraryVisible.length === 0 ? (
                  <div className="empty compact">
                    <p className="muted">{loading ? t("scanning") : t("sfxNoMatch")}</p>
                  </div>
                ) : (
                  <div className="sfx-lib-list">
                    {libraryVisible.map((e, i) => {
                      const inSfx = settings.mySfx.includes(e.path);
                      const inBgm = settings.myBgm.includes(e.path);
                      const isPlaying = Boolean(playing[e.path]);
                      return (
                        <div
                          key={e.path}
                          className={isPlaying ? "sfx-lib-row playing" : "sfx-lib-row"}
                          onContextMenu={(ev) => openPadMenu(ev, e, "library")}
                        >
                          <button
                            type="button"
                            className="sfx-lib-idx"
                            title={isPlaying ? t("sfxStudioPause") : t("sfxPlayOnce")}
                            onClick={() =>
                              void (async () => {
                                if (isPlaying) {
                                  try {
                                    await invoke("sfx_stop_sfx");
                                    for (const timer of playTimers.current.values()) {
                                      window.clearTimeout(timer);
                                    }
                                    playTimers.current.clear();
                                    setPlaying({});
                                  } catch {
                                    /* ignore */
                                  }
                                } else {
                                  await playSfx(e.path);
                                }
                              })()
                            }
                          >
                            <span className="sfx-lib-idx-num">
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            {isPlaying ? (
                              <Pause
                                className="sfx-lib-idx-icon"
                                size={14}
                                strokeWidth={0}
                                absoluteStrokeWidth
                                fill="currentColor"
                              />
                            ) : (
                              <Play
                                className="sfx-lib-idx-icon"
                                size={14}
                                strokeWidth={0}
                                absoluteStrokeWidth
                                fill="currentColor"
                                style={{ marginLeft: 1 }}
                              />
                            )}
                          </button>
                          <button
                            type="button"
                            className="sfx-lib-main"
                            title={t("sfxPreviewHint")}
                            onClick={() => void playSfx(e.path)}
                          >
                            <span className="sfx-lib-name">{padLabel(e)}</span>
                            <span className="sfx-lib-cat">{e.category}</span>
                          </button>
                          <button
                            type="button"
                            className={inSfx ? "sfx-collect on" : "sfx-collect"}
                            title={inSfx ? t("sfxRemoveFromMine") : t("sfxAddToMine")}
                            onClick={() => void toggleCollect(e.path, "sfx")}
                          >
                            {t("sfxCollectSfx")}
                          </button>
                          <button
                            type="button"
                            className={inBgm ? "sfx-collect bgm on" : "sfx-collect bgm"}
                            title={inBgm ? t("sfxRemoveFromBgm") : t("sfxAddToBgm")}
                            onClick={() => void toggleCollect(e.path, "bgm")}
                          >
                            {t("sfxCollectBgm")}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "bgm" && (
            <div className="sfx-player bgm">
              <div className="sfx-player-stage">
                <div className="sfx-player-stage-bg" aria-hidden>
                  <DarkVeil
                    speed={0.5}
                    warpAmount={0}
                    noiseIntensity={0}
                    scanlineIntensity={0}
                    scanlineFrequency={0}
                    resolutionScale={1}
                  />
                </div>
                <div className="sfx-player-stage-fg">
                <div className="sfx-player-title">
                  {bgm.path ? bgmName : t("sfxBgmPickHint")}
                </div>

                <div
                  className={
                    bgm.playing && !bgm.paused
                      ? "sfx-vinyl spinning"
                      : bgm.paused
                        ? "sfx-vinyl paused"
                        : "sfx-vinyl"
                  }
                >
                  <div className="sfx-vinyl-disk" aria-hidden>
                    {settings.vinylArtDataUrl ? (
                      <img
                        className="sfx-vinyl-art"
                        src={settings.vinylArtDataUrl}
                        alt=""
                        draggable={false}
                      />
                    ) : (
                      <svg
                        className="sfx-vinyl-face"
                        width="112"
                        height="112"
                        viewBox="0 0 128 128"
                      >
                        <rect width="128" height="128" fill="#0a0a0a" />
                        <circle cx="20" cy="20" r="1.5" fill="#fff" opacity="0.55" />
                        <circle cx="40" cy="30" r="1.5" fill="#fff" opacity="0.4" />
                        <circle cx="60" cy="10" r="1.5" fill="#fff" opacity="0.5" />
                        <circle cx="80" cy="40" r="1.5" fill="#fff" opacity="0.35" />
                        <circle cx="100" cy="20" r="1.5" fill="#fff" opacity="0.45" />
                        <circle cx="110" cy="55" r="1.5" fill="#fff" opacity="0.35" />
                        <path
                          d="M0 128 Q32 64 64 128 T128 128"
                          fill="var(--accent)"
                          opacity="0.9"
                        />
                        <path
                          d="M0 128 Q32 48 64 128 T128 128"
                          fill="var(--accent)"
                          opacity="0.7"
                        />
                        <path
                          d="M0 128 Q32 32 64 128 T128 128"
                          fill="var(--accent)"
                          opacity="0.55"
                        />
                        <path
                          d="M0 128 Q16 64 32 128 T64 128"
                          fill="var(--accent)"
                          opacity="0.75"
                        />
                        <path
                          d="M64 128 Q80 64 96 128 T128 128"
                          fill="var(--accent)"
                          opacity="0.65"
                        />
                      </svg>
                    )}
                    {/* 轴心始终盖在封面之上，换图也还是唱片 */}
                    <svg
                      className="sfx-vinyl-spindle"
                      width="112"
                      height="112"
                      viewBox="0 0 128 128"
                    >
                      <circle cx="64" cy="64" r="14" fill="#141414" />
                      <circle cx="64" cy="64" r="9" fill="var(--accent)" />
                      <circle cx="64" cy="64" r="3.5" fill="#f2f2f2" />
                    </svg>
                  </div>
                  <button
                    type="button"
                    className="sfx-vinyl-edit"
                    title={t("sfxVinylArtChange")}
                    aria-label={t("sfxVinylArtChange")}
                    onClick={() => void pickVinylArt()}
                  >
                    <Pencil size={22} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                  {settings.vinylArtDataUrl ? (
                    <button
                      type="button"
                      className="sfx-vinyl-clear"
                      title={t("sfxVinylArtClear")}
                      aria-label={t("sfxVinylArtClear")}
                      onClick={() =>
                        void persist({
                          ...settingsRef.current,
                          vinylArtDataUrl: null,
                        })
                      }
                    >
                      ×
                    </button>
                  ) : null}
                </div>

                <div className="sfx-seek">
                  <span className="sfx-seek-time">
                    {formatMs(seekDrag ?? bgm.positionMs)}
                  </span>
                  <input
                    type="range"
                    className="sfx-seek-bar"
                    min={0}
                    max={Math.max(bgm.durationMs ?? 0, 1)}
                    step={100}
                    disabled={!bgm.path || !bgm.durationMs}
                    value={seekDrag ?? Math.min(bgm.positionMs, bgm.durationMs ?? 0)}
                    onChange={(e) => setSeekDrag(Number(e.target.value))}
                    onMouseUp={(e) => {
                      const v = Number((e.target as HTMLInputElement).value);
                      setSeekDrag(null);
                      void seekBgm(v);
                    }}
                    onTouchEnd={(e) => {
                      const v = Number((e.target as HTMLInputElement).value);
                      setSeekDrag(null);
                      void seekBgm(v);
                    }}
                    title={t("sfxSeek")}
                  />
                  <span className="sfx-seek-time">
                    {bgm.durationMs != null ? formatMs(bgm.durationMs) : "--:--"}
                  </span>
                </div>

                <div className="sfx-player-controls deck">
                  <button
                    type="button"
                    className="sfx-player-btn ghost"
                    title={
                      settings.loopMode === "loopList"
                        ? t("sfxLoopList")
                        : t("sfxLoopOne")
                    }
                    onClick={() =>
                      void onLoopMode(
                        settings.loopMode === "loopList" ? "loopOne" : "loopList",
                      )
                    }
                  >
                    {settings.loopMode === "loopList" ? (
                      <Repeat size={22} strokeWidth={1.75} absoluteStrokeWidth />
                    ) : (
                      <Repeat1 size={22} strokeWidth={1.75} absoluteStrokeWidth />
                    )}
                  </button>
                  <button
                    type="button"
                    className="sfx-player-btn ghost"
                    title={t("sfxPrev")}
                    disabled={myBgmEntries.length === 0}
                    onClick={() => void skipBgm(-1)}
                  >
                    <SkipBack size={22} strokeWidth={1.75} absoluteStrokeWidth fill="currentColor" />
                  </button>
                  <button
                    type="button"
                    className="sfx-player-btn primary solid"
                    disabled={!bgm.path && myBgmEntries.length === 0}
                    onClick={() =>
                      void (async () => {
                        try {
                          if (!bgm.path) {
                            if (myBgmEntries[0]) await playBgm(myBgmEntries[0].path);
                            return;
                          }
                          if (bgm.paused) await invoke("sfx_resume_bgm");
                          else if (bgm.playing) await invoke("sfx_pause_bgm");
                          else await playBgm(bgm.path);
                          await refreshBgm();
                        } catch (err) {
                        }
                      })()
                    }
                  >
                    {bgm.playing ? (
                      <Pause size={22} strokeWidth={0} absoluteStrokeWidth fill="currentColor" />
                    ) : (
                      <Play
                        size={22}
                        strokeWidth={0}
                        absoluteStrokeWidth
                        fill="currentColor"
                        style={{ marginLeft: 2 }}
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    className="sfx-player-btn ghost"
                    title={t("sfxNext")}
                    disabled={myBgmEntries.length === 0}
                    onClick={() => void skipBgm(1)}
                  >
                    <SkipForward size={22} strokeWidth={1.75} absoluteStrokeWidth fill="currentColor" />
                  </button>
                  <button
                    type="button"
                    className={
                      settings.loopMode === "shuffle"
                        ? "sfx-player-btn ghost on"
                        : "sfx-player-btn ghost"
                    }
                    title={t("sfxShuffle")}
                    onClick={() =>
                      void onLoopMode(
                        settings.loopMode === "shuffle" ? "loopOne" : "shuffle",
                      )
                    }
                  >
                    <Shuffle size={22} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                </div>

                <div className="sfx-player-extras">
                  <SfxMenuSelect
                    label={t("sfxSpeed")}
                    title={t("sfxSpeedHint")}
                    value={String(settings.bgmSpeed)}
                    options={[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((s) => ({
                      value: String(s),
                      label: s === 1 ? "1.0×" : `${s}×`,
                    }))}
                    onChange={(v) => void onBgmSpeed(Number(v))}
                  />
                  <SfxMenuSelect
                    label={t("sfxPitch")}
                    title={t("sfxPitchHint")}
                    value={String(settings.bgmPitch)}
                    options={[-6, -3, -1, 0, 1, 3, 6].map((p) => ({
                      value: String(p),
                      label: p > 0 ? `+${p}` : String(p),
                    }))}
                    onChange={(v) => void onBgmPitch(Number(v))}
                  />
                  <SfxMenuSelect
                    label={t("sfxFade")}
                    title={t("sfxFadeHint")}
                    value={String(settings.fadeMs)}
                    options={[
                      { value: "0", label: t("sfxFadeOff") },
                      { value: "250", label: "0.25s" },
                      { value: "450", label: "0.45s" },
                      { value: "800", label: "0.8s" },
                      { value: "1200", label: "1.2s" },
                    ]}
                    onChange={(v) => void onFadeMs(Number(v))}
                  />
                  <SfxVolumeButton
                    tone="bgm"
                    compact
                    title={t("sfxBgmVolume")}
                    value={settings.bgmVolume}
                    onChange={(v) => void onBgmVolume(v)}
                  />
                </div>
                </div>
              </div>
              <div className="sfx-player-list" id="sfx-bgm-list">
                <div className="sfx-player-list-head">
                  <span>{t("sfxMyBgmList")}</span>
                  <span className="muted">{myBgmEntries.length}</span>
                </div>
                {myBgmEntries.length === 0 ? (
                  <div className="empty compact">
                    <p className="muted">{t("sfxBgmEmpty")}</p>
                    <button type="button" className="empty-pick" onClick={() => setTab("library")}>
                      {t("sfxGoLibrary")}
                    </button>
                  </div>
                ) : (
                  <div className="sfx-track-list">
                    {myBgmEntries.map((e, i) => {
                      const on = bgm.path === e.path;
                      return (
                        <button
                          key={e.path}
                          type="button"
                          className={on ? "sfx-track on" : "sfx-track"}
                          onClick={() => void playBgm(e.path)}
                          onContextMenu={(ev) => openPadMenu(ev, e, "bgm")}
                        >
                          <span className="sfx-track-idx">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span className="sfx-track-body">
                            <span className="sfx-track-name">{padLabel(e)}</span>
                            <span className="sfx-track-meta">{e.category}</span>
                          </span>
                          <span className="sfx-track-time">
                            {e.durationMs != null ? formatMs(e.durationMs) : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "mysfx" && (
            <SfxHotkeysPanel
              bindings={hotkeyBindings}
              selectedId={hotkeySelectedId}
              capturing={Boolean(capturingPath || capturingStop)}
              previewHotkey={null}
              playing={playing}
              onSelect={(id) => {
                setHotkeySelectedId(id);
                setCapturingPath(null);
                setCapturingStop(false);
              }}
              onStartCapture={(id) => {
                const target = id ?? hotkeySelectedId;
                if (!target) return;
                setHotkeySelectedId(target);
                if (target === "__stop__") {
                  setCapturingStop(true);
                  setCapturingPath(null);
                } else {
                  setCapturingPath(target);
                  setCapturingStop(false);
                }
              }}
              onClear={clearHotkeyBinding}
              onTogglePlay={toggleMinePlay}
              onVirtualCommit={(hk) => {
                const id = hotkeySelectedId;
                if (!id) return;
                applyHotkey(id, hk);
              }}
              t={t}
            />
          )}

          {tab === "studio" && (
            <SfxStudioMontage
              libraryRoot={settings.libraryPath}
              incoming={studioIncoming}
              onIncomingConsumed={onStudioIncomingConsumed}
              dropApiRef={studioDropApiRef}
              studioQuery={studioQuery}
              onStudioQuery={setStudioQuery}
              studioKind={studioKind}
              onStudioKind={setStudioKind}
              studioVisible={studioVisible}
              padLabel={padLabel}
              dragOver={dragOver}
              recording={recording}
              recElapsedMs={recElapsedMs}
              recPeak={recPeak}
              onToggleRecord={() => void (recording ? stopRecording() : startRecording())}
              sfxVolume={settings.sfxVolume}
              onSfxVolume={(v) => void onSfxVolume(v)}
              sfxInterrupt={settings.interrupt}
              t={t}
              onError={setError}
              onExported={(dest, opts) => {
                void (async () => {
                  try {
                    await reloadLibrary(settingsRef.current.libraryPath);
                    setError(null);
                    if (opts?.offerMine) {
                      const next = { ...settingsRef.current };
                      if (!next.mySfx.includes(dest)) {
                        next.mySfx = [...next.mySfx, dest];
                        await persist(next);
                      }
                    }
                  } catch (err) {
                    setError(String(err));
                  }
                })();
              }}
            />
          )}
        </div>
      )}

      {showAudioSettings &&
        createPortal(
          <div
            className="sfx-settings-mask"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setShowAudioSettings(false);
            }}
          >
            <div
              ref={audioSettingsRef}
              className="sfx-settings-pop"
              role="dialog"
              aria-modal="true"
              aria-label={t("sfxAudioSettings")}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="sfx-settings-pop-title">
                {t("sfxAudioSettings")}
              </div>
              <div className="sfx-set-pane">
                <div className="sfx-set-cols">
                  <div className="sfx-set-col">
                    <div className="sfx-set-sep">{t("sfxSettingsBasic")}</div>
                    <label className="sfx-set-row">
                      <span className="sfx-set-label">{t("sfxOutputDevice")}</span>
                      <select
                        className="sfx-set-ctrl"
                        value={settings.outputDevice ?? ""}
                        onChange={(e) => void onDevice(e.target.value)}
                      >
                        <option value="">{t("sfxDefaultDevice")}</option>
                        {devices.map((d) => (
                          <option key={d.name} value={d.name}>
                            {d.isDefault ? `${d.name} ★` : d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="sfx-set-row">
                      <span className="sfx-set-label">{t("sfxMasterVolume")}</span>
                      <input
                        className="sfx-set-range"
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.01}
                        value={settings.masterVolume}
                        onChange={(e) => void onMasterVolume(Number(e.target.value))}
                      />
                    </label>
                    <div className="sfx-set-row">
                      <span className="sfx-set-label">{t("sfxStopHotkey")}</span>
                      <button
                        type="button"
                        className={
                          capturingStop ? "sfx-set-key capturing" : "sfx-set-key"
                        }
                        onClick={() => setCapturingStop(true)}
                      >
                        {capturingStop
                          ? t("sfxCaptureHint")
                          : settings.stopHotkey || t("sfxHotkeysUnset")}
                      </button>
                    </div>

                    <div className="sfx-set-sep">{t("sfxSettingsPlayGroup")}</div>
                    <label
                      className="sfx-set-row switch"
                      title={t("sfxInterruptHint")}
                    >
                      <span className="sfx-set-label">{t("sfxInterrupt")}</span>
                      <input
                        type="checkbox"
                        checked={settings.interrupt}
                        onChange={(e) => void onInterrupt(e.target.checked)}
                      />
                    </label>
                    <label className="sfx-set-row switch" title={t("sfxDuckHint")}>
                      <span className="sfx-set-label">{t("sfxDuck")}</span>
                      <input
                        type="checkbox"
                        checked={settings.duckEnabled}
                        onChange={(e) =>
                          void onDuck({ duckEnabled: e.target.checked })
                        }
                      />
                    </label>
                    {settings.duckEnabled ? (
                      <label
                        className="sfx-set-row"
                        title={t("sfxDuckFactorHint")}
                      >
                        <span className="sfx-set-label">{t("sfxDuckFactor")}</span>
                        <input
                          className="sfx-set-range"
                          type="range"
                          min={0.05}
                          max={0.8}
                          step={0.01}
                          value={settings.duckFactor}
                          onChange={(e) =>
                            void onDuck({ duckFactor: Number(e.target.value) })
                          }
                        />
                      </label>
                    ) : null}

                    <div className="sfx-set-sep">{t("sfxSettingsVoiceTab")}</div>
                    <label className="sfx-set-row switch">
                      <span className="sfx-set-label">{t("sfxVoiceDuckEnable")}</span>
                      <input
                        type="checkbox"
                        checked={settings.voiceDuckEnabled}
                        onChange={(e) =>
                          void applyVoiceDuck({
                            voiceDuckEnabled: e.target.checked,
                          })
                        }
                      />
                    </label>
                    {settings.voiceDuckEnabled ? (
                      <>
                        <label className="sfx-set-row">
                          <span className="sfx-set-label">{t("sfxVoiceDevice")}</span>
                          <select
                            className="sfx-set-ctrl"
                            value={settings.voiceDevice ?? ""}
                            onChange={(e) =>
                              void applyVoiceDuck({
                                voiceDevice: e.target.value || null,
                              })
                            }
                          >
                            <option value="">{t("sfxDefaultDevice")}</option>
                            {inputDevices.map((d) => (
                              <option key={d.name} value={d.name}>
                                {d.isDefault ? `${d.name} ★` : d.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="sfx-set-row">
                          <span className="sfx-set-label">
                            {t("sfxVoiceThreshold")}
                          </span>
                          <input
                            className="sfx-set-range"
                            type="range"
                            min={0.02}
                            max={0.4}
                            step={0.01}
                            value={settings.voiceThreshold}
                            onChange={(e) =>
                              void applyVoiceDuck({
                                voiceThreshold: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label className="sfx-set-row">
                          <span className="sfx-set-label">{t("sfxVoiceFactor")}</span>
                          <input
                            className="sfx-set-range"
                            type="range"
                            min={0.05}
                            max={0.8}
                            step={0.01}
                            value={settings.voiceFactor}
                            onChange={(e) =>
                              void applyVoiceDuck({
                                voiceFactor: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      </>
                    ) : null}
                  </div>

                  <div className="sfx-set-col">
                    <div className="sfx-set-sep">{t("sfxObsTitle")}</div>
                    <label className="sfx-set-row">
                      <span className="sfx-set-label">
                        {t("sfxObsHost")} / {t("sfxObsPort")}
                      </span>
                      <div className="sfx-set-inline">
                        <input
                          className="sfx-set-ctrl"
                          value={settings.obsHost}
                          onChange={(e) =>
                            void persist({
                              ...settingsRef.current,
                              obsHost: e.target.value,
                            })
                          }
                        />
                        <input
                          className="sfx-set-num"
                          type="number"
                          value={settings.obsPort}
                          onChange={(e) =>
                            void persist({
                              ...settingsRef.current,
                              obsPort: Number(e.target.value) || 4455,
                            })
                          }
                        />
                      </div>
                    </label>
                    <label className="sfx-set-row">
                      <span className="sfx-set-label">{t("sfxObsPassword")}</span>
                      <input
                        className="sfx-set-ctrl"
                        type="password"
                        value={settings.obsPassword}
                        onChange={(e) =>
                          void persist({
                            ...settingsRef.current,
                            obsPassword: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="sfx-set-row">
                      <span className="sfx-set-label">{t("sfxObsMedia")}</span>
                      <input
                        className="sfx-set-ctrl"
                        value={settings.obsMediaInput}
                        placeholder={t("sfxObsMediaHint")}
                        onChange={(e) =>
                          void persist({
                            ...settingsRef.current,
                            obsMediaInput: e.target.value,
                          })
                        }
                      />
                    </label>
                    <div className="sfx-set-row">
                      <span className="sfx-set-label" />
                      <div className="sfx-set-actions">
                        <button
                          type="button"
                          className={
                            obsConnected ? "sfx-set-btn on" : "sfx-set-btn"
                          }
                          onClick={() =>
                            void (async () => {
                              try {
                                await invoke("obs_configure", {
                                  host: settingsRef.current.obsHost,
                                  port: settingsRef.current.obsPort,
                                  password: settingsRef.current.obsPassword,
                                  seekCompensateMs:
                                    settingsRef.current.obsSeekCompensateMs,
                                  mediaInput:
                                    settingsRef.current.obsMediaInput || null,
                                });
                                const st = await invoke<{
                                  connected: boolean;
                                  scenes: string[];
                                }>("obs_connect");
                                setObsConnected(st.connected);
                                setObsScenes(st.scenes ?? []);
                              } catch {
                                setObsConnected(false);
                              }
                            })()
                          }
                        >
                          {obsConnected
                            ? t("sfxObsReconnect")
                            : t("sfxObsConnect")}
                        </button>
                        {obsScenes.length > 0 ? (
                          <select
                            className="sfx-set-ctrl"
                            onChange={(e) => {
                              if (!e.target.value) return;
                              void invoke("obs_set_scene", {
                                scene: e.target.value,
                              }).catch(() => {});
                            }}
                            defaultValue=""
                          >
                            <option value="">{t("sfxObsPickScene")}</option>
                            {obsScenes.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
                    </div>

                    <div
                      className="sfx-set-sep"
                      title={t("sfxMidiHint")}
                    >
                      {t("sfxMidiTitle")}
                    </div>
                    <label
                      className="sfx-set-row switch"
                      title={t("sfxMidiHint")}
                    >
                      <span className="sfx-set-label">{t("sfxMidiEnable")}</span>
                      <input
                        type="checkbox"
                        checked={settings.midiEnabled}
                        onChange={(e) =>
                          void (async () => {
                            const midiEnabled = e.target.checked;
                            await persist({
                              ...settingsRef.current,
                              midiEnabled,
                            });
                            try {
                              await invoke("midi_configure", {
                                enabled: midiEnabled,
                                portName: settingsRef.current.midiPort,
                                fps: settingsRef.current.midiFps,
                                offsetMs: settingsRef.current.midiOffsetMs,
                              });
                              const ports = await invoke<string[]>(
                                "midi_list_ports",
                              );
                              setMidiPorts(ports);
                            } catch {
                              /* ignore */
                            }
                          })()
                        }
                      />
                    </label>
                    {settings.midiEnabled ? (
                      <>
                        <label className="sfx-set-row">
                          <span className="sfx-set-label">{t("sfxMidiPort")}</span>
                          <select
                            className="sfx-set-ctrl"
                            value={settings.midiPort ?? ""}
                            onChange={(e) =>
                              void (async () => {
                                const midiPort = e.target.value || null;
                                await persist({
                                  ...settingsRef.current,
                                  midiPort,
                                });
                                await invoke("midi_configure", {
                                  enabled: settingsRef.current.midiEnabled,
                                  portName: midiPort,
                                  fps: settingsRef.current.midiFps,
                                  offsetMs: settingsRef.current.midiOffsetMs,
                                });
                              })()
                            }
                          >
                            <option value="">{t("sfxDefaultDevice")}</option>
                            {midiPorts.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="sfx-set-row">
                          <span className="sfx-set-label">{t("sfxMidiFps")}</span>
                          <select
                            className="sfx-set-num"
                            value={String(settings.midiFps)}
                            onChange={(e) =>
                              void (async () => {
                                const midiFps = Number(e.target.value) || 30;
                                await persist({
                                  ...settingsRef.current,
                                  midiFps,
                                });
                                await invoke("midi_configure", {
                                  enabled: settingsRef.current.midiEnabled,
                                  portName: settingsRef.current.midiPort,
                                  fps: midiFps,
                                  offsetMs: settingsRef.current.midiOffsetMs,
                                });
                              })()
                            }
                          >
                            {[24, 25, 30].map((f) => (
                              <option key={f} value={String(f)}>
                                {f}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <ContextMenu menu={ctx} onClose={() => setCtx(null)} />
      {vinylCropSrc ? (
        <ImageCropModal
          src={vinylCropSrc}
          onCancel={() => {
            if (vinylCropSrc.startsWith("blob:")) {
              URL.revokeObjectURL(vinylCropSrc);
            }
            setVinylCropSrc(null);
          }}
          onConfirm={(dataUrl) => {
            if (vinylCropSrc.startsWith("blob:")) {
              URL.revokeObjectURL(vinylCropSrc);
            }
            setVinylCropSrc(null);
            void persist({
              ...settingsRef.current,
              vinylArtDataUrl: dataUrl,
            });
          }}
        />
      ) : null}
    </div>
  );
}
