/**
 * GH #805 — display-only weight formatting.
 *
 * Weights arriving via the API / CSV import / a scale can carry float noise
 * (e.g. `210.40000000000003`) or more precision than is meaningful for a
 * gram readout. UI surfaces should show a clean, rounded number. This rounds
 * to at most `decimals` places (default 2) and trims trailing zeros, so a
 * whole number reads `210` (not `210.00`) and `39.5` (not `39.50`).
 *
 * DISPLAY-ONLY: this never changes stored or API-returned values — those keep
 * full precision for downstream math (slicer spool-check, % remaining, etc.).
 * Pure + null-safe so it's trivial to unit-test and safe to call inline in JSX.
 *
 * Returns the bare number string WITHOUT a unit — call sites keep their own
 * `g` / ` g` suffix, so adoption is a drop-in replacement for `Math.round(x)`.
 */
export function formatGrams(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return "";
  // A naive `Math.round(value * 10**decimals)` mis-rounds exact .005-type ties
  // because the binary product lands JUST below the tie (1.005 * 100 ===
  // 100.4999…, so it would show "1" instead of "1.01"). Shifting the decimal
  // point through the number parser ("1.005e2" → 100.5 exactly) avoids that, and
  // `String(Number(...))` drops trailing zeros (210.00 → "210"). (#805 / Codex P3)
  const rounded = Number(`${Math.round(Number(`${value}e${decimals}`))}e-${decimals}`);
  // Guard the parser path: a value that stringifies to exponential notation
  // (absurd for a gram weight) would yield NaN — fall back to the raw value.
  return Number.isFinite(rounded) ? String(rounded) : String(value);
}
