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
  warn?: string | null;
  message: string;
  sourceNote: string;
  dllPath?: string | null;
};

type VcamSource = { name: string };

type Props = {
  embedded?: boolean;
  onChromeChange?: (chrome: ModuleChrome | null) => void;
};

const TEST_VALUE = "__test__";

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
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, h - 28, w, 28);
  ctx.fillStyle = "#fff";
  ctx.font = "12px system-ui,sans-serif";
  ctx.fillText("FLYBOX · test pattern", 10, h - 10);
}

export default function VcamModule({ embedded, onChromeChange }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<VcamStatus | null>(null);
  const [sources, setSources] = useState<VcamSource[]>([]);
  const [selected, setSelected] = useState<string>(TEST_VALUE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [previewHint, setPreviewHint] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<"video" | "canvas" | "empty">(
    "empty",
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const pushTimerRef = useRef(0);

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
        if (prev !== TEST_VALUE && list.some((x) => x.name === prev)) {
          return prev;
        }
        return list[0]?.name ?? TEST_VALUE;
      });
    } catch (e) {
      setSources([]);
      setErr(String(e));
    }
  }, []);

  function stopPushLoop() {
    if (pushTimerRef.current) {
      window.clearInterval(pushTimerRef.current);
      pushTimerRef.current = 0;
    }
  }

  function releasePreviewCamera() {
    stopPushLoop();
    if (streamRef.current) {
      for (const tr of streamRef.current.getTracks()) tr.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  async function openPhysicalCamera(name: string): Promise<MediaStream> {
    // Permission + labels
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      for (const tr of tmp.getTracks()) tr.stop();
    } catch {
      /* continue */
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
    return stream;
  }

  function startJpegPushLoop() {
    stopPushLoop();
    if (!grabRef.current) {
      grabRef.current = document.createElement("canvas");
    }
    const grab = grabRef.current;
    grab.width = 1280;
    grab.height = 720;
    const ctx = grab.getContext("2d");
    if (!ctx) return;

    let pushing = false;
    pushTimerRef.current = window.setInterval(() => {
      if (pushing) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      pushing = true;
      try {
        ctx.drawImage(video, 0, 0, 1280, 720);
        grab.toBlob(
          (blob) => {
            if (!blob) {
              pushing = false;
              return;
            }
            void blob
              .arrayBuffer()
              .then((ab) =>
                invoke("vcam_push_jpeg", {
                  jpeg: Array.from(new Uint8Array(ab)),
                }),
              )
              .catch(() => undefined)
              .finally(() => {
                pushing = false;
              });
          },
          "image/jpeg",
          0.72,
        );
      } catch {
        pushing = false;
      }
    }, 66); // ~15 fps
  }

  async function startOutput(sourceName: string) {
    if (sourceName === TEST_VALUE) {
      releasePreviewCamera();
      await invoke("vcam_start", { source: null });
      return;
    }
    // Keep WebView camera open — backend no longer grabs dshow exclusively.
    if (!streamRef.current) {
      await openPhysicalCamera(sourceName);
    }
    await invoke("vcam_start", { source: sourceName });
    startJpegPushLoop();
  }

  useEffect(() => {
    void refresh();
    void loadSources();
  }, [refresh, loadSources]);

  useEffect(() => {
    const ms = status?.running ? 1000 : 2500;
    const id = window.setInterval(() => {
      void refresh();
    }, ms);
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

  // Preview management
  useEffect(() => {
    let cancelled = false;

    function stopRaf() {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    }

    function startPattern(hint: string) {
      stopRaf();
      setPreviewKind("canvas");
      setPreviewHint(hint);
      requestAnimationFrame(() => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        let tick = 0;
        const loop = () => {
          if (cancelled) return;
          drawTestPattern(ctx, canvas.width, canvas.height, tick++);
          rafRef.current = requestAnimationFrame(loop);
        };
        loop();
      });
    }

    async function setup() {
      stopRaf();
      const running = !!status?.running;
      const activeSource = status?.source || null;
      const pick = selected;

      if (busy && !running) {
        setPreviewHint(t("vcamPreviewConnecting"));
        return;
      }

      if (running && activeSource) {
        // Real camera: keep video element + push loop
        setPreviewHint(
          `${t("vcamPreviewLiveHint")} (${activeSource} → FLYBOX Camera)`,
        );
        if (!streamRef.current) {
          try {
            await openPhysicalCamera(activeSource);
          } catch (e) {
            if (!cancelled) setErr(String(e));
            return;
          }
        } else {
          setPreviewKind("video");
        }
        if (!pushTimerRef.current) startJpegPushLoop();
        return;
      }

      if (running && !activeSource) {
        // Test pattern from backend — show local bars matching output
        stopPushLoop();
        startPattern(t("vcamPreviewPatternHint"));
        return;
      }

      // Idle
      stopPushLoop();
      if (pick === TEST_VALUE) {
        releasePreviewCamera();
        startPattern(t("vcamPreviewIdleTest"));
        return;
      }

      setPreviewHint(t("vcamPreviewConnecting"));
      try {
        if (
          !streamRef.current ||
          streamRef.current.getVideoTracks()[0]?.label !== pick
        ) {
          releasePreviewCamera();
          await openPhysicalCamera(pick);
        } else {
          setPreviewKind("video");
        }
        setPreviewHint(`${t("vcamPreviewSourceHint")} ${pick}`);
      } catch {
        if (!cancelled) startPattern(t("vcamPreviewSourceFail"));
      }
    }

    void setup();
    return () => {
      cancelled = true;
      stopRaf();
    };
  }, [status?.running, status?.source, selected, busy, t]);

  // Stop push when not running
  useEffect(() => {
    if (!status?.running) stopPushLoop();
  }, [status?.running]);

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
      </section>

      <section className="vcam-card">
        <div className="vcam-card-label">{t("vcamPreviewTitle")}</div>
        <div className={`vcam-preview ${running ? "on" : ""}`}>
          {previewKind === "empty" ? (
            <div className="vcam-preview-empty">
              <div className="vcam-onair">{t("vcamOnAir")}</div>
              <div className="muted">{status?.source}</div>
            </div>
          ) : null}
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
            style={{ display: previewKind === "canvas" ? "block" : "none" }}
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
                  stopPushLoop();
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
