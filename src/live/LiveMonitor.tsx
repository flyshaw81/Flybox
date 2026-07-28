import Sparkline from "./Sparkline";
import type { LiveSession } from "./liveTypes";
import { buildLiveAlerts, efficiency } from "./insights";

function fmt(n: number): string {
  return n.toLocaleString("zh-CN");
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

type Props = {
  session: LiveSession;
  allSessions: LiveSession[];
  labels: {
    live: string;
    peak: string;
    gifts: string;
    followers: string;
    likes: string;
    comments: string;
    viewersTrend: string;
    endLive: string;
    liveTip: string;
  };
  onEnd: () => void;
};

export default function LiveMonitor({ session, allSessions, labels, onEnd }: Props) {
  const elapsed =
    session.endTime != null
      ? session.duration
      : Math.max(0, Math.floor(Date.now() / 1000) - session.startTime);
  const last = session.dataPoints[session.dataPoints.length - 1];
  const viewers = last?.viewers ?? session.peakViewers;
  const alerts = buildLiveAlerts(session, allSessions);
  const eff = efficiency({ ...session, duration: Math.max(session.duration, elapsed) });

  const cards = [
    { label: labels.peak, value: session.peakViewers },
    { label: labels.gifts, value: session.totalGifts },
    { label: labels.followers, value: session.newFollowers },
    { label: labels.likes, value: session.totalLikes },
    { label: labels.comments, value: session.totalComments },
    { label: "在线", value: viewers },
  ];

  return (
    <div className="live-monitor">
      <div className="live-monitor-bar">
        <span className="live-pill on">{labels.live}</span>
        <span className="live-elapsed">{fmtDur(elapsed)}</span>
        <span className="live-monitor-title">{session.title}</span>
        <button type="button" className="settings-path-btn" onClick={onEnd}>
          {labels.endLive}
        </button>
      </div>
      {alerts.length ? (
        <div className="live-live-tip">
          <div className="live-section-label">{labels.liveTip}</div>
          {alerts.map((a) => (
            <p key={a.text} className={`live-alert live-alert-${a.level}`}>
              {a.text}
            </p>
          ))}
          <p className="muted">
            当前约 {fmt(eff.giftsPerHour)} 音浪/小时
          </p>
        </div>
      ) : null}
      <div className="live-cards">
        {cards.map((c) => (
          <div key={c.label} className="live-card">
            <div className="live-card-label">{c.label}</div>
            <div className="live-card-value">{fmt(c.value)}</div>
          </div>
        ))}
      </div>
      <div className="live-trend">
        <div className="live-section-label">{labels.viewersTrend}</div>
        <Sparkline values={session.dataPoints.map((p) => p.viewers)} />
      </div>
    </div>
  );
}
