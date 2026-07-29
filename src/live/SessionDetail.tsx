import { useEffect, useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Check, ClipboardCopy, Download } from "lucide-react";
import { useTheme } from "../theme";
import LiveEChart from "./charts/LiveEChart";
import { ageOption, channelOption, minuteOption } from "./charts/options";
import PayFunnel from "./PayFunnel";
import type { AudiencePortrait, LiveSession, MinutePoint } from "./liveTypes";
import {
  buildSessionInsight,
  buildSessionReportText,
  efficiency,
  labelMinuteMoments,
} from "./insights";

const ICO = 15;

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

function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  const sign = p >= 0 ? "↑" : "↓";
  return `${sign}${Math.abs(p).toFixed(0)}%`;
}

function peakMinute(
  points: MinutePoint[],
  key: "viewers" | "gifts",
): MinutePoint | null {
  if (!points.length) return null;
  return points.reduce((best, cur) => (cur[key] > best[key] ? cur : best));
}

function shortClock(t: string): string {
  const m = t.match(/(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : t;
}

type Props = {
  session: LiveSession;
  allSessions: LiveSession[];
  prev: LiveSession | null;
  /** 下播后自动点亮「已复制」状态（复制已在外层完成） */
  autoCopyReport?: boolean;
  onAutoCopyDone?: () => void;
  labels: {
    back: string;
    core: string;
    peak: string;
    avg: string;
    gifts: string;
    followers: string;
    likes: string;
    comments: string;
    shares: string;
    senders: string;
    trend: string;
    vsPrev: string;
    noPrev: string;
    vsMedian: string;
    efficiency: string;
    giftsPerHour: string;
    fansPerHour: string;
    giftsPerViewer: string;
    enterRate: string;
    avgStay: string;
    consumeRate: string;
    portrait: string;
    gender: string;
    age: string;
    region: string;
    hobby: string;
    honor: string;
    portraitComments: string;
    fans: string;
    noPortrait: string;
    traffic: string;
    channelCol: string;
    watchShare: string;
    consumeShare: string;
    avgWatch: string;
    funnel: string;
    funnelShow: string;
    funnelEnter: string;
    funnelInteract: string;
    funnelPay: string;
    funnelFollow: string;
    funnelPayTitle: string;
    funnelInteractTitle: string;
    funnelFollowTitle: string;
    funnelEnterRate: string;
    funnelPayRate: string;
    funnelInteractRate: string;
    funnelFollowRate: string;
    funnelVs7: string;
    funnelGift: string;
    funnelNewFans: string;
    funnelRoomInteract: string;
    minuteCross: string;
    minuteViewers: string;
    minuteGifts: string;
    minutePeak: string;
    reviewHint: string;
    portraitAll: string;
    portraitPaid: string;
    portraitFans: string;
    copyReport: string;
    copyReportOk: string;
    exportReport: string;
    exportReportOk: string;
    audienceMaint: string;
    lostAudience: string;
    highValueAudience: string;
  };
  onBack: () => void;
};

export default function SessionDetail({
  session,
  allSessions,
  prev,
  autoCopyReport,
  onAutoCopyDone,
  labels,
  onBack,
}: Props) {
  const { theme } = useTheme();
  const insight = useMemo(
    () => buildSessionInsight(session, allSessions),
    [session, allSessions],
  );
  const eff = useMemo(() => efficiency(session), [session]);
  const moments = useMemo(
    () => labelMinuteMoments(session.minuteTrend),
    [session.minuteTrend],
  );
  const [portraitTab, setPortraitTab] = useState<"all" | "paid" | "fans">("all");
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [exportState, setExportState] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    if (!autoCopyReport) return;
    setCopyState("ok");
    onAutoCopyDone?.();
    const id = window.setTimeout(() => setCopyState("idle"), 2200);
    return () => window.clearTimeout(id);
  }, [autoCopyReport, onAutoCopyDone, session.id]);

  const channels = useMemo(() => {
    const list = session.trafficChannels ?? [];
    return list
      .slice()
      .sort((a, b) => (b.watchPct ?? 0) - (a.watchPct ?? 0));
  }, [session.trafficChannels]);
  const funnel = session.trafficFunnel;
  const minutes = session.minuteTrend ?? [];
  const giftPeak = useMemo(() => peakMinute(minutes, "gifts"), [minutes]);
  const viewerPeak = useMemo(() => peakMinute(minutes, "viewers"), [minutes]);
  const portrait: AudiencePortrait | null | undefined =
    portraitTab === "paid"
      ? session.portraitSlices?.paid ?? null
      : portraitTab === "fans"
        ? session.portraitSlices?.fans ?? null
        : session.portraitSlices?.all ?? session.audiencePortrait;
  const hasSliceTabs = !!(
    session.portraitSlices?.paid ||
    session.portraitSlices?.fans
  );
  const maint = session.audienceMaintenance;

  const minuteOpt = useMemo(
    () => (minutes.length >= 2 ? minuteOption(minutes, moments) : null),
    [minutes, moments, theme],
  );
  const channelOpt = useMemo(
    () => (channels.length ? channelOption(channels) : null),
    [channels, theme],
  );
  const ageOpt = useMemo(
    () =>
      portrait?.ages && portrait.ages.length ? ageOption(portrait.ages) : null,
    [portrait, theme],
  );

  async function copyReport() {
    const text = buildSessionReportText(session, allSessions);
    try {
      await writeText(text);
      setCopyState("ok");
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        setCopyState("ok");
      } catch {
        setCopyState("fail");
      }
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  async function exportReport() {
    const text = buildSessionReportText(session, allSessions);
    const d = new Date(session.startTime * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    try {
      const picked = await save({
        title: labels.exportReport,
        defaultPath: `FLYBOX复盘_${stamp}.txt`,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!picked) return;
      await writeTextFile(picked, text);
      setExportState("ok");
    } catch {
      setExportState("fail");
    }
    window.setTimeout(() => setExportState("idle"), 1800);
  }

  const metrics: { label: string; value: number; prev?: number }[] = [
    {
      label: labels.peak,
      value: session.peakViewers || session.watchUcnt || 0,
      prev: prev?.peakViewers || prev?.watchUcnt,
    },
    { label: labels.avg, value: session.avgViewers, prev: prev?.avgViewers },
    { label: labels.gifts, value: session.totalGifts, prev: prev?.totalGifts },
    {
      label: labels.followers,
      value: session.newFollowers,
      prev: prev?.newFollowers,
    },
  ];

  const coreKpis = [
    {
      label: labels.peak,
      value: fmt(session.peakViewers || session.watchUcnt || 0),
    },
    { label: labels.gifts, value: fmt(session.totalGifts) },
    { label: labels.followers, value: fmt(session.newFollowers) },
    {
      label: labels.enterRate,
      value:
        session.enterRate != null ? `${session.enterRate.toFixed(1)}%` : "—",
    },
    {
      label: labels.avgStay,
      value:
        session.avgWatchMins != null
          ? `${session.avgWatchMins.toFixed(1)}m`
          : "—",
    },
    { label: labels.giftsPerHour, value: fmt(eff.giftsPerHour) },
    { label: labels.fansPerHour, value: String(eff.followersPerHour) },
    {
      label: labels.consumeRate,
      value:
        session.consumeRate != null
          ? `${session.consumeRate.toFixed(1)}%`
          : "—",
    },
  ];

  return (
    <div className="live-detail">
      <div className="live-detail-bar">
        <button type="button" className="settings-path-btn" onClick={onBack}>
          {labels.back}
        </button>
        <div
          className="live-detail-meta"
          title={`${session.date} ${fmtTime(session.startTime)} · ${session.title} · ${fmtDur(session.duration)}`}
        >
          <strong>
            {session.date} {fmtTime(session.startTime)}
          </strong>
          <span className={`live-grade live-grade-${insight.grade}`}>
            {insight.gradeLabel}
          </span>
          <span className="live-detail-meta-sep" aria-hidden>
            ·
          </span>
          <span className="live-detail-meta-title muted">{session.title}</span>
          <span className="live-detail-meta-sep muted" aria-hidden>
            ·
          </span>
          <span className="muted live-detail-meta-dur">
            {fmtDur(session.duration)}
          </span>
        </div>
        <button
          type="button"
          className="live-icon-btn"
          onClick={() => void copyReport()}
          title={
            copyState === "ok"
              ? labels.copyReportOk
              : copyState === "fail"
                ? "复制失败"
                : labels.copyReport
          }
          aria-label={labels.copyReport}
        >
          {copyState === "ok" ? <Check size={ICO} /> : <ClipboardCopy size={ICO} />}
        </button>
        <button
          type="button"
          className="live-icon-btn"
          onClick={() => void exportReport()}
          title={
            exportState === "ok"
              ? labels.exportReportOk
              : exportState === "fail"
                ? "导出失败"
                : labels.exportReport
          }
          aria-label={labels.exportReport}
        >
          {exportState === "ok" ? <Check size={ICO} /> : <Download size={ICO} />}
        </button>
      </div>

      {(insight.diagnosis || insight.lines[0]) && (
        <div className="live-diag">
          <p className="live-diag-text">
            {insight.diagnosis || insight.lines[0]}
          </p>
        </div>
      )}

      <div className="live-cards live-kpi-row">
        {coreKpis.map((m) => (
          <div key={m.label} className="live-card live-card-compact">
            <div className="live-card-label">{m.label}</div>
            <div className="live-card-value">{m.value}</div>
          </div>
        ))}
      </div>

      <div className="live-block">
        <div className="live-section-label">{labels.minuteCross}</div>
        {minuteOpt ? (
          <>
            <LiveEChart option={minuteOpt} height={260} />
            <p className="muted live-traffic-note">
              {labels.minutePeak}
              {giftPeak && giftPeak.gifts > 0
                ? ` · ${labels.minuteGifts} ${shortClock(giftPeak.t)}（${fmt(giftPeak.gifts)}）`
                : ""}
              {viewerPeak && viewerPeak.viewers > 0
                ? ` · ${labels.minuteViewers} ${shortClock(viewerPeak.t)}（${fmt(viewerPeak.viewers)}）`
                : ""}
            </p>
            {moments.length ? (
              <div className="live-moment-list">
                {moments.map((m) => (
                  <span
                    key={`${m.kind}-${m.label}-${m.clock}`}
                    className={`live-moment live-moment-${m.kind}`}
                  >
                    {m.label} {m.clock}（{fmt(m.value)}）
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">{labels.reviewHint}</p>
        )}
      </div>

      <div className="live-split">
        <div className="live-block live-split-pane">
          <div className="live-section-label">{labels.traffic}</div>
          {channelOpt ? (
            <LiveEChart option={channelOpt} height={200} />
          ) : (
            <p className="muted">{labels.reviewHint}</p>
          )}
        </div>
        <div className="live-block live-split-pane">
          <div className="live-section-label">{labels.funnelPayTitle}</div>
          {funnel ? (
            <PayFunnel
              funnel={funnel}
              labels={{
                show: "曝光展现",
                enter: "进直播间",
                pay: "打赏送礼",
                enterRate: labels.funnelEnterRate,
                payRate: labels.funnelPayRate,
                vs7: labels.funnelVs7,
                interactRate: labels.funnelInteractRate,
                followRate: labels.funnelFollowRate,
              }}
            />
          ) : (
            <p className="muted">{labels.reviewHint}</p>
          )}
        </div>
      </div>

      <div className="live-block">
        <div className="live-section-label">{labels.portrait}</div>
        {hasSliceTabs ? (
          <div className="live-portrait-tabs">
            {(
              [
                ["all", labels.portraitAll],
                ["paid", labels.portraitPaid],
                ["fans", labels.portraitFans],
              ] as const
            ).map(([key, lab]) => (
              <button
                key={key}
                type="button"
                className={
                  portraitTab === key
                    ? "live-portrait-tab on"
                    : "live-portrait-tab"
                }
                onClick={() => setPortraitTab(key)}
              >
                {lab}
              </button>
            ))}
          </div>
        ) : null}
        {!portrait && !maint ? (
          <p className="muted">{labels.noPortrait}</p>
        ) : (
          <div className="live-portrait-row">
            {ageOpt ? (
              <LiveEChart
                option={ageOpt}
                height={180}
                className="live-age-chart"
              />
            ) : null}
            <div className="live-portrait-facts">
              {[
                { k: labels.gender, v: portrait?.genderText },
                { k: labels.age, v: portrait?.ageText },
                { k: labels.region, v: portrait?.regionText },
                { k: labels.hobby, v: portrait?.hobbyText },
                { k: labels.honor, v: portrait?.honorText },
                { k: labels.portraitComments, v: portrait?.commentText },
                { k: labels.fans, v: portrait?.fansText },
                maint
                  ? {
                      k: labels.lostAudience,
                      v:
                        maint.lostCount != null
                          ? `${fmt(maint.lostCount)}${
                              maint.lostSamples?.length
                                ? `（${maint.lostSamples.join("、")}）`
                                : ""
                            }`
                          : "—",
                    }
                  : null,
                maint
                  ? {
                      k: labels.highValueAudience,
                      v:
                        maint.highValueCount != null
                          ? `${fmt(maint.highValueCount)}${
                              maint.highValueSamples?.length
                                ? `（${maint.highValueSamples.join("、")}）`
                                : ""
                            }`
                          : "—",
                    }
                  : null,
              ]
                .filter((x): x is { k: string; v: string } => !!x?.v)
                .map((x) => (
                  <div key={x.k} className="live-portrait-fact">
                    <span className="muted">{x.k}</span>
                    <strong>{x.v}</strong>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      <div className="live-block">
        <div className="live-section-label">{labels.vsPrev}</div>
        {!prev ? (
          <p className="muted">{labels.noPrev}</p>
        ) : (
          <div className="live-compare-grid">
            {metrics.map((m) => {
              const d =
                m.prev != null && m.prev !== 0
                  ? ((m.value - m.prev) / m.prev) * 100
                  : null;
              return (
                <div key={m.label} className="live-compare-tile">
                  <div className="live-compare-tile-top">
                    <span className="muted">{m.label}</span>
                    <span
                      className={
                        d != null && d >= 0
                          ? "live-compare-delta up"
                          : d != null
                            ? "live-compare-delta down"
                            : "live-compare-delta"
                      }
                    >
                      {fmtPct(d)}
                    </span>
                  </div>
                  <div className="live-compare-tile-value">{fmt(m.value)}</div>
                  <div className="muted live-compare-tile-prev">
                    上场 {fmt(m.prev ?? 0)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {insight.lines.length > 1 ? (
          <p className="muted live-compare-note">
            {insight.lines.slice(0, 2).join(" · ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
