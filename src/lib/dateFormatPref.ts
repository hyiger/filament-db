/**
 * GH #983 — user-selectable date format.
 *
 * The app used to render every date via `Intl.DateTimeFormat(appLocale,
 * { dateStyle: "short" })` (see `src/lib/dateFormat.ts`), so a UK user on
 * the English app locale got US-ordered `M/D/YY` dates with no way to change
 * it. This module is the pure, DB-free, React-free core of the preference:
 * the stored shape, its validation, the preset → pattern resolution, and a
 * deterministic token formatter for the fixed presets + custom patterns.
 *
 * Kept separate from `src/lib/dateFormat.ts` (which owns the locale-aware
 * `Intl` path) so the token logic is small and exhaustively unit-testable
 * against the `src/lib/**` coverage gate. The React binding lives in
 * `src/hooks/useDateFormat.ts`; the Settings UI in
 * `src/components/DateFormatSection.tsx`.
 */

/**
 * `system` follows the device's regional setting (the GH #983 request — a UK
 * PC renders `31/12/2026`); the three named presets are locale-INDEPENDENT
 * fixed patterns (a user who picks "ISO" wants `YYYY-MM-DD` regardless of app
 * language); `custom` is a user-typed pattern.
 */
export type DateFormatMode = "system" | "iso" | "us" | "european" | "custom";

export interface DateFormatPref {
  mode: DateFormatMode;
  /** Only meaningful for `mode: "custom"`, but preserved across preset
   *  switches so toggling away and back keeps the last-typed pattern. */
  pattern?: string;
}

/** Default = follow the device region (preserves the "no explicit choice"
 *  case as the requested system-locale behaviour). */
export const DEFAULT_DATE_FORMAT: DateFormatPref = { mode: "system" };

/** Fixed patterns for the named presets. `system`/`custom` resolve elsewhere. */
export const PRESET_PATTERNS: Record<"iso" | "us" | "european", string> = {
  iso: "YYYY-MM-DD",
  us: "MM/DD/YYYY",
  european: "DD/MM/YYYY",
};

const MODES: readonly DateFormatMode[] = [
  "system",
  "iso",
  "us",
  "european",
  "custom",
];

/**
 * The supported tokens, longest-first so a single regex pass never lets a
 * shorter token (`YY`) consume part of a longer one (`YYYY`). JS alternation
 * is first-match, so ordering `YYYY` before `YY` and `MM`/`DD` before `M`/`D`
 * is load-bearing.
 */
const TOKEN_RE = /YYYY|YY|MM|DD|M|D/g;
const HAS_TOKEN_RE = /YYYY|YY|MM|DD|M|D/;

/** A pattern is usable only if it carries at least one date token; otherwise
 *  it would render as all-literal garbage, so callers fall back to `system`. */
export function isValidPattern(pattern: string): boolean {
  return HAS_TOKEN_RE.test(pattern);
}

/** Coerce an unknown persisted value into a valid preference (defensive: a
 *  corrupt electron-store / localStorage blob must never poison rendering). */
export function normalizeDateFormat(input: unknown): DateFormatPref {
  if (!input || typeof input !== "object") return { mode: "system" };
  const o = input as Record<string, unknown>;
  const mode = MODES.includes(o.mode as DateFormatMode)
    ? (o.mode as DateFormatMode)
    : "system";
  const pattern = typeof o.pattern === "string" ? o.pattern : undefined;
  return pattern !== undefined ? { mode, pattern } : { mode };
}

/**
 * Resolve a preference to a token pattern, or `null` when the caller should
 * use the locale-aware `Intl` path instead (`system`, or an invalid/empty
 * custom pattern — the safe fallback).
 */
export function resolveDatePattern(pref: DateFormatPref): string | null {
  switch (pref.mode) {
    case "iso":
      return PRESET_PATTERNS.iso;
    case "us":
      return PRESET_PATTERNS.us;
    case "european":
      return PRESET_PATTERNS.european;
    case "custom":
      return pref.pattern && isValidPattern(pref.pattern) ? pref.pattern : null;
    case "system":
    default:
      return null;
  }
}

/**
 * Render `date` against a numeric token `pattern`. Non-token characters pass
 * through verbatim as separators.
 *
 * Field values come from a single `Intl.DateTimeFormat(...).formatToParts`
 * with a FIXED locale (`en-US`) so the numeric parts are stable ASCII digits
 * regardless of the app/OS locale — a user who typed `YYYY-MM-DD` wants
 * `2026-05-30`, not locale-native digits or ordering. `timeZone` threads into
 * that formatter so a UTC calendar-day value (spool dates, analytics day-keys)
 * keeps its UTC day instead of shifting ±1 day for users west/east of UTC.
 */
export function formatWithPattern(
  date: Date,
  pattern: string,
  timeZone?: string,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);

  let year = "";
  let month = "";
  let day = "";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
  }

  const yyyy = year.padStart(4, "0");
  // The regex only ever yields the six keys below, so a plain lookup is total
  // (no fallback branch to leave uncovered).
  const values: Record<string, string> = {
    YYYY: yyyy,
    YY: yyyy.slice(-2),
    MM: month.padStart(2, "0"),
    M: String(Number(month)),
    DD: day.padStart(2, "0"),
    D: String(Number(day)),
  };

  return pattern.replace(TOKEN_RE, (tok) => values[tok]);
}
