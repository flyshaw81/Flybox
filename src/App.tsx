import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { load } from "@tauri-apps/plugin-store";
import {
  Columns3,
  Copy,
  FolderOpen,
  FolderSearch,
  Image as ImageIcon,
  LayoutGrid,
  FileText,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  ArrowLeft,
  AudioLines,
  X,
} from "lucide-react";
import Passbox from "./Passbox";
import Notepad from "./Notepad";
import Soundboard from "./Soundboard";
import ContextMenu, { openCtxMenu, type CtxItem, type CtxMenuState } from "./ContextMenu";
import { LangButton, useI18n } from "./i18n";
import { ThemeButton, useTheme } from "./theme";
import SettingsPopover, {
  DEFAULT_APP_SETTINGS,
  readAutostart,
  setAutostart,
  type AppSettings,
} from "./SettingsPopover";
import {
  applyBrandColors,
  DEFAULT_ACCENT,
  DEFAULT_ASSIST,
  normalizeHex,
} from "./brandColors";
import logoDark from "./assets/flyshaw-logo-white-transparent.png";
import logoLight from "./assets/flyshaw-logo-transparent.png";

/** 子模块上报到唯一顶栏的场景信息 + 右侧工具 */
export type ModuleChrome = {
  title?: string;
  meta?: string;
  /** 自定义左侧场景区（如音效子页签）；有则优先于 title/meta */
  context?: ReactNode;
  tools?: ReactNode;
};

const appWindow = getCurrentWindow();
const ICO = 16;
const ICO_WIN = 14;

/** 顶栏品牌：手写标 + FLYBOX 名；点击打开设置 */
function BrandLogo({ onClick }: { onClick: () => void }) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const src = theme === "light" ? logoLight : logoDark;
  return (
    <button
      type="button"
      className="logo logo-btn"
      title={t("settings")}
      onClick={onClick}
      data-tauri-drag-region={undefined}
    >
      <img className="logo-img" src={src} alt="" draggable={false} />
      <span className="logo-text">{t("appName")}</span>
    </button>
  );
}

type MediaKind = "image" | "video";

type ImageEntry = {
  path: string;
  name: string;
  width: number;
  height: number;
  /** 后端 kind；缺省当图片（兼容旧缓存） */
  kind?: MediaKind | string;
};

function isVideoPath(path: string, kind?: string): boolean {
  return kind === "video" || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(path);
}

function isVideoEntry(img: ImageEntry): boolean {
  return isVideoPath(img.path, img.kind);
}

/** 网格 · 瀑布；点缩略图放大 = 单图预览（灯箱），不再单独设「单图模式」 */
type ViewMode = "grid" | "waterfall";

const STORE_FILE = "settings.json";
const VAULT_KEY = "vaultPath";
const RESTORE_VAULT_KEY = "restoreVault";
const DEEP_DEFAULT_KEY = "deepScanDefault";
const START_MIN_KEY = "startMinimized";
const ACCENT_KEY = "accentColor";
const ASSIST_KEY = "assistColor";
/** 缩略图并发：图片可高一点；视频抽帧更重，单独限流 */
const THUMB_CONCURRENCY = 6;
const VIDEO_THUMB_CONCURRENCY = 2;


declare global {
  interface Window {
    __FLYPHOTO_ORIGIN__?: string;
  }
}

function localFileUrl(path: string): string {
  const origin = window.__FLYPHOTO_ORIGIN__;
  if (!origin) return "";
  return `${origin}/__file?p=${encodeURIComponent(path)}`;
}

async function getStore() {
  return load(STORE_FILE, { autoSave: true });
}

const thumbUrlCache = new Map<string, string>();
/** 视频真实分辨率（抽帧后写入，瀑布流按此排） */
const mediaSizeCache = new Map<string, { width: number; height: number }>();

type QueueJob = {
  path: string;
  kind?: string;
  resolve: (url: string) => void;
  reject: (err: unknown) => void;
};

const queue: QueueJob[] = [];
let activeWorkers = 0;
let activeVideoWorkers = 0;

type VideoFrameResult = { dataUrl: string; width: number; height: number };

