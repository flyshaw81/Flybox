import { useEffect, useRef } from "react";
import type { EChartsOption } from "echarts";
import { ensureEcharts } from "./register";

type Props = {
  option: EChartsOption;
  className?: string;
  height?: number;
};

function isResizing(): boolean {
  return document.documentElement.classList.contains("is-resizing");
}

export default function LiveEChart({
  option,
  className = "",
  height = 240,
}: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<
    ReturnType<typeof ensureEcharts>["init"]
  > | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const echarts = ensureEcharts();
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    let raf = 0;
    let dirty = false;

    const applyResize = () => {
      raf = 0;
      if (isResizing()) {
        dirty = true;
        return;
      }
      dirty = false;
      chart.resize();
    };

    const scheduleResize = () => {
      if (isResizing()) {
        dirty = true;
        return;
      }
      if (raf) return;
      raf = requestAnimationFrame(applyResize);
    };

    // 拖边框时只记脏，松手后再 resize，避免每帧重算图表
    const mo = new MutationObserver(() => {
      if (!isResizing() && dirty) scheduleResize();
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleResize)
        : null;
    ro?.observe(el);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      mo.disconnect();
      ro?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={elRef}
      className={`live-echart ${className}`.trim()}
      style={{ height }}
      tabIndex={-1}
    />
  );
}
