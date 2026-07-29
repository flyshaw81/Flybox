import type { LiveSession } from "./liveTypes";
import { upsertSession } from "./liveStore";

const MATCH_WINDOW_SEC = 20 * 60;

/** 本地开播 id（时间戳样式）与抖音历史 room 数字 id 不同 */
export function isRemoteRoomId(id: string): boolean {
  return /^\d{10,}$/.test(id);
}

/**
 * 在已有列表里找与本场时间最接近的历史场（优先远程 id）。
 */
export function findHistoryMatch(
  local: LiveSession,
  sessions: LiveSession[],
): LiveSession | null {
  let best: LiveSession | null = null;
  let bestDelta = MATCH_WINDOW_SEC + 1;
  for (const s of sessions) {
    if (s.id === local.id) continue;
    if (!isRemoteRoomId(s.id) && s.dataPoints.length <= local.dataPoints.length) {
      continue;
    }
    const d = Math.abs(s.startTime - local.startTime);
    if (d > MATCH_WINDOW_SEC) continue;
    // 远程 id 优先：同等时间差时选 room id
    const score = d - (isRemoteRoomId(s.id) ? 0.5 : 0);
    if (score < bestDelta) {
      bestDelta = score;
      best = s;
    }
  }
  return best;
}

/** 实时曲线 + 历史复盘字段合并到一场 */
export function mergeLocalIntoRemote(
  local: LiveSession,
  remote: LiveSession,
): LiveSession {
  const dataPoints =
    local.dataPoints.length >= remote.dataPoints.length
      ? local.dataPoints
      : remote.dataPoints;
  return {
    ...remote,
    title:
      local.title && local.title !== "直播场次" ? local.title : remote.title,
    startTime: Math.min(local.startTime, remote.startTime),
    endTime:
      local.endTime != null && remote.endTime != null
        ? Math.max(local.endTime, remote.endTime)
        : local.endTime ?? remote.endTime,
    duration: Math.max(local.duration, remote.duration),
    peakViewers: Math.max(local.peakViewers, remote.peakViewers),
    avgViewers: Math.max(local.avgViewers, remote.avgViewers),
    totalGifts: Math.max(local.totalGifts, remote.totalGifts),
    giftSenders: Math.max(local.giftSenders, remote.giftSenders),
    newFollowers: Math.max(local.newFollowers, remote.newFollowers),
    newFansClub: Math.max(local.newFansClub, remote.newFansClub),
    totalLikes: Math.max(local.totalLikes, remote.totalLikes),
    totalComments: Math.max(local.totalComments, remote.totalComments),
    totalShares: Math.max(local.totalShares, remote.totalShares),
    dataPoints,
    showUcnt: remote.showUcnt ?? local.showUcnt,
    enterUcnt: remote.enterUcnt ?? local.enterUcnt,
    enterRate: remote.enterRate ?? local.enterRate,
    stayRate: remote.stayRate ?? local.stayRate,
    giftRate: remote.giftRate ?? local.giftRate,
    avgWatchMins: remote.avgWatchMins ?? local.avgWatchMins,
    consumeUcnt: remote.consumeUcnt ?? local.consumeUcnt,
    consumeRate: remote.consumeRate ?? local.consumeRate,
    watchUcnt: remote.watchUcnt ?? local.watchUcnt,
    audiencePortrait: remote.audiencePortrait ?? local.audiencePortrait,
    portraitSlices: remote.portraitSlices ?? local.portraitSlices,
    audienceMaintenance: remote.audienceMaintenance ?? local.audienceMaintenance,
    trafficChannels: remote.trafficChannels ?? local.trafficChannels,
    trafficFunnel: remote.trafficFunnel ?? local.trafficFunnel,
    minuteTrend: remote.minuteTrend?.length
      ? remote.minuteTrend
      : local.minuteTrend,
  };
}

/**
 * 下播闭环：用本地实时场 dig 历史，合并后去掉孤儿本地 id。
 * 返回应打开的详情 id。
 */
export function closeLocalSessionWithHistory(
  sessions: LiveSession[],
  localDone: LiveSession,
): { sessions: LiveSession[]; detailId: string } {
  const withLocal = upsertSession(sessions, localDone);
  const match = findHistoryMatch(localDone, withLocal);
  if (!match) {
    return { sessions: withLocal, detailId: localDone.id };
  }
  const merged = mergeLocalIntoRemote(localDone, match);
  let next = upsertSession(withLocal, merged);
  if (localDone.id !== merged.id) {
    next = next.filter((s) => s.id !== localDone.id);
  }
  return { sessions: next, detailId: merged.id };
}