/** 从视频抽一帧当封面，并带回真实宽高（瀑布流要用） */
function captureVideoFrame(path: string): Promise<VideoFrameResult> {
  return new Promise((resolve, reject) => {
    const url = localFileUrl(path);
    if (!url) {
      reject(new Error("no origin"));
      return;
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      fn();
    };
    const timer = window.setTimeout(() => {
      done(() => reject(new Error("video thumb timeout")));
    }, 10000);

    const snap = () => {
      const vw = video.videoWidth || 0;
      const vh = video.videoHeight || 0;
      if (vw < 2 || vh < 2) {
        done(() => reject(new Error("no frame")));
        return;
      }
      // 缩略图最长边 480，保持真实比例
      const scale = Math.min(1, 480 / Math.max(vw, vh));
      const w = Math.max(2, Math.round(vw * scale));
      const h = Math.max(2, Math.round(vh * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        done(() => reject(new Error("no canvas")));
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.84);
      done(() => resolve({ dataUrl, width: vw, height: vh }));
    };

    video.addEventListener("error", () => {
      done(() => reject(new Error("video load error")));
    });
    video.addEventListener("loadeddata", () => {
      try {
        const dur = Number.isFinite(video.duration) ? video.duration : 0;
        const t = dur > 3 ? Math.min(1.5, dur * 0.1) : dur > 0.4 ? 0.2 : 0;
        if (t < 0.05) {
          snap();
          return;
        }
        video.addEventListener("seeked", () => snap(), { once: true });
        video.currentTime = t;
      } catch (e) {
        done(() => reject(e));
      }
    });
    video.src = url;
  });
}

function pumpQueue() {
  while (activeWorkers < THUMB_CONCURRENCY && queue.length > 0) {
    // 视频抽帧限流：队列头是视频且视频槽满了 → 先找后面的图片任务
    let jobIndex = 0;
    while (jobIndex < queue.length) {
      const cand = queue[jobIndex]!;
      const isVid = isVideoPath(cand.path, cand.kind);
      if (!isVid || activeVideoWorkers < VIDEO_THUMB_CONCURRENCY) break;
      jobIndex += 1;
    }
    if (jobIndex >= queue.length) break;
    const job = queue.splice(jobIndex, 1)[0]!;
    const isVid = isVideoPath(job.path, job.kind);
    activeWorkers += 1;
    if (isVid) activeVideoWorkers += 1;
    void (async () => {
      try {
        const cached = thumbUrlCache.get(job.path);
        if (cached) {
          job.resolve(cached);
          return;
        }
        if (isVid) {
          try {
            const frame = await captureVideoFrame(job.path);
            thumbUrlCache.set(job.path, frame.dataUrl);
            mediaSizeCache.set(job.path, {
              width: frame.width,
              height: frame.height,
            });
            job.resolve(frame.dataUrl);
            return;
          } catch {
            /* fall through to backend placeholder */
          }
        }
        const dataUrl = await invoke<string>("get_thumbnail", { path: job.path });
        if (!dataUrl.startsWith("data:image/")) throw new Error("invalid thumb");
        thumbUrlCache.set(job.path, dataUrl);
        job.resolve(dataUrl);
      } catch (e) {
        job.reject(e);
      } finally {
        activeWorkers -= 1;
        if (isVid) activeVideoWorkers -= 1;
        pumpQueue();
      }
    })();
  }
}

function resolveThumbUrl(imagePath: string, kind?: string): Promise<string> {
  const hit = thumbUrlCache.get(imagePath);
  if (hit) return Promise.resolve(hit);
  return new Promise<string>((resolve, reject) => {
    queue.push({ path: imagePath, kind, resolve, reject });
    pumpQueue();
  });
}

/** 全局只允许一个格子在悬停预览播，避免卡顿 */
let activePreviewVideo: HTMLVideoElement | null = null;
const PREVIEW_HOVER_DELAY_MS = 90;

function stopActivePreview() {
  if (!activePreviewVideo) return;
  try {
    activePreviewVideo.pause();
    activePreviewVideo.removeAttribute("src");
    activePreviewVideo.load();
  } catch {
    /* ignore */
  }
  activePreviewVideo = null;
  window.dispatchEvent(new CustomEvent("flybox-stop-preview"));
}

const Tile = memo(function Tile({
  img,
  index,
  layout,
  onOpen,
  onContextMenu,
  scrollRoot,
  onMediaSize,
}: {
  img: ImageEntry;
  index: number;
  layout: "grid" | "waterfall";
  onOpen: (index: number) => void;
  onContextMenu?: (e: React.MouseEvent, index: number) => void;
  scrollRoot: HTMLElement | null;
  /** 视频抽到真实宽高后回调，瀑布流重排 */
  onMediaSize?: (path: string, width: number, height: number) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState<string | null>(() => thumbUrlCache.get(img.path) ?? null);
  const [ready, setReady] = useState(() => thumbUrlCache.has(img.path));
  const [failed, setFailed] = useState(false);
  /** 悬停时格子内静音循环预览 */
  const [previewing, setPreviewing] = useState(false);
  const video = isVideoEntry(img);
  const cachedSize = mediaSizeCache.get(img.path);
  const w = cachedSize?.width || img.width;
  const h = cachedSize?.height || img.height;

  // 瀑布流：视频用真实比例；假 16:9 会让一排视频全长得一样、很难看
  const ar =
    layout === "grid"
      ? 1
      : w > 0 && h > 0
        ? w / h
        : video
          ? 16 / 9
          : 0.75;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let started = false;

    const run = () => {
      if (started || cancelled) return;
      started = true;
      void resolveThumbUrl(img.path, img.kind)
        .then((url) => {
          if (!cancelled) {
            setSrc(url);
            setFailed(false);
            const sz = mediaSizeCache.get(img.path);
            if (sz && onMediaSize) onMediaSize(img.path, sz.width, sz.height);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };

    // Already cached → show immediately (no IO wait).
    if (thumbUrlCache.has(img.path)) {
      run();
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      run();
      return;
    }

    // Observe against the real scroll container (not window) — critical for nested scroll.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          run();
          io.disconnect();
        }
      },
      { root: scrollRoot, rootMargin: "600px 0px", threshold: 0.01 },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [img.path, img.kind, scrollRoot, onMediaSize]);

  const hoverTimer = useRef<number | null>(null);

  const startPreview = useCallback(() => {
    if (!video) return;
    const v = videoRef.current;
    if (!v) return;
    const fileUrl = localFileUrl(img.path);
    if (!fileUrl) return;
    if (activePreviewVideo && activePreviewVideo !== v) {
      stopActivePreview();
    }
    if (v.getAttribute("src") !== fileUrl) {
      v.src = fileUrl;
    }
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    activePreviewVideo = v;
    setPreviewing(true);
    void v.play().catch(() => {
      /* 自动播失败时仍显示封面 */
    });
  }, [video, img.path]);

  const stopPreview = useCallback(() => {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (!video) return;
    const v = videoRef.current;
    if (v && activePreviewVideo === v) {
      try {
        v.pause();
        v.currentTime = 0;
      } catch {
        /* ignore */
      }
      activePreviewVideo = null;
    }
    setPreviewing(false);
  }, [video]);

  const schedulePreview = useCallback(() => {
    if (!video) return;
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
    // 轻微延迟：快速划过格子不启动解码，滚动更顺
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      startPreview();
    }, PREVIEW_HOVER_DELAY_MS);
  }, [video, startPreview]);

  useEffect(() => {
    const onStop = () => setPreviewing(false);
    window.addEventListener("flybox-stop-preview", onStop);
    return () => {
      window.removeEventListener("flybox-stop-preview", onStop);
      if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
      if (videoRef.current && activePreviewVideo === videoRef.current) {
        stopActivePreview();
      }
    };
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      className={
        (layout === "waterfall" ? "tile tile-wf" : "tile tile-grid") +
        (video ? " tile-has-video" : "") +
        (previewing ? " tile-previewing" : "")
      }
      style={
        layout === "waterfall"
          ? ({ ["--ar" as string]: String(ar) } as React.CSSProperties)
          : undefined
      }
      onClick={() => onOpen(index)}
      onContextMenu={(e) => onContextMenu?.(e, index)}
      onMouseEnter={() => schedulePreview()}
      onMouseLeave={() => stopPreview()}
      onFocus={() => schedulePreview()}
      onBlur={() => stopPreview()}
      title={video ? `${img.name} · 悬停预览，点击全屏播` : img.name}
    >
      {!ready && !failed && <div className="tile-ph" aria-hidden />}
      {failed && !src && <div className="tile-ph fail">无法预览</div>}
      {src && (
        <img
          src={src}
          alt={img.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          className={
            (ready ? "on " : "") +
            (video && layout === "waterfall" ? "tile-img-video " : "") +
            (previewing ? "tile-img-dim" : "")
          }
          onLoad={() => setReady(true)}
          onError={() => {
            setFailed(true);
            setSrc(null);
            setReady(false);
          }}
        />
      )}
      {video && (
        <video
          ref={videoRef}
          className={previewing ? "tile-video-preview on" : "tile-video-preview"}
          muted
          loop
          playsInline
          preload="none"
          // 不设 controls，格子里是预览
        />
      )}
      {video && !previewing && ready && src && (
        <span className="tile-video-badge" aria-label="video" />
      )}
    </button>
  );
});

/**
 * JS multi-column waterfall (shortest-column packing).
 * 对照 masonic / Pinterest：
 * - 只在「列数变化」时 React 重排；拖窗口过程中列宽交给 CSS flex，避免每像素 setState
 * - 高度用相对比例（宽抵消），最短列算法与像素宽无关
 */
const WF_GAP = 12;
const WF_TARGET_COL = 220;

function waterfallColCount(width: number): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.floor((width + WF_GAP) / (WF_TARGET_COL + WF_GAP)) || 1);
}

