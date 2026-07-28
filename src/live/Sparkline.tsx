type Props = {
  values: number[];
  width?: number;
  height?: number;
};

export default function Sparkline({ values, width = 280, height = 72 }: Props) {
  if (values.length < 2) {
    return <div className="live-spark empty muted">暂无趋势</div>;
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - 4) + 2;
      const y = height - 4 - ((v - min) / span) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className="live-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      aria-hidden
    >
      <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={pts} />
    </svg>
  );
}
