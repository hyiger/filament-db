/**
 * GH #446 — locale-aware date / time / datetime formatting.
 *
 * Every date display in the app used to call
 * `new Date(x).toLocaleDateString()` (or `toLocaleString()`) with no
 * locale argument, so the output followed the browser locale rather
 * than the app's selected i18n locale. A user on a German app locale
 * with an English browser saw English dates everywhere.
 *
 * These helpers take the i18n locale string the caller already has
 * from `useTranslation()` and pass it through to Intl. They're pure
 * functions (no React) so they can be used inside event handlers,
 * sort comparators, and `useMemo` selectors as well as JSX.
 *
 * All accept either a `Date` or any value `new Date(x)` can parse
 * (ISO 8601 string, epoch ms number, etc.) — they normalise once and
 * silently render an empty string for invalid input rather than
 * throwing "Invalid Date" into the render tree.
 */

type DateInput = Date | string | number | null | undefined;

function normalise(input: DateInput): Date | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Locale-aware short date — `Intl.DateTimeFormat(locale, { dateStyle: "short" })`. */
export function formatDate(input: DateInput, locale: string): string {
  const d = normalise(input);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(d);
  } catch {
    // Fall back to the browser-locale form if the supplied locale is
    // rejected (e.g. a future i18n catalog ships an exotic tag Intl
    // doesn't know about). Better a wrong-locale date than a crash.
    return d.toLocaleDateString();
  }
}

/** Locale-aware short time — `Intl.DateTimeFormat(locale, { timeStyle: "short" })`. */
export function formatTime(input: DateInput, locale: string): string {
  const d = normalise(input);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

/** Locale-aware datetime — short date + short time. */
export function formatDateTime(input: DateInput, locale: string): string {
  const d = normalise(input);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}
