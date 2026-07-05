"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import {
  DateFormatPref,
  DEFAULT_DATE_FORMAT,
  normalizeDateFormat,
  resolveDatePattern,
} from "@/lib/dateFormatPref";
import {
  formatDate as libFormatDate,
  formatDateTime as libFormatDateTime,
  formatTime as libFormatTime,
} from "@/lib/dateFormat";

/**
 * useDateFormat — the global date-format preference (GH #983).
 *
 * Backed by a module-level store via useSyncExternalStore (the useLabelFormat
 * pattern) so the Settings editor and every date-rendering page share live
 * state without a Provider. Persistence mirrors useLabelFormat: electron-store
 * (`dateFormat`) is the source of truth on desktop; a localStorage copy
 * (`filamentdb-date-format`) serves web-mode users.
 *
 * HYDRATION SAFETY: the `ready` flag gates preference application. During SSR
 * and the first client render, `ready` is false and the returned formatters
 * behave EXACTLY as before this feature (locale-aware `Intl` short form with
 * the app locale) — identical on server and client, so no React 19 hydration
 * mismatch. A one-time post-mount effect reads the persisted preference AND
 * the device locale (`navigator.language`, for `system` mode), flips `ready`,
 * and re-renders. So the preference — including the device-region system mode
 * — only takes effect after mount, never during the hydration-critical render.
 */

const STORAGE_KEY = "filamentdb-date-format";

interface Snapshot {
  config: DateFormatPref;
  /** false until the post-mount hydration effect has run */
  ready: boolean;
  /** device locale for `system` mode; only set after hydration */
  osLocale?: string;
}

const SERVER_SNAPSHOT: Snapshot = { config: DEFAULT_DATE_FORMAT, ready: false };

let snapshot: Snapshot | null = null;
let hydrated = false; // hydration effect runs once per session
const listeners = new Set<() => void>();

function readInitial(): DateFormatPref {
  if (typeof window === "undefined") return DEFAULT_DATE_FORMAT;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeDateFormat(JSON.parse(saved));
  } catch {
    // localStorage unavailable / corrupt JSON → default
  }
  return DEFAULT_DATE_FORMAT;
}

function getSnapshot(): Snapshot {
  // config is read eagerly (so the Settings UI highlights the right choice
  // from first render) but `ready` stays false so formatting output matches
  // the server until the post-mount effect runs.
  if (snapshot === null) snapshot = { config: readInitial(), ready: false };
  return snapshot;
}

function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit() {
  for (const l of listeners) l();
}

function persist(config: DateFormatPref) {
  const json = JSON.stringify(config);
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (api?.saveConfig) {
    api.saveConfig({ dateFormat: json } as Record<string, string>).catch(() => {});
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      // ignore — quota / disabled storage
    }
  }
}

/** Update the global preference: normalize, persist, and notify all instances. */
export function setDateFormat(next: DateFormatPref) {
  const config = normalizeDateFormat(next);
  const prev = getSnapshot();
  snapshot = { config, ready: true, osLocale: prev.osLocale };
  persist(config);
  emit();
}

export function useDateFormat() {
  const { locale } = useTranslation();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // One-time hydration: capture the device locale + override from electron-store,
  // then flip `ready` so the preference starts applying. Module-scoped so it
  // runs once regardless of how many instances mount.
  useEffect(() => {
    if (hydrated) return;
    hydrated = true;
    const osLocale =
      typeof navigator !== "undefined" ? navigator.language : undefined;
    const finish = (config: DateFormatPref) => {
      snapshot = { config, ready: true, osLocale };
      emit();
    };
    const api = window.electronAPI;
    if (api?.getConfig) {
      api
        .getConfig()
        .then((cfg) => {
          const c = cfg as Record<string, unknown>;
          if (typeof c.dateFormat === "string") {
            try {
              finish(normalizeDateFormat(JSON.parse(c.dateFormat)));
              return;
            } catch {
              /* corrupt stored value → fall through to current */
            }
          }
          finish(getSnapshot().config);
        })
        .catch(() => finish(getSnapshot().config));
    } else {
      finish(getSnapshot().config);
    }
  }, []);

  const { config, ready, osLocale } = snap;
  const pattern = ready ? resolveDatePattern(config) : null;
  // When there's no token pattern — `system` mode, OR a `custom` pattern that
  // was empty/invalid and so collapsed to null — render in the device region.
  // That's the documented "system" fallback; keying it on `pattern === null`
  // (not `mode === "system"`) stops an invalid custom pattern from silently
  // reverting to app-locale date ordering (Codex P2). A non-null pattern
  // renders locale-independently, so `locale` there is moot. Pre-`ready` we
  // use the app locale so the first render matches the server (no hydration
  // mismatch); `osLocale` is only set post-mount.
  const dateLocale =
    ready && pattern === null ? osLocale ?? locale : locale;

  const formatDate = useCallback(
    (input: Parameters<typeof libFormatDate>[0], opts?: { timeZone?: string }) =>
      libFormatDate(input, dateLocale, {
        timeZone: opts?.timeZone,
        pattern,
      }),
    [dateLocale, pattern],
  );

  const formatDateTime = useCallback(
    (input: Parameters<typeof libFormatDateTime>[0]) =>
      libFormatDateTime(input, dateLocale, { pattern }),
    [dateLocale, pattern],
  );

  const formatTime = useCallback(
    (input: Parameters<typeof libFormatTime>[0]) =>
      libFormatTime(input, dateLocale),
    [dateLocale],
  );

  return { config, setConfig: setDateFormat, formatDate, formatDateTime, formatTime };
}
