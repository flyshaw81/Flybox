/**
 * 记事本 — 正文用 TipTap（ProseMirror），选区/加粗/颜色/字号走成熟方案，
 * 不再自研 contenteditable + execCommand 补丁。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle, Color, FontSize } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { load } from "@tauri-apps/plugin-store";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Bold,
  CalendarDays,
  ClipboardPaste,
  Copy,
  FileText,
  Highlighter,
  ImagePlus,
  Italic,
  PanelLeft,
  PanelLeftClose,
  PanelTop,
  Plus,
  Redo2,
  Scissors,
  Search,
  Smile,
  Trash2,
  Type,
  Underline as UnderlineIcon,
  Undo2,
  X,
} from "lucide-react";
import ContextMenu, { openCtxMenu, type CtxItem, type CtxMenuState } from "./ContextMenu";
import { useI18n } from "./i18n";

type ModuleChrome = {
  title?: string;
  meta?: string;
  tools?: ReactNode;
};

const ICO = 16;
const NOTES_STORE = "notepad.json";
const NOTES_KEY = "notes";

const EMOJIS = [
  "😀", "😁", "😂", "🤣", "😊", "😍", "🥰", "😘", "😜", "🤔",
  "😎", "🤩", "😭", "😡", "🤯", "😱", "😴", "🤗", "🫡", "🤝",
  "👍", "👎", "👏", "🙏", "💪", "🔥", "✨", "⭐", "💯", "🎉",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔", "💕", "💖",
  "🌹", "🌸", "🌈", "☀️", "🌙", "⚡", "🍀", "🍕", "☕", "🍺",
  "✅", "❌", "⚠️", "📌", "📝", "💡", "🚀", "🎯", "🎵", "📷",
];

export type Note = {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
  /** Notion 风格封面，JPEG data URL，约 1500×600（2.5:1） */
  cover?: string;
};

/** Notion 常用封面比例 1500×600（2.5:1） */
const COVER_W = 1500;
const COVER_H = 600;
const COVER_RATIO = COVER_W / COVER_H;

type CoverCropState = {
  src: string;
  nw: number;
  nh: number;
  /** 裁切窗口左上角在原图像素坐标（所见即所得） */
  sx: number;
  sy: number;
};

/** 原图上 2.5:1 裁切窗口尺寸 + 可拖动范围 */
function coverWindow(nw: number, nh: number) {
  let sw: number;
  let sh: number;
  if (nw / nh > COVER_RATIO) {
    // 图更宽：高度吃满，左右裁
    sh = nh;
    sw = nh * COVER_RATIO;
  } else {
    // 图更高/方：宽度吃满，上下裁
    sw = nw;
    sh = nw / COVER_RATIO;
  }
  return {
    sw,
    sh,
    maxSx: Math.max(0, nw - sw),
    maxSy: Math.max(0, nh - sh),
  };
}

function clampCoverOrigin(nw: number, nh: number, sx: number, sy: number) {
  const { maxSx, maxSy } = coverWindow(nw, nh);
  return {
    sx: Math.min(maxSx, Math.max(0, sx)),
    sy: Math.min(maxSy, Math.max(0, sy)),
  };
}

const TEXT_COLORS = [
  { id: "default", color: "", label: "默" },
  { id: "white", color: "#f2f2f2", label: "白" },
  { id: "red", color: "#e07070", label: "红" },
  { id: "orange", color: "#e0a050", label: "橙" },
  { id: "yellow", color: "#e0d060", label: "黄" },
  { id: "green", color: "#70c090", label: "绿" },
  { id: "blue", color: "#6a9ee0", label: "蓝" },
  { id: "purple", color: "#b080e0", label: "紫" },
];

const HIGHLIGHT_COLORS = [
  { id: "none", color: "", label: "无" },
  { id: "yellow", color: "#f5d547", label: "黄" },
  { id: "green", color: "#5ecf8a", label: "绿" },
  { id: "blue", color: "#5aa8f0", label: "蓝" },
  { id: "pink", color: "#f080a0", label: "粉" },
  { id: "orange", color: "#f0a050", label: "橙" },
  { id: "purple", color: "#c090f0", label: "紫" },
];

const FONT_SIZES = [
  { id: "S", px: 13 },
  { id: "M", px: 15 },
  { id: "L", px: 18 },
  { id: "XL", px: 24 },
] as const;

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyNote(): Note {
  return { id: newId(), title: "", body: "", updatedAt: Date.now() };
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function previewText(body: string, emptyLabel: string, imageLabel = "图片"): string {
  const hasImg = /<img\b/i.test(body);
  const t = stripHtml(body);
  if (!t && hasImg) return imageLabel;
  if (!t) return emptyLabel;
  const base = t.length > 48 ? t.slice(0, 48) + "…" : t;
  return hasImg ? `${imageLabel} · ${base}` : base;
}

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "jpg" || ext === "jpeg" || ext === "jfif") return "image/jpeg";
  return "image/png";
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mime || "image/png" });
  return readBlobAsDataUrl(blob);
}

