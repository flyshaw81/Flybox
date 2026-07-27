import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useI18n } from "./i18n";
import { useTheme, type ThemeMode } from "./theme";
import { APP_VERSION_LABEL } from "./appVersion";
import {
  DEFAULT_ACCENT,
  DEFAULT_ASSIST,
  normalizeHex,
} from "./brandColors";

export type AppSettings = {
  restoreVault: boolean;
  deepScanDefault: boolean;
  startMinimized: boolean;
  accentColor: string;
  assistColor: string;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  restoreVault: true,
  deepScanDefault: false,
  startMinimized: false,
  accentColor: DEFAULT_ACCENT,
  assistColor: DEFAULT_ASSIST,
};

type Props = {
  open: boolean;
  onClose: () => void;
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

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="settings-color-row">
      <span className="settings-row-text">
        <span className="settings-row-label">{label}</span>
      </span>
      <span className="settings-color-controls">
        <input
          type="color"
          className="settings-color-swatch"
          value={normalizeHex(value, DEFAULT_ACCENT)}
          onChange={(e) => onChange(normalizeHex(e.target.value, DEFAULT_ACCENT))}
        />
        <input
          className="settings-color-hex"
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) =>
            onChange(normalizeHex(e.target.value, normalizeHex(value, DEFAULT_ACCENT)))
          }
        />
      </span>
    </label>
  );
}

export default function SettingsPopover({
  open,
  onClose,
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const patch = useCallback(
    (partial: Partial<AppSettings>) => {
      onChange({ ...settings, ...partial });
    },
    [onChange, settings],
  );

  if (!open) return null;

  return createPortal(
    <div
      className="settings-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="settings-pop"
        role="dialog"
        aria-modal="true"
        aria-label={t("settingsTitle")}
        onMouseDown={(e) => e.stopPropagation()}
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
          <div className="settings-section-label">{t("settingsColors")}</div>
          <ColorRow
            label={t("settingsAccent")}
            value={settings.accentColor}
            onChange={(hex) => patch({ accentColor: hex })}
          />
          <ColorRow
            label={t("settingsAssist")}
            value={settings.assistColor}
            onChange={(hex) => patch({ assistColor: hex })}
          />
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
