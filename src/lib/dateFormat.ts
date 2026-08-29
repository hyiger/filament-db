/**
 * GH #446 — locale-aware date / time / datetime formatting. These helpers
 * take the i18n locale from `useTranslation()` and pass it through to Intl
 * (a bare `toLocaleDateString()` follows the browser locale, not the app's).
 * Pure functions (no React) so they work in event handlers, comparators and
 * `useMemo` selectors. All accept a `Date` or anything `new Date(x)` can
 * parse, and silently render an empty string for invalid input rather than
 * throwing "Invalid Date" into the render tree.
 */

import { formatWithPattern } from "./dateFormatPref";
import { getDateTimeFormat } from "./intlCache";

type DateInput = Date | string | number | null | undefined;

function normalise(input: DateInput): Date | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Locale-aware short date — `Intl.DateTimeFormat(locale, { dateStyle: "short" })`.
 *
 * When the caller passes `{ timeZone: "UTC" }` the formatter renders in
 * UTC instead of the browser's local timezone. Use this for values that
 * are semantically CALENDAR DAYS in UTC (e.g. a `YYYY-MM-DD` day key
 * from a server aggregation) — the default local-timezone rendering
 * shifts them by up to ±1 day west/east of UTC.
 *
 * When the caller passes a `pattern` (GH #983), the date is rendered via the
 * deterministic token formatter in `dateFormatPref.ts` instead of the
 * locale-aware `Intl` short form; `pattern` composes with `timeZone`. A
 * null/undefined pattern keeps the original locale-aware behaviour, so every
 * existing caller is unchanged.
 */
export function formatDate(
  input: DateInput,
  locale: string,
  options?: { timeZone?: string; pattern?: string | null },
): string {
  const d = normalise(input);
  if (!d) return "";
  if (options?.pattern) {
    return formatWithPattern(d, options.pattern, options.timeZone);
  }
  try {
    return getDateTimeFormat(locale, {
      dateStyle: "short",
      ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(d);
  } catch {
    // Fall back to the browser-locale form when Intl rejects the supplied
    // locale. Preserve `timeZone` across the fallback so a UTC-flagged input
    // can't silently shift to the browser's local calendar day — that would
    // re-open the off-by-one bug the option was introduced to close.
    return d.toLocaleDateString(
      undefined,
      options?.timeZone ? { timeZone: options.timeZone } : undefined,
    );
  }
}

/** Locale-aware short time — `Intl.DateTimeFormat(locale, { timeStyle: "short" })`. */
export function formatTime(input: DateInput, locale: string): string {
  const d = normalise(input);
  if (!d) return "";
  try {
    return getDateTimeFormat(locale, { timeStyle: "short" }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

/**
 * Locale-aware datetime — short date + short time.
 *
 * GH #983: when a `pattern` is supplied the DATE part follows it while the
 * TIME part stays locale-short (the date-format preference is date-only —
 * time formatting, incl. 12h/24h, is left to the locale). A null/undefined
 * pattern preserves the original combined `Intl` output.
 */
export function formatDateTime(
  input: DateInput,
  locale: string,
  options?: { pattern?: string | null },
): string {
  const d = normalise(input);
  if (!d) return "";
  if (options?.pattern) {
    // Date part follows the pattern; time part stays locale-short. `d` is
    // already validated, so formatTime always yields a non-empty time.
    return `${formatWithPattern(d, options.pattern)}, ${formatTime(d, locale)}`;
  }
  try {
    return getDateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}
