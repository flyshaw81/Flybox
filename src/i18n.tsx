import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { load } from "@tauri-apps/plugin-store";
import { Languages } from "lucide-react";

export type Locale = "zh" | "en";

type Dict = Record<string, string>;

const zh: Dict = {
  appName: "FLYBOX",
  booting: "正在打开…",
  noVault: "未选择图库",
  photos: "张图片",
  pickFolder: "选择图库文件夹",
  changeFolder: "更换文件夹",
  refresh: "刷新",
  deepScan: "DEEP",
  deepScanOn: "DEEP 开：包含全部子文件夹",
  deepScanOff: "DEEP 关：仅当前文件夹",
  passbox: "密码箱",
  notepad: "记事本",
  grid: "网格",
  waterfall: "瀑布",
  single: "单张",
  minimize: "最小化",
  maximize: "最大化",
  close: "关闭",
  zoomOut: "缩小",
  zoomIn: "放大",
  zoomReset: "重置缩放",
  copy: "复制",
  delete: "删除",
  backGallery: "返回图库",
  backList: "返回列表",
  open: "打开",
  copyImage: "复制图片",
  copyPath: "复制路径",
  closePreview: "关闭预览",
  emptyTitle: "像打开一个文件夹一样",
  emptyDesc: "指定一个目录作为图库，打开即可浏览里面的图片。",
  scanning: "扫描中…",
  noImages: "这个文件夹里还没有图片",
  noImagesHint: "把图片放进该文件夹后点「刷新」",
  copiedClipboard: "已复制到剪贴板",
  copiedPath: "已复制文件路径",
  copyFail: "复制失败",
  deleted: "已删除",
  deleteFail: "删除失败",
  deleteConfirm: "确定删除这张图片？",
  deleteConfirmDisk: "将从磁盘彻底删除。",
  openFolderFail: "打开文件夹失败",
  langSwitch: "中 / EN",
  langZh: "中文",
  langEn: "English",
  themeToLight: "切换浅色",
  themeToDark: "切换深色",

  // notepad
  notes: "记事本",
  notesCount: "条",
  saved: "已保存",
  saveFail: "保存失败",
  newNote: "新建笔记",
  deleteNote: "删除当前笔记",
  deleteNoteConfirm: "删除这条笔记？",
  searchNotes: "搜索笔记",
  emptyNotes: "点搜索栏旁 + 写一条",
  noMatchNotes: "没有匹配的笔记",
  untitledNote: "未命名笔记",
  emptyNote: "空笔记",
  noteImage: "图片",
  insertEmoji: "表情",
  collapseSidebar: "收起列表",
  expandSidebar: "展开列表",
  noteTitle: "标题",
  noteBody: "开始写点什么…  可粘贴图片/表情 · Ctrl+Z 撤销",
  pickOrNew: "选择左侧笔记，或新建一条",
  undo: "撤销",
  redo: "重做",
  cut: "剪切",
  paste: "粘贴",
  selectAll: "全选",
  insertDate: "日期",
  insertDateTime: "插入日期时间",
  fontS: "小",
  fontM: "中",
  fontL: "大",
  fontXL: "超大",
  chars: "字",
  lines: "行",
  undoHint: "Ctrl+Z 撤销 · Ctrl+Y 重做",
  bold: "加粗",
  italic: "斜体",
  underline: "下划线",
  textColor: "文字颜色",
  highlight: "高亮",
  clearHighlight: "取消高亮",

  // passbox common
  passboxTitle: "密码箱",
  setupTitle: "密码箱 · 首次设置",
  editEntry: "编辑条目",
  listView: "密码箱 · 列表",
  gridView: "密码箱 · 网格",
  createPassbox: "创建密码箱",
  createHint: "内容仅本机加密保存 · 无法找回 · 无法重置 · 请务必记住密码",
  masterPw: "主密码",
  confirmPw: "确认主密码",
  hint1Opt: "提示 1（可选，不能用来重置密码）",
  hint2Opt: "提示 2（可选）",
  pwMin: "至少 4 位",
  createAndLock: "创建并锁定",
  wipeRule: "连续输错 50 次密码 → 箱内全部内容自动永久销毁",
  unlockTitle: "输入密码解锁",
  unlock: "解锁",
  forgotPw: "忘记密码",
  hideHints: "收起提示",
  hintOnly: "提示只能帮你想起来，不能重置密码",
  hintLabel1: "提示 1：",
  hintLabel2: "提示 2：",
  destroyed: "密码箱已销毁",
  destroyedSub: "连续 50 次密码错误 · 全部条目已永久删除且不可恢复",
  recreate: "重新创建密码箱",
  lockNow: "立即上锁",
  newEntry: "新建",
  all: "全部",
  noEntries: "还没有条目",
  noEntriesHint: "点右上角 + 添加 API 密钥、银行卡、账号或备忘",
  save: "保存",
  savedOk: "已保存",
  localOnly: "内容仅本地加密存储 · 离开密码箱后自动上锁",
  name: "名称",
  note: "备注",
  optional: "可选",
  images: "图片",
  addImage: "添加图片",
  removeImage: "删除图片",
  cardNo: "卡号",
  cardPlaceholder: "银行卡号",
  account: "账号",
  password: "密码",
  content: "内容",
  freeText: "自由文本",
  addKey: "添加 KEY",
  deleteKey: "删除此 KEY",
  edit: "编辑",
  deleteEntry: "删除",
  deleteEntryConfirm: "删除这条记录？删除后无法恢复。",
  entryDeleted: "已删除",
  titleRequired: "标题不能为空",
  pwMismatch: "两次密码不一致",
  pwTooShort: "密码至少 4 位",
  created: "密码箱已创建",
  type_api: "API 密钥",
  type_bank: "银行卡",
  type_account: "账号密码",
  type_game: "游戏账号",
  type_douyin: "抖音账号",
  type_x: "X 账号",
  type_google: "谷歌账号",
  type_apple: "Apple ID",
  type_note: "自由文本",
  copyUrl: "复制 URL",
  copyKey: "复制 KEY",
  maxImages: "最多图片张数",
  imageTooBig: "图片过大已跳过（单张不超过约 2.5MB）",
  addedImages: "已添加图片",
  addImageFail: "添加图片失败",
  pickImages: "选择图片",
  nothingCopy: "没有可复制的内容",
  copied: "已复制",
};

