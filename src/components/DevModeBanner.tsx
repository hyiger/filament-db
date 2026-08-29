"use client";

import { useEffect, useState } from "react";
import { useIsElectron } from "@/hooks/useIsElectron";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * Banner for a data-safety footgun in the Electron dev workflow
 * (issue #489): in dev mode (`!app.isPackaged`) the renderer is served
 * by a separately-run `next dev` reading MONGODB_URI from `.env.local`,
 * so the connection-mode wizard's selection has NO effect on the
 * renderer's data source — a user clicking through Offline Mode can be
 * silently writing to production Atlas.
 *
 * Renders nothing in the web app and in the packaged Electron app
 * (where the wizard is the truth).
 */
export default function DevModeBanner() {
  const isElectron = useIsElectron();
  const { t } = useTranslation();
  const [isDev, setIsDev] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    // Dismissal persists in sessionStorage so navigating between pages
    // doesn't re-summon the banner, but a full app restart brings it
    // back (a fresh dev session deserves a fresh warning).
    window.electronAPI
      ?.getRuntimeMode()
      .then(({ isPackaged }) => {
        if (cancelled) return;
        setIsDev(!isPackaged);
      })
      .catch(() => {
        /* IPC unavailable → not in Electron after all; stay silent */
      });
    if (typeof window !== "undefined") {
      const stored = window.sessionStorage.getItem("filamentdb.devModeBannerDismissed");
      if (stored === "1" && !cancelled) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDismissed(true);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  if (!isElectron || !isDev || dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("filamentdb.devModeBannerDismissed", "1");
    }
  };

  return (
    <div
      role="alert"
      className="w-full bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-4 py-2 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-2"
    >
      <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="font-medium">{t("devMode.banner.title")}</p>
        <p className="mt-0.5 text-xs">{t("devMode.banner.body")}</p>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="flex-shrink-0 text-xs text-amber-700 dark:text-amber-400 hover:underline"
        aria-label={t("devMode.banner.dismiss")}
      >
        {t("devMode.banner.dismiss")}
      </button>
    </div>
  );
}
