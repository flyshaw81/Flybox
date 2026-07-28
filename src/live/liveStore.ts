import { load } from "@tauri-apps/plugin-store";
import { suggestedGoals } from "./insights";
import type {
  LiveGoals,
  LiveProfile,
  LiveSession,
  LiveStoreData,
} from "./liveTypes";

const STORE_FILE = "live.json";
const KEY = "live";

const DEFAULT_GOALS: LiveGoals = {
  dailyGifts: 3000,
  weeklyFollowers: 30,
  weeklyDurationSec: 20 * 3600,
};

function isStockGoals(g: LiveGoals | undefined): boolean {
  if (!g) return true;
  return (
    g.dailyGifts === DEFAULT_GOALS.dailyGifts &&
    g.weeklyFollowers === DEFAULT_GOALS.weeklyFollowers &&
    g.weeklyDurationSec === DEFAULT_GOALS.weeklyDurationSec
  );
}

export async function loadLiveStore(): Promise<LiveStoreData> {
  const store = await load(STORE_FILE, { autoSave: true });
  const raw = (await store.get<Partial<LiveStoreData>>(KEY)) ?? {};
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  let goals: LiveGoals = raw.goals
    ? { ...DEFAULT_GOALS, ...raw.goals }
    : { ...DEFAULT_GOALS };
  // 仍是出厂默认且已有历史时，按近况给一版更贴身目标
  if (sessions.length >= 8 && isStockGoals(raw.goals)) {
    goals = suggestedGoals(sessions);
  }
  const profile = normalizeProfile(raw.profile);
  return {
    loggedIn: Boolean(raw.loggedIn),
    sessions,
    activeSessionId: raw.activeSessionId ?? null,
    goals,
    profile,
    lastHistorySyncAt:
      typeof raw.lastHistorySyncAt === "number" ? raw.lastHistorySyncAt : null,
  };
}

function normalizeProfile(raw: unknown): LiveProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<LiveProfile>;
  const nickname = typeof p.nickname === "string" ? p.nickname.trim() : "";
  if (!nickname && !p.avatarUrl) return null;
  return {
    nickname: nickname || "—",
    avatarUrl: typeof p.avatarUrl === "string" ? p.avatarUrl : null,
    diggCount: typeof p.diggCount === "number" ? p.diggCount : null,
    followingCount:
      typeof p.followingCount === "number" ? p.followingCount : null,
    followerCount: typeof p.followerCount === "number" ? p.followerCount : null,
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : null,
  };
}

export async function saveLiveStore(data: LiveStoreData): Promise<void> {
  const store = await load(STORE_FILE, { autoSave: true });
  await store.set(KEY, data);
}

export function newSessionId(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function sessionDate(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createSession(title?: string | null, now = Date.now()): LiveSession {
  return {
    id: newSessionId(now),
    date: sessionDate(now),
    startTime: Math.floor(now / 1000),
    endTime: null,
    duration: 0,
    title: (title && title.trim()) || "直播场次",
    type: "日常聊天",
    peakViewers: 0,
    avgViewers: 0,
    totalGifts: 0,
    giftSenders: 0,
    newFollowers: 0,
    newFansClub: 0,
    totalComments: 0,
    totalLikes: 0,
    totalShares: 0,
    dataPoints: [],
  };
}

export function recomputeSessionStats(session: LiveSession): LiveSession {
  const pts = session.dataPoints;
  if (pts.length === 0) return session;
  const peakViewers = Math.max(session.peakViewers, ...pts.map((p) => p.viewers));
  const avgViewers = Math.round(pts.reduce((s, p) => s + p.viewers, 0) / pts.length);
  const last = pts[pts.length - 1];
  return {
    ...session,
    peakViewers,
    avgViewers,
    totalGifts: last.gifts,
    giftSenders: last.giftSenders ?? session.giftSenders,
    newFollowers: last.newFollowers ?? session.newFollowers,
    newFansClub: last.newFansClub ?? session.newFansClub,
    totalComments: last.comments,
    totalLikes: last.likes,
    totalShares: last.shares ?? session.totalShares,
  };
}

export function finalizeSession(session: LiveSession, now = Date.now()): LiveSession {
  const endTime = Math.floor(now / 1000);
  const duration = Math.max(0, endTime - session.startTime);
  return recomputeSessionStats({ ...session, endTime, duration });
}

export function upsertSession(sessions: LiveSession[], next: LiveSession): LiveSession[] {
  const i = sessions.findIndex((s) => s.id === next.id);
  if (i < 0) return [next, ...sessions];
  const copy = sessions.slice();
  copy[i] = next;
  return copy;
}