const en: Dict = {
  appName: "FLYBOX",
  booting: "Opening…",
  noVault: "No library selected",
  photos: "photos",
  pickFolder: "Choose library folder",
  changeFolder: "Change folder",
  refresh: "Refresh",
  deepScan: "DEEP",
  deepScanOn: "DEEP on: all subfolders",
  deepScanOff: "DEEP off: this folder only",
  passbox: "Vault",
  notepad: "Notes",
  grid: "Grid",
  waterfall: "Masonry",
  single: "Single",
  minimize: "Minimize",
  maximize: "Maximize",
  close: "Close",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoomReset: "Reset zoom",
  copy: "Copy",
  delete: "Delete",
  backGallery: "Back to library",
  backList: "Back to list",
  open: "Open",
  copyImage: "Copy image",
  copyPath: "Copy path",
  closePreview: "Close preview",
  emptyTitle: "Open a folder as your library",
  emptyDesc: "Pick a directory and browse photos inside it.",
  scanning: "Scanning…",
  noImages: "No photos in this folder",
  noImagesHint: "Add images, then hit Refresh",
  copiedClipboard: "Copied to clipboard",
  copiedPath: "Path copied",
  copyFail: "Copy failed",
  deleted: "Deleted",
  deleteFail: "Delete failed",
  deleteConfirm: "Delete this photo?",
  deleteConfirmDisk: "It will be permanently removed from disk.",
  openFolderFail: "Failed to open folder",
  langSwitch: "中 / EN",
  langZh: "中文",
  langEn: "English",
  themeToLight: "Light mode",
  themeToDark: "Dark mode",

  notes: "Notes",
  notesCount: "notes",
  saved: "Saved",
  saveFail: "Save failed",
  newNote: "New note",
  deleteNote: "Delete note",
  deleteNoteConfirm: "Delete this note?",
  searchNotes: "Search notes",
  emptyNotes: "Tap + to write a note",
  noMatchNotes: "No matching notes",
  untitledNote: "Untitled",
  emptyNote: "Empty",
  noteImage: "Image",
  insertEmoji: "Emoji",
  collapseSidebar: "Collapse list",
  expandSidebar: "Expand list",
  noteTitle: "Title",
  noteBody: "Start writing…  Paste images/emoji · Ctrl+Z undo",
  pickOrNew: "Pick a note or create one",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  paste: "Paste",
  selectAll: "Select all",
  insertDate: "Date",
  insertDateTime: "Insert date & time",
  fontS: "S",
  fontM: "M",
  fontL: "L",
  fontXL: "XL",
  chars: "chars",
  lines: "lines",
  undoHint: "Ctrl+Z undo · Ctrl+Y redo",
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  textColor: "Text color",
  highlight: "Highlight",
  clearHighlight: "Clear highlight",

  passboxTitle: "Vault",
  setupTitle: "Vault · First setup",
  editEntry: "Edit entry",
  listView: "Vault · List",
  gridView: "Vault · Grid",
  createPassbox: "Create vault",
  createHint: "Encrypted on this device only · No recovery · No reset · Remember your password",
  masterPw: "Master password",
  confirmPw: "Confirm password",
  hint1Opt: "Hint 1 (optional, cannot reset password)",
  hint2Opt: "Hint 2 (optional)",
  pwMin: "At least 4 characters",
  createAndLock: "Create & lock",
  wipeRule: "50 wrong attempts → all vault data is permanently destroyed",
  unlockTitle: "Enter password to unlock",
  unlock: "Unlock",
  forgotPw: "Forgot password",
  hideHints: "Hide hints",
  hintOnly: "Hints only help you remember — they cannot reset the password",
  hintLabel1: "Hint 1: ",
  hintLabel2: "Hint 2: ",
  destroyed: "Vault destroyed",
  destroyedSub: "50 wrong passwords · All entries permanently deleted",
  recreate: "Create a new vault",
  lockNow: "Lock now",
  newEntry: "New",
  all: "All",
  noEntries: "No entries yet",
  noEntriesHint: "Tap + to add API keys, cards, accounts, or notes",
  save: "Save",
  savedOk: "Saved",
  localOnly: "Encrypted locally · Auto-locks when you leave the vault",
  name: "Name",
  note: "Note",
  optional: "Optional",
  images: "Images",
  addImage: "Add image",
  removeImage: "Remove image",
  cardNo: "Card number",
  cardPlaceholder: "Card number",
  account: "Account",
  password: "Password",
  content: "Content",
  freeText: "Free text",
  addKey: "Add KEY",
  deleteKey: "Remove KEY",
  edit: "Edit",
  deleteEntry: "Delete",
  deleteEntryConfirm: "Delete this entry? This cannot be undone.",
  entryDeleted: "Deleted",
  titleRequired: "Title is required",
  pwMismatch: "Passwords do not match",
  pwTooShort: "Password must be at least 4 characters",
  created: "Vault created",
  type_api: "API key",
  type_bank: "Bank card",
  type_account: "Account",
  type_game: "Game account",
  type_douyin: "Douyin",
  type_x: "X account",
  type_google: "Google",
  type_apple: "Apple ID",
  type_note: "Note",
  copyUrl: "Copy URL",
  copyKey: "Copy KEY",
  maxImages: "Image limit reached",
  imageTooBig: "Image too large (max ~2.5MB each)",
  addedImages: "Images added",
  addImageFail: "Failed to add image",
  pickImages: "Choose images",
  nothingCopy: "Nothing to copy",
  copied: "Copied",
};

