import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type { LiveGoals, LiveSession } from "./liveTypes";
import { evaluateLiveAlerts } from "./liveAlerts";

function fmt(n: number | null | undefined, locale: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString(locale === "en" ? "en-US" : "zh-CN");
}

function fmtRate(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function rateOf(num: number | null | undefined, den: number | null | undefined): number | null {
  if (num == null || den == null || !Number.isFinite(num) || !Number.isFinite(den) || den <= 0) {
    return null;
  }
  return Math.round((num / den) * 10000) / 100;
}

function pointAtOrBefore(points: LiveSession["dataPoints"], t: number) {
  let hit: (typeof points)[number] | null = null;
  for (const p of points) {
    if (p.t <= t) hit = p;
    else break;
  }
  return hit;
}

type ConvMode = "minute" | "total";

type Props = {
  session: LiveSession | null;
  allSessions: LiveSession[];
  goals?: LiveGoals;
  labels: {
    live: string;
    idle: string;
    endLive: string;
    heatTitle: string;
    viewers: string;
    gifts: string;
    senders: string;
    followers: string;
    commenters: string;
    likes: string;
    shares: string;
    fansClub: string;
    convTitle: string;
    modeMinute: string;
    modeTotal: string;
    showMinute: string;
    enterMinute: string;
    stayMinute: string;
    showTotal: string;
    enterTotal: string;
    giftTotal: string;
    enterRate: string;
    stayRate: string;
    giftRate: string;
    vs7: string;
  };
  onEnd: () => void;
};

export default function LiveMonitor({
  session,
  allSessions,
  goals,
  labels,
  onEnd,
}: Props) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<ConvMode>("minute");
  const alerts = useMemo(
    () => evaluateLiveAlerts(session, goals, allSessions, t, locale),
    // dataPoints length drives recompute while live
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, goals, allSessions, session?.dataPoints.length, session?.totalGifts, t, locale],
  );

  const elapsed = session
    ? session.endTime != null
      ? session.duration
      : Math.max(0, Math.floor(Date.now() / 1000) - session.startTime)
    : 0;

  const last = session?.dataPoints[session.dataPoints.length - 1];
  const viewers = last?.viewers ?? session?.peakViewers ?? null;

  const heat = [
    { label: labels.viewers, value: viewers },
    { label: labels.gifts, value: session?.totalGifts ?? last?.gifts ?? null },
    { label: labels.senders, value: session?.giftSenders ?? last?.giftSenders ?? null },
    { label: labels.followers, value: session?.newFollowers ?? last?.newFollowers ?? null },
    { label: labels.commenters, value: session?.totalComments ?? last?.comments ?? null },
    { label: labels.likes, value: session?.totalLikes ?? last?.likes ?? null },
    { label: labels.shares, value: session?.totalShares ?? last?.shares ?? null },
    { label: labels.fansClub, value: session?.newFansClub ?? last?.newFansClub ?? null },
  ];

  const conv = useMemo(() => {
    if (!session || !last) {
      return {
        a: null as number | null,
        b: null as number | null,
        c: null as number | null,
        rate1: null as number | null,
        rate2: null as number | null,
        rate1Label: labels.enterRate,
        rate2Label: labels.stayRate,
        aLabel: labels.showMinute,
        bLabel: labels.enterMinute,
        cLabel: labels.stayMinute,
        vsEnter: null as number | null,
        vsSecond: null as number | null,
      };
    }

    const pts = session.dataPoints;
    const ago = pointAtOrBefore(pts, Math.max(0, last.t - 60));
    const delta = (key: "show" | "enter" | "stay") => {
      const cur = last[key];
      if (cur == null) return null;
      // 没有 60 秒前的点时不要把累计当「近一分钟」
      const prev = ago?.[key];
      if (prev == null || ago == null) return null;
      return Math.max(0, cur - prev);
    };

    const medianEnter = (() => {
      const rates = allSessions
        .filter((s) => s.id !== session.id)
        .map((s) => s.enterRate ?? s.trafficFunnel?.enterRate ?? null)
        .filter((n): n is number => n != null && Number.isFinite(n))
        .sort((a, b) => a - b);
      if (!rates.length) return null;
      return rates[Math.floor(rates.length / 2)] ?? null;
    })();

    const medianGift = (() => {
      const rates = allSessions
        .filter((s) => s.id !== session.id)
        .map((s) => s.giftRate ?? s.consumeRate ?? s.trafficFunnel?.payRate ?? null)
        .filter((n): n is number => n != null && Number.isFinite(n))
        .sort((a, b) => a - b);
      if (!rates.length) return null;
      return rates[Math.floor(rates.length / 2)] ?? null;
    })();

    if (mode === "minute") {
      const show = delta("show");
      const enter = delta("enter");
      const stay = delta("stay");
      return {
        a: show,
        b: enter,
        c: stay,
        rate1: rateOf(enter, show),
        rate2: rateOf(stay, enter),
        rate1Label: labels.enterRate,
        rate2Label: labels.stayRate,
        aLabel: labels.showMinute,
        bLabel: labels.enterMinute,
        cLabel: labels.stayMinute,
        vsEnter: null,
        vsSecond: null,
      };
    }

    const show = last.show ?? session.showUcnt ?? null;
    const enter = last.enter ?? session.enterUcnt ?? null;
    const giftU = last.giftSenders ?? session.giftSenders ?? null;
    const enterRate =
      session.enterRate != null ? session.enterRate : rateOf(enter, show);
    const giftRate =
      session.giftRate != null ? session.giftRate : rateOf(giftU, enter);
    return {
      a: show,
      b: enter,
      c: giftU,
      rate1: enterRate,
      rate2: giftRate,
      rate1Label: labels.enterRate,
      rate2Label: labels.giftRate,
      aLabel: labels.showTotal,
      bLabel: labels.enterTotal,
      cLabel: labels.giftTotal,
      vsEnter:
        enterRate != null && medianEnter != null
          ? Math.round((enterRate - medianEnter) * 10) / 10
          : null,
      vsSecond:
        giftRate != null && medianGift != null
          ? Math.round((giftRate - medianGift) * 10) / 10
          : null,
    };
  }, [session, last, mode, allSessions, labels]);

  return (
    <div className="live-mon">
      <div className="live-mon-bar">
        {session ? (
          <span className="live-pill on">{labels.live}</span>
        ) : (
          <span className="live-pill">{labels.idle}</span>
        )}
        <span className="live-elapsed">{fmtDur(elapsed)}</span>
        <span className="live-mon-title">{session?.title?.trim() || labels.idle}</span>
        {session ? (
          <button type="button" className="settings-path-btn" onClick={onEnd}>
            {labels.endLive}
          </button>
        ) : null}
      </div>

      {alerts.length > 0 ? (
        <div className="live-alerts" role="status">
          {alerts.map((a) => (
            <div
              key={a.id}
              className={
                a.level === "warn" ? "live-alert live-alert-warn" : "live-alert"
              }
            >
              {a.text}
            </div>
          ))}
        </div>
      ) : null}

      <div className="live-mon-grid">
        <section className="live-mon-conv">
          <div className="live-mon-conv-head">
            <span className="live-mon-label">{labels.convTitle}</span>
            <div className="live-seg" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "minute"}
                className={mode === "minute" ? "live-seg-btn on" : "live-seg-btn"}
                onClick={() => setMode("minute")}
              >
                {labels.modeMinute}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "total"}
                className={mode === "total" ? "live-seg-btn on" : "live-seg-btn"}
                onClick={() => setMode("total")}
              >
                {labels.modeTotal}
              </button>
            </div>
          </div>
          <div className="live-mon-conv-body">
            <div className="live-mon-stages">
              <div className="live-mon-stage">
                <span>{conv.aLabel}</span>
                <strong>{fmt(conv.a, locale)}</strong>
              </div>
              <div className="live-mon-stage">
                <span>{conv.bLabel}</span>
                <strong>{fmt(conv.b, locale)}</strong>
              </div>
              <div className="live-mon-stage">
                <span>{conv.cLabel}</span>
                <strong>{fmt(conv.c, locale)}</strong>
              </div>
            </div>
            <div className="live-mon-rates">
              <div>
                <span>{conv.rate1Label}</span>
                <strong>{fmtRate(conv.rate1)}</strong>
                {conv.vsEnter != null ? (
                  <em className={conv.vsEnter >= 0 ? "up" : "down"}>
                    {labels.vs7}
                    {conv.vsEnter >= 0 ? "+" : ""}
                    {conv.vsEnter.toFixed(1)}%
                  </em>
                ) : null}
              </div>
              <div>
                <span>{conv.rate2Label}</span>
                <strong>{fmtRate(conv.rate2)}</strong>
                {conv.vsSecond != null ? (
                  <em className={conv.vsSecond >= 0 ? "up" : "down"}>
                    {labels.vs7}
                    {conv.vsSecond >= 0 ? "+" : ""}
                    {conv.vsSecond.toFixed(1)}%
                  </em>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <section className="live-mon-heat">
          <span className="live-mon-label">{labels.heatTitle}</span>
          <div className="live-mon-heat-grid">
            {heat.map((c) => (
              <div key={c.label} className="live-mon-heat-cell">
                <span>{c.label}</span>
                <strong>{fmt(c.value, locale)}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
