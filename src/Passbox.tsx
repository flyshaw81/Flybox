import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
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
  Mail,
  User,
  X,
} from "lucide-react";
import ContextMenu, { openCtxMenu, type CtxItem, type CtxMenuState } from "./ContextMenu";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";
import logoDark from "./assets/flyshaw-logo-white-transparent.png";
import logoLight from "./assets/flyshaw-logo-transparent.png";

type ModuleChrome = {
  title?: string;
  meta?: string;
  tools?: ReactNode;
};

const ICO = 16;

/** 账号类：用户名 + 密码 */
export type AccountLikeType =
  | "account"
  | "game"
  | "douyin"
  | "x"
  | "google"
  | "apple"
  | "email";
export type EntryType = "api" | "bank" | AccountLikeType | "note";

export type VaultEntry = {
  id: string;
  type: EntryType;
  title: string;
  /** String values；API：`urls` / `keys` 可为 string[]。 */
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
  /** 冷却截止 Unix 毫秒；0 表示可试 */
  lockUntilMs?: number;
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
  email: "邮箱",
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
  "email",
  "note",
];

function isAccountLike(t: EntryType): t is AccountLikeType {
  return (
    t === "account" ||
    t === "game" ||
    t === "douyin" ||
    t === "x" ||
    t === "google" ||
    t === "apple" ||
    t === "email"
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
    base = { urls: getApiUrls(f), keys: getApiKeys(f) };
  } else if (type === "bank") {
    base = {
      holderName: fieldStr(f, "holderName"),
      cardNumber: fieldStr(f, "cardNumber"),
      bankName: fieldStr(f, "bankName"),
    };
  } else if (type === "douyin") {
    base = {
      username: fieldStr(f, "username"),
      douyinId: fieldStr(f, "douyinId"),
      phone: fieldStr(f, "phone"),
      password: fieldStr(f, "password"),
    };
  } else if (type === "apple") {
    base = {
      username: fieldStr(f, "username"),
      password: fieldStr(f, "password"),
      region: fieldStr(f, "region"),
    };
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
  if (type === "api") return { urls: [""], keys: [""] };
  if (type === "bank") return { holderName: "", cardNumber: "", bankName: "" };
  if (type === "douyin") return { username: "", douyinId: "", phone: "", password: "" };
  if (type === "apple") return { username: "", password: "", region: "" };
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

/** 读 string[] 字段；兼容旧单字符串 / JSON 数组字符串。 */
function getStringList(
  fields: Record<string, unknown> | undefined,
  multiKey: string,
  singleKey: string,
): string[] {
  if (!fields) return [""];
  const multi = fields[multiKey];
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
  if (typeof multi === "string" && multi.trim()) return [multi];
  const single = fieldStr(fields, singleKey);
  if (single) return [single];
  return [""];
}

/** API 可多 KEY；兼容旧数据 fields.key 单字符串。 */
function getApiKeys(fields: Record<string, unknown> | undefined): string[] {
  return getStringList(fields, "keys", "key");
}

/** API 可多 URL；兼容旧数据 fields.url 单字符串。 */
function getApiUrls(fields: Record<string, unknown> | undefined): string[] {
  return getStringList(fields, "urls", "url");
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

/** 列表/卡片摘要：只显示掩码，不露明文 */
function previewLine(e: VaultEntry): string {
  if (e.type === "api") {
    const urls = getApiUrls(e.fields).filter((u) => u.trim());
    const keys = getApiKeys(e.fields).filter((k) => k.trim());
    const urlPart =
      urls.length > 1 ? `${urls.length} 个 URL` : urls.length === 1 ? "URL" : "";
    const keyPart =
      keys.length > 1 ? `${keys.length} 个 KEY` : keys.length === 1 ? "KEY" : "";
    if (urlPart && keyPart) return `${urlPart} + ${keyPart}`;
    if (urlPart) return `${urlPart} · ••••••••`;
    if (keyPart) return keyPart === "KEY" ? "••••••••" : keyPart;
    return "API 密钥";
  }
  if (e.type === "bank") {
    const has =
      fieldStr(e.fields, "holderName") ||
      fieldStr(e.fields, "cardNumber") ||
      fieldStr(e.fields, "bankName");
    return has ? "••••••••" : "银行卡";
  }
  if (e.type === "douyin") {
    const has =
      fieldStr(e.fields, "username") ||
      fieldStr(e.fields, "douyinId") ||
      fieldStr(e.fields, "phone") ||
      fieldStr(e.fields, "password");
    return has ? "••••••••" : TYPE_LABEL.douyin;
  }
  if (isAccountLike(e.type)) {
    const has = fieldStr(e.fields, "username") || fieldStr(e.fields, "password");
    return has ? "••••••••" : TYPE_LABEL[e.type];
  }
  if (e.type === "note") {
    const body = fieldStr(e.fields, "body");
    return body ? "••••••••" : "自由文本";
  }
  return "";
}

function listMeta(e: VaultEntry): string {
  return `${TYPE_LABEL[e.type] ?? ""} · ${previewLine(e)}`;
}

function TypeIcon({ type }: { type: EntryType }) {
  const p = { size: ICO, strokeWidth: 1.75 as const, absoluteStrokeWidth: true };
  if (type === "api") return <Key {...p} />;
  if (type === "bank") return <CreditCard {...p} />;
  if (type === "game") return <Gamepad2 {...p} />;
  if (type === "douyin" || type === "x") return <AtSign {...p} />;
  if (type === "email") return <Mail {...p} />;
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
  const { theme } = useTheme();
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
            email: "type_email",
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
  const [nowTick, setNowTick] = useState(() => Date.now());

  // list
  const [tab, setTab] = useState<TabFilter>("all");
  /** 顶栏 tools 闭包易过期：新建永远读最新分类 */
  const tabRef = useRef<TabFilter>("all");
  const [boxView, setBoxView] = useState<BoxView>("list");
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // 冷却倒计时：解锁页且仍在锁定中时每秒刷新
  useEffect(() => {
    if (screen !== "unlock") return;
    const until = status?.lockUntilMs ?? 0;
    if (until <= Date.now()) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [screen, status?.lockUntilMs]);

  // edit
  const [draft, setDraft] = useState<VaultEntry>(emptyDraft());

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

  // 会话策略：本次启动解锁后，切模块也不上锁；关软件才清会话。手动「立即上锁」仍可用。

  const filtered = useMemo(() => {
    if (tab === "all") return entries;
    return entries.filter((e) => e.type === tab);
  }, [entries, tab]);

  const copyText = async (text: string) => {
    if (!text) {
      return;
    }
    try {
      await writeText(text);
    } catch (e1) {
      // 插件失败时退回浏览器剪贴板
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
      } catch {
        /* fall through */
      }
    }
  };

  /** 列表/卡片上的复制：整条内容一起拷，方便粘贴 */
  const formatEntryAll = (e: VaultEntry): string => {
    const lines: string[] = [];
    const push = (label: string, value: string) => {
      const v = value.trim();
      if (v) lines.push(`${label}：${v}`);
    };
    if (e.title.trim()) push("名称", e.title);
    if (e.type === "api") {
      const urls = getApiUrls(e.fields).filter((u) => u.trim());
      const keys = getApiKeys(e.fields).filter((k) => k.trim());
      urls.forEach((u, i) => push(urls.length > 1 ? `URL ${i + 1}` : "URL", u));
      keys.forEach((k, i) => push(keys.length > 1 ? `KEY ${i + 1}` : "KEY", k));
    } else if (e.type === "bank") {
      push("开户名", fieldStr(e.fields, "holderName"));
      push("卡号", fieldStr(e.fields, "cardNumber"));
      push("银行", fieldStr(e.fields, "bankName"));
    } else if (e.type === "douyin") {
      push("用户名", fieldStr(e.fields, "username"));
      push("抖音号", fieldStr(e.fields, "douyinId"));
      push("手机号", fieldStr(e.fields, "phone"));
      push("密码", fieldStr(e.fields, "password"));
    } else if (e.type === "apple") {
      push("Apple ID", fieldStr(e.fields, "username"));
      push("密码", fieldStr(e.fields, "password"));
      push("地区", fieldStr(e.fields, "region"));
    } else if (e.type === "email") {
      push("邮箱", fieldStr(e.fields, "username"));
      push("密码", fieldStr(e.fields, "password"));
    } else if (isAccountLike(e.type)) {
      push("账号", fieldStr(e.fields, "username"));
      push("密码", fieldStr(e.fields, "password"));
    } else if (e.type === "note") {
      push("内容", fieldStr(e.fields, "body"));
    }
    if ((e.note ?? "").trim()) push("备注", e.note);
    return lines.join("\n");
  };

  const copyEntry = async (e: VaultEntry) => {
    await copyText(formatEntryAll(e));
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

  const setApiUrlAt = (index: number, value: string) => {
    setDraft((d) => {
      const urls = [...getApiUrls(d.fields)];
      urls[index] = value;
      return { ...d, fields: { ...d.fields, urls } };
    });
  };

  const addApiUrl = () => {
    setDraft((d) => {
      const urls = [...getApiUrls(d.fields), ""];
      return { ...d, fields: { ...d.fields, urls } };
    });
  };

  const removeApiUrl = (index: number) => {
    setDraft((d) => {
      const urls = getApiUrls(d.fields).filter((_, i) => i !== index);
      return { ...d, fields: { ...d.fields, urls: urls.length > 0 ? urls : [""] } };
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
        const urls = getApiUrls(draft.fields)
          .map((u) => u.trim())
          .filter(Boolean);
        fields = { urls, keys };
      } else if (draft.type === "bank") {
        fields = {
          holderName: fieldStr(draft.fields, "holderName").trim(),
          cardNumber: fieldStr(draft.fields, "cardNumber").trim(),
          bankName: fieldStr(draft.fields, "bankName").trim(),
        };
      } else if (draft.type === "douyin") {
        fields = {
          username: fieldStr(draft.fields, "username").trim(),
          douyinId: fieldStr(draft.fields, "douyinId").trim(),
          phone: fieldStr(draft.fields, "phone").trim(),
          password: fieldStr(draft.fields, "password"),
        };
      } else if (draft.type === "apple") {
        fields = {
          username: fieldStr(draft.fields, "username").trim(),
          password: fieldStr(draft.fields, "password"),
          region: fieldStr(draft.fields, "region").trim(),
        };
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
      // 部分分类不填「名称」：用账号字段当列表标题
      const title =
        draft.type === "douyin"
          ? fieldStr(fields, "username") ||
            fieldStr(fields, "douyinId") ||
            fieldStr(fields, "phone") ||
            "抖音账号"
          : draft.type === "apple"
            ? fieldStr(fields, "username") ||
              fieldStr(fields, "region") ||
              "Apple ID"
            : draft.type === "google"
              ? fieldStr(fields, "username") || "谷歌账号"
              : draft.type === "bank"
                ? fieldStr(fields, "holderName") ||
                  fieldStr(fields, "bankName") ||
                  "银行卡"
                : draft.title.trim();
      const payload = {
        id: draft.id,
        type: draft.type,
        title,
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
    } catch (e) {
      setError(String(e));
    }
  };

  const addImages = async () => {
    const current = getImages(draft.fields);
    if (current.length >= MAX_ENTRY_IMAGES) {
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
    } catch (e) {
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
    const ok = await ask("确定删除这条记录？删除后无法恢复。", {
      title: "删除",
      kind: "warning",
    });
    if (!ok) return;
    try {
      const list = await invoke<VaultEntry[]>("vault_delete", { id });
      setEntries(list.map(normalizeEntry));
      setScreen("list");
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
      // 只切模块，不锁箱：本会话解锁一次即可
      onClick: () => onBackToGallery(),
    },
  ];

  const onDestroyedBack = async () => {
    try {
      await invoke("vault_clear_destroyed");
    } catch {
      /* ignore */
    }
    setScreen("setup");
    setStatus({
      state: "none",
      hint1: "",
      hint2: "",
      failCount: 0,
      entryCount: 0,
      lockUntilMs: 0,
    });
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
          <button type="button" className="icon-btn" title={t("newEntry")} onClick={openNew}>
            <Plus size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
          </button>
          {draft.id ? (
            <button
              type="button"
              className="icon-btn"
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
          <p className="passbox-warn">{t("wipeRule")}</p>
          <button type="button" className="passbox-primary" onClick={() => void onSetup()}>
            {t("createAndLock")}
          </button>
        </main>
      )}

      {screen === "unlock" && (
        <main className="passbox-center passbox-unlock">
          <div className="passbox-unlock-brand" aria-label={t("unlockTitle")}>
            <img
              className="passbox-unlock-logo"
              src={theme === "light" ? logoLight : logoDark}
              alt=""
              draggable={false}
            />
            <span className="passbox-unlock-name">{t("appName")}</span>
          </div>
          <div className="passbox-form passbox-unlock-form">
            {(() => {
              const until = status?.lockUntilMs ?? 0;
              const remMs = Math.max(0, until - nowTick);
              if (remMs <= 0) return null;
              const remSec = Math.ceil(remMs / 1000);
              const h = Math.floor(remSec / 3600);
              const m = Math.floor((remSec % 3600) / 60);
              const s = remSec % 60;
              const clock =
                h > 0
                  ? `${h} 小时 ${m} 分 ${s} 秒`
                  : m > 0
                    ? `${m} 分 ${s} 秒`
                    : `${s} 秒`;
              return (
                <p className="passbox-warn">
                  已锁定，请 {clock} 后再试
                  {status?.failCount ? ` · 累计错误 ${status.failCount} / 45` : ""}
                </p>
              );
            })()}
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
                disabled={(status?.lockUntilMs ?? 0) > nowTick}
              />
            </label>
            <button
              type="button"
              className="passbox-primary"
              onClick={() => void onUnlock()}
              disabled={(status?.lockUntilMs ?? 0) > nowTick}
            >
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
                      {getApiUrls(e.fields)
                        .filter((u) => u.trim())
                        .map((_u, i, arr) => (
                          <span key={`u${i}`}>
                            {arr.length > 1 ? `URL ${i + 1}` : "URL"}  ••••••••
                          </span>
                        ))}
                      {getApiUrls(e.fields).every((u) => !u.trim()) && <span>URL  —</span>}
                      {getApiKeys(e.fields)
                        .filter((key) => key.trim())
                        .map((_key, i, arr) => (
                          <span key={`k${i}`}>
                            {arr.length > 1 ? `KEY ${i + 1}` : "KEY"}  ••••••••
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
            {draft.type !== "douyin" &&
              draft.type !== "apple" &&
              draft.type !== "google" &&
              draft.type !== "bank" && (
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
            )}

            {draft.type === "api" && (
              <>
                {getApiUrls(draft.fields).map((u, i, arr) => (
                  <label className="field" key={`url-${i}`}>
                    <span>{arr.length > 1 ? `URL ${i + 1}` : "URL"}</span>
                    <div className="field-row">
                      <input
                        type="text"
                        value={u}
                        onChange={(e) => setApiUrlAt(i, e.target.value)}
                        placeholder="https://api.example.com/v1"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title="复制 URL"
                        onClick={() => void copyText(u)}
                      >
                        <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                      </button>
                      {arr.length > 1 && (
                        <button
                          type="button"
                          className="icon-btn"
                          title="删除此 URL"
                          onClick={() => removeApiUrl(i)}
                        >
                          <Trash2 size={14} strokeWidth={1.75} absoluteStrokeWidth />
                        </button>
                      )}
                    </div>
                  </label>
                ))}
                <button type="button" className="passbox-add-key" onClick={addApiUrl}>
                  <Plus size={14} strokeWidth={1.75} absoluteStrokeWidth />
                  添加 URL
                </button>
                {getApiKeys(draft.fields).map((k, i, arr) => (
                  <label className="field" key={`key-${i}`}>
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
                        onClick={() => void copyText(k)}
                      >
                        <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                      </button>
                      {arr.length > 1 && (
                        <button
                          type="button"
                          className="icon-btn"
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
              <>
                <label className="field">
                  <span>开户名</span>
                  <div className="field-row">
                    <input
                      type="text"
                      name="vault-bank-holder"
                      value={fieldStr(draft.fields, "holderName")}
                      onChange={(e) => setField("holderName", e.target.value)}
                      placeholder="持卡人姓名"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制"
                      onClick={() => void copyText(fieldStr(draft.fields, "holderName"))}
                    >
                      <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>卡号</span>
                  <div className="field-row">
                    <input
                      type="text"
                      name="vault-bank-card"
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
                <label className="field">
                  <span>银行</span>
                  <div className="field-row">
                    <input
                      type="text"
                      name="vault-bank-name"
                      value={fieldStr(draft.fields, "bankName")}
                      onChange={(e) => setField("bankName", e.target.value)}
                      placeholder="如 招商银行、工商银行"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制"
                      onClick={() => void copyText(fieldStr(draft.fields, "bankName"))}
                    >
                      <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                  </div>
                </label>
              </>
            )}

            {draft.type === "douyin" && (
              <>
                <label className="field">
                  <span>用户名</span>
                  <div className="field-row">
                    <input
                      type="text"
                      name="vault-douyin-user"
                      value={fieldStr(draft.fields, "username")}
                      onChange={(e) => setField("username", e.target.value)}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="用户名 / 昵称"
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
                  <span>抖音号</span>
                  <div className="field-row">
                    <input
                      type="text"
                      name="vault-douyin-id"
                      value={fieldStr(draft.fields, "douyinId")}
                      onChange={(e) => setField("douyinId", e.target.value)}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="抖音号"
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制"
                      onClick={() => void copyText(fieldStr(draft.fields, "douyinId"))}
                    >
                      <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>手机号</span>
                  <div className="field-row">
                    <input
                      type="text"
                      name="vault-douyin-phone"
                      value={fieldStr(draft.fields, "phone")}
                      onChange={(e) => setField("phone", e.target.value)}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="手机号"
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制"
                      onClick={() => void copyText(fieldStr(draft.fields, "phone"))}
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
                      name="vault-douyin-pass"
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

            {isAccountLike(draft.type) && draft.type !== "douyin" && (
              <>
                <label className="field">
                  <span>
                    {draft.type === "apple"
                      ? "Apple ID"
                      : draft.type === "email"
                        ? "邮箱"
                        : "账号"}
                  </span>
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
                            : draft.type === "email"
                              ? "name@example.com"
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
                {draft.type === "apple" && (
                  <label className="field">
                    <span>地区</span>
                    <div className="field-row">
                      <input
                        type="text"
                        name="vault-apple-region"
                        value={fieldStr(draft.fields, "region")}
                        onChange={(e) => setField("region", e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="国家 / 地区，如 中国、美国、日本"
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title="复制"
                        onClick={() => void copyText(fieldStr(draft.fields, "region"))}
                      >
                        <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth />
                      </button>
                    </div>
                  </label>
                )}
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

      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
}
