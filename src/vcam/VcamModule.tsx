import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Video } from "lucide-react";
import { useI18n } from "../i18n";

type ModuleChrome = {
  title?: string;
  meta?: string;
  tools?: React.ReactNode;
};

type VcamStatus = {
  deviceName: string;
  installed: boolean;
  running: boolean;
  pushing?: boolean;
  frames?: number;
  source?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  warn?: string | null;
  message: string;
  sourceNote: string;
  dllPath?: string | null;
};

/** Output presets for companion (default 1080p30). */
const RES_PRESETS = [
  { id: "1080p30", label: "1920×1080 · 30fps", w: 1920, h: 1080, fps: 30 },
  { id: "1080p60", label: "1920×1080 · 60fps", w: 1920, h: 1080, fps: 60 },
  { id: "720p30", label: "1280×720 · 30fps", w: 1280, h: 720, fps: 30 },
  { id: "720p60", label: "1280×720 · 60fps", w: 1280, h: 720, fps: 60 },
] as const;

type VcamSource = { name: string };

type VcamPreview = {
  width: number;
  height: number;
  dataUrl: string;
};

type Props = {
  embedded?: boolean;
  onChromeChange?: (chrome: ModuleChrome | null) => void;
};

const TEST_VALUE = "__test__";

/** Local idle-only bars. NEVER use while native output is running. */
function drawTestPattern(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tick: number,
) {
  const bands = 8;
  const colors = [
    "#ebebeb",
    "#ebeb16",
    "#16ebeb",
    "#16eb16",
    "#eb16eb",
    "#eb1616",
    "#1616eb",
    "#101010",
  ];
  const bw = w / bands;
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = colors[i];
    ctx.fillRect(i * bw, 0, bw + 1, h);
  }
  const barX = (tick * 4) % Math.max(1, w - 48);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(barX, h / 3, 48, h / 3);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, h - 28, w, 28);
  ctx.fillStyle = "#fff";
  ctx.font = "12px system-ui,sans-serif";
  ctx.fillText("FLYBOX · test pattern (idle only)", 10, h - 10);
}

