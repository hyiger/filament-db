"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import type { UpdateStatus } from "@/types/electron";

/**
 * Thin bar at the top of the app that surfaces auto-update state. Only
 * mounts inside Electron; in the browser it renders nothing.
 *
 * States it handles:
 *   available     — "New version X ready to download" + Download / Dismiss
 *   downloading   — progress bar
 *   ready         — "X downloaded, restart to install" + Restart / Later
 *   error         — plus a "Open release page" fallback link for unsigned
 *                   macOS builds where Gatekeeper blocks auto-install.
 *   idle / checking / not-available — renders nothing (no noise).
 */
export default function UpdateBanner() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const isElectron = typeof window !== "undefined" && !!window.electronAPI;

  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI!;
    // Seed with the current state so we don't miss an event that fired
    // before we mounted.
    api.updateGetStatus().then(setStatus).catch(() => {});
    return api.onUpdateStatus(setStatus);
  }, [isElectron]);

  if (!isElectron) return null;

  const hidden =
    status.state === "idle" ||
    status.state === "checking" ||
    status.state === "not-available" ||
    (status.state === "available" && status.version === dismissedVersion);
  if (hidden) return null;

  const handleDownload = () => window.electronAPI!.updateDownload();
  const handleInstall = () => window.electronAPI!.updateInstall();
  const handleOpenPage = () => window.electronAPI!.updateOpenReleasePage();
  const handleDismiss = () => setDismissedVersion(status.version ?? "");

  let body: React.ReactNode = null;
  let tone = "bg-blue-600";

  if (status.state === "available") {
    body = (
      <>
        <span>{t("update.available", { version: status.version ?? "" })}</span>
        <button
          onClick={handleDownload}
          className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-xs"
        >
          {t("update.download")}
        </button>
        <button
          onClick={handleOpenPage}
          className="text-xs underline opacity-80 hover:opacity-100"
        >
          {t("update.viewRelease")}
        </button>
        <button
          onClick={handleDismiss}
          aria-label={t("update.dismiss")}
          className="ml-auto text-xs opacity-80 hover:opacity-100"
        >
          ×
        </button>
      </>
    );
  } else if (status.state === "downloading") {
    const pct = status.progress ? Math.round(status.progress.percent) : 0;
    body = (
      <>
        <span>{t("update.downloading", { percent: pct })}</span>
        <div className="flex-1 max-w-xs h-1.5 bg-white/20 rounded-full overflow-hidden">
          <div className="h-full bg-white" style={{ width: `${pct}%` }} />
        </div>
      </>
    );
  } else if (status.state === "ready") {
    tone = "bg-green-600";
    body = (
      <>
        <span>{t("update.ready", { version: status.version ?? "" })}</span>
        <button
          onClick={handleInstall}
          className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-xs"
        >
          {t("update.restart")}
        </button>
      </>
    );
  } else if (status.state === "error") {
    tone = "bg-amber-600";
    body = (
      <>
        <span>{t("update.error", { error: status.error ?? "" })}</span>
        <button
          onClick={handleOpenPage}
          className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-xs"
        >
          {t("update.viewRelease")}
        </button>
        <button
          onClick={handleDismiss}
          aria-label={t("update.dismiss")}
          className="ml-auto text-xs opacity-80 hover:opacity-100"
        >
          ×
        </button>
      </>
    );
  }

  return (
    <div
      role="status"
      className={`${tone} text-white text-sm px-3 py-1.5 flex items-center gap-3`}
    >
      {body}
    </div>
  );
}
