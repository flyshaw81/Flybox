import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Mic,
  Square,
  Trash2,
  Plus,
  Minus,
  MousePointer2,
  Scissors,
  SplitSquareHorizontal,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Magnet,
  Download,
  FolderOpen,
  Star,
  X,
  Search,
  ChevronDown,
} from "lucide-react";
import ContextMenu, { openCtxMenu, type CtxMenuState } from "./ContextMenu";
import SfxVolumeButton from "./SfxVolumeButton";
import { loadPeaks, peaksSvgPath } from "./sfxWaveformPeaks";

type TFn = (key: string) => string;

export type StudioEntry = {
  path: string;
  name: string;
  category: string;
  durationMs?: number | null;
};

type Track = { id: string; name: string; muted: boolean };

type TlClip = {
  id: string;
  trackId: string;
  path: string;
  label: string;
  mediaMs: number;
  srcStartMs: number;
  srcEndMs: number;
  atMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Clip gain in dB (0 = unity). CapCut-style volume rubber band. */
  gainDb: number;
  /** 变速：1 = 原速 */
  speed: number;
  /** 变调：半音，0 = 原调 */
  pitchSemitones: number;
};

type InspectorTab = "basic" | "voice" | "fx" | "speed";

type EditMode = "selection" | "blade";

const VOICE_PRESETS: { id: string; pitch: number }[] = [
  { id: "none", pitch: 0 },
  { id: "low", pitch: -4 },
  { id: "deep", pitch: -7 },
  { id: "bright", pitch: 4 },
  { id: "chip", pitch: 7 },
];

type DragKind = "move" | "trim-left" | "trim-right";

/** Preview on pointermove; commit on pointerup (OpenChatCut). */
type DragState = {
  kind: DragKind;
  id: string;
  startX: number;
  baseAt: number;
  baseTrackId: string;
  baseSrcStart: number;
  baseSrcEnd: number;
  mediaMs: number;
  deltaMs: number;
  targetTrackId: string;
  /** Timeline ms of the edge currently locked to a snap target. */
  snapGuideMs: number | null;
};

type VolDrag = {
  id: string;
  startY: number;
  baseDb: number;
  gainDb: number;
};

type FadeDrag = {
  id: string;
  kind: "in" | "out";
  startX: number;
  baseMs: number;
  fadeMs: number;
};

const TRACK_H = 56;
const RULER_H = 30;
const MIN_CLIP_MS = 80;
const SNAP_PX = 8;
/** Visual / edit range; 0dB sits at mid-clip like CapCut. */
const VOL_MIN_DB = -18;
const VOL_MAX_DB = 18;
const LIB_MIME = "application/x-flyphoto-sfx";

function clampGainDb(db: number): number {
  return Math.max(VOL_MIN_DB, Math.min(VOL_MAX_DB, db));
}

/** CapCut-style mm:ss for library cards / mini player */
function formatLibMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/** 正在打字时不抢快捷键；点时间线后焦点离开输入框即可用 */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return ![
      "button",
      "checkbox",
      "radio",
      "range",
      "file",
      "submit",
      "reset",
      "color",
    ].includes(type);
  }
  return false;
}

function dbToLinear(db: number): number {
  if (db <= VOL_MIN_DB) return 0;
  return Math.pow(10, clampGainDb(db) / 20);
}

function fmtGainDb(db: number): string {
  const v = Math.round(clampGainDb(db) * 10) / 10;
  if (Object.is(v, -0) || Math.abs(v) < 0.05) return "0dB";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}dB`;
}

/** Map dB → vertical fraction inside clip (0 = top / +12dB, 1 = bottom / -60dB). */
function gainDbToYFrac(db: number): number {
  return (VOL_MAX_DB - clampGainDb(db)) / (VOL_MAX_DB - VOL_MIN_DB);
}

function yDeltaToDb(deltaY: number, clipH: number): number {
  const span = VOL_MAX_DB - VOL_MIN_DB;
  return (-deltaY / Math.max(1, clipH)) * span;
}

function fmtFadeSec(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

function clampFadePair(
  fadeInMs: number,
  fadeOutMs: number,
  durMs: number,
): { fadeInMs: number; fadeOutMs: number } {
  const maxTotal = Math.max(0, durMs - 20);
  let fi = Math.max(0, Math.round(fadeInMs));
  let fo = Math.max(0, Math.round(fadeOutMs));
  if (fi + fo > maxTotal) {
    const scale = maxTotal / Math.max(1, fi + fo);
    fi = Math.round(fi * scale);
    fo = Math.max(0, maxTotal - fi);
  }
  return { fadeInMs: fi, fadeOutMs: fo };
}

function collectSnapTargets(
  clips: TlClip[],
  excludeId: string,
  playheadMs: number,
): number[] {
  const pts = [0, Math.max(0, playheadMs)];
  for (const c of clips) {
    if (c.id === excludeId) continue;
    pts.push(c.atMs);
    pts.push(c.atMs + clipDurationMs(c));
  }
  return pts;
}

/** Snap a time to the nearest target within threshold; returns [snapped, guideMs|null]. */
function snapTime(
  raw: number,
  targets: number[],
  threshMs: number,
): { value: number; guide: number | null } {
  let best = raw;
  let bestDist = threshMs + 1;
  for (const t of targets) {
    const dist = Math.abs(raw - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  if (bestDist <= threshMs) return { value: best, guide: best };
  return { value: raw, guide: null };
}

function snapDragDelta(
  d: DragState,
  rawDelta: number,
  targets: number[],
  threshMs: number,
): { deltaMs: number; snapGuideMs: number | null } {
  const dur = Math.max(MIN_CLIP_MS, d.baseSrcEnd - d.baseSrcStart);
  if (d.kind === "move") {
    const rawAt = Math.max(0, d.baseAt + rawDelta);
    const rawEnd = rawAt + dur;
    const left = snapTime(rawAt, targets, threshMs);
    const right = snapTime(rawEnd, targets, threshMs);
    const dL = Math.abs(left.value - rawAt);
    const dR = Math.abs(right.value - rawEnd);
    if (left.guide != null && (right.guide == null || dL <= dR)) {
      return { deltaMs: left.value - d.baseAt, snapGuideMs: left.guide };
    }
    if (right.guide != null) {
      return {
        deltaMs: right.value - dur - d.baseAt,
        snapGuideMs: right.guide,
      };
    }
    return { deltaMs: rawDelta, snapGuideMs: null };
  }
  if (d.kind === "trim-left") {
    const rawAt = Math.max(0, d.baseAt + rawDelta);
    const s = snapTime(rawAt, targets, threshMs);
    return { deltaMs: s.value - d.baseAt, snapGuideMs: s.guide };
  }
  // trim-right: right edge = baseAt + (baseSrcEnd + delta - baseSrcStart)
  const rawEnd = d.baseAt + dur + rawDelta;
  const s = snapTime(rawEnd, targets, threshMs);
  return {
    deltaMs: s.value - (d.baseAt + dur),
    snapGuideMs: s.guide,
  };
}

function fmtShort(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
}

function fmtTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const cs = Math.floor((Math.max(0, ms) % 1000) / 10);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs
    .toString()
    .padStart(2, "0")}`;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function defaultTracks(t: TFn): Track[] {
  return [{ id: "tr1", name: `${t("sfxStudioTrack")} 1`, muted: false }];
}

function clipDurationMs(c: {
  srcStartMs: number;
  srcEndMs: number;
  speed?: number;
}): number {
  const raw = Math.max(0, c.srcEndMs - c.srcStartMs);
  const speed = Math.max(0.25, Math.min(4, c.speed ?? 1));
  return Math.max(0, Math.round(raw / speed));
}

export type StudioDropTarget = { trackId: string; atMs: number };

export type StudioDropApi = {
  hitTest: (clientX: number, clientY: number) => StudioDropTarget;
  setOsHover: (pos: { clientX: number; clientY: number } | null) => void;
};

export type StudioIncoming = {
  paths: string[];
  trackId?: string;
  atMs?: number;
};