export default function VcamModule({ embedded, onChromeChange }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<VcamStatus | null>(null);
  const [sources, setSources] = useState<VcamSource[]>([]);
  const [selected, setSelected] = useState<string>(TEST_VALUE);
  const [resId, setResId] = useState<string>(() => {
    try {
      // Prefer 1080p30: many webcams (C930c) cannot open 1080p60 natively.
      const saved = localStorage.getItem("flybox.vcam.res") || "1080p30";
      return saved === "1080p60" ? "1080p30" : saved;
    } catch {
      return "1080p30";
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [previewHint, setPreviewHint] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<"video" | "canvas" | "empty">(
    "empty",
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Bumps on every preview mode change — kills stale rAF / intervals. */
  const previewGenRef = useRef(0);
  const rafRef = useRef(0);
  const intervalRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<VcamStatus>("vcam_status");
      setStatus(s);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const list = await invoke<VcamSource[]>("vcam_list_sources");
      setSources(list);
      setSelected((prev) => {
        if (prev !== TEST_VALUE && list.some((x) => x.name === prev)) return prev;
        return list[0]?.name ?? TEST_VALUE;
      });
    } catch (e) {
      setSources([]);
      setErr(String(e));
    }
  }, []);

  function killPreviewWork() {
    previewGenRef.current += 1;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = 0;
    }
  }

  function releaseCamera() {
    if (streamRef.current) {
      for (const tr of streamRef.current.getTracks()) tr.stop();
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  function clearCanvas(color = "#0a0a0c") {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  async function openPhysicalCamera(name: string): Promise<void> {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      for (const tr of tmp.getTracks()) tr.stop();
    } catch {
      /* ignore */
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cam = devices.find(
      (d) =>
        d.kind === "videoinput" &&
        d.label &&
        (d.label === name || d.label.includes(name) || name.includes(d.label)),
    );
    const stream = await navigator.mediaDevices.getUserMedia({
      video: cam?.deviceId
        ? {
            deviceId: { ideal: cam.deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    streamRef.current = stream;
    setPreviewKind("video");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => undefined);
    }
  }

  /**
   * OBS-style start:
   * 1) fully release WebView camera
   * 2) Rust/ffmpeg opens dshow at full 30fps → SHM
   * UI only polls a lightweight thumbnail (does not feed the pipe).
   */
  async function startOutput(sourceName: string) {
    killPreviewWork();
    releaseCamera();
    setPreviewKind("canvas");
    clearCanvas();
    setPreviewHint(t("vcamPreviewConnecting"));
    const preset =
      RES_PRESETS.find((p) => p.id === resId) ?? RES_PRESETS[0];
    // Fully drop WebView camera pins (idle preview holds the device exclusively).
    releaseCamera();
    await new Promise((r) => window.setTimeout(r, 800));
    await invoke("vcam_start", {
      source: sourceName === TEST_VALUE ? null : sourceName,
      width: preset.w,
      height: preset.h,
      fps: preset.fps,
    });
  }

  useEffect(() => {
    void refresh();
    void loadSources();
  }, [refresh, loadSources]);

  useEffect(() => {
    const id = window.setInterval(
      () => {
        void refresh();
      },
      status?.running ? 3000 : 4000,
    );
    return () => window.clearInterval(id);
  }, [refresh, status?.running]);

  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    onChromeChange({
      title: t("vcamTitle"),
      meta: status?.running
        ? t("vcamMetaOn")
        : status?.installed
          ? t("vcamMetaReady")
          : t("vcamMetaSetup"),
    });
    return () => onChromeChange(null);
  }, [embedded, onChromeChange, t, status?.running, status?.installed]);

  // Preview modes — always kill previous work first (gen token).
  useEffect(() => {
    const gen = ++previewGenRef.current;
    const alive = () => gen === previewGenRef.current;

    // Cancel any previous rAF / interval from older gen.
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = 0;
    }

    const running = !!status?.running;
    const activeSource = status?.source || null;
    const pick = selected;

    if (busy && !running) {
      setPreviewHint(t("vcamPreviewConnecting"));
      return () => {
        previewGenRef.current += 1;
      };
    }

    // —— Running: Rust writes SHM at full rate. Preview = read virtual device
    // (same as companion) OR backend JPEG thumbnail as fallback. ——
    if (running) {
      releaseCamera();
      setPreviewKind("canvas");
      clearCanvas("#111");
      setPreviewHint(
        activeSource
          ? `${t("vcamPreviewLiveHint")} (${activeSource} → FLYBOX Camera)`
          : t("vcamPreviewPatternHint"),
      );

      const img = new Image();
      let usingVideo = false;

      const paintBackendThumb = async () => {
        if (!alive() || usingVideo || document.hidden) return;
        try {
          const p = await invoke<VcamPreview | null>("vcam_preview");
          if (!alive() || !p?.dataUrl) return;
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject();
            img.src = p.dataUrl;
          }).catch(() => undefined);
          if (!alive() || usingVideo) return;
          const canvas = canvasRef.current;
          if (!canvas) return;
          if (canvas.width !== p.width || canvas.height !== p.height) {
            canvas.width = p.width;
            canvas.height = p.height;
          }
          const ctx = canvas.getContext("2d");
          ctx?.drawImage(img, 0, 0, p.width, p.height);
        } catch {
          /* ignore */
        }
      };

      const tryOpenVirtualCam = async (): Promise<boolean> => {
        try {
          // Unlock labels
          try {
            const tmp = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
            for (const tr of tmp.getTracks()) tr.stop();
          } catch {
            /* ignore */
          }
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cam = devices.find(
            (d) =>
              d.kind === "videoinput" &&
              /FLYBOX\s*Camera/i.test(d.label || ""),
          );
          if (!cam?.deviceId) return false;
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: cam.deviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
          if (!alive()) {
            for (const tr of stream.getTracks()) tr.stop();
            return false;
          }
          streamRef.current = stream;
          usingVideo = true;
          setPreviewKind("video");
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play().catch(() => undefined);
          }
          return true;
        } catch {
          return false;
        }
      };

      // Virtual cam is a reader pin — multiple clients OK (companion + us).
      // Retry: filter may need a moment after SHM becomes READY.
      void (async () => {
        for (let i = 0; i < 12 && alive(); i++) {
          if (await tryOpenVirtualCam()) return;
          await new Promise((r) => window.setTimeout(r, 400));
        }
        // Fallback: backend half-res JPEG thumbs
        void paintBackendThumb();
        intervalRef.current = window.setInterval(() => {
          void paintBackendThumb();
        }, 200);
      })();

      return () => {
        if (intervalRef.current) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = 0;
        }
        releaseCamera();
      };
    }

    // —— Idle: local physical preview OR local test bars only. ——
    releaseCamera();

    if (pick === TEST_VALUE) {
      setPreviewKind("canvas");
      setPreviewHint(t("vcamPreviewIdleTest"));
      const loop = (tick: number) => {
        if (!alive()) return;
        const c = canvasRef.current;
        if (!c) {
          rafRef.current = requestAnimationFrame(() => loop(tick));
          return;
        }
        const ctx = c.getContext("2d");
        if (ctx) drawTestPattern(ctx, c.width, c.height, tick);
        rafRef.current = requestAnimationFrame(() => loop(tick + 1));
      };
      rafRef.current = requestAnimationFrame(() => loop(0));
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      };
    }

    setPreviewHint(t("vcamPreviewConnecting"));
    void (async () => {
      try {
        await openPhysicalCamera(pick);
        if (!alive()) {
          releaseCamera();
          return;
        }
        setPreviewHint(`${t("vcamPreviewSourceHint")} ${pick}`);
      } catch {
        if (!alive()) return;
        setPreviewKind("canvas");
        setPreviewHint(t("vcamPreviewSourceFail"));
        const loop = (tick: number) => {
          if (!alive()) return;
          const c = canvasRef.current;
          if (!c) {
            rafRef.current = requestAnimationFrame(() => loop(tick));
            return;
          }
          const ctx = c.getContext("2d");
          if (ctx) drawTestPattern(ctx, c.width, c.height, tick);
          rafRef.current = requestAnimationFrame(() => loop(tick + 1));
        };
        rafRef.current = requestAnimationFrame(() => loop(0));
      }
    })();

    return () => {
      previewGenRef.current += 1;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = 0;
      }
      // Don't release camera here if a newer gen already re-opened it —
      // gen bump handles invalidation; release only when leaving module.
    };
  }, [status?.running, status?.source, selected, busy, t]);

  // On unmount: free camera
  useEffect(() => {
    return () => {
      killPreviewWork();
      releaseCamera();
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setErr(String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const installed = !!status?.installed;
  const running = !!status?.running;
  const canInstall = !busy && !installed && !!status?.dllPath;
  const canUninstall = !busy && installed && !running;
  const canStart = !busy && installed && !running;
  const canStop = !busy && running;

  return (
    <div className="vcam-module">
      <div className="vcam-hero">
        <div className="vcam-hero-icon" aria-hidden>
          <Video size={28} strokeWidth={1.5} />
        </div>
        <div>
          <h2 className="vcam-hero-title">{t("vcamTitle")}</h2>
          <p className="muted vcam-hero-desc">{t("vcamDesc")}</p>
        </div>
      </div>

      <section className="vcam-card">
        <div className="vcam-card-label">{t("vcamSourceTitle")}</div>
        <div className="vcam-source-row">
          <select
            className="vcam-source-select"
            value={selected}
            disabled={busy || running}
            onChange={(e) => setSelected(e.target.value)}
          >
            {sources.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
            <option value={TEST_VALUE}>{t("vcamSourceTest")}</option>
          </select>
          <button
            type="button"
            className="settings-path-btn"
            disabled={busy || running}
            onClick={() => void loadSources()}
          >
            {t("refresh")}
          </button>
        </div>
        <p className="muted vcam-note">{t("vcamSourceHint")}</p>
        <div className="vcam-card-label" style={{ marginTop: 12 }}>
          {t("vcamResTitle")}
        </div>
        <div className="vcam-source-row">
          <select
            className="vcam-source-select"
            value={resId}
            disabled={busy || running}
            onChange={(e) => {
              const v = e.target.value;
              setResId(v);
              try {
                localStorage.setItem("flybox.vcam.res", v);
              } catch {
                /* ignore */
              }
            }}
          >
            {RES_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <p className="muted vcam-note">{t("vcamResHint")}</p>
      </section>

      <section className="vcam-card">
        <div className="vcam-card-label">{t("vcamPreviewTitle")}</div>
        <div className={`vcam-preview ${running ? "on" : ""}`}>
          <video
            ref={videoRef}
            className="vcam-preview-video"
            muted
            playsInline
            autoPlay
            style={{ display: previewKind === "video" ? "block" : "none" }}
          />
          <canvas
            ref={canvasRef}
            className="vcam-preview-canvas"
            width={640}
            height={360}
            style={{ display: previewKind !== "video" ? "block" : "none" }}
          />
        </div>
        {previewHint ? (
          <p className="muted vcam-note vcam-preview-hint">{previewHint}</p>
        ) : null}
      </section>

      <section className="vcam-card">
        <div className="vcam-card-label">{t("vcamStatusTitle")}</div>
        {status ? (
          <ul className="vcam-status-list">
            <li>
              <span className="muted">{t("vcamDeviceName")}</span>
              <strong>{status.deviceName}</strong>
            </li>
            <li>
              <span className="muted">{t("vcamSourceActive")}</span>
              <strong>
                {status.running
                  ? status.source || t("vcamSourceTest")
                  : "—"}
              </strong>
            </li>
            <li>
              <span className="muted">{t("vcamResActive")}</span>
              <strong>
                {status.running && status.width && status.height
                  ? `${status.width}×${status.height} @ ${status.fps ?? 30}fps`
                  : "—"}
              </strong>
            </li>
            <li>
              <span className="muted">{t("vcamInstalled")}</span>
              <span
                className={
                  installed ? "vcam-pill vcam-pill-ok" : "vcam-pill vcam-pill-off"
                }
              >
                {installed ? t("vcamYes") : t("vcamNo")}
              </span>
            </li>
            <li>
              <span className="muted">{t("vcamRunning")}</span>
              <span
                className={
                  running ? "vcam-pill vcam-pill-live" : "vcam-pill vcam-pill-off"
                }
              >
                {running ? t("vcamYes") : t("vcamNo")}
              </span>
            </li>
            <li>
              <span className="muted">{t("vcamPushing")}</span>
              <span
                className={
                  status.pushing
                    ? "vcam-pill vcam-pill-live"
                    : "vcam-pill vcam-pill-off"
                }
              >
                {status.pushing
                  ? `${t("vcamYes")} (${status.frames ?? 0})`
                  : t("vcamNo")}
              </span>
            </li>
            <li className="vcam-status-msg">
              <span className="muted">{status.message}</span>
            </li>
          </ul>
        ) : (
          <p className="muted">{t("vcamLoading")}</p>
        )}
        {err ? <p className="banner error">{err}</p> : null}
        {status?.warn ? <p className="banner error">{status.warn}</p> : null}
        <div className="vcam-actions">
          {!installed ? (
            <button
              type="button"
              className="settings-path-btn vcam-btn-primary"
              disabled={!canInstall}
              onClick={() => void run(() => invoke("vcam_install"))}
            >
              {t("vcamInstall")}
            </button>
          ) : (
            <button
              type="button"
              className="settings-path-btn"
              disabled={!canUninstall}
              onClick={() => void run(() => invoke("vcam_uninstall"))}
            >
              {t("vcamUninstall")}
            </button>
          )}
          {!running ? (
            <button
              type="button"
              className="settings-path-btn vcam-btn-primary"
              disabled={!canStart}
              onClick={() => void run(() => startOutput(selected))}
            >
              {t("vcamStart")}
            </button>
          ) : (
            <button
              type="button"
              className="settings-path-btn"
              disabled={!canStop}
              onClick={() =>
                void run(async () => {
                  killPreviewWork();
                  releaseCamera();
                  await invoke("vcam_stop");
                })
              }
            >
              {t("vcamStop")}
            </button>
          )}
        </div>
      </section>

      <section className="vcam-card">
        <div className="vcam-card-label">{t("vcamHowTitle")}</div>
        <ol className="vcam-steps">
          <li>{t("vcamHow1")}</li>
          <li>{t("vcamHow2")}</li>
          <li>{t("vcamHow3")}</li>
        </ol>
        <p className="muted vcam-note">{t("vcamNoteBuild")}</p>
        {status?.sourceNote ? (
          <p className="muted vcam-note">{status.sourceNote}</p>
        ) : null}
      </section>
    </div>
  );
}
