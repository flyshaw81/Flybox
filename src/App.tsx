import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { load } from "@tauri-apps/plugin-store";
import {
  Columns3,
  Copy,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
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
import ContextMenu, { openCtxMenu, type CtxItem, type CtxMenuState } from "./ContextMenu";

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
  return (
    <div className="win-controls">
      <button
        type="button"
        className="win-btn"
        title="最小化"
        onClick={() => void appWindow.minimize()}
      >
        <Minus size={ICO_WIN} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        className="win-btn"
        title="最大化"
        onClick={() => void appWindow.toggleMaximize()}
      >
        <Square size={12} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
      <button
        type="button"
        className="win-btn close"
        title="关闭"
        onClick={() => void appWindow.close()}
      >
        <X size={ICO_WIN} strokeWidth={1.75} absoluteStrokeWidth />
      </button>
    </div>
  );
}

export default function App() {
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
  const bootRef = useRef(false);
  const loadGen = useRef(0);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const bindContent = useCallback((node: HTMLElement | null) => {
    setScrollRoot(node);
  }, []);
  /** 密码箱全屏页（与图库互斥） */
  const [passboxOpen, setPassboxOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  }, []);

  const loadImages = useCallback(async (root: string) => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<ImageEntry[]>("list_images", { root });
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
      await loadImages(path);
    },
    [loadImages],
  );

  const pickVault = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择图库文件夹",
      });
      if (typeof selected === "string" && selected) {
        await openVault(selected);
      }
    } catch (e) {
      showToast(`打开文件夹失败：${e}`);
    }
  }, [openVault, showToast]);

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
        showToast("已复制到剪贴板");
        return;
      }
      await writeText(entry.path);
      showToast("已复制文件路径");
    } catch {
      try {
        await writeText(entry.path);
        showToast("已复制文件路径");
      } catch (e) {
        showToast(`复制失败：${e}`);
      }
    }
  };

  const deleteImage = async (entry: ImageEntry, index: number) => {
    const ok = window.confirm(`确定删除这张图片？\n\n${entry.name}\n\n将从磁盘彻底删除。`);
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
        }
        return next;
      });
      showToast("已删除");
    } catch (e) {
      showToast(`删除失败：${e}`);
    }
  };

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
          label: "打开",
          onClick: () => openAt(index),
        });
      }
      items.push({
        id: "copy",
        label: "复制图片",
        onClick: () => void copyImage(entry),
      });
      items.push({
        id: "copy-path",
        label: "复制路径",
        onClick: () => {
          void writeText(entry.path).then(
            () => showToast("已复制路径"),
            (e) => showToast(`复制失败：${e}`),
          );
        },
      });
      items.push({ id: "sep1", separator: true });
      items.push({
        id: "delete",
        label: "删除",
        danger: true,
        onClick: () => void deleteImage(entry, index),
      });
      if (opts?.lightbox) {
        items.push({ id: "sep2", separator: true });
        items.push({
          id: "close",
          label: "关闭预览",
          onClick: () => closeLightbox(),
        });
      }
      return items;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showToast, closeLightbox],
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
          label: vault ? "更换文件夹" : "选择图库文件夹",
          onClick: () => void pickVault(),
        },
      ];
      if (vault) {
        items.push({
          id: "refresh",
          label: "刷新",
          disabled: loading,
          onClick: () => void loadImages(vault),
        });
      }
      items.push({ id: "sep", separator: true });
      items.push({
        id: "passbox",
        label: "密码箱",
        onClick: () => {
          setActiveIndex(null);
          setPassboxOpen(true);
        },
      });
      openCtxMenu(e, items, setCtxMenu);
    },
    [vault, loading, pickVault, loadImages],
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
            <span className="logo">FLYPHOTO</span>
          </div>
          <div className="topbar-right">
            <WinControls />
          </div>
        </header>
        <div className="empty">
          <p className="muted">正在打开…</p>
        </div>
      </div>
    );
  }

  if (passboxOpen) {
    return <Passbox onBackToGallery={() => setPassboxOpen(false)} />;
  }

  return (
    <div className="app">
      {/* 唯一顶栏：左标题 · 中操作 · 右 ─ □ ✕ */}
      <header
        className="topbar"
        data-tauri-drag-region
        onDoubleClick={() => void appWindow.toggleMaximize()}
      >
        <div className="brand" data-tauri-drag-region>
          {viewing ? (
            <>
              {/* 大图预览：返回放左侧，最显眼 */}
              {lightboxOpen && (
                <button
                  type="button"
                  className="icon-btn brand-back"
                  title="返回图库"
                  onClick={closeLightbox}
                >
                  <ArrowLeft size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
              )}
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
                FLYPHOTO
              </span>
              {vault ? (
                <>
                  <span className="vault-path" title={vault} data-tauri-drag-region>
                    {folderName}
                  </span>
                  {!loading && images.length > 0 && (
                    <span className="count-label" data-tauri-drag-region>
                      {images.length} 张图片
                    </span>
                  )}
                </>
              ) : (
                <span className="muted" data-tauri-drag-region>
                  未选择图库
                </span>
              )}
            </>
          )}
        </div>

        <div className="topbar-right">
          <div className="actions">
            {viewing ? (
              <>
                <button type="button" className="icon-btn" title="缩小" onClick={zoomOut}>
                  <Minus size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button type="button" className="icon-btn zoom-pct" title="重置缩放" onClick={zoomReset}>
                  {Math.round(zoom * 100)}%
                </button>
                <button type="button" className="icon-btn" title="放大" onClick={zoomIn}>
                  <Plus size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="复制"
                  onClick={() => copyImage(viewing)}
                >
                  <Copy size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="删除"
                  onClick={() => deleteImage(viewing, currentIndex!)}
                >
                  <Trash2 size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  title={vault ? "更换文件夹" : "选择文件夹"}
                  onClick={pickVault}
                >
                  <FolderOpen size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="密码箱"
                  onClick={() => {
                    setActiveIndex(null);
                    setPassboxOpen(true);
                  }}
                >
                  <Lock size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                {vault && (
                  <button
                    type="button"
                    className="icon-btn"
                    title="刷新"
                    onClick={() => loadImages(vault)}
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
                      title="网格"
                      onClick={() => setMode("grid")}
                    >
                      <LayoutGrid size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                    <button
                      type="button"
                      className={viewMode === "waterfall" ? "icon-btn on" : "icon-btn"}
                      title="瀑布"
                      onClick={() => setMode("waterfall")}
                    >
                      <Columns3 size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                    <button
                      type="button"
                      className={viewMode === "single" ? "icon-btn on" : "icon-btn"}
                      title="单张"
                      onClick={() => setMode("single")}
                    >
                      <ImageIcon size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          <WinControls />
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      {!vault && (
        <div
          className="empty"
          onContextMenu={(e) => {
            openCtxMenu(
              e,
              [
                {
                  id: "pick",
                  label: "选择图库文件夹",
                  onClick: () => void pickVault(),
                },
                { id: "sep", separator: true },
                {
                  id: "passbox",
                  label: "密码箱",
                  onClick: () => setPassboxOpen(true),
                },
              ],
              setCtxMenu,
            );
          }}
        >
          <h1>像打开一个文件夹一样</h1>
          <p>指定一个目录作为图库，打开即可浏览里面的图片。</p>
          <button type="button" className="icon-btn on empty-pick" title="选择图库文件夹" onClick={pickVault}>
            <FolderOpen size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
            <span className="icon-btn-label">选择图库文件夹</span>
          </button>
        </div>
      )}

      {/* Keep gallery mounted under lightbox so scroll position is not lost. */}
      {vault && !singleOpen && (
        <main
          className={lightboxOpen ? "content content-hold" : "content"}
          ref={bindContent}
          aria-hidden={lightboxOpen}
          onContextMenu={onGalleryBgContext}
        >
          {loading && <p className="status">扫描中…</p>}
          {!loading && images.length === 0 && (
            <div className="empty compact">
              <p>这个文件夹里还没有图片</p>
              <p className="muted">把图片放进该文件夹后点「刷新」</p>
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

      {vault && showViewer && currentIndex != null && images[currentIndex] && (
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
