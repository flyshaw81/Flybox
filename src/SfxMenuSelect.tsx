import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export type SfxMenuOption = { value: string; label: string };

type MenuPos = { left: number; top: number; minWidth: number; openUp: boolean };

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
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
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

  const placeMenu = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const estH = Math.min(options.length * 36 + 12, 280);
    const spaceBelow = window.innerHeight - r.bottom - gap;
    const openUp = spaceBelow < estH && r.top > spaceBelow;
    setMenuPos({
      left: r.left,
      top: openUp ? r.top - gap : r.bottom + gap,
      minWidth: r.width,
      openUp,
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    placeMenu();
    const onReposition = () => placeMenu();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
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

  const menu =
    open && menuPos
      ? createPortal(
          <ul
            ref={listRef}
            className="sfx-menu-select-list portal"
            role="listbox"
            id={listId}
            style={{
              left: menuPos.left,
              top: menuPos.openUp ? undefined : menuPos.top,
              bottom: menuPos.openUp
                ? window.innerHeight - menuPos.top
                : undefined,
              minWidth: menuPos.minWidth,
            }}
          >
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
          </ul>,
          document.body,
        )
      : null;

  return (
    <div className="sfx-menu-select" ref={rootRef} title={title}>
      <span className="sfx-menu-select-label">{label}</span>
      <div className="sfx-menu-select-field">
        <button
          ref={btnRef}
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
      </div>
      {menu}
    </div>
  );
}
