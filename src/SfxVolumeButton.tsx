import { useEffect, useRef, useState } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";

export default function SfxVolumeButton({
  value,
  onChange,
  title,
  tone = "bgm",
  compact = false,
  /** Open a horizontal slider expanding to the left of the icon. */
  expandLeft = false,
}: {
  value: number;
  onChange: (v: number) => void;
  title: string;
  tone?: "bgm" | "sfx";
  /** Sit in the extras bar (right side), not the deck */
  compact?: boolean;
  expandLeft?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const Icon = value <= 0.001 ? VolumeX : value < 0.45 ? Volume1 : Volume2;
  const pct = Math.round(value * 100);

  const rootClass = [
    "sfx-vol-pop",
    tone === "sfx" ? "tone-sfx" : "tone-bgm",
    compact ? "compact" : "",
    expandLeft ? "expand-left" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const btnClass = expandLeft
    ? open
      ? "sfx-tl-tool on"
      : "sfx-tl-tool"
    : compact
      ? open
        ? "sfx-vol-chip on"
        : "sfx-vol-chip"
      : open
        ? "sfx-player-btn vol-btn on"
        : "sfx-player-btn vol-btn";

  return (
    <div className={rootClass} ref={rootRef}>
      {expandLeft && open ? (
        <div className="sfx-vol-pop-panel horiz" role="dialog" aria-label={title}>
          <span className="sfx-vol-pct">{pct}</span>
          <input
            className="sfx-vol-rail horiz"
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={value}
            aria-valuetext={`${title} ${pct}%`}
            autoFocus
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      ) : null}
      <button
        type="button"
        className={btnClass}
        title={`${title} ${pct}%`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon
          size={expandLeft || compact ? 16 : 18}
          strokeWidth={1.75}
          absoluteStrokeWidth
        />
      </button>
      {!expandLeft && open ? (
        <div className="sfx-vol-pop-panel vert" role="dialog" aria-label={title}>
          <span className="sfx-vol-pct">{pct}</span>
          <input
            className="sfx-vol-rail vert"
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={value}
            aria-orientation="vertical"
            aria-valuetext={`${title} ${pct}%`}
            autoFocus
            onChange={(e) => onChange(Number(e.target.value))}
            {...{ orient: "vertical" }}
          />
        </div>
      ) : null}
    </div>
  );
}
