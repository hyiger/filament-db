/**
 * GH #807 — format a duration given in MINUTES (the app's canonical drying-time
 * unit) as a human "Xh Ym" / "Ym" string:
 *   480 → "8h 0m"   90 → "1h 30m"   45 → "45m"   0 → "0m"
 *
 * The OpenPrintTag browser was rendering the raw minutes value with an `h`
 * suffix (so `drying_time: 480` showed as "480 h"); this matches the minutes
 * interpretation the form, NFC read dialog, and compare page already use.
 *
 * Pure + null-safe. Returns null for null/non-finite input so callers can hide
 * the field entirely.
 */
export function formatMinutesAsHm(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
