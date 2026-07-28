import type {
  AudienceMaintenance,
  AudiencePortrait,
  LiveSession,
  MinutePoint,
  PortraitSlices,
  TrafficChannel,
  TrafficFunnel,
} from "./liveTypes";
import { sessionDate, upsertSession } from "./liveStore";

export type HistorySessionDto = {
  id: string;
  title?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  duration?: number | null;
  peakViewers?: number | null;
  avgViewers?: number | null;
  totalGifts?: number | null;
  newFollowers?: number | null;
  totalLikes?: number | null;
  totalComments?: number | null;
  giftSenders?: number | null;
  avgWatchMins?: number | null;
  consumeUcnt?: number | null;
  consumeRate?: number | null;
  dateHint?: string | null;
};

export type HistorySyncResult = {
  sessions: HistorySessionDto[];
  captured?: number;
  href?: string;
};

export type DeepSessionDto = {
  id: string;
  totalGifts?: number | null;
  giftSenders?: number | null;
  newFollowers?: number | null;
  totalLikes?: number | null;
  totalComments?: number | null;
  peakViewers?: number | null;
  avgViewers?: number | null;
  watchUcnt?: number | null;
  enterUcnt?: number | null;
  enterRate?: number | null;
  showUcnt?: number | null;
  avgWatchMins?: number | null;
  consumeUcnt?: number | null;
  consumeRate?: number | null;
  earnScoreDiff?: number | null;
  duration?: number | null;
  newFansClub?: number | null;
};

export type DeepSyncResult = {
  sessions: DeepSessionDto[];
  fetched?: number;
};

export type PortraitSessionDto = {
  id: string | null;
  sourceRoomId?: string | null;
  portrait?: AudiencePortrait | null;
  portraitSlices?: PortraitSlices | null;
  audienceMaintenance?: AudienceMaintenance | null;
  trafficChannels?: TrafficChannel[] | null;
  trafficFunnel?: TrafficFunnel | null;
  minuteTrend?: MinutePoint[] | null;
  deep?: DeepSessionDto | null;
  error?: string | null;
};

export type PortraitSyncResult = {
  sessions: PortraitSessionDto[];
  fetched?: number;
};

