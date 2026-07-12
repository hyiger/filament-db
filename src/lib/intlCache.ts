/**
 * GH #1005 F3: module-level Intl formatter cache.
 *
 * `new Intl.DateTimeFormat(...)` / `new Intl.NumberFormat(...)` is expensive
 * (~50–200 µs each). The home list and /inventory render a fresh formatter per
 * cell per render — on a ~2,000-row table that's thousands of constructions on
 * every keystroke. Cache the constructed formatters keyed by (locale | options)
 * so repeated (locale, options) pairs reuse one instance. (The analytics page
 * already memoises its formatter for exactly this reason since v1.60.1; this
 * generalises it to every date/number render site.)
 *
 * A formatter is pure — a (locale, options) pair maps to a deterministic
 * formatter — so a module-level cache is safe to share across React renders AND
 * across SSR requests (no request-specific state). The real key space is small
 * and bounded: a handful of app/device locales × a handful of fixed option
 * shapes (user-chosen custom date patterns bypass Intl via formatWithPattern;
 * custom separators are applied manually). A MAX_ENTRIES cap clears the map if
 * some future caller ever explodes the key space, so it can't grow unbounded.
 *
 * Keys use JSON.stringify(options): Intl option bags are small, flat, and
 * JSON-serializable. A different key ORDER would just miss (a harmless
 * duplicate entry, never a wrong formatter); callers use literal option objects
 * with stable key order. A construction that throws (an unknown locale/option)
 * is NOT cached — it propagates to the caller's existing try/catch fallback.
 */

const MAX_ENTRIES = 500;

const dateTimeCache = new Map<string, Intl.DateTimeFormat>();
const numberCache = new Map<string, Intl.NumberFormat>();

function cacheKey(locale: string | undefined, options: unknown): string {
  return `${locale ?? ""}|${options ? JSON.stringify(options) : ""}`;
}

/** Cached `Intl.DateTimeFormat` for a (locale, options) pair. */
export function getDateTimeFormat(
  locale: string | undefined,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = cacheKey(locale, options);
  let fmt = dateTimeCache.get(key);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat(locale, options);
    if (dateTimeCache.size >= MAX_ENTRIES) dateTimeCache.clear();
    dateTimeCache.set(key, fmt);
  }
  return fmt;
}

/** Cached `Intl.NumberFormat` for a (locale, options) pair. */
export function getNumberFormat(
  locale: string | undefined,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = cacheKey(locale, options);
  let fmt = numberCache.get(key);
  if (fmt === undefined) {
    fmt = new Intl.NumberFormat(locale, options);
    if (numberCache.size >= MAX_ENTRIES) numberCache.clear();
    numberCache.set(key, fmt);
  }
  return fmt;
}
