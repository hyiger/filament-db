"use client";

import { useEffect, useState } from "react";
import { useIsElectron } from "@/hooks/useIsElectron";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * Tiny banner that surfaces a data-safety footgun in the Electron
 * dev workflow (issue #489).
 *
 * In the packaged app, Electron starts an embedded Next server via
 * `utilityProcess.fork(...)` and the connection-mode wizard
 * (Atlas / Hybrid / Offline) controls which MongoDB the renderer
 * talks to. The setup is end-to-end consistent.
 *
 * In dev mode (`!app.isPackaged`), the renderer is served by a
 * separately-run `next dev` process which reads MONGODB_URI from
 * `.env.local`. Electron's main process still honors the wizard
 * selection (starts/stops local mongo, stores config) — but those
 * actions have NO effect on the renderer's data source. A user who
 * clicks through Offline Mode sees a "Local" status pill while
 * writes go to whatever `.env.local` points to. With `.env.local`
 * pointing at production Atlas, that's a destructive surprise.
 *
 * The right architectural fix would re-route the dev renderer's
 * queries through the embedded mongo, but that needs the next dev
 * process to be relaunched with the embedded mongo's URI in its
 * env — invasive enough to be its own feature. This banner is the
 * minimum we can do today to keep the footgun from firing silently.
 *
 * Renders nothing in:
 *   - The web app (not in Electron at all — no wizard, no embedded
 *     mongo, no mismatch potential).
 *   - The packaged Electron app (the wizard is the truth there).
 */
export default function DevModeBanner() {
  const isElectron = useIsElectron();
  const { t } = useTranslation();
  const [isDev, setIsDev] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    let cancelled = false;
    // The IPC handler always returns synchronously after a Boolean
    // check; we only need to ask once per session. Persist dismissal
    // in sessionStorage so navigating between pages doesn't keep
    // re-summoning the banner the user just dismissed, but DO bring
    // it back on a full app restart (a fresh dev session with a
    // different `.env.local` deserves a fresh warning).
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
        // Restoring persisted dismissal state from sessionStorage —
        // legitimately effect-driven (depends on isElectron), same
        // pattern as the project's other data-fetching effects.
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
