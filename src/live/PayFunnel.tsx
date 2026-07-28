import type { TrafficFunnel } from "./liveTypes";

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

function rateOf(
  num: number | null | undefined,
  den: number | null | undefined,
): number | null {
  if (
    num == null ||
    den == null ||
    !Number.isFinite(num) ||
    !Number.isFinite(den) ||
    den <= 0
  )
    return null;
  return Math.round((num / den) * 1000) / 10;
}

function preferRate(
  stored: number | null | undefined,
  num: number | null | undefined,
  den: number | null | undefined,
): number | null {
  if (stored != null && Number.isFinite(stored) && stored > 0) return stored;
  return rateOf(num, den);
}

function fmtRate(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${p.toFixed(1)}%`;
}

function fmtDiff(p: number | null | undefined, vsLabel: string): string | null {
  if (p == null || !Number.isFinite(p)) return null;
  const sign = p >= 0 ? "+" : "";
  return `${vsLabel} ${sign}${p.toFixed(1)}%`;
}

type Props = {
  funnel: TrafficFunnel;
  labels: {
    show: string;
    enter: string;
    pay: string;
    enterRate: string;
    payRate: string;
    vs7: string;
    interactRate: string;
    followRate: string;
  };
};

export default function PayFunnel({ funnel, labels }: Props) {
  const enterRate = preferRate(
    funnel.enterRate,
    funnel.enterUcnt,
    funnel.showUcnt,
  );
  const payRate = preferRate(funnel.payRate, funnel.payUcnt, funnel.enterUcnt);
  const interactRate = preferRate(
    funnel.interactRate,
    funnel.interactUcnt,
    funnel.enterUcnt,
  );
  const followRate = preferRate(
    funnel.followRate,
    funnel.followUcnt,
    funnel.enterUcnt,
  );

  const stages = [
    { key: "show", name: labels.show, value: funnel.showUcnt, width: 100 },
    { key: "enter", name: labels.enter, value: funnel.enterUcnt, width: 78 },
    { key: "pay", name: labels.pay, value: funnel.payUcnt, width: 56 },
  ] as const;

  const rates = [
    {
      key: "enter",
      title: labels.enterRate,
      value: enterRate,
      diff: funnel.enterRateDiff,
    },
    {
      key: "pay",
      title: labels.payRate,
      value: payRate,
      diff: funnel.payRateDiff,
    },
  ];

  return (
    <div className="live-pay-funnel">
      <div className="live-pay-body">
        <div className="live-pay-stages">
          {stages.map((s) => (
            <div
              key={s.key}
              className={`live-pay-stage live-pay-stage-${s.key}`}
              style={{ width: `${s.width}%` }}
            >
              <span className="live-pay-stage-name">{s.name}</span>
              <strong className="live-pay-stage-value">{fmt(s.value)}</strong>
            </div>
          ))}
        </div>
        <div className="live-pay-rates">
          {rates.map((r) => {
            const diffText = fmtDiff(r.diff, labels.vs7);
            return (
              <div key={r.key} className="live-pay-rate">
                <span className="live-pay-rate-line" aria-hidden />
                <div className="live-pay-rate-card">
                  <span className="live-pay-rate-title">{r.title}</span>
                  <strong className="live-pay-rate-value">
                    {fmtRate(r.value)}
                  </strong>
                  {diffText ? (
                    <span
                      className={
                        r.diff != null && r.diff >= 0
                          ? "live-pay-rate-diff up"
                          : "live-pay-rate-diff down"
                      }
                    >
                      {diffText}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="muted live-pay-extra">
        {labels.interactRate} {fmtRate(interactRate)}
        {" · "}
        {labels.followRate} {fmtRate(followRate)}
      </p>
    </div>
  );
}
