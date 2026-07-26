/**
 * 日夜主题：顶栏一个图标点击切换，写入 settings.json
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { load } from "@tauri-apps/plugin-store";
import { Moon, Sun } from "lucide-react";
import { useI18n } from "./i18n";

export type ThemeMode = "dark" | "light";

type ThemeCtx = {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
};

const Ctx = createContext<ThemeCtx | null>(null);
const STORE = "settings.json";
const THEME_KEY = "theme";

function applyDomTheme(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", mode);
  document.documentElement.style.colorScheme = mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("dark");

  useEffect(() => {
    let cancelled = false;
    // 默认深色，避免闪白
    applyDomTheme("dark");
    (async () => {
      try {
        const store = await load(STORE, { autoSave: true });
        const saved = await store.get<string>(THEME_KEY);
        if (!cancelled && (saved === "dark" || saved === "light")) {
          setThemeState(saved);
          applyDomTheme(saved);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    applyDomTheme(t);
    void (async () => {
      try {
        const store = await load(STORE, { autoSave: true });
        await store.set(THEME_KEY, t);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside provider");
  return v;
}

/** 顶栏：一个图标，点一下日↔夜 */
export function ThemeButton({ className = "icon-btn" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const nextIsLight = theme === "dark";
  return (
    <button
      type="button"
      className={className}
      title={nextIsLight ? t("themeToLight") : t("themeToDark")}
      onClick={toggleTheme}
      data-theme-btn={theme}
    >
      {theme === "dark" ? (
        <Sun size={15} strokeWidth={1.75} absoluteStrokeWidth />
      ) : (
        <Moon size={15} strokeWidth={1.75} absoluteStrokeWidth />
      )}
    </button>
  );
}
