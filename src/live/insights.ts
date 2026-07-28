import type { LiveSession, MinutePoint } from "./liveTypes";

export type SessionGrade = "hot" | "normal" | "cold";

export type InsightLine = {
  kind: "trend" | "best" | "risk" | "tip";
  text: string;
};

/** 本月日历格：周一～周日 × 1～31 号 */
export type HeatCell = {
  /** YYYY-MM-DD（本地日） */
  date: string;
  /** 当月日号 1–31 */
  day: number;
  /** Date.getDay()：0=周日 … 6=周六 */
  weekday: number;
  /** 周一=0 … 周日=6 */
  weekdayMon: number;
  avgGifts: number;
  count: number;
};

/** 周几×小时聚合（开播建议用） */
export type WeekdayHeatCell = {
  weekday: number;
  hour: number;
  avgGifts: number;
  count: number;
};

export type SlotAdvice = {
  text: string;
  bestWeekday: number;
  bestHour: number;
  avgGifts: number;
  shortVsNormalText: string | null;
};

export type MinuteMoment = {
  kind: "high" | "low";
  label: string;
  clock: string;
  value: number;
};

export type SessionInsight = {
  grade: SessionGrade;
  gradeLabel: string;
  lines: string[];
  diagnosis: string | null;
  moments: MinuteMoment[];
  vsMedian: {
    giftsPct: number | null;
    followersPct: number | null;
    durationPct: number | null;
  };
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function sortedByStart(sessions: LiveSession[]): LiveSession[] {
  return sessions.slice().sort((a, b) => b.startTime - a.startTime);
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

function mean(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function pctChange(cur: number, base: number): number | null {
  if (!base) return null;
  return ((cur - base) / base) * 100;
}

function fmtPct(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return "—";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(0)}%`;
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分钟`;
}

function inWindow(sessions: LiveSession[], nowSec: number, fromAgo: number, toAgo: number) {
  return sessions.filter(
    (s) => s.startTime >= nowSec - fromAgo && s.startTime < nowSec - toAgo,
  );
}

/** 近 7 场（不含当前）中位数基准 */
export function recentMedianBaseline(
  sessions: LiveSession[],
  excludeId?: string,
  n = 7,
): { gifts: number; followers: number; duration: number } | null {
  const pool = sortedByStart(sessions)
    .filter((s) => s.id !== excludeId)
    .slice(0, n);
  if (pool.length < 3) return null;
  return {
    gifts: median(pool.map((s) => s.totalGifts)) ?? 0,
    followers: median(pool.map((s) => s.newFollowers)) ?? 0,
    duration: median(pool.map((s) => s.duration)) ?? 0,
  };
}

export function gradeSession(
  session: LiveSession,
  baseline: { gifts: number } | null,
): SessionGrade {
  if (!baseline || baseline.gifts <= 0) return "normal";
  const ratio = session.totalGifts / baseline.gifts;
  if (ratio >= 1.25) return "hot";
  if (ratio <= 0.75) return "cold";
  return "normal";
}

export function gradeLabel(g: SessionGrade): string {
  if (g === "hot") return "爆发";
  if (g === "cold") return "偏冷";
  return "正常";
}

export function buildOverviewInsights(sessions: LiveSession[], now = Date.now()): InsightLine[] {
  const list = sortedByStart(sessions);
  if (!list.length) return [];
  const nowSec = Math.floor(now / 1000);
  const d7 = 7 * 86400;
  const last7 = inWindow(list, nowSec, d7, 0);
  const prev7 = inWindow(list, nowSec, 2 * d7, d7);
  const lines: InsightLine[] = [];

  if (last7.length && prev7.length) {
    const gPct = pctChange(
      last7.reduce((s, x) => s + x.totalGifts, 0),
      prev7.reduce((s, x) => s + x.totalGifts, 0),
    );
    const fPct = pctChange(
      last7.reduce((s, x) => s + x.newFollowers, 0),
      prev7.reduce((s, x) => s + x.newFollowers, 0),
    );
    const durPct = pctChange(
      mean(last7.map((x) => x.duration)),
      mean(prev7.map((x) => x.duration)),
    );
    lines.push({
      kind: "trend",
      text: `近7天相对前7天：音浪 ${fmtPct(gPct)}，涨粉 ${fmtPct(fPct)}，场均时长 ${fmtPct(durPct)}`,
    });
  } else if (last7.length) {
    lines.push({
      kind: "trend",
      text: `近7天共 ${last7.length} 场，音浪 ${last7.reduce((s, x) => s + x.totalGifts, 0).toLocaleString("zh-CN")}，涨粉 ${last7.reduce((s, x) => s + x.newFollowers, 0)}`,
    });
  }

  const week = inWindow(list, nowSec, d7, 0);
  if (week.length) {
    const bestG = week.reduce((a, b) => (b.totalGifts > a.totalGifts ? b : a));
    const bestF = week.reduce((a, b) => (b.newFollowers > a.newFollowers ? b : a));
    const d = new Date(bestG.startTime * 1000);
    lines.push({
      kind: "best",
      text: `近7天音浪最佳：${d.getMonth() + 1}/${d.getDate()}「${bestG.title.slice(0, 16)}」${bestG.totalGifts.toLocaleString("zh-CN")} 音浪`,
    });
    if (bestF.id !== bestG.id && bestF.newFollowers > 0) {
      const df = new Date(bestF.startTime * 1000);
      lines.push({
        kind: "best",
        text: `近7天涨粉最佳：${df.getMonth() + 1}/${df.getDate()} +${bestF.newFollowers} 粉`,
      });
    }
  }

  const last14 = list.slice(0, 14);
  const med = median(last14.map((s) => s.totalGifts));
  if (med != null && med > 0 && list.length >= 5) {
    let streak = 0;
    for (const s of list) {
      if (s.totalGifts < med * 0.75) streak += 1;
      else break;
    }
    if (streak >= 3) {
      lines.push({
        kind: "risk",
        text: `最近连续 ${streak} 场音浪低于近况中位，状态偏冷，可优先挑黄金时段开`,
      });
    }
  }

  const portrait = list.find((s) => s.audiencePortrait)?.audiencePortrait;
  if (portrait) {
    const bits: string[] = [];
    if (portrait.malePct != null && portrait.malePct >= 70) {
      bits.push(`男性约 ${portrait.malePct}%`);
    }
    if (portrait.nonFanPct != null && portrait.nonFanPct >= 80) {
      bits.push(`路人约 ${portrait.nonFanPct}%（涨粉空间大）`);
    }
    if (portrait.hobbyText) bits.push(portrait.hobbyText.replace(/居多$/, ""));
    if (portrait.regionText) bits.push(portrait.regionText.replace(/居多$/, ""));
    if (bits.length) {
      lines.push({
        kind: "tip",
        text: `最近观众：${bits.slice(0, 3).join(" · ")}`,
      });
    }
  }

  const withTraffic = list.find((s) => s.trafficChannels?.length);
  if (withTraffic?.trafficChannels?.length) {
    const top = withTraffic.trafficChannels[0];
    if (top.watchPct != null && top.watchPct >= 85 && /推荐/.test(top.name)) {
      lines.push({
        kind: "tip",
        text: `最近一场约 ${top.watchPct.toFixed(0)}% 来自${top.name}，关注页占比低，开播前半小时多引导关注/进房承接`,
      });
    }
  }

  const withFunnel = list.find((s) => s.trafficFunnel);
  const fun = withFunnel?.trafficFunnel;
  if (fun?.enterRateDiff != null && fun.enterRateDiff <= -2) {
    lines.push({
      kind: "risk",
      text: `最近进房率较近7场低 ${Math.abs(fun.enterRateDiff).toFixed(1)} 个点，优先改封面与开场 30 秒`,
    });
  } else if (fun?.payRateDiff != null && fun.payRateDiff <= -1.5) {
    lines.push({
      kind: "risk",
      text: `最近付费转化较近7场低 ${Math.abs(fun.payRateDiff).toFixed(1)} 个点，检查福利节奏与付费引导`,
    });
  } else if (
    fun?.showUcnt &&
    fun.enterUcnt != null &&
    fun.showUcnt > 0 &&
    fun.enterUcnt / fun.showUcnt < 0.04
  ) {
    lines.push({
      kind: "risk",
      text: `最近进房率约 ${((fun.enterUcnt / fun.showUcnt) * 100).toFixed(1)}%，曝光没接住，优先改封面/开场`,
    });
  }

  const withMinutes = list.find((s) => s.minuteTrend && s.minuteTrend.length >= 2);
  if (withMinutes?.minuteTrend?.length) {
    const peak = withMinutes.minuteTrend.reduce((a, b) =>
      b.gifts > a.gifts ? b : a,
    );
    if (peak.gifts > 0) {
      const clock = peak.t.match(/(\d{1,2}:\d{2})(?::\d{2})?$/)?.[1] || peak.t;
      lines.push({
        kind: "tip",
        text: `最近高光在 ${clock}（音浪峰值 ${peak.gifts.toLocaleString("zh-CN")}），可复盘该时段话术/互动`,
      });
    }
  }

  const withMaint = list.find(
    (s) =>
      (s.audienceMaintenance?.lostCount ?? 0) > 0 ||
      (s.audienceMaintenance?.highValueCount ?? 0) > 0,
  );
  if (withMaint?.audienceMaintenance) {
    const m = withMaint.audienceMaintenance;
    if ((m.lostCount ?? 0) > 0) {
      lines.push({
        kind: "risk",
        text: `最近一场流失相关 ${m.lostCount} 人${m.note ? `（${m.note}）` : ""}，优先私信/粉丝群召回贡献下降用户`,
      });
    } else if ((m.highValueCount ?? 0) > 0) {
      const samples = m.highValueSamples?.slice(0, 2).join("、");
      lines.push({
        kind: "tip",
        text: `最近高活跃贡献榜 ${m.highValueCount} 人${samples ? `（如 ${samples}）` : ""}，开播前可点名互动稳场`,
      });
    }
  }

  const paid = list.find((s) => s.portraitSlices?.paid)?.portraitSlices?.paid;
  const allP = list.find((s) => s.portraitSlices?.all || s.audiencePortrait);
  const allSlice = allP?.portraitSlices?.all ?? allP?.audiencePortrait;
  if (paid?.malePct != null && allSlice?.malePct != null) {
    const d = Math.abs(paid.malePct - allSlice.malePct);
    if (d >= 12) {
      lines.push({
        kind: "tip",
        text: `付费观众性别结构与全部差约 ${d.toFixed(0)} 个点，福利话术可按付费画像单独调`,
      });
    }
  }

  return lines.slice(0, 4);
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 周一=0 … 周日=6 */
function weekdayMon(jsDay: number): number {
  return (jsDay + 6) % 7;
}

/** 本月：每天一格（1～当月最后一天），按周几落位 */
export function buildHeatmap(
  sessions: LiveSession[],
  _daysIgnored = 30,
  now = Date.now(),
): HeatCell[] {
  const anchor = new Date(now);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthStart = Math.floor(new Date(year, month, 1).getTime() / 1000);
  const monthEnd = Math.floor(new Date(year, month + 1, 1).getTime() / 1000);

  const buckets = new Map<string, { sum: number; count: number }>();
  for (const s of sessions) {
    if (s.startTime < monthStart || s.startTime >= monthEnd) continue;
    const d = new Date(s.startTime * 1000);
    const key = ymdLocal(d);
    const cur = buckets.get(key) ?? { sum: 0, count: 0 };
    cur.sum += s.totalGifts;
    cur.count += 1;
    buckets.set(key, cur);
  }

  const cells: HeatCell[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day, 12, 0, 0, 0);
    const date = ymdLocal(d);
    const wd = d.getDay();
    const v = buckets.get(date);
    cells.push({
      date,
      day,
      weekday: wd,
      weekdayMon: weekdayMon(wd),
      // 日历格用当日音浪合计
      avgGifts: v ? Math.round(v.sum) : 0,
      count: v?.count ?? 0,
    });
  }
  return cells;
}

function buildWeekdayHeatmap(
  sessions: LiveSession[],
  days = 30,
  now = Date.now(),
): WeekdayHeatCell[] {
  const nowSec = Math.floor(now / 1000);
  const from = nowSec - days * 86400;
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const s of sessions) {
    if (s.startTime < from) continue;
    const d = new Date(s.startTime * 1000);
    const key = `${d.getDay()}_${d.getHours()}`;
    const cur = buckets.get(key) ?? { sum: 0, count: 0 };
    cur.sum += s.totalGifts;
    cur.count += 1;
    buckets.set(key, cur);
  }
  const cells: WeekdayHeatCell[] = [];
  for (const [key, v] of buckets) {
    const [wd, hour] = key.split("_").map(Number);
    cells.push({
      weekday: wd!,
      hour: hour!,
      avgGifts: Math.round(v.sum / v.count),
      count: v.count,
    });
  }
  return cells;
}

export function buildSlotAdvice(sessions: LiveSession[], now = Date.now()): SlotAdvice | null {
  const cells = buildWeekdayHeatmap(sessions, 30, now).filter((c) => c.count >= 2);
  if (!cells.length) return null;
  const best = cells.reduce((a, b) => (b.avgGifts > a.avgGifts ? b : a));
  const short = sessions.filter((s) => s.duration > 0 && s.duration < 1800);
  const normal = sessions.filter((s) => s.duration >= 1800);
  let shortVsNormalText: string | null = null;
  if (short.length >= 3 && normal.length >= 3) {
    const sg = mean(short.map((s) => s.totalGifts));
    const ng = mean(normal.map((s) => s.totalGifts));
    if (ng > 0) {
      const ratio = sg / ng;
      shortVsNormalText =
        ratio < 0.7
          ? `不足30分钟的场场均音浪只有正常场的 ${(ratio * 100).toFixed(0)}%，短开不太划算`
          : `短开（<30分钟）与正常场场均音浪接近（${(ratio * 100).toFixed(0)}%）`;
    }
  }
  const hourEnd = (best.hour + 1) % 24;
  return {
    bestWeekday: best.weekday,
    bestHour: best.hour,
    avgGifts: best.avgGifts,
    text: `近30天：${WEEKDAYS[best.weekday]} ${best.hour}:00–${hourEnd}:00 场均音浪最高（约 ${best.avgGifts.toLocaleString("zh-CN")}，样本 ${best.count} 场）`,
    shortVsNormalText,
  };
}

export function buildSessionInsight(
  session: LiveSession,
  all: LiveSession[],
): SessionInsight {
  const baseline = recentMedianBaseline(all, session.id, 7);
  const grade = gradeSession(session, baseline);
  const giftsPct = baseline ? pctChange(session.totalGifts, baseline.gifts) : null;
  const followersPct = baseline ? pctChange(session.newFollowers, baseline.followers) : null;
  const durationPct = baseline ? pctChange(session.duration, baseline.duration) : null;
  const moments = labelMinuteMoments(session.minuteTrend);
  const diagnosis = diagnoseSession(session, all);
  const lines: string[] = [];
  if (baseline) {
    lines.push(
      `音浪相对近7场中位 ${fmtPct(giftsPct)}（本场 ${session.totalGifts.toLocaleString("zh-CN")} / 中位 ${Math.round(baseline.gifts).toLocaleString("zh-CN")}）`,
    );
    lines.push(
      `涨粉相对近7场中位 ${fmtPct(followersPct)}（本场 +${session.newFollowers} / 中位 ${Math.round(baseline.followers)}）`,
    );
    lines.push(
      `时长相对近7场中位 ${fmtPct(durationPct)}（本场 ${fmtDur(session.duration)} / 中位 ${fmtDur(baseline.duration)}）`,
    );
  } else {
    lines.push("近况场次不足，暂用绝对值展示；多开几场后会有对比结论");
  }
  if (diagnosis) lines.push(`诊断：${diagnosis}`);
  for (const m of moments.slice(0, 3)) {
    lines.push(
      `${m.kind === "high" ? "高光" : "低谷"} · ${m.label} ${m.clock}（${m.value.toLocaleString("zh-CN")}）`,
    );
  }
  return {
    grade,
    gradeLabel: gradeLabel(grade),
    lines,
    diagnosis,
    moments,
    vsMedian: { giftsPct, followersPct, durationPct },
  };
}

export type SortKey = "date" | "gifts" | "followers" | "duration";
export type RangeKey = "7d" | "30d" | "all";

export function filterAndSortSessions(
  sessions: LiveSession[],
  range: RangeKey,
  sort: SortKey,
  now = Date.now(),
): LiveSession[] {
  const nowSec = Math.floor(now / 1000);
  let list = sessions.slice();
  if (range === "7d") list = list.filter((s) => s.startTime >= nowSec - 7 * 86400);
  if (range === "30d") list = list.filter((s) => s.startTime >= nowSec - 30 * 86400);
  list.sort((a, b) => {
    if (sort === "gifts") return b.totalGifts - a.totalGifts;
    if (sort === "followers") return b.newFollowers - a.newFollowers;
    if (sort === "duration") return b.duration - a.duration;
    return b.startTime - a.startTime;
  });
  return list;
}

/** 效率指标（有深采或时长时） */
export function efficiency(session: LiveSession): {
  giftsPerHour: number;
  followersPerHour: number;
  giftsPerViewer: number | null;
} {
  const hours = Math.max(session.duration / 3600, 1 / 60);
  const viewers =
    session.avgViewers || session.peakViewers || session.watchUcnt || 0;
  return {
    giftsPerHour: Math.round(session.totalGifts / hours),
    followersPerHour: Math.round((session.newFollowers / hours) * 10) / 10,
    giftsPerViewer: viewers > 0 ? Math.round((session.totalGifts / viewers) * 10) / 10 : null,
  };
}

export function goalProgress(
  sessions: LiveSession[],
  goals: {
    dailyGifts?: number;
    weeklyFollowers?: number;
    weeklyDurationSec?: number;
  },
  now = Date.now(),
): {
  dailyGifts: { target: number; current: number } | null;
  weeklyFollowers: { target: number; current: number } | null;
  weeklyDuration: { target: number; current: number } | null;
} {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(d.getTime() / 1000);
  const monday = new Date(d);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weekSec = Math.floor(monday.getTime() / 1000);

  const today = sessions.filter((s) => s.startTime >= dayStart);
  const week = sessions.filter((s) => s.startTime >= weekSec);

  return {
    dailyGifts: goals.dailyGifts
      ? {
          target: goals.dailyGifts,
          current: today.reduce((s, x) => s + x.totalGifts, 0),
        }
      : null,
    weeklyFollowers: goals.weeklyFollowers
      ? {
          target: goals.weeklyFollowers,
          current: week.reduce((s, x) => s + x.newFollowers, 0),
        }
      : null,
    weeklyDuration: goals.weeklyDurationSec
      ? {
          target: goals.weeklyDurationSec,
          current: week.reduce((s, x) => s + x.duration, 0),
        }
      : null,
  };
}

function shortClock(t: string): string {
  const m = t.match(/(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : t;
}

/** 分钟走势：高光 / 低谷自动标注 */
export function labelMinuteMoments(points: MinutePoint[] | null | undefined): MinuteMoment[] {
  if (!points || points.length < 3) return [];
  const out: MinuteMoment[] = [];
  const by = <K extends keyof MinutePoint>(key: K) =>
    points.reduce((best, cur) =>
      Number(cur[key] ?? 0) > Number(best[key] ?? 0) ? cur : best,
    );
  const giftPeak = by("gifts");
  if (giftPeak.gifts > 0) {
    out.push({
      kind: "high",
      label: "音浪峰值",
      clock: shortClock(giftPeak.t),
      value: giftPeak.gifts,
    });
  }
  const viewPeak = by("viewers");
  if (viewPeak.viewers > 0) {
    out.push({
      kind: "high",
      label: "在线峰值",
      clock: shortClock(viewPeak.t),
      value: viewPeak.viewers,
    });
  }
  const fanPeak = by("followers");
  if (fanPeak.followers > 0) {
    out.push({
      kind: "high",
      label: "涨粉峰值",
      clock: shortClock(fanPeak.t),
      value: fanPeak.followers,
    });
  }
  const leavePeak = by("leave");
  if ((leavePeak.leave ?? 0) > 0) {
    out.push({
      kind: "low",
      label: "离开高峰",
      clock: shortClock(leavePeak.t),
      value: leavePeak.leave ?? 0,
    });
  }
  // 峰值之后的在线低谷（至少落后 3 分钟）
  const peakIdx = points.findIndex((p) => p.t === viewPeak.t);
  if (peakIdx >= 0 && peakIdx < points.length - 3) {
    const after = points.slice(peakIdx + 2);
    const trough = after.reduce((best, cur) =>
      cur.viewers < best.viewers ? cur : best,
    );
    if (
      viewPeak.viewers >= 5 &&
      trough.viewers <= viewPeak.viewers * 0.45 &&
      trough.viewers < viewPeak.viewers - 2
    ) {
      out.push({
        kind: "low",
        label: "在线低谷",
        clock: shortClock(trough.t),
        value: trough.viewers,
      });
    }
  }
  // 去重：同钟点同 kind 只留一条
  const seen = new Set<string>();
  return out.filter((m) => {
    const k = `${m.kind}:${m.clock}:${m.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 5);
}

/** 单场一句话诊断（可执行） */
export function diagnoseSession(
  session: LiveSession,
  all: LiveSession[],
): string | null {
  const fun = session.trafficFunnel;
  const ch = session.trafficChannels?.[0];
  const moments = labelMinuteMoments(session.minuteTrend);
  const giftHigh = moments.find((m) => m.label === "音浪峰值");
  const leaveLow = moments.find((m) => m.label === "离开高峰");
  const trough = moments.find((m) => m.label === "在线低谷");

  if (fun?.enterRateDiff != null && fun.enterRateDiff <= -2) {
    return `进房率较近7场低 ${Math.abs(fun.enterRateDiff).toFixed(1)} 个点，优先改封面与开场 30 秒`;
  }
  if (fun?.payRateDiff != null && fun.payRateDiff <= -1.5) {
    return `付费转化较近7场低 ${Math.abs(fun.payRateDiff).toFixed(1)} 个点，检查福利节奏与付费引导`;
  }
  if (ch?.watchPct != null && ch.watchPct >= 85 && /推荐/.test(ch.name)) {
    return `约 ${ch.watchPct.toFixed(0)}% 来自${ch.name}，关注承接偏弱，开播前半小时多推关注/进房`;
  }
  if (leaveLow && giftHigh && leaveLow.clock !== giftHigh.clock) {
    return `${leaveLow.clock} 离开偏多，对照 ${giftHigh.clock} 高光话术，避免同段冷场`;
  }
  if (trough) {
    return `${trough.clock} 在线掉到 ${trough.value}，复盘该段是否断档或节奏拖沓`;
  }
  if (giftHigh) {
    return `高光在 ${giftHigh.clock}（音浪 ${giftHigh.value.toLocaleString("zh-CN")}），可固化该时段互动`;
  }
  const baseline = recentMedianBaseline(all, session.id, 7);
  if (baseline && baseline.gifts > 0) {
    const ratio = session.totalGifts / baseline.gifts;
    if (ratio <= 0.75) return "本场音浪低于近7场中位，下次优先挑黄金时段并提前 10 分钟暖场";
    if (ratio >= 1.25) return "本场音浪高于近7场中位，记下开场与福利节点方便复用";
  }
  return null;
}

export type LiveAlert = {
  level: "warn" | "ok" | "info";
  text: string;
};

const DROP_PCT = 0.25;
const DROP_POINTS = 3;

/** 直播中盯盘：掉速 + 音浪节奏 vs 近7场 */
export function buildLiveAlerts(
  session: LiveSession,
  all: LiveSession[],
): LiveAlert[] {
  const alerts: LiveAlert[] = [];
  const pts = session.dataPoints;
  if (pts.length >= DROP_POINTS + 1) {
    const recent = pts.slice(-DROP_POINTS);
    const prev = pts[pts.length - DROP_POINTS - 1]!;
    const last = recent[recent.length - 1]!;
    const base = Math.max(prev.viewers, 1);
    const drop = (base - last.viewers) / base;
    if (drop >= DROP_PCT && last.viewers < prev.viewers) {
      alerts.push({
        level: "warn",
        text: `近 ${DROP_POINTS * 10} 秒在线从 ${prev.viewers} 掉到 ${last.viewers}（约 -${Math.round(drop * 100)}%），赶紧抛互动/福利拉回`,
      });
    } else if (last.viewers >= base * 1.35 && last.viewers - prev.viewers >= 3) {
      alerts.push({
        level: "ok",
        text: `近 ${DROP_POINTS * 10} 秒在线抬头（${prev.viewers}→${last.viewers}），抓住窗口推进转化`,
      });
    }
  }

  const baseline = recentMedianBaseline(all, session.id, 7);
  if (baseline && baseline.duration > 0 && baseline.gifts > 0) {
    const elapsed = Math.max(
      session.duration,
      session.endTime != null
        ? session.duration
        : Math.max(0, Math.floor(Date.now() / 1000) - session.startTime),
      60,
    );
    const pace = session.totalGifts / (elapsed / 3600);
    const medPace = baseline.gifts / (baseline.duration / 3600);
    if (medPace > 0 && elapsed >= 8 * 60) {
      const ratio = pace / medPace;
      if (ratio <= 0.55) {
        alerts.push({
          level: "warn",
          text: `音浪时速约 ${Math.round(pace)}，只有近7场中位的 ${Math.round(ratio * 100)}%，节奏偏慢`,
        });
      } else if (ratio >= 1.3) {
        alerts.push({
          level: "ok",
          text: `音浪时速约 ${Math.round(pace)}，高于近7场中位，保持当前节奏`,
        });
      }
    }
  }

  const tip = buildLiveTip(session, all);
  if (tip && alerts.length < 2) {
    alerts.push({ level: "info", text: tip });
  }
  return alerts.slice(0, 3);
}

/** 直播中：相对近 7 场中位的一句话提示 */
export function buildLiveTip(
  session: LiveSession,
  all: LiveSession[],
): string | null {
  const baseline = recentMedianBaseline(all, session.id, 7);
  if (!baseline || baseline.gifts <= 0) return null;
  const gifts = session.totalGifts;
  const ratio = gifts / baseline.gifts;
  const med = Math.round(baseline.gifts);
  if (ratio >= 1.25) {
    return `本场音浪已超近7场中位（${med.toLocaleString("zh-CN")}），状态不错，可继续稳住节奏`;
  }
  if (ratio >= 0.9) {
    return `本场音浪接近近7场中位（${med.toLocaleString("zh-CN")}），还差 ${Math.max(0, med - gifts).toLocaleString("zh-CN")}`;
  }
  if (ratio >= 0.6) {
    return `本场音浪低于近7场中位（${med.toLocaleString("zh-CN")}），还差 ${Math.max(0, med - gifts).toLocaleString("zh-CN")} 到中位线`;
  }
  return `本场音浪明显低于近7场中位（${med.toLocaleString("zh-CN")}），可尝试互动或游戏节点拉一拉`;
}

/** 复盘小报（纯文本，可复制） */
export function buildSessionReportText(
  session: LiveSession,
  all: LiveSession[],
): string {
  const insight = buildSessionInsight(session, all);
  const d = new Date(session.startTime * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const lines: string[] = [
    `【FLYBOX 复盘】${when} · ${session.title || "未命名"}`,
    `评级：${insight.gradeLabel} · 时长 ${fmtDur(session.duration)}`,
    `音浪 ${session.totalGifts.toLocaleString("zh-CN")} · 涨粉 +${session.newFollowers} · 峰值在线 ${session.peakViewers || session.watchUcnt || 0}`,
  ];
  for (const l of insight.lines) lines.push(`· ${l}`);
  const ch = session.trafficChannels?.[0];
  if (ch?.watchPct != null) {
    lines.push(`流量：${ch.name} ${ch.watchPct.toFixed(1)}%` +
      (ch.consumePct != null ? `（营收 ${ch.consumePct.toFixed(1)}%）` : ""));
  }
  const fun = session.trafficFunnel;
  if (fun) {
    const er =
      fun.enterRate && fun.enterRate > 0
        ? fun.enterRate
        : fun.showUcnt && fun.enterUcnt != null && fun.showUcnt > 0
          ? Math.round((fun.enterUcnt / fun.showUcnt) * 1000) / 10
          : null;
    const pr =
      fun.payRate && fun.payRate > 0
        ? fun.payRate
        : fun.enterUcnt && fun.payUcnt != null && fun.enterUcnt > 0
          ? Math.round((fun.payUcnt / fun.enterUcnt) * 1000) / 10
          : null;
    lines.push(
      `漏斗：曝光 ${fun.showUcnt ?? "—"} → 进房 ${fun.enterUcnt ?? "—"}${er != null ? `（${er}%）` : ""} → 付费 ${fun.payUcnt ?? "—"}${pr != null ? `（${pr}%）` : ""}`,
    );
  }
  const p = session.audiencePortrait;
  if (p) {
    const bits = [p.genderText, p.ageText, p.regionText, p.hobbyText]
      .filter(Boolean)
      .slice(0, 3);
    if (bits.length) lines.push(`画像：${bits.join(" · ")}`);
  }
  const paid = session.portraitSlices?.paid;
  if (paid?.genderText || paid?.ageText) {
    lines.push(
      `付费画像：${[paid.genderText, paid.ageText, paid.hobbyText].filter(Boolean).slice(0, 2).join(" · ")}`,
    );
  }
  const m = session.audienceMaintenance;
  if (m) {
    lines.push(
      `观众维护：流失 ${m.lostCount ?? "—"} · 高活跃 ${m.highValueCount ?? "—"}${m.note ? ` · ${m.note}` : ""}`,
    );
  }
  const moments = labelMinuteMoments(session.minuteTrend);
  if (moments.length) {
    lines.push(
      `节点：${moments.map((x) => `${x.label}${x.clock}(${x.value})`).join(" · ")}`,
    );
  }
  if (insight.diagnosis) lines.push(`诊断：${insight.diagnosis}`);
  return lines.join("\n");
}

/** 按近 14 天表现给一版更贴身的目标（仅建议值） */
export function suggestedGoals(
  sessions: LiveSession[],
  now = Date.now(),
): { dailyGifts: number; weeklyFollowers: number; weeklyDurationSec: number } {
  const nowSec = Math.floor(now / 1000);
  const last14 = sessions.filter((s) => s.startTime >= nowSec - 14 * 86400);
  const pool = last14.length >= 5 ? last14 : sessions.slice(0, 20);
  if (!pool.length) {
    return { dailyGifts: 3000, weeklyFollowers: 30, weeklyDurationSec: 20 * 3600 };
  }
  const byDay = new Map<string, number>();
  for (const s of pool) {
    const key = new Date(s.startTime * 1000).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + s.totalGifts);
  }
  const dayGifts = [...byDay.values()];
  const daily = Math.max(500, Math.round((median(dayGifts) || mean(dayGifts)) * 1.05));
  const weekFans = pool.reduce((s, x) => s + x.newFollowers, 0);
  const spanDays = Math.max(
    1,
    (Math.max(...pool.map((s) => s.startTime)) -
      Math.min(...pool.map((s) => s.startTime))) /
      86400,
  );
  const weeklyFollowers = Math.max(
    5,
    Math.round((weekFans / spanDays) * 7 * 1.1),
  );
  const totalDur = pool.reduce((s, x) => s + x.duration, 0);
  const weeklyDurationSec = Math.max(
    5 * 3600,
    Math.round((totalDur / spanDays) * 7 * 1.05),
  );
  return {
    dailyGifts: daily,
    weeklyFollowers,
    weeklyDurationSec,
  };
}

export { WEEKDAYS };
