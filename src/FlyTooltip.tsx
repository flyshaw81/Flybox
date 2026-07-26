/**
 * 全局悬停提示：拦截原生 title，改用 FLYBOX 深色样式（与右键菜单一致）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TipState = {
  text: string;
  x: number;
  y: number;
  place: "below" | "above";
};

function titledEl(from: EventTarget | null): HTMLElement | null {
  let el = from as HTMLElement | null;
  while (el && el !== document.documentElement) {
    if (el.nodeType === 1) {
      const t = el.getAttribute("title");
      const d = el.dataset.flyTip;
      if ((t && t.trim()) || (d && d.trim())) return el;
    }
    el = el.parentElement;
  }
  return null;
}

export default function FlyTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const savedRef = useRef("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const restoreTitle = () => {
      const el = activeRef.current;
      if (el && savedRef.current) {
        el.setAttribute("title", savedRef.current);
        delete el.dataset.flyTip;
      }
      activeRef.current = null;
      savedRef.current = "";
    };

    const hide = () => {
      clearTimer();
      restoreTitle();
      setTip(null);
    };

    const showFor = (el: HTMLElement) => {
      const text = (el.getAttribute("title") || el.dataset.flyTip || "").trim();
      if (!text) return;

      // 摘掉 title，避免系统黄框再弹
      if (el.getAttribute("title")) {
        savedRef.current = el.getAttribute("title") || text;
        el.dataset.flyTip = savedRef.current;
        el.removeAttribute("title");
      } else {
        savedRef.current = el.dataset.flyTip || text;
      }
      activeRef.current = el;

      const rect = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const place: "below" | "above" = spaceBelow < 40 ? "above" : "below";
      const x = rect.left + rect.width / 2;
      const y = place === "below" ? rect.bottom + 8 : rect.top - 8;

      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setTip({ text: savedRef.current, x, y, place });
      }, 380);
    };

    const onOver = (e: MouseEvent) => {
      const el = titledEl(e.target);
      if (!el) return;
      if (el === activeRef.current) return;
      hide();
      showFor(el);
    };

    const onOut = (e: MouseEvent) => {
      const el = activeRef.current;
      if (!el) return;
      const related = e.relatedTarget as Node | null;
      if (related && el.contains(related)) return;
      // 离开当前带 tip 的节点
      const still = titledEl(e.relatedTarget);
      if (still === el) return;
      hide();
    };

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("mousedown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("blur", hide);

    return () => {
      hide();
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("mousedown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // 贴边修正，避免出屏
  useLayoutEffect(() => {
    if (!tip || !boxRef.current) return;
    const box = boxRef.current;
    const pad = 8;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let x = tip.x;
    let y = tip.y;
    const half = w / 2;
    if (x - half < pad) x = pad + half;
    if (x + half > window.innerWidth - pad) x = window.innerWidth - pad - half;
    if (tip.place === "below") {
      if (y + h > window.innerHeight - pad) y = Math.max(pad, tip.y - h - 16);
    } else {
      y = y - h;
      if (y < pad) y = pad;
    }
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
  }, [tip]);

  if (!tip) return null;

  return createPortal(
    <div
      ref={boxRef}
      className={`fly-tip fly-tip-${tip.place}`}
      role="tooltip"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