/** 按原图像素窗口裁切为 1500×600 JPEG（与预览框所见一致） */
function cropCoverFromOrigin(
  src: string,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = COVER_W;
        canvas.height = COVER_H;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("no canvas"));
          return;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, COVER_W, COVER_H);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("load fail"));
    img.src = src;
  });
}

function loadImageSize(src: string): Promise<{ nw: number; nh: number }> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      if (img.naturalWidth < 1 || img.naturalHeight < 1) {
        reject(new Error("bad image"));
        return;
      }
      resolve({ nw: img.naturalWidth, nh: img.naturalHeight });
    };
    img.onerror = () => reject(new Error("load fail"));
    img.src = src;
  });
}

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  } catch {
    return "";
  }
}

async function getNotesStore() {
  return load(NOTES_STORE, { autoSave: true });
}

/** 防止工具栏抢走选区（TipTap 文档：toolbar 必须 mousedown preventDefault） */
function keepSel(e: React.MouseEvent) {
  e.preventDefault();
}

/**
 * 颜色/高亮/字号：必须有非空选区才执行。
 * 空选区时 TipTap 会把 mark 存成「下一段输入样式」，容易让人以为「别的字也变了」。
 * 官方命令本身只改选区；这里再挡一层，杜绝误触。
 */
function runOnSelection(editor: Editor | null, fn: (ed: Editor) => void) {
  if (!editor) return;
  const { empty } = editor.state.selection;
  if (empty) return;
  fn(editor);
}

/** 支持 #RGB / #RRGGBB / 不带 # */
function normalizeHex(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1];
    const g = s[2];
    const b = s[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  return null;
}

type Hsv = { h: number; s: number; v: number };

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

function hexToHsv(hex: string): Hsv {
  const n = normalizeHex(hex) || "#e07070";
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s = max === 0 ? 0 : d / max;
  return { h: h * 360, s, v: max };
}

