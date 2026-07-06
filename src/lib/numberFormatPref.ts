/**
 * GH — user-selectable number formatting (sibling of src/lib/dateFormatPref.ts).
 *
 * Numbers across the app rendered with a hard-coded `.` decimal and no digit
 * grouping (or the browser's locale via `toLocaleString`). This module is the
 * pure, DB-free, React-free core of a preference that lets the user pick the
 * grouping + decimal separators: System (device locale), US/UK, European,
 * Space-separated, or a Custom pair.
 *
 * Mirrors the date-format core exactly: a small preference shape, defensive
 * normalization of a persisted blob, a `resolveSeparators` that returns `null`
 * to mean "use the locale-aware `Intl` path", and a deterministic formatter.
 * The React binding is src/hooks/useNumberFormat.ts; the Settings UI is
 * src/components/NumberFormatSection.tsx.
 */

/**
 * `system` follows the device's locale via `Intl.NumberFormat`; `usuk`,
 * `european`, `space` are fixed separator pairs; `none` disables thousands
 * grouping entirely (`12345689.56`); `custom` is a user-chosen pair.
 * (US and UK number formats are identical, so they share one preset.)
 */
export type NumberFormatMode =
  | "system"
  | "usuk"
  | "european"
  | "space"
  | "none"
  | "custom";

export interface NumberFormatPref {
  mode: NumberFormatMode;
  /** Only meaningful for `mode: "custom"`, but preserved across preset switches
   *  so toggling away and back keeps the last-typed pair. */
  group?: string;
  decimal?: string;
}

/** Default = follow the device locale (the requested "system default"). */
export const DEFAULT_NUMBER_FORMAT: NumberFormatPref = { mode: "system" };

/** The narrow no-break space (U+202F) is what modern ICU emits for fr-FR / SI
 *  grouping; it never line-wraps and is unambiguous with a value boundary. */
export const GROUP_SPACE = "\u202f";

export interface Separators {
  group: string;
  decimal: string;
}

/** Fixed separator pairs for the named presets. `system`/`custom` resolve
 *  elsewhere. `none` uses an empty group separator (no thousands grouping). */
export const PRESET_SEPARATORS: Record<
  "usuk" | "european" | "space" | "none",
  Separators
> = {
  usuk: { group: ",", decimal: "." },
  european: { group: ".", decimal: "," },
  space: { group: GROUP_SPACE, decimal: "," },
  none: { group: "", decimal: "." },
};

const MODES: readonly NumberFormatMode[] = [
  "system",
  "usuk",
  "european",
  "space",
  "none",
  "custom",
];

/**
 * A custom pair is usable only if both separators are a single non-digit
 * character and they differ (otherwise the output is ambiguous/garbage).
 * Mirrors `isValidPattern` in the date core.
 */
export function isValidSeparators(group: string, decimal: string): boolean {
  const ok = (s: string) => typeof s === "string" && s.length === 1 && !/[0-9]/.test(s);
  return ok(group) && ok(decimal) && group !== decimal;
}

/** Coerce an unknown persisted value into a valid preference (a corrupt
 *  electron-store / localStorage blob must never poison rendering). */
export function normalizeNumberFormat(input: unknown): NumberFormatPref {
  if (!input || typeof input !== "object") return { mode: "system" };
  const o = input as Record<string, unknown>;
  const mode = MODES.includes(o.mode as NumberFormatMode)
    ? (o.mode as NumberFormatMode)
    : "system";
  const group = typeof o.group === "string" ? o.group : undefined;
  const decimal = typeof o.decimal === "string" ? o.decimal : undefined;
  const out: NumberFormatPref = { mode };
  if (group !== undefined) out.group = group;
  if (decimal !== undefined) out.decimal = decimal;
  return out;
}

/**
 * Resolve a preference to a separator pair, or `null` when the caller should
 * use the locale-aware `Intl` path instead (`system`, or an invalid/empty
 * custom pair — the safe fallback).
 */
export function resolveSeparators(pref: NumberFormatPref): Separators | null {
  switch (pref.mode) {
    case "usuk":
      return PRESET_SEPARATORS.usuk;
    case "european":
      return PRESET_SEPARATORS.european;
    case "space":
      return PRESET_SEPARATORS.space;
    case "none":
      return PRESET_SEPARATORS.none;
    case "custom":
      return pref.group !== undefined &&
        pref.decimal !== undefined &&
        isValidSeparators(pref.group, pref.decimal)
        ? { group: pref.group, decimal: pref.decimal }
        : null;
    case "system":
    default:
      return null;
  }
}

export interface FormatOptions {
  /** Minimum fraction digits (default 0). */
  minDecimals?: number;
  /** Maximum fraction digits (default 2). */
  maxDecimals?: number;
  /** Drop trailing zeros in the fraction (default true) — the formatGrams look. */
  trimTrailingZeros?: boolean;
  /** Group the integer part in thousands (default true). */
  useGrouping?: boolean;
}

/**
 * Render `value` with the given separators. Pure and deterministic (no `Intl`),
 * so preset/custom output is stable across ICU/Node versions.
 *
 * Rounding uses the decimal-shift-through-the-parser trick from formatGrams so
 * exact .005-type ties round up rather than landing just below the tie.
 */
export function formatWithSeparators(
  value: number,
  sep: Separators,
  opts: FormatOptions = {},
): string {
  if (value == null || !Number.isFinite(value)) return "";
  const maxDecimals = opts.maxDecimals ?? 2;
  const minDecimals = opts.minDecimals ?? 0;
  const trim = opts.trimTrailingZeros ?? true;
  const useGrouping = opts.useGrouping ?? true;

  const negative = value < 0;
  const abs = Math.abs(value);

  // Round to maxDecimals via the parser (avoids binary tie mis-rounding).
  const roundedNum = Number(`${Math.round(Number(`${abs}e${maxDecimals}`))}e-${maxDecimals}`);
  const safe = Number.isFinite(roundedNum) ? roundedNum : abs;

  // Fixed representation, then split integer / fraction on the ASCII dot.
  const fixed = safe.toFixed(maxDecimals);
  const dot = fixed.indexOf(".");
  const intDigits = dot === -1 ? fixed : fixed.slice(0, dot);
  let frac = dot === -1 ? "" : fixed.slice(dot + 1);

  if (trim) frac = frac.replace(/0+$/, "");
  while (frac.length < minDecimals) frac += "0";

  const grouped = useGrouping
    ? intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, sep.group)
    : intDigits;

  const sign = negative && (safe !== 0 || frac.replace(/0/g, "") !== "") ? "-" : "";
  return frac.length > 0 ? `${sign}${grouped}${sep.decimal}${frac}` : `${sign}${grouped}`;
}
