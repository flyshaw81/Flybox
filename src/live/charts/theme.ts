export type ChartTheme = {
  text: string;
  muted: string;
  soft: string;
  accent: string;
  assist: string;
  border: string;
  panel: string;
  danger: string;
};

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

export function readChartTheme(): ChartTheme {
  return {
    text: cssVar("--text", "#f2f2f2"),
    muted: cssVar("--muted", "#8a8a8a"),
    soft: cssVar("--soft", "#b0b0b0"),
    accent: cssVar("--accent", "#ff6a00"),
    assist: cssVar("--assist", "#4a90d9"),
    border: cssVar("--border-strong", "#2a2a2a"),
    panel: cssVar("--menu-bg", "#161616"),
    danger: cssVar("--danger", "#e07070"),
  };
}
