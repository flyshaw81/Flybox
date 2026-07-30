import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ChevronDown,
  Maximize2,
  Play,
  RefreshCw,
  Scan,
  Square,
} from "lucide-react";
import { useI18n } from "../i18n";
import {
  getBeautyEngineHint,
  getFaceLandmarker,
  paintBeautyFrame,
} from "./beautyCanvas";

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
  aspect?: string;
  warn?: string | null;
  /** mf | ffmpeg | test */
  captureBackend?: string | null;
  /** contain | cover — OBS bounding box style (always keep aspect) */
  fitMode?: string;
  message: string;
  sourceNote: string;
  dllPath?: string | null;
};

/** Clarity tier — short side in pixels (720p / 1K / 2K / 4K). */
const QUALITY_TIERS = [
  { id: "720", label: "720p", base: 720 },
  { id: "1k", label: "1K", base: 1080 },
  { id: "2k", label: "2K", base: 1440 },
  { id: "4k", label: "4K", base: 2160 },
] as const;

/** Aspect ratio — combined with quality tier → canvas width×height. */
const ASPECT_RATIOS = [
  { id: "16:9", aw: 16, ah: 9, labelKey: "vcamAspect169" as const },
  { id: "4:3", aw: 4, ah: 3, labelKey: "vcamAspect43" as const },
  { id: "3:4", aw: 3, ah: 4, labelKey: "vcamAspect34" as const },
  { id: "9:16", aw: 9, ah: 16, labelKey: "vcamAspect916" as const },
  { id: "1:1", aw: 1, ah: 1, labelKey: "vcamAspect11" as const },
] as const;

function even(n: number): number {
  return Math.max(2, Math.round(n) & ~1);
}

/** OBS-style: Xp = short side for landscape height / portrait width. */
function canvasSize(base: number, aw: number, ah: number): { w: number; h: number } {
  if (aw === ah) {
    const s = even(base);
    return { w: s, h: s };
  }
  if (aw > ah) {
    const h = even(base);
    const w = even((base * aw) / ah);
    return { w, h };
  }
  const w = even(base);
  const h = even((base * ah) / aw);
  return { w, h };
}

