import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n";

type Props = {
  src: string;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
};

type View = { x: number; y: number; scale: number };

/** 圆形裁剪：拖动挪图、滚轮缩放，圆圈内贴到唱片 */
export default function ImageCropModal({ src, onCancel, onConfirm }: Props) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<{
    px: number;
    py: number;
    ox: number;
    oy: number;
  } | null>(null);

  const circleOf = useCallback((sw: number, sh: number) => {
    const d = Math.min(sw, sh) * 0.78;
    return { d, cx: sw / 2, cy: sh / 2, r: d / 2 };
  }, []);

  const fitCover = useCallback(
    (sw: number, sh: number, nw: number, nh: number) => {
      if (!sw || !sh || !nw || !nh) return;
      const { d } = circleOf(sw, sh);
      const scale = Math.max(d / nw, d / nh);
      setView({
        scale,
        x: (sw - nw * scale) / 2,
        y: (sh - nh * scale) / 2,
      });
    },
    [circleOf],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      setStage({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = viewRef.current;
    dragRef.current = { px: e.clientX, py: e.clientY, ox: v.x, oy: v.y };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({
      ...v,
      x: d.ox + (e.clientX - d.px),
      y: d.oy + (e.clientY - d.py),
    }));
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!nat.w || !stage.w) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const { d } = circleOf(stage.w, stage.h);
    setView((v) => {
      const minScale = Math.max(d / nat.w, d / nat.h) * 0.85;
      const next = Math.min(8, Math.max(minScale, v.scale * factor));
      const ratio = next / v.scale;
      return {
        scale: next,
        x: mx - (mx - v.x) * ratio,
        y: my - (my - v.y) * ratio,
      };
    });
  };

  const confirm = () => {
    const im = imgRef.current;
    if (!im || !nat.w || !stage.w) return;
    const { d, cx, cy, r } = circleOf(stage.w, stage.h);
    const v = viewRef.current;
    const left = (cx - r - v.x) / v.scale;
    const top = (cy - r - v.y) / v.scale;
    const srcSize = d / v.scale;
    const side = 512;
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, side, side);
    ctx.beginPath();
    ctx.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    try {
      ctx.drawImage(im, left, top, srcSize, srcSize, 0, 0, side, side);
      onConfirm(canvas.toDataURL("image/jpeg", 0.9));
    } catch (err) {
      console.error(err);
    }
  };

  const { cx, cy, r } = circleOf(stage.w || 1, stage.h || 1);
  const holePath =
    stage.w > 0
      ? `M0 0H${stage.w}V${stage.h}H0Z M${cx} ${cy} m ${-r},0 a ${r},${r} 0 1,0 ${r * 2},0 a ${r},${r} 0 1,0 ${-r * 2},0`
      : "";

  return createPortal(
    <div
      className="img-crop-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="img-crop-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("imgCropTitle")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="img-crop-title">{t("imgCropTitle")}</div>
        <p className="img-crop-hint muted">{t("imgCropHint")}</p>
        <div
          ref={stageRef}
          className="img-crop-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            className="img-crop-img"
            style={{
              width: nat.w ? nat.w * view.scale : undefined,
              height: nat.h ? nat.h * view.scale : undefined,
              transform: `translate(${view.x}px, ${view.y}px)`,
            }}
            onLoad={() => {
              const im = imgRef.current;
              const el = stageRef.current;
              if (!im || !el) return;
              const nw = im.naturalWidth;
              const nh = im.naturalHeight;
              setNat({ w: nw, h: nh });
              fitCover(el.clientWidth, el.clientHeight, nw, nh);
            }}
          />
          {stage.w > 0 ? (
            <svg
              className="img-crop-overlay"
              width={stage.w}
              height={stage.h}
              aria-hidden
            >
              <path d={holePath} fill="rgba(0,0,0,0.58)" fillRule="evenodd" />
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2.5}
              />
            </svg>
          ) : null}
        </div>
        <div className="img-crop-actions">
          <button type="button" className="img-crop-btn ghost" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button type="button" className="img-crop-btn primary" onClick={confirm}>
            {t("imgCropApply")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
