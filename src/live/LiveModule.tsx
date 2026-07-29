import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AppWindow, LogIn, RefreshCw } from "lucide-react";
import { useI18n } from "../i18n";
import type { ModuleChrome } from "../App";
import LiveBoard from "./LiveBoard";
import LiveOverview from "./LiveOverview";
import LiveSpeederLoader from "./LiveSpeederLoader";
import SessionDetail from "./SessionDetail";
import { classifyLiveUrl, SCRAPE_SCRIPT } from "./scraper";
import {
  createSession,
  finalizeSession,
  loadLiveStore,
  recomputeSessionStats,
  saveLiveStore,
  upsertSession,
} from "./liveStore";
import {
  mergeDeepSessions,
  mergeHistorySessions,
  mergePortraitSessions,
  type DeepSyncResult,
  type HistorySyncResult,
  type PortraitSyncResult,
} from "./historySync";
import { buildSessionReportText } from "./insights";
import { closeLocalSessionWithHistory } from "./sessionMerge";
import type {
  LiveGoals,
  LiveProfile,
  LiveScrapeResult,
  LiveSession,
  LiveStoreData,
} from "./liveTypes";

const ICO = 16;

type Props = {
  embedded?: boolean;
  onChromeChange?: (chrome: ModuleChrome | null) => void;
};

type View = "overview" | "monitor" | "detail";
type Section = "analysis" | "live";

const SCRAPE_MS = 10_000;
/** 历史列表多久内算新鲜，进模块不再全量重拉 */
const HISTORY_FRESH_SEC = 30 * 60;

