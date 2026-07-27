import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export type SfxMenuOption = { value: string; label: string };

export default function SfxMenuSelect({
  label,
  title,
  value,
  options,
  onChange,
}: {
  label: string;
  title?: string;
  value: string;
  options: SfxMenuOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [valueWidth, setValueWidth] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  useLayoutEffect(() => {
    const host = measureRef.current;
    if (!host) return;
    let max = 0;
    for (const node of host.children) {
      max = Math.max(max, (node as HTMLElement).offsetWidth);
    }
    if (max > 0) setValueWidth(max);
  }, [options]);

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

  return (
    <div className="sfx-menu-select" ref={rootRef} title={title}>
      <span className="sfx-menu-select-label">{label}</span>
      <div className="sfx-menu-select-field">
        <button
          type="button"
          className={open ? "sfx-menu-select-btn on" : "sfx-menu-select-btn"}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className="sfx-menu-select-value"
            style={valueWidth != null ? { width: valueWidth } : undefined}
          >
            {current?.label ?? value}
          </span>
          <ChevronDown size={14} strokeWidth={2} absoluteStrokeWidth />
        </button>
        <span className="sfx-menu-select-measure" aria-hidden ref={measureRef}>
          {options.map((o) => (
            <span key={o.value}>{o.label}</span>
          ))}
        </span>
        {open ? (
          <ul className="sfx-menu-select-list" role="listbox" id={listId}>
            {options.map((o) => (
              <li key={o.value} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  className={
                    o.value === value ? "sfx-menu-select-opt on" : "sfx-menu-select-opt"
                  }
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  {o.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
