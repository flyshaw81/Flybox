import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type CtxItem =
  | {
      id: string;
      label: string;
      danger?: boolean;
      disabled?: boolean;
      onClick: () => void;
    }
  | { id: string; separator: true };

export type CtxMenuState = {
  x: number;
  y: number;
  items: CtxItem[];
} | null;

export function openCtxMenu(
  e: React.MouseEvent,
  items: CtxItem[],
  setMenu: (m: CtxMenuState) => void,
) {
  e.preventDefault();
  e.stopPropagation();
  if (items.length === 0) return;
  setMenu({ x: e.clientX, y: e.clientY, items });
}

export default function ContextMenu({
  menu,
  onClose,
}: {
  menu: CtxMenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pad = 8;
    let x = menu.x;
    let y = menu.y;
    if (x + w > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - w - pad);
    if (y + h > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - h - pad);
    setPos({ x, y });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // 下一帧再绑，避免立刻被同一次右键关掉
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", close);
      window.addEventListener("resize", close);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {menu.items.map((item) => {
        if ("separator" in item && item.separator) {
          return <div key={item.id} className="ctx-sep" role="separator" />;
        }
        if (!("label" in item)) return null;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={item.danger ? "ctx-item danger" : "ctx-item"}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              const action = item.onClick;
              onClose();
              // 先关菜单再跑动作，避免确认框/异步被同帧卸载吞掉
              window.setTimeout(() => action(), 0);
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
