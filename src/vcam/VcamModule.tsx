import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Video } from "lucide-react";
import { useI18n } from "../i18n";

type ModuleChrome = {
  title?: string;
  meta?: string;
  tools?: React.ReactNode;
};

type VcamStatus = {
  deviceName: string;
  installed: boolean;
  running: boolean;
  message: string;
  sourceNote: string;
  dllPath?: string | null;
};

type Props = {
  embedded?: boolean;
  onChromeChange?: (chrome: ModuleChrome | null) => void;
};

export default function VcamModule({ embedded, onChromeChange }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<VcamStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<VcamStatus>("vcam_status");
      setStatus(s);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep status fresh while outputting or after UAC install.
  useEffect(() => {
    const ms = status?.running ? 1500 : 4000;
    const id = window.setInterval(() => {
      void refresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [refresh, status?.running]);

  useEffect(() => {
    if (!embedded || !onChromeChange) return;
    onChromeChange({
      title: t("vcamTitle"),
      meta: status?.running
        ? t("vcamMetaOn")
        : status?.installed
          ? t("vcamMetaReady")
          : t("vcamMetaSetup"),
    });
    return () => onChromeChange(null);
  }, [embedded, onChromeChange, t, status?.running, status?.installed]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setErr(String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const installed = !!status?.installed;
  const running = !!status?.running;
  const canInstall = !busy && !installed && !!status?.dllPath;
  const canUninstall = !busy && installed && !running;
  const canStart = !busy && installed && !running;
  const canStop = !busy && running;

  return (
    <div className="vcam-module">
      <div className="vcam-hero">
        <div className="vcam-hero-icon" aria-hidden>
          <Video size={28} strokeWidth={1.5} />
        </div>
        <div>
          <h2 className="vcam-hero-title">{t("vcamTitle")}</h2>
          <p className="muted vcam-hero-desc">{t("vcamDesc")}</p>
        </div>
      </div>

      <section className="vcam-card">
        <div className="vcam-card-label">{t("vcamStatusTitle")}</div>
        {status ? (
          <ul className="vcam-status-list">
            <li>
              <span className="muted">{t("vcamDeviceName")}</span>
              <strong>{status.deviceName}</strong>
            </li>
            <li>
              <span className="muted">{t("vcamInstalled")}</span>
              <span
                className={
                  installed ? "vcam-pill vcam-pill-ok" : "vcam-pill vcam-pill-off"
                }
              >
                {installed ? t("vcamYes") : t("vcamNo")}
              </span>
            </li>
            <li>
              <span className="muted">{t("vcamRunning")}</span>
              <span
                className={
                  running ? "vcam-pill vcam-pill-live" : "vcam-pill vcam-pill-off"
                }
              >
                {running ? t("vcamYes") : t("vcamNo")}
              </span>
            </li>
            <li className="vcam-status-msg">
              <span className="muted">{status.message}</span>
            </li>
          </ul>
        ) : (
          <p className="muted">{t("vcamLoading")}</p>
        )}
        {err ? <p className="banner error">{err}</p> : null}
        <div className="vcam-actions">
          <button
            type="button"
            className="settings-path-btn"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {t("refresh")}
          </button>
          {!installed ? (
            <button
              type="button"
              className="settings-path-btn vcam-btn-primary"
              disabled={!canInstall}
              onClick={() => void run(() => invoke("vcam_install"))}
            >
              {t("vcamInstall")}
            </button>
          ) : (
            <button
              type="button"
              className="settings-path-btn"
              disabled={!canUninstall}
              onClick={() => void run(() => invoke("vcam_uninstall"))}
            >
              {t("vcamUninstall")}
            </button>
          )}
          {!running ? (
            <button
              type="button"
              className="settings-path-btn vcam-btn-primary"
              disabled={!canStart}
              onClick={() => void run(() => invoke("vcam_start"))}
            >
              {t("vcamStart")}
            </button>
          ) : (
            <button
              type="button"
              className="settings-path-btn"
              disabled={!canStop}
              onClick={() => void run(() => invoke("vcam_stop"))}
            >
              {t("vcamStop")}
            </button>
          )}
        </div>
      </section>

      <section className="vcam-card">
        <div className="vcam-card-label">{t("vcamHowTitle")}</div>
        <ol className="vcam-steps">
          <li>{t("vcamHow1")}</li>
          <li>{t("vcamHow2")}</li>
          <li>{t("vcamHow3")}</li>
        </ol>
        <p className="muted vcam-note">{t("vcamNoteBuild")}</p>
        {status?.sourceNote ? (
          <p className="muted vcam-note">{status.sourceNote}</p>
        ) : null}
      </section>
    </div>
  );
}
