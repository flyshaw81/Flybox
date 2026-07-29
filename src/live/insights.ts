import type { LiveSession, MinutePoint } from "./liveTypes";
import {
  localizeChannelName,
  localizePortraitText,
} from "./localizeDisplay";

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

export type MomentId =
  | "giftPeak"
  | "viewerPeak"
  | "fanPeak"
  | "leavePeak"
  | "viewerTrough";

export type MinuteMoment = {
  kind: "high" | "low";
  id: MomentId;
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

/** i18n lookup — same shape as useI18n().t */
export type TFn = (key: string) => string;

function asT(tr: unknown): TFn {
  return typeof tr === "function" ? (tr as TFn) : (key: string) => key;
}

export function tf(
  tr: unknown,
  key: string,
  vars?: Record<string, string | number>,
): string {
  let s = asT(tr)(key);
  if (!vars) return s;
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

function loc(locale: string): string {
  return locale === "en" ? "en-US" : "zh-CN";
}

function num(n: number, locale: string): string {
  return n.toLocaleString(loc(locale));
}

function weekdayName(tr: TFn, jsDay: number): string {
  return tr(`liveWd${jsDay}` as "liveWd0");
}

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

function fmtDur(sec: number, tr: TFn): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return tf(tr, "liveUnitHourMin", { h, m });
  return tf(tr, "liveUnitMinOnly", { m });
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

export function gradeLabel(g: SessionGrade, tr: TFn): string {
  const t = asT(tr);
  if (g === "hot") return t("liveGradeHot");
  if (g === "cold") return t("liveGradeCold");
  return t("liveGradeNormal");
}

export function buildOverviewInsights(
  sessions: LiveSession[],
  tr: TFn,
  locale = "zh",
  now = Date.now(),
): InsightLine[] {
  const t = asT(tr);
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
      text: tf(t, "liveInsTrendCompare", {
        gifts: fmtPct(gPct),
        fans: fmtPct(fPct),
        dur: fmtPct(durPct),
      }),
    });
  } else if (last7.length) {
    lines.push({
      kind: "trend",
      text: tf(t, "liveInsTrendOnly", {
        n: last7.length,
        gifts: num(
          last7.reduce((s, x) => s + x.totalGifts, 0),
          locale,
        ),
        fans: last7.reduce((s, x) => s + x.newFollowers, 0),
      }),
    });
  }

  const week = inWindow(list, nowSec, d7, 0);
  if (week.length) {
    const bestG = week.reduce((a, b) => (b.totalGifts > a.totalGifts ? b : a));
    const bestF = week.reduce((a, b) => (b.newFollowers > a.newFollowers ? b : a));
    const d = new Date(bestG.startTime * 1000);
    lines.push({
      kind: "best",
      text: tf(t, "liveInsBestGifts", {
        date: `${d.getMonth() + 1}/${d.getDate()}`,
        title: bestG.title.slice(0, 16),
        gifts: num(bestG.totalGifts, locale),
      }),
    });
    if (bestF.id !== bestG.id && bestF.newFollowers > 0) {
      const df = new Date(bestF.startTime * 1000);
      lines.push({
        kind: "best",
        text: tf(t, "liveInsBestFans", {
          date: `${df.getMonth() + 1}/${df.getDate()}`,
          fans: bestF.newFollowers,
        }),
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
        text: tf(t, "liveInsColdStreak", { n: streak }),
      });
    }
  }

  const portrait = list.find((s) => s.audiencePortrait)?.audiencePortrait;
  if (portrait) {
    const bits: string[] = [];
    if (portrait.malePct != null && portrait.malePct >= 70) {
      bits.push(tf(t, "liveInsMale", { pct: portrait.malePct }));
    }
    if (portrait.nonFanPct != null && portrait.nonFanPct >= 80) {
      bits.push(tf(t, "liveInsNonFan", { pct: portrait.nonFanPct }));
    }
    if (portrait.hobbyText) {
      const h =
        localizePortraitText(portrait.hobbyText.replace(/居多$/, ""), locale) ||
        portrait.hobbyText.replace(/居多$/, "");
      bits.push(h);
    }
    if (portrait.regionText) {
      const r =
        localizePortraitText(portrait.regionText.replace(/居多$/, ""), locale) ||
        portrait.regionText.replace(/居多$/, "");
      bits.push(r);
    }
    if (bits.length) {
      lines.push({
        kind: "tip",
        text: tf(t, "liveInsAudience", { bits: bits.slice(0, 3).join(" · ") }),
      });
    }
  }

  const withTraffic = list.find((s) => s.trafficChannels?.length);
  if (withTraffic?.trafficChannels?.length) {
    const top = withTraffic.trafficChannels[0];
    if (top.watchPct != null && top.watchPct >= 85 && /推荐/.test(top.name)) {
      lines.push({
        kind: "tip",
        text: tf(t, "liveInsTrafficRec", {
          pct: top.watchPct.toFixed(0),
          name: localizeChannelName(top.name, locale),
        }),
      });
    }
  }

  const withFunnel = list.find((s) => s.trafficFunnel);
  const fun = withFunnel?.trafficFunnel;
  if (fun?.enterRateDiff != null && fun.enterRateDiff <= -2) {
    lines.push({
      kind: "risk",
      text: tf(t, "liveInsEnterLow", {
        pts: Math.abs(fun.enterRateDiff).toFixed(1),
      }),
    });
  } else if (fun?.payRateDiff != null && fun.payRateDiff <= -1.5) {
    lines.push({
      kind: "risk",
      text: tf(t, "liveInsPayLow", {
        pts: Math.abs(fun.payRateDiff).toFixed(1),
      }),
    });
  } else if (
    fun?.showUcnt &&
    fun.enterUcnt != null &&
    fun.showUcnt > 0 &&
    fun.enterUcnt / fun.showUcnt < 0.04
  ) {
    lines.push({
      kind: "risk",
      text: tf(t, "liveInsEnterRate", {
        pct: ((fun.enterUcnt / fun.showUcnt) * 100).toFixed(1),
      }),
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
        text: tf(t, "liveInsHighlight", {
          clock,
          gifts: num(peak.gifts, locale),
        }),
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
        text: tf(t, "liveInsLost", {
          n: m.lostCount ?? 0,
          note: m.note ? tf(t, "liveInsParen", { text: m.note }) : "",
        }),
      });
    } else if ((m.highValueCount ?? 0) > 0) {
      const samples = m.highValueSamples?.slice(0, 2).join(locale === "en" ? ", " : "、");
      lines.push({
        kind: "tip",
        text: tf(t, "liveInsHighVal", {
          n: m.highValueCount ?? 0,
          samples: samples ? tf(t, "liveInsLike", { text: samples }) : "",
        }),
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
        text: tf(t, "liveInsPaidGender", { pts: d.toFixed(0) }),
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

export function buildSlotAdvice(
  sessions: LiveSession[],
  tr: TFn,
  locale = "zh",
  now = Date.now(),
): SlotAdvice | null {
  const t = asT(tr);
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
          ? tf(t, "liveInsShortBad", { pct: (ratio * 100).toFixed(0) })
          : tf(t, "liveInsShortOk", { pct: (ratio * 100).toFixed(0) });
    }
  }
  const hourEnd = (best.hour + 1) % 24;
  return {
    bestWeekday: best.weekday,
    bestHour: best.hour,
    avgGifts: best.avgGifts,
    text: tf(t, "liveInsSlotBest", {
      weekday: weekdayName(t, best.weekday),
      h0: best.hour,
      h1: hourEnd,
      gifts: num(best.avgGifts, locale),
      n: best.count,
    }),
    shortVsNormalText,
  };
}

export function buildSessionInsight(
  session: LiveSession,
  all: LiveSession[],
  tr: TFn,
  locale = "zh",
): SessionInsight {
  const t = asT(tr);
  const baseline = recentMedianBaseline(all, session.id, 7);
  const grade = gradeSession(session, baseline);
  const giftsPct = baseline ? pctChange(session.totalGifts, baseline.gifts) : null;
  const followersPct = baseline ? pctChange(session.newFollowers, baseline.followers) : null;
  const durationPct = baseline ? pctChange(session.duration, baseline.duration) : null;
  const moments = labelMinuteMoments(session.minuteTrend, t);
  const diagnosis = diagnoseSession(session, all, t, locale);
  const lines: string[] = [];
  if (baseline) {
    lines.push(
      tf(t, "liveInsVsGifts", {
        pct: fmtPct(giftsPct),
        cur: num(session.totalGifts, locale),
        med: num(Math.round(baseline.gifts), locale),
      }),
    );
    lines.push(
      tf(t, "liveInsVsFans", {
        pct: fmtPct(followersPct),
        cur: session.newFollowers,
        med: Math.round(baseline.followers),
      }),
    );
    lines.push(
      tf(t, "liveInsVsDur", {
        pct: fmtPct(durationPct),
        cur: fmtDur(session.duration, t),
        med: fmtDur(baseline.duration, t),
      }),
    );
  } else {
    lines.push(t("liveInsNoBase"));
  }
  if (diagnosis) lines.push(tf(t, "liveInsDiagPrefix", { text: diagnosis }));
  for (const m of moments.slice(0, 3)) {
    lines.push(
      tf(t, "liveInsMomentLine", {
        kind: m.kind === "high" ? t("liveInsHigh") : t("liveInsLow"),
        label: m.label,
        clock: m.clock,
        value: num(m.value, locale),
      }),
    );
  }
  return {
    grade,
    gradeLabel: gradeLabel(grade, t),
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
export function labelMinuteMoments(
  points: MinutePoint[] | null | undefined,
  tr: TFn,
): MinuteMoment[] {
  const translate = asT(tr);
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
      id: "giftPeak",
      label: translate("liveMomGiftPeak"),
      clock: shortClock(giftPeak.t),
      value: giftPeak.gifts,
    });
  }
  const viewPeak = by("viewers");
  if (viewPeak.viewers > 0) {
    out.push({
      kind: "high",
      id: "viewerPeak",
      label: translate("liveMomViewerPeak"),
      clock: shortClock(viewPeak.t),
      value: viewPeak.viewers,
    });
  }
  const fanPeak = by("followers");
  if (fanPeak.followers > 0) {
    out.push({
      kind: "high",
      id: "fanPeak",
      label: translate("liveMomFanPeak"),
      clock: shortClock(fanPeak.t),
      value: fanPeak.followers,
    });
  }
  const leavePeak = by("leave");
  if ((leavePeak.leave ?? 0) > 0) {
    out.push({
      kind: "low",
      id: "leavePeak",
      label: translate("liveMomLeavePeak"),
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
        id: "viewerTrough",
        label: translate("liveMomViewerTrough"),
        clock: shortClock(trough.t),
        value: trough.viewers,
      });
    }
  }
  // 去重：同钟点同 kind 只留一条
  const seen = new Set<string>();
  return out.filter((m) => {
    const k = `${m.kind}:${m.clock}:${m.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 5);
}

/** 单场一句话诊断（可执行） */
export function diagnoseSession(
  session: LiveSession,
  all: LiveSession[],
  tr: TFn,
  locale = "zh",
): string | null {
  const t = asT(tr);
  const fun = session.trafficFunnel;
  const ch = session.trafficChannels?.[0];
  const moments = labelMinuteMoments(session.minuteTrend, t);
  const giftHigh = moments.find((m) => m.id === "giftPeak");
  const leaveLow = moments.find((m) => m.id === "leavePeak");
  const trough = moments.find((m) => m.id === "viewerTrough");

  if (fun?.enterRateDiff != null && fun.enterRateDiff <= -2) {
    return tf(t, "liveDiagEnter", {
      pts: Math.abs(fun.enterRateDiff).toFixed(1),
    });
  }
  if (fun?.payRateDiff != null && fun.payRateDiff <= -1.5) {
    return tf(t, "liveDiagPay", {
      pts: Math.abs(fun.payRateDiff).toFixed(1),
    });
  }
  if (ch?.watchPct != null && ch.watchPct >= 85 && /推荐/.test(ch.name)) {
    return tf(t, "liveDiagTraffic", {
      pct: ch.watchPct.toFixed(0),
      name: localizeChannelName(ch.name, locale),
    });
  }
  if (leaveLow && giftHigh && leaveLow.clock !== giftHigh.clock) {
    return tf(t, "liveDiagLeave", {
      leave: leaveLow.clock,
      high: giftHigh.clock,
    });
  }
  if (trough) {
    return tf(t, "liveDiagTrough", {
      clock: trough.clock,
      n: trough.value,
    });
  }
  if (giftHigh) {
    return tf(t, "liveDiagGiftHigh", {
      clock: giftHigh.clock,
      gifts: num(giftHigh.value, locale),
    });
  }
  const baseline = recentMedianBaseline(all, session.id, 7);
  if (baseline && baseline.gifts > 0) {
    const ratio = session.totalGifts / baseline.gifts;
    if (ratio <= 0.75) return t("liveDiagCold");
    if (ratio >= 1.25) return t("liveDiagHot");
  }
  return null;
}

/** 复盘小报（纯文本，可复制） */
export function buildSessionReportText(
  session: LiveSession,
  all: LiveSession[],
  tr: TFn,
  locale = "zh",
): string {
  const t = asT(tr);
  const insight = buildSessionInsight(session, all, t, locale);
  const d = new Date(session.startTime * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const lines: string[] = [
    tf(t, "liveReportTitle", {
      when,
      title: session.title || t("liveReportUntitled"),
    }),
    tf(t, "liveReportGrade", {
      grade: insight.gradeLabel,
      dur: fmtDur(session.duration, t),
    }),
    tf(t, "liveReportCore", {
      gifts: num(session.totalGifts, locale),
      fans: session.newFollowers,
      peak: session.peakViewers || session.watchUcnt || 0,
    }),
  ];
  for (const l of insight.lines) lines.push(`· ${l}`);
  const ch = session.trafficChannels?.[0];
  if (ch?.watchPct != null) {
    lines.push(
      tf(t, "liveReportTraffic", {
        name: localizeChannelName(ch.name, locale),
        pct: ch.watchPct.toFixed(1),
        consume:
          ch.consumePct != null
            ? tf(t, "liveReportConsume", { pct: ch.consumePct.toFixed(1) })
            : "",
      }),
    );
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
      tf(t, "liveReportFunnel", {
        show: fun.showUcnt ?? "—",
        enter: fun.enterUcnt ?? "—",
        er: er != null ? `（${er}%）` : "",
        pay: fun.payUcnt ?? "—",
        pr: pr != null ? `（${pr}%）` : "",
      }),
    );
  }
  const p = session.audiencePortrait;
  if (p) {
    const bits = [p.genderText, p.ageText, p.regionText, p.hobbyText]
      .filter(Boolean)
      .slice(0, 3);
    if (bits.length) lines.push(tf(t, "liveReportPortrait", { bits: bits.join(" · ") }));
  }
  const paid = session.portraitSlices?.paid;
  if (paid?.genderText || paid?.ageText) {
    lines.push(
      tf(t, "liveReportPaid", {
        bits: [paid.genderText, paid.ageText, paid.hobbyText]
          .filter(Boolean)
          .slice(0, 2)
          .join(" · "),
      }),
    );
  }
  const m = session.audienceMaintenance;
  if (m) {
    lines.push(
      tf(t, "liveReportMaint", {
        lost: m.lostCount ?? "—",
        high: m.highValueCount ?? "—",
        note: m.note ? ` · ${m.note}` : "",
      }),
    );
  }
  const moments = labelMinuteMoments(session.minuteTrend, t);
  if (moments.length) {
    lines.push(
      tf(t, "liveReportMoments", {
        bits: moments.map((x) => `${x.label}${x.clock}(${x.value})`).join(" · "),
      }),
    );
  }
  if (insight.diagnosis) lines.push(tf(t, "liveReportDiag", { text: insight.diagnosis }));
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
