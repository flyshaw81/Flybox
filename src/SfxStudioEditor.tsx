import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import type { Region } from "wavesurfer.js/dist/plugins/regions.esm.js";

type TFn = (key: string) => string;

const STUDIO_CAT = "我制作的";
const REGION_COLOR = "rgba(56, 189, 248, 0.22)";

function fmtMs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, "0")}`;
}

function cssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export type StudioClipPatch = {
  startMs: number;
  endMs: number;
  fadeInMs: number;
  fadeOutMs: number;
};

export default function SfxStudioEditor({
  path,
  label,
  libraryRoot,
  t,
  onExported,
  onError,
  clipMode = false,
  initialStartMs,
  initialEndMs,
  initialFadeInMs,
  initialFadeOutMs,
  onClipChange,
}: {
  path: string;
  label: string;
  libraryRoot: string | null;
  t: TFn;
  onExported?: (dest: string) => void;
  onError: (err: string) => void;
  /** When true, edits sync to a montage clip instead of exporting a single file. */
  clipMode?: boolean;
  initialStartMs?: number;
  initialEndMs?: number;
  initialFadeInMs?: number;
  initialFadeOutMs?: number;
  onClipChange?: (patch: StudioClipPatch) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const regionRef = useRef<Region | null>(null);
  const onClipChangeRef = useRef(onClipChange);
  onClipChangeRef.current = onClipChange;
  const initRef = useRef({
    start: initialStartMs,
    end: initialEndMs,
    fadeIn: initialFadeInMs,
    fadeOut: initialFadeOutMs,
  });
  initRef.current = {
    start: initialStartMs,
    end: initialEndMs,
    fadeIn: initialFadeInMs,
    fadeOut: initialFadeOutMs,
  };
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [durMs, setDurMs] = useState(0);
  const [selStartMs, setSelStartMs] = useState(initialStartMs ?? 0);
  const [selEndMs, setSelEndMs] = useState(initialEndMs ?? 0);
  const [fadeInMs, setFadeInMs] = useState(initialFadeInMs ?? 0);
  const [fadeOutMs, setFadeOutMs] = useState(initialFadeOutMs ?? 80);
  const [previewVol, setPreviewVol] = useState(0.85);
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const fitToWidth = () => {
    const ws = wsRef.current;
    const host = hostRef.current;
    if (!ws || !host) return 1;
    const dur = ws.getDuration();
    if (!dur || !Number.isFinite(dur) || dur <= 0) return 1;
    const w = Math.max(120, host.clientWidth || host.parentElement?.clientWidth || 400);
    // px/sec so the whole file fits; floor a bit so scrollbar disappears
    const px = Math.max(1, Math.floor((w - 4) / dur));
    setMinZoom(px);
    setZoom(px);
    try {
      ws.zoom(px);
    } catch {
      /* ignore */
    }
    return px;
  };

  useEffect(() => {
    const host = hostRef.current;
    const timelineEl = timelineRef.current;
    if (!host || !timelineEl) return;

    setReady(false);
    setPlaying(false);
    setLoadErr(null);
    regionRef.current = null;

    const regions = RegionsPlugin.create();
    regionsRef.current = regions;

    const waveColor = cssColor("--muted", "#94a3b8");
    const progressColor = cssColor("--icon-on", "#38bdf8");
    const cursorColor = cssColor("--text", "#e2e8f0");

    const ws = WaveSurfer.create({
      container: host,
      height: 168,
      waveColor,
      progressColor,
      cursorColor,
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      dragToSeek: true,
      url: convertFileSrc(path),
      plugins: [
        regions,
        TimelinePlugin.create({
          container: timelineEl,
          height: 20,
          timeInterval: 0.5,
          primaryLabelInterval: 2,
          secondaryLabelInterval: 1,
          style: {
            fontSize: "10px",
            color: waveColor,
          },
        }),
      ],
    });
    wsRef.current = ws;
    ws.setVolume(previewVol);

    const syncSel = (r: Region) => {
      regionRef.current = r;
      setSelStartMs(Math.round(r.start * 1000));
      setSelEndMs(Math.round(r.end * 1000));
    };

    const ensureRegion = () => {
      const dur = ws.getDuration();
      if (!dur || !Number.isFinite(dur)) return;
      const durMsLocal = Math.round(dur * 1000);
      setDurMs(durMsLocal);
      const existing = regions.getRegions()[0];
      if (existing) {
        syncSel(existing);
        return;
      }
      const init = initRef.current;
      let start = 0;
      let end = Math.min(dur, Math.max(0.15, Math.min(2, dur * 0.35)));
      if (init.start != null && init.end != null && init.end > init.start + 20) {
        start = Math.max(0, Math.min(dur - 0.05, init.start / 1000));
        end = Math.max(start + 0.05, Math.min(dur, init.end / 1000));
      }
      if (init.fadeIn != null) setFadeInMs(init.fadeIn);
      if (init.fadeOut != null) setFadeOutMs(init.fadeOut);
      const r = regions.addRegion({
        start,
        end,
        color: REGION_COLOR,
        drag: true,
        resize: true,
      });
      syncSel(r);
    };

    const onReady = () => {
      setReady(true);
      ensureRegion();
      // Always open fitted to full duration — fixed min zoom was too high for long clips
      requestAnimationFrame(() => fitToWidth());
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onFinish = () => setPlaying(false);
    const onErrorEv = (err: Error) => {
      setLoadErr(String(err?.message || err));
      onError(t("sfxStudioLoadFail"));
    };

    ws.on("ready", onReady);
    ws.on("play", onPlay);
    ws.on("pause", onPause);
    ws.on("finish", onFinish);
    ws.on("error", onErrorEv);

    regions.enableDragSelection({ color: REGION_COLOR });

    regions.on("region-created", (r) => {
      for (const old of regions.getRegions()) {
        if (old.id !== r.id) old.remove();
      }
      syncSel(r);
    });
    regions.on("region-updated", syncSel);
    regions.on("region-clicked", (r, e) => {
      e.stopPropagation();
      r.play(true);
    });

    return () => {
      ws.un("ready", onReady);
      ws.un("play", onPlay);
      ws.un("pause", onPause);
      ws.un("finish", onFinish);
      ws.un("error", onErrorEv);
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      regionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    try {
      ws.zoom(zoom);
    } catch {
      /* ignore */
    }
  }, [zoom, ready]);

  useEffect(() => {
    wsRef.current?.setVolume(previewVol);
  }, [previewVol]);

  useEffect(() => {
    if (!clipMode || !onClipChangeRef.current) return;
    if (selEndMs <= selStartMs) return;
    onClipChangeRef.current({
      startMs: selStartMs,
      endMs: selEndMs,
      fadeInMs,
      fadeOutMs,
    });
  }, [clipMode, selStartMs, selEndMs, fadeInMs, fadeOutMs]);

  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        el?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const ws = wsRef.current;
      if (!ws) return;
      if (ws.isPlaying()) {
        ws.pause();
        return;
      }
      const r = regionRef.current ?? regionsRef.current?.getRegions()[0];
      if (r) r.play(true);
      else void ws.play();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ready]);

  const setRegionMs = (startMs: number, endMs: number) => {
    const ws = wsRef.current;
    const regions = regionsRef.current;
    if (!ws || !regions) return;
    const dur = ws.getDuration();
    if (!dur) return;
    const start = Math.max(0, Math.min(dur - 0.05, startMs / 1000));
    const end = Math.max(start + 0.05, Math.min(dur, endMs / 1000));
    let r = regionRef.current ?? regions.getRegions()[0];
    if (!r) {
      r = regions.addRegion({
        start,
        end,
        color: REGION_COLOR,
        drag: true,
        resize: true,
      });
    } else {
      r.setOptions({ start, end });
    }
    regionRef.current = r;
    setSelStartMs(Math.round(start * 1000));
    setSelEndMs(Math.round(end * 1000));
  };

  const playToggle = () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.isPlaying()) ws.pause();
    else void ws.play();
  };

  const playSelection = () => {
    const r = regionRef.current ?? regionsRef.current?.getRegions()[0];
    if (!r) return;
    r.play(true);
  };

  const selectAll = () => {
    if (!durMs) return;
    setRegionMs(0, durMs);
  };

  const exportClip = async () => {
    if (clipMode) return;
    if (!libraryRoot) {
      onError(t("sfxNeedLibrary"));
      return;
    }
    if (selEndMs <= selStartMs + 20) {
      onError(t("sfxExportRangeNeed"));
      return;
    }
    setBusy(true);
    try {
      const dest = await invoke<string>("sfx_export_range", {
        path,
        startMs: selStartMs,
        endMs: selEndMs,
        dest: null,
        fadeInMs,
        fadeOutMs,
        libraryRoot,
        category: STUDIO_CAT,
      });
      onExported?.(dest);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const selLen = Math.max(0, selEndMs - selStartMs);

  return (
    <div className="sfx-editor">
      <div className="sfx-editor-head">
        <div className="sfx-editor-title" title={path}>
          {label}
        </div>
        <div className="sfx-editor-meta muted">
          {loadErr
            ? loadErr
            : ready
              ? `${t("sfxStudioSelLen")} ${fmtMs(selLen)} · ${fmtMs(selStartMs)} → ${fmtMs(selEndMs)} / ${fmtMs(durMs)}`
              : t("sfxStudioLoading")}
        </div>
      </div>

      <p className="sfx-editor-cut-hint">
        {clipMode ? t("sfxStudioClipEditHint") : t("sfxStudioEditHint")}
      </p>

      <div className="sfx-editor-wave-wrap">
        <div ref={hostRef} className="sfx-editor-wave" />
        <div ref={timelineRef} className="sfx-editor-timeline" />
      </div>

      <div className="sfx-editor-toolbar">
        <button type="button" className="sfx-chip action" disabled={!ready} onClick={playToggle}>
          {playing ? t("sfxStudioPause") : t("sfxPlayOnce")}
        </button>
        <button
          type="button"
          className="sfx-chip action"
          disabled={!ready}
          onClick={playSelection}
        >
          {t("sfxStudioPlaySel")}
        </button>
        <button type="button" className="sfx-chip action" disabled={!ready} onClick={selectAll}>
          {t("sfxStudioSelectAll")}
        </button>
        <label className="sfx-editor-vol" title={t("sfxStudioVol")}>
          <span>{t("sfxStudioVol")}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(previewVol * 100)}
            onChange={(e) => setPreviewVol(Number(e.target.value) / 100)}
            disabled={!ready}
          />
          <span className="sfx-editor-vol-pct">{Math.round(previewVol * 100)}%</span>
        </label>
        <button
          type="button"
          className="sfx-chip action"
          disabled={!ready}
          title={t("sfxStudioZoomFit")}
          onClick={() => fitToWidth()}
        >
          {t("sfxStudioZoomFit")}
        </button>
        <label className="sfx-editor-zoom">
          <span>{t("sfxStudioZoom")}</span>
          <input
            type="range"
            min={minZoom}
            max={Math.max(minZoom * 24, minZoom + 80)}
            value={Math.max(minZoom, Math.min(zoom, Math.max(minZoom * 24, minZoom + 80)))}
            onChange={(e) => setZoom(Number(e.target.value))}
            disabled={!ready}
          />
        </label>
      </div>

      <div className="sfx-editor-fades">
        <label className="sfx-editor-num">
          <span>{t("sfxRangeStartPrompt")}</span>
          <input
            type="number"
            min={0}
            step={10}
            disabled={!ready}
            value={selStartMs}
            onChange={(e) => setRegionMs(Number(e.target.value) || 0, selEndMs)}
          />
        </label>
        <label className="sfx-editor-num">
          <span>{t("sfxRangeEndPrompt")}</span>
          <input
            type="number"
            min={50}
            step={10}
            disabled={!ready}
            value={selEndMs}
            onChange={(e) => setRegionMs(selStartMs, Number(e.target.value) || selStartMs + 50)}
          />
        </label>
        <label>
          <span>{t("sfxStudioFadeIn")}</span>
          <input
            type="number"
            min={0}
            max={10000}
            step={50}
            value={fadeInMs}
            onChange={(e) => setFadeInMs(Math.max(0, Number(e.target.value) || 0))}
          />
          <span className="muted">ms</span>
        </label>
        <label>
          <span>{t("sfxStudioFadeOut")}</span>
          <input
            type="number"
            min={0}
            max={10000}
            step={50}
            value={fadeOutMs}
            onChange={(e) => setFadeOutMs(Math.max(0, Number(e.target.value) || 0))}
          />
          <span className="muted">ms</span>
        </label>
      </div>

      {!clipMode ? (
        <div className="sfx-editor-export-row">
          <button
            type="button"
            className="sfx-editor-export"
            disabled={!ready || busy || !libraryRoot}
            title={t("sfxStudioExportHint")}
            onClick={() => void exportClip()}
          >
            {busy ? t("sfxStudioExporting") : t("sfxStudioExport")}
          </button>
          <span className="muted sfx-editor-export-tip">{t("sfxStudioExportHint")}</span>
        </div>
      ) : (
        <p className="muted sfx-editor-export-tip">{t("sfxStudioClipSynced")}</p>
      )}
    </div>
  );
}
