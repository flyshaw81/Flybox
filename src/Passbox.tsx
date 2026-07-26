import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowLeft,
  AtSign,
  Copy,
  CreditCard,
  FileText,
  Gamepad2,
  ImagePlus,
  Key,
  LayoutGrid,
  List,
  Lock,
  Plus,
  Skull,
  Trash2,
  User,
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

/** 账号类：用户名 + 密码 */
export type AccountLikeType = "account" | "game" | "douyin" | "x" | "google" | "apple";
export type EntryType = "api" | "bank" | AccountLikeType | "note";

export type VaultEntry = {
  id: string;
  type: EntryType;
  title: string;
  /** String values, or for API: `keys` may be string[]. */
  fields: Record<string, unknown>;
  note: string;
  updatedAt: number;
};

type VaultStatus = {
  state: "none" | "locked" | "unlocked" | "destroyed" | string;
  hint1: string;
  hint2: string;
  failCount: number;
  entryCount: number;
};

type TabFilter = "all" | EntryType;
type BoxView = "list" | "grid";
type Screen = "boot" | "setup" | "unlock" | "list" | "edit" | "destroyed";

const TYPE_LABEL: Record<EntryType, string> = {
  api: "API 密钥",
  bank: "银行卡",
  account: "账号密码",
  game: "游戏账号",
  douyin: "抖音账号",
  x: "X 账号",
  google: "谷歌账号",
  apple: "Apple ID",
  note: "自由文本",
};

const ALL_TYPES: EntryType[] = [
  "api",
  "bank",
  "account",
  "game",
  "douyin",
  "x",
  "google",
  "apple",
  "note",
];

function isAccountLike(t: EntryType): t is AccountLikeType {
  return (
    t === "account" ||
    t === "game" ||
    t === "douyin" ||
    t === "x" ||
    t === "google" ||
    t === "apple"
  );
}

/** 条目附图（data URL），所有分类共用 */
function getImages(fields: Record<string, unknown> | undefined): string[] {
  if (!fields) return [];
  const multi = fields.images;
  if (Array.isArray(multi)) {
    return multi.filter(
      (x): x is string => typeof x === "string" && x.startsWith("data:image"),
    );
  }
  const one = fields.image;
  if (typeof one === "string" && one.startsWith("data:image")) return [one];
  return [];
}

/** 仅保留当前类型该有的字段，避免串台；图片所有分类都保留 */
function fieldsForType(type: EntryType, src?: Record<string, unknown>): Record<string, unknown> {
  const f = src ?? {};
  const images = getImages(f);
  let base: Record<string, unknown> = {};
  if (type === "api") {
    base = { url: fieldStr(f, "url"), keys: getApiKeys(f) };
  } else if (type === "bank") {
    base = { cardNumber: fieldStr(f, "cardNumber") };
  } else if (isAccountLike(type)) {
    base = {
      username: fieldStr(f, "username"),
      password: fieldStr(f, "password"),
    };
  } else if (type === "note") {
    base = { body: fieldStr(f, "body") };
  }
  return images.length > 0 ? { ...base, images } : base;
}

function emptyFields(type: EntryType): Record<string, unknown> {
  if (type === "api") return { url: "", keys: [""] };
  if (type === "bank") return { cardNumber: "" };
  if (isAccountLike(type)) return { username: "", password: "" };
  if (type === "note") return { body: "" };
  return {};
}

const MAX_ENTRY_IMAGES = 8;
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "jpg" || ext === "jpeg" || ext === "jfif") return "image/jpeg";
  return "image/jpeg";
}

/** 大图安全转 data URL，避免 fromCharCode 展开爆栈 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mime || "image/jpeg" });
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function fieldStr(fields: Record<string, unknown> | undefined, key: string): string {
  const v = fields?.[key];
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** API 可多 KEY；兼容旧数据 fields.key 单字符串。 */
function getApiKeys(fields: Record<string, unknown> | undefined): string[] {
  if (!fields) return [""];
  const multi = fields.keys;
  if (Array.isArray(multi)) {
    const list = multi.map((x) => (x == null ? "" : String(x)));
    return list.length > 0 ? list : [""];
  }
  if (typeof multi === "string" && multi.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(multi) as unknown;
      if (Array.isArray(parsed)) {
        const list = parsed.map((x) => (x == null ? "" : String(x)));
        return list.length > 0 ? list : [""];
      }
    } catch {
      /* fall through */
    }
  }
  const single = fieldStr(fields, "key");
  if (single) return [single];
  return [""];
}

