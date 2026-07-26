/**
 * 记事本 — 体验对齐常见开源轻量 Notes：
 * 左列表 / 右编辑 / 本地持久化 / 自动保存（参考 Notepad 式简洁，不做 Markdown 重编辑器）
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Plus,
  Redo2,
  Scissors,
  Search,
  Smile,
  TextSelect,
  Trash2,
  Type,
  Underline,
  Undo2,
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

/** 常用表情（点选插入；也支持系统表情面板 Win+. / 直接粘贴） */
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
};

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyNote(): Note {
  return {
    id: newId(),
    title: "",
    body: "",
    updatedAt: Date.now(),
  };
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

/** 大图安全转 data URL：不走 fromCharCode 展开，避免爆栈 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mime || "image/png" });
  return readBlobAsDataUrl(blob);
}

const TEXT_COLORS = [
  { id: "default", color: "#d0d0d0", label: "默" },
  { id: "white", color: "#ffffff", label: "白" },
  { id: "red", color: "#e07070", label: "红" },
  { id: "orange", color: "#e0a050", label: "橙" },
  { id: "yellow", color: "#e0d060", label: "黄" },
  { id: "green", color: "#70c090", label: "绿" },
  { id: "blue", color: "#6a9ee0", label: "蓝" },
  { id: "purple", color: "#b080e0", label: "紫" },
];

/** 高亮底色：要够亮，选中一点就看得出来 */
const HIGHLIGHT_COLORS = [
  { id: "none", color: "transparent", label: "无" },
  { id: "yellow", color: "#f5d547", label: "黄" },
  { id: "green", color: "#5ecf8a", label: "绿" },
  { id: "blue", color: "#5aa8f0", label: "蓝" },
  { id: "pink", color: "#f080a0", label: "粉" },
  { id: "orange", color: "#f0a050", label: "橙" },
  { id: "purple", color: "#c090f0", label: "紫" },
];

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

export default function Notepad({
  embedded = false,
  onChromeChange,
}: {
  /** 由 App 统一顶栏时始终 true */
  embedded?: boolean;
  /** 嵌入时把场景标题与工具上报到 App 唯一顶栏 */
  onChromeChange?: (chrome: ModuleChrome | null) => void;
}) {
  const { t } = useI18n();
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [booting, setBooting] = useState(true);
  const [saveHint, setSaveHint] = useState("");
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);
  /** 默认中号，与工具栏 M 对齐 */
  const [fontSize, setFontSize] = useState(15);
  const [stats, setStats] = useState({ chars: 0, lines: 1 });
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** 左侧笔记列表展开 / 收起 */
  const [sideOpen, setSideOpen] = useState(true);
  const saveTimer = useRef<number | null>(null);
  /** 尚未落盘的最新列表；离开模块时立刻冲刷，避免丢最后一次输入 */
  const dirtyListRef = useRef<Note[] | null>(null);
  const notesRef = useRef<Note[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const emojiWrapRef = useRef<HTMLDivElement | null>(null);
  /** 点工具栏时先存选区，避免焦点一跳选区丢了高亮失效 */
  const savedRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  const focusBody = () => bodyRef.current?.focus();

  const syncStats = useCallback(() => {
    const el = bodyRef.current;
    const plain = el ? stripHtml(el.innerHTML) : "";
    setStats({
      chars: plain.length,
      lines: plain.length === 0 ? 1 : plain.split(/\n/).length,
    });
  }, []);

  useEffect(() => {
    // 切换笔记：灌入 HTML，不在每次输入时 reset（保护光标与撤销）
    const el = bodyRef.current;
    if (!el || !activeId) return;
    const note = notesRef.current.find((n) => n.id === activeId);
    if (!note) return;
    const html = note.body.includes("<")
      ? note.body
      : note.body
        ? note.body
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br>")
        : "";
    el.innerHTML = html;
    const t = window.setTimeout(() => syncStats(), 0);
    return () => window.clearTimeout(t);
  }, [activeId, syncStats]);

  const persist = useCallback(async (list: Note[]) => {
    try {
      const store = await getNotesStore();
      await store.set(NOTES_KEY, list);
      setSaveHint(t("saved"));
      window.setTimeout(() => setSaveHint(""), 1200);
    } catch {
      setSaveHint(t("saveFail"));
    }
  }, [t]);

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

  // 切走 / 卸载时：取消定时器并立刻写入未保存内容
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

  const updateActive = (patch: Partial<Pick<Note, "title" | "body">>) => {
    if (!activeId) return;
    const next = notesRef.current.map((n) =>
      n.id === activeId
        ? { ...n, ...patch, updatedAt: Date.now() }
        : n,
    );
    setNotes(next);
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
    if (activeId === id) {
      setActiveId(next[0]?.id ?? null);
    }
    schedulePersist(next);
  };

  const noteMenu = (n: Note): CtxItem[] => [
    {
      id: "open",
      label: t("open"),
      onClick: () => setActiveId(n.id),
    },
    { id: "sep", separator: true },
    {
      id: "del",
      label: t("delete"),
      danger: true,
      onClick: () => void deleteNote(n.id),
    },
  ];

  /** 富文本 contenteditable：改完同步 HTML 到列表 */
  const onBodyInput = () => {
    const el = bodyRef.current;
    if (!el || !activeId) return;
    updateActive({ body: el.innerHTML });
    const plain = stripHtml(el.innerHTML);
    setStats({
      chars: plain.length,
      lines: plain.length === 0 ? 1 : plain.split(/\n/).length,
    });
  };

  const onTitleInput = () => {
    const el = titleRef.current;
    if (!el || !activeId) return;
    updateActive({ title: el.value });
  };

  const captureSelection = (allowCollapsed = false) => {
    const el = bodyRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.commonAncestorContainer)) return;
    if (r.collapsed && !allowCollapsed) return;
    try {
      savedRangeRef.current = r.cloneRange();
    } catch {
      savedRangeRef.current = null;
    }
  };

  /** 恢复正文选区；失败则读当前选区。没有落在正文内的选区时返回 false（避免格式化整篇） */
  const ensureBodySelection = (requireNonCollapsed = false): boolean => {
    const el = bodyRef.current;
    if (!el) return false;
    if (restoreSelection()) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (el.contains(r.commonAncestorContainer)) {
          if (requireNonCollapsed && r.collapsed) return false;
          return true;
        }
      }
    }
    captureSelection(!requireNonCollapsed);
    if (!restoreSelection()) return false;
    if (requireNonCollapsed) {
      const sel = window.getSelection();
      const r = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (!r || r.collapsed) return false;
    }
    return true;
  };

  /** 在光标处插入图片（data URL），支持粘贴 / 加号选图 */
  const insertImageDataUrl = (dataUrl: string) => {
    const el = bodyRef.current;
    if (!el || !dataUrl.startsWith("data:image")) return;
    el.focus();
    restoreSelection();
    const img = document.createElement("img");
    img.src = dataUrl;
    img.className = "notepad-img";
    img.alt = "";
    img.draggable = false;

    const sel = window.getSelection();
    try {
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (el.contains(range.commonAncestorContainer)) {
          range.deleteContents();
          range.insertNode(img);
          // 光标挪到图后，方便继续写
          range.setStartAfter(img);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          savedRangeRef.current = range.cloneRange();
        } else {
          el.appendChild(img);
        }
      } else {
        el.appendChild(img);
      }
    } catch {
      el.appendChild(img);
    }
    onBodyInput();
  };

  const addImageFromPicker = async () => {
    captureSelection(true);
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
      let added = 0;
      for (const path of paths) {
        if (typeof path !== "string" || !path) continue;
        const bytes = await readFile(path);
        const url = await bytesToDataUrl(bytes, mimeFromPath(path));
        insertImageDataUrl(url);
        added += 1;
      }
      if (added === 0) return;
    } catch {
      window.alert(t("addImageFail"));
    }
  };

  const onBodyPaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;

    const imageFiles: File[] = [];
    if (cd.files && cd.files.length > 0) {
      for (const f of Array.from(cd.files)) {
        if (f.type.startsWith("image/")) imageFiles.push(f);
      }
    }
    if (imageFiles.length === 0 && cd.items) {
      for (const item of Array.from(cd.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) imageFiles.push(f);
        }
      }
    }
    if (imageFiles.length === 0) return; // 文字/表情走默认粘贴

    e.preventDefault();
    captureSelection(true);
    for (const f of imageFiles) {
      try {
        const url = await readBlobAsDataUrl(f);
        insertImageDataUrl(url);
      } catch {
        /* skip bad file */
      }
    }
  };

  const insertEmoji = (emoji: string) => {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
    restoreSelection();
    try {
      const ok = document.execCommand("insertText", false, emoji);
      if (!ok) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(emoji);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          savedRangeRef.current = range.cloneRange();
        } else {
          el.appendChild(document.createTextNode(emoji));
        }
      } else {
        captureSelection(true);
      }
    } catch {
      el.appendChild(document.createTextNode(emoji));
    }
    onBodyInput();
    setEmojiOpen(false);
  };

  // 点面板外关闭表情
  useEffect(() => {
    if (!emojiOpen) return;
    const onDown = (e: MouseEvent) => {
      const wrap = emojiWrapRef.current;
      if (wrap && !wrap.contains(e.target as Node)) setEmojiOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEmojiOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [emojiOpen]);

  const restoreSelection = (): boolean => {
    const el = bodyRef.current;
    const range = savedRangeRef.current;
    if (!el || !range) return false;
    try {
      el.focus();
      const sel = window.getSelection();
      if (!sel) return false;
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch {
      return false;
    }
  };

  const runCmd = (cmd: string, value?: string) => {
    const el = bodyRef.current;
    if (!el) return;
    // 撤销/重做/全选不依赖选区；其它格式命令没有正文选区时禁止执行（否则会改整篇）
    const free =
      cmd === "undo" ||
      cmd === "redo" ||
      cmd === "selectAll" ||
      cmd === "styleWithCSS";
    if (!free && !ensureBodySelection(false)) return;
    el.focus();
    try {
      document.execCommand(cmd, false, value);
    } catch {
      /* ignore */
    }
    captureSelection(true);
    onBodyInput();
  };

  const runEdit = async (
    action: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "bold" | "italic" | "underline",
  ) => {
    const el = bodyRef.current;
    if (!el) return;
    if (action !== "undo" && action !== "redo" && action !== "selectAll") {
      if (!ensureBodySelection(false)) return;
    } else {
      el.focus();
    }
    if (action === "paste") {
      try {
        const text = await readText();
        document.execCommand("insertText", false, text);
        onBodyInput();
      } catch {
        try {
          document.execCommand("paste");
          onBodyInput();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    runCmd(action);
  };

  /** 只给当前选中文字包颜色 span；禁止无选区时 execCommand 污染全文 */
  const wrapSelectionColor = (color: string): boolean => {
    const range = savedRangeRef.current;
    if (!range || range.collapsed) return false;
    try {
      const live = range.cloneRange();
      const span = document.createElement("span");
      span.style.color = color;
      try {
        live.surroundContents(span);
      } catch {
        const frag = live.extractContents();
        span.appendChild(frag);
        live.insertNode(span);
      }
      const sel = window.getSelection();
      if (sel) {
        const nr = document.createRange();
        nr.selectNodeContents(span);
        sel.removeAllRanges();
        sel.addRange(nr);
        savedRangeRef.current = nr.cloneRange();
      }
      return true;
    } catch {
      return false;
    }
  };

  const applyColor = (color: string) => {
    const el = bodyRef.current;
    if (!el) return;
    // 必须有选中文字，否则不改（避免整篇变色）
    if (!ensureBodySelection(true)) return;
    el.focus();
    // 一次改完再保存，中间不要 onBodyInput（重渲染会弄丢选区，导致第二次命令打到全文）
    if (!wrapSelectionColor(color)) {
      try {
        document.execCommand("styleWithCSS", false, "true");
        document.execCommand("foreColor", false, color);
      } catch {
        /* ignore */
      }
    }
    captureSelection(true);
    onBodyInput();
  };

  /** 用 span 包一层：execCommand 在 WebView 里偶发失效 */
  const wrapSelectionHighlight = (color: string) => {
    const range = savedRangeRef.current;
    if (!range || range.collapsed) return false;
    try {
      if (color === "transparent") {
        restoreSelection();
        document.execCommand("styleWithCSS", false, "true");
        document.execCommand("hiliteColor", false, "transparent");
        document.execCommand("backColor", false, "transparent");
        return true;
      }
      const live = range.cloneRange();
      const span = document.createElement("span");
      span.setAttribute("data-hl", "1");
      span.style.backgroundColor = color;
      span.style.color = "#111111";
      span.style.borderRadius = "2px";
      span.style.padding = "0 2px";
      try {
        live.surroundContents(span);
      } catch {
        const frag = live.extractContents();
        span.appendChild(frag);
        live.insertNode(span);
      }
      const sel = window.getSelection();
      if (sel) {
        const nr = document.createRange();
        nr.selectNodeContents(span);
        sel.removeAllRanges();
        sel.addRange(nr);
        savedRangeRef.current = nr.cloneRange();
      }
      return true;
    } catch {
      return false;
    }
  };

  /** 选中文字加背景高亮；transparent = 取消高亮 */
  const applyHighlight = (color: string) => {
    const el = bodyRef.current;
    if (!el) return;
    // 高亮必须有选中段，禁止无选区时改整篇
    if (!ensureBodySelection(true)) return;
    el.focus();
    if (color === "transparent") {
      try {
        document.execCommand("styleWithCSS", false, "true");
        document.execCommand("hiliteColor", false, "transparent");
        document.execCommand("backColor", false, "transparent");
      } catch {
        /* ignore */
      }
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          let node: Node | null = sel.getRangeAt(0).commonAncestorContainer;
          if (node.nodeType === 3) node = node.parentNode;
          const hl = (node as HTMLElement | null)?.closest?.("span[data-hl='1']");
          if (hl && hl.parentNode) {
            while (hl.firstChild) hl.parentNode.insertBefore(hl.firstChild, hl);
            hl.parentNode.removeChild(hl);
          }
        }
      } catch {
        /* ignore */
      }
    } else if (!wrapSelectionHighlight(color)) {
      try {
        document.execCommand("styleWithCSS", false, "true");
        document.execCommand("hiliteColor", false, color);
        document.execCommand("backColor", false, color);
      } catch {
        /* ignore */
      }
    }
    captureSelection(true);
    onBodyInput();
  };

  const insertDateTime = () => {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
    const stamp = new Date().toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    document.execCommand("insertText", false, stamp);
    onBodyInput();
  };

  const editorMenu = (): CtxItem[] => [
    { id: "bold", label: t("bold") || "加粗", onClick: () => void runEdit("bold") },
    { id: "italic", label: t("italic") || "斜体", onClick: () => void runEdit("italic") },
    { id: "underline", label: t("underline") || "下划线", onClick: () => void runEdit("underline") },
    { id: "sep0", separator: true },
    { id: "undo", label: t("undo"), onClick: () => void runEdit("undo") },
    { id: "redo", label: t("redo"), onClick: () => void runEdit("redo") },
    { id: "sep1", separator: true },
    { id: "cut", label: t("cut"), onClick: () => void runEdit("cut") },
    { id: "copy", label: t("copy"), onClick: () => void runEdit("copy") },
    { id: "paste", label: t("paste"), onClick: () => void runEdit("paste") },
    { id: "sep2", separator: true },
    { id: "all", label: t("selectAll"), onClick: () => void runEdit("selectAll") },
    { id: "time", label: t("insertDateTime"), onClick: () => insertDateTime() },
  ];

  // 顶栏只放全局（语言/窗控）；新建/删除放列表区，不占顶栏
  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    if (booting) {
      onChromeChange(null);
      return;
    }
    const meta = [
      `${notes.length} ${t("notesCount")}`,
      saveHint || null,
    ]
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
        {/* 收起时彻底隐藏，不留细条；展开/收起只在右侧工具栏 */}
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
                    onClick={() => deleteNote(active.id)}
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
          {/* 工具栏始终有侧栏开关；收起后只靠这里展开 */}
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
            {active ? (
              <>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={`${t("undo")} Ctrl+Z`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("undo")}
                >
                  <Undo2 size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={`${t("redo")} Ctrl+Y`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("redo")}
                >
                  <Redo2 size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("cut")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("cut")}
                >
                  <Scissors size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("copy")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("copy")}
                >
                  <Copy size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("paste")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("paste")}
                >
                  <ClipboardPaste size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("bold") || "加粗"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("bold")}
                >
                  <Bold size={15} strokeWidth={2} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("italic") || "斜体"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("italic")}
                >
                  <Italic size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("underline") || "下划线"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("underline")}
                >
                  <Underline size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <span className="notepad-tool-sep" />
                <span className="notepad-colors" title={t("textColor") || "文字颜色"}>
                  <Type size={12} strokeWidth={1.75} absoluteStrokeWidth className="notepad-colors-icon" aria-hidden />
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="notepad-color-dot"
                      style={{ background: c.color }}
                      title={`${t("textColor") || "文字"} · ${c.label}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        captureSelection();
                      }}
                      onClick={() => applyColor(c.color)}
                    />
                  ))}
                </span>
                <span className="notepad-tool-sep" />
                <span className="notepad-colors" title={t("highlight") || "高亮"}>
                  <Highlighter size={12} strokeWidth={1.75} absoluteStrokeWidth className="notepad-colors-icon" aria-hidden />
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
                      onMouseDown={(e) => {
                        e.preventDefault();
                        captureSelection();
                      }}
                      onClick={() => applyHighlight(c.color)}
                    />
                  ))}
                </span>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("selectAll")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection();
                  }}
                  onClick={() => void runEdit("selectAll")}
                >
                  <TextSelect size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("insertDateTime")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection(true);
                  }}
                  onClick={insertDateTime}
                >
                  <CalendarDays size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <button
                  type="button"
                  className="notepad-tool icon-only"
                  title={t("addImage")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    captureSelection(true);
                  }}
                  onClick={() => void addImageFromPicker()}
                >
                  <ImagePlus size={15} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
                <div className="notepad-emoji-wrap" ref={emojiWrapRef}>
                  <button
                    type="button"
                    className={emojiOpen ? "notepad-tool icon-only on" : "notepad-tool icon-only"}
                    title={t("insertEmoji")}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      captureSelection(true);
                    }}
                    onClick={() => setEmojiOpen((v) => !v)}
                  >
                    <Smile size={15} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                  {emojiOpen ? (
                    <div className="notepad-emoji-panel" role="listbox" aria-label={t("insertEmoji")}>
                      {EMOJIS.map((em) => (
                        <button
                          key={em}
                          type="button"
                          className="notepad-emoji-btn"
                          title={em}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            captureSelection(true);
                          }}
                          onClick={() => insertEmoji(em)}
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <span className="notepad-tool-sep" />
                <button
                  type="button"
                  className={fontSize <= 13 ? "notepad-tool size-letter on" : "notepad-tool size-letter"}
                  title={t("fontS")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setFontSize(13);
                    focusBody();
                  }}
                >
                  S
                </button>
                <button
                  type="button"
                  className={fontSize === 15 ? "notepad-tool size-letter on" : "notepad-tool size-letter"}
                  title={t("fontM")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setFontSize(15);
                    focusBody();
                  }}
                >
                  M
                </button>
                <button
                  type="button"
                  className={fontSize === 18 ? "notepad-tool size-letter on" : "notepad-tool size-letter"}
                  title={t("fontL")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setFontSize(18);
                    focusBody();
                  }}
                >
                  L
                </button>
                <button
                  type="button"
                  className={fontSize >= 22 ? "notepad-tool size-letter xl on" : "notepad-tool size-letter xl"}
                  title={t("fontXL")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setFontSize(24);
                    focusBody();
                  }}
                >
                  XL
                </button>
              </>
            ) : null}
          </div>
          {active ? (
            <>
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
                key={`b-${active.id}`}
                ref={bodyRef}
                className="notepad-body notepad-rich"
                contentEditable
                suppressContentEditableWarning
                data-placeholder={t("noteBody")}
                onInput={onBodyInput}
                onPaste={(e) => void onBodyPaste(e)}
                onMouseUp={() => captureSelection()}
                onKeyUp={() => captureSelection(true)}
                onContextMenu={(e) => openCtxMenu(e, editorMenu(), setCtxMenu)}
                spellCheck={false}
                style={{ fontSize: fontSize }}
              />
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
              <button type="button" className="passbox-primary notepad-blank-btn" onClick={createNote}>
                {t("newNote")}
              </button>
            </div>
          )}
        </section>
      </div>

      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
}
