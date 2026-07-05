"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import {
  NumberFormatPref,
  DEFAULT_NUMBER_FORMAT,
  normalizeNumberFormat,
  resolveSeparators,
  formatWithSeparators,
  type Separators,
  type FormatOptions,
} from "@/lib/numberFormatPref";
import { formatGrams as pureFormatGrams } from "@/lib/formatWeight";

/**
 * useNumberFormat — the global number-format preference (sibling of
 * useDateFormat). Module store + useSyncExternalStore so the Settings editor
 * and every number-rendering page share live state. Persistence mirrors
 * useDateFormat: electron-store key `numberFormat` / localStorage
 * `filamentdb-number-format`.
 *
 * HYDRATION SAFETY: the `ready` flag gates preference application. During SSR
 * and the first client render the formatters behave EXACTLY as before this
 * feature (bare `formatGrams`, plain `.`-decimal, no grouping) — identical on
 * server and client, so no React 19 hydration mismatch. A post-mount effect
 * reads the persisted preference + device locale (`navigator.language`, for
 * `system` mode), flips `ready`, and re-renders, at which point grouping /
 * separators take effect.
 */

const STORAGE_KEY = "filamentdb-number-format";

interface Snapshot {
  config: NumberFormatPref;
  ready: boolean;
  osLocale?: string;
}

const SERVER_SNAPSHOT: Snapshot = { config: DEFAULT_NUMBER_FORMAT, ready: false };

let snapshot: Snapshot | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function readInitial(): NumberFormatPref {
  if (typeof window === "undefined") return DEFAULT_NUMBER_FORMAT;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeNumberFormat(JSON.parse(saved));
  } catch {
    // localStorage unavailable / corrupt JSON → default
  }
  return DEFAULT_NUMBER_FORMAT;
}

function getSnapshot(): Snapshot {
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

function persist(config: NumberFormatPref) {
  const json = JSON.stringify(config);
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (api?.saveConfig) {
    api.saveConfig({ numberFormat: json } as Record<string, string>).catch(() => {});
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      // ignore — quota / disabled storage
    }
  }
}

/** Update the global preference: normalize, persist, notify all instances. */
export function setNumberFormat(next: NumberFormatPref) {
  const config = normalizeNumberFormat(next);
  const prev = getSnapshot();
  snapshot = { config, ready: true, osLocale: prev.osLocale };
  persist(config);
  emit();
}

export function useNumberFormat() {
  const { locale } = useTranslation();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (hydrated) return;
    hydrated = true;
    const osLocale =
      typeof navigator !== "undefined" ? navigator.language : undefined;
    const finish = (config: NumberFormatPref) => {
      snapshot = { config, ready: true, osLocale };
      emit();
    };
    const api = window.electronAPI;
    if (api?.getConfig) {
      api
        .getConfig()
        .then((cfg) => {
          const c = cfg as Record<string, unknown>;
          if (typeof c.numberFormat === "string") {
            try {
              finish(normalizeNumberFormat(JSON.parse(c.numberFormat)));
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
  // Resolved separators (or null = system/Intl path). Null pre-`ready` so the
  // first render matches the server. Also consumed by useCurrency.
  const separators: Separators | null = ready ? resolveSeparators(config) : null;
  const deviceLocale = osLocale ?? locale;
  // The locale to use for Intl-based (system-mode) number/currency grouping.
  // `undefined` pre-`ready` so callers keep their app-locale default and the
  // first render matches the server. Post-`ready` it's the device locale, so
  // currency in system mode groups per device — matching weights/counts
  // (Codex P2: otherwise system-mode prices stayed on the app locale).
  const systemLocale = ready ? deviceLocale : undefined;
  const group = separators?.group;
  const decimal = separators?.decimal;

  const formatGrams = useCallback(
    (value: number | null | undefined, decimals = 2): string => {
      if (value == null || !Number.isFinite(value)) return "";
      if (!ready) return pureFormatGrams(value, decimals); // today's exact output
      if (group !== undefined && decimal !== undefined) {
        return formatWithSeparators(value, { group, decimal }, {
          maxDecimals: decimals,
          trimTrailingZeros: true,
          useGrouping: true,
        });
      }
      // system mode: device-locale grouping via Intl (trims trailing zeros).
      try {
        return new Intl.NumberFormat(deviceLocale, {
          maximumFractionDigits: decimals,
        }).format(value);
      } catch {
        return pureFormatGrams(value, decimals);
      }
    },
    [ready, group, decimal, deviceLocale],
  );

  const formatNumber = useCallback(
    (value: number | null | undefined, opts: FormatOptions = {}): string => {
      if (value == null || !Number.isFinite(value)) return "";
      const minDecimals = opts.minDecimals ?? 0;
      const maxDecimals = opts.maxDecimals ?? 2;
      const trimTrailingZeros = opts.trimTrailingZeros ?? minDecimals === 0;
      const useGrouping = opts.useGrouping ?? true;
      if (!ready) {
        // Plain `.`-decimal, no grouping — matches the toFixed sites we replace.
        return formatWithSeparators(value, { group: "", decimal: "." }, {
          minDecimals,
          maxDecimals,
          trimTrailingZeros,
          useGrouping: false,
        });
      }
      if (group !== undefined && decimal !== undefined) {
        return formatWithSeparators(value, { group, decimal }, {
          minDecimals,
          maxDecimals,
          trimTrailingZeros,
          useGrouping,
        });
      }
      try {
        return new Intl.NumberFormat(deviceLocale, {
          minimumFractionDigits: minDecimals,
          maximumFractionDigits: maxDecimals,
          useGrouping,
        }).format(value);
      } catch {
        return formatWithSeparators(value, { group: ",", decimal: "." }, {
          minDecimals,
          maxDecimals,
          trimTrailingZeros,
          useGrouping,
        });
      }
    },
    [ready, group, decimal, deviceLocale],
  );

  return useMemo(
    () => ({ config, setConfig: setNumberFormat, separators, systemLocale, formatGrams, formatNumber }),
    [config, separators, systemLocale, formatGrams, formatNumber],
  );
}
