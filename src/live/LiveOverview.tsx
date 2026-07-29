import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../theme";
import type { LiveGoals, LiveProfile, LiveSession } from "./liveTypes";
import {
  computePeriodCore,
  type PeriodKey,
} from "./historySync";
import LiveEChart from "./charts/LiveEChart";
import { dailyGiftsOption } from "./charts/options";
import MonthHeatCalendar from "./MonthHeatCalendar";
import {
  buildHeatmap,
  buildOverviewInsights,
  buildSlotAdvice,
  efficiency,
  filterAndSortSessions,
  goalProgress,
  gradeLabel,
  gradeSession,
  recentMedianBaseline,
  type RangeKey,
  type SortKey,
} from "./insights";

function fmt(n: number): string {
  return n.toLocaleString("zh-CN");
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function fmtDurMins(sec: number): string {
  const mins = Math.max(0, sec) / 60;
  if (mins >= 1000) return `${mins.toFixed(2)}分钟`;
  if (mins >= 10) return `${mins.toFixed(1)}分钟`;
  return `${mins.toFixed(2)}分钟`;
}

function fmtPeriodDate(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

type Props = {
  sessions: LiveSession[];
  goals?: LiveGoals;
  profile?: LiveProfile | null;
  labels: {
    empty: string;
    coreTitle: string;
    rangeToday: string;
    range7: string;
    range30: string;
    rangeAll: string;
    periodLabel: string;
    gifts: string;
    senders: string;
    watchers: string;
    avgWatch: string;
    followers: string;
    fansClub: string;
    comments: string;
    likes: string;
    liveCount: string;
    liveDuration: string;
    coreTrend: string;
    coreEmptyTrend: string;
    date: string;
    title: string;
    colDuration: string;
    insights: string;
    slotAdvice: string;
    heatTitle: string;
    sortDate: string;
    sortGifts: string;
    sortFollowers: string;
    sortDuration: string;
    goalsTitle: string;
    goalDailyGifts: string;
    goalWeeklyFans: string;
    goalWeeklyDur: string;
    remaining: string;
    giftsPerHour: string;
    digg: string;
    following: string;
    fans: string;
  };
  onOpen: (id: string) => void;
  onGoalsChange?: (goals: LiveGoals) => void;
};

function fmtStat(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN");
}

export default function LiveOverview({
  sessions,
  goals,
  profile,
  labels,
  onOpen,
  onGoalsChange,
}: Props) {
  const { theme } = useTheme();
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [range, setRange] = useState<RangeKey>("30d");
  const [sort, setSort] = useState<SortKey>("date");
  const core = useMemo(
    () => computePeriodCore(sessions, period),
    [sessions, period],
  );
  const trendOpt = useMemo(
    () =>
      core.dailyGifts.some((d) => d.gifts > 0)
        ? dailyGiftsOption(core.dailyGifts)
        : null,
    [core.dailyGifts, theme],
  );
  const insights = useMemo(() => buildOverviewInsights(sessions), [sessions]);
  const advice = useMemo(() => buildSlotAdvice(sessions), [sessions]);
  const heat = useMemo(() => buildHeatmap(sessions), [sessions]);
  const heatHasData = useMemo(() => heat.some((c) => c.count > 0), [heat]);
  const baseline = useMemo(() => recentMedianBaseline(sessions), [sessions]);
  const list = useMemo(
    () => filterAndSortSessions(sessions, range, sort),
    [sessions, range, sort],
  );
  const progress = useMemo(
    () => goalProgress(sessions, goals ?? {}),
    [sessions, goals],
  );

  const topInsights = insights.slice(0, 3);

  const metrics: { label: string; value: string }[] = [
    { label: labels.gifts, value: fmt(core.totalGifts) },
    { label: labels.senders, value: fmt(core.giftSenders) },
    { label: labels.watchers, value: fmt(core.watchUcnt) },
    {
      label: labels.avgWatch,
      value:
        core.avgWatchMins != null ? `${core.avgWatchMins.toFixed(2)}分钟` : "—",
    },
    { label: labels.followers, value: fmt(core.newFollowers) },
    { label: labels.fansClub, value: fmt(core.newFansClub) },
    { label: labels.comments, value: fmt(core.totalComments) },
    { label: labels.likes, value: fmt(core.totalLikes) },
    { label: labels.liveCount, value: fmt(core.sessionCount) },
    {
      label: labels.liveDuration,
      value: fmtDurMins(core.totalDuration),
    },
  ];

  const nick = profile?.nickname?.trim() || "—";
  const avatarLetter = nick !== "—" ? nick.slice(0, 1) : "主";
  const [avatarBroken, setAvatarBroken] = useState(false);
  const avatarSrc = profile?.avatarUrl || null;
  const showAvatar = !!avatarSrc && !avatarBroken;
  useEffect(() => {
    setAvatarBroken(false);
  }, [avatarSrc]);

  const decisionLine =
    advice?.text ||
    topInsights.find((l) => l.kind === "risk" || l.kind === "tip")?.text ||
    topInsights[0]?.text ||
    null;

  return (
    <div className="live-overview">
      {decisionLine || advice?.shortVsNormalText ? (
        <div className="live-decision-strip" aria-label={labels.slotAdvice}>
          <div className="live-decision-card">
            <div className="live-decision-title">{labels.slotAdvice}</div>
            {decisionLine ? (
              <p className="live-decision-body">{decisionLine}</p>
            ) : null}
            {advice?.shortVsNormalText ? (
              <p className="live-decision-body muted">{advice.shortVsNormalText}</p>
            ) : null}
          </div>
          {(progress.dailyGifts ||
            progress.weeklyFollowers ||
            progress.weeklyDuration) &&
          onGoalsChange ? (
            <div className="live-decision-card">
              <div className="live-decision-title">{labels.goalsTitle}</div>
              {progress.dailyGifts ? (
                <p className="live-decision-body">
                  {labels.goalDailyGifts}{" "}
                  {fmt(progress.dailyGifts.current)}/{fmt(progress.dailyGifts.target)}
                </p>
              ) : null}
              {progress.weeklyFollowers ? (
                <p className="live-decision-body">
                  {labels.goalWeeklyFans}{" "}
                  {fmt(progress.weeklyFollowers.current)}/
                  {fmt(progress.weeklyFollowers.target)}
                </p>
              ) : null}
              {progress.weeklyDuration ? (
                <p className="live-decision-body">
                  {labels.goalWeeklyDur}{" "}
                  {fmtDur(progress.weeklyDuration.current)} /{" "}
                  {fmtDur(progress.weeklyDuration.target)}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="live-anchor-card">
        <aside className="live-anchor-aside">
          {showAvatar ? (
            <img
              className="live-anchor-avatar"
              src={avatarSrc}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setAvatarBroken(true)}
            />
          ) : (
            <div className="live-anchor-avatar is-fallback" aria-hidden>
              {avatarLetter}
            </div>
          )}
          <div className="live-anchor-name" title={nick}>
            {nick}
          </div>
          <div className="live-anchor-stats">
            <div className="live-anchor-stat">
              <span className="live-anchor-stat-val">
                {fmtStat(profile?.diggCount)}
              </span>
              <span className="live-anchor-stat-lab">{labels.digg}</span>
            </div>
            <div className="live-anchor-stat">
              <span className="live-anchor-stat-val">
                {fmtStat(profile?.followingCount)}
              </span>
              <span className="live-anchor-stat-lab">{labels.following}</span>
            </div>
            <div className="live-anchor-stat">
              <span className="live-anchor-stat-val">
                {fmtStat(profile?.followerCount)}
              </span>
              <span className="live-anchor-stat-lab">{labels.fans}</span>
            </div>
          </div>
        </aside>

        <div className="live-anchor-main">
          <section className="live-anchor-pane">
            <div className="live-anchor-pane-title">{labels.insights}</div>
            {topInsights.length > 0 ? (
              <ul className="live-anchor-lines">
                {topInsights.map((line) => (
                  <li
                    key={line.text}
                    className={`live-anchor-line live-anchor-line-${line.kind}`}
                  >
                    {line.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted live-anchor-empty">暂无总结</p>
            )}
          </section>

          <section className="live-anchor-pane">
            <div className="live-anchor-pane-title">{labels.slotAdvice}</div>
            {advice ? (
              <ul className="live-anchor-lines">
                <li className="live-anchor-line">{advice.text}</li>
                {advice.shortVsNormalText ? (
                  <li className="live-anchor-line is-muted">
                    {advice.shortVsNormalText}
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="muted live-anchor-empty">暂无建议</p>
            )}
          </section>
        </div>
      </div>

      <div className="live-core">
        <div className="live-core-head">
          <div className="live-section-label" style={{ margin: 0 }}>
            {labels.coreTitle}
          </div>
          <div className="live-chip-row">
            {(
              [
                ["today", labels.rangeToday],
                ["7d", labels.range7],
                ["30d", labels.range30],
              ] as const
            ).map(([k, lab]) => (
              <button
                key={k}
                type="button"
                className={`live-chip${period === k ? " on" : ""}`}
                onClick={() => setPeriod(k)}
              >
                {lab}
              </button>
            ))}
          </div>
          <span className="muted live-core-period">
            {labels.periodLabel}：{fmtPeriodDate(core.fromSec)}–
            {fmtPeriodDate(core.toSec)}
          </span>
        </div>
        <div className="live-core-metrics">
          {metrics.map((m) => (
            <div key={m.label} className="live-core-metric">
              <div className="live-card-label">{m.label}</div>
              <div className="live-core-metric-value">{m.value}</div>
            </div>
          ))}
        </div>
        <div className="live-section-label">{labels.coreTrend}</div>
        {trendOpt ? (
          <LiveEChart option={trendOpt} height={200} />
        ) : (
          <p className="muted live-core-empty">{labels.coreEmptyTrend}</p>
        )}
      </div>

      {heatHasData ||
      ((progress.dailyGifts ||
        progress.weeklyFollowers ||
        progress.weeklyDuration) &&
        onGoalsChange) ? (
        <div className="live-heat-goals">
          {heatHasData ? (
            <MonthHeatCalendar cells={heat} title={labels.heatTitle} />
          ) : null}
          {(progress.dailyGifts ||
            progress.weeklyFollowers ||
            progress.weeklyDuration) &&
          onGoalsChange ? (
            <div className="live-goals">
              <div className="live-section-label">{labels.goalsTitle}</div>
              {progress.dailyGifts ? (
                <GoalRow
                  label={labels.goalDailyGifts}
                  current={progress.dailyGifts.current}
                  target={progress.dailyGifts.target}
                  remainingLabel={labels.remaining}
                  format={fmt}
                  onTarget={(n) =>
                    onGoalsChange({ ...goals, dailyGifts: Math.max(0, n) })
                  }
                />
              ) : null}
              {progress.weeklyFollowers ? (
                <GoalRow
                  label={labels.goalWeeklyFans}
                  current={progress.weeklyFollowers.current}
                  target={progress.weeklyFollowers.target}
                  remainingLabel={labels.remaining}
                  format={fmt}
                  onTarget={(n) =>
                    onGoalsChange({
                      ...goals,
                      weeklyFollowers: Math.max(0, n),
                    })
                  }
                />
              ) : null}
              {progress.weeklyDuration ? (
                <GoalRow
                  label={labels.goalWeeklyDur}
                  current={progress.weeklyDuration.current}
                  target={progress.weeklyDuration.target}
                  remainingLabel={labels.remaining}
                  format={fmtDur}
                  onTarget={(n) =>
                    onGoalsChange({
                      ...goals,
                      weeklyDurationSec: Math.max(0, n),
                    })
                  }
                  editHours
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {sessions.length === 0 ? (
        <div className="empty live-empty-list">
          <p className="muted">{labels.empty}</p>
        </div>
      ) : (
        <div className="live-list-block">
          <div className="live-list-controls">
            <div className="live-chip-row">
              {(
                [
                  ["7d", labels.range7],
                  ["30d", labels.range30],
                  ["all", labels.rangeAll],
                ] as const
              ).map(([k, lab]) => (
                <button
                  key={k}
                  type="button"
                  className={`live-chip${range === k ? " on" : ""}`}
                  onClick={() => setRange(k)}
                >
                  {lab}
                </button>
              ))}
            </div>
            <div className="live-chip-row">
              {(
                [
                  ["date", labels.sortDate],
                  ["gifts", labels.sortGifts],
                  ["followers", labels.sortFollowers],
                  ["duration", labels.sortDuration],
                ] as const
              ).map(([k, lab]) => (
                <button
                  key={k}
                  type="button"
                  className={`live-chip${sort === k ? " on" : ""}`}
                  onClick={() => setSort(k)}
                >
                  {lab}
                </button>
              ))}
            </div>
          </div>
          <div className="live-table-head live-table-head-eff">
            <span>{labels.date}</span>
            <span>{labels.title}</span>
            <span>{labels.colDuration}</span>
            <span>{labels.gifts}</span>
            <span>{labels.giftsPerHour}</span>
            <span>{labels.followers}</span>
          </div>
          <div className="live-table-body">
            {list.map((s) => {
              const grade = gradeSession(s, baseline);
              const eff = efficiency(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  className="live-table-row live-table-row-eff"
                  onClick={() => onOpen(s.id)}
                >
                  <span>{s.date.slice(5)}</span>
                  <span className="live-table-title" title={s.title}>
                    <span className={`live-grade live-grade-${grade}`}>
                      {gradeLabel(grade)}
                    </span>{" "}
                    {s.title}
                  </span>
                  <span>
                    {fmtDur(
                      s.duration ||
                        (s.endTime
                          ? 0
                          : Math.floor(Date.now() / 1000) - s.startTime),
                    )}
                  </span>
                  <span>{fmt(s.totalGifts)}</span>
                  <span>{fmt(eff.giftsPerHour)}</span>
                  <span>{fmt(s.newFollowers)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function GoalRow({
  label,
  current,
  target,
  remainingLabel,
  format,
  onTarget,
  editHours,
}: {
  label: string;
  current: number;
  target: number;
  remainingLabel: string;
  format: (n: number) => string;
  onTarget: (n: number) => void;
  editHours?: boolean;
}) {
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  const remain = Math.max(0, target - current);
  return (
    <div className="live-goal-row">
      <div className="live-goal-head">
        <span>{label}</span>
        <span className="muted">
          {format(current)} / {format(target)} · {remainingLabel} {format(remain)}
        </span>
      </div>
      <div className="live-goal-bar">
        <div className="live-goal-fill" style={{ width: `${pct}%` }} />
      </div>
      <label className="live-goal-edit muted">
        目标
        <input
          type="number"
          min={0}
          value={editHours ? Math.round(target / 3600) : target}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            onTarget(editHours ? Math.round(v * 3600) : Math.round(v));
          }}
        />
        {editHours ? "小时/周" : ""}
      </label>
    </div>
  );
}