function hsvToHex(h: number, s: number, v: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh < 60) [rp, gp, bp] = [c, x, 0];
  else if (hh < 120) [rp, gp, bp] = [x, c, 0];
  else if (hh < 180) [rp, gp, bp] = [0, c, x];
  else if (hh < 240) [rp, gp, bp] = [0, x, c];
  else if (hh < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(rp)}${to(gp)}${to(bp)}`;
}

function pureHueHex(h: number): string {
  return hsvToHex(h, 1, 1);
}

export default function Notepad({
  embedded = false,
  onChromeChange,
}: {
  embedded?: boolean;
  onChromeChange?: (chrome: ModuleChrome | null) => void;
}) {
  const { t } = useI18n();
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [booting, setBooting] = useState(true);
  const [saveHint, setSaveHint] = useState("");
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);
  const [fontSize, setFontSize] = useState(15);
  const [stats, setStats] = useState({ chars: 0, lines: 1 });
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** 紧凑取色面板：色板+色相条+色值（portal 到 body） */
  const [hexPick, setHexPick] = useState<null | "text" | "hl">(null);
  const [hexDraft, setHexDraft] = useState("#e07070");
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv("#e07070"));
  const [hexPopPos, setHexPopPos] = useState({ left: 0, top: 0 });
  /** 封面裁切：用户拖动画中区域 */
  const [coverCrop, setCoverCrop] = useState<CoverCropState | null>(null);
  const coverFrameRef = useRef<HTMLDivElement | null>(null);
  const coverDrag = useRef<{
    id: number;
    x0: number;
    y0: number;
    sx0: number;
    sy0: number;
  } | null>(null);
  const [sideOpen, setSideOpen] = useState(true);
  const saveTimer = useRef<number | null>(null);
  const dirtyListRef = useRef<Note[] | null>(null);
  const notesRef = useRef<Note[]>([]);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const emojiBtnRef = useRef<HTMLButtonElement | null>(null);
  const emojiPanelRef = useRef<HTMLDivElement | null>(null);
  const [emojiPos, setEmojiPos] = useState({ left: 0, top: 0 });
  const hexPickRef = useRef<HTMLDivElement | null>(null);
  const hexTextBtnRef = useRef<HTMLButtonElement | null>(null);
  const hexHlBtnRef = useRef<HTMLButtonElement | null>(null);
  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const editorRef = useRef<Editor | null>(null);
  /** 切换笔记时灌内容，避免 onUpdate 回写旧笔记 */
  const suppressUpdate = useRef(false);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const persist = useCallback(
    async (list: Note[]) => {
      try {
        const store = await getNotesStore();
        await store.set(NOTES_KEY, list);
        setSaveHint(t("saved"));
        window.setTimeout(() => setSaveHint(""), 1200);
      } catch {
        setSaveHint(t("saveFail"));
      }
    },
    [t],
  );

  const schedulePersist = useCallback(
    (list: Note[]) => {
      dirtyListRef.current = list;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        dirtyListRef.current = null;
        saveTimer.current = null;
        void persist(list);
      }, 400);
    },
    [persist],
  );

  const updateActive = useCallback(
    (patch: Partial<Pick<Note, "title" | "body" | "cover">>) => {
      const id = activeIdRef.current;
      if (!id) return;
      const next = notesRef.current.map((n) => {
        if (n.id !== id) return n;
        const merged: Note = { ...n, ...patch, updatedAt: Date.now() };
        // cover 传空串表示去掉封面
        if ("cover" in patch && !patch.cover) {
          delete merged.cover;
        }
        return merged;
      });
      setNotes(next);
      schedulePersist(next);
    },
    [schedulePersist],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Underline,
      // 官方 TextStyle + Color + FontSize（@tiptap/extension-text-style）
      TextStyle,
      Color,
      FontSize,
      Highlight.configure({ multicolor: true }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: { class: "notepad-img" },
      }),
      Placeholder.configure({
        placeholder: t("noteBody"),
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class: "notepad-body notepad-rich notepad-tiptap",
      },
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (!file) continue;
            event.preventDefault();
            void readBlobAsDataUrl(file).then((url) => {
              editorRef.current?.chain().focus().setImage({ src: url }).run();
            });
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (suppressUpdate.current) return;
      const html = ed.getHTML();
      const plain = ed.getText();
      updateActive({ body: html });
      setStats({
        chars: plain.replace(/\s+/g, " ").trim().length,
        lines: plain.length === 0 ? 1 : plain.split(/\n/).length,
      });
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // 切换笔记 → 灌入 HTML
  useEffect(() => {
    if (!editor || !activeId) return;
    const note = notesRef.current.find((n) => n.id === activeId);
    if (!note) return;
    const html =
      !note.body
        ? ""
        : note.body.includes("<")
          ? note.body
          : note.body
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\n/g, "<br>");
    suppressUpdate.current = true;
    editor.commands.setContent(html || "<p></p>", { emitUpdate: false });
    suppressUpdate.current = false;
    const plain = editor.getText();
    setStats({
      chars: plain.replace(/\s+/g, " ").trim().length,
      lines: plain.length === 0 ? 1 : plain.split(/\n/).length,
    });
  }, [activeId, editor]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await getNotesStore();
        const saved = (await store.get<Note[]>(NOTES_KEY)) ?? [];
        if (cancelled) return;
        const list = Array.isArray(saved) ? saved : [];
        setNotes(list);
        if (list.length > 0) setActiveId(list[0].id);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const pending = dirtyListRef.current;
      if (!pending) return;
      dirtyListRef.current = null;
      void getNotesStore()
        .then((store) => store.set(NOTES_KEY, pending))
        .catch(() => undefined);
    };
  }, []);

  useLayoutEffect(() => {
    if (!emojiOpen) return;
    const btn = emojiBtnRef.current;
    if (!btn) return;
    const place = () => {
      const r = btn.getBoundingClientRect();
      const popW = 288;
      const popH = 220;
      let left = r.left + r.width / 2 - popW / 2;
      let top = r.bottom + 8;
      const pad = 8;
      if (left < pad) left = pad;
      if (left + popW > window.innerWidth - pad) {
        left = window.innerWidth - pad - popW;
      }
      if (top + popH > window.innerHeight - pad) {
        top = Math.max(pad, r.top - popH - 8);
      }
      setEmojiPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [emojiOpen]);

  useEffect(() => {
    if (!emojiOpen) return;
    const onDown = (e: MouseEvent) => {
      const panel = emojiPanelRef.current;
      const btn = emojiBtnRef.current;
      const t = e.target as Node;
      if (panel?.contains(t) || btn?.contains(t)) return;
      setEmojiOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEmojiOpen(false);
    };
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [emojiOpen]);

  const setColorFromHsv = (next: Hsv) => {
    setHsv(next);
    setHexDraft(hsvToHex(next.h, next.s, next.v));
  };

  const openHexPick = (mode: "text" | "hl", _btn: HTMLButtonElement | null) => {
    const start = mode === "hl" ? "#f5d547" : "#e07070";
    setHexDraft(start);
    setHsv(hexToHsv(start));
    setHexPick((v) => (v === mode ? null : mode));
  };

  const pickSv = (clientX: number, clientY: number) => {
    const el = svRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = clamp01((clientX - r.left) / r.width);
    const v = clamp01(1 - (clientY - r.top) / r.height);
    setColorFromHsv({ ...hsv, s, v });
  };

  const pickHue = (clientX: number) => {
    const el = hueRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const h = clamp01((clientX - r.left) / r.width) * 360;
    setColorFromHsv({ ...hsv, h });
  };

  useLayoutEffect(() => {
    if (!hexPick) return;
    const btn = hexPick === "hl" ? hexHlBtnRef.current : hexTextBtnRef.current;
    if (!btn) return;
    const place = () => {
      const r = btn.getBoundingClientRect();
      const popW = 196;
      const popH = 196;
      let left = r.left + r.width / 2 - popW / 2;
      let top = r.bottom + 8;
      const pad = 8;
      if (left < pad) left = pad;
      if (left + popW > window.innerWidth - pad) left = window.innerWidth - pad - popW;
      if (top + popH > window.innerHeight - pad) top = Math.max(pad, r.top - popH - 8);
      setHexPopPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [hexPick]);

  useEffect(() => {
    if (!hexPick) return;
    const onDown = (e: MouseEvent) => {
      const pop = hexPickRef.current;
      const btn = hexPick === "hl" ? hexHlBtnRef.current : hexTextBtnRef.current;
      const t = e.target as Node;
      if (pop?.contains(t) || btn?.contains(t)) return;
      setHexPick(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHexPick(null);
    };
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [hexPick]);

  const applyHexColor = () => {
    const hex = normalizeHex(hexDraft) || hsvToHex(hsv.h, hsv.s, hsv.v);
    if (!hex) return;
    runOnSelection(editor, (ed) => {
      if (hexPick === "hl") {
        ed.chain().focus().setHighlight({ color: hex }).run();
      } else {
        ed.chain().focus().setColor(hex).run();
      }
    });
    setHexPick(null);
  };

  const liveHex = normalizeHex(hexDraft) || hsvToHex(hsv.h, hsv.s, hsv.v);

  const hexPop =
    hexPick &&
    createPortal(
      <div
        ref={hexPickRef}
        className="notepad-hex-pop"
        role="dialog"
        aria-label={hexPick === "hl" ? t("pickHighlight") : t("pickTextColor")}
        style={{ left: hexPopPos.left, top: hexPopPos.top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 饱和度 / 明度 色板 */}
        <div
          ref={svRef}
          className="notepad-sv"
          style={{ backgroundColor: pureHueHex(hsv.h) }}
          onMouseDown={(e) => {
            e.preventDefault();
            pickSv(e.clientX, e.clientY);
            const move = (ev: MouseEvent) => pickSv(ev.clientX, ev.clientY);
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        >
          <div className="notepad-sv-white" />
          <div className="notepad-sv-black" />
          <span
            className="notepad-sv-knob"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
          />
        </div>
        {/* 色相条 */}
        <div
          ref={hueRef}
          className="notepad-hue"
          onMouseDown={(e) => {
            e.preventDefault();
            pickHue(e.clientX);
            const move = (ev: MouseEvent) => pickHue(ev.clientX);
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        >
          <span className="notepad-hue-knob" style={{ left: `${(hsv.h / 360) * 100}%` }} />
        </div>
        {/* 预览 + 色值 + 应用 */}
        <div className="notepad-hex-row">
          <span className="notepad-hex-swatch" style={{ background: liveHex }} />
          <input
            className="notepad-hex-input"
            value={hexDraft}
            placeholder="#RRGGBB"
            spellCheck={false}
            autoComplete="off"
            maxLength={7}
            onChange={(e) => {
              const v = e.target.value;
              setHexDraft(v);
              const n = normalizeHex(v);
              if (n) setHsv(hexToHsv(n));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyHexColor();
              }
            }}
          />
          <button
            type="button"
            className="notepad-hex-apply"
            onMouseDown={keepSel}
            onClick={applyHexColor}
          >
            {t("applyColor") || "应用"}
          </button>
        </div>
      </div>,
      document.body,
    );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!q) return list;
    return list.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        stripHtml(n.body).toLowerCase().includes(q),
    );
  }, [notes, query]);

  const active = useMemo(
    () => notes.find((n) => n.id === activeId) ?? null,
    [notes, activeId],
  );

  const createNote = () => {
    const n = emptyNote();
    n.title = t("untitledNote");
    const next = [n, ...notesRef.current];
    setNotes(next);
    setActiveId(n.id);
    schedulePersist(next);
  };

  const deleteNote = async (id: string) => {
    const ok = await ask(t("deleteNoteConfirm"), {
      title: t("delete"),
      kind: "warning",
    });
    if (!ok) return;
    const next = notesRef.current.filter((n) => n.id !== id);
    setNotes(next);
    if (activeId === id) setActiveId(next[0]?.id ?? null);
    schedulePersist(next);
  };

  const onTitleInput = () => {
    const el = titleRef.current;
    if (!el || !activeId) return;
    updateActive({ title: el.value });
  };

  const run = (fn: () => void) => {
    if (!editor) return;
    fn();
  };

  const addImageFromPicker = async () => {
    if (!editor) return;
    try {
      const selected = await openDialog({
        multiple: true,
        title: t("pickImages"),
        filters: [
          {
            name: t("pickImages"),
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "jfif"],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const path of paths) {
        if (typeof path !== "string" || !path) continue;
        const bytes = await readFile(path);
        const url = await bytesToDataUrl(bytes, mimeFromPath(path));
        editor.chain().focus().setImage({ src: url }).run();
      }
    } catch {
      window.alert(t("addImageFail"));
    }
  };

  /** 上传 / 更换封面：选图后进入裁切框，用户拖动选择区域 */
  const setCoverFromPicker = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: t("pickCover"),
        filters: [
          {
            name: t("pickCover"),
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "jfif"],
          },
        ],
      });
      if (!selected || typeof selected !== "string") return;
      const bytes = await readFile(selected);
      const raw = await bytesToDataUrl(bytes, mimeFromPath(selected));
      const { nw, nh } = await loadImageSize(raw);
      const { maxSx, maxSy } = coverWindow(nw, nh);
      // 默认居中
      setCoverCrop({
        src: raw,
        nw,
        nh,
        sx: maxSx / 2,
        sy: maxSy / 2,
      });
    } catch {
      window.alert(t("addImageFail"));
    }
  };

  const confirmCoverCrop = async () => {
    if (!coverCrop) return;
    try {
      const { sw, sh } = coverWindow(coverCrop.nw, coverCrop.nh);
      const { sx, sy } = clampCoverOrigin(
        coverCrop.nw,
        coverCrop.nh,
        coverCrop.sx,
        coverCrop.sy,
      );
      const cover = await cropCoverFromOrigin(coverCrop.src, sx, sy, sw, sh);
      updateActive({ cover });
      setCoverCrop(null);
    } catch {
      window.alert(t("addImageFail"));
    }
  };

  const removeCover = () => {
    updateActive({ cover: "" });
  };

  const insertEmoji = (emoji: string) => {
    editor?.chain().focus().insertContent(emoji).run();
    setEmojiOpen(false);
  };

  const insertDateTime = () => {
    const stamp = new Date().toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    editor?.chain().focus().insertContent(stamp).run();
  };

  const pasteText = async () => {
    if (!editor) return;
    try {
      const text = await readText();
      editor.chain().focus().insertContent(text).run();
    } catch {
      /* ignore */
    }
  };

  const noteMenu = (n: Note): CtxItem[] => [
    { id: "open", label: t("open"), onClick: () => setActiveId(n.id) },
    { id: "sep", separator: true },
    {
      id: "del",
      label: t("delete"),
      danger: true,
      onClick: () => void deleteNote(n.id),
    },
  ];

  const editorMenu = (): CtxItem[] => [
    {
      id: "bold",
      label: t("bold") || "加粗",
      onClick: () => run(() => editor!.chain().focus().toggleBold().run()),
    },
    {
      id: "italic",
      label: t("italic") || "斜体",
      onClick: () => run(() => editor!.chain().focus().toggleItalic().run()),
    },
    {
      id: "underline",
      label: t("underline") || "下划线",
      onClick: () => run(() => editor!.chain().focus().toggleUnderline().run()),
    },
    { id: "sep0", separator: true },
    {
      id: "undo",
      label: t("undo"),
      onClick: () => run(() => editor!.chain().focus().undo().run()),
    },
    {
      id: "redo",
      label: t("redo"),
      onClick: () => run(() => editor!.chain().focus().redo().run()),
    },
    { id: "sep1", separator: true },
    {
      id: "time",
      label: t("insertDateTime"),
      onClick: () => insertDateTime(),
    },
  ];

  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    if (booting) {
      onChromeChange(null);
      return;
    }
    const meta = [`${notes.length} ${t("notesCount")}`, saveHint || null]
      .filter(Boolean)
      .join(" · ");
    onChromeChange({ meta });
  }, [embedded, onChromeChange, booting, notes.length, saveHint, t]);

  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    return () => onChromeChange(null);
  }, [embedded, onChromeChange]);

  if (booting) {
    return (
      <div className="notepad-embedded">
        <div className="empty">
          <p className="muted">{t("booting")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="notepad-embedded">
      <div className={sideOpen ? "notepad" : "notepad side-collapsed"}>
        {sideOpen ? (
          <aside className="notepad-side">
            <div className="notepad-search">
              <Search size={14} strokeWidth={1.75} absoluteStrokeWidth />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchNotes")}
                autoComplete="off"
              />
              <div className="notepad-side-actions">
                <button type="button" className="icon-btn" title={t("newNote")} onClick={createNote}>
                  <Plus size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                {active ? (
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={t("deleteNote")}
                    onClick={() => void deleteNote(active.id)}
                  >
                    <Trash2 size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="notepad-list">
              {filtered.length === 0 ? (
                <div className="notepad-empty-list">
                  {notes.length === 0 ? t("emptyNotes") : t("noMatchNotes")}
                </div>
              ) : (
                filtered.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={n.id === activeId ? "notepad-item on" : "notepad-item"}
                    onClick={() => setActiveId(n.id)}
                    onContextMenu={(e) => openCtxMenu(e, noteMenu(n), setCtxMenu)}
                  >
                    <span className="notepad-item-title">
                      {n.title.trim() || t("untitledNote")}
                    </span>
                    <span className="notepad-item-meta">
                      <span>{formatTime(n.updatedAt)}</span>
                      <span className="notepad-item-preview">
                        {previewText(n.body, t("emptyNote"), t("noteImage"))}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>
        ) : null}

        <section className="notepad-main">
          <div className="notepad-toolbar">
            <button
              type="button"
              className="notepad-tool icon-only"
              title={sideOpen ? t("collapseSidebar") : t("expandSidebar")}
              onClick={() => setSideOpen((v) => !v)}
            >
              {sideOpen ? (
                <PanelLeftClose size={15} strokeWidth={1.75} absoluteStrokeWidth />
              ) : (
                <PanelLeft size={15} strokeWidth={1.75} absoluteStrokeWidth />
              )}
            </button>
            {active && editor ? (
              <>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={`${t("undo")} Ctrl+Z`}
                  onMouseDown={keepSel}
                  onClick={() => editor.chain().focus().undo().run()}
                >
                  <Undo2 size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={`${t("redo")} Ctrl+Y`}
                  onMouseDown={keepSel}
                  onClick={() => editor.chain().focus().redo().run()}
                >
                  <Redo2 size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("cut")}
                  onMouseDown={keepSel}
                  onClick={() => {
                    document.execCommand("cut");
                  }}
                >
                  <Scissors size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("copy")}
                  onMouseDown={keepSel}
                  onClick={() => {
                    document.execCommand("copy");
                  }}
                >
                  <Copy size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("paste")}
                  onMouseDown={keepSel}
                  onClick={() => void pasteText()}
                >
                  <ClipboardPaste size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className={
                    editor.isActive("bold")
                      ? "notepad-tool icon-only on"
                      : "notepad-tool icon-only"
                  }
                  title={t("bold") || "加粗"}
                  onMouseDown={keepSel}
                  onClick={() => editor.chain().focus().toggleBold().run()}
                >
                  <Bold size={15} strokeWidth={2} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className={
                    editor.isActive("italic")
                      ? "notepad-tool icon-only on"
                      : "notepad-tool icon-only"
                  }
                  title={t("italic") || "斜体"}
                  onMouseDown={keepSel}
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                >
                  <Italic size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className={
                    editor.isActive("underline")
                      ? "notepad-tool icon-only on"
                      : "notepad-tool icon-only"
                  }
                  title={t("underline") || "下划线"}
                  onMouseDown={keepSel}
                  onClick={() => editor.chain().focus().toggleUnderline().run()}
                >
                  <UnderlineIcon size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <span className="notepad-tool-sep" />
                <span className="notepad-colors" title={t("textColor") || "文字颜色"}>
                  <Type
                    size={12}
                    strokeWidth={1.75}
                    absoluteStrokeWidth
                    className="notepad-colors-icon"
                    aria-hidden
                  />
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={
                        c.id === "default"
                          ? "notepad-color-dot text-default"
                          : "notepad-color-dot"
                      }
                      style={c.id === "default" ? undefined : { background: c.color }}
                      title={`${t("textColor") || "文字"} · ${c.label}`}
                      onMouseDown={keepSel}
                      onClick={() => {
                        // 只改选中文字（官方 setColor/unsetColor 作用在当前选区）
                        runOnSelection(editor, (ed) => {
                          if (!c.color) ed.chain().focus().unsetColor().run();
                          else ed.chain().focus().setColor(c.color).run();
                        });
                      }}
                    />
                  ))}
                  <button
                    ref={hexTextBtnRef}
                    type="button"
                    className="notepad-color-pick"
                    title={t("pickTextColor") || "自己选文字颜色"}
                    onMouseDown={keepSel}
                    onClick={(e) => openHexPick("text", e.currentTarget)}
                  />
                </span>
                <span className="notepad-tool-sep" />
                <span className="notepad-colors" title={t("highlight") || "高亮"}>
                  <Highlighter
                    size={12}
                    strokeWidth={1.75}
                    absoluteStrokeWidth
                    className="notepad-colors-icon"
                    aria-hidden
                  />
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={
                        c.id === "none"
                          ? "notepad-color-dot hl none"
                          : "notepad-color-dot hl"
                      }
                      style={c.id === "none" ? undefined : { background: c.color }}
                      title={
                        c.id === "none"
                          ? t("clearHighlight") || "取消高亮"
                          : `${t("highlight") || "高亮"} · ${c.label}`
                      }
                      onMouseDown={keepSel}
                      onClick={() => {
                        // 用 setHighlight 不用 toggle，避免误伤其它已高亮段落
                        runOnSelection(editor, (ed) => {
                          if (!c.color) ed.chain().focus().unsetHighlight().run();
                          else ed.chain().focus().setHighlight({ color: c.color }).run();
                        });
                      }}
                    />
                  ))}
                  <button
                    ref={hexHlBtnRef}
                    type="button"
                    className="notepad-color-pick hl"
                    title={t("pickHighlight") || "自己选高亮颜色"}
                    onMouseDown={keepSel}
                    onClick={(e) => openHexPick("hl", e.currentTarget)}
                  />
                </span>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("insertDateTime")}
                  onMouseDown={keepSel}
                  onClick={insertDateTime}
                >
                  <CalendarDays size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("addImage")}
                  onMouseDown={keepSel}
                  onClick={() => void addImageFromPicker()}
                >
                  <ImagePlus size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className={
                    active.cover
                      ? "notepad-tool icon-only on"
                      : "notepad-tool icon-only"
                  }
                  title={active.cover ? t("changeCover") : t("addCover")}
                  onMouseDown={keepSel}
                  onClick={() => void setCoverFromPicker()}
                >
                  <PanelTop size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  ref={emojiBtnRef}
                  type="button"
                  className={
                    emojiOpen ? "notepad-tool icon-only on" : "notepad-tool icon-only"
                  }
                  title={t("insertEmoji")}
                  onMouseDown={keepSel}
                  onClick={() => setEmojiOpen((v) => !v)}
                >
                  <Smile size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <span className="notepad-tool-sep" />
                {FONT_SIZES.map((fs) => (
                  <button
                    key={fs.id}
                    type="button"
                    className={
                      fontSize === fs.px
                        ? fs.id === "XL"
                          ? "notepad-tool size-letter xl on"
                          : "notepad-tool size-letter on"
                        : fs.id === "XL"
                          ? "notepad-tool size-letter xl"
                          : "notepad-tool size-letter"
                    }
                    title={
                      fs.id === "S"
                        ? t("fontS")
                        : fs.id === "M"
                          ? t("fontM")
                          : fs.id === "L"
                            ? t("fontL")
                            : t("fontXL")
                    }
                    onMouseDown={keepSel}
                    onClick={() => {
                      setFontSize(fs.px);
                      // 官方 FontSize：只给选中文字设绝对 px
                      runOnSelection(editor, (ed) => {
                        ed.chain().focus().setFontSize(`${fs.px}px`).run();
                      });
                    }}
                  >
                    {fs.id}
                  </button>
                ))}
              </>
            ) : null}
          </div>
          {active ? (
            <>
              {active.cover ? (
                <div className="notepad-cover">
                  <img src={active.cover} alt="" draggable={false} />
                  <div className="notepad-cover-actions">
                    <button
                      type="button"
                      className="notepad-cover-btn"
                      onClick={() => void setCoverFromPicker()}
                    >
                      {t("changeCover")}
                    </button>
                    <button
                      type="button"
                      className="notepad-cover-btn"
                      title={t("removeCover")}
                      onClick={removeCover}
                    >
                      <X size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                  </div>
                </div>
              ) : null}
              <input
                key={`t-${active.id}`}
                ref={titleRef}
                className="notepad-title"
                type="text"
                defaultValue={active.title}
                onInput={onTitleInput}
                placeholder={t("noteTitle")}
                autoComplete="off"
              />
              <div
                className="notepad-editor-wrap"
                onContextMenu={(e) => {
                  if (!editor) return;
                  openCtxMenu(e, editorMenu(), setCtxMenu);
                }}
              >
                <EditorContent editor={editor} />
              </div>
              <div className="notepad-status">
                <span>
                  {stats.chars} {t("chars")} · {stats.lines} {t("lines")}
                </span>
                <span className="muted">{t("undoHint")}</span>
              </div>
            </>
          ) : (
            <div className="notepad-blank">
              <FileText size={40} strokeWidth={1.25} color="#444" absoluteStrokeWidth />
              <p>{t("pickOrNew")}</p>
              <button
                type="button"
                className="passbox-primary notepad-blank-btn"
                onClick={createNote}
              >
                {t("newNote")}
              </button>
            </div>
          )}
        </section>
      </div>
      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
      {hexPop}
      {emojiOpen
        ? createPortal(
            <div
              ref={emojiPanelRef}
              className="notepad-emoji-panel"
              role="listbox"
              aria-label={t("insertEmoji")}
              style={{ left: emojiPos.left, top: emojiPos.top }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="notepad-emoji-panel-title">{t("insertEmoji")}</div>
              <div className="notepad-emoji-grid">
                {EMOJIS.map((em) => (
                  <button
                    key={em}
                    type="button"
                    className="notepad-emoji-btn"
                    title={em}
                    onMouseDown={keepSel}
                    onClick={() => insertEmoji(em)}
                  >
                    {em}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
      {coverCrop
        ? createPortal(
            <div
              className="cover-crop-mask"
              role="dialog"
              aria-label={t("coverCropTitle")}
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setCoverCrop(null);
              }}
            >
              <div className="cover-crop-panel">
                <div className="cover-crop-title">{t("coverCropTitle")}</div>
                <p className="cover-crop-hint">{t("coverCropHint")}</p>
                <div
                  ref={coverFrameRef}
                  className="cover-crop-frame"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    coverDrag.current = {
                      id: e.pointerId,
                      x0: e.clientX,
                      y0: e.clientY,
                      sx0: coverCrop.sx,
                      sy0: coverCrop.sy,
                    };
                  }}
                  onPointerMove={(e) => {
                    const d = coverDrag.current;
                    if (!d || d.id !== e.pointerId) return;
                    const frame = coverFrameRef.current;
                    if (!frame || frame.clientWidth <= 0) return;
                    const { sw } = coverWindow(coverCrop.nw, coverCrop.nh);
                    const scale = frame.clientWidth / sw;
                    // 手指右移 → 图右移 → 裁切窗口在原图上左移
                    const next = clampCoverOrigin(
                      coverCrop.nw,
                      coverCrop.nh,
                      d.sx0 - (e.clientX - d.x0) / scale,
                      d.sy0 - (e.clientY - d.y0) / scale,
                    );
                    setCoverCrop((c) =>
                      c ? { ...c, sx: next.sx, sy: next.sy } : c,
                    );
                  }}
                  onPointerUp={(e) => {
                    if (coverDrag.current?.id === e.pointerId) {
                      coverDrag.current = null;
                    }
                  }}
                  onPointerCancel={() => {
                    coverDrag.current = null;
                  }}
                >
                  {(() => {
                    const { sw, sh } = coverWindow(coverCrop.nw, coverCrop.nh);
                    const { sx, sy } = clampCoverOrigin(
                      coverCrop.nw,
                      coverCrop.nh,
                      coverCrop.sx,
                      coverCrop.sy,
                    );
                    // 百分比相对裁切框：窗口 sw×sh 刚好铺满框 → 所见即所得
                    return (
                      <img
                        src={coverCrop.src}
                        alt=""
                        draggable={false}
                        className="cover-crop-img"
                        style={{
                          width: `${(coverCrop.nw / sw) * 100}%`,
                          height: `${(coverCrop.nh / sh) * 100}%`,
                          left: `${(-sx / sw) * 100}%`,
                          top: `${(-sy / sh) * 100}%`,
                        }}
                      />
                    );
                  })()}
                  <div className="cover-crop-shade" aria-hidden />
                </div>
                <div className="cover-crop-actions">
                  <button
                    type="button"
                    className="cover-crop-btn ghost"
                    onClick={() => setCoverCrop(null)}
                  >
                    {t("coverCropCancel")}
                  </button>
                  <button
                    type="button"
                    className="cover-crop-btn primary"
                    onClick={() => void confirmCoverCrop()}
                  >
                    {t("coverCropOk")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