function WaterfallGallery({
  images,
  onOpen,
  onContextMenu,
  scrollRoot,
  onMediaSize,
}: {
  images: ImageEntry[];
  onOpen: (index: number) => void;
  onContextMenu?: (e: React.MouseEvent, index: number) => void;
  scrollRoot: HTMLElement | null;
  onMediaSize?: (path: string, width: number, height: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [colCount, setColCount] = useState(1);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const next = waterfallColCount(el.clientWidth);
      setColCount((prev) => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver(() => {
      // rAF 合并：一帧最多算一次列数，不在拖拽中 setTimeout 堆积
      if (raf) return;
      raf = requestAnimationFrame(apply);
    });
    ro.observe(el);
    apply();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // 仅 images / 列数变时重算列分配；拖宽不重算
  const columns = useMemo(() => {
    const cols: { img: ImageEntry; index: number }[][] = Array.from(
      { length: colCount },
      () => [],
    );
    const heights = Array.from({ length: colCount }, () => 0);
    for (let index = 0; index < images.length; index++) {
      const img = images[index];
      let minI = 0;
      for (let i = 1; i < colCount; i++) {
        if (heights[i] < heights[minI]) minI = i;
      }
      const sz = mediaSizeCache.get(img.path);
      const iw = sz?.width || img.width;
      const ih = sz?.height || img.height;
      // 相对高（与列像素宽无关）；视频未测前 16:9
      const ar =
        iw > 0 && ih > 0
          ? ih / iw
          : isVideoEntry(img)
            ? 9 / 16
            : 1.25;
      cols[minI].push({ img, index });
      heights[minI] += ar + 0.05;
    }
    return cols;
  }, [images, colCount]);

  return (
    <div ref={wrapRef} className="waterfall-js">
      {columns.map((col, ci) => (
        <div key={ci} className="waterfall-col">
          {col.map(({ img, index }) => (
            <Tile
              key={img.path}
              img={img}
              index={index}
              layout="waterfall"
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              scrollRoot={scrollRoot}
              onMediaSize={onMediaSize}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function WinControls() {
  const { t } = useI18n();
  return (
    <div className="win-controls">
      <button
        type="button"
        className="win-btn"
        title={t("minimize")}
        onClick={() => void appWindow.minimize()}
      >
        <Minus size={ICO_WIN} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        className="win-btn"
        title={t("maximize")}
        onClick={() => void appWindow.toggleMaximize()}
      >
        <Square size={12} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        className="win-btn close"
        title={t("close")}
        onClick={() => {
          void (async () => {
            try {
              await invoke("sfx_stop_all");
            } catch {
              /* engine may already be gone */
            }
            await appWindow.close();
          })();
        }}
      >
        <X size={ICO_WIN} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  const [vault, setVault] = useState<string | null>(null);
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  /** Pan offset while zoomed — desktop image viewers always allow drag-to-move. */
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    id: number;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);
  const [booting, setBooting] = useState(true);
  /** 深扫子文件夹：默认关，只扫当前目录 */
  const [deepScan, setDeepScan] = useState(false);
  const deepScanRef = useRef(false);
  const bootRef = useRef(false);
  const loadGen = useRef(0);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const bindContent = useCallback((node: HTMLElement | null) => {
    setScrollRoot(node);
  }, []);
  /** 四大模块：图库 / 密码箱 / 记事本 / 音效 */
  type AppModule = "gallery" | "passbox" | "notepad" | "sfx";
  const [appModule, setAppModule] = useState<AppModule>("gallery");
  const [moduleChrome, setModuleChrome] = useState<ModuleChrome | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    applyBrandColors(appSettings.accentColor, appSettings.assistColor);
  }, [appSettings.accentColor, appSettings.assistColor]);
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);

  const switchModule = useCallback(
    (m: AppModule) => {
      // 已在当前模块再点一次：不要清 chrome，否则音效子页签不会重挂载也回不来
      if (m === appModule) return;
      setActiveIndex(null);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setModuleChrome(null);
      setAppModule(m);
    },
    [appModule],
  );

  const loadImages = useCallback(async (root: string, recursive?: boolean) => {
    const gen = ++loadGen.current;
    const deep = recursive ?? deepScanRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<ImageEntry[]>("list_images", {
        root,
        recursive: deep,
      });
      if (gen !== loadGen.current) return;
      setImages(list);
      // 刷新后列表变短时，修正正在看的大图下标，避免空白
      setActiveIndex((i) => {
        if (i == null) return i;
        if (list.length === 0) return null;
        return Math.min(i, list.length - 1);
      });
    } catch (e) {
      if (gen !== loadGen.current) return;
      setImages([]);
      setActiveIndex(null);
      setError(String(e));
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, []);

  const setDeepScanAndReload = useCallback(
    (on: boolean) => {
      deepScanRef.current = on;
      setDeepScan(on);
      void (async () => {
        try {
          const store = await getStore();
          await store.set(DEEP_DEFAULT_KEY, on);
        } catch {
          /* ignore */
        }
      })();
      if (vault) void loadImages(vault, on);
    },
    [vault, loadImages],
  );

  const persistAppSettings = useCallback(
    async (next: AppSettings) => {
      const prevDeep = deepScanRef.current;
      const accent = normalizeHex(next.accentColor, DEFAULT_ACCENT);
      const assist = normalizeHex(next.assistColor, DEFAULT_ASSIST);
      const normalized = { ...next, accentColor: accent, assistColor: assist };
      setAppSettings(normalized);
      applyBrandColors(accent, assist);
      deepScanRef.current = normalized.deepScanDefault;
      setDeepScan(normalized.deepScanDefault);
      try {
        const store = await getStore();
        await store.set(RESTORE_VAULT_KEY, normalized.restoreVault);
        await store.set(DEEP_DEFAULT_KEY, normalized.deepScanDefault);
        await store.set(START_MIN_KEY, normalized.startMinimized);
        await store.set(ACCENT_KEY, accent);
        await store.set(ASSIST_KEY, assist);
      } catch {
        /* ignore */
      }
      if (vault && prevDeep !== normalized.deepScanDefault) {
        void loadImages(vault, normalized.deepScanDefault);
      }
    },
    [vault, loadImages],
  );

  /** Logo：开则关、关则开 */
  const toggleSettings = useCallback(() => {
    setSettingsOpen((open) => !open);
  }, []);

  const onAutostartChange = useCallback(
    async (on: boolean) => {
      setAutostartBusy(true);
      try {
        await setAutostart(on);
        setAutostartOn(on);
      } catch {
      } finally {
        setAutostartBusy(false);
      }
    },
    [t],
  );

  const openVault = useCallback(
    async (path: string) => {
      setVault(path);
      setActiveIndex(null);
      setZoom(1);
      try {
        const store = await getStore();
        await store.set(VAULT_KEY, path);
      } catch {
        /* ignore */
      }
      await loadImages(path, deepScanRef.current);
    },
    [loadImages],
  );

  const pickVault = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("pickFolder"),
      });
      if (typeof selected === "string" && selected) {
        await openVault(selected);
      }
    } catch (e) {
    }
  }, [openVault, t]);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    (async () => {
      try {
        const store = await getStore();
        const restore = (await store.get<boolean>(RESTORE_VAULT_KEY)) ?? true;
        const deepDef = (await store.get<boolean>(DEEP_DEFAULT_KEY)) ?? false;
        const startMin = (await store.get<boolean>(START_MIN_KEY)) ?? false;
        const accent = normalizeHex(
          (await store.get<string>(ACCENT_KEY)) ?? DEFAULT_ACCENT,
          DEFAULT_ACCENT,
        );
        let assist = normalizeHex(
          (await store.get<string>(ASSIST_KEY)) ?? DEFAULT_ASSIST,
          DEFAULT_ASSIST,
        );
        // 旧出厂绿 → 新出厂蓝
        if (assist === "#3cb371") {
          assist = DEFAULT_ASSIST;
          try {
            await store.set(ASSIST_KEY, assist);
          } catch {
            /* ignore */
          }
        }
        setAppSettings({
          restoreVault: restore,
          deepScanDefault: deepDef,
          startMinimized: startMin,
          accentColor: accent,
          assistColor: assist,
        });
        applyBrandColors(accent, assist);
        deepScanRef.current = deepDef;
        setDeepScan(deepDef);

        try {
          setAutostartOn(await readAutostart());
        } catch {
          /* ignore */
        }

        if (startMin) {
          try {
            await appWindow.minimize();
          } catch {
            /* ignore */
          }
        }

        if (restore) {
          const saved = await store.get<string>(VAULT_KEY);
          if (saved) await openVault(saved);
        }
      } catch {
        /* ignore */
      } finally {
        setBooting(false);
      }
    })();
  }, [openVault]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    dragRef.current = null;
  }, []);

  const openAt = useCallback((index: number) => {
    setActiveIndex(index);
    resetView();
  }, [resetView]);

  // 窗口缩放：停悬停预览 + 关过渡，避免拖边框时解码/动画抢主线程（masonic/桌面端常见做法）
  useEffect(() => {
    let endTimer: number | null = null;
    const onResize = () => {
      document.documentElement.classList.add("is-resizing");
      stopActivePreview();
      if (endTimer != null) window.clearTimeout(endTimer);
      endTimer = window.setTimeout(() => {
        endTimer = null;
        document.documentElement.classList.remove("is-resizing");
      }, 140);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (endTimer != null) window.clearTimeout(endTimer);
      document.documentElement.classList.remove("is-resizing");
    };
  }, []);

  /** 视频真实宽高：合并一批再 setState，避免每抽一帧就整表重排 */
  const pendingSizes = useRef<Map<string, { width: number; height: number }>>(new Map());
  const sizeFlushTimer = useRef<number | null>(null);
  const onMediaSize = useCallback((path: string, width: number, height: number) => {
    if (width < 2 || height < 2) return;
    mediaSizeCache.set(path, { width, height });
    pendingSizes.current.set(path, { width, height });
    if (sizeFlushTimer.current != null) return;
    sizeFlushTimer.current = window.setTimeout(() => {
      sizeFlushTimer.current = null;
      const batch = pendingSizes.current;
      if (batch.size === 0) return;
      pendingSizes.current = new Map();
      setImages((prev) => {
        let changed = false;
        const next = prev.map((img) => {
          const sz = batch.get(img.path);
          if (!sz) return img;
          if (img.width === sz.width && img.height === sz.height) return img;
          changed = true;
          return { ...img, width: sz.width, height: sz.height };
        });
        return changed ? next : prev;
      });
    }, 80);
  }, []);

  // 滚动时停掉悬停预览，释放解码压力
  useEffect(() => {
    if (!scrollRoot) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        stopActivePreview();
      });
    };
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollRoot.removeEventListener("scroll", onScroll);
  }, [scrollRoot]);

  const closeLightbox = useCallback(() => {
    setActiveIndex(null);
    resetView();
  }, [resetView]);

  const goPrev = useCallback(() => {
    setActiveIndex((i) => {
      if (i == null || images.length === 0) return i;
      return (i - 1 + images.length) % images.length;
    });
    resetView();
  }, [images.length, resetView]);

  const goNext = useCallback(() => {
    setActiveIndex((i) => {
      if (i == null || images.length === 0) return i;
      return (i + 1) % images.length;
    });
    resetView();
  }, [images.length, resetView]);

  const zoomIn = () => setZoom((z) => Math.min(5, Math.round((z + 0.25) * 100) / 100));
  const zoomOut = () => {
    setZoom((z) => {
      const next = Math.max(0.25, Math.round((z - 0.25) * 100) / 100);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };
  const zoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const copyImage = async (entry: ImageEntry) => {
    // 视频只复制路径；图片尽量贴剪贴板
    if (isVideoEntry(entry)) {
      try {
        await writeText(entry.path);
      } catch (e) {
      }
      return;
    }
    try {
      const url = localFileUrl(entry.path);
      if (!url) throw new Error("no origin");
      const res = await fetch(url);
      if (!res.ok) throw new Error("读取图片失败");
      const blob = await res.blob();
      const type = blob.type || "image/png";
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        return;
      }
      await writeText(entry.path);
    } catch {
      try {
        await writeText(entry.path);
      } catch (e) {
      }
    }
  };

  const deleteImage = useCallback(
    async (entry: ImageEntry, index: number) => {
      // 用系统对话框，不用 window.confirm：放大预览 + 右键菜单关闭后，WebView 常吞掉 confirm
      const ok = await ask(
        `${t("deleteConfirm")}\n\n${entry.name}\n\n${t("deleteConfirmDisk")}`,
        { title: t("delete"), kind: "warning" },
      );
      if (!ok) return;
      try {
        await invoke("delete_image", { path: entry.path });
        thumbUrlCache.delete(entry.path);
        setImages((prev) => {
          const next = prev.filter((x) => x.path !== entry.path);
          setActiveIndex((cur) => {
            // 网格里删图：本来没放大，就别弹大图
            if (cur == null) return null;
            if (next.length === 0) return null;
            // 正在看大图：删的是当前/前面，修正下标
            if (index < cur) return cur - 1;
            if (index === cur) return Math.min(index, next.length - 1);
            return cur;
          });
          setZoom(1);
          setPan({ x: 0, y: 0 });
          return next;
        });
      } catch (e) {
      }
    },
    [t],
  );

  const setMode = (mode: ViewMode) => {
    setViewMode(mode);
    resetView();
    // 换浏览布局时关掉大图，避免模式叠在一起
    setActiveIndex(null);
  };

  const imageMenuItems = useCallback(
    (entry: ImageEntry, index: number, opts?: { lightbox?: boolean }): CtxItem[] => {
      const items: CtxItem[] = [];
      if (!opts?.lightbox) {
        items.push({
          id: "open",
          label: t("open"),
          onClick: () => openAt(index),
        });
      }
      items.push({
        id: "copy",
        label: t("copyImage"),
        onClick: () => void copyImage(entry),
      });
      items.push({
        id: "copy-path",
        label: t("copyPath"),
        onClick: () => {
          void writeText(entry.path).catch(() => {});
        },
      });
      items.push({ id: "sep1", separator: true });
      items.push({
        id: "delete",
        label: t("delete"),
        danger: true,
        onClick: () => void deleteImage(entry, index),
      });
      if (opts?.lightbox) {
        items.push({ id: "sep2", separator: true });
        items.push({
          id: "close",
          label: t("closePreview"),
          onClick: () => closeLightbox(),
        });
      }
      return items;
    },
    // openAt / copyImage 随渲染更新，菜单打开时会重新生成 items
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deleteImage, closeLightbox, t],
  );

  const onTileContext = useCallback(
    (e: React.MouseEvent, index: number) => {
      const entry = images[index];
      if (!entry) return;
      openCtxMenu(e, imageMenuItems(entry, index), setCtxMenu);
    },
    [images, imageMenuItems],
  );

  const onGalleryBgContext = useCallback(
    (e: React.MouseEvent) => {
      // 点在缩略图上由 Tile 自己处理
      if ((e.target as HTMLElement).closest(".tile")) return;
      const items: CtxItem[] = [
        {
          id: "pick",
          label: vault ? t("changeFolder") : t("pickFolder"),
          onClick: () => void pickVault(),
        },
      ];
      if (vault) {
        items.push({
          id: "refresh",
          label: t("refresh"),
          disabled: loading,
          onClick: () => void loadImages(vault, deepScanRef.current),
        });
      }
      items.push({ id: "sep", separator: true });
      items.push({
        id: "passbox",
        label: t("passbox"),
        onClick: () => switchModule("passbox"),
      });
      items.push({
        id: "notepad",
        label: t("notepad"),
        onClick: () => switchModule("notepad"),
      });
      items.push({
        id: "sfx",
        label: t("sfxboard"),
        onClick: () => switchModule("sfx"),
      });
      openCtxMenu(e, items, setCtxMenu);
    },
    [vault, loading, pickVault, loadImages, t, switchModule],
  );

  // 点缩略图放大 = 单图预览（灯箱）
  const lightboxOpen = activeIndex != null && images[activeIndex] != null;
  const currentIndex = lightboxOpen ? activeIndex : null;

  useEffect(() => {
    if (!lightboxOpen || currentIndex == null) return;
    const entry = images[currentIndex];
    const videoMode = entry ? isVideoEntry(entry) : false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLightbox();
        return;
      }
      if (videoMode) {
        const v = document.querySelector(
          "video.viewer-video",
        ) as HTMLVideoElement | null;
        if (e.key === " " || e.code === "Space") {
          e.preventDefault();
          if (v) {
            if (v.paused) void v.play();
            else v.pause();
          }
          return;
        }
        if (e.key === "ArrowLeft" && (e.shiftKey || e.altKey)) {
          e.preventDefault();
          if (v) v.currentTime = Math.max(0, v.currentTime - 5);
          return;
        }
        if (e.key === "ArrowRight" && (e.shiftKey || e.altKey)) {
          e.preventDefault();
          if (v) v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 5);
          return;
        }
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (!videoMode && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        zoomIn();
      } else if (!videoMode && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        zoomOut();
      } else if (!videoMode && e.key === "0") {
        e.preventDefault();
        zoomReset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen, currentIndex, images, closeLightbox, goPrev, goNext]);

  const folderName = vault
    ? vault.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || vault
    : "";

  const viewing =
    lightboxOpen && currentIndex != null && images[currentIndex]
      ? images[currentIndex]
      : null;

  if (booting) {
    return (
      <div className="app">
        <header
          className="topbar"
          data-tauri-drag-region
          onDoubleClick={() => void appWindow.toggleMaximize()}
        >
          <div className="brand" data-tauri-drag-region>
            <BrandLogo onClick={toggleSettings} />
          </div>
          <div className="topbar-right">
            <div className="actions">
              <ThemeButton />
              <LangButton />
            </div>
            <WinControls />
          </div>
        </header>
        <div className="empty">
          <p className="muted">{t("booting")}</p>
        </div>
      </div>
    );
  }

  const moduleNav = (
    <nav className="module-nav" aria-label="modules">
      <button
        type="button"
        className={appModule === "gallery" ? "icon-btn on" : "icon-btn"}
        title={t("photos") === "photos" ? "Library" : "图库"}
        onClick={() => switchModule("gallery")}
      >
        <ImageIcon size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        className={appModule === "passbox" ? "icon-btn on" : "icon-btn"}
        title={t("passbox")}
        onClick={() => switchModule("passbox")}
      >
        <Lock size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        className={appModule === "notepad" ? "icon-btn on" : "icon-btn"}
        title={t("notepad")}
        onClick={() => switchModule("notepad")}
      >
        <FileText size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        className={appModule === "sfx" ? "icon-btn on" : "icon-btn"}
        title={t("sfxboard")}
        onClick={() => switchModule("sfx")}
      >
        <AudioLines size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
    </nav>
  );

  /** 点开大图后的沉浸顶栏：返回 + 文件名 */
  const galleryViewerChrome = viewing != null && appModule === "gallery" && lightboxOpen;

  /** 右侧：当前模块工具 + 语言（窗控始终在最右） */
  const topbarActions = (
    <div className="actions">
      {appModule === "gallery" &&
        (viewing ? (
          <>
            {!isVideoEntry(viewing) && (
              <>
                <button type="button" className="icon-btn" title={t("zoomOut")} onClick={zoomOut}>
                  <Minus size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button type="button" className="icon-btn zoom-pct" title={t("zoomReset")} onClick={zoomReset}>
                  {Math.round(zoom * 100)}%
                </button>
                <button type="button" className="icon-btn" title={t("zoomIn")} onClick={zoomIn}>
                  <Plus size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
              </>
            )}
            <button
              type="button"
              className="icon-btn"
              title={t("copy")}
              onClick={() => copyImage(viewing)}
            >
              <Copy size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
            <button
              type="button"
              className="icon-btn danger"
              title={t("delete")}
              onClick={() => deleteImage(viewing, currentIndex!)}
            >
              <Trash2 size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
          </>
        ) : (
          <>
            {vault && (
              <label
                className={deepScan ? "scan-switch on" : "scan-switch"}
                title={deepScan ? t("deepScanOn") : t("deepScanOff")}
              >
                <FolderSearch size={15} strokeWidth={1.75} absoluteStrokeWidth />
                <span className="scan-switch-label">{t("deepScan")}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={deepScan}
                  className="scan-switch-track"
                  disabled={loading}
                  onClick={() => setDeepScanAndReload(!deepScan)}
                >
                  <span className="scan-switch-knob" />
                </button>
              </label>
            )}
            <button
              type="button"
              className="icon-btn"
              title={vault ? t("changeFolder") : t("pickFolder")}
              onClick={pickVault}
            >
              <FolderOpen size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
            {vault && (
              <button
                type="button"
                className="icon-btn"
                title={t("refresh")}
                onClick={() => loadImages(vault, deepScanRef.current)}
                disabled={loading}
              >
                <RefreshCw size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
              </button>
            )}
            {vault && (
              <>
                <button
                  type="button"
                  className={viewMode === "grid" ? "icon-btn on" : "icon-btn"}
                  title={t("grid")}
                  onClick={() => setMode("grid")}
                >
                  <LayoutGrid size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className={viewMode === "waterfall" ? "icon-btn on" : "icon-btn"}
                  title={t("waterfall")}
                  onClick={() => setMode("waterfall")}
                >
                  <Columns3 size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
              </>
            )}
          </>
        ))}
      {(appModule === "passbox" || appModule === "notepad" || appModule === "sfx") &&
        moduleChrome?.tools}
      <ThemeButton />
      <LangButton />
    </div>
  );

  return (
    <div className="app">
      {/*
        唯一顶栏产品逻辑：
        左 FLYBOX + 三模块 + 当前场景信息
        右 当前模块工具 + 语言 + 窗控
        大图预览时临时沉浸：返回 + 文件名
      */}
      <header
        className="topbar"
        data-tauri-drag-region
        onDoubleClick={() => void appWindow.toggleMaximize()}
      >
        <div className="brand" data-tauri-drag-region>
          {galleryViewerChrome && viewing ? (
            <>
              <button
                type="button"
                className="icon-btn brand-back"
                title={t("backGallery")}
                onClick={closeLightbox}
              >
                <ArrowLeft size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
              </button>
              <span className="viewer-title" title={viewing.path} data-tauri-drag-region>
                <span className="viewer-title-name">{viewing.name}</span>
                <span className="viewer-title-meta muted">
                  {" "}
                  · {(currentIndex ?? 0) + 1}/{images.length}
                </span>
              </span>
            </>
          ) : (
            <>
              <BrandLogo onClick={toggleSettings} />
              <span className="brand-sep" aria-hidden />
              {moduleNav}
              {appModule === "gallery" &&
                (vault ? (
                  <div className="brand-context" data-tauri-drag-region>
                    <span className="brand-sep" aria-hidden />
                    <span className="vault-path" title={vault} data-tauri-drag-region>
                      {folderName}
                    </span>
                    {!loading && images.length > 0 && (
                      <span className="count-label" data-tauri-drag-region>
                        {images.length} {t("photos")}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="brand-context" data-tauri-drag-region>
                    <span className="brand-sep" aria-hidden />
                    <span className="vault-path muted" data-tauri-drag-region>
                      {t("noVault")}
                    </span>
                  </div>
                ))}
              {(appModule === "passbox" || appModule === "notepad" || appModule === "sfx") &&
                (moduleChrome?.context || moduleChrome?.title || moduleChrome?.meta) && (
                  <div
                    className={
                      moduleChrome?.context
                        ? "brand-context brand-context-nav"
                        : "brand-context"
                    }
                    data-tauri-drag-region
                  >
                    <span className="brand-sep" aria-hidden />
                    {moduleChrome?.context ? (
                      moduleChrome.context
                    ) : (
                      <>
                        {moduleChrome?.title ? (
                          <span className="module-context" data-tauri-drag-region>
                            {moduleChrome.title}
                          </span>
                        ) : null}
                        {moduleChrome?.meta ? (
                          <span className="count-label" data-tauri-drag-region>
                            {moduleChrome.meta}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                )}
            </>
          )}
        </div>

        <div className="topbar-right">
          {topbarActions}
          <WinControls />
        </div>
      </header>

      {appModule === "passbox" && (
        <div className="module-body">
          <Passbox
            embedded
            onBackToGallery={() => switchModule("gallery")}
            onChromeChange={setModuleChrome}
          />
        </div>
      )}

      {appModule === "notepad" && (
        <div className="module-body">
          <Notepad embedded onChromeChange={setModuleChrome} />
        </div>
      )}

      {appModule === "sfx" && (
        <div className="module-body">
          <Soundboard embedded onChromeChange={setModuleChrome} />
        </div>
      )}

      {appModule === "gallery" && error && <div className="banner error">{error}</div>}

      {appModule === "gallery" && !vault && (
        <div
          className="empty"
          onContextMenu={(e) => {
            openCtxMenu(
              e,
              [
                {
                  id: "pick",
                  label: t("pickFolder"),
                  onClick: () => void pickVault(),
                },
                { id: "sep", separator: true },
                {
                  id: "passbox",
                  label: t("passbox"),
                  onClick: () => switchModule("passbox"),
                },
                {
                  id: "notepad",
                  label: t("notepad"),
                  onClick: () => switchModule("notepad"),
                },
                {
                  id: "sfx",
                  label: t("sfxboard"),
                  onClick: () => switchModule("sfx"),
                },
              ],
              setCtxMenu,
            );
          }}
        >
          <h1>{t("emptyTitle")}</h1>
          <p>{t("emptyDesc")}</p>
          <button type="button" className="icon-btn on empty-pick" title={t("pickFolder")} onClick={pickVault}>
            <FolderOpen size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
            <span className="icon-btn-label">{t("pickFolder")}</span>
          </button>
        </div>
      )}

      {/* Keep gallery mounted under lightbox so scroll position is not lost. */}
      {appModule === "gallery" && vault && (
        <main
          className={lightboxOpen ? "content content-hold" : "content"}
          ref={bindContent}
          aria-hidden={lightboxOpen}
          onContextMenu={onGalleryBgContext}
        >
          {loading && <p className="status">{t("scanning")}</p>}
          {!loading && images.length === 0 && (
            <div className="empty compact">
              <p>{t("noImages")}</p>
              <p className="muted">{t("noImagesHint")}</p>
            </div>
          )}
          {!loading && images.length > 0 && (
            viewMode === "waterfall" ? (
              <WaterfallGallery
                images={images}
                onOpen={openAt}
                onContextMenu={onTileContext}
                onMediaSize={onMediaSize}
                scrollRoot={scrollRoot}
              />
            ) : (
              <div className="grid">
                {images.map((img, i) => (
                  <Tile
                    key={img.path}
                    img={img}
                    index={i}
                    layout="grid"
                    onOpen={openAt}
                    onContextMenu={onTileContext}
                    scrollRoot={scrollRoot}
                  />
                ))}
              </div>
            )
          )}
        </main>
      )}

      {appModule === "gallery" &&
        vault &&
        lightboxOpen &&
        currentIndex != null &&
        images[currentIndex] && (
        <div className="viewer overlay">
          <div
            className={zoom > 1 ? "stage stage-zoomed" : "stage"}
            onContextMenu={(e) => {
              const entry = images[currentIndex];
              if (!entry) return;
              openCtxMenu(
                e,
                imageMenuItems(entry, currentIndex, { lightbox: true }),
                setCtxMenu,
              );
            }}
            onWheel={(e) => {
              if (isVideoEntry(images[currentIndex])) return;
              e.preventDefault();
              if (e.deltaY < 0) zoomIn();
              else zoomOut();
            }}
          >
            <button
              type="button"
              className="nav prev"
              onClick={(e) => {
                e.stopPropagation();
                goPrev();
              }}
              aria-label="上一张"
            >
              ‹
            </button>
            <div
              className={
                isVideoEntry(images[currentIndex])
                  ? "stage-inner stage-inner-video"
                  : "stage-inner"
              }
              onPointerDown={(e) => {
                if (isVideoEntry(images[currentIndex])) return;
                if (zoom <= 1) return;
                // 仅在点到图片本体时拖动
                const img = (e.currentTarget as HTMLElement).querySelector("img");
                if (img) {
                  const r = img.getBoundingClientRect();
                  if (
                    e.clientX < r.left ||
                    e.clientX > r.right ||
                    e.clientY < r.top ||
                    e.clientY > r.bottom
                  ) {
                    return;
                  }
                }
                e.preventDefault();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                dragRef.current = {
                  id: e.pointerId,
                  sx: e.clientX,
                  sy: e.clientY,
                  ox: pan.x,
                  oy: pan.y,
                  moved: false,
                };
              }}
              onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d || d.id !== e.pointerId) return;
                const dx = e.clientX - d.sx;
                const dy = e.clientY - d.sy;
                if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
                setPan({ x: d.ox + dx, y: d.oy + dy });
              }}
              onPointerUp={(e) => {
                const d = dragRef.current;
                if (d && d.id === e.pointerId) {
                  try {
                    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
                  } catch {
                    /* ignore */
                  }
                  const wasDrag = d.moved;
                  dragRef.current = null;
                  // 拖过就不当点击
                  if (wasDrag) return;
                }
              }}
              onPointerCancel={() => {
                dragRef.current = null;
              }}
              onClick={(e) => {
                // 视频：点控件不关；点空白关
                if (dragRef.current?.moved) return;
                if ((e.target as HTMLElement).closest(".nav")) return;
                if ((e.target as HTMLElement).closest("video, .viewer-video-wrap")) return;
                const img = (e.currentTarget as HTMLElement).querySelector("img");
                if (img) {
                  const box = e.currentTarget.getBoundingClientRect();
                  const w = img.offsetWidth;
                  const h = img.offsetHeight;
                  const cx = box.left + box.width / 2 + pan.x;
                  const cy = box.top + box.height / 2 + pan.y;
                  const dx = (e.clientX - cx) / (zoom || 1);
                  const dy = (e.clientY - cy) / (zoom || 1);
                  if (Math.abs(dx) <= w / 2 && Math.abs(dy) <= h / 2) {
                    return;
                  }
                }
                closeLightbox();
              }}
            >
              {isVideoEntry(images[currentIndex]) ? (
                <div className="viewer-video-wrap">
                  <video
                    key={images[currentIndex].path}
                    className="viewer-video"
                    src={localFileUrl(images[currentIndex].path)}
                    controls
                    autoPlay
                    muted
                    playsInline
                    preload="auto"
                    onLoadedData={(e) => {
                      // 系统常拦带声自动播；静音先播起来，用户可再开声音
                      const v = e.currentTarget;
                      void v.play().catch(() => undefined);
                    }}
                    onError={() => {}}
                  />
                </div>
              ) : (
                <img
                  src={localFileUrl(images[currentIndex].path)}
                  alt={images[currentIndex].name}
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  }}
                  draggable={false}
                  onError={(e) => {
                    const thumb = thumbUrlCache.get(images[currentIndex].path);
                    if (thumb && e.currentTarget.src !== thumb) {
                      e.currentTarget.src = thumb;
                    }
                  }}
                />
              )}
            </div>
            <button
              type="button"
              className="nav next"
              onClick={(e) => {
                e.stopPropagation();
                goNext();
              }}
              aria-label="下一张"
            >
              ›
            </button>
          </div>
        </div>
      )}

      <SettingsPopover
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={appSettings}
        onChange={(next) => void persistAppSettings(next)}
        autostart={autostartOn}
        onAutostartChange={onAutostartChange}
        autostartBusy={autostartBusy}
      />
      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
}