function num(v: number | null | undefined, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function minuteMatchesSession(s: LiveSession): boolean {
  const t0 = s.minuteTrend?.[0]?.t;
  if (!t0) return false;
  const d = new Date(s.startTime * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  // 分钟曲线首点应落在开播同一小时内（允许整分对齐）
  const prefix = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:`;
  return t0.startsWith(prefix);
}

/** 核心复盘已齐：不再自动重采（切片/维护属增强，不挡「已采过」） */
function hasCoreReview(s: LiveSession): boolean {
  return (
    !!s.audiencePortrait &&
    !!s.trafficChannels?.length &&
    !!s.minuteTrend?.length &&
    minuteMatchesSession(s)
  );
}

function needsReviewMetrics(s: LiveSession): boolean {
  return /^\d{10,}$/.test(s.id) && !hasCoreReview(s);
}

/** overview 深采缺口：只补缺，不重跑已有进房率/停留的场 */
function needsDeepMetrics(s: LiveSession): boolean {
  return (
    /^\d{10,}$/.test(s.id) &&
    s.avgWatchMins == null &&
    s.consumeRate == null &&
    s.enterRate == null &&
    s.watchUcnt == null
  );
}

function recentSessions(sessions: LiveSession[], n: number): LiveSession[] {
  return sessions.slice().sort((a, b) => b.startTime - a.startTime).slice(0, n);
}

export default function LiveModule({ embedded, onChromeChange }: Props) {
  const { t, locale } = useI18n();
  const [booting, setBooting] = useState(true);
  const [data, setData] = useState<LiveStoreData>({
    loggedIn: false,
    sessions: [],
    activeSessionId: null,
    goals: {
      dailyGifts: 3000,
      weeklyFollowers: 30,
      weeklyDurationSec: 20 * 3600,
    },
  });
  const [view, setView] = useState<View>("overview");
  const [section, setSection] = useState<Section>("analysis");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needRelogin, setNeedRelogin] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [historySyncing, setHistorySyncing] = useState(false);
  /** 扫码登录成功后，第一次抓历史/数据时的全屏飞车 loading */
  const [fetchAfterLogin, setFetchAfterLogin] = useState(false);
  const [postEndNotice, setPostEndNotice] = useState<string | null>(null);
  const [autoCopyReport, setAutoCopyReport] = useState(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  const scrapeLock = useRef(false);
  const historySyncLock = useRef(false);
  const autoSyncStarted = useRef(false);
  const portraitAttempts = useRef(0);
  const gapFillRunning = useRef(false);

  const persist = useCallback(async (next: LiveStoreData) => {
    setData(next);
    dataRef.current = next;
    await saveLiveStore(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadLiveStore();
        if (cancelled) return;
        // 先出本地缓存，再后台确认登录态（避免每次白屏久等）
        setData(loaded);
        dataRef.current = loaded;
        setBooting(false);
        try {
          const boot = await invoke<{
            loggedIn: boolean;
            url?: string | null;
          }>("live_bootstrap");
          if (cancelled) return;
          if (boot.loggedIn) {
            await persist({ ...dataRef.current, loggedIn: true });
            setNeedRelogin(false);
            setQrDataUrl(null);
          } else {
            setNeedRelogin(Boolean(loaded.loggedIn));
            if (dataRef.current.loggedIn) {
              await persist({ ...dataRef.current, loggedIn: false });
            }
          }
        } catch (e) {
          setError(String(e));
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setBooting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persist]);

  /** 后台藏着 WebView：抽二维码 + 轮询是否已扫码登录成功 */
  useEffect(() => {
    if (booting) return;
    if (data.loggedIn && !needRelogin) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const auth = await invoke<{
          loggedIn: boolean;
          needLogin: boolean;
          url?: string | null;
        }>("live_auth_status");
        if (cancelled) return;
        if (auth.loggedIn) {
          setNeedRelogin(false);
          setQrDataUrl(null);
          const cur = dataRef.current;
          if (!cur.loggedIn) {
            // 本地已有场次时不要挡整屏；只在第一次空库抓数时飞车
            if (cur.sessions.length === 0) setFetchAfterLogin(true);
            await persist({ ...cur, loggedIn: true });
          }
          try {
            await invoke("live_hide_window");
          } catch {
            /* ignore */
          }
          return;
        }
      } catch {
        /* ignore */
      }
      try {
        const q = await invoke<string | null>("live_fetch_login_qr");
        if (cancelled) return;
        // 无码时清空，避免把上次误抓的趋势图继续显示在二维码框里
        if (q && q.startsWith("data:image")) setQrDataUrl(q);
        else setQrDataUrl(null);
      } catch {
        /* 还在加载 */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 800);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [booting, data.loggedIn, needRelogin, persist]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void listen<{ url: string }>("live-nav", (ev) => {
      const cls = classifyLiveUrl(ev.payload?.url);
      if (cls.needLogin) {
        setNeedRelogin(true);
        return;
      }
      if (cls.loggedInHint) {
        setNeedRelogin(false);
        setQrDataUrl(null);
        const cur = dataRef.current;
        void (async () => {
          if (!cur.loggedIn) {
            if (cur.sessions.length === 0) setFetchAfterLogin(true);
            await persist({ ...cur, loggedIn: true });
          }
          try {
            await invoke("live_hide_window");
          } catch {
            /* ignore */
          }
        })();
      }
    }).then((fn) => {
      un = fn;
    });
    return () => {
      un?.();
    };
  }, [persist]);

  const activeSession = useMemo(() => {
    if (!data.activeSessionId) return null;
    return data.sessions.find((s) => s.id === data.activeSessionId) ?? null;
  }, [data.activeSessionId, data.sessions]);

  /** 下播：定稿 → 同步历史合并 → 复制小报 → 打开详情 */
  const closeSessionPipeline = useCallback(
    async (active: LiveSession) => {
      const done = finalizeSession(active);
      let cur = dataRef.current;
      let sessions = upsertSession(cur.sessions, done);
      await persist({ ...cur, loggedIn: true, sessions, activeSessionId: null });

      let openId = done.id;
      let noticeParts: string[] = [t("livePostEndSyncing")];
      setPostEndNotice(noticeParts.join(" · "));
      setSection("analysis");
      setView("detail");
      setDetailId(openId);

      try {
        if (!historySyncLock.current && dataRef.current.loggedIn && !needRelogin) {
          historySyncLock.current = true;
          setHistorySyncing(true);
          try {
            const raw = await invoke<HistorySyncResult>("live_sync_history");
            const remote = Array.isArray(raw?.sessions) ? raw.sessions : [];
            cur = dataRef.current;
            sessions = mergeHistorySessions(cur.sessions, remote);
            const closed = closeLocalSessionWithHistory(sessions, done);
            sessions = closed.sessions;
            openId = closed.detailId;
            await persist({
              ...cur,
              loggedIn: true,
              sessions,
              activeSessionId: null,
              lastHistorySyncAt: Math.floor(Date.now() / 1000),
            });
            setDetailId(openId);
            if (openId !== done.id) noticeParts = [t("livePostEndMerged")];
            // 画像/深采交给详情页缺口补采 effect，避免此处循环依赖
          } finally {
            historySyncLock.current = false;
            setHistorySyncing(false);
          }
        }
      } catch {
        /* 合并失败仍保留本场详情 */
      }

      try {
        const list = dataRef.current.sessions;
        const target = list.find((x) => x.id === openId) ?? done;
        const text = buildSessionReportText(target, list, t, locale);
        await writeText(text);
        noticeParts = noticeParts.filter((p) => p !== t("livePostEndSyncing"));
        noticeParts.push(t("livePostEndCopied"));
        setPostEndNotice(noticeParts.join(" · "));
        setAutoCopyReport(true);
      } catch {
        noticeParts = noticeParts.filter((p) => p !== t("livePostEndSyncing"));
        setPostEndNotice(noticeParts.join(" · ") || null);
      }
      window.setTimeout(() => setPostEndNotice(null), 6000);
    },
    [needRelogin, persist, t, locale],
  );

  const applyScrape = useCallback(
    async (raw: LiveScrapeResult) => {
      if (raw.needLogin) {
        // 再向 Rust 确认一次，避免页面文案误伤把已登录态踢成「登录已失效」
        try {
          const auth = await invoke<{ loggedIn: boolean }>("live_auth_status");
          if (auth.loggedIn) {
            setNeedRelogin(false);
          } else {
            setNeedRelogin(true);
            return;
          }
        } catch {
          setNeedRelogin(true);
          return;
        }
      }
      setNeedRelogin(false);
      const status = String(raw.liveStatus || "unknown");
      let cur = dataRef.current;
      let sessions = cur.sessions;
      let activeId = cur.activeSessionId;
      let active = activeId ? sessions.find((s) => s.id === activeId) ?? null : null;

      if (status === "live") {
        if (!active || active.endTime != null) {
          active = createSession(raw.title);
          activeId = active.id;
          sessions = upsertSession(sessions, active);
          setSection("live");
          setView("monitor");
        }
        const tSec = Math.max(0, Math.floor(Date.now() / 1000) - active.startTime);
        const lastPt = active.dataPoints[active.dataPoints.length - 1];
        const point = {
          t: tSec,
          viewers: num(raw.viewers, lastPt?.viewers ?? 0),
          likes: num(raw.likes, lastPt?.likes ?? 0),
          gifts: num(raw.gifts, lastPt?.gifts ?? 0),
          comments: num(raw.comments, lastPt?.comments ?? 0),
          giftSenders: num(raw.giftSenders, active.giftSenders),
          newFollowers: num(raw.newFollowers, active.newFollowers),
          newFansClub: num(raw.newFansClub, active.newFansClub),
          shares: num(raw.shares, active.totalShares),
          show: raw.show != null ? num(raw.show) : lastPt?.show,
          enter: raw.enter != null ? num(raw.enter) : lastPt?.enter,
          stay: raw.stay != null ? num(raw.stay) : lastPt?.stay,
        };
        let next: LiveSession = {
          ...active,
          title: (raw.title && raw.title.trim()) || active.title,
          dataPoints: [...active.dataPoints, point],
          showUcnt: raw.show != null ? num(raw.show) : active.showUcnt,
          enterUcnt: raw.enter != null ? num(raw.enter) : active.enterUcnt,
          enterRate: raw.enterRate != null ? num(raw.enterRate) : active.enterRate,
          stayRate: raw.stayRate != null ? num(raw.stayRate) : active.stayRate,
          giftRate: raw.giftRate != null ? num(raw.giftRate) : active.giftRate,
        };
        next = recomputeSessionStats(next);
        sessions = upsertSession(sessions, next);
        await persist({ ...cur, loggedIn: true, sessions, activeSessionId: activeId });
        setSection("live");
        setView("monitor");
        return;
      }

      if (status === "ended" && active && active.endTime == null) {
        await closeSessionPipeline(active);
      }
    },
    [closeSessionPipeline, persist],
  );

  const runDeepSync = useCallback(
    async (sessions: LiveSession[]) => {
      // 只采缺 overview 深字段的场次，最多 8 场
      const roomIds = recentSessions(sessions, 30)
        .filter(needsDeepMetrics)
        .slice(0, 8)
        .map((s) => s.id);
      if (!roomIds.length) return;
      try {
        const deep = await invoke<DeepSyncResult>("live_sync_deep", { roomIds });
        const deepRows = Array.isArray(deep?.sessions) ? deep.sessions : [];
        if (deepRows.length) {
          const cur = dataRef.current;
          const merged = mergeDeepSessions(cur.sessions, deepRows);
          await persist({ ...cur, loggedIn: true, sessions: merged });
        }
      } catch {
        /* 深采失败不阻断列表；history 字段已够用 */
      }
    },
    [persist],
  );

  const runPortraitSync = useCallback(
    async (sessions: LiveSession[]) => {
      const pad = (n: number) => String(n).padStart(2, "0");
      // 只采核心复盘仍缺的场；已齐的绝不重跑
      const rooms = recentSessions(sessions, 30)
        .filter(needsReviewMetrics)
        .slice(0, 6)
        .map((s) => {
          const d = new Date(s.startTime * 1000);
          const startHint = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          return { id: s.id, startHint };
        })
        .filter((r) => /^\d{10,}$/.test(r.id));
      if (!rooms.length) return;
      portraitAttempts.current += 1;
      try {
        const raw = await invoke<PortraitSyncResult>("live_sync_portrait", {
          rooms,
        });
        const rows = Array.isArray(raw?.sessions) ? raw.sessions : [];
        if (rows.length) {
          const cur = dataRef.current;
          const merged = mergePortraitSessions(cur.sessions, rows);
          await persist({ ...cur, loggedIn: true, sessions: merged });
        }
      } catch {
        /* 单轮失败可被后续缺口补采再试 */
      }
    },
    [persist],
  );

  /** 只补缺口：深采 + 复盘（不拉历史列表） */
  const fillGaps = useCallback(async () => {
    if (gapFillRunning.current || historySyncLock.current) return;
    if (!dataRef.current.loggedIn || needRelogin) return;
    const list = dataRef.current.sessions;
    const needDeep = recentSessions(list, 30).some(needsDeepMetrics);
    const needReview = recentSessions(list, 30).some(needsReviewMetrics);
    if (!needDeep && !needReview) return;
    gapFillRunning.current = true;
    try {
      if (needDeep) await runDeepSync(list);
      if (needReview && portraitAttempts.current < 3) {
        await runPortraitSync(dataRef.current.sessions);
      }
    } finally {
      gapFillRunning.current = false;
    }
  }, [needRelogin, runDeepSync, runPortraitSync]);

  const profileIncomplete = (p: LiveProfile | null | undefined) =>
    !p?.nickname ||
    !p.avatarUrl ||
    // http 直链在应用里会裂图，需再采一次转成 data URL
    !p.avatarUrl.startsWith("data:") ||
    p.diggCount == null ||
    p.followingCount == null ||
    p.followerCount == null;

  /** 同步头像 / 获赞 / 关注 / 粉丝 */
  const syncProfile = useCallback(async () => {
    if (!dataRef.current.loggedIn || needRelogin) return;
    try {
      const raw = await invoke<{
        nickname?: string;
        avatarUrl?: string | null;
        diggCount?: number | null;
        followingCount?: number | null;
        followerCount?: number | null;
      }>("live_sync_profile");
      const nick = (raw?.nickname || "").trim();
      if (
        !nick &&
        !raw?.avatarUrl &&
        raw?.diggCount == null &&
        raw?.followingCount == null &&
        raw?.followerCount == null
      ) {
        return;
      }
      const prev = dataRef.current.profile;
      const profile: LiveProfile = {
        nickname: nick || prev?.nickname || "—",
        avatarUrl: raw?.avatarUrl || prev?.avatarUrl || null,
        diggCount:
          typeof raw?.diggCount === "number"
            ? raw.diggCount
            : (prev?.diggCount ?? null),
        followingCount:
          typeof raw?.followingCount === "number"
            ? raw.followingCount
            : (prev?.followingCount ?? null),
        followerCount:
          typeof raw?.followerCount === "number"
            ? raw.followerCount
            : (prev?.followerCount ?? null),
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await persist({ ...dataRef.current, profile });
    } catch {
      /* 资料失败不挡场次同步 */
    }
  }, [needRelogin, persist]);

  /**
   * 同步历史列表。
   * - force：手动点「同步历史」，必拉列表
   * - 自动进入：30 分钟内已同步过则只补缺口，不重跑全场深采
   */
  const syncHistory = useCallback(
    async (opts?: { force?: boolean }) => {
      if (historySyncLock.current) return;
      if (!dataRef.current.loggedIn || needRelogin) return;
      const force = !!opts?.force;
      const nowSec = Math.floor(Date.now() / 1000);
      const last = dataRef.current.lastHistorySyncAt ?? 0;
      const recent = recentSessions(dataRef.current.sessions, 8);
      const mostlyReady =
        recent.length >= 3 &&
        recent.filter(hasCoreReview).length >= Math.min(3, recent.length);
      // 本地已有齐套复盘时，首次升级也走轻量补缺，避免整批重采
      const fresh =
        !force &&
        dataRef.current.sessions.length >= 1 &&
        ((last > 0 && nowSec - last < HISTORY_FRESH_SEC) ||
          (last <= 0 && mostlyReady));

      historySyncLock.current = true;
      setHistorySyncing(true);
      setError(null);
      try {
        if (fresh) {
          // 本地已有数据：立刻收起飞车，后台补缺
          setFetchAfterLogin(false);
          if (profileIncomplete(dataRef.current.profile)) {
            await syncProfile();
          }
          await fillGaps();
          // 记一次时间戳，下次进模块继续轻量
          if (!dataRef.current.lastHistorySyncAt) {
            const cur = dataRef.current;
            await persist({
              ...cur,
              lastHistorySyncAt: Math.floor(Date.now() / 1000),
            });
          }
          return;
        }
        // 资料很快：先抠中控台顶栏，别等历史/深采跑完才显示
        if (profileIncomplete(dataRef.current.profile)) {
          await syncProfile();
        }
        const raw = await invoke<HistorySyncResult>("live_sync_history");
        const remote = Array.isArray(raw?.sessions) ? raw.sessions : [];
        const cur = dataRef.current;
        const sessions = mergeHistorySessions(cur.sessions, remote);
        await persist({
          ...cur,
          loggedIn: true,
          sessions,
          lastHistorySyncAt: Math.floor(Date.now() / 1000),
        });
        // 列表到手就进分析页，深采/画像后台继续，别挡整屏
        setFetchAfterLogin(false);
        portraitAttempts.current = 0;
        if (profileIncomplete(dataRef.current.profile)) {
          await syncProfile();
        }
        await runDeepSync(dataRef.current.sessions);
        await runPortraitSync(dataRef.current.sessions);
      } catch (e) {
        setError(String(e));
      } finally {
        historySyncLock.current = false;
        setHistorySyncing(false);
        setFetchAfterLogin(false);
      }
    },
    [needRelogin, persist, fillGaps, runDeepSync, runPortraitSync, syncProfile],
  );

  const saveGoals = useCallback(
    async (goals: LiveGoals) => {
      const cur = dataRef.current;
      await persist({ ...cur, goals });
    },
    [persist],
  );

  // 进模块：先抠资料（中控台顶栏），再按新鲜度同步历史/补缺
  useEffect(() => {
    if (booting || !data.loggedIn || needRelogin) return;
    if (autoSyncStarted.current) return;
    autoSyncStarted.current = true;
    void (async () => {
      if (profileIncomplete(dataRef.current.profile)) {
        await syncProfile();
      }
      await syncHistory({ force: false });
    })();
  }, [booting, data.loggedIn, needRelogin, syncHistory, syncProfile]);

  // 打开仍缺核心复盘的单场：只补这一场
  useEffect(() => {
    if (booting || !data.loggedIn || needRelogin) return;
    if (view !== "detail" || !detailId) return;
    if (historySyncLock.current || gapFillRunning.current) return;
    const s = data.sessions.find((x) => x.id === detailId);
    if (!s || !needsReviewMetrics(s)) return;
    void runPortraitSync([s]);
  }, [
    booting,
    data.loggedIn,
    needRelogin,
    view,
    detailId,
    data.sessions,
    runPortraitSync,
  ]);

  const tickScrape = useCallback(async () => {
    if (scrapeLock.current || historySyncLock.current) return;
    if (!dataRef.current.loggedIn || needRelogin) return;
    scrapeLock.current = true;
    try {
      const raw = await invoke<LiveScrapeResult>("live_scrape", { script: SCRAPE_SCRIPT });
      if (raw?.error) setError(String(raw.error));
      else setError(null);
      await applyScrape(raw ?? {});
    } catch (e) {
      const msg = String(e);
      if (/采集窗未打开|未打开/.test(msg)) {
        /* quiet until user opens login */
      } else {
        setError(msg);
      }
    } finally {
      scrapeLock.current = false;
    }
  }, [applyScrape, needRelogin]);

  useEffect(() => {
    if (booting || !data.loggedIn || needRelogin) return;
    void tickScrape();
    const id = window.setInterval(() => void tickScrape(), SCRAPE_MS);
    return () => window.clearInterval(id);
  }, [booting, data.loggedIn, needRelogin, tickScrape]);

  const openLogin = useCallback(async () => {
    setBusy(true);
    setError(null);
    setQrDataUrl(null);
    try {
      await invoke("live_open_login");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const showScrapeWindow = useCallback(async () => {
    setBusy(true);
    try {
      await invoke("live_show_window");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const endLiveManual = useCallback(async () => {
    const cur = dataRef.current;
    const active = cur.activeSessionId
      ? cur.sessions.find((s) => s.id === cur.activeSessionId)
      : null;
    if (!active || active.endTime != null) {
      setSection("analysis");
      setView("overview");
      return;
    }
    await closeSessionPipeline(active);
  }, [closeSessionPipeline]);

  const detailSession = detailId
    ? data.sessions.find((s) => s.id === detailId) ?? null
    : null;
  const prevSession = useMemo(() => {
    if (!detailSession) return null;
    const idx = data.sessions.findIndex((s) => s.id === detailSession.id);
    return idx >= 0 ? data.sessions[idx + 1] ?? null : null;
  }, [data.sessions, detailSession]);

  const shellRef = useRef<HTMLDivElement | null>(null);
  // 切概览/详情时滚回顶部，避免沿用列表页滚动位置
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [view, detailId, section]);

  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    const tools = data.loggedIn ? (
      <>
        <button
          type="button"
          className="icon-btn"
          title={t("liveOpenPanel")}
          disabled={busy}
          onClick={() => void showScrapeWindow()}
        >
          <AppWindow size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t("liveSyncHistory")}
          disabled={busy || historySyncing}
          onClick={() => {
            void syncHistory({ force: true });
          }}
        >
          <RefreshCw size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t("liveRelogin")}
          disabled={busy}
          onClick={() => void openLogin()}
        >
          <LogIn size={ICO} strokeWidth={1.75} absoluteStrokeWidth />
        </button>
      </>
    ) : null;
    if (!data.loggedIn || needRelogin) {
      onChromeChange({ title: t("liveData"), tools });
      return;
    }
    const meta =
      section === "live" && activeSession
        ? t("liveMetaLive")
        : `${data.sessions.length} ${t("liveSessionsUnit")}`;
    onChromeChange({
      context: (
        <>
          <nav className="live-chrome-tabs" role="tablist" aria-label={t("liveData")}>
            <button
              type="button"
              role="tab"
              aria-selected={section === "analysis"}
              className={section === "analysis" ? "live-chrome-tab on" : "live-chrome-tab"}
              onClick={() => {
                setSection("analysis");
                if (view === "monitor") setView("overview");
              }}
            >
              {t("liveData")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={section === "live"}
              className={section === "live" ? "live-chrome-tab on" : "live-chrome-tab"}
              onClick={() => {
                setSection("live");
                setView("monitor");
              }}
            >
              {t("liveLiveTab")}
            </button>
          </nav>
          <span className="count-label" data-tauri-drag-region>
            {meta}
          </span>
        </>
      ),
      tools,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    embedded,
    onChromeChange,
    t,
    view,
    section,
    activeSession?.id,
    needRelogin,
    data.loggedIn,
    data.sessions.length,
    busy,
    historySyncing,
    syncHistory,
  ]);

  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    return () => onChromeChange(null);
  }, [embedded, onChromeChange]);

  const saveCueNoteId = useCallback(
    (id: string | null) => {
      void persist({ ...dataRef.current, cueNoteId: id });
    },
    [persist],
  );

  if (booting) {
    return (
      <div className="empty live-login">
        <div className="live-qr-loading" aria-hidden>
          <div className="live-qr-spinner" />
        </div>
        <p className="muted">{t("liveLoading")}</p>
      </div>
    );
  }

  if (!data.loggedIn || needRelogin) {
    return (
      <div className="empty live-login">
        <h2>{needRelogin ? t("liveExpiredTitle") : t("liveScanTitle")}</h2>
        <p className="muted">{needRelogin ? t("liveExpiredDesc") : t("liveScanHint")}</p>
        <div className="live-qr-frame">
          {qrDataUrl ? (
            <img className="live-qr-img" src={qrDataUrl} alt="" draggable={false} />
          ) : (
            <div className="live-qr-loading" aria-hidden>
              <div className="live-qr-spinner" />
            </div>
          )}
        </div>
        {error ? <div className="banner error">{error}</div> : null}
        <button
          type="button"
          className="settings-path-btn"
          disabled={busy}
          onClick={() => void openLogin()}
        >
          {t("liveRefreshQr")}
        </button>
        {needRelogin ? (
          <button
            type="button"
            className="settings-path-btn"
            style={{ marginTop: 12 }}
            onClick={() => {
              setNeedRelogin(false);
              void persist({ ...dataRef.current, loggedIn: true });
              setView("overview");
            }}
          >
            {t("liveContinueOffline")}
          </button>
        ) : null}
      </div>
    );
  }

  // 仅首次空库抓数时全屏飞车；已有场次绝不挡界面
  if (fetchAfterLogin && data.sessions.length === 0) {
    return (
      <div className="empty live-login">
        <LiveSpeederLoader />
      </div>
    );
  }

  return (
    <div className="live-shell" ref={shellRef}>
      {error ? <div className="banner error">{error}</div> : null}
      {postEndNotice ? (
        <div className="banner live-post-end-banner" role="status">
          {postEndNotice}
        </div>
      ) : null}
      {section === "live" ? (
        <LiveBoard
          session={activeSession}
          allSessions={data.sessions}
          goals={data.goals}
          cueNoteId={data.cueNoteId ?? null}
          onCueNoteId={saveCueNoteId}
          onEndLive={() => void endLiveManual()}
          labels={{
            live: t("liveStatusLive"),
            idle: t("liveIdlePill"),
            endLive: t("liveEndManual"),
            heatTitle: t("liveLiveHeatTitle"),
            viewers: t("liveMetricViewersNow"),
            gifts: t("liveMetricGifts"),
            senders: t("liveMetricSenders"),
            followers: t("liveMetricFollowers"),
            commenters: t("liveMetricCommenters"),
            likes: t("liveMetricLikes"),
            shares: t("liveMetricShares"),
            fansClub: t("liveMetricFansClub"),
            convTitle: t("liveConvTitle"),
            modeMinute: t("liveConvModeMinute"),
            modeTotal: t("liveConvModeTotal"),
            showMinute: t("liveConvShowMinute"),
            enterMinute: t("liveConvEnterMinute"),
            stayMinute: t("liveConvStayMinute"),
            showTotal: t("liveConvShowTotal"),
            enterTotal: t("liveConvEnterTotal"),
            giftTotal: t("liveConvGiftTotal"),
            enterRate: t("liveEnterRate"),
            stayRate: t("liveConvStayRate"),
            giftRate: t("liveConvGiftRate"),
            vs7: t("liveFunnelVs7"),
            musicTitle: t("liveBoardMusic"),
            cuePick: t("liveBoardCuePick"),
            cueEmpty: t("liveBoardCueEmptyTitle"),
            cueNoNotes: t("liveBoardCueNoNotes"),
            bgmIdle: t("sfxBgmIdle"),
            prev: t("sfxPrev"),
            next: t("sfxNext"),
            loopOne: t("sfxLoopOne"),
            loopList: t("sfxLoopList"),
            playlist: t("liveBoardPlaylist"),
            playlistTitle: t("liveBoardPlaylistTitle"),
            noPlaylist: t("liveBoardNoPlaylist"),
          }}
        />
      ) : null}
      {section === "analysis" && view === "detail" && detailSession ? (
        <SessionDetail
          key={`detail-${locale}-${detailSession.id}`}
          session={detailSession}
          allSessions={data.sessions}
          prev={prevSession}
          autoCopyReport={autoCopyReport}
          onAutoCopyDone={() => setAutoCopyReport(false)}
          labels={{
            back: t("liveBackList"),
            core: t("liveCoreMetrics"),
            peak: t("liveMetricPeak"),
            avg: t("liveMetricAvg"),
            gifts: t("liveMetricGifts"),
            followers: t("liveMetricFollowers"),
            likes: t("liveMetricLikes"),
            comments: t("liveMetricComments"),
            shares: t("liveMetricShares"),
            senders: t("liveMetricSenders"),
            trend: t("liveViewersTrend"),
            vsPrev: t("liveVsPrev"),
            noPrev: t("liveNoPrev"),
            vsMedian: t("liveVsMedian"),
            efficiency: t("liveEfficiency"),
            giftsPerHour: t("liveGiftsPerHour"),
            fansPerHour: t("liveFansPerHour"),
            giftsPerViewer: t("liveGiftsPerViewer"),
            enterRate: t("liveEnterRate"),
            avgStay: t("liveAvgStay"),
            consumeRate: t("liveConsumeRate"),
            portrait: t("liveAudiencePortrait"),
            gender: t("livePortraitGender"),
            age: t("livePortraitAge"),
            region: t("livePortraitRegion"),
            hobby: t("livePortraitHobby"),
            honor: t("livePortraitHonor"),
            portraitComments: t("livePortraitComments"),
            fans: t("livePortraitFans"),
            noPortrait: t("livePortraitEmpty"),
            traffic: t("liveTrafficChannels"),
            channelCol: t("liveTrafficChannelCol"),
            watchShare: t("liveTrafficWatchShare"),
            consumeShare: t("liveTrafficConsumeShare"),
            avgWatch: t("liveTrafficAvgWatch"),
            funnel: t("liveTrafficFunnel"),
            funnelShow: t("liveFunnelShow"),
            funnelEnter: t("liveFunnelEnter"),
            funnelInteract: t("liveFunnelInteract"),
            funnelPay: t("liveFunnelPay"),
            funnelFollow: t("liveFunnelFollow"),
            funnelPayTitle: t("liveFunnelPayTitle"),
            funnelInteractTitle: t("liveFunnelInteractTitle"),
            funnelFollowTitle: t("liveFunnelFollowTitle"),
            funnelEnterRate: t("liveFunnelEnterRate"),
            funnelPayRate: t("liveFunnelPayRate"),
            funnelInteractRate: t("liveFunnelInteractRate"),
            funnelFollowRate: t("liveFunnelFollowRate"),
            funnelVs7: t("liveFunnelVs7"),
            funnelGift: t("liveFunnelGift"),
            funnelNewFans: t("liveFunnelNewFans"),
            funnelRoomInteract: t("liveFunnelRoomInteract"),
            minuteCross: t("liveMinuteCross"),
            minuteViewers: t("liveMinuteViewers"),
            minuteGifts: t("liveMinuteGifts"),
            minutePeak: t("liveMinutePeak"),
            reviewHint: t("liveReviewSyncHint"),
            portraitAll: t("livePortraitAll"),
            portraitPaid: t("livePortraitPaid"),
            portraitFans: t("livePortraitFansOnly"),
            copyReport: t("liveCopyReport"),
            copyReportOk: t("liveCopyReportOk"),
            exportReport: t("liveExportReport"),
            exportReportOk: t("liveExportReportOk"),
            audienceMaint: t("liveAudienceMaint"),
            lostAudience: t("liveLostAudience"),
            highValueAudience: t("liveHighValueAudience"),
            copyFail: t("liveCopyFail"),
            exportFail: t("liveExportFail"),
            prevSession: t("livePrevSession"),
            funnelShowView: t("liveFunnelShowView"),
            funnelEnterRoom: t("liveFunnelEnterRoom"),
            funnelGiftPay: t("liveFunnelGift"),
          }}
          onBack={() => {
            setDetailId(null);
            setSection("analysis");
            setView("overview");
          }}
        />
      ) : null}
      {section === "analysis" && (view === "overview" || view === "monitor") ? (
        <LiveOverview
          sessions={data.sessions}
          goals={data.goals}
          labels={{
            empty: t("liveListEmpty"),
            coreTitle: t("liveCoreTitle"),
            rangeToday: t("liveRangeToday"),
            range7: t("liveRange7"),
            range30: t("liveRange30"),
            rangeAll: t("liveRangeAll"),
            periodLabel: t("livePeriodLabel"),
            gifts: t("liveMetricGifts"),
            senders: t("liveMetricSenders"),
            watchers: t("liveMetricWatchers"),
            avgWatch: t("liveMetricAvgWatch"),
            followers: t("liveMetricFollowers"),
            fansClub: t("liveMetricFansClub"),
            comments: t("liveMetricComments"),
            likes: t("liveMetricLikes"),
            liveCount: t("liveMetricLiveCount"),
            liveDuration: t("liveMetricLiveDuration"),
            coreTrend: t("liveCoreTrend"),
            coreEmptyTrend: t("liveCoreEmptyTrend"),
            date: t("liveColDate"),
            title: t("liveColTitle"),
            colDuration: t("liveColDuration"),
            insights: t("liveInsights"),
            slotAdvice: t("liveSlotAdvice"),
            heatTitle: t("liveHeatTitle"),
            sortDate: t("liveSortDate"),
            sortGifts: t("liveSortGifts"),
            sortFollowers: t("liveSortFollowers"),
            sortDuration: t("liveSortDuration"),
            goalsTitle: t("liveGoalsTitle"),
            goalDailyGifts: t("liveGoalDailyGifts"),
            goalWeeklyFans: t("liveGoalWeeklyFans"),
            goalWeeklyDur: t("liveGoalWeeklyDur"),
            remaining: t("liveGoalRemaining"),
            giftsPerHour: t("liveGiftsPerHour"),
            digg: t("liveProfileDigg"),
            following: t("liveProfileFollowing"),
            fans: t("liveProfileFans"),
            insightsEmpty: t("liveInsightsEmpty"),
            adviceEmpty: t("liveAdviceEmpty"),
            goalTarget: t("liveGoalTarget"),
            goalHoursWeek: t("liveGoalHoursWeek"),
          }}
          profile={data.profile}
          onOpen={(id) => {
            setDetailId(id);
            setView("detail");
          }}
          onGoalsChange={(goals) => void saveGoals(goals)}
        />
      ) : null}
    </div>
  );
}