function ClipWaveform({
  path,
  mediaMs,
  srcStartMs,
  srcEndMs,
  width,
}: {
  path: string;
  mediaMs: number;
  srcStartMs: number;
  srcEndMs: number;
  width: number;
  pxPerSec?: number;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadPeaks>> | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    // 带时长提示：后端一次算准 bucket，避免浏览器整文件解码
    void loadPeaks(path, mediaMs > 0 ? mediaMs : null)
      .then((p) => {
        if (alive) setData(p);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [path, mediaMs]);
  const d = useMemo(() => {
    if (!data || width < 4) return "";
    return peaksSvgPath(data, width, 28, srcStartMs, srcEndMs);
  }, [data, width, srcStartMs, srcEndMs]);
  if (!d) return null;
  return (
    <svg
      className="sfx-tl-wave"
      viewBox={`0 0 ${Math.max(1, width)} 28`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

function previewClip(
  c: TlClip,
  drag: DragState | null,
): { atMs: number; srcStartMs: number; srcEndMs: number; trackId: string } {
  if (!drag || drag.id !== c.id) {
    return {
      atMs: c.atMs,
      srcStartMs: c.srcStartMs,
      srcEndMs: c.srcEndMs,
      trackId: c.trackId,
    };
  }
  const d = drag.deltaMs;
  if (drag.kind === "move") {
    return {
      atMs: Math.max(0, drag.baseAt + d),
      srcStartMs: c.srcStartMs,
      srcEndMs: c.srcEndMs,
      trackId: drag.targetTrackId || drag.baseTrackId,
    };
  }
  if (drag.kind === "trim-left") {
    let srcStart = drag.baseSrcStart + d;
    let at = drag.baseAt + d;
    srcStart = Math.max(0, Math.min(srcStart, drag.baseSrcEnd - MIN_CLIP_MS));
    at = drag.baseAt + (srcStart - drag.baseSrcStart);
    if (at < 0) {
      srcStart -= at;
      at = 0;
    }
    return {
      atMs: at,
      srcStartMs: srcStart,
      srcEndMs: drag.baseSrcEnd,
      trackId: c.trackId,
    };
  }
  // trim-right
  let srcEnd = drag.baseSrcEnd + d;
  const maxEnd = Math.max(drag.mediaMs, drag.baseSrcEnd);
  srcEnd = Math.max(drag.baseSrcStart + MIN_CLIP_MS, Math.min(srcEnd, maxEnd));
  return {
    atMs: drag.baseAt,
    srcStartMs: drag.baseSrcStart,
    srcEndMs: srcEnd,
    trackId: c.trackId,
  };
}

export default function SfxStudioMontage({
  libraryRoot,
  incoming,
  onIncomingConsumed,
  dropApiRef,
  studioQuery,
  onStudioQuery,
  studioKind,
  onStudioKind,
  studioFavFilter,
  onStudioFavFilter,
  studioVisible,
  favoritedPaths,
  onToggleFavorite,
  padLabel,
  dragOver,
  recording,
  recElapsedMs,
  recPeak,
  onToggleRecord,
  sfxVolume,
  onSfxVolume,
  sfxInterrupt,
  t,
  onError,
  onExported,
}: {
  libraryRoot: string | null;
  incoming: StudioIncoming | null;
  onIncomingConsumed: () => void;
  dropApiRef?: MutableRefObject<StudioDropApi | null>;
  studioQuery: string;
  onStudioQuery: (q: string) => void;
  studioKind: "sfx" | "bgm" | "fav";
  onStudioKind: (k: "sfx" | "bgm" | "fav") => void;
  studioFavFilter: "all" | "sfx" | "bgm";
  onStudioFavFilter: (f: "all" | "sfx" | "bgm") => void;
  studioVisible: StudioEntry[];
  favoritedPaths: string[];
  onToggleFavorite: (path: string) => void;
  padLabel: (e: { path: string; name: string; category: string }) => string;
  dragOver: boolean;
  recording: boolean;
  recElapsedMs: number;
  recPeak: number;
  onToggleRecord: () => void;
  sfxVolume: number;
  onSfxVolume: (v: number) => void;
  sfxInterrupt: boolean;
  t: TFn;
  onError: (err: string) => void;
  onExported: (dest: string, opts?: { offerMine?: boolean }) => void;
}) {
  const [tracks, setTracks] = useState<Track[]>(() => defaultTracks(t));
  const [clips, setClips] = useState<TlClip[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTrackId, setActiveTrackId] = useState("tr1");
  const [libDropTrack, setLibDropTrack] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(36);
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<"mine" | "file">("mine");
  const [exportAddMine, setExportAddMine] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>("selection");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("basic");
  /** CapCut-style library mini player */
  const [libPick, setLibPick] = useState<StudioEntry | null>(null);
  const [libPlaying, setLibPlaying] = useState(false);
  const [libPosMs, setLibPosMs] = useState(0);
  const libPlayGen = useRef(0);
  const libRafRef = useRef(0);
  const libStartRef = useRef(0);
  const favoritedSet = useMemo(
    () => new Set(favoritedPaths),
    [favoritedPaths],
  );
  const [snapping, setSnapping] = useState(true);
  /** 上半区高度占比（素材+声音）；可拖边界改 */
  const [upperPct, setUpperPct] = useState(38);
  /** 声音设置宽度 px；可拖边界改 */
  const [inspW, setInspW] = useState(300);
  /** 收藏筛选：自定义下拉（不用原生 select） */
  const [favFilterOpen, setFavFilterOpen] = useState(false);
  const favFilterRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [volDrag, setVolDrag] = useState<VolDrag | null>(null);
  const [fadeDrag, setFadeDrag] = useState<FadeDrag | null>(null);
  const [ctx, setCtx] = useState<CtxMenuState>(null);
  const previewGen = useRef(0);
  const previewTimersRef = useRef<number[]>([]);
  const previewingRef = useRef(false);
  previewingRef.current = previewing;
  const sfxVolumeRef = useRef(sfxVolume);
  sfxVolumeRef.current = sfxVolume;
  /** True when volume-drag started its own audition voice (not mix preview). */
  const volMonitorRef = useRef(false);
  const volMonitorGen = useRef(0);
  const sfxInterruptRef = useRef(sfxInterrupt);
  sfxInterruptRef.current = sfxInterrupt;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  const activeTrackRef = useRef(activeTrackId);
  activeTrackRef.current = activeTrackId;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  /** 拖片段：只在 handler 里写 dragRef，禁止每帧 render 回写（否则会冲掉实时 delta） */
  const dragRef = useRef<DragState | null>(null);
  const dragElRef = useRef<HTMLElement | null>(null);
  const dragBaseLeftPxRef = useRef(0);
  const dragBaseWidthPxRef = useRef(0);
  const dragSnapTargetsRef = useRef<number[]>([]);
  const dragWinCleanupRef = useRef<(() => void) | null>(null);
  const snapGuideLineRef = useRef<HTMLDivElement | null>(null);
  const upperElRef = useRef<HTMLDivElement | null>(null);
  const inspElRef = useRef<HTMLElement | null>(null);
  const volDragRef = useRef<VolDrag | null>(null);
  volDragRef.current = volDrag;
  const fadeDragRef = useRef<FadeDrag | null>(null);
  fadeDragRef.current = fadeDrag;
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;
  const snappingRef = useRef(snapping);
  snappingRef.current = snapping;
  const playheadRef = useRef(0);
  const scrubbingRef = useRef(false);
  const scrubRafRef = useRef(0);
  const pendingScrubMsRef = useRef<number | null>(null);
  const lastTcPaintRef = useRef(0);
  const previewRafRef = useRef(0);
  const paintPlayheadRef = useRef<(ms: number, forceTc?: boolean) => void>(
    () => {},
  );
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const activeTrackIdRef = useRef(activeTrackId);
  activeTrackIdRef.current = activeTrackId;
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;
  const exportOpenRef = useRef(exportOpen);
  exportOpenRef.current = exportOpen;
  /** 剪映式撤销栈（只记片段） */
  const undoStackRef = useRef<TlClip[][]>([]);
  const redoStackRef = useRef<TlClip[][]>([]);
  const clipboardRef = useRef<TlClip | null>(null);

  const pushUndo = useCallback(() => {
    undoStackRef.current.push(clipsRef.current.map((c) => ({ ...c })));
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, []);

  const applyClips = useCallback((next: TlClip[]) => {
    clipsRef.current = next;
    setClips(next);
  }, []);

  const undoEdit = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push(clipsRef.current.map((c) => ({ ...c })));
    applyClips(prev);
    void invoke("sfx_stop_sfx").catch(() => {});
    setPreviewing(false);
  }, [applyClips]);

  const redoEdit = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(clipsRef.current.map((c) => ({ ...c })));
    applyClips(next);
    void invoke("sfx_stop_sfx").catch(() => {});
    setPreviewing(false);
  }, [applyClips]);

  /** OpenChatCut-style: paint playhead via GPU transform, no React re-render. */
  const paintPlayhead = useCallback((ms: number, forceTc = false) => {
    const current = Math.max(0, ms);
    playheadRef.current = current;
    const x = (current / 1000) * pxPerSecRef.current;
    const line = playheadLineRef.current;
    if (line) line.style.transform = `translate3d(${x}px,0,0)`;
    const now = performance.now();
    if (forceTc || now - lastTcPaintRef.current > 80) {
      lastTcPaintRef.current = now;
      if (timecodeRef.current) {
        timecodeRef.current.textContent = fmtTimecode(current);
      }
    }
  }, []);
  paintPlayheadRef.current = paintPlayhead;

  useEffect(() => {
    paintPlayhead(playheadRef.current, true);
  }, [pxPerSec, paintPlayhead]);

  const stopPlayheadFollow = useCallback(() => {
    if (previewRafRef.current) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = 0;
    }
  }, []);

  const startPlayheadFollow = useCallback(
    (fromMs: number, endMs: number, gen: number) => {
      stopPlayheadFollow();
      const wall0 = performance.now();
      paintPlayheadRef.current(fromMs, true);
      const tick = () => {
        if (previewGen.current !== gen) {
          previewRafRef.current = 0;
          return;
        }
        const ms = fromMs + (performance.now() - wall0);
        if (ms >= endMs) {
          paintPlayheadRef.current(endMs, true);
          previewRafRef.current = 0;
          return;
        }
        paintPlayheadRef.current(ms);
        // Keep red line in view while playing.
        const sc = scrollRef.current;
        if (sc) {
          const x = (ms / 1000) * pxPerSecRef.current;
          const left = sc.scrollLeft;
          const right = left + sc.clientWidth;
          if (x > right - 48) sc.scrollLeft = x - sc.clientWidth * 0.65;
          else if (x < left + 24) sc.scrollLeft = Math.max(0, x - 24);
        }
        previewRafRef.current = requestAnimationFrame(tick);
      };
      previewRafRef.current = requestAnimationFrame(tick);
    },
    [stopPlayheadFollow],
  );

  const projectEndMs = useMemo(() => {
    let end = 10000;
    for (const c of clips) {
      const p = previewClip(c, drag);
      end = Math.max(end, p.atMs + (p.srcEndMs - p.srcStartMs));
    }
    return end + 4000;
  }, [clips, drag]);

  const timelineW = Math.max(720, (projectEndMs / 1000) * pxPerSec);

  const rulerMarks = useMemo(() => {
    const marks: number[] = [];
    // Match Jianying: when zoomed far out, tick every 30s/1min so a long song
    // can shrink to a short strip on the timeline.
    const step =
      pxPerSec >= 80
        ? 1
        : pxPerSec >= 40
          ? 2
          : pxPerSec >= 16
            ? 5
            : pxPerSec >= 6
              ? 10
              : pxPerSec >= 2
                ? 30
                : 60;
    const endSec = Math.ceil(projectEndMs / 1000);
    for (let s = 0; s <= endSec; s += step) marks.push(s);
    return marks;
  }, [projectEndMs, pxPerSec]);

  const trackFromClientY = useCallback((clientY: number): string => {
    const root = lanesRef.current;
    const list = tracksRef.current;
    if (!root || list.length === 0) return activeTrackRef.current;
    const rect = root.getBoundingClientRect();
    const y = clientY - rect.top;
    const idx = Math.max(0, Math.min(list.length - 1, Math.floor(y / TRACK_H)));
    return list[idx].id;
  }, []);

  const atMsFromClientX = useCallback(
    (clientX: number) => {
      const sc = scrollRef.current;
      if (!sc) return 0;
      const x = clientX - sc.getBoundingClientRect().left + sc.scrollLeft;
      return Math.max(0, Math.round((x / pxPerSec) * 1000));
    },
    [pxPerSec],
  );

  const addPath = useCallback(
    async (
      path: string,
      labelHint?: string,
      trackId?: string,
      atMsHint?: number,
    ): Promise<number> => {
      if (!path) return 0;
      let dur = 0;
      try {
        const info = await invoke<{ durationMs?: number | null }>("sfx_probe", {
          path,
        });
        dur = Math.max(0, info.durationMs ?? 0);
      } catch {
        dur = 0;
      }
      const mediaMs = dur > 0 ? dur : 2000;
      const label =
        labelHint ||
        path
          .replace(/\\/g, "/")
          .split("/")
          .pop()
          ?.replace(/\.[^.]+$/, "") ||
        path;
      const tid =
        trackId || activeTrackRef.current || tracksRef.current[0]?.id || "tr1";
      let atMs = atMsHint ?? 0;
      if (atMsHint == null) {
        for (const c of clipsRef.current) {
          if (c.trackId !== tid) continue;
          atMs = Math.max(atMs, c.atMs + (c.srcEndMs - c.srcStartMs));
        }
      }
      const clip: TlClip = {
        id: newId("clip"),
        trackId: tid,
        path,
        label,
        mediaMs,
        srcStartMs: 0,
        srcEndMs: mediaMs,
        atMs,
        fadeInMs: 0,
        fadeOutMs: 0,
        gainDb: 0,
        speed: 1,
        pitchSemitones: 0,
      };
      // Keep ref in sync so sequential batch drops land after each other.
      clipsRef.current = [...clipsRef.current, clip];
      setClips((prev) => [...prev, clip]);
      setSelectedId(clip.id);
      setActiveTrackId(tid);
      setEditMode("selection");
      return mediaMs;
    },
    [],
  );

  const stopLibPreview = useCallback(async () => {
    libPlayGen.current += 1;
    if (libRafRef.current) {
      cancelAnimationFrame(libRafRef.current);
      libRafRef.current = 0;
    }
    setLibPlaying(false);
    setLibPosMs(0);
    try {
      await invoke("sfx_stop_sfx");
    } catch {
      /* ignore */
    }
  }, []);

  const tickLibProgress = useCallback((gen: number, durationMs: number) => {
    const step = () => {
      if (libPlayGen.current !== gen) return;
      const elapsed = performance.now() - libStartRef.current;
      if (elapsed >= durationMs) {
        setLibPosMs(durationMs);
        setLibPlaying(false);
        libRafRef.current = 0;
        return;
      }
      setLibPosMs(elapsed);
      libRafRef.current = requestAnimationFrame(step);
    };
    libRafRef.current = requestAnimationFrame(step);
  }, []);

  const playLibPreview = useCallback(
    async (entry: StudioEntry) => {
      const gen = ++libPlayGen.current;
      if (libRafRef.current) {
        cancelAnimationFrame(libRafRef.current);
        libRafRef.current = 0;
      }
      setLibPick(entry);
      setLibPosMs(0);
      setLibPlaying(true);
      try {
        await invoke("sfx_play", {
          path: entry.path,
          volume: sfxVolumeRef.current,
          fadeMs: 0,
          pitch: 0,
        });
        if (libPlayGen.current !== gen) return;
        let dur = entry.durationMs ?? 0;
        if (!dur || dur <= 0) {
          try {
            const info = await invoke<{ durationMs?: number | null }>(
              "sfx_probe",
              { path: entry.path },
            );
            dur = info.durationMs ?? 0;
            if (dur > 0) {
              setLibPick((prev) =>
                prev && prev.path === entry.path
                  ? { ...prev, durationMs: dur }
                  : prev,
              );
            }
          } catch {
            /* ignore */
          }
        }
        const hold = Math.max(400, dur || 2000);
        libStartRef.current = performance.now();
        tickLibProgress(gen, hold);
      } catch (e) {
        if (libPlayGen.current !== gen) return;
        setLibPlaying(false);
        onError(String(e));
      }
    },
    [onError, tickLibProgress],
  );

  const toggleLibPlay = useCallback(() => {
    if (!libPick) return;
    if (libPlaying) {
      void stopLibPreview().then(() => {
        setLibPick(libPick);
      });
      return;
    }
    void playLibPreview(libPick);
  }, [libPick, libPlaying, playLibPreview, stopLibPreview]);

  const closeLibPlayer = useCallback(() => {
    void stopLibPreview();
    setLibPick(null);
  }, [stopLibPreview]);

  useEffect(() => {
    return () => {
      libPlayGen.current += 1;
      if (libRafRef.current) cancelAnimationFrame(libRafRef.current);
    };
  }, []);

  useEffect(() => {
    void stopLibPreview();
    setLibPick(null);
    setFavFilterOpen(false);
  }, [studioKind, stopLibPreview]);

  useEffect(() => {
    if (!favFilterOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!favFilterRef.current?.contains(e.target as Node)) {
        setFavFilterOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFavFilterOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [favFilterOpen]);

  const hitTest = useCallback(
    (clientX: number, clientY: number): StudioDropTarget => {
      const trackId = trackFromClientY(clientY);
      const sc = scrollRef.current;
      if (!sc) return { trackId, atMs: 0 };
      const x = clientX - sc.getBoundingClientRect().left + sc.scrollLeft;
      const atMs = Math.max(0, Math.round((x / pxPerSecRef.current) * 1000));
      return { trackId, atMs };
    },
    [trackFromClientY],
  );

  const lastHoverRef = useRef<{ trackId: string; atMs: number } | null>(null);

  useEffect(() => {
    if (!dropApiRef) return;
    dropApiRef.current = {
      hitTest,
      setOsHover: (pos) => {
        if (!pos) {
          lastHoverRef.current = null;
          setLibDropTrack(null);
          return;
        }
        const hit = hitTest(pos.clientX, pos.clientY);
        const prev = lastHoverRef.current;
        // Avoid re-render storms while dragging OS files over the window.
        if (
          prev &&
          prev.trackId === hit.trackId &&
          Math.abs(prev.atMs - hit.atMs) < 40
        ) {
          return;
        }
        lastHoverRef.current = hit;
        setLibDropTrack(hit.trackId);
        setActiveTrackId(hit.trackId);
        paintPlayhead(hit.atMs);
      },
    };
    return () => {
      dropApiRef.current = null;
    };
  }, [dropApiRef, hitTest, paintPlayhead]);

  /** Used tracks (stable order) + orphan clip lanes + exactly one empty spare. */
  const compactTracksOneEmpty = useCallback(() => {
    const prev = tracksRef.current;
    const clips = clipsRef.current;
    const used: Track[] = [];
    const seen = new Set<string>();
    for (const tr of prev) {
      if (!clips.some((c) => c.trackId === tr.id)) continue;
      used.push(tr);
      seen.add(tr.id);
    }
    for (const c of clips) {
      if (seen.has(c.trackId)) continue;
      used.push({ id: c.trackId, name: "", muted: false });
      seen.add(c.trackId);
    }
    const next: Track[] = used.map((tr, i) => ({
      ...tr,
      muted: Boolean(tr.muted),
      name: `${t("sfxStudioTrack")} ${i + 1}`,
    }));
    next.push({
      id: newId("tr"),
      name: `${t("sfxStudioTrack")} ${next.length + 1}`,
      muted: false,
    });
    tracksRef.current = next;
    setTracks(next);
    if (!next.some((tr) => tr.id === activeTrackRef.current)) {
      setActiveTrackId(next[0]?.id ?? "tr1");
    }
  }, [t]);

  const ingestingRef = useRef(false);
  const pendingIncomingRef = useRef<StudioIncoming | null>(null);

  useEffect(() => {
    if (!incoming?.paths.length) return;
    // 正在入库时先排队，避免 ingesting 锁把这一批直接丢掉
    if (ingestingRef.current) {
      pendingIncomingRef.current = incoming;
      onIncomingConsumed();
      return;
    }
    const run = async (batch: StudioIncoming) => {
      ingestingRef.current = true;
      try {
        const paths = batch.paths;
        const at = batch.atMs ?? 0;

        if (paths.length === 1) {
          const tid =
            batch.trackId &&
            tracksRef.current.some((tr) => tr.id === batch.trackId)
              ? batch.trackId
              : undefined;
          await addPath(paths[0]!, undefined, tid, batch.atMs);
          compactTracksOneEmpty();
          return;
        }

        // Multi-drop: keep lanes that already have clips, append N new lanes, then +1 spare.
        const keep = tracksRef.current.filter((tr) =>
          clipsRef.current.some((c) => c.trackId === tr.id),
        );
        const trackIds = paths.map(() => newId("tr"));
        const built: Track[] = [
          ...keep,
          ...trackIds.map((id) => ({ id, name: "", muted: false })),
        ].map((tr, i) => ({
          ...tr,
          muted: Boolean(tr.muted),
          name: `${t("sfxStudioTrack")} ${i + 1}`,
        }));
        tracksRef.current = built;
        setTracks(built);

        for (let i = 0; i < paths.length; i++) {
          await addPath(paths[i]!, undefined, trackIds[i], at);
        }
        compactTracksOneEmpty();
        setActiveTrackId(trackIds[0]);
        paintPlayhead(at, true);
      } finally {
        ingestingRef.current = false;
        const queued = pendingIncomingRef.current;
        pendingIncomingRef.current = null;
        if (queued?.paths.length) {
          void run(queued);
        }
      }
    };
    const batch = incoming;
    onIncomingConsumed();
    void run(batch);
  }, [incoming, onIncomingConsumed, addPath, compactTracksOneEmpty, t, paintPlayhead]);

  const openClipMenu = (e: ReactMouseEvent, clip: TlClip) => {
    setSelectedId(clip.id);
    setActiveTrackId(clip.trackId);
    const cutAt = atMsFromClientX(e.clientX);
    openCtxMenu(
      e,
      [
        {
          id: "split",
          label: t("sfxStudioSplitHere"),
          onClick: () => {
            splitClipAt(clip.id, cutAt);
            paintPlayhead(cutAt, true);
          },
        },
        { id: "sep", separator: true },
        {
          id: "delete",
          label: t("sfxStudioDelete"),
          danger: true,
          onClick: () => removeClip(clip.id),
        },
      ],
      setCtx,
    );
  };

  const addTrack = () => {
    const n = tracks.length + 1;
    const id = newId("tr");
    setTracks((prev) => [
      ...prev,
      { id, name: `${t("sfxStudioTrack")} ${n}`, muted: false },
    ]);
    setActiveTrackId(id);
  };

  const toggleTrackMute = (trackId: string) => {
    setTracks((prev) => {
      const next = prev.map((tr) =>
        tr.id === trackId ? { ...tr, muted: !tr.muted } : tr,
      );
      tracksRef.current = next;
      return next;
    });
  };

  const splitClipAt = useCallback(
    (clipId: string, cutAtMs: number) => {
      const prev = clipsRef.current;
      const c = prev.find((x) => x.id === clipId);
      if (!c) return;
      const dur = clipDurationMs(c);
      const offset = Math.round(cutAtMs - c.atMs);
      if (offset < MIN_CLIP_MS || offset > dur - MIN_CLIP_MS) return;
      const cutSrc = c.srcStartMs + offset;
      if (cutSrc <= c.srcStartMs || cutSrc >= c.srcEndMs) return;
      const left: TlClip = {
        ...c,
        srcEndMs: cutSrc,
        fadeOutMs: 0,
      };
      const right: TlClip = {
        ...c,
        id: newId("clip"),
        srcStartMs: cutSrc,
        atMs: c.atMs + offset,
        fadeInMs: 0,
      };
      pushUndo();
      applyClips(prev.flatMap((x) => (x.id === clipId ? [left, right] : [x])));
    },
    [applyClips, pushUndo],
  );

  const findClipAtPlayhead = useCallback((): TlClip | null => {
    const ph = playheadRef.current;
    const list = clipsRef.current;
    const sel = selectedIdRef.current
      ? list.find((c) => c.id === selectedIdRef.current)
      : null;
    if (
      sel &&
      ph >= sel.atMs + 1 &&
      ph <= sel.atMs + clipDurationMs(sel) - 1
    ) {
      return sel;
    }
    return (
      [...list]
        .reverse()
        .find(
          (c) =>
            ph >= c.atMs + 1 && ph <= c.atMs + clipDurationMs(c) - 1,
        ) ?? null
    );
  }, []);

  const splitAtPlayhead = useCallback(() => {
    const ph = playheadRef.current;
    const target = findClipAtPlayhead();
    if (!target) return;
    splitClipAt(target.id, ph);
    setSelectedId(target.id);
  }, [findClipAtPlayhead, splitClipAt]);

  /** 剪映 Q：删播放头前 · W：删播放头后 */
  const trimAtPlayhead = useCallback(
    (side: "q" | "w") => {
      const c = findClipAtPlayhead();
      if (!c) return;
      const ph = playheadRef.current;
      const dur = clipDurationMs(c);
      const offset = Math.round(ph - c.atMs);
      if (offset < MIN_CLIP_MS || offset > dur - MIN_CLIP_MS) return;
      pushUndo();
      if (side === "q") {
        applyClips(
          clipsRef.current.map((x) =>
            x.id !== c.id
              ? x
              : {
                  ...c,
                  atMs: c.atMs + offset,
                  srcStartMs: c.srcStartMs + offset,
                  fadeInMs: 0,
                },
          ),
        );
      } else {
        applyClips(
          clipsRef.current.map((x) =>
            x.id !== c.id
              ? x
              : {
                  ...c,
                  srcEndMs: c.srcStartMs + offset,
                  fadeOutMs: 0,
                },
          ),
        );
      }
      setSelectedId(c.id);
    },
    [applyClips, findClipAtPlayhead, pushUndo],
  );

  const fitTimeline = useCallback(() => {
    let end = 2000;
    for (const c of clipsRef.current) {
      end = Math.max(end, c.atMs + clipDurationMs(c));
    }
    const sc = scrollRef.current;
    const w = Math.max(320, sc?.clientWidth ?? 720);
    const sec = Math.max(1, end / 1000);
    setPxPerSec(Math.max(1, Math.min(160, Math.floor((w - 48) / sec))));
    if (sc) sc.scrollLeft = 0;
    paintPlayhead(playheadRef.current, true);
  }, [paintPlayhead]);

  /**
   * 剪映：Ctrl + 滚轮 = 以鼠标下时间为锚点缩放时间线
   * （不按 Ctrl 时仍是正常滚动；native + passive:false 才能拦住浏览器整页缩放）
   */
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = sc.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const oldPx = pxPerSecRef.current;
      const anchorMs = Math.max(
        0,
        Math.round(((sc.scrollLeft + localX) / Math.max(1, oldPx)) * 1000),
      );
      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      const next = Math.max(
        1,
        Math.min(160, Math.round(oldPx * factor * 10) / 10),
      );
      if (Math.abs(next - oldPx) < 0.05) return;
      setPxPerSec(next);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const newX = (anchorMs / 1000) * next;
        el.scrollLeft = Math.max(0, newX - localX);
        paintPlayhead(playheadRef.current, true);
      });
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [paintPlayhead]);

  const pasteClipboard = useCallback(() => {
    const src = clipboardRef.current;
    if (!src) return;
    pushUndo();
    const tid =
      activeTrackIdRef.current || tracksRef.current[0]?.id || "tr1";
    const at = Math.max(0, Math.round(playheadRef.current));
    const clip: TlClip = {
      ...src,
      id: newId("clip"),
      trackId: tid,
      atMs: at,
    };
    applyClips([...clipsRef.current, clip]);
    setSelectedId(clip.id);
    setActiveTrackId(tid);
  }, [applyClips, pushUndo]);

  /**
   * 跟手拖：移动只用 translate3d（GPU，不触 layout）；
   * 修剪才改 left/width。立刻写 DOM，绝不 rAF 排队。
   */
  const paintClipDragDom = useCallback((d: DragState) => {
    const el = dragElRef.current;
    if (!el) return;
    const px = pxPerSecRef.current;
    const guide = snapGuideLineRef.current;

    if (d.kind === "move") {
      const atMs = Math.max(0, d.baseAt + d.deltaMs);
      const dx = ((atMs - d.baseAt) / 1000) * px;
      const from = tracksRef.current.findIndex((tr) => tr.id === d.baseTrackId);
      const to = tracksRef.current.findIndex((tr) => tr.id === d.targetTrackId);
      const fi = from < 0 ? 0 : from;
      const ti = to < 0 ? fi : to;
      const dy = (ti - fi) * TRACK_H;
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      el.style.zIndex = "24";
    } else {
      const fake: TlClip = {
        id: d.id,
        trackId: d.baseTrackId,
        path: "",
        label: "",
        mediaMs: d.mediaMs,
        srcStartMs: d.baseSrcStart,
        srcEndMs: d.baseSrcEnd,
        atMs: d.baseAt,
        fadeInMs: 0,
        fadeOutMs: 0,
        gainDb: 0,
        speed: 1,
        pitchSemitones: 0,
      };
      const p = previewClip(fake, d);
      const dur = Math.max(MIN_CLIP_MS, p.srcEndMs - p.srcStartMs);
      el.style.left = `${(p.atMs / 1000) * px}px`;
      el.style.width = `${Math.max(28, (dur / 1000) * px)}px`;
      el.style.transform = "translate3d(0,0,0)";
      el.style.zIndex = "24";
    }

    if (guide) {
      if (d.snapGuideMs != null) {
        guide.style.opacity = "1";
        guide.style.transform = `translate3d(${(d.snapGuideMs / 1000) * px}px, 0, 0)`;
      } else {
        guide.style.opacity = "0";
      }
    }
  }, []);

  const endClipDrag = useCallback(() => {
    dragWinCleanupRef.current?.();
    dragWinCleanupRef.current = null;
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    const guide = snapGuideLineRef.current;
    if (guide) guide.style.opacity = "0";
    const el = dragElRef.current;
    dragElRef.current = null;
    if (el) {
      el.style.transform = "";
      el.style.zIndex = "";
      el.classList.remove("dragging");
    }
    if (!d) return;
    const fake: TlClip = {
      id: d.id,
      trackId: d.baseTrackId,
      path: "",
      label: "",
      mediaMs: d.mediaMs,
      srcStartMs: d.baseSrcStart,
      srcEndMs: d.baseSrcEnd,
      atMs: d.baseAt,
      fadeInMs: 0,
      fadeOutMs: 0,
      gainDb: 0,
      speed: 1,
      pitchSemitones: 0,
    };
    const p = previewClip(fake, d);
    setClips((prev) =>
      prev.map((c) =>
        c.id === d.id
          ? {
              ...c,
              atMs: p.atMs,
              trackId: p.trackId,
              srcStartMs: p.srcStartMs,
              srcEndMs: p.srcEndMs,
            }
          : c,
      ),
    );
    if (d.kind === "move") setActiveTrackId(p.trackId);
  }, []);

  const startDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    clip: TlClip,
    kind: DragKind,
  ) => {
    if (editModeRef.current === "blade") return;
    e.preventDefault();
    e.stopPropagation();
    // 上一次拖没松干净
    dragWinCleanupRef.current?.();
    dragWinCleanupRef.current = null;

    pushUndo();
    setSelectedId(clip.id);
    setActiveTrackId(clip.trackId);

    const px = pxPerSecRef.current;
    const baseDur = Math.max(MIN_CLIP_MS, clip.srcEndMs - clip.srcStartMs);
    const el =
      (e.currentTarget.closest(".sfx-tl-clip") as HTMLElement | null) ||
      (document.querySelector(
        `.sfx-tl-clip[data-clip-id="${CSS.escape(clip.id)}"]`,
      ) as HTMLElement | null);
    if (!el) return;
    dragElRef.current = el;
    dragBaseLeftPxRef.current = (clip.atMs / 1000) * px;
    dragBaseWidthPxRef.current = Math.max(28, (baseDur / 1000) * px);
    dragSnapTargetsRef.current = collectSnapTargets(
      clipsRef.current,
      clip.id,
      playheadRef.current,
    );
    el.classList.add("dragging");
    el.style.willChange = "transform";
    el.style.zIndex = "24";

    const next: DragState = {
      kind,
      id: clip.id,
      startX: e.clientX,
      baseAt: clip.atMs,
      baseTrackId: clip.trackId,
      baseSrcStart: clip.srcStartMs,
      baseSrcEnd: clip.srcEndMs,
      mediaMs: clip.mediaMs,
      deltaMs: 0,
      targetTrackId: clip.trackId,
      snapGuideMs: null,
    };
    dragRef.current = next;
    setDrag(next);

    const onMove = (ev: PointerEvent) => {
      const d0 = dragRef.current;
      if (!d0) return;
      let deltaMs = Math.round(((ev.clientX - d0.startX) / pxPerSecRef.current) * 1000);
      let snapGuideMs: number | null = null;
      if (snappingRef.current) {
        const threshMs = Math.max(
          20,
          Math.round((SNAP_PX / pxPerSecRef.current) * 1000),
        );
        const snapped = snapDragDelta(
          d0,
          deltaMs,
          dragSnapTargetsRef.current,
          threshMs,
        );
        deltaMs = snapped.deltaMs;
        snapGuideMs = snapped.snapGuideMs;
      }
      const targetTrackId =
        d0.kind === "move" ? trackFromClientY(ev.clientY) : d0.baseTrackId;
      const nextD = { ...d0, deltaMs, targetTrackId, snapGuideMs };
      dragRef.current = nextD;
      // 同步指针立刻画，零 rAF 排队
      paintClipDragDom(nextD);
    };
    const onUp = () => endClipDrag();
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    dragWinCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };

  const onClipPointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    clip: TlClip,
  ) => {
    if (e.button !== 0) return;
    // 点片段也先落红线
    seekFromEvent(e.clientX, true);
    if (editModeRef.current === "blade") {
      e.preventDefault();
      e.stopPropagation();
      const cutAt = playheadRef.current;
      splitClipAt(clip.id, cutAt);
      setSelectedId(clip.id);
      return;
    }
    startDrag(e, clip, "move");
  };

  const applyLiveClipVolume = (clipId: string, gainDb: number) => {
    const linear = sfxVolumeRef.current * dbToLinear(gainDb);
    void invoke("sfx_set_tagged_volume", {
      tag: clipId,
      volume: linear,
    }).catch((err) => onError(String(err)));
  };

  const commitClipGain = (clipId: string, gainDb: number) => {
    setClips((prev) => {
      const mapped = prev.map((c) =>
        c.id === clipId ? { ...c, gainDb } : c,
      );
      clipsRef.current = mapped;
      return mapped;
    });
    applyLiveClipVolume(clipId, gainDb);
  };

  const endVolDragListenersRef = useRef<(() => void) | null>(null);
  const endFadeDragListenersRef = useRef<(() => void) | null>(null);

  const startVolMonitor = (clip: TlClip, gainDb: number) => {
    if (previewingRef.current) {
      applyLiveClipVolume(clip.id, gainDb);
      return;
    }
    const ph = playheadRef.current;
    let rangeStart = clip.srcStartMs;
    if (ph > clip.atMs && ph < clip.atMs + clipDurationMs(clip)) {
      rangeStart = clip.srcStartMs + (ph - clip.atMs);
    }
    const rangeEnd = clip.srcEndMs;
    if (rangeEnd <= rangeStart + 20) return;
    const gen = ++volMonitorGen.current;
    volMonitorRef.current = true;
    void (async () => {
      try {
        await invoke("sfx_set_interrupt", { interrupt: true });
        if (volMonitorGen.current !== gen || !volMonitorRef.current) return;
        const liveDb = volDragRef.current?.gainDb ?? gainDb;
        await invoke("sfx_play", {
          path: clip.path,
          volume: sfxVolumeRef.current * dbToLinear(liveDb),
          fadeMs: 0,
          fadeOutMs: 0,
          pitch: 0,
          rangeStartMs: Math.round(rangeStart),
          rangeEndMs: Math.round(rangeEnd),
          tag: clip.id,
        });
        // Apply latest drag value — moves during await were no-ops before voice existed.
        if (volMonitorGen.current === gen && volMonitorRef.current) {
          const latest = volDragRef.current?.gainDb ?? liveDb;
          applyLiveClipVolume(clip.id, latest);
        }
      } catch (e) {
        if (volMonitorGen.current === gen) volMonitorRef.current = false;
        onError(String(e));
      }
    })();
  };

  const stopVolMonitor = () => {
    if (!volMonitorRef.current) return;
    volMonitorRef.current = false;
    volMonitorGen.current += 1;
    void (async () => {
      try {
        await invoke("sfx_stop_sfx");
        await invoke("sfx_set_interrupt", {
          interrupt: sfxInterruptRef.current,
        });
      } catch {
        /* ignore */
      }
    })();
  };

  const finishVolDrag = () => {
    endVolDragListenersRef.current?.();
    endVolDragListenersRef.current = null;
    const vd = volDragRef.current;
    if (!vd) return;
    volDragRef.current = null;
    setVolDrag(null);
    commitClipGain(vd.id, vd.gainDb);
    stopVolMonitor();
  };

  const startVolDrag = (
    e: ReactPointerEvent,
    clip: TlClip,
  ) => {
    if (e.button !== 0) return;
    if (editModeRef.current !== "selection") return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(clip.id);
    const next: VolDrag = {
      id: clip.id,
      startY: e.clientY,
      baseDb: clip.gainDb,
      gainDb: clip.gainDb,
    };
    volDragRef.current = next;
    setVolDrag(next);
    startVolMonitor(clip, clip.gainDb);

    // Window listeners: re-renders must not drop pointer capture / move events.
    const onMove = (ev: PointerEvent) => {
      const vd = volDragRef.current;
      if (!vd) return;
      const nextDb = clampGainDb(
        Math.round((vd.baseDb + yDeltaToDb(ev.clientY - vd.startY, 40)) * 10) /
          10,
      );
      if (nextDb === vd.gainDb) return;
      volDragRef.current = { ...vd, gainDb: nextDb };
      setVolDrag(volDragRef.current);
      commitClipGain(vd.id, nextDb);
    };
    const onUp = () => finishVolDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    endVolDragListenersRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };

  const commitClipFade = (
    clipId: string,
    kind: "in" | "out",
    fadeMs: number,
  ) => {
    setClips((prev) => {
      const mapped = prev.map((c) => {
        if (c.id !== clipId) return c;
        const dur = clipDurationMs(c);
        if (kind === "in") return { ...c, ...clampFadePair(fadeMs, c.fadeOutMs, dur) };
        return { ...c, ...clampFadePair(c.fadeInMs, fadeMs, dur) };
      });
      clipsRef.current = mapped;
      return mapped;
    });
  };

  const finishFadeDrag = () => {
    endFadeDragListenersRef.current?.();
    endFadeDragListenersRef.current = null;
    const fd = fadeDragRef.current;
    if (!fd) return;
    fadeDragRef.current = null;
    setFadeDrag(null);
    commitClipFade(fd.id, fd.kind, fd.fadeMs);
  };

  const startFadeDrag = (
    e: ReactPointerEvent,
    clip: TlClip,
    kind: "in" | "out",
  ) => {
    if (e.button !== 0) return;
    if (editModeRef.current !== "selection") return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(clip.id);
    const next: FadeDrag = {
      id: clip.id,
      kind,
      startX: e.clientX,
      baseMs: kind === "in" ? clip.fadeInMs : clip.fadeOutMs,
      fadeMs: kind === "in" ? clip.fadeInMs : clip.fadeOutMs,
    };
    fadeDragRef.current = next;
    setFadeDrag(next);

    const onMove = (ev: PointerEvent) => {
      const fd = fadeDragRef.current;
      if (!fd) return;
      const c = clipsRef.current.find((x) => x.id === fd.id);
      if (!c) return;
      const dur = clipDurationMs(c);
      const other = fd.kind === "in" ? c.fadeOutMs : c.fadeInMs;
      const maxOne = Math.max(0, dur - other - 20);
      const deltaMs = Math.round(
        ((ev.clientX - fd.startX) / pxPerSecRef.current) * 1000,
      );
      const raw =
        fd.kind === "in" ? fd.baseMs + deltaMs : fd.baseMs - deltaMs;
      const fadeMs = Math.max(0, Math.min(maxOne, raw));
      if (fadeMs === fd.fadeMs) return;
      fadeDragRef.current = { ...fd, fadeMs };
      setFadeDrag(fadeDragRef.current);
      commitClipFade(fd.id, fd.kind, fadeMs);
    };
    const onUp = () => finishFadeDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    endFadeDragListenersRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };

  const onPointerMove = (_e: ReactPointerEvent) => {
    // 片段拖动走 window 监听（零延迟）；此处只给别的逻辑占位
    if (fadeDragRef.current || volDragRef.current || dragRef.current) return;
  };

  const onPointerUp = () => {
    if (fadeDragRef.current) {
      finishFadeDrag();
      return;
    }
    if (volDragRef.current) {
      finishVolDrag();
      return;
    }
    if (dragRef.current) {
      endClipDrag();
    }
  };

  const flushScrub = useCallback(() => {
    scrubRafRef.current = 0;
    if (pendingScrubMsRef.current == null) return;
    paintPlayhead(pendingScrubMsRef.current);
    pendingScrubMsRef.current = null;
  }, [paintPlayhead]);

  const seekFromEvent = useCallback(
    (clientX: number, forceTc = false) => {
      let ms = atMsFromClientX(clientX);
      if (snappingRef.current) {
        const threshMs = Math.max(
          20,
          Math.round((SNAP_PX / pxPerSecRef.current) * 1000),
        );
        const edgeTargets = [
          0,
          ...clipsRef.current.flatMap((c) => [
            c.atMs,
            c.atMs + clipDurationMs(c),
          ]),
        ];
        ms = snapTime(ms, edgeTargets, threshMs).value;
      }
      if (forceTc) {
        paintPlayhead(ms, true);
        return;
      }
      pendingScrubMsRef.current = ms;
      if (!scrubRafRef.current) {
        scrubRafRef.current = requestAnimationFrame(flushScrub);
      }
    },
    [atMsFromClientX, flushScrub, paintPlayhead],
  );

  /**
   * 时间线区域内点击：一律移动播放头（标尺红线）。
   * 空白处再允许拖着 scrub；点在片段上只定位，由片段自己处理拖动/刀片。
   */
  const startScrub = (
    e: ReactPointerEvent<HTMLElement>,
    opts?: { allowDragScrub?: boolean },
  ) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    // 左侧轨道名不抢时间
    if (t.closest(".sfx-tl-side")) return;
    if (previewRafRef.current) void stopPreview();
    seekFromEvent(e.clientX, true);

    const onClip = Boolean(t.closest(".sfx-tl-clip"));
    const onChrome = Boolean(
      t.closest(
        ".sfx-tl-handle, .sfx-tl-vol-hit, .sfx-tl-fade-handle, .sfx-tl-clip-x",
      ),
    );
    // 点片段/控件：只跳播放头，不进入 scrub 拖动（避免和拖片段抢事件）
    const allowDrag =
      opts?.allowDragScrub !== false && !onClip && !onChrome;
    if (!allowDrag) return;

    scrubbingRef.current = true;
    const root = (e.currentTarget.closest(".sfx-tl") ??
      e.currentTarget) as HTMLElement;
    try {
      root.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onScrubMove = (e: ReactPointerEvent) => {
    if (!scrubbingRef.current) return;
    seekFromEvent(e.clientX);
  };

  const endScrub = (e: ReactPointerEvent<HTMLElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    paintPlayhead(playheadRef.current, true);
  };

  const onLaneDrop = (e: ReactDragEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setLibDropTrack(null);
    const raw =
      e.dataTransfer.getData(LIB_MIME) || e.dataTransfer.getData("text/plain");
    if (raw) {
      let path = raw.trim();
      let label: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { path?: string; label?: string };
        if (parsed.path) {
          path = parsed.path;
          label = parsed.label;
        }
      } catch {
        /* plain path */
      }
      if (path) {
        const at = atMsFromClientX(e.clientX);
        paintPlayhead(at, true);
        void addPath(path, label, trackId, at);
        return;
      }
    }
    // 兜底：部分环境库内拖拽只带 Files / path 字段
    const files = Array.from(e.dataTransfer.files || []);
    for (const f of files) {
      const p =
        (f as File & { path?: string }).path ||
        (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
        "";
      if (p && /\.(mp3|wav|flac|ogg|m4a|aac|wma|opus|webm|aiff|ape|ac3|mka)$/i.test(p)) {
        const at = atMsFromClientX(e.clientX);
        paintPlayhead(at, true);
        void addPath(p, undefined, trackId, at);
        return;
      }
    }
  };

  const clearPreviewTimers = useCallback(() => {
    for (const id of previewTimersRef.current) window.clearTimeout(id);
    previewTimersRef.current = [];
  }, []);

  const stopPreview = useCallback(async () => {
    previewGen.current += 1;
    clearPreviewTimers();
    stopPlayheadFollow();
    setPreviewing(false);
    try {
      await invoke("sfx_stop_sfx");
      await invoke("sfx_set_interrupt", {
        interrupt: sfxInterruptRef.current,
      });
    } catch {
      /* ignore */
    }
  }, [clearPreviewTimers, stopPlayheadFollow]);

  const removeClip = useCallback(
    (id: string) => {
      void stopPreview();
      if (!clipsRef.current.some((c) => c.id === id)) return;
      pushUndo();
      applyClips(clipsRef.current.filter((c) => c.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [applyClips, pushUndo, stopPreview],
  );

  const selectedClip = useMemo(
    () => (selectedId ? clips.find((c) => c.id === selectedId) ?? null : null),
    [clips, selectedId],
  );

  const previewDebounceRef = useRef(0);
  /** 声音设置正在实时试听的片段 id（BASS 直播，不跑 ffmpeg） */
  const inspLiveIdRef = useRef<string | null>(null);
  const previewSelectedClipRef = useRef<() => Promise<void>>(async () => {});

  /**
   * 声音设置实时试听：BASS 直播 + 红线跟着走。
   * 不跑 ffmpeg、不整轨重渲；导出仍走渲染链路。
   */
  const previewSelectedClip = useCallback(async () => {
    const id = selectedIdRef.current;
    const c = id ? clipsRef.current.find((x) => x.id === id) : null;
    if (!c) {
      onError(t("sfxStudioInspEmpty"));
      return;
    }
    // 打断整轨混听，但不要清空时间线状态
    previewGen.current += 1;
    clearPreviewTimers();
    stopPlayheadFollow();
    setPreviewing(false);
    const gen = ++previewGen.current;
    inspLiveIdRef.current = c.id;
    const speed = Math.max(0.25, Math.min(4, c.speed ?? 1));
    const dur = Math.max(MIN_CLIP_MS, clipDurationMs(c));
    // 始终从片段起点跟标尺，红线跟着声音走
    paintPlayhead(c.atMs, true);
    startPlayheadFollow(c.atMs, c.atMs + dur, gen);
    try {
      await invoke("sfx_set_interrupt", { interrupt: true });
      if (previewGen.current !== gen) return;
      await invoke("sfx_play", {
        path: c.path,
        volume: sfxVolumeRef.current * dbToLinear(c.gainDb),
        fadeMs: Math.max(0, Math.round(c.fadeInMs)),
        fadeOutMs: Math.max(0, Math.round(c.fadeOutMs)),
        pitch: c.pitchSemitones ?? 0,
        speed,
        rangeStartMs: Math.round(c.srcStartMs),
        rangeEndMs: Math.round(c.srcEndMs),
        tag: c.id,
      });
      if (previewGen.current !== gen) return;
      const tid = window.setTimeout(() => {
        if (previewGen.current !== gen) return;
        if (inspLiveIdRef.current === c.id) inspLiveIdRef.current = null;
        stopPlayheadFollow();
        try {
          void invoke("sfx_set_interrupt", {
            interrupt: sfxInterruptRef.current,
          });
        } catch {
          /* ignore */
        }
      }, dur + 120);
      previewTimersRef.current.push(tid);
    } catch (e) {
      inspLiveIdRef.current = null;
      stopPlayheadFollow();
      onError(String(e));
      try {
        await invoke("sfx_set_interrupt", {
          interrupt: sfxInterruptRef.current,
        });
      } catch {
        /* ignore */
      }
    }
  }, [
    clearPreviewTimers,
    onError,
    paintPlayhead,
    startPlayheadFollow,
    stopPlayheadFollow,
    t,
  ]);
  previewSelectedClipRef.current = previewSelectedClip;

  /**
   * 改选中片段。
   * - 只改音量且正在播：热更新增益，红线继续走
   * - 其它参数：短防抖后 BASS 重播 + 红线重跟
   */
  const patchSelected = useCallback(
    (partial: Partial<TlClip>, record = true, autoPreview = true) => {
      const id = selectedIdRef.current;
      if (!id) return;
      if (record) pushUndo();
      const next = clipsRef.current.map((c) => {
        if (c.id !== id) return c;
        const merged = { ...c, ...partial };
        if (partial.speed != null) {
          merged.speed = Math.max(
            0.25,
            Math.min(4, Number(partial.speed) || 1),
          );
        }
        if (partial.pitchSemitones != null) {
          merged.pitchSemitones = Math.max(
            -12,
            Math.min(12, Number(partial.pitchSemitones) || 0),
          );
        }
        return merged;
      });
      applyClips(next);
      if (!autoPreview) return;

      const keys = Object.keys(partial);
      const onlyGain = keys.length === 1 && partial.gainDb != null;

      if (onlyGain) {
        applyLiveClipVolume(id, partial.gainDb!);
        // 已在实时试听：只改音量，红线保持跟着走
        if (inspLiveIdRef.current === id && previewRafRef.current) return;
        window.clearTimeout(previewDebounceRef.current);
        previewDebounceRef.current = window.setTimeout(() => {
          void previewSelectedClipRef.current();
        }, 60);
        return;
      }

      window.clearTimeout(previewDebounceRef.current);
      previewDebounceRef.current = window.setTimeout(() => {
        void previewSelectedClipRef.current();
      }, 90);
    },
    [applyClips, applyLiveClipVolume, pushUndo],
  );

  // HMR / leave studio: kill lingering montage voices (interrupt=false stacks them).
  useEffect(() => {
    return () => {
      previewGen.current += 1;
      for (const id of previewTimersRef.current) window.clearTimeout(id);
      previewTimersRef.current = [];
      if (previewRafRef.current) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = 0;
      }
      void invoke("sfx_stop_sfx");
      void invoke("sfx_set_interrupt", {
        interrupt: sfxInterruptRef.current,
      });
    };
  }, []);

  const previewMix = useCallback(
    async (fromMs?: number) => {
      if (clipsRef.current.length === 0) {
        onError(t("sfxStudioNeedClips"));
        return;
      }
      // Hard reset any previous preview before arming a new one.
      previewGen.current += 1;
      clearPreviewTimers();
      stopPlayheadFollow();
      try {
        await invoke("sfx_stop_sfx");
      } catch {
        /* ignore */
      }

      const startAt = Math.max(0, Math.round(fromMs ?? playheadRef.current));
      const gen = ++previewGen.current;
      setPreviewing(true);
      const muted = new Set(
        tracksRef.current.filter((tr) => tr.muted).map((tr) => tr.id),
      );
      const sorted = [...clipsRef.current]
        .filter((c) => !muted.has(c.trackId) && clipDurationMs(c) >= MIN_CLIP_MS)
        .sort((a, b) => a.atMs - b.atMs);
      if (sorted.length === 0) {
        setPreviewing(false);
        onError(t("sfxStudioNeedClips"));
        return;
      }
      const ends = sorted.map((c) => c.atMs + clipDurationMs(c));
      const maxEnd = Math.max(startAt + MIN_CLIP_MS, ...ends);
      const waitMs = Math.max(MIN_CLIP_MS, maxEnd - startAt) + 120;
      startPlayheadFollow(startAt, maxEnd, gen);
      try {
        await invoke("sfx_set_interrupt", { interrupt: false });
        await invoke("sfx_stop_sfx");
        const timers: number[] = [];
        for (const c of sorted) {
          const dur = clipDurationMs(c);
          const endAt = c.atMs + dur;
          // Play if playhead is inside or before this clip (not past its end).
          if (endAt <= startAt + 1) continue;
          const delay = Math.max(0, c.atMs - startAt);
          const speed = Math.max(0.25, Math.min(4, c.speed ?? 1));
          // 时间线坐标 → 源文件坐标：变速后 1ms 时间线 = speed ms 源素材
          let rangeStart = c.srcStartMs;
          if (c.atMs < startAt) {
            rangeStart = c.srcStartMs + (startAt - c.atMs) * speed;
          }
          const rangeEnd = c.srcEndMs;
          if (rangeEnd <= rangeStart + 20) continue;
          timers.push(
            window.setTimeout(() => {
              if (previewGen.current !== gen) return;
              const intoClipTl = Math.max(0, startAt - c.atMs);
              const needFx =
                Math.abs(speed - 1) > 0.01 ||
                Math.abs(c.pitchSemitones ?? 0) > 0.05 ||
                Math.abs(c.gainDb) > 0.05 ||
                c.fadeInMs > 0 ||
                c.fadeOutMs > 0;
              void (async () => {
                try {
                  if (needFx) {
                    // 与导出一致：先渲染再播，速度可反复改
                    const rendered = await invoke<string>("sfx_render_clip_fx", {
                      path: c.path,
                      startMs: Math.round(rangeStart),
                      endMs: Math.round(rangeEnd),
                      fadeInMs: Math.round(
                        Math.max(0, c.fadeInMs - intoClipTl),
                      ),
                      fadeOutMs: Math.round(c.fadeOutMs),
                      volume: dbToLinear(c.gainDb),
                      speed,
                      pitch: c.pitchSemitones ?? 0,
                    });
                    if (previewGen.current !== gen) return;
                    await invoke("sfx_play", {
                      path: rendered,
                      volume: sfxVolumeRef.current,
                      fadeMs: 0,
                      fadeOutMs: 0,
                      pitch: 0,
                      speed: 1,
                      rangeStartMs: null,
                      rangeEndMs: null,
                      tag: c.id,
                    });
                  } else {
                    await invoke("sfx_play", {
                      path: c.path,
                      volume: sfxVolumeRef.current,
                      fadeMs: 0,
                      fadeOutMs: 0,
                      pitch: 0,
                      speed: 1,
                      rangeStartMs: Math.round(rangeStart),
                      rangeEndMs: Math.round(rangeEnd),
                      tag: c.id,
                    });
                  }
                } catch (e) {
                  onError(String(e));
                }
              })();
            }, delay),
          );
        }
        if (timers.length === 0) {
          onError(t("sfxStudioNeedClips"));
        }
        previewTimersRef.current = timers;
        await new Promise<void>((resolve) => {
          const endId = window.setTimeout(() => resolve(), waitMs);
          previewTimersRef.current.push(endId);
        });
      } catch (e) {
        onError(String(e));
      } finally {
        if (previewGen.current === gen) {
          clearPreviewTimers();
          stopPlayheadFollow();
          try {
            // Let voices finish via range end; only restore interrupt flag.
            await invoke("sfx_set_interrupt", {
              interrupt: sfxInterruptRef.current,
            });
          } catch {
            /* ignore */
          }
          paintPlayheadRef.current(Math.min(maxEnd, playheadRef.current), true);
          setPreviewing(false);
        }
      }
    },
    [
      onError,
      sfxVolume,
      t,
      startPlayheadFollow,
      stopPlayheadFollow,
      clearPreviewTimers,
    ],
  );

  const openExportDialog = () => {
    if (clips.length === 0) {
      onError(t("sfxStudioNeedClips"));
      return;
    }
    setExportTarget("mine");
    setExportAddMine(true);
    setExportOpen(true);
  };

  const exportMix = async () => {
    if (clips.length === 0) {
      onError(t("sfxStudioNeedClips"));
      return;
    }
    if (exportTarget === "mine" && !libraryRoot) {
      onError(t("sfxNeedLibrary"));
      return;
    }

    let destPath: string | null = null;
    if (exportTarget === "file") {
      const picked = await save({
        title: t("sfxStudioExportPickFile"),
        defaultPath: `混剪_${Date.now()}.wav`,
        filters: [{ name: "WAV", extensions: ["wav"] }],
      });
      if (!picked) return;
      destPath = picked;
    }

    setBusy(true);
    setExportOpen(false);
    try {
      await stopPreview();
      const muted = new Set(tracks.filter((tr) => tr.muted).map((tr) => tr.id));
      const audible = clips.filter(
        (c) => !muted.has(c.trackId) && clipDurationMs(c) >= MIN_CLIP_MS,
      );
      if (audible.length === 0) {
        onError(t("sfxStudioNeedClips"));
        return;
      }
      const dest = await invoke<string>("sfx_export_montage", {
        clips: audible.map((c) => ({
          path: c.path,
          startMs: c.srcStartMs,
          endMs: c.srcEndMs,
          timelineMs: c.atMs,
          fadeInMs: c.fadeInMs,
          fadeOutMs: c.fadeOutMs,
          volume: dbToLinear(c.gainDb),
          speed: c.speed ?? 1,
          pitch: c.pitchSemitones ?? 0,
        })),
        libraryRoot: libraryRoot || "",
        category: exportTarget === "mine" ? "我制作的" : null,
        dest: destPath,
      });
      onExported(dest, {
        offerMine: exportTarget === "mine" && exportAddMine,
      });
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (exportOpenRef.current) return;

      // 搜索框：Esc 失焦；Ctrl 组合仍可用撤销等
      if (isTypingTarget(e.target)) {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur?.();
          e.preventDefault();
        }
        const mod = e.ctrlKey || e.metaKey;
        if (!(mod && (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y"))) {
          return;
        }
      }

      const key = e.key;
      const code = e.code;
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      // ── 剪映：撤销 / 重做 ──
      if (mod && !e.altKey && (key === "z" || key === "Z")) {
        e.preventDefault();
        if (shift) redoEdit();
        else undoEdit();
        return;
      }
      if (mod && !shift && (key === "y" || key === "Y")) {
        e.preventDefault();
        redoEdit();
        return;
      }

      // ── 剪映：复制 / 剪切 / 粘贴 ──
      if (mod && !shift && (key === "c" || key === "C")) {
        const id = selectedIdRef.current;
        const c = id ? clipsRef.current.find((x) => x.id === id) : null;
        if (c) {
          e.preventDefault();
          clipboardRef.current = { ...c };
        }
        return;
      }
      if (mod && !shift && (key === "x" || key === "X")) {
        const id = selectedIdRef.current;
        const c = id ? clipsRef.current.find((x) => x.id === id) : null;
        if (c) {
          e.preventDefault();
          clipboardRef.current = { ...c };
          removeClip(c.id);
        }
        return;
      }
      if (mod && !shift && (key === "v" || key === "V")) {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      // Ctrl+B / Ctrl+K：刀片模式
      if (mod && !shift && (key === "b" || key === "B" || key === "k" || key === "K")) {
        e.preventDefault();
        setEditMode("blade");
        return;
      }
      // 剪映：Ctrl+D 复制一份到播放头
      if (mod && !shift && (key === "d" || key === "D")) {
        const id = selectedIdRef.current;
        const c = id ? clipsRef.current.find((x) => x.id === id) : null;
        if (c) {
          e.preventDefault();
          clipboardRef.current = { ...c };
          pasteClipboard();
        }
        return;
      }

      // 空格：播放/暂停
      if (key === " " || code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (previewingRef.current) void stopPreview();
        else void previewMix();
        return;
      }

      if (!mod && !e.altKey) {
        // V 选择 · C/B 在播放头切开
        if (key === "v" || key === "V") {
          e.preventDefault();
          setEditMode("selection");
          return;
        }
        if (key === "c" || key === "C" || key === "b" || key === "B") {
          e.preventDefault();
          splitAtPlayhead();
          return;
        }
        // 剪映：S 吸附
        if (key === "s" || key === "S") {
          e.preventDefault();
          setSnapping((v) => !v);
          return;
        }
        // 剪映：Q 掐头 · W 去尾
        if (key === "q" || key === "Q") {
          e.preventDefault();
          trimAtPlayhead("q");
          return;
        }
        if (key === "w" || key === "W") {
          e.preventDefault();
          trimAtPlayhead("w");
          return;
        }
        // 剪映：+/- 缩放时间线
        if (key === "=" || key === "+" || code === "NumpadAdd") {
          e.preventDefault();
          setPxPerSec((v) => Math.min(160, v + 8));
          return;
        }
        if (key === "-" || key === "_" || code === "NumpadSubtract") {
          e.preventDefault();
          setPxPerSec((v) => Math.max(1, v - 8));
          return;
        }
        // 剪映：Shift+Z 适应时间线
        if (shift && (key === "z" || key === "Z")) {
          e.preventDefault();
          fitTimeline();
          return;
        }
      }

      // 方向键挪播放头（Shift 大步 1s）
      if (key === "ArrowLeft") {
        e.preventDefault();
        const step = shift ? 1000 : 100;
        paintPlayhead(Math.max(0, playheadRef.current - step), true);
        return;
      }
      if (key === "ArrowRight") {
        e.preventDefault();
        const step = shift ? 1000 : 100;
        paintPlayhead(playheadRef.current + step, true);
        return;
      }
      if (key === "Home") {
        e.preventDefault();
        paintPlayhead(0, true);
        return;
      }
      if (key === "End") {
        e.preventDefault();
        let end = 0;
        for (const c of clipsRef.current) {
          end = Math.max(end, c.atMs + clipDurationMs(c));
        }
        paintPlayhead(end, true);
        return;
      }

      // 删除
      if (key === "Delete" || key === "Backspace") {
        if (selectedIdRef.current) {
          e.preventDefault();
          removeClip(selectedIdRef.current);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    fitTimeline,
    paintPlayhead,
    pasteClipboard,
    previewMix,
    redoEdit,
    removeClip,
    splitAtPlayhead,
    stopPreview,
    trimAtPlayhead,
    undoEdit,
  ]);

  const q = studioQuery.trim();
  const libEmptyText = q
    ? studioKind === "bgm"
      ? t("sfxStudioSearchEmptyBgm")
      : studioKind === "fav"
        ? t("sfxStudioSearchEmptyFav")
        : t("sfxStudioSearchEmpty")
    : studioKind === "bgm"
      ? t("sfxStudioLibEmptyBgm")
      : studioKind === "fav"
        ? t("sfxStudioLibEmptyFav")
        : t("sfxStudioLibEmpty");
  const libDurMs = Math.max(0, libPick?.durationMs ?? 0);
  const libProgress = libDurMs > 0 ? Math.min(1, libPosMs / libDurMs) : 0;

  /** 上下拖：立刻改 height(px)，不排队 rAF、不每帧 setState */
  const startVSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const root = rootRef.current;
    const upper = upperElRef.current;
    if (!root || !upper) return;
    const startY = e.clientY;
    const boxH = Math.max(1, root.clientHeight);
    const startH = upper.getBoundingClientRect().height;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    // 拖动期用固定 px，比 flex% 更少抖动
    upper.style.flex = "0 0 auto";
    upper.style.height = `${startH}px`;
    upper.style.minHeight = "0";
    upper.style.maxHeight = "none";
    let latestPct = upperPct;
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const h = Math.max(boxH * 0.2, Math.min(boxH * 0.72, startH + dy));
      upper.style.height = `${h}px`;
      latestPct = (h / boxH) * 100;
    };
    const onUp = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      upper.style.flex = `0 0 ${latestPct}%`;
      upper.style.height = "";
      upper.style.minHeight = "";
      upper.style.maxHeight = "";
      setUpperPct(latestPct);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  /** 左右拖：立刻改 width，不排队 */
  const startHSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const root = rootRef.current;
    const insp = inspElRef.current;
    if (!root || !insp) return;
    const startX = e.clientX;
    const startW = insp.getBoundingClientRect().width;
    const boxW = Math.max(1, root.clientWidth);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      // 分隔在左素材与右声音之间：向右拖 → 声音变窄
      const w = Math.max(220, Math.min(boxW * 0.48, startW - dx));
      latest = w;
      insp.style.width = `${w}px`;
      insp.style.flex = `0 0 ${w}px`;
    };
    const onUp = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      setInspW(latest);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  return (
    <div className="sfx-studio" ref={rootRef}>
      {/* 上：素材搜索 | 声音设置 */}
      <div
        className="sfx-studio-upper"
        ref={upperElRef}
        style={{ flex: `0 0 ${upperPct}%` }}
      >
      <section
        className="sfx-studio-lib"
        aria-label={t("sfxStudioMaterials")}
      >
        <div className="sfx-studio-top">
          <div
            className="sfx-studio-kind"
            role="tablist"
            aria-label={t("sfxStudioMaterials")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={studioKind === "sfx"}
              className={
                studioKind === "sfx"
                  ? "sfx-studio-kind-btn on"
                  : "sfx-studio-kind-btn"
              }
              onClick={() => onStudioKind("sfx")}
            >
              {t("sfxStudioKindSfx")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={studioKind === "bgm"}
              className={
                studioKind === "bgm"
                  ? "sfx-studio-kind-btn on"
                  : "sfx-studio-kind-btn"
              }
              onClick={() => onStudioKind("bgm")}
            >
              {t("sfxStudioKindBgm")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={studioKind === "fav"}
              className={
                studioKind === "fav"
                  ? "sfx-studio-kind-btn on"
                  : "sfx-studio-kind-btn"
              }
              onClick={() => onStudioKind("fav")}
            >
              {t("sfxStudioKindFav")}
            </button>
          </div>
          <div
            className={
              studioKind === "fav"
                ? "sfx-studio-top-search with-filter"
                : "sfx-studio-top-search"
            }
          >
            {studioKind === "fav" ? (
              <div className="sfx-studio-search-seg" ref={favFilterRef}>
                <button
                  type="button"
                  className={
                    favFilterOpen
                      ? "sfx-studio-search-seg-btn on"
                      : "sfx-studio-search-seg-btn"
                  }
                  aria-haspopup="listbox"
                  aria-expanded={favFilterOpen}
                  aria-label={t("sfxStudioKindFav")}
                  onClick={() => setFavFilterOpen((v) => !v)}
                >
                  <span>
                    {studioFavFilter === "all"
                      ? t("sfxStudioFavAll")
                      : studioFavFilter === "bgm"
                        ? t("sfxStudioKindBgm")
                        : t("sfxStudioKindSfx")}
                  </span>
                  <ChevronDown
                    size={14}
                    strokeWidth={2}
                    absoluteStrokeWidth
                    className={
                      favFilterOpen
                        ? "sfx-studio-search-seg-chev open"
                        : "sfx-studio-search-seg-chev"
                    }
                  />
                </button>
                {favFilterOpen ? (
                  <div
                    className="sfx-studio-search-seg-menu"
                    role="listbox"
                    aria-label={t("sfxStudioKindFav")}
                  >
                    {(
                      [
                        ["all", "sfxStudioFavAll"],
                        ["sfx", "sfxStudioKindSfx"],
                        ["bgm", "sfxStudioKindBgm"],
                      ] as const
                    ).map(([id, key]) => (
                      <button
                        key={id}
                        type="button"
                        role="option"
                        aria-selected={studioFavFilter === id}
                        className={
                          studioFavFilter === id
                            ? "sfx-studio-search-seg-opt on"
                            : "sfx-studio-search-seg-opt"
                        }
                        onClick={() => {
                          onStudioFavFilter(id);
                          setFavFilterOpen(false);
                        }}
                      >
                        {t(key)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="sfx-studio-search-field">
              <Search
                className="sfx-studio-search-ico"
                size={14}
                strokeWidth={1.75}
                absoluteStrokeWidth
                aria-hidden
              />
              <input
                className="sfx-search sfx-studio-search"
                type="search"
                value={studioQuery}
                placeholder={
                  studioKind === "bgm"
                    ? t("sfxStudioSearchBgm")
                    : studioKind === "fav"
                      ? t("sfxStudioSearchFav")
                      : t("sfxStudioSearchSfx")
                }
                onChange={(e) => onStudioQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onStudioQuery("");
                }}
              />
            </div>
          </div>
        </div>

        <div className="sfx-studio-lib-grid">
          {studioVisible.length === 0 ? (
            <p className="muted sfx-studio-lib-empty">{libEmptyText}</p>
          ) : (
            studioVisible.map((e) => {
              const label = padLabel(e);
              const fav = favoritedSet.has(e.path);
              const on = libPick?.path === e.path;
              const source =
                studioKind === "bgm"
                  ? t("sfxStudioKindBgm")
                  : studioKind === "fav"
                    ? favoritedSet.has(e.path)
                      ? e.category || t("sfxStudioKindFav")
                      : e.category
                    : e.category;
              const dur =
                e.durationMs != null && e.durationMs > 0
                  ? formatLibMs(e.durationMs)
                  : "--:--";
              return (
                <div
                  key={e.path}
                  role="button"
                  tabIndex={0}
                  className={
                    on ? "sfx-studio-lib-card on" : "sfx-studio-lib-card"
                  }
                  draggable
                  onDragStart={(ev) => {
                    const payload = JSON.stringify({
                      path: e.path,
                      label,
                    });
                    ev.dataTransfer.setData(LIB_MIME, payload);
                    ev.dataTransfer.setData("text/plain", payload);
                    ev.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => void playLibPreview(e)}
                  onDoubleClick={() =>
                    void addPath(
                      e.path,
                      label,
                      activeTrackId,
                      playheadRef.current,
                    )
                  }
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      void playLibPreview(e);
                    }
                  }}
                >
                  <div className="sfx-studio-lib-card-main">
                    <span className="sfx-studio-lib-card-name" title={label}>
                      {label}
                    </span>
                    <span className="sfx-studio-lib-card-meta">
                      {source}
                      <span className="sfx-studio-lib-dot">·</span>
                      {dur}
                    </span>
                  </div>
                  <div className="sfx-studio-lib-card-acts">
                    <button
                      type="button"
                      className={
                        fav
                          ? "sfx-studio-lib-icon-btn on"
                          : "sfx-studio-lib-icon-btn"
                      }
                      title={fav ? t("sfxStudioUnfav") : t("sfxStudioFav")}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onToggleFavorite(e.path);
                      }}
                    >
                      <Star
                        size={14}
                        strokeWidth={1.75}
                        absoluteStrokeWidth
                        fill={fav ? "currentColor" : "none"}
                      />
                    </button>
                    <button
                      type="button"
                      className="sfx-studio-lib-icon-btn"
                      title={t("sfxStudioAddClip")}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void addPath(
                          e.path,
                          label,
                          activeTrackId,
                          playheadRef.current,
                        );
                      }}
                    >
                      <Plus size={15} strokeWidth={2} absoluteStrokeWidth />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {libPick ? (
          <div className="sfx-studio-lib-player">
            <button
              type="button"
              className="sfx-studio-lib-play"
              title={
                libPlaying ? t("sfxStudioPause") : t("sfxPlayOnce")
              }
              onClick={() => toggleLibPlay()}
            >
              {libPlaying ? (
                <Pause
                  size={16}
                  strokeWidth={0}
                  absoluteStrokeWidth
                  fill="currentColor"
                />
              ) : (
                <Play
                  size={16}
                  strokeWidth={0}
                  absoluteStrokeWidth
                  fill="currentColor"
                  style={{ marginLeft: 1 }}
                />
              )}
            </button>
            <div className="sfx-studio-lib-player-body">
              <div className="sfx-studio-lib-player-title">
                {padLabel(libPick)}
                {libPick.category ? (
                  <span className="sfx-studio-lib-player-src">
                    {" "}
                    - {libPick.category}
                  </span>
                ) : null}
              </div>
              <div className="sfx-studio-lib-player-row">
                <span className="sfx-studio-lib-time">
                  {formatLibMs(libPosMs)}
                </span>
                <span className="sfx-studio-lib-time muted">
                  {libDurMs > 0 ? formatLibMs(libDurMs) : "--:--"}
                </span>
                <div
                  className="sfx-studio-lib-seek"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={libDurMs || 1}
                  aria-valuenow={Math.min(libPosMs, libDurMs || 0)}
                >
                  <div
                    className="sfx-studio-lib-seek-fill"
                    style={{ width: `${libProgress * 100}%` }}
                  />
                </div>
              </div>
            </div>
            <button
              type="button"
              className="sfx-studio-lib-icon-btn sfx-studio-lib-close"
              title={t("closePreview")}
              onClick={() => closeLibPlayer()}
            >
              <X size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
          </div>
        ) : null}
      </section>

      <div
        className="sfx-studio-hsplit"
        role="separator"
        aria-orientation="vertical"
        aria-label={`${t("sfxStudioMaterials")} / ${t("sfxStudioSoundSettings")}`}
        title="左右拖动调整宽度"
        onPointerDown={startHSplit}
      />

      <aside
        className="sfx-studio-inspector"
        ref={inspElRef}
        aria-label={t("sfxStudioSoundSettings")}
        style={{ width: inspW, flex: `0 0 ${inspW}px` }}
      >
        <div className="sfx-insp-tabs" role="tablist">
          {(
            [
              ["basic", "sfxStudioTabBasic"],
              ["voice", "sfxStudioTabVoice"],
              ["fx", "sfxStudioTabFx"],
              ["speed", "sfxStudioTabSpeed"],
            ] as const
          ).map(([id, key]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={inspectorTab === id}
              className={
                inspectorTab === id ? "sfx-insp-tab on" : "sfx-insp-tab"
              }
              onClick={() => setInspectorTab(id)}
            >
              {t(key)}
            </button>
          ))}
        </div>
        {!selectedClip ? (
          <p className="sfx-insp-empty muted">{t("sfxStudioInspEmpty")}</p>
        ) : (
          <div className="sfx-insp-body">
            <div className="sfx-insp-head">
              <div className="sfx-insp-clip-name" title={selectedClip.label}>
                {selectedClip.label}
              </div>
              <button
                type="button"
                className="sfx-insp-preview-btn"
                disabled={busy}
                onClick={() => void previewSelectedClip()}
              >
                {t("sfxStudioPreviewClip")}
              </button>
            </div>

            {inspectorTab === "basic" ? (
              <div className="sfx-insp-fields">
                <div className="sfx-insp-field">
                  <div className="sfx-insp-field-top">
                    <span>{t("sfxStudioClipVolume")}</span>
                    <em>{fmtGainDb(selectedClip.gainDb)}</em>
                  </div>
                  <input
                    type="range"
                    min={VOL_MIN_DB}
                    max={VOL_MAX_DB}
                    step={0.5}
                    value={selectedClip.gainDb}
                    onPointerDown={() => pushUndo()}
                    onChange={(e) =>
                      patchSelected(
                        { gainDb: clampGainDb(Number(e.target.value)) },
                        false,
                      )
                    }
                  />
                </div>
                <div className="sfx-insp-field">
                  <div className="sfx-insp-field-top">
                    <span>{t("sfxStudioFadeIn")}</span>
                    <em>{selectedClip.fadeInMs}ms</em>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2000}
                    step={10}
                    value={selectedClip.fadeInMs}
                    onPointerDown={() => pushUndo()}
                    onChange={(e) =>
                      patchSelected(
                        { fadeInMs: Math.max(0, Number(e.target.value)) },
                        false,
                      )
                    }
                  />
                </div>
                <div className="sfx-insp-field">
                  <div className="sfx-insp-field-top">
                    <span>{t("sfxStudioFadeOut")}</span>
                    <em>{selectedClip.fadeOutMs}ms</em>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2000}
                    step={10}
                    value={selectedClip.fadeOutMs}
                    onPointerDown={() => pushUndo()}
                    onChange={(e) =>
                      patchSelected(
                        { fadeOutMs: Math.max(0, Number(e.target.value)) },
                        false,
                      )
                    }
                  />
                </div>
              </div>
            ) : null}

            {inspectorTab === "voice" ? (
              <div className="sfx-insp-fields">
                <div className="sfx-insp-field">
                  <div className="sfx-insp-field-top">
                    <span>{t("sfxStudioTabVoice")}</span>
                  </div>
                  <div className="sfx-insp-chips">
                    {VOICE_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={
                          Math.abs(
                            (selectedClip.pitchSemitones ?? 0) - p.pitch,
                          ) < 0.1
                            ? "sfx-insp-chip on"
                            : "sfx-insp-chip"
                        }
                        onClick={() =>
                          patchSelected({ pitchSemitones: p.pitch }, true)
                        }
                      >
                        {t(`sfxStudioVoice_${p.id}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sfx-insp-field">
                  <div className="sfx-insp-field-top">
                    <span>{t("sfxStudioPitch")}</span>
                    <em>
                      {(selectedClip.pitchSemitones ?? 0) > 0 ? "+" : ""}
                      {(selectedClip.pitchSemitones ?? 0).toFixed(1)}
                    </em>
                  </div>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={selectedClip.pitchSemitones ?? 0}
                    onPointerDown={() => pushUndo()}
                    onChange={(e) =>
                      patchSelected(
                        { pitchSemitones: Number(e.target.value) },
                        false,
                      )
                    }
                  />
                </div>
              </div>
            ) : null}

            {inspectorTab === "fx" ? (
              <div className="sfx-insp-fields">
                <div className="sfx-insp-field">
                  <div className="sfx-insp-field-top">
                    <span>{t("sfxStudioTabFx")}</span>
                  </div>
                  <div className="sfx-insp-chips">
                    {(
                      [
                        ["none", { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }],
                        ["soft", { gainDb: 0, fadeInMs: 250, fadeOutMs: 0 }],
                        ["loud", { gainDb: 4, fadeInMs: 0, fadeOutMs: 0 }],
                        ["quiet", { gainDb: -6, fadeInMs: 0, fadeOutMs: 0 }],
                        ["tail", { gainDb: 0, fadeInMs: 0, fadeOutMs: 500 }],
                      ] as const
                    ).map(([id, partial]) => (
                      <button
                        key={id}
                        type="button"
                        className="sfx-insp-chip"
                        onClick={() => patchSelected({ ...partial }, true)}
                      >
                        {t(`sfxStudioFx_${id}`)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {inspectorTab === "speed" ? (
              <div className="sfx-insp-fields">
                <div className="sfx-insp-field">
                  <div className="sfx-insp-field-top">
                    <span>{t("sfxStudioSpeed")}</span>
                    <em>{Number(selectedClip.speed ?? 1).toFixed(2)}x</em>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.05}
                    value={Number(selectedClip.speed ?? 1)}
                    onPointerDown={() => pushUndo()}
                    onChange={(e) => {
                      const v = Math.max(
                        0.5,
                        Math.min(2, Number(e.target.value) || 1),
                      );
                      patchSelected({ speed: v }, false, true);
                    }}
                  />
                </div>
                <div className="sfx-insp-field">
                  <div className="sfx-insp-chips sfx-insp-chips-speed">
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={
                          Math.abs(Number(selectedClip.speed ?? 1) - s) < 0.02
                            ? "sfx-insp-chip on"
                            : "sfx-insp-chip"
                        }
                        onClick={() => {
                          pushUndo();
                          patchSelected({ speed: s }, false, true);
                        }}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </aside>
      </div>

      <div
        className="sfx-studio-vsplit"
        role="separator"
        aria-orientation="horizontal"
        aria-label={`${t("sfxStudioMaterials")} / ${t("sfxStudioMontage")}`}
        title="上下拖动调整高度"
        onPointerDown={startVSplit}
      />

      {/* 下：混剪 */}
      <div className="sfx-studio-lower" aria-label={t("sfxStudioMontage")}>
      <section
        className={
          dragOver ? "sfx-studio-card edit drop-target" : "sfx-studio-card edit"
        }
      >
        <div className="sfx-tl-toolbar">
          <div className="sfx-tl-tool-group">
            <button
              type="button"
              className={
                editMode === "selection" ? "sfx-tl-tool on" : "sfx-tl-tool"
              }
              title={t("sfxStudioModeSelect")}
              onClick={() => setEditMode("selection")}
            >
              <MousePointer2 size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
            <button
              type="button"
              className={editMode === "blade" ? "sfx-tl-tool on" : "sfx-tl-tool"}
              title={t("sfxStudioModeBlade")}
              onClick={() => setEditMode("blade")}
            >
              <Scissors size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
            <button
              type="button"
              className="sfx-tl-tool"
              title={t("sfxStudioSplitPlayhead")}
              disabled={clips.length === 0}
              onClick={splitAtPlayhead}
            >
              <SplitSquareHorizontal
                size={16}
                strokeWidth={1.75}
                absoluteStrokeWidth
              />
            </button>
          </div>
          <span className="sfx-tl-sep" aria-hidden />
          <div className="sfx-tl-tool-group">
            <button
              type="button"
              className={snapping ? "sfx-tl-tool on" : "sfx-tl-tool"}
              title={
                snapping ? t("sfxStudioSnapOn") : t("sfxStudioSnapOff")
              }
              onClick={() => setSnapping((v) => !v)}
            >
              <Magnet size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
            <button
              type="button"
              className={previewing ? "sfx-tl-tool on" : "sfx-tl-tool"}
              title={
                previewing
                  ? t("sfxStudioPausePreview")
                  : t("sfxStudioPreviewAll")
              }
              disabled={clips.length === 0 || busy}
              onClick={() =>
                void (previewing ? stopPreview() : previewMix())
              }
            >
              {previewing ? (
                <Pause size={16} strokeWidth={1.75} absoluteStrokeWidth />
              ) : (
                <Play size={16} strokeWidth={1.75} absoluteStrokeWidth />
              )}
            </button>
            <span
              ref={timecodeRef}
              className="sfx-tl-timecode"
              title={t("sfxStudioPlayhead")}
            >
              {fmtTimecode(0)}
            </span>
          </div>

          <div className="sfx-tl-tool-group grow">
            <button
              type="button"
              className="sfx-tl-tool"
              title={t("sfxStudioZoom")}
              onClick={() => setPxPerSec((v) => Math.max(1, v - 8))}
            >
              <Minus size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
            <input
              className="sfx-tl-zoom"
              type="range"
              min={1}
              max={160}
              value={pxPerSec}
              title={t("sfxStudioZoom")}
              onChange={(e) => setPxPerSec(Number(e.target.value))}
            />
            <button
              type="button"
              className="sfx-tl-tool"
              title={t("sfxStudioZoom")}
              onClick={() => setPxPerSec((v) => Math.min(160, v + 8))}
            >
              <Plus size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
            <span className="sfx-tl-sep" aria-hidden />
            <SfxVolumeButton
              tone="sfx"
              expandLeft
              title={t("sfxSfxVolume")}
              value={sfxVolume}
              onChange={onSfxVolume}
            />
            <button
              type="button"
              className={
                recording ? "sfx-tl-tool on sfx-rec-icon" : "sfx-tl-tool"
              }
              title={
                recording
                  ? `${t("sfxRecording")} ${Math.floor(recElapsedMs / 1000)}s`
                  : t("sfxRecord")
              }
              onClick={onToggleRecord}
            >
              {recording ? (
                <Square size={16} strokeWidth={1.75} absoluteStrokeWidth />
              ) : (
                <Mic size={16} strokeWidth={1.75} absoluteStrokeWidth />
              )}
              {recording ? (
                <span
                  className="sfx-rec-meter icon"
                  aria-hidden
                  style={{
                    ["--rec-peak" as string]: String(Math.min(1, recPeak * 2)),
                  }}
                />
              ) : null}
            </button>
            <span className="sfx-tl-sep" aria-hidden />
            <button
              type="button"
              className={busy ? "sfx-tl-tool on" : "sfx-tl-tool"}
              title={t("sfxStudioExportMontage")}
              disabled={clips.length === 0 || busy}
              aria-busy={busy}
              onClick={openExportDialog}
            >
              <Download size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
          </div>
        </div>

        {exportOpen ? (
          <div
            className="sfx-export-mask"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !busy) setExportOpen(false);
            }}
          >
            <div
              className="sfx-export-dialog"
              role="dialog"
              aria-labelledby="sfx-export-title"
            >
              <div id="sfx-export-title" className="sfx-export-title">
                {t("sfxStudioExportMontage")}
              </div>
              <p className="sfx-export-desc muted">
                {t("sfxStudioExportMontageHint")}
              </p>
              <div className="sfx-export-choices">
                <button
                  type="button"
                  className={
                    exportTarget === "mine"
                      ? "sfx-export-choice on"
                      : "sfx-export-choice"
                  }
                  onClick={() => setExportTarget("mine")}
                >
                  <Download size={16} strokeWidth={1.75} absoluteStrokeWidth />
                  <span>
                    <strong>{t("sfxStudioExportToMine")}</strong>
                    <em>{t("sfxStudioExportToMineHint")}</em>
                  </span>
                </button>
                <button
                  type="button"
                  className={
                    exportTarget === "file"
                      ? "sfx-export-choice on"
                      : "sfx-export-choice"
                  }
                  onClick={() => setExportTarget("file")}
                >
                  <FolderOpen size={16} strokeWidth={1.75} absoluteStrokeWidth />
                  <span>
                    <strong>{t("sfxStudioExportToFile")}</strong>
                    <em>{t("sfxStudioExportToFileHint")}</em>
                  </span>
                </button>
              </div>
              {exportTarget === "mine" ? (
                <label className="sfx-export-check">
                  <input
                    type="checkbox"
                    checked={exportAddMine}
                    onChange={(e) => setExportAddMine(e.target.checked)}
                  />
                  {t("sfxStudioExportAddMine")}
                </label>
              ) : null}
              <div className="sfx-export-actions">
                <button
                  type="button"
                  className="sfx-export-btn ghost"
                  disabled={busy}
                  onClick={() => setExportOpen(false)}
                >
                  {t("sfxStudioExportCancel")}
                </button>
                <button
                  type="button"
                  className="sfx-export-btn primary"
                  disabled={busy || (exportTarget === "mine" && !libraryRoot)}
                  onClick={() => void exportMix()}
                >
                  {busy ? t("sfxStudioExporting") : t("sfxStudioExportGo")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <p className="sfx-tl-keys muted" title={t("sfxStudioKeysHint")}>
          {t("sfxStudioKeysLegend")}
        </p>

        <div
          className={editMode === "blade" ? "sfx-tl blade" : "sfx-tl"}
          tabIndex={0}
          onPointerDownCapture={(e) => {
            // 点时间线：离开搜索框，快捷键立刻可用
            const ae = document.activeElement;
            if (isTypingTarget(ae)) (ae as HTMLElement).blur?.();
            // 捕获阶段：标尺/轨道/空白/片段 点击都先移动播放头
            if (e.button !== 0) return;
            const t = e.target as HTMLElement;
            if (t.closest(".sfx-tl-side")) return;
            if (!t.closest(".sfx-tl-scroll")) return;
            if (previewRafRef.current) void stopPreview();
            seekFromEvent(e.clientX, true);
          }}
          onPointerMove={(e) => {
            onScrubMove(e);
            onPointerMove(e);
          }}
          onPointerUp={(e) => {
            endScrub(e);
            onPointerUp();
          }}
          onPointerCancel={(e) => {
            endScrub(e);
            onPointerUp();
          }}
        >
          <div className="sfx-tl-side">
            <div className="sfx-tl-corner" style={{ height: RULER_H }} />
            {tracks.map((tr) => {
              const count = clips.filter((c) => c.trackId === tr.id).length;
              const hot =
                activeTrackId === tr.id ||
                libDropTrack === tr.id ||
                (drag?.kind === "move" && drag.targetTrackId === tr.id);
              return (
                <div
                  key={tr.id}
                  className={[
                    "sfx-tl-track-label",
                    hot ? "on" : "",
                    tr.muted ? "muted" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ height: TRACK_H }}
                >
                  <button
                    type="button"
                    className="sfx-tl-track-select"
                    onClick={() => setActiveTrackId(tr.id)}
                  >
                    <span>{tr.name}</span>
                    <span className="sfx-tl-track-count">{count}</span>
                  </button>
                  <button
                    type="button"
                    className={
                      tr.muted ? "sfx-tl-track-mute on" : "sfx-tl-track-mute"
                    }
                    title={
                      tr.muted ? t("sfxStudioTrackUnmute") : t("sfxStudioTrackMute")
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleTrackMute(tr.id);
                    }}
                  >
                    {tr.muted ? (
                      <VolumeX size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    ) : (
                      <Volume2 size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    )}
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="sfx-tl-add-track"
              title={t("sfxStudioAddTrack")}
              onClick={addTrack}
            >
              <Plus size={16} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
          </div>

          <div
            className="sfx-tl-scroll"
            ref={scrollRef}
            onPointerDown={(e) => {
              // 点到滚动区空白（含轨道下方空地）也移动红线并可拖 scrub
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest(".sfx-tl-clip")) return;
              startScrub(e);
            }}
          >
            <div className="sfx-tl-inner" style={{ width: timelineW }}>
              <div
                ref={playheadLineRef}
                className="sfx-tl-playhead"
                aria-hidden
              >
                <span className="sfx-tl-playhead-head" />
              </div>
              <div
                ref={snapGuideLineRef}
                className="sfx-tl-snap-guide"
                style={{ opacity: 0, left: 0 }}
                aria-hidden
              />

              <div
                className="sfx-tl-ruler"
                style={{ height: RULER_H }}
                onPointerDown={startScrub}
              >
                {rulerMarks.map((s) => (
                  <span
                    key={s}
                    className={s === 0 ? "sfx-tl-mark origin" : "sfx-tl-mark"}
                    style={{ left: s * pxPerSec }}
                  >
                    <i className="sfx-tl-tick" aria-hidden />
                    {fmtShort(s * 1000)}
                  </span>
                ))}
              </div>

              <div ref={lanesRef} className="sfx-tl-lanes">
                {tracks.map((tr) => {
                  const laneClips = clips.filter((c) => c.trackId === tr.id);
                  const hot =
                    activeTrackId === tr.id ||
                    libDropTrack === tr.id ||
                    (drag?.kind === "move" && drag.targetTrackId === tr.id);
                  return (
                    <div
                      key={tr.id}
                      className={[
                        "sfx-tl-lane",
                        hot ? "on" : "",
                        tr.muted ? "muted" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ height: TRACK_H }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        setActiveTrackId(tr.id);
                        // 片段上：播放头已在 capture 里移过，这里只处理空白 lane
                        if ((e.target as HTMLElement).closest(".sfx-tl-clip")) {
                          return;
                        }
                        startScrub(e);
                      }}
                      onDragOver={(e) => {
                        const types = [...e.dataTransfer.types];
                        const ok =
                          types.includes(LIB_MIME) ||
                          types.includes("text/plain") ||
                          types.includes("Files") ||
                          types.includes("files");
                        if (!ok) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                        setLibDropTrack(tr.id);
                        setActiveTrackId(tr.id);
                      }}
                      onDragLeave={() =>
                        setLibDropTrack((cur) => (cur === tr.id ? null : cur))
                      }
                      onDrop={(e) => onLaneDrop(e, tr.id)}
                    >
                      {laneClips.map((c) => {
                        const dragging = drag?.id === c.id;
                        // 拖动中：React 只钉死起点坐标，位移全交给 paintClipDragDom 的 transform
                        // （避免 re-render 改 left 再叠加 transform → 双倍位移/发飘）
                        const p = dragging
                          ? {
                              atMs: c.atMs,
                              srcStartMs: c.srcStartMs,
                              srcEndMs: c.srcEndMs,
                              trackId: c.trackId,
                            }
                          : previewClip(c, null);
                        // DOM stays on original track while dragging (OCC)
                        if (c.trackId !== tr.id) return null;
                        const dur = Math.max(
                          MIN_CLIP_MS,
                          p.srcEndMs - p.srcStartMs,
                        );
                        const left = (p.atMs / 1000) * pxPerSec;
                        const width = Math.max(28, (dur / 1000) * pxPerSec);
                        const selected = selectedId === c.id || dragging;
                        const gainDb =
                          volDrag?.id === c.id ? volDrag.gainDb : c.gainDb;
                        const fadeInMs =
                          fadeDrag?.id === c.id && fadeDrag.kind === "in"
                            ? fadeDrag.fadeMs
                            : c.fadeInMs;
                        const fadeOutMs =
                          fadeDrag?.id === c.id && fadeDrag.kind === "out"
                            ? fadeDrag.fadeMs
                            : c.fadeOutMs;
                        const fadeInPx = Math.min(
                          width - 8,
                          (fadeInMs / 1000) * pxPerSec,
                        );
                        const fadeOutPx = Math.min(
                          width - 8,
                          (fadeOutMs / 1000) * pxPerSec,
                        );
                        const volY = gainDbToYFrac(gainDb) * 40;
                        const volTopPct = gainDbToYFrac(gainDb) * 100;
                        const volLeft = Math.min(fadeInPx, width - 12);
                        const volRight = Math.min(fadeOutPx, width - 12);
                        const showVolTip = volDrag?.id === c.id;
                        const showFadeTip = fadeDrag?.id === c.id;
                        const elev = dragging || showVolTip || showFadeTip;
                        const clipH = 40;
                        return (
                          <div
                            key={c.id}
                            data-clip-id={c.id}
                            className={
                              selected
                                ? editMode === "blade"
                                  ? "sfx-tl-clip on blade"
                                  : "sfx-tl-clip on"
                                : editMode === "blade"
                                  ? "sfx-tl-clip blade"
                                  : "sfx-tl-clip"
                            }
                            style={{
                              left,
                              width,
                              // 拖动 transform 由 paintClipDragDom 独占，这里不要写
                              zIndex: elev ? 20 : undefined,
                            }}
                            title={`${c.label} · ${fmtTimecode(p.atMs)} · ${fmtGainDb(gainDb)}`}
                            onPointerDown={(e) => onClipPointerDown(e, c)}
                            onContextMenu={(e) => openClipMenu(e, c)}
                          >
                            <ClipWaveform
                              path={c.path}
                              mediaMs={c.mediaMs}
                              srcStartMs={p.srcStartMs}
                              srcEndMs={p.srcEndMs}
                              width={width}
                            />
                            {editMode === "selection" ? (
                              <svg
                                className="sfx-tl-fade"
                                viewBox={`0 0 ${Math.max(1, width)} ${clipH}`}
                                preserveAspectRatio="none"
                                aria-hidden
                              >
                                {fadeInPx > 0.5 ? (
                                  <>
                                    <polygon
                                      points={`0,${clipH} ${fadeInPx.toFixed(1)},${volY.toFixed(1)} ${fadeInPx.toFixed(1)},${clipH}`}
                                    />
                                    <line
                                      className="sfx-tl-fade-edge"
                                      x1="0"
                                      y1={clipH}
                                      x2={fadeInPx}
                                      y2={volY}
                                    />
                                  </>
                                ) : null}
                                {fadeOutPx > 0.5 ? (
                                  <>
                                    <polygon
                                      points={`${width},${clipH} ${(width - fadeOutPx).toFixed(1)},${volY.toFixed(1)} ${(width - fadeOutPx).toFixed(1)},${clipH}`}
                                    />
                                    <line
                                      className="sfx-tl-fade-edge"
                                      x1={width}
                                      y1={clipH}
                                      x2={width - fadeOutPx}
                                      y2={volY}
                                    />
                                  </>
                                ) : null}
                              </svg>
                            ) : null}
                            {editMode === "selection" ? (
                              <div
                                className="sfx-tl-handle left"
                                title={t("sfxStudioTrimLeft")}
                                onPointerDown={(e) =>
                                  startDrag(e, c, "trim-left")
                                }
                              />
                            ) : null}
                            <span className="sfx-tl-clip-name">{c.label}</span>
                            {editMode === "selection" ? (
                              <div
                                className={
                                  selected || showVolTip || showFadeTip
                                    ? "sfx-tl-vol on"
                                    : "sfx-tl-vol"
                                }
                                style={{
                                  top: `${volTopPct}%`,
                                  left: volLeft,
                                  right: volRight,
                                }}
                              >
                                <span
                                  className="sfx-tl-vol-hit"
                                  title={t("sfxStudioClipVolume")}
                                  onPointerDown={(e) => startVolDrag(e, c)}
                                />
                                <span className="sfx-tl-vol-line" />
                                {showVolTip ? (
                                  <span className="sfx-tl-vol-tip">
                                    {fmtGainDb(gainDb)}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            {editMode === "selection" ? (
                              <>
                                <div
                                  className={
                                    selected || showFadeTip
                                      ? "sfx-tl-fade-handle on left"
                                      : "sfx-tl-fade-handle left"
                                  }
                                  style={{ left: fadeInPx, top: volY }}
                                  title={t("sfxStudioFadeIn")}
                                  onPointerDown={(e) =>
                                    startFadeDrag(e, c, "in")
                                  }
                                >
                                  {showFadeTip && fadeDrag?.kind === "in" ? (
                                    <span className="sfx-tl-fade-tip">
                                      {fmtFadeSec(fadeInMs)}
                                    </span>
                                  ) : null}
                                </div>
                                <div
                                  className={
                                    selected || showFadeTip
                                      ? "sfx-tl-fade-handle on right"
                                      : "sfx-tl-fade-handle right"
                                  }
                                  style={{
                                    left: Math.max(0, width - fadeOutPx),
                                    top: volY,
                                  }}
                                  title={t("sfxStudioFadeOut")}
                                  onPointerDown={(e) =>
                                    startFadeDrag(e, c, "out")
                                  }
                                >
                                  {showFadeTip && fadeDrag?.kind === "out" ? (
                                    <span className="sfx-tl-fade-tip">
                                      {fmtFadeSec(fadeOutMs)}
                                    </span>
                                  ) : null}
                                </div>
                              </>
                            ) : null}
                            <button
                              type="button"
                              className="sfx-tl-clip-x"
                              title={t("sfxStudioRemoveClip")}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeClip(c.id);
                              }}
                            >
                              <Trash2
                                size={12}
                                strokeWidth={1.75}
                                absoluteStrokeWidth
                              />
                            </button>
                            {editMode === "selection" ? (
                              <div
                                className="sfx-tl-handle right"
                                title={t("sfxStudioTrimRight")}
                                onPointerDown={(e) =>
                                  startDrag(e, c, "trim-right")
                                }
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

      </section>
      </div>

      <ContextMenu menu={ctx} onClose={() => setCtx(null)} />
    </div>
  );
}