const tables: Record<Locale, Dict> = { zh, en };

type I18nCtx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  toggleLocale: () => void;
  t: (key: string) => string;
};

const Ctx = createContext<I18nCtx | null>(null);
const STORE = "settings.json";
const LOCALE_KEY = "locale";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("zh");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await load(STORE, { autoSave: true });
        const saved = await store.get<string>(LOCALE_KEY);
        if (!cancelled && (saved === "zh" || saved === "en")) {
          setLocaleState(saved);
          document.documentElement.lang = saved === "zh" ? "zh-CN" : "en";
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    void (async () => {
      try {
        const store = await load(STORE, { autoSave: true });
        await store.set(LOCALE_KEY, l);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "zh" ? "en" : "zh");
  }, [locale, setLocale]);

  const t = useCallback(
    (key: string) => tables[locale][key] ?? tables.zh[key] ?? key,
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, toggleLocale, t }),
    [locale, setLocale, toggleLocale, t],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside provider");
  return v;
}

/** 顶栏中英文切换：仅 Languages 图标（悬停看当前可切到的语言） */
export function LangButton({ className = "icon-btn" }: { className?: string }) {
  const { locale, toggleLocale, t } = useI18n();
  return (
    <button
      type="button"
      className={className}
      title={`${t("langSwitch")} → ${locale === "zh" ? t("langEn") : t("langZh")}`}
      onClick={toggleLocale}
      data-locale={locale}
    >
      <Languages size={15} strokeWidth={1.75} absoluteStrokeWidth />
    </button>
  );
}