function tierFromSize(w: number, h: number): string {
  const short = Math.min(w, h);
  let best: (typeof QUALITY_TIERS)[number] = QUALITY_TIERS[0];
  let bestD = Math.abs(short - best.base);
  for (const t of QUALITY_TIERS) {
    const d = Math.abs(short - t.base);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best.id;
}

/** Tier allowed only if camera short-side can reach it (product: no fake 4K). */
function tierAllowed(
  base: number,
  maxW?: number,
  maxH?: number,
): boolean {
  // Unknown or junk probe (e.g. 800×448): do not trust — allow up to 1K only.
  if (
    !maxW ||
    !maxH ||
    maxW < 640 ||
    maxH < 480 ||
    maxW * maxH < 1280 * 720
  ) {
    return base <= 1080;
  }
  const short = Math.min(maxW, maxH);
  return base <= short + 16;
}

function highestAllowedTierId(maxW?: number, maxH?: number): string {
  let id = "720";
  for (const t of QUALITY_TIERS) {
    if (tierAllowed(t.base, maxW, maxH)) id = t.id;
  }
  return id;
}

function aspectFromSize(w: number, h: number): string {
  const r = w / Math.max(1, h);
  let best: (typeof ASPECT_RATIOS)[number] = ASPECT_RATIOS[0];
  let bestD = Infinity;
  for (const a of ASPECT_RATIOS) {
    const ar = a.aw / a.ah;
    const d = Math.abs(r - ar);
    if (d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best.id;
}

type VcamSource = {
  name: string;
  /** Highest native mode from the device (0 = unknown). */
  maxWidth?: number;
  maxHeight?: number;
};

type VcamPreview = {
  width: number;
  height: number;
  dataUrl: string;
};

type BeautyParams = {
  enabled: boolean;
  smooth: number;
  whiten: number;
  slim: number;
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
  const [qualityId, setQualityId] = useState<string>(() => {
    try {
      const s = localStorage.getItem("flybox.vcam.quality") || "1k";
      return QUALITY_TIERS.some((q) => q.id === s) ? s : "1k";
    } catch {
      return "1k";
    }
  });
  const [aspectId, setAspectId] = useState<string>(() => {
    try {
      const s = localStorage.getItem("flybox.vcam.aspect") || "16:9";
      return ASPECT_RATIOS.some((a) => a.id === s) ? s : "16:9";
    } catch {
      return "16:9";
    }
  });
  const [fitId, setFitId] = useState<string>(() => {
    try {
      const s = localStorage.getItem("flybox.vcam.fit") || "contain";
      // Drop legacy "stretch" (distorts people).
      return s === "cover" ? "cover" : "contain";
    } catch {
      return "contain";
    }
  });
  const [busy, setBusy] = useState(false);
  const [beauty, setBeauty] = useState<BeautyParams>({
    enabled: false,
    smooth: 0.35,
    whiten: 0.35,
    slim: 0.0,
  });
  const beautyRef = useRef(beauty);
  beautyRef.current = beauty;
  const [beautyHint, setBeautyHint] = useState("");

  function currentCanvas(): { w: number; h: number; fps: number } {
    const tier = QUALITY_TIERS.find((q) => q.id === qualityId) ?? QUALITY_TIERS[1];
    const aspect = ASPECT_RATIOS.find((a) => a.id === aspectId) ?? ASPECT_RATIOS[0];
    const { w, h } = canvasSize(tier.base, aspect.aw, aspect.ah);
    return { w, h, fps: 30 };
  }

  /**
   * Media box inside fixed 16:9 shell — true canvas aspect, centered.
   */
  const previewBoxStyle: CSSProperties = (() => {
    const { w, h } = currentCanvas();
    const ar = w / Math.max(1, h);
    const padAr = 16 / 9;
    if (ar >= padAr) {
      return {
        aspectRatio: `${w} / ${h}`,
        width: "100%",
        height: "auto",
        maxHeight: "100%",
      };
    }
    return {
      aspectRatio: `${w} / ${h}`,
      height: "100%",
      width: "auto",
      maxWidth: "100%",
    };
  })();
  const previewMediaStyle: CSSProperties = {
    objectFit: fitId === "cover" ? "cover" : "contain",
  };

  /**
   * Apply canvas size for real. While running we **stop + start** (not soft reconfigure)
   * so SHM size always changes — reconfigure used to keep old size when companion held the mapping.
   */
  async function applyCanvas(nextQuality: string, nextAspect: string, nextFit: string) {
    const tier = QUALITY_TIERS.find((q) => q.id === nextQuality) ?? QUALITY_TIERS[1];
    const aspect = ASPECT_RATIOS.find((a) => a.id === nextAspect) ?? ASPECT_RATIOS[0];
    const { w, h } = canvasSize(tier.base, aspect.aw, aspect.ah);
    const cam = sources.find((x) => x.name === selected);
    const sourceArg = selected === TEST_VALUE ? null : selected;

    // Full restart: guaranteed new VideoQueue size.
    try {
      await invoke("vcam_stop");
    } catch {
      /* may already be stopped */
    }
    await new Promise((r) => window.setTimeout(r, 250));
    freezePreviewToCanvas();
    releaseCamera();
    await new Promise((r) => window.setTimeout(r, 150));

    await invoke("vcam_start", {
      source: sourceArg,
      width: w,
      height: h,
      fps: 30,
      fitMode: nextFit,
      maxWidth: cam?.maxWidth ?? null,
      maxHeight: cam?.maxHeight ?? null,
    });

    // Poll status briefly until dimensions update (worker may take a moment).
    let aw = 0;
    let ah = 0;
    let s: VcamStatus | null = null;
    for (let i = 0; i < 20; i++) {
      s = await invoke<VcamStatus>("vcam_status");
      aw = s.width ?? 0;
      ah = s.height ?? 0;
      if (s.running && aw > 0 && ah > 0) break;
      await new Promise((r) => window.setTimeout(r, 100));
    }
    if (s) setStatus(s);

    // Accept clamp within 2px even; otherwise surface mismatch.
    if (!s?.running) {
      throw new Error("切换未成功，请先在伴侣里取消 FLYBOX 摄像头后再试");
    }
    if (Math.abs(aw - w) > 2 || Math.abs(ah - h) > 2) {
      setErr(`已按摄像头能力调整为 ${aw}×${ah}`);
    } else {
      setErr(null);
    }
  }
  const [err, setErr] = useState<string | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  const qualityBtnRef = useRef<HTMLButtonElement | null>(null);
  const qualityMenuRef = useRef<HTMLDivElement | null>(null);
  const [qualityMenuPos, setQualityMenuPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceBtnRef = useRef<HTMLButtonElement | null>(null);
  const sourceMenuRef = useRef<HTMLDivElement | null>(null);
  const [sourceMenuPos, setSourceMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
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
      // Keep quality / aspect / fit in sync with actual backend canvas.
      if (s.running && s.width && s.height) {
        const q = tierFromSize(s.width, s.height);
        const a = s.aspect && ASPECT_RATIOS.some((x) => x.id === s.aspect)
          ? s.aspect
          : aspectFromSize(s.width, s.height);
        setQualityId((prev) => {
          if (prev === q) return prev;
          try {
            localStorage.setItem("flybox.vcam.quality", q);
          } catch {
            /* ignore */
          }
          return q;
        });
        setAspectId((prev) => {
          if (prev === a) return prev;
          try {
            localStorage.setItem("flybox.vcam.aspect", a);
          } catch {
            /* ignore */
          }
          return a;
        });
        if (s.fitMode === "contain" || s.fitMode === "cover") {
          setFitId((prev) => {
            if (prev === s.fitMode) return prev;
            try {
              localStorage.setItem("flybox.vcam.fit", s.fitMode!);
            } catch {
              /* ignore */
            }
            return s.fitMode!;
          });
        }
      }
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const list = await invoke<VcamSource[]>("vcam_list_sources");
      setSources(list);
      setSelected((prev) => {
        const next =
          prev !== TEST_VALUE && list.some((x) => x.name === prev)
            ? prev
            : (list[0]?.name ?? TEST_VALUE);
        // Snap quality to this camera's real max (no fake 2K/4K on 1080p cams).
        const cam = list.find((x) => x.name === next);
        if (cam) {
          const top = highestAllowedTierId(cam.maxWidth, cam.maxHeight);
          setQualityId((q) => {
            const cur = QUALITY_TIERS.find((t) => t.id === q);
            if (cur && tierAllowed(cur.base, cam.maxWidth, cam.maxHeight)) {
              return q;
            }
            try {
              localStorage.setItem("flybox.vcam.quality", top);
            } catch {
              /* ignore */
            }
            return top;
          });
        }
        return next;
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
    // Use a normal landscape capture for idle preview; CSS box + object-fit handles aspect.
    // Forcing 1:1 / 9:16 getUserMedia makes some webcams stretch in the browser.
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

  /** Freeze last video frame onto canvas so start does not flash black for seconds. */
  function freezePreviewToCanvas() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw < 2 || vh < 2) return;
    try {
      canvas.width = vw;
      canvas.height = vh;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(video, 0, 0, vw, vh);
      setPreviewKind("canvas");
    } catch {
      /* ignore */
    }
  }

  /**
   * OBS-style start:
   * 1) freeze last preview frame (no black flash)
   * 2) release WebView camera quickly
   * 3) Rust opens capture → SHM; UI keeps frozen frame until first live thumb
   */
  async function startOutput(sourceName: string) {
    killPreviewWork();
    // Keep last picture visible while backend opens the device.
    freezePreviewToCanvas();
    releaseCamera();
    const canvas = currentCanvas();
    const cam =
      sourceName === TEST_VALUE
        ? undefined
        : sources.find((x) => x.name === sourceName);
    // Short settle only — 800ms black wait was the main “卡几秒” feel.
    await new Promise((r) => window.setTimeout(r, 120));
    await invoke("vcam_start", {
      source: sourceName === TEST_VALUE ? null : sourceName,
      width: canvas.w,
      height: canvas.h,
      fps: canvas.fps,
      fitMode: fitId,
      maxWidth: cam?.maxWidth ?? null,
      maxHeight: cam?.maxHeight ?? null,
    });
  }

  useEffect(() => {
    void refresh();
    void loadSources();
    void (async () => {
      try {
        const p = await invoke<BeautyParams>("beauty_get");
        setBeauty(p);
      } catch {
        /* ignore */
      }
    })();
  }, [refresh, loadSources]);

  async function applyBeauty(next: BeautyParams) {
    setBeauty(next);
    try {
      localStorage.setItem("flybox.vcam.beauty", JSON.stringify(next));
    } catch {
      /* ignore */
    }
    try {
      const p = await invoke<BeautyParams>("beauty_set", { params: next });
      setBeauty(p);
    } catch (e) {
      setErr(String(e));
    }
  }

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
    const pick = selected;

    if (busy && !running) {
      // Keep frozen/last frame on canvas — do not clear to black.
      return () => {
        previewGenRef.current += 1;
      };
    }

    // —— Running: Rust writes SHM at full rate. Preview = backend JPEG (shows beauty).
    // Prefer backend thumbs when beauty is on so UI matches virtual cam pipeline. ——
    if (running) {
      releaseCamera();
      setPreviewKind("canvas");
      // Do not clearCanvas — keep freeze frame until first live thumb arrives.

      const img = new Image();
      let usingVideo = false;
      // Beauty path must show processed SHM thumbs, not raw local camera.
      const preferBackendOnly = beauty.enabled;

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
          // Canvas buffer matches output frame; CSS aspect-ratio + object-fit paints without stretch.
          if (canvas.width !== p.width || canvas.height !== p.height) {
            canvas.width = p.width;
            canvas.height = p.height;
          }
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, p.width, p.height);
          }
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
          // Don't force 16:9 on the virtual cam — use native negotiated size + CSS fit.
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: cam.deviceId },
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

      // Always paint backend thumbs immediately (keeps freeze→live seamless).
      // Virtual-cam getUserMedia is optional upgrade — never block thumbs for seconds.
      void paintBackendThumb();
      intervalRef.current = window.setInterval(() => {
        if (!usingVideo) void paintBackendThumb();
      }, preferBackendOnly ? 80 : 120);

      if (!preferBackendOnly) {
        void (async () => {
          for (let i = 0; i < 6 && alive() && !usingVideo; i++) {
            if (await tryOpenVirtualCam()) {
              if (intervalRef.current) {
                window.clearInterval(intervalRef.current);
                intervalRef.current = 0;
              }
              return;
            }
            await new Promise((r) => window.setTimeout(r, 250));
          }
        })();
      }

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

    void (async () => {
      try {
        await openPhysicalCamera(pick);
        if (!alive()) {
          releaseCamera();
          return;
        }
        // Beauty ON: MediaPipe face lock + face-only composite (not full-screen filter)
        if (beauty.enabled) {
          setPreviewKind("canvas");
          setBeautyHint("加载人脸模型…");
          void getFaceLandmarker().then((lm) => {
            if (!alive()) return;
            if (!lm) setBeautyHint("人脸模型失败");
          });
          void invoke("beauty_warmup").catch(() => undefined);
          let lastTs = 0;
          let busy = false;
          let lastHint = "";
          const loop = (ts: number) => {
            if (!alive()) return;
            rafRef.current = requestAnimationFrame(loop);
            if (document.hidden || busy) return;
            // ~15–20 fps: face detect + beauty + mask composite
            if (ts - lastTs < 50) return;
            lastTs = ts;
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (!video || !canvas || video.videoWidth < 2) return;
            busy = true;
            void paintBeautyFrame(video, canvas, beautyRef.current, 960, ts)
              .then((r) => {
                if (!alive() || !beautyRef.current.enabled) return;
                if (!r.ready) return;
                const h = getBeautyEngineHint() || "人脸美颜";
                if (h !== lastHint) {
                  lastHint = h;
                  setBeautyHint(h);
                }
              })
              .finally(() => {
                busy = false;
              });
          };
          rafRef.current = requestAnimationFrame(loop);
        } else {
          setBeautyHint("");
        }
      } catch {
        if (!alive()) return;
        setPreviewKind("canvas");
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
        window.clearTimeout(intervalRef.current);
        window.clearInterval(intervalRef.current);
        intervalRef.current = 0;
      }
      // Don't release camera here if a newer gen already re-opened it —
      // gen bump handles invalidation; release only when leaving module.
    };
  }, [status?.running, status?.source, selected, busy, t, beauty.enabled]);

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
  const canStart = !busy && installed && !running;
  const canStop = !busy && running;
  const cam = sources.find((x) => x.name === selected);
  const canvas = currentCanvas();
  const outLabel =
    running && status?.width && status?.height
      ? `${status.width}×${status.height}`
      : `${canvas.w}×${canvas.h}`;
  const sourceLabel =
    selected === TEST_VALUE
      ? t("vcamSourceTest")
      : selected || t("vcamSourceTitle");
  const sourceChoices = [
    ...sources.map((s) => ({ id: s.name, label: s.name })),
    { id: TEST_VALUE, label: t("vcamSourceTest") },
  ];

  function pickSource(name: string) {
    setSourceOpen(false);
    setSelected(name);
    if (name === TEST_VALUE) return;
    const c = sources.find((x) => x.name === name);
    if (!c) return;
    const top = highestAllowedTierId(c.maxWidth, c.maxHeight);
    setQualityId((q) => {
      const cur = QUALITY_TIERS.find((tier) => tier.id === q);
      if (cur && tierAllowed(cur.base, c.maxWidth, c.maxHeight)) return q;
      try {
        localStorage.setItem("flybox.vcam.quality", top);
      } catch {
        /* ignore */
      }
      return top;
    });
  }

  function pickQuality(v: string) {
    if (busy) return;
    setQualityOpen(false);
    if (v === qualityId) return;
    const prev = qualityId;
    setQualityId(v);
    try {
      localStorage.setItem("flybox.vcam.quality", v);
    } catch {
      /* ignore */
    }
    if (!running) return;
    void run(async () => {
      try {
        await applyCanvas(v, aspectId, fitId);
      } catch (e) {
        setQualityId(prev);
        try {
          localStorage.setItem("flybox.vcam.quality", prev);
        } catch {
          /* ignore */
        }
        throw e;
      }
    });
  }

  useLayoutEffect(() => {
    if (!qualityOpen) {
      setQualityMenuPos(null);
      return;
    }
    const place = () => {
      const btn = qualityBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setQualityMenuPos({
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [qualityOpen]);

  useLayoutEffect(() => {
    if (!sourceOpen) {
      setSourceMenuPos(null);
      return;
    }
    const place = () => {
      const btn = sourceBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setSourceMenuPos({
        top: r.bottom + 6,
        left: r.left,
        width: r.width,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [sourceOpen]);

  useEffect(() => {
    if (!qualityOpen && !sourceOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (qualityOpen) {
        if (qualityBtnRef.current?.contains(t)) return;
        if (qualityMenuRef.current?.contains(t)) return;
        setQualityOpen(false);
      }
      if (sourceOpen) {
        if (sourceBtnRef.current?.contains(t)) return;
        if (sourceMenuRef.current?.contains(t)) return;
        setSourceOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setQualityOpen(false);
        setSourceOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [qualityOpen, sourceOpen]);

  function pickAspect(v: string) {
    if (busy) return;
    const prev = aspectId;
    setAspectId(v);
    try {
      localStorage.setItem("flybox.vcam.aspect", v);
    } catch {
      /* ignore */
    }
    if (!running) return;
    void run(async () => {
      try {
        await applyCanvas(qualityId, v, fitId);
      } catch (e) {
        setAspectId(prev);
        try {
          localStorage.setItem("flybox.vcam.aspect", prev);
        } catch {
          /* ignore */
        }
        throw e;
      }
    });
  }

  function pickFit(v: string) {
    if (busy) return;
    const prev = fitId;
    setFitId(v);
    try {
      localStorage.setItem("flybox.vcam.fit", v);
    } catch {
      /* ignore */
    }
    if (!running) return;
    void run(async () => {
      try {
        await applyCanvas(qualityId, aspectId, v);
      } catch (e) {
        setFitId(prev);
        try {
          localStorage.setItem("flybox.vcam.fit", prev);
        } catch {
          /* ignore */
        }
        throw e;
      }
    });
  }

  return (
    <div className="vcam-studio">
      <div className={`vcam-toolbar ${sourceOpen ? "open" : ""}`}>
        <div className={`vcam-srcdrop ${sourceOpen ? "open" : ""}`}>
          <button
            type="button"
            ref={sourceBtnRef}
            className="vcam-srcdrop-btn"
            disabled={busy || running}
            aria-label={t("vcamSourceTitle")}
            aria-expanded={sourceOpen}
            aria-haspopup="listbox"
            onClick={() => {
              setQualityOpen(false);
              setSourceOpen((o) => !o);
            }}
          >
            <span className="vcam-srcdrop-label">{sourceLabel}</span>
            <ChevronDown
              className="vcam-srcdrop-chev"
              size={14}
              strokeWidth={2.2}
              absoluteStrokeWidth
            />
          </button>
          {sourceOpen && sourceMenuPos
            ? createPortal(
                <div
                  ref={sourceMenuRef}
                  className="vcam-srcdrop-menu"
                  role="listbox"
                  style={{
                    top: sourceMenuPos.top,
                    left: sourceMenuPos.left,
                    width: Math.max(sourceMenuPos.width, 220),
                  }}
                >
                  {sourceChoices.map((opt) => {
                    const on = selected === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        className={`vcam-srcdrop-item ${on ? "on" : ""}`}
                        disabled={busy || running}
                        onClick={() => pickSource(opt.id)}
                      >
                        <span className="vcam-srcdrop-item-label">
                          {opt.label}
                        </span>
                        {on ? (
                          <Check
                            size={14}
                            strokeWidth={2.4}
                            absoluteStrokeWidth
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )
            : null}
        </div>
        <div className="vcam-toolbar-acts" aria-hidden={false}>
          <button
            type="button"
            className="vcam-tool-icon"
            disabled={busy || running}
            onClick={() => void loadSources()}
            title={t("refresh")}
            aria-label={t("refresh")}
          >
            <RefreshCw size={17} strokeWidth={1.85} absoluteStrokeWidth />
          </button>
          {!installed ? (
            <button
              type="button"
              className="vcam-tool-icon"
              disabled={!canInstall}
              onClick={() => void run(() => invoke("vcam_install"))}
              title={t("vcamInstall")}
              aria-label={t("vcamInstall")}
            >
              <Play size={17} strokeWidth={1.85} absoluteStrokeWidth />
            </button>
          ) : !running ? (
            <button
              type="button"
              className="vcam-tool-icon"
              disabled={!canStart}
              onClick={() => void run(() => startOutput(selected))}
              title={t("vcamStart")}
              aria-label={t("vcamStart")}
            >
              <Play size={17} strokeWidth={1.85} absoluteStrokeWidth />
            </button>
          ) : (
            <button
              type="button"
              className="vcam-tool-icon"
              disabled={!canStop}
              onClick={() =>
                void run(async () => {
                  killPreviewWork();
                  releaseCamera();
                  await invoke("vcam_stop");
                })
              }
              title={t("vcamStop")}
              aria-label={t("vcamStop")}
            >
              <Square size={14} strokeWidth={2.2} absoluteStrokeWidth />
            </button>
          )}
        </div>
      </div>

      <div className={`vcam-stage ${running ? "live" : ""}`}>
        {/*
          chrome = no clip (page-bg ring can cover AA fringe)
          shell  = sole clip node for video
        */}
        <div className="vcam-stage-chrome">
          <div className="vcam-stage-shell">
            <div className="vcam-stage-media" style={previewBoxStyle}>
              <video
                ref={videoRef}
                className="vcam-preview-video"
                muted
                playsInline
                autoPlay
                style={{
                  display: previewKind === "video" ? "block" : "none",
                  ...previewMediaStyle,
                }}
              />
              <canvas
                ref={canvasRef}
                className="vcam-preview-canvas"
                width={Math.min(960, canvas.w)}
                height={Math.min(
                  960,
                  Math.round(
                    (Math.min(960, canvas.w) * canvas.h) /
                      Math.max(1, canvas.w),
                  ),
                )}
                style={{
                  display: previewKind !== "video" ? "block" : "none",
                  ...previewMediaStyle,
                }}
              />
            </div>
            <div className="vcam-stage-hud top">
              <span className={`vcam-badge ${running ? "live" : ""}`}>
                <i className="vcam-badge-dot" aria-hidden />
                {running ? t("vcamMetaOn") : t("vcamMetaReady")}
              </span>
              <div className={`vcam-qdrop ${qualityOpen ? "open" : ""}`}>
                <button
                  type="button"
                  ref={qualityBtnRef}
                  className="vcam-qdrop-btn"
                  disabled={busy}
                  title={outLabel}
                  aria-label={t("vcamQualityTitle")}
                  aria-expanded={qualityOpen}
                  aria-haspopup="listbox"
                  onClick={() => {
                    setSourceOpen(false);
                    setQualityOpen((o) => !o);
                  }}
                >
                  <span>
                    {QUALITY_TIERS.find((q) => q.id === qualityId)?.label ??
                      qualityId}
                  </span>
                  <ChevronDown
                    className="vcam-qdrop-chev"
                    size={11}
                    strokeWidth={2.5}
                    absoluteStrokeWidth
                  />
                </button>
                {qualityOpen && qualityMenuPos
                  ? createPortal(
                      <div
                        ref={qualityMenuRef}
                        className="vcam-qdrop-menu"
                        role="listbox"
                        style={{
                          top: qualityMenuPos.top,
                          right: qualityMenuPos.right,
                        }}
                      >
                        {QUALITY_TIERS.map((q) => {
                          const ok =
                            selected === TEST_VALUE ||
                            tierAllowed(
                              q.base,
                              cam?.maxWidth,
                              cam?.maxHeight,
                            );
                          const on = qualityId === q.id;
                          return (
                            <button
                              key={q.id}
                              type="button"
                              role="option"
                              aria-selected={on}
                              className={`vcam-qdrop-item ${on ? "on" : ""}`}
                              disabled={busy || !ok}
                              onClick={() => pickQuality(q.id)}
                            >
                              <span className="vcam-qdrop-item-label">
                                {q.label}
                              </span>
                              {on ? (
                                <Check
                                  size={14}
                                  strokeWidth={2.4}
                                  absoluteStrokeWidth
                                />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
            </div>
            <div className="vcam-stage-hud bottom">
              <div
                className="vcam-stage-aspect"
                role="group"
                aria-label={t("vcamAspectTitle")}
              >
                {ASPECT_RATIOS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`vcam-hud-chip ${aspectId === a.id ? "on" : ""}`}
                    disabled={busy}
                    onClick={() => pickAspect(a.id)}
                  >
                    {a.id}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`vcam-hud-fit ${fitId === "cover" ? "on" : ""}`}
                disabled={busy}
                title={
                  fitId === "cover" ? t("vcamFitCover") : t("vcamFitContain")
                }
                aria-label={
                  fitId === "cover" ? t("vcamFitCover") : t("vcamFitContain")
                }
                onClick={() =>
                  pickFit(fitId === "cover" ? "contain" : "cover")
                }
              >
                {fitId === "cover" ? (
                  <Maximize2
                    size={16}
                    strokeWidth={1.85}
                    absoluteStrokeWidth
                  />
                ) : (
                  <Scan size={16} strokeWidth={1.85} absoluteStrokeWidth />
                )}
              </button>
            </div>
          </div>
        </div>
        {err ? <p className="vcam-toast err">{err}</p> : null}
      </div>

      <div className="vcam-beauty">
        <button
          type="button"
          className={`vcam-beauty-toggle ${beauty.enabled ? "on" : ""}`}
          onClick={() =>
            void applyBeauty({ ...beauty, enabled: !beauty.enabled })
          }
        >
          {t("beautyTitle")} ·{" "}
          {beauty.enabled ? t("beautyOn") : t("beautyOff")}
          {beauty.enabled ? (
            <span className="vcam-beauty-engine">
              {beautyHint || "人脸美颜"}
            </span>
          ) : null}
        </button>
        {beauty.enabled ? (
          <div className="vcam-beauty-sliders">
            <label className="vcam-beauty-row">
              <span>{t("beautySmooth")}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(beauty.smooth * 100)}
                onChange={(e) =>
                  void applyBeauty({
                    ...beauty,
                    smooth: Number(e.target.value) / 100,
                  })
                }
              />
            </label>
            <label className="vcam-beauty-row">
              <span>{t("beautyWhiten")}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(beauty.whiten * 100)}
                onChange={(e) =>
                  void applyBeauty({
                    ...beauty,
                    whiten: Number(e.target.value) / 100,
                  })
                }
              />
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}
