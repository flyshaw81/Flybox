import {
  memo,
  useCallback,
  useEffect,
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
  X,
} from "lucide-react";
import Passbox from "./Passbox";
import Notepad from "./Notepad";
import ContextMenu, { openCtxMenu, type CtxItem, type CtxMenuState } from "./ContextMenu";
import { LangButton, useI18n } from "./i18n";
import { ThemeButton } from "./theme";

/** 子模块上报到唯一顶栏的场景信息 + 右侧工具 */
export type ModuleChrome = {
  title?: string;
  meta?: string;
  tools?: ReactNode;
};

const appWindow = getCurrentWindow();
const ICO = 16;
const ICO_WIN = 14;

type ImageEntry = {
  path: string;
  name: string;
  width: number;
  height: number;
};

/** 网格 · 瀑布 · 单张 */
type ViewMode = "grid" | "waterfall" | "single";

const STORE_FILE = "settings.json";
const VAULT_KEY = "vaultPath";
/** Slightly higher than before — still capped to avoid CPU thrash (masonic-style lazy). */
const THUMB_CONCURRENCY = 4;

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

type QueueJob = {
  path: string;
  resolve: (url: string) => void;
  reject: (err: unknown) => void;
};

const queue: QueueJob[] = [];
let activeWorkers = 0;

function pumpQueue() {
  while (activeWorkers < THUMB_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    activeWorkers += 1;
    void (async () => {
      try {
        const cached = thumbUrlCache.get(job.path);
        if (cached) {
          job.resolve(cached);
          return;
        }
        const dataUrl = await invoke<string>("get_thumbnail", { path: job.path });
        if (!dataUrl.startsWith("data:image/")) throw new Error("invalid thumb");
        thumbUrlCache.set(job.path, dataUrl);
        job.resolve(dataUrl);
      } catch (e) {
        job.reject(e);
      } finally {
        activeWorkers -= 1;
        pumpQueue();
      }
    })();
  }
}

function resolveThumbUrl(imagePath: string): Promise<string> {
  const hit = thumbUrlCache.get(imagePath);
  if (hit) return Promise.resolve(hit);
  return new Promise<string>((resolve, reject) => {
    queue.push({ path: imagePath, resolve, reject });
    pumpQueue();
  });
}

