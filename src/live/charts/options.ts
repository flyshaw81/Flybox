import type { EChartsOption } from "echarts";
import type {
  AudienceBucket,
  MinutePoint,
  TrafficChannel,
} from "../liveTypes";
import type { MinuteMoment } from "../insights";
import type { PeriodDailyGift } from "../historySync";
import { readChartTheme, type ChartTheme } from "./theme";

const ACCENT = "#ff6a00";
const ASSIST = "#4a90d9";

function shortClock(t: string): string {
  const m = t.match(/(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : t;
}

function baseText(theme: ChartTheme) {
  return {
    color: theme.text,
    fontFamily: "inherit",
  };
}

export type MinuteChartLabels = {
  online: string;
  gifts: string;
  fans: string;
};

export function minuteOption(
  points: MinutePoint[],
  moments: MinuteMoment[] = [],
  labels: MinuteChartLabels = {
    online: "在线",
    gifts: "音浪",
    fans: "涨粉",
  },
): EChartsOption {
  const theme = readChartTheme();
  const accent = theme.accent || ACCENT;
  const assist = theme.assist || ASSIST;
  const soft = theme.soft || "#b0b0b0";
  const cats = points.map((p) => shortClock(p.t));
  const viewers = points.map((p) => p.viewers);
  const gifts = points.map((p) => p.gifts);
  const followers = points.map((p) => p.followers);

  // 只标高光，且挂在对应系列上；低谷用底部文案即可
  const highs = moments.filter((m) => m.kind === "high").slice(0, 3);
  const markFor = (match: (id: string) => boolean) =>
    highs
      .filter((m) => match(m.id))
      .map((m) => {
        const idx = points.findIndex((p) => shortClock(p.t) === m.clock);
        const i = idx >= 0 ? idx : 0;
        const y =
          m.id === "giftPeak"
            ? points[i]!.gifts
            : m.id === "fanPeak"
              ? points[i]!.followers
              : points[i]!.viewers;
        return {
          name: m.label,
          coord: [cats[i], y] as [string, number],
          value: m.value,
          itemStyle: { color: accent },
        };
      });

  return {
    color: [accent, assist, soft],
    backgroundColor: "transparent",
    textStyle: baseText(theme),
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.panel || "#161616",
      borderColor: theme.border || "#2a2a2a",
      textStyle: { color: theme.text || "#f2f2f2" },
    },
    legend: {
      data: [labels.online, labels.gifts, labels.fans],
      top: 0,
      textStyle: { color: theme.muted, fontSize: 11 },
      itemWidth: 12,
      itemHeight: 8,
    },
    grid: { left: 44, right: 44, top: 32, bottom: 36 },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      {
        type: "slider",
        height: 16,
        bottom: 2,
        borderColor: theme.border,
        fillerColor: "rgba(255,106,0,0.18)",
        handleStyle: { color: accent },
        textStyle: { color: theme.muted, fontSize: 10 },
        dataBackground: {
          lineStyle: { color: theme.border },
          areaStyle: { color: "rgba(255,106,0,0.08)" },
        },
      },
    ],
    xAxis: {
      type: "category",
      data: cats,
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.border } },
      axisLabel: { color: theme.muted, fontSize: 10 },
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: "value",
        name: labels.online,
        nameTextStyle: { color: theme.muted, fontSize: 10 },
        splitLine: { lineStyle: { color: theme.border, opacity: 0.45 } },
        axisLabel: { color: theme.muted, fontSize: 10 },
      },
      {
        type: "value",
        name: labels.gifts,
        nameTextStyle: { color: theme.muted, fontSize: 10 },
        splitLine: { show: false },
        axisLabel: { color: theme.muted, fontSize: 10 },
      },
    ],
    series: [
      {
        name: labels.online,
        type: "line",
        smooth: 0.25,
        showSymbol: false,
        data: viewers,
        itemStyle: { color: accent },
        lineStyle: { width: 2, color: accent },
        areaStyle: { color: "rgba(255,106,0,0.12)" },
        markPoint: {
          symbolSize: 28,
          label: { fontSize: 9, color: "#fff" },
          data: markFor((id) => id === "viewerPeak"),
        },
      },
      {
        name: labels.gifts,
        type: "line",
        yAxisIndex: 1,
        smooth: 0.25,
        showSymbol: false,
        data: gifts,
        itemStyle: { color: assist },
        lineStyle: { width: 2, color: assist },
        markPoint: {
          symbolSize: 28,
          label: { fontSize: 9, color: "#fff" },
          data: markFor((id) => id === "giftPeak"),
        },
      },
      {
        name: labels.fans,
        type: "line",
        yAxisIndex: 1,
        smooth: 0.25,
        showSymbol: false,
        data: followers,
        itemStyle: { color: soft },
        lineStyle: { width: 1.5, type: "dashed", color: soft },
        markPoint: {
          symbolSize: 26,
          label: { fontSize: 9, color: "#fff" },
          data: markFor((id) => id === "fanPeak"),
        },
      },
    ],
  };
}

export type ChannelChartLabels = {
  min: (n: string) => string;
  audience: (pct: string) => string;
  avg: (avg: string) => string;
  rev: (pct: string) => string;
};

