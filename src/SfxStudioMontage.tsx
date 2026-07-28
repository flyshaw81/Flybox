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
};

type EditMode = "selection" | "blade";

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

function clipDurationMs(c: { srcStartMs: number; srcEndMs: number }): number {
  return Math.max(0, c.srcEndMs - c.srcStartMs);
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
    void loadPeaks(path)
      .then((p) => {
        if (alive) setData(p);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [path]);
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
  studioVisible,
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
  studioKind: "sfx" | "bgm";
  onStudioKind: (k: "sfx" | "bgm") => void;
  studioVisible: StudioEntry[];
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
  const [snapping, setSnapping] = useState(true);
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
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
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
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;

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

  const trackIndex = useCallback((trackId: string) => {
    const i = tracksRef.current.findIndex((tr) => tr.id === trackId);
    return i < 0 ? 0 : i;
  }, []);

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

  const splitClipAt = useCallback((clipId: string, cutAtMs: number) => {
    setClips((prev) => {
      const c = prev.find((x) => x.id === clipId);
      if (!c) return prev;
      const dur = clipDurationMs(c);
      const offset = Math.round(cutAtMs - c.atMs);
      if (offset < MIN_CLIP_MS || offset > dur - MIN_CLIP_MS) return prev;
      const cutSrc = c.srcStartMs + offset;
      if (cutSrc <= c.srcStartMs || cutSrc >= c.srcEndMs) return prev;
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
      return prev.flatMap((x) => (x.id === clipId ? [left, right] : [x]));
    });
  }, []);

  const splitAtPlayhead = useCallback(() => {
    const ph = playheadRef.current;
    const list = clipsRef.current;
    // Prefer the clip under the playhead (same track layer order: topmost = last).
    const under = [...list]
      .reverse()
      .find(
        (c) =>
          ph >= c.atMs + 1 &&
          ph <= c.atMs + clipDurationMs(c) - 1,
      );
    const sel = selectedIdRef.current;
    const selected = sel ? list.find((c) => c.id === sel) : null;
    const selectedUnder =
      selected &&
      ph >= selected.atMs + 1 &&
      ph <= selected.atMs + clipDurationMs(selected) - 1
        ? selected
        : null;
    const target = selectedUnder || under;
    if (!target) return;
    splitClipAt(target.id, ph);
    setSelectedId(target.id);
  }, [splitClipAt]);

  const startDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    clip: TlClip,
    kind: DragKind,
  ) => {
    if (editModeRef.current === "blade") return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(clip.id);
    setActiveTrackId(clip.trackId);
    e.currentTarget.setPointerCapture(e.pointerId);
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
  };

  const onClipPointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    clip: TlClip,
  ) => {
    if (e.button !== 0) return;
    if (editModeRef.current === "blade") {
      e.preventDefault();
      e.stopPropagation();
      const cutAt = atMsFromClientX(e.clientX);
      splitClipAt(clip.id, cutAt);
      setSelectedId(clip.id);
      paintPlayhead(cutAt, true);
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

  const onPointerMove = (e: ReactPointerEvent) => {
    if (fadeDragRef.current) return; // handled by window listeners
    if (volDragRef.current) return; // handled by window listeners
    const d = dragRef.current;
    if (!d) return;
    let deltaMs = Math.round(((e.clientX - d.startX) / pxPerSec) * 1000);
    let snapGuideMs: number | null = null;
    if (snappingRef.current) {
      const threshMs = Math.max(20, Math.round((SNAP_PX / pxPerSec) * 1000));
      const targets = collectSnapTargets(
        clipsRef.current,
        d.id,
        playheadRef.current,
      );
      const snapped = snapDragDelta(d, deltaMs, targets, threshMs);
      deltaMs = snapped.deltaMs;
      snapGuideMs = snapped.snapGuideMs;
    }
    const targetTrackId =
      d.kind === "move" ? trackFromClientY(e.clientY) : d.baseTrackId;
    const next = { ...d, deltaMs, targetTrackId, snapGuideMs };
    dragRef.current = next;
    setDrag(next);
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
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
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

  const startScrub = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".sfx-tl-clip")) return;
    if (previewRafRef.current) void stopPreview();
    scrubbingRef.current = true;
    // Capture on timeline root so move/up handlers (on .sfx-tl) keep receiving events.
    const root = (e.currentTarget.closest(".sfx-tl") ?? e.currentTarget) as HTMLElement;
    root.setPointerCapture?.(e.pointerId);
    seekFromEvent(e.clientX, true);
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
      clipsRef.current = clipsRef.current.filter((c) => c.id !== id);
      setClips((prev) => prev.filter((c) => c.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [stopPreview],
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
          let rangeStart = c.srcStartMs;
          if (c.atMs < startAt) {
            rangeStart = c.srcStartMs + (startAt - c.atMs);
          }
          const rangeEnd = c.srcEndMs;
          if (rangeEnd <= rangeStart + 20) continue;
          timers.push(
            window.setTimeout(() => {
              if (previewGen.current !== gen) return;
              const intoClip = Math.max(0, startAt - c.atMs);
              const playDur = Math.max(0, rangeEnd - rangeStart);
              let fadeIn = Math.max(0, c.fadeInMs - intoClip);
              let fadeOut = c.fadeOutMs;
              if (fadeIn + fadeOut > playDur) {
                const pair = clampFadePair(fadeIn, fadeOut, playDur);
                fadeIn = pair.fadeInMs;
                fadeOut = pair.fadeOutMs;
              }
              void invoke("sfx_play", {
                path: c.path,
                volume: sfxVolume * dbToLinear(c.gainDb),
                fadeMs: Math.round(fadeIn),
                fadeOutMs: Math.round(fadeOut),
                pitch: 0,
                rangeStartMs: Math.round(rangeStart),
                rangeEndMs: Math.round(rangeEnd),
                tag: c.id,
              }).catch((e) => onError(String(e)));
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
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (previewing) void stopPreview();
        else void previewMix();
        return;
      }
      if (e.key === "v" || e.key === "V") {
        setEditMode("selection");
        return;
      }
      if (e.key === "b" || e.key === "B") {
        setEditMode("blade");
        return;
      }
      if (e.key === "s" || e.key === "S") {
        setSnapping((v) => !v);
        return;
      }
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        splitAtPlayhead();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIdRef.current) {
          e.preventDefault();
          removeClip(selectedIdRef.current);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewMix, previewing, splitAtPlayhead, stopPreview]);

  const q = studioQuery.trim();

  return (
    <div className="sfx-studio" ref={rootRef}>
      <div className="sfx-studio-top">
        <div className="sfx-studio-kind" role="tablist" aria-label={t("sfxStudioSearch")}>
          <button
            type="button"
            role="tab"
            aria-selected={studioKind === "sfx"}
            className={
              studioKind === "sfx" ? "sfx-studio-kind-btn on" : "sfx-studio-kind-btn"
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
              studioKind === "bgm" ? "sfx-studio-kind-btn on" : "sfx-studio-kind-btn"
            }
            onClick={() => onStudioKind("bgm")}
          >
            {t("sfxStudioKindBgm")}
          </button>
        </div>
        <div className="sfx-studio-top-search">
          <input
            className="sfx-search sfx-studio-search"
            type="search"
            value={studioQuery}
            placeholder={
              studioKind === "bgm"
                ? t("sfxStudioSearchBgm")
                : t("sfxStudioSearchSfx")
            }
            onChange={(e) => onStudioQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onStudioQuery("");
            }}
          />
          {q ? (
            <div className="sfx-studio-top-hits">
              {studioVisible.length === 0 ? (
                <p className="muted sfx-studio-pick-empty">
                  {studioKind === "bgm"
                    ? t("sfxStudioSearchEmptyBgm")
                    : t("sfxStudioSearchEmpty")}
                </p>
              ) : (
                studioVisible.map((e) => (
                  <div
                    key={e.path}
                    role="button"
                    tabIndex={0}
                    className="sfx-studio-pick"
                    draggable
                    onDragStart={(ev) => {
                      const payload = JSON.stringify({
                        path: e.path,
                        label: padLabel(e),
                      });
                      ev.dataTransfer.setData(LIB_MIME, payload);
                      ev.dataTransfer.setData("text/plain", payload);
                      ev.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() =>
                      void addPath(e.path, padLabel(e), activeTrackId)
                    }
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        void addPath(e.path, padLabel(e), activeTrackId);
                      }
                    }}
                  >
                    <span className="sfx-studio-pick-name">{padLabel(e)}</span>
                    <span className="sfx-studio-pick-cat muted">
                      {studioKind === "bgm"
                        ? t("sfxStudioKindBgm")
                        : e.category}
                    </span>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
        <div className="sfx-studio-top-actions">
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
        </div>
      </div>

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

        <div
          className={editMode === "blade" ? "sfx-tl blade" : "sfx-tl"}
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

          <div className="sfx-tl-scroll" ref={scrollRef}>
            <div className="sfx-tl-inner" style={{ width: timelineW }}>
              <div
                ref={playheadLineRef}
                className="sfx-tl-playhead"
                aria-hidden
              />
              {drag?.snapGuideMs != null ? (
                <div
                  className="sfx-tl-snap-guide"
                  style={{
                    left: (drag.snapGuideMs / 1000) * pxPerSec,
                  }}
                  aria-hidden
                />
              ) : null}

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
                        if ((e.target as HTMLElement).closest(".sfx-tl-clip")) {
                          return;
                        }
                        setActiveTrackId(tr.id);
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
                        const p = previewClip(c, drag);
                        // DOM stays on original track while dragging (OCC)
                        if (c.trackId !== tr.id) return null;
                        const dur = Math.max(MIN_CLIP_MS, p.srcEndMs - p.srcStartMs);
                        const dragging = drag?.id === c.id;
                        const left = (p.atMs / 1000) * pxPerSec;
                        const width = Math.max(28, (dur / 1000) * pxPerSec);
                        const dragOffsetY =
                          dragging && drag.kind === "move"
                            ? (trackIndex(drag.targetTrackId) -
                                trackIndex(drag.baseTrackId)) *
                              TRACK_H
                            : 0;
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
                              transform: dragOffsetY
                                ? `translate3d(0, ${dragOffsetY}px, 0)`
                                : undefined,
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

      <ContextMenu menu={ctx} onClose={() => setCtx(null)} />
    </div>
  );
}
