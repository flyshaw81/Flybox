import { useMemo } from "react";
import { useI18n } from "../i18n";
import type { HeatCell } from "./insights";
import { tf } from "./insights";

/** 0 灰 + 1/2/3/5+ 四档（GitHub 贡献墙式） */
const LEVELS = 5;

/** 按场次：0→灰，1→1，2→2，3～4→3，≥5→4 */
function levelBySessions(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3; // 3场、4场
  return 4; // 5场及以上
}

type Props = {
  cells: HeatCell[];
  title: string;
};

/** 标准月历热力：周一～周日 × 1～31 号，按开播场次上色 */
export default function MonthHeatCalendar({ cells, title }: Props) {
  const { t, locale } = useI18n();
  const weekdays = [
    t("liveWdMon"),
    t("liveWdTue"),
    t("liveWdWed"),
    t("liveWdThu"),
    t("liveWdFri"),
    t("liveWdSat"),
    t("liveWdSun"),
  ];

  const { weeks, monthLabel } = useMemo(() => {
    if (!cells.length) {
      return { weeks: [] as Array<Array<HeatCell | null>>, monthLabel: "" };
    }
    const byDay = new Map(cells.map((c) => [c.day, c]));
    const first = cells[0]!;
    const daysInMonth = cells.length;
    const startMon = first.weekdayMon;

    const flat: Array<HeatCell | null> = [];
    for (let i = 0; i < startMon; i++) flat.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      flat.push(byDay.get(d) ?? null);
    }
    while (flat.length % 7 !== 0) flat.push(null);

    const rows: Array<Array<HeatCell | null>> = [];
    for (let i = 0; i < flat.length; i += 7) {
      rows.push(flat.slice(i, i + 7));
    }

    const [y, m] = first.date.split("-");
    return {
      weeks: rows,
      monthLabel:
        y && m ? tf(t, "liveHeatMonth", { y, m: Number(m) }) : "",
    };
  }, [cells, t]);

  if (!weeks.length) return null;

  const loc = locale === "en" ? "en-US" : "zh-CN";

  return (
    <div className="live-slot-heat">
      <div className="live-slot-heat-head">
        <span className="live-section-label" style={{ margin: 0 }}>
          {title}
          {monthLabel ? (
            <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
              {monthLabel}
            </span>
          ) : null}
        </span>
        <div className="live-slot-heat-legend" aria-hidden>
          <span>{t("liveHeatSessions0")}</span>
          {Array.from({ length: LEVELS }, (_, i) => (
            <i key={i} data-level={i} />
          ))}
          <span>{t("liveHeatSessions5")}</span>
        </div>
      </div>

      <div className="live-month-cal">
        <div className="live-month-cal-head">
          {weekdays.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div
          className="live-month-cal-body"
          style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        >
          {weeks.map((row, wi) =>
            row.map((cell, di) => {
              if (!cell) {
                return (
                  <span
                    key={`e-${wi}-${di}`}
                    className="live-month-cal-cell is-empty"
                  />
                );
              }
              const level = levelBySessions(cell.count);
              const tip =
                cell.count > 0
                  ? tf(t, "liveHeatTip", {
                      date: cell.date,
                      count: cell.count,
                      gifts: cell.avgGifts.toLocaleString(loc),
                    })
                  : tf(t, "liveHeatTip0", { date: cell.date });
              return (
                <span
                  key={cell.date}
                  className={`live-month-cal-cell${level === 0 ? " is-zero" : ""}`}
                  data-level={level}
                  title={tip}
                >
                  <em>{cell.day}</em>
                </span>
              );
            }),
          )}
        </div>
      </div>
    </div>
  );
}