export function channelOption(
  channels: TrafficChannel[],
  chartLabels?: ChannelChartLabels,
): EChartsOption {
  const theme = readChartTheme();
  const accent = theme.accent || ACCENT;
  const list = channels
    .slice()
    .sort((a, b) => (b.watchPct ?? 0) - (a.watchPct ?? 0))
    .slice(0, 8);
  const names = list.map((c) => c.name).reverse();
  const vals = list.map((c) => +(c.watchPct ?? 0).toFixed(1)).reverse();
  return {
    backgroundColor: "transparent",
    textStyle: baseText(theme),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: theme.panel || "#161616",
      borderColor: theme.border || "#2a2a2a",
      textStyle: { color: theme.text || "#f2f2f2" },
      formatter: (params: unknown) => {
        const p = Array.isArray(params) ? params[0] : params;
        const name =
          p && typeof p === "object" && "name" in p
            ? String((p as { name: string }).name)
            : "";
        const row = list.find((c) => c.name === name);
        if (!row) return name;
        const avgRaw =
          row.avgWatchSec != null
            ? (row.avgWatchSec / 60).toFixed(1)
            : null;
        const avg = avgRaw
          ? chartLabels
            ? chartLabels.min(avgRaw)
            : `${avgRaw}分`
          : "—";
        const consume =
          row.consumePct != null ? `${row.consumePct.toFixed(1)}%` : "—";
        if (chartLabels) {
          return `${row.name}<br/>${chartLabels.audience(row.watchPct?.toFixed(1) ?? "—")}<br/>${chartLabels.avg(avg)}<br/>${chartLabels.rev(consume)}`;
        }
        return `${row.name}<br/>观众 ${row.watchPct?.toFixed(1) ?? "—"}%<br/>人均 ${avg}<br/>营收 ${consume}`;
      },
    },
    grid: { left: 80, right: 40, top: 4, bottom: 4 },
    xAxis: {
      type: "value",
      max: 100,
      axisLabel: { color: theme.muted, fontSize: 10, formatter: "{value}%" },
      splitLine: { lineStyle: { color: theme.border, opacity: 0.4 } },
    },
    yAxis: {
      type: "category",
      data: names,
      axisLabel: { color: theme.text, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: vals,
        barMaxWidth: 14,
        itemStyle: {
          color: accent,
          borderRadius: [0, 4, 4, 0],
        },
        label: {
          show: true,
          position: "right",
          color: theme.muted,
          fontSize: 10,
          formatter: "{c}%",
        },
      },
    ],
  };
}

export function ageOption(ages: AudienceBucket[]): EChartsOption {
  const theme = readChartTheme();
  const accent = theme.accent || ACCENT;
  const list = ages.slice(0, 8);
  const names = list.map((a) => a.name).reverse();
  const vals = list.map((a) => +a.pct.toFixed(1)).reverse();
  return {
    backgroundColor: "transparent",
    textStyle: baseText(theme),
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.panel || "#161616",
      borderColor: theme.border || "#2a2a2a",
      textStyle: { color: theme.text || "#f2f2f2" },
    },
    grid: { left: 64, right: 36, top: 4, bottom: 4 },
    xAxis: {
      type: "value",
      max: 100,
      axisLabel: { color: theme.muted, fontSize: 10, formatter: "{value}%" },
      splitLine: { lineStyle: { color: theme.border, opacity: 0.4 } },
    },
    yAxis: {
      type: "category",
      data: names,
      axisLabel: { color: theme.text, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: vals,
        barMaxWidth: 12,
        itemStyle: {
          color: accent,
          borderRadius: [0, 4, 4, 0],
        },
        label: {
          show: true,
          position: "right",
          color: theme.muted,
          fontSize: 10,
          formatter: "{c}%",
        },
      },
    ],
  };
}

/** 首页核心数据：周期按日音浪走势 */
export function dailyGiftsOption(
  days: PeriodDailyGift[],
  labels?: { seriesName: string; tip: (n: string) => string },
): EChartsOption {
  const theme = readChartTheme();
  const accent = theme.accent || ACCENT;
  const seriesName = labels?.seriesName ?? "收获音浪";
  const cats = days.map((d) => {
    const m = d.date.match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[1])}/${Number(m[2])}` : d.date;
  });
  const vals = days.map((d) => d.gifts);
  return {
    backgroundColor: "transparent",
    color: [accent],
    textStyle: baseText(theme),
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.panel || "#161616",
      borderColor: theme.border || "#2a2a2a",
      textStyle: { color: theme.text || "#f2f2f2" },
      formatter: (params: unknown) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p || typeof p !== "object") return "";
        const name = String((p as { name?: string }).name ?? "");
        const val = Number((p as { value?: number }).value ?? 0);
        const n = val.toLocaleString();
        return `${name}<br/>${labels ? labels.tip(n) : `收获音浪 ${n}`}`;
      },
    },
    grid: { left: 48, right: 16, top: 20, bottom: 28 },
    xAxis: {
      type: "category",
      data: cats,
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.border } },
      axisLabel: { color: theme.muted, fontSize: 10 },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: theme.border, opacity: 0.45 } },
      axisLabel: { color: theme.muted, fontSize: 10 },
    },
    series: [
      {
        name: seriesName,
        type: "line",
        smooth: 0.25,
        showSymbol: days.length <= 14,
        symbolSize: 6,
        data: vals,
        lineStyle: { width: 2, color: accent },
        itemStyle: { color: accent },
        areaStyle: { color: "rgba(255,106,0,0.12)" },
      },
    ],
  };
}