function normalizeEntry(raw: VaultEntry): VaultEntry {
  const type = (ALL_TYPES.includes(raw.type as EntryType) ? raw.type : "note") as EntryType;
  const src = (raw.fields ?? {}) as Record<string, unknown>;
  return {
    id: raw.id ?? "",
    type,
    title: raw.title ?? "",
    fields: fieldsForType(type, src),
    note: raw.note ?? "",
    updatedAt: raw.updatedAt ?? 0,
  };
}

function previewLine(e: VaultEntry): string {
  if (e.type === "api") {
    const url = fieldStr(e.fields, "url");
    const keys = getApiKeys(e.fields).filter((k) => k.trim());
    if (url && keys.length) return keys.length > 1 ? `URL + ${keys.length} 个 KEY` : "URL + KEY";
    if (url) return url;
    if (keys.length > 1) return `${keys.length} 个 KEY`;
    if (keys.length === 1) return maskSecret(keys[0]);
    return "API 密钥";
  }
  if (e.type === "bank") {
    return maskCard(fieldStr(e.fields, "cardNumber")) || "银行卡";
  }
  if (isAccountLike(e.type)) {
    return fieldStr(e.fields, "username") || TYPE_LABEL[e.type];
  }
  if (e.type === "note") {
    const body = fieldStr(e.fields, "body");
    return body ? (body.length > 28 ? body.slice(0, 28) + "…" : body) : "自由文本";
  }
  return "";
}

function listMeta(e: VaultEntry): string {
  return `${TYPE_LABEL[e.type] ?? ""} · ${previewLine(e)}`;
}

function maskSecret(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return s.slice(0, 6) + "••••••••";
}

function maskCard(s: string): string {
  const d = s.replace(/\s+/g, "");
  if (d.length < 4) return d ? "****" : "";
  return `**** ${d.slice(-4)}`;
}

function TypeIcon({ type }: { type: EntryType }) {
  const p = { size: ICO, strokeWidth: 1.75 as const, absoluteStrokeWidth: true };
  if (type === "api") return <Key {...p} />;
  if (type === "bank") return <CreditCard {...p} />;
  if (type === "game") return <Gamepad2 {...p} />;
  if (type === "douyin" || type === "x") return <AtSign {...p} />;
  if (type === "google" || type === "apple" || type === "account") return <User {...p} />;
  if (type === "note") return <FileText {...p} />;
  return <User {...p} />;
}

function emptyDraft(type: EntryType = "api"): VaultEntry {
  return {
    id: "",
    type,
    title: "",
    fields: emptyFields(type),
    note: "",
    updatedAt: 0,
  };
}

/** 编辑会话里每个分类各自一份标题/备注/字段，互不粘连 */
type TypeSlice = { title: string; note: string; fields: Record<string, unknown> };

function sliceFromDraft(d: VaultEntry): TypeSlice {
  return {
    title: d.title,
    note: d.note ?? "",
    fields: { ...d.fields },
  };
}

function draftFromSlice(
  id: string,
  type: EntryType,
  slice: TypeSlice | undefined,
  updatedAt: number,
): VaultEntry {
  if (slice) {
    return {
      id,
      type,
      title: slice.title,
      note: slice.note,
      fields: { ...emptyFields(type), ...slice.fields },
      updatedAt,
    };
  }
  return {
    id,
    type,
    title: "",
    note: "",
    fields: emptyFields(type),
    updatedAt,
  };
}