const Tile = memo(function Tile({
  img,
  index,
  layout,
  onOpen,
  onContextMenu,
  scrollRoot,
}: {
  img: ImageEntry;
  index: number;
  layout: "grid" | "waterfall";
  onOpen: (index: number) => void;
  onContextMenu?: (e: React.MouseEvent, index: number) => void;
  scrollRoot: HTMLElement | null;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [src, setSrc] = useState<string | null>(() => thumbUrlCache.get(img.path) ?? null);
  const [ready, setReady] = useState(() => thumbUrlCache.has(img.path));
  const [failed, setFailed] = useState(false);

  // Reserve slot height up front (GitHub masonry pattern) so scroll doesn't thrash.
  const ar =
    img.width > 0 && img.height > 0 ? img.width / img.height : layout === "grid" ? 1 : 0.75;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let started = false;

    const run = () => {
      if (started || cancelled) return;
      started = true;
      void resolveThumbUrl(img.path)
        .then((url) => {
          if (!cancelled) {
            setSrc(url);
            setFailed(false);
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
  }, [img.path, scrollRoot]);

  return (
    <button
      ref={ref}
      type="button"
      className={layout === "waterfall" ? "tile tile-wf" : "tile tile-grid"}
      style={
        layout === "waterfall"
          ? ({ ["--ar" as string]: String(ar) } as React.CSSProperties)
          : undefined
      }
      onClick={() => onOpen(index)}
      onContextMenu={(e) => onContextMenu?.(e, index)}
      title={img.name}
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
          className={ready ? "on" : ""}
          onLoad={() => setReady(true)}
          onError={() => {
            setFailed(true);
            setSrc(null);
            setReady(false);
          }}
        />
      )}
    </button>
  );
});

/**
 * JS multi-column waterfall (shortest-column packing).
 * Inspired by masonic / Pinterest: known aspect ratios + no CSS-column reflow jank.
 */
function WaterfallGallery({
  images,
  onOpen,
  onContextMenu,
  scrollRoot,
}: {
  images: ImageEntry[];
  onOpen: (index: number) => void;
  onContextMenu?: (e: React.MouseEvent, index: number) => void;
  scrollRoot: HTMLElement | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const gap = 12;
  const targetCol = 220;
  const colCount = Math.max(1, Math.floor((width + gap) / (targetCol + gap)) || 1);
  const colWidth = width > 0 ? (width - gap * (colCount - 1)) / colCount : targetCol;

  // Pack items into shortest column using estimated heights from aspect ratio.
  const columns: { img: ImageEntry; index: number }[][] = Array.from(
    { length: colCount },
    () => [],
  );
  const colHeights = Array.from({ length: colCount }, () => 0);

  if (width > 0) {
    images.forEach((img, index) => {
      let minI = 0;
      for (let i = 1; i < colCount; i++) {
        if (colHeights[i] < colHeights[minI]) minI = i;
      }
      const ar = img.width > 0 && img.height > 0 ? img.height / img.width : 1.25;
      const estH = colWidth * ar;
      columns[minI].push({ img, index });
      colHeights[minI] += estH + gap;
    });
  }

  return (
    <div ref={wrapRef} className="waterfall-js">
      {width > 0 &&
        columns.map((col, ci) => (
          <div key={ci} className="waterfall-col" style={{ width: colWidth }}>
            {col.map(({ img, index }) => (
              <Tile
                key={img.path}
                img={img}
                index={index}
                layout="waterfall"
                onOpen={onOpen}
                onContextMenu={onContextMenu}
                scrollRoot={scrollRoot}
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
        onClick={() => void appWindow.close()}
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
  const [toast, setToast] = useState<string | null>(null);
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
  /** 三大模块：图库 / 密码箱 / 记事本 */
  type AppModule = "gallery" | "passbox" | "notepad";
  const [appModule, setAppModule] = useState<AppModule>("gallery");
  const [moduleChrome, setModuleChrome] = useState<ModuleChrome | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);

  const switchModule = useCallback((m: AppModule) => {
    setActiveIndex(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setModuleChrome(null);
    setAppModule(m);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  }, []);

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
    } catch (e) {
      if (gen !== loadGen.current) return;
      setImages([]);
      setError(String(e));
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, []);

  const setDeepScanAndReload = useCallback(
    (on: boolean) => {
      deepScanRef.current = on;
      setDeepScan(on);
      if (vault) void loadImages(vault, on);
    },
    [vault, loadImages],
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
      showToast(`${t("openFolderFail")}：${e}`);
    }
  }, [openVault, showToast, t]);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    (async () => {
      try {
        const store = await getStore();
        const saved = await store.get<string>(VAULT_KEY);
        if (saved) await openVault(saved);
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

  const openAt = (index: number) => {
    setActiveIndex(index);
    resetView();
  };

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
    try {
      const url = localFileUrl(entry.path);
      if (!url) throw new Error("no origin");
      const res = await fetch(url);
      if (!res.ok) throw new Error("读取图片失败");
      const blob = await res.blob();
      const type = blob.type || "image/png";
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        showToast(t("copiedClipboard"));
        return;
      }
      await writeText(entry.path);
      showToast(t("copiedPath"));
    } catch {
      try {
        await writeText(entry.path);
        showToast(t("copiedPath"));
      } catch (e) {
        showToast(`${t("copyFail")}：${e}`);
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
          if (next.length === 0) closeLightbox();
          else {
            setActiveIndex(Math.min(index, next.length - 1));
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }
          return next;
        });
        showToast(t("deleted"));
      } catch (e) {
        showToast(`${t("deleteFail")}：${e}`);
      }
    },
    [closeLightbox, showToast, t],
  );

  const setMode = (mode: ViewMode) => {
    setViewMode(mode);
    resetView();
    if (mode === "single") {
      setActiveIndex((i) => i ?? 0);
    } else {
      setActiveIndex(null);
    }
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
          void writeText(entry.path).then(
            () => showToast(t("copiedPath")),
            (e) => showToast(`${t("copyFail")}：${e}`),
          );
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
    [deleteImage, showToast, closeLightbox, t],
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
      openCtxMenu(e, items, setCtxMenu);
    },
    [vault, loading, pickVault, loadImages, t, switchModule],
  );

  // 灯箱：网格/瀑布点图后；单张模式始终看图
  const lightboxOpen =
    viewMode !== "single" && activeIndex != null && images[activeIndex] != null;
  const singleOpen = viewMode === "single" && images.length > 0;
  const showViewer = lightboxOpen || singleOpen;

  const currentIndex = singleOpen
    ? activeIndex ?? 0
    : lightboxOpen
      ? activeIndex
      : null;

  useEffect(() => {
    if (viewMode === "single" && images.length > 0 && activeIndex == null) {
      setActiveIndex(0);
    }
  }, [viewMode, images.length, activeIndex]);

  useEffect(() => {
    if (!showViewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightboxOpen) {
          closeLightbox();
          return;
        }
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        zoomReset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showViewer, lightboxOpen, closeLightbox, goPrev, goNext]);

  const folderName = vault
    ? vault.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || vault
    : "";

  const viewing =
    showViewer && currentIndex != null && images[currentIndex]
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
            <span className="logo">{t("appName")}</span>
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
    </nav>
  );

  /** 图库预览大图：沉浸式顶栏（返回 + 文件名） */
  const galleryLightboxChrome = viewing && lightboxOpen && appModule === "gallery";

  /** 右侧：当前模块工具 + 语言（窗控始终在最右） */
  const topbarActions = (
    <div className="actions">
      {appModule === "gallery" &&
        (viewing ? (
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
                <button
                  type="button"
                  className={viewMode === "single" ? "icon-btn on" : "icon-btn"}
                  title={t("single")}
                  onClick={() => setMode("single")}
                >
                  <ImageIcon size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
              </>
            )}
          </>
        ))}
      {(appModule === "passbox" || appModule === "notepad") && moduleChrome?.tools}
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
          {galleryLightboxChrome ? (
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
                {viewing.name}
                <span className="muted">
                  {" "}
                  · {(currentIndex ?? 0) + 1}/{images.length}
                </span>
              </span>
            </>
          ) : (
            <>
              <span className="logo" data-tauri-drag-region>
                {t("appName")}
              </span>
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
              {(appModule === "passbox" || appModule === "notepad") &&
                (moduleChrome?.title || moduleChrome?.meta) && (
                  <div className="brand-context" data-tauri-drag-region>
                    <span className="brand-sep" aria-hidden />
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
      {appModule === "gallery" && vault && !singleOpen && (
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
        showViewer &&
        currentIndex != null &&
        images[currentIndex] && (
        <div className={viewMode === "single" ? "viewer page" : "viewer overlay"}>
          <div
            className={zoom > 1 ? "stage stage-zoomed" : "stage"}
            onContextMenu={(e) => {
              const entry = images[currentIndex];
              if (!entry) return;
              openCtxMenu(
                e,
                imageMenuItems(entry, currentIndex, { lightbox: lightboxOpen }),
                setCtxMenu,
              );
            }}
            onWheel={(e) => {
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
              className="stage-inner"
              onPointerDown={(e) => {
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
                // 灯箱：点非图片区域关闭；单张模式不关
                if (!lightboxOpen) return;
                if (dragRef.current?.moved) return;
                if ((e.target as HTMLElement).closest(".nav")) return;
                const img = (e.currentTarget as HTMLElement).querySelector("img");
                if (img) {
                  const r = img.getBoundingClientRect();
                  if (
                    e.clientX >= r.left &&
                    e.clientX <= r.right &&
                    e.clientY >= r.top &&
                    e.clientY <= r.bottom
                  ) {
                    return;
                  }
                }
                closeLightbox();
              }}
            >
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

      {toast && <div className="toast">{toast}</div>}
      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
}
