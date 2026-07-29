import type { LiveGoals, LiveSession } from "./liveTypes";
import { goalProgress } from "./insights";

export type LiveAlert = {
  id: string;
  level: "warn" | "info";
  text: string;
};

/**
 * 开播中轻量规则：少而准，避免刷屏。
 * 返回最多 2 条。
 */
export function evaluateLiveAlerts(
  session: LiveSession | null,
  goals: LiveGoals | undefined,
  allSessions: LiveSession[],
  nowMs = Date.now(),
): LiveAlert[] {
  if (!session || session.endTime != null) return [];
  const pts = session.dataPoints;
  if (pts.length < 2) return [];

  const out: LiveAlert[] = [];
  const last = pts[pts.length - 1]!;
  const nowSec = Math.floor(nowMs / 1000);
  const elapsed = Math.max(0, nowSec - session.startTime);

  // 在线 3 分钟内掉超 30%（需至少 3 分钟数据）
  if (last.t >= 180) {
    const target = last.t - 180;
    let older = pts[0]!;
    for (const p of pts) {
      if (p.t <= target) older = p;
      else break;
    }
    if (older.viewers >= 20 && last.viewers < older.viewers * 0.7) {
      const drop = Math.round((1 - last.viewers / older.viewers) * 100);
      out.push({
        id: "viewers-drop",
        level: "warn",
        text: `近3分钟在线掉约 ${drop}%（${older.viewers}→${last.viewers}），可加互动或垫场`,
      });
    }
  }

  // 近 1 分钟进房率相对本场前半崩溃
  if (last.t >= 120 && last.show != null && last.enter != null) {
    const ago = (() => {
      const target = last.t - 60;
      let hit = pts[0]!;
      for (const p of pts) {
        if (p.t <= target) hit = p;
        else break;
      }
      return hit;
    })();
    const midT = Math.floor(last.t / 2);
    let mid = pts[0]!;
    for (const p of pts) {
      if (p.t <= midT) mid = p;
      else break;
    }
    const dShow = last.show - (ago.show ?? last.show);
    const dEnter = last.enter - (ago.enter ?? last.enter);
    const halfShow = mid.show ?? 0;
    const halfEnter = mid.enter ?? 0;
    if (dShow >= 50 && halfShow >= 100) {
      const recentRate = dEnter / dShow;
      const earlyRate = halfEnter / halfShow;
      if (earlyRate >= 0.05 && recentRate < earlyRate * 0.55) {
        out.push({
          id: "enter-collapse",
          level: "warn",
          text: "近1分钟进房变差，封面/推荐承接可能弱了",
        });
      }
    }
  }

  // 今日音浪目标进度 < 时间进度（播超过 20 分钟才提醒）
  if (elapsed >= 20 * 60 && goals?.dailyGifts && goals.dailyGifts > 0) {
    const gp = goalProgress(allSessions, goals, nowMs);
    const day = gp.dailyGifts;
    if (day && day.target > 0) {
      // 用「已过白天比例」粗估：从 0 点到现在，但直播侧用本场进度更贴——取本场时长占「建议 3h」或目标相对
      const giftPct = day.current / day.target;
      // 一天按 8 小时有效开播预算粗算时间进度，避免过早吓
      const dayStart = new Date(nowMs);
      dayStart.setHours(0, 0, 0, 0);
      const dayElapsed = (nowMs - dayStart.getTime()) / (8 * 3600 * 1000);
      const timePct = Math.min(1, Math.max(0.05, dayElapsed));
      if (giftPct < timePct * 0.55 && day.current < day.target) {
        out.push({
          id: "goal-lag",
          level: "info",
          text: `今日音浪 ${day.current.toLocaleString("zh-CN")}/${day.target.toLocaleString("zh-CN")}，进度偏慢`,
        });
      }
    }
  }

  // 去重并限 2 条：warn 优先
  const seen = new Set<string>();
  const sorted = out
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    })
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
  return sorted.slice(0, 2);
}
