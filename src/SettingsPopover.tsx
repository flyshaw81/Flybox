import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useI18n } from "./i18n";
import { useTheme, type ThemeMode } from "./theme";
import { APP_VERSION_LABEL } from "./appVersion";

export type AppSettings = {
  restoreVault: boolean;
  deepScanDefault: boolean;
  startMinimized: boolean;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  restoreVault: true,
  deepScanDefault: false,
  startMinimized: false,
};

type Props = {
  open: boolean;
  onClose: () => void;
  anchor: DOMRect | null;
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  autostart: boolean;
  onAutostartChange: (on: boolean) => Promise<void>;
  autostartBusy?: boolean;
};

function SwitchRow({
  label,
  hint,
  on,
  disabled,
  onToggle,
}: {
  label: string;
  hint?: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={on ? "settings-row on" : "settings-row"}
      onClick={onToggle}
      disabled={disabled}
    >
      <span className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        {hint ? <span className="settings-row-hint">{hint}</span> : null}
      </span>
      <span className={on ? "settings-switch on" : "settings-switch"} aria-hidden>
        <span className="settings-switch-knob" />
      </span>
      <span className="sr-only">{on ? t("settingsOn") : t("settingsOff")}</span>
    </button>
  );
}

export default function SettingsPopover({
  open,
  onClose,
  anchor,
  settings,
  onChange,
  autostart,
  onAutostartChange,
  autostartBusy,
}: Props) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 用 click 捕获：点弹窗外（含整条顶栏）即关；Logo 自己负责开关，这里跳过避免「先关再开」
    const onClickCapture = (e: MouseEvent) => {
      const el = panelRef.current;
      if (!el) return;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (el.contains(t)) return;
      if (t instanceof Element && t.closest(".logo-btn")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClickCapture, true);
    };
  }, [open, onClose]);

  const patch = useCallback(
    (partial: Partial<AppSettings>) => {
      onChange({ ...settings, ...partial });
    },
    [onChange, settings],
  );

  if (!open || !anchor) return null;

  const top = Math.min(anchor.bottom + 8, window.innerHeight - 24);
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - 320 - 12));

  return createPortal(
    <div
      ref={panelRef}
      className="settings-pop"
      role="dialog"
      aria-label={t("settingsTitle")}
      style={{ top, left }}
    >
      <div className="settings-pop-title">{t("settingsTitle")}</div>

      <div className="settings-section">
        <SwitchRow
          label={t("settingsAutostart")}
          hint={t("settingsAutostartHint")}
          on={autostart}
          disabled={autostartBusy}
          onToggle={() => void onAutostartChange(!autostart)}
        />
        <SwitchRow
          label={t("settingsRestoreVault")}
          hint={t("settingsRestoreVaultHint")}
          on={settings.restoreVault}
          onToggle={() => patch({ restoreVault: !settings.restoreVault })}
        />
        <SwitchRow
          label={t("settingsDeepDefault")}
          hint={t("settingsDeepDefaultHint")}
          on={settings.deepScanDefault}
          onToggle={() => patch({ deepScanDefault: !settings.deepScanDefault })}
        />
        <SwitchRow
          label={t("settingsStartMin")}
          hint={t("settingsStartMinHint")}
          on={settings.startMinimized}
          onToggle={() => patch({ startMinimized: !settings.startMinimized })}
        />
      </div>

      <div className="settings-section">
        <div className="settings-section-label">{t("settingsTheme")}</div>
        <div className="settings-seg">
          <button
            type="button"
            className={theme === "dark" ? "settings-seg-btn on" : "settings-seg-btn"}
            onClick={() => setTheme("dark" as ThemeMode)}
          >
            {t("settingsThemeDark")}
          </button>
          <button
            type="button"
            className={theme === "light" ? "settings-seg-btn on" : "settings-seg-btn"}
            onClick={() => setTheme("light" as ThemeMode)}
          >
            {t("settingsThemeLight")}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-label">{t("settingsLang")}</div>
        <div className="settings-seg">
          <button
            type="button"
            className={locale === "zh" ? "settings-seg-btn on" : "settings-seg-btn"}
            onClick={() => setLocale("zh")}
          >
            {t("langZh")}
          </button>
          <button
            type="button"
            className={locale === "en" ? "settings-seg-btn on" : "settings-seg-btn"}
            onClick={() => setLocale("en")}
          >
            {t("langEn")}
          </button>
        </div>
      </div>

      <div className="settings-about">
        <div className="settings-about-name">
          FLYBOX · {t("settingsVersion")} {APP_VERSION_LABEL}
        </div>
        <div className="settings-about-note">{t("settingsLocalOnly")}</div>
      </div>
    </div>,
    document.body,
  );
}

/** 读系统自启状态（失败当 false） */
export async function readAutostart(): Promise<boolean> {
  try {
    return await isEnabled();
  } catch {
    return false;
  }
}

export async function setAutostart(on: boolean): Promise<void> {
  if (on) await enable();
  else await disable();
}
