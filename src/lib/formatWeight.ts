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
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  // `Number(...toFixed())` re-parses to drop trailing zeros: 210.00 → "210",
  // 210.40 → "210.4". toFixed also tames the binary-float rounding artifacts.
  return String(Number(rounded.toFixed(decimals)));
}