export function mergePortraitSessions(
  local: LiveSession[],
  rows: PortraitSessionDto[],
): LiveSession[] {
  let next = local.slice();
  for (const row of rows) {
    if (!row?.id) continue;
    // 串场数据丢弃（复盘页 URL roomID 不可靠时曾整批写成同一场）
    if (
      row.sourceRoomId &&
      String(row.sourceRoomId) !== String(row.id)
    ) {
      continue;
    }
    const hasAny =
      row.portrait ||
      row.portraitSlices != null ||
      row.audienceMaintenance != null ||
      (row.trafficChannels && row.trafficChannels.length) ||
      row.trafficFunnel ||
      (row.minuteTrend && row.minuteTrend.length) ||
      row.deep;
    if (!hasAny) continue;
    const prev = next.find((s) => s.id === String(row.id));
    if (!prev) continue;
    const d = row.deep;
    const slices: PortraitSlices | null | undefined = row.portraitSlices
      ? {
          all: row.portraitSlices.all ?? prev.portraitSlices?.all ?? row.portrait ?? prev.audiencePortrait,
          paid: row.portraitSlices.paid ?? prev.portraitSlices?.paid,
          fans: row.portraitSlices.fans ?? prev.portraitSlices?.fans,
        }
      : prev.portraitSlices;
    const merged: LiveSession = {
      ...prev,
      audiencePortrait:
        row.portrait ??
        row.portraitSlices?.all ??
        prev.audiencePortrait,
      portraitSlices: slices,
      audienceMaintenance: (() => {
        const incoming = row.audienceMaintenance;
        const old = prev.audienceMaintenance;
        if (!incoming) return old;
        if (!old) return incoming;
        // 保留更完整的一边（有高活跃人数/样本优先）
        const score = (m: AudienceMaintenance) =>
          (m.highValueCount ?? 0) * 10 +
          (m.lostCount ?? 0) +
          (m.highValueSamples?.length ?? 0) * 3 +
          (m.lostSamples?.length ?? 0);
        return score(incoming) >= score(old) ? incoming : old;
      })(),
      trafficChannels: row.trafficChannels?.length
        ? row.trafficChannels
        : prev.trafficChannels,
      trafficFunnel: row.trafficFunnel ?? prev.trafficFunnel,
      // 有旧曲线时：新曲线必须对得上开播小时，否则宁可不覆盖（防串场写坏）
      minuteTrend: (() => {
        if (!row.minuteTrend?.length) return prev.minuteTrend;
        if (!prev.minuteTrend?.length) return row.minuteTrend;
        const t0 = row.minuteTrend[0]?.t || "";
        const d = new Date(prev.startTime * 1000);
        const pad = (n: number) => String(n).padStart(2, "0");
        const prefix = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:`;
        if (t0.startsWith(prefix)) return row.minuteTrend;
        return prev.minuteTrend;
      })(),
      totalGifts:
        d?.totalGifts != null ? n(d.totalGifts) : prev.totalGifts,
      giftSenders:
        d?.giftSenders != null ? n(d.giftSenders) : prev.giftSenders,
      newFollowers:
        d?.newFollowers != null ? n(d.newFollowers) : prev.newFollowers,
      totalLikes: d?.totalLikes != null ? n(d.totalLikes) : prev.totalLikes,
      totalComments:
        d?.totalComments != null ? n(d.totalComments) : prev.totalComments,
      peakViewers:
        d?.peakViewers != null ? n(d.peakViewers) : prev.peakViewers,
      avgViewers: d?.avgViewers != null ? n(d.avgViewers) : prev.avgViewers,
      duration:
        d?.duration != null && n(d.duration) > 0
          ? n(d.duration)
          : prev.duration,
      newFansClub:
        d?.newFansClub != null ? n(d.newFansClub) : prev.newFansClub,
      watchUcnt: d?.watchUcnt ?? prev.watchUcnt,
      enterUcnt: d?.enterUcnt ?? prev.enterUcnt,
      enterRate: d?.enterRate ?? prev.enterRate,
      showUcnt: d?.showUcnt ?? prev.showUcnt,
      avgWatchMins: d?.avgWatchMins ?? prev.avgWatchMins,
      consumeUcnt: d?.consumeUcnt ?? prev.consumeUcnt,
      consumeRate: d?.consumeRate ?? prev.consumeRate,
      earnScoreDiff: d?.earnScoreDiff ?? prev.earnScoreDiff,
    };
    next = upsertSession(next, merged);
  }
  return next.sort((a, b) => b.startTime - a.startTime);
}

export function mergeDeepSessions(
  local: LiveSession[],
  deep: DeepSessionDto[],
): LiveSession[] {
  let next = local.slice();
  for (const d of deep) {
    const prev = next.find((s) => s.id === String(d.id));
    if (!prev) continue;
    const merged: LiveSession = {
      ...prev,
      totalGifts: d.totalGifts != null ? n(d.totalGifts) : prev.totalGifts,
      giftSenders: d.giftSenders != null ? n(d.giftSenders) : prev.giftSenders,
      newFollowers:
        d.newFollowers != null ? n(d.newFollowers) : prev.newFollowers,
      totalLikes: d.totalLikes != null ? n(d.totalLikes) : prev.totalLikes,
      totalComments:
        d.totalComments != null ? n(d.totalComments) : prev.totalComments,
      peakViewers: d.peakViewers != null ? n(d.peakViewers) : prev.peakViewers,
      avgViewers: d.avgViewers != null ? n(d.avgViewers) : prev.avgViewers,
      duration:
        d.duration != null && n(d.duration) > 0
          ? n(d.duration)
          : prev.duration,
      newFansClub: d.newFansClub != null ? n(d.newFansClub) : prev.newFansClub,
      watchUcnt: d.watchUcnt ?? prev.watchUcnt,
      enterUcnt: d.enterUcnt ?? prev.enterUcnt,
      enterRate: d.enterRate ?? prev.enterRate,
      showUcnt: d.showUcnt ?? prev.showUcnt,
      avgWatchMins: d.avgWatchMins ?? prev.avgWatchMins,
      consumeUcnt: d.consumeUcnt ?? prev.consumeUcnt,
      consumeRate: d.consumeRate ?? prev.consumeRate,
      earnScoreDiff: d.earnScoreDiff ?? prev.earnScoreDiff,
    };
    next = upsertSession(next, merged);
  }
  return next.sort((a, b) => b.startTime - a.startTime);
}

function n(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function historyToSession(dto: HistorySessionDto): LiveSession {
  let start = n(dto.startTime);
  if (start > 1e12) start = Math.floor(start / 1000);
  if (!start && dto.dateHint) {
    const parsed = Date.parse(dto.dateHint.replace(/\./g, "-"));
    if (Number.isFinite(parsed)) start = Math.floor(parsed / 1000);
  }
  if (!start) start = Math.floor(Date.now() / 1000);
  let end = n(dto.endTime);
  if (end > 1e12) end = Math.floor(end / 1000);
  let duration = Math.max(0, n(dto.duration));
  if (!duration && end > start) duration = end - start;
  const endTime = end > start ? end : duration > 0 ? start + duration : start;
  return {
    id: String(dto.id),
    date: sessionDate(start * 1000),
    startTime: start,
    endTime,
    duration,
    title: (dto.title && String(dto.title).trim()) || "直播场次",
    type: "日常聊天",
    peakViewers: n(dto.peakViewers),
    avgViewers: n(dto.avgViewers),
    totalGifts: n(dto.totalGifts),
    giftSenders: n(dto.giftSenders),
    newFollowers: n(dto.newFollowers),
    newFansClub: 0,
    totalComments: n(dto.totalComments),
    totalLikes: n(dto.totalLikes),
    totalShares: 0,
    dataPoints: [],
    avgWatchMins: dto.avgWatchMins ?? undefined,
    consumeUcnt: dto.consumeUcnt ?? undefined,
    consumeRate: dto.consumeRate ?? undefined,
  };
}

/** 合并历史：本地已有细粒度 dataPoints 的场次优先保留曲线，数字取较大值 */
export function mergeHistorySessions(
  local: LiveSession[],
  remote: HistorySessionDto[],
): LiveSession[] {
  let next = local.slice();
  for (const dto of remote) {
    const incoming = historyToSession(dto);
    const prev = next.find((s) => s.id === incoming.id);
    if (!prev) {
      next = upsertSession(next, incoming);
      continue;
    }
    const richer =
      prev.dataPoints.length >= incoming.dataPoints.length ? prev : incoming;
    const merged: LiveSession = {
      ...richer,
      title: prev.title !== "直播场次" ? prev.title : incoming.title,
      peakViewers: Math.max(prev.peakViewers, incoming.peakViewers),
      avgViewers: Math.max(prev.avgViewers, incoming.avgViewers),
      totalGifts: Math.max(prev.totalGifts, incoming.totalGifts),
      giftSenders: Math.max(prev.giftSenders, incoming.giftSenders),
      newFollowers: Math.max(prev.newFollowers, incoming.newFollowers),
      totalLikes: Math.max(prev.totalLikes, incoming.totalLikes),
      totalComments: Math.max(prev.totalComments, incoming.totalComments),
      duration: Math.max(prev.duration, incoming.duration),
      startTime: Math.min(prev.startTime, incoming.startTime),
      endTime:
        prev.endTime != null && incoming.endTime != null
          ? Math.max(prev.endTime, incoming.endTime)
          : prev.endTime ?? incoming.endTime,
      dataPoints: prev.dataPoints.length ? prev.dataPoints : incoming.dataPoints,
      avgWatchMins: incoming.avgWatchMins ?? prev.avgWatchMins,
      consumeUcnt: incoming.consumeUcnt ?? prev.consumeUcnt,
      consumeRate: incoming.consumeRate ?? prev.consumeRate,
    };
    next = upsertSession(next, merged);
  }
  return next.sort((a, b) => b.startTime - a.startTime);
}

export type LiveSummary = {
  sessionCount: number;
  totalDuration: number;
  totalGifts: number;
  totalFollowers: number;
  peakViewers: number;
  avgGifts: number;
  last7Gifts: number;
  prev7Gifts: number;
  giftsGrowthPct: number | null;
};

export function computeLiveSummary(sessions: LiveSession[]): LiveSummary {
  const list = sessions;
  const sessionCount = list.length;
  const totalDuration = list.reduce((s, x) => s + (x.duration || 0), 0);
  const totalGifts = list.reduce((s, x) => s + x.totalGifts, 0);
  const totalFollowers = list.reduce((s, x) => s + x.newFollowers, 0);
  const peakViewers = list.reduce((m, x) => Math.max(m, x.peakViewers), 0);
  const avgGifts = sessionCount ? Math.round(totalGifts / sessionCount) : 0;

  const now = Date.now() / 1000;
  const d7 = 7 * 86400;
  const last7 = list.filter((s) => s.startTime >= now - d7);
  const prev7 = list.filter((s) => s.startTime >= now - 2 * d7 && s.startTime < now - d7);
  const last7Gifts = last7.reduce((s, x) => s + x.totalGifts, 0);
  const prev7Gifts = prev7.reduce((s, x) => s + x.totalGifts, 0);
  const giftsGrowthPct =
    prev7Gifts > 0 ? ((last7Gifts - prev7Gifts) / prev7Gifts) * 100 : null;

  return {
    sessionCount,
    totalDuration,
    totalGifts,
    totalFollowers,
    peakViewers,
    avgGifts,
    last7Gifts,
    prev7Gifts,
    giftsGrowthPct,
  };
}

/** 首页核心数据周期：今日 / 近7日 / 近30日 */
export type PeriodKey = "today" | "7d" | "30d";

export type PeriodDailyGift = {
  date: string; // YYYY-MM-DD
  gifts: number;
};

export type PeriodCore = {
  period: PeriodKey;
  fromSec: number;
  toSec: number;
  sessionCount: number;
  totalGifts: number;
  giftSenders: number;
  watchUcnt: number;
  avgWatchMins: number | null;
  newFollowers: number;
  newFansClub: number;
  totalComments: number;
  totalLikes: number;
  totalDuration: number;
  dailyGifts: PeriodDailyGift[];
};

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function periodWindow(
  period: PeriodKey,
  nowMs = Date.now(),
): { fromSec: number; toSec: number } {
  const toSec = Math.floor(nowMs / 1000);
  if (period === "today") {
    return { fromSec: startOfLocalDay(nowMs), toSec };
  }
  const days = period === "7d" ? 7 : 30;
  return { fromSec: toSec - days * 86400, toSec };
}

function dayKey(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function computePeriodCore(
  sessions: LiveSession[],
  period: PeriodKey,
  nowMs = Date.now(),
): PeriodCore {
  const { fromSec, toSec } = periodWindow(period, nowMs);
  const list = sessions.filter(
    (s) => s.startTime >= fromSec && s.startTime <= toSec,
  );

  const sessionCount = list.length;
  const totalGifts = list.reduce((s, x) => s + (x.totalGifts || 0), 0);
  const giftSenders = list.reduce(
    (s, x) => s + (x.giftSenders || x.consumeUcnt || 0),
    0,
  );
  const watchUcnt = list.reduce((s, x) => {
    const w = x.watchUcnt;
    if (w != null && w > 0) return s + w;
    return s + (x.peakViewers || 0);
  }, 0);
  const staySamples = list
    .map((x) => x.avgWatchMins)
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  const avgWatchMins = staySamples.length
    ? Math.round(
        (staySamples.reduce((a, b) => a + b, 0) / staySamples.length) * 10,
      ) / 10
    : null;
  const newFollowers = list.reduce((s, x) => s + (x.newFollowers || 0), 0);
  const newFansClub = list.reduce((s, x) => s + (x.newFansClub || 0), 0);
  const totalComments = list.reduce((s, x) => s + (x.totalComments || 0), 0);
  const totalLikes = list.reduce((s, x) => s + (x.totalLikes || 0), 0);
  const totalDuration = list.reduce((s, x) => s + (x.duration || 0), 0);

  const byDay = new Map<string, number>();
  // 先铺满日期轴，保证走势连续
  const daySec = 86400;
  const firstDay = startOfLocalDay(fromSec * 1000);
  for (let t = firstDay; t <= toSec; t += daySec) {
    byDay.set(dayKey(t), 0);
  }
  for (const s of list) {
    const k = dayKey(s.startTime);
    byDay.set(k, (byDay.get(k) ?? 0) + (s.totalGifts || 0));
  }
  const dailyGifts = Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, gifts]) => ({ date, gifts }));

  return {
    period,
    fromSec,
    toSec,
    sessionCount,
    totalGifts,
    giftSenders,
    watchUcnt,
    avgWatchMins,
    newFollowers,
    newFansClub,
    totalComments,
    totalLikes,
    totalDuration,
    dailyGifts,
  };
}