export default function Passbox({
  onBackToGallery,
  embedded = false,
  onChromeChange,
}: {
  onBackToGallery: () => void;
  /** 由 App 统一顶栏时，隐藏窗控/模块外的第二套全屏壳 */
  embedded?: boolean;
  /** 嵌入时把场景标题与工具上报到 App 唯一顶栏 */
  onChromeChange?: (chrome: ModuleChrome | null) => void;
}) {
  const { t, locale } = useI18n();
  const labels = useMemo(() => {
    const m = { ...TYPE_LABEL };
    (Object.keys(TYPE_LABEL) as EntryType[]).forEach((k) => {
      m[k] = t(
        (
          {
            api: "type_api",
            bank: "type_bank",
            account: "type_account",
            game: "type_game",
            douyin: "type_douyin",
            x: "type_x",
            google: "type_google",
            apple: "type_apple",
            note: "type_note",
          } as Record<EntryType, string>
        )[k],
      );
    });
    return m;
  }, [t, locale]);

  const [screen, setScreen] = useState<Screen>("boot");
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** 编辑中各分类缓存，换 tab 不串字 */
  const typeCacheRef = useRef<Partial<Record<EntryType, TypeSlice>>>({});
  const [formGen, setFormGen] = useState(0);

  // setup
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [hint1, setHint1] = useState("");
  const [hint2, setHint2] = useState("");

  // unlock
  const [unlockPw, setUnlockPw] = useState("");
  const [showHints, setShowHints] = useState(false);

  // list
  const [tab, setTab] = useState<TabFilter>("all");
  /** 顶栏 tools 闭包易过期：新建永远读最新分类 */
  const tabRef = useRef<TabFilter>("all");
  const [boxView, setBoxView] = useState<BoxView>("list");
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // edit
  const [draft, setDraft] = useState<VaultEntry>(emptyDraft());

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await invoke<VaultStatus>("vault_status");
    setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await invoke<VaultStatus>("vault_status");
        if (cancelled) return;
        setStatus(s);
        if (s.state === "destroyed") setScreen("destroyed");
        else if (s.state === "none") setScreen("setup");
        else if (s.state === "unlocked") {
          const list = await invoke<VaultEntry[]>("vault_list");
          if (cancelled) return;
          setEntries(list.map(normalizeEntry));
          setScreen("list");
        } else setScreen("unlock");
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setScreen("setup");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (tab === "all") return entries;
    return entries.filter((e) => e.type === tab);
  }, [entries, tab]);

  const copyText = async (text: string, label = "已复制") => {
    if (!text) {
      showToast("没有可复制的内容");
      return;
    }
    try {
      await writeText(text);
      showToast(label);
    } catch (e) {
      showToast(`复制失败：${e}`);
    }
  };

  const copyEntry = async (e: VaultEntry) => {
    if (e.type === "api") {
      const keys = getApiKeys(e.fields).filter((k) => k.trim());
      const url = fieldStr(e.fields, "url");
      if (keys.length === 1) {
        await copyText(keys[0], "已复制 KEY");
        return;
      }
      if (keys.length > 1) {
        await copyText(keys.join("\n"), `已复制 ${keys.length} 个 KEY`);
        return;
      }
      await copyText(url, "已复制 URL");
      return;
    }
    if (e.type === "bank") {
      await copyText(fieldStr(e.fields, "cardNumber"), "已复制卡号");
      return;
    }
    if (isAccountLike(e.type)) {
      await copyText(fieldStr(e.fields, "password") || fieldStr(e.fields, "username"), "已复制");
      return;
    }
    await copyText(fieldStr(e.fields, "body") || e.note, "已复制");
  };

  const onSetup = async () => {
    setError(null);
    if (pw.length < 4) {
      setError("密码至少 4 位");
      return;
    }
    if (pw !== pw2) {
      setError("两次密码不一致");
      return;
    }
    try {
      await invoke("vault_setup", {
        password: pw,
        hint1,
        hint2,
      });
      setPw("");
      setPw2("");
      setEntries([]);
      setScreen("list");
      await refreshStatus();
      showToast("密码箱已创建");
    } catch (e) {
      setError(String(e));
    }
  };

  const onUnlock = async () => {
    setError(null);
    try {
      const list = await invoke<VaultEntry[]>("vault_unlock", { password: unlockPw });
      setUnlockPw("");
      setEntries(list.map(normalizeEntry));
      setScreen("list");
      await refreshStatus();
    } catch (e) {
      const msg = String(e);
      setUnlockPw("");
      // 仅后端明确返回 VAULT_DESTROYED 才进销毁页（勿用「销毁」二字模糊匹配，会误伤）
      if (msg.includes("VAULT_DESTROYED")) {
        setError(null);
        setScreen("destroyed");
        await refreshStatus().catch(() => undefined);
        return;
      }
      setError(msg.replace(/^Error:\s*/i, "").replace(/^"/, "").replace(/"$/, ""));
      try {
        const s = await refreshStatus();
        if (s.state === "destroyed") setScreen("destroyed");
      } catch {
        /* ignore */
      }
    }
  };

  const onLock = async () => {
    try {
      await invoke("vault_lock");
    } catch {
      /* ignore */
    }
    setEntries([]);
    setDraft(emptyDraft());
    setUnlockPw("");
    setScreen("unlock");
    await refreshStatus();
  };

  const openNew = useCallback(() => {
    // 当前筛选了哪个分类，新建就落在哪个分类；「全部」时默认 API 密钥
    const cur = tabRef.current;
    const type: EntryType = cur === "all" ? "api" : cur;
    typeCacheRef.current = {};
    setFormGen((g) => g + 1);
    setDraft(emptyDraft(type));
    setError(null);
    setScreen("edit");
  }, []);

  const applyOpenedEntry = (n: VaultEntry) => {
    typeCacheRef.current = {
      [n.type]: {
        title: n.title,
        note: n.note ?? "",
        fields: { ...emptyFields(n.type), ...n.fields },
      },
    };
    setFormGen((g) => g + 1);
    setDraft({
      id: n.id,
      type: n.type,
      title: n.title,
      note: n.note ?? "",
      updatedAt: n.updatedAt,
      fields: { ...emptyFields(n.type), ...n.fields },
    });
    setScreen("edit");
  };

  /** 深拷贝打开条目，避免和列表共用引用、互相污染 */
  const openEdit = async (e: VaultEntry) => {
    setError(null);
    try {
      const list = await invoke<VaultEntry[]>("vault_list");
      setEntries(list.map(normalizeEntry));
      const fresh = list.find((x) => x.id === e.id) ?? e;
      const raw = JSON.parse(JSON.stringify(fresh)) as VaultEntry;
      applyOpenedEntry(normalizeEntry(raw));
    } catch (err) {
      const raw = JSON.parse(JSON.stringify(e)) as VaultEntry;
      applyOpenedEntry(normalizeEntry(raw));
      setError(String(err));
    }
  };

  /** 切换分类：当前分类内容写入缓存，目标分类从缓存取或空白 */
  const switchEditType = (next: EntryType) => {
    setDraft((d) => {
      if (d.type === next) return d;
      typeCacheRef.current[d.type] = sliceFromDraft(d);
      return draftFromSlice(d.id, next, typeCacheRef.current[next], d.updatedAt);
    });
    setFormGen((g) => g + 1);
  };

  const setField = (key: string, value: string) => {
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));
  };

  const setApiKeyAt = (index: number, value: string) => {
    setDraft((d) => {
      const keys = [...getApiKeys(d.fields)];
      keys[index] = value;
      return { ...d, fields: { ...d.fields, keys } };
    });
  };

  const addApiKey = () => {
    setDraft((d) => {
      const keys = [...getApiKeys(d.fields), ""];
      return { ...d, fields: { ...d.fields, keys } };
    });
  };

  const removeApiKey = (index: number) => {
    setDraft((d) => {
      const keys = getApiKeys(d.fields).filter((_, i) => i !== index);
      return { ...d, fields: { ...d.fields, keys: keys.length > 0 ? keys : [""] } };
    });
  };

  const onSave = async () => {
    setError(null);
    try {
      // 只写入当前分类字段 + 图片，绝不把别的分类脏字段带进存储
      const images = getImages(draft.fields);
      let fields = fieldsForType(draft.type, draft.fields);
      if (draft.type === "api") {
        const keys = getApiKeys(draft.fields)
          .map((k) => k.trim())
          .filter(Boolean);
        fields = { url: fieldStr(draft.fields, "url").trim(), keys };
      } else if (draft.type === "bank") {
        fields = { cardNumber: fieldStr(draft.fields, "cardNumber").trim() };
      } else if (isAccountLike(draft.type)) {
        fields = {
          username: fieldStr(draft.fields, "username").trim(),
          password: fieldStr(draft.fields, "password"),
        };
      } else if (draft.type === "note") {
        fields = { body: fieldStr(draft.fields, "body") };
      }
      if (images.length > 0) fields = { ...fields, images };
      else {
        const { images: _drop, image: _drop2, ...rest } = fields as Record<string, unknown>;
        fields = rest;
      }
      const payload = {
        id: draft.id,
        type: draft.type,
        title: draft.title.trim(),
        fields,
        note: (draft.note ?? "").trim(),
        updatedAt: draft.updatedAt || 0,
      };
      const list = await invoke<VaultEntry[]>("vault_upsert", { entry: payload });
      const normalized = list.map(normalizeEntry);
      setEntries(normalized);
      typeCacheRef.current = {};
      setFormGen((g) => g + 1);
      setDraft(emptyDraft(tab === "all" ? "api" : tab));
      setScreen("list");
      showToast("已保存");
    } catch (e) {
      setError(String(e));
    }
  };

  const addImages = async () => {
    const current = getImages(draft.fields);
    if (current.length >= MAX_ENTRY_IMAGES) {
      showToast(`最多 ${MAX_ENTRY_IMAGES} 张图`);
      return;
    }
    try {
      const selected = await openDialog({
        multiple: true,
        title: "选择图片",
        filters: [
          {
            name: "图片",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "jfif"],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const room = MAX_ENTRY_IMAGES - current.length;
      const take = paths.slice(0, room);
      const added: string[] = [];
      for (const path of take) {
        if (typeof path !== "string" || !path) continue;
        const bytes = await readFile(path);
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          showToast(`图片过大已跳过（单张不超过约 2.5MB）`);
          continue;
        }
        added.push(await bytesToDataUrl(bytes, mimeFromPath(path)));
      }
      if (added.length === 0) return;
      setDraft((d) => ({
        ...d,
        fields: {
          ...d.fields,
          images: [...getImages(d.fields), ...added],
        },
      }));
      showToast(`已添加 ${added.length} 张图`);
    } catch (e) {
      showToast(`添加图片失败：${e}`);
    }
  };

  const removeImageAt = (index: number) => {
    setDraft((d) => {
      const images = getImages(d.fields).filter((_, i) => i !== index);
      const next = { ...d.fields };
      if (images.length > 0) next.images = images;
      else delete next.images;
      return { ...d, fields: next };
    });
  };

  const deleteEntryById = async (id: string) => {
    if (!id) return;
    if (!window.confirm("确定删除这条记录？删除后无法恢复。")) return;
    try {
      const list = await invoke<VaultEntry[]>("vault_delete", { id });
      setEntries(list.map(normalizeEntry));
      setScreen("list");
      showToast("已删除");
    } catch (e) {
      setError(String(e));
    }
  };

  const onDeleteEntry = async () => {
    if (!draft.id) {
      setScreen("list");
      return;
    }
    await deleteEntryById(draft.id);
  };

  const entryMenu = (e: VaultEntry): CtxItem[] => [
    { id: "edit", label: "编辑", onClick: () => openEdit(e) },
    { id: "copy", label: "复制", onClick: () => void copyEntry(e) },
    { id: "sep", separator: true },
    {
      id: "delete",
      label: "删除",
      danger: true,
      onClick: () => void deleteEntryById(e.id),
    },
  ];

  const listBgMenu = (): CtxItem[] => [
    { id: "new", label: "新建条目", onClick: openNew },
    { id: "sep1", separator: true },
    { id: "lock", label: "立即上锁", onClick: () => void onLock() },
    {
      id: "gallery",
      label: "返回图库",
      onClick: () => {
        void onLock();
        onBackToGallery();
      },
    },
  ];

  const onDestroyedBack = async () => {
    try {
      await invoke("vault_clear_destroyed");
    } catch {
      /* ignore */
    }
    setScreen("setup");
    setStatus({ state: "none", hint1: "", hint2: "", failCount: 0, entryCount: 0 });
  };

  /** 嵌入顶栏：锁图标已标「密码箱」，这里只补场景，避免「密码箱·列表」叠字 */
  const chromeTitle =
    screen === "setup"
      ? t("createPassbox")
      : screen === "edit"
        ? draft.id
          ? t("editEntry")
          : t("newEntry")
        : screen === "unlock"
          ? t("unlock")
          : screen === "destroyed"
            ? t("destroyed")
            : screen === "list"
              ? boxView === "grid"
                ? t("grid")
                : locale === "en"
                  ? "List"
                  : "列表"
              : undefined;

  const chromeMeta =
    screen === "list" ? `${entries.length} ${t("notesCount")}` : undefined;

  const tools: ReactNode = (
    <>
      {screen === "list" && (
        <>
          <button type="button" className="icon-btn" title={t("newEntry")} onClick={openNew}>
            <Plus size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
          </button>
          <button type="button" className="icon-btn" title={t("lockNow")} onClick={() => void onLock()}>
            <Lock size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
          </button>
          <button
            type="button"
            className={boxView === "list" ? "icon-btn on" : "icon-btn"}
            title={t("listView")}
            onClick={() => setBoxView("list")}
          >
            <List size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
          </button>
          <button
            type="button"
            className={boxView === "grid" ? "icon-btn on" : "icon-btn"}
            title={t("gridView")}
            onClick={() => setBoxView("grid")}
          >
            <LayoutGrid size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
          </button>
        </>
      )}
      {screen === "edit" && (
        <>
          <button
            type="button"
            className="icon-btn"
            title={t("backList")}
            onClick={() => {
              setError(null);
              setScreen("list");
            }}
          >
            <ArrowLeft size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
          </button>
          {draft.id ? (
            <button
              type="button"
              className="icon-btn danger"
              title={t("delete")}
              onClick={() => void onDeleteEntry()}
            >
              <Trash2 size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
            </button>
          ) : null}
        </>
      )}
    </>
  );

  // 嵌入：场景 + 工具并入 App 唯一顶栏（无第二层黑条）
  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    if (screen === "boot") {
      onChromeChange(null);
      return;
    }
    onChromeChange({
      title: chromeTitle,
      meta: chromeMeta,
      tools,
    });
    // tools 随 screen / boxView / draft / tab 变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, onChromeChange, screen, boxView, tab, entries.length, draft.id, chromeTitle, chromeMeta, locale]);

  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    return () => onChromeChange(null);
  }, [embedded, onChromeChange]);

  if (screen === "boot") {
    return (
      <div className="passbox-embedded">
        <div className="empty">
          <p className="muted">{t("booting")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="passbox-embedded">
      {error && screen !== "unlock" && <div className="banner error">{error}</div>}

      {screen === "setup" && (
        <main className="passbox-center">
          <h1 className="passbox-h1">{t("createPassbox")}</h1>
          <p className="passbox-sub">{t("createHint")}</p>
          <div className="passbox-form">
            <label className="field">
              <span>主密码</span>
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="new-password"
                placeholder="至少 4 位"
              />
            </label>
            <label className="field">
              <span>确认主密码</span>
              <input
                type="password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label className="field">
              <span>提示 1（可选，不能用来重置密码）</span>
              <input type="text" value={hint1} onChange={(e) => setHint1(e.target.value)} placeholder="例如：我的第一个宠物" />
            </label>
            <label className="field">
              <span>提示 2（可选）</span>
              <input type="text" value={hint2} onChange={(e) => setHint2(e.target.value)} placeholder="例如：小学班主任姓氏" />
            </label>
          </div>
          <p className="passbox-warn">连续输错 50 次密码 → 箱内全部内容自动永久销毁</p>
          <button type="button" className="passbox-primary" onClick={() => void onSetup()}>
            {t("createAndLock")}
          </button>
        </main>
      )}

      {screen === "unlock" && (
        <main className="passbox-center passbox-unlock">
          <Lock size={32} strokeWidth={1.5} color="#666" absoluteStrokeWidth />
          <h1 className="passbox-h1">{t("unlockTitle")}</h1>
          <div className="passbox-form passbox-unlock-form">
            <label className="field">
              <span className="sr-only">密码</span>
              <input
                type="password"
                value={unlockPw}
                onChange={(e) => setUnlockPw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onUnlock();
                }}
                autoComplete="current-password"
                placeholder="主密码"
                autoFocus
              />
            </label>
            <button type="button" className="passbox-primary" onClick={() => void onUnlock()}>
              {t("unlock")}
            </button>
            {(status?.hint1 || status?.hint2) && (
              <div className="passbox-forgot-row">
                <button
                  type="button"
                  className="passbox-forgot"
                  onClick={() => setShowHints((v) => !v)}
                >
                  {showHints ? t("hideHints") : t("forgotPw")}
                </button>
              </div>
            )}
            {showHints && (
              <div className="passbox-hints">
                {status?.hint1 ? (
                  <p className="passbox-hint">
                    {t("hintLabel1")}
                    {status.hint1}
                  </p>
                ) : null}
                {status?.hint2 ? (
                  <p className="passbox-hint">
                    {t("hintLabel2")}
                    {status.hint2}
                  </p>
                ) : null}
                <p className="passbox-hint-note">{t("hintOnly")}</p>
              </div>
            )}
            {error ? <p className="passbox-warn">{error}</p> : null}
          </div>
        </main>
      )}

      {screen === "destroyed" && (
        <main className="passbox-center">
          <Skull size={40} strokeWidth={1.5} color="#6B4040" absoluteStrokeWidth />
          <h1 className="passbox-h1 danger">{t("destroyed")}</h1>
          <p className="passbox-sub">{t("destroyedSub")}</p>
          <button type="button" className="passbox-primary" onClick={() => void onDestroyedBack()}>
            {t("recreate")}
          </button>
          <button type="button" className="passbox-link" onClick={onBackToGallery}>
            {t("backGallery")}
          </button>
        </main>
      )}

      {screen === "list" && (
        <main
          className="content passbox-list"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest(".passbox-row, .passbox-card")) return;
            openCtxMenu(e, listBgMenu(), setCtxMenu);
          }}
        >
          <div className="passbox-tabs">
            <button
              type="button"
              className={tab === "all" ? "passbox-tab on" : "passbox-tab"}
              onClick={() => setTab("all")}
            >
              {t("all")}
            </button>
            {ALL_TYPES.map((k) => (
              <button
                key={k}
                type="button"
                className={tab === k ? "passbox-tab on" : "passbox-tab"}
                onClick={() => setTab(k)}
              >
                {labels[k]}
              </button>
            ))}
          </div>

          {filtered.length === 0 && (
            <div className="empty compact">
              <p>{t("noEntries")}</p>
              <p className="muted">{t("noEntriesHint")}</p>
            </div>
          )}

          {boxView === "list" && filtered.length > 0 && (
            <div className="passbox-rows">
              {filtered.map((e) => (
                <div
                  key={e.id}
                  className="passbox-row"
                  onContextMenu={(ev) => openCtxMenu(ev, entryMenu(e), setCtxMenu)}
                >
                  <button type="button" className="passbox-row-main" onClick={() => openEdit(e)}>
                    <span className="passbox-row-ico">
                      <TypeIcon type={e.type} />
                    </span>
                    <span className="passbox-row-text">
                      <span className="passbox-row-title">{e.title}</span>
                      <span className="passbox-row-meta">{listMeta(e).replace(TYPE_LABEL[e.type], labels[e.type])}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn passbox-copy"
                    title="复制"
                    onClick={() => void copyEntry(e)}
                  >
                    <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                </div>
              ))}
            </div>
          )}

          {boxView === "grid" && filtered.length > 0 && (
            <div className="passbox-grid">
              {filtered.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="passbox-card"
                  onClick={() => openEdit(e)}
                  onContextMenu={(ev) => openCtxMenu(ev, entryMenu(e), setCtxMenu)}
                >
                  <div className="passbox-card-top">
                    <span className="passbox-card-title">{e.title}</span>
                    <span
                      className="passbox-card-copy"
                      role="button"
                      tabIndex={0}
                      title="复制"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void copyEntry(e);
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") {
                          ev.stopPropagation();
                          void copyEntry(e);
                        }
                      }}
                    >
                      <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    </span>
                  </div>
                  <span className="passbox-card-type">{labels[e.type]}</span>
                  {e.type === "api" ? (
                    <div className="passbox-card-lines">
                      <span>URL  {fieldStr(e.fields, "url") || "—"}</span>
                      {getApiKeys(e.fields)
                        .filter((k) => k.trim())
                        .map((k, i, arr) => (
                          <span key={i}>
                            {arr.length > 1 ? `KEY ${i + 1}` : "KEY"}  {maskSecret(k)}
                          </span>
                        ))}
                      {getApiKeys(e.fields).every((k) => !k.trim()) && <span>KEY  —</span>}
                    </div>
                  ) : (
                    <span className="passbox-card-preview">{previewLine(e)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </main>
      )}

      {screen === "edit" && (
        <main className="content passbox-edit">
          <div className="passbox-tabs">
            {ALL_TYPES.map((k) => (
              <button
                key={k}
                type="button"
                className={draft.type === k ? "passbox-tab on" : "passbox-tab"}
                onClick={() => switchEditType(k)}
              >
                {labels[k]}
              </button>
            ))}
          </div>

          <div className="passbox-edit-form" key={`${formGen}-${draft.id || "new"}-${draft.type}`}>
            <label className="field">
              <span>{t("name")}</span>
              <div className="field-row">
                <input
                  type="text"
                  name={`vault-title-${formGen}-${draft.type}`}
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  placeholder="名称"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button type="button" className="icon-btn" title="复制" onClick={() => void copyText(draft.title)}>
                  <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
              </div>
            </label>

            {draft.type === "api" && (
              <>
                <label className="field">
                  <span>URL</span>
                  <div className="field-row">
                    <input
                      type="text"
                      value={fieldStr(draft.fields, "url")}
                      onChange={(e) => setField("url", e.target.value)}
                      placeholder="https://api.example.com/v1"
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制 URL"
                      onClick={() => void copyText(fieldStr(draft.fields, "url"), "已复制 URL")}
                    >
                      <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                  </div>
                </label>
                {getApiKeys(draft.fields).map((k, i, arr) => (
                  <label className="field" key={i}>
                    <span>{arr.length > 1 ? `KEY ${i + 1}` : "KEY"}</span>
                    <div className="field-row">
                      <input
                        type="text"
                        value={k}
                        onChange={(e) => setApiKeyAt(i, e.target.value)}
                        placeholder="sk-…"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title="复制 KEY"
                        onClick={() => void copyText(k, "已复制 KEY")}
                      >
                        <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                      </button>
                      {arr.length > 1 && (
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="删除此 KEY"
                          onClick={() => removeApiKey(i)}
                        >
                          <Trash2 size={14} strokeWidth={1.75} absoluteStrokeWidth />
                        </button>
                      )}
                    </div>
                  </label>
                ))}
                <button type="button" className="passbox-add-key" onClick={addApiKey}>
                  <Plus size={14} strokeWidth={1.75} absoluteStrokeWidth />
                  添加 KEY
                </button>
              </>
            )}

            {draft.type === "bank" && (
              <label className="field">
                <span>卡号</span>
                <div className="field-row">
                  <input
                    type="text"
                    value={fieldStr(draft.fields, "cardNumber")}
                    onChange={(e) => setField("cardNumber", e.target.value)}
                    placeholder="银行卡号"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    title="复制"
                    onClick={() => void copyText(fieldStr(draft.fields, "cardNumber"))}
                  >
                    <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                  </button>
                </div>
              </label>
            )}

            {isAccountLike(draft.type) && (
              <>
                <label className="field">
                  <span>{draft.type === "apple" ? "Apple ID" : "账号"}</span>
                  <div className="field-row">
                    <input
                      type="text"
                      name={`vault-${draft.type}-user`}
                      value={fieldStr(draft.fields, "username")}
                      onChange={(e) => setField("username", e.target.value)}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={
                        draft.type === "apple"
                          ? "email@icloud.com"
                          : draft.type === "google"
                            ? "email@gmail.com"
                            : "账号 / 手机号 / 邮箱"
                      }
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制"
                      onClick={() => void copyText(fieldStr(draft.fields, "username"))}
                    >
                      <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>密码</span>
                  <div className="field-row">
                    <input
                      type="text"
                      name={`vault-${draft.type}-pass`}
                      value={fieldStr(draft.fields, "password")}
                      onChange={(e) => setField("password", e.target.value)}
                      autoComplete="new-password"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="密码"
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制"
                      onClick={() => void copyText(fieldStr(draft.fields, "password"))}
                    >
                      <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                  </div>
                </label>
              </>
            )}

            {draft.type === "note" && (
              <label className="field">
                <span>内容</span>
                <textarea
                  value={fieldStr(draft.fields, "body")}
                  onChange={(e) => setField("body", e.target.value)}
                  rows={6}
                  placeholder="自由文本"
                />
              </label>
            )}

            <label className="field">
              <span>备注</span>
              <div className="field-row">
                <input
                  type="text"
                  name={`vault-note-${formGen}-${draft.type}`}
                  value={draft.note}
                  onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                  placeholder="可选"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button type="button" className="icon-btn" title="复制" onClick={() => void copyText(draft.note)}>
                  <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                </button>
              </div>
            </label>

            <div className="field passbox-images-field">
              <span>图片</span>
              <div className="passbox-images">
                {getImages(draft.fields).map((src, i) => (
                  <div key={i} className="passbox-img-item">
                    <img src={src} alt="" draggable={false} />
                    <button
                      type="button"
                      className="passbox-img-remove"
                      title="删除图片"
                      onClick={() => removeImageAt(i)}
                    >
                      <X size={12} strokeWidth={2} absoluteStrokeWidth />
                    </button>
                  </div>
                ))}
                {getImages(draft.fields).length < MAX_ENTRY_IMAGES && (
                  <button
                    type="button"
                    className="passbox-img-add"
                    title="添加图片"
                    onClick={() => void addImages()}
                  >
                    <ImagePlus size={20} strokeWidth={1.75} absoluteStrokeWidth />
                    <span>添加图片</span>
                  </button>
                )}
              </div>
            </div>

            <p className="passbox-note-foot">{t("localOnly")}</p>
            <button type="button" className="passbox-primary" onClick={() => void onSave()}>
              {t("save")}
            </button>
          </div>
        </main>
      )}

      {toast && <div className="toast">{toast}</div>}
      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
}
