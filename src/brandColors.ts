/** 全系统强调色 / 辅助色 */

export const DEFAULT_ACCENT = "#ff6a00";
export const DEFAULT_ASSIST = "#4a90d9";

export function normalizeHex(input: string, fallback: string): string {
  const s = input.trim();
  const m = s.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return `#${h.toLowerCase()}`;
}

/** 写入 :root，全应用 CSS var(--accent) / var(--assist) 生效 */
export function applyBrandColors(accent: string, assist: string) {
  const a = normalizeHex(accent, DEFAULT_ACCENT);
  const b = normalizeHex(assist, DEFAULT_ASSIST);
  const root = document.documentElement;
  root.style.setProperty("--accent", a);
  root.style.setProperty("--assist", b);
  root.style.setProperty("--sfx-accent", a);
}
