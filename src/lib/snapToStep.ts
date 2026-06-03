/**
 * Snap a number to a numeric `<input step="…">` grid.
 *
 * OpenPrintTag stores `density` and `filament_diameter` as CBOR half-floats
 * (10-bit mantissa → 1/1024 resolution), so a tag programmed with density
 * 1.24 decodes to 1.2392578125 and a 2.85 mm diameter decodes to
 * 2.849609375. Threading those raw values straight into the Add-Filament
 * form's `step="0.01"` inputs trips the browser's native step validation
 * ("the two nearest valid values are 1.23 and 1.24") and blocks save (#570).
 *
 * Rounding the inbound value to the field's own step is the form's job —
 * decode stays lossless (the round-trip/precision decode tests rely on it),
 * the form just snaps the value it shows the user to a value the field can
 * actually hold.
 *
 * Rounds to the nearest multiple of `step`, then trims binary floating-point
 * dust by fixing to the step's own decimal precision (so 285 * 0.01 surfaces
 * as 2.85, not 2.8500000000000005).
 *
 * Non-finite inputs and a non-positive `step` are returned unchanged.
 */
export function snapToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return value;
  }
  const decimals = decimalPlaces(step);
  const snapped = Math.round(value / step) * step;
  return Number(snapped.toFixed(decimals));
}

/** Number of decimal places in a step value (0.01 → 2, 1 → 0, 1e-3 → 3). */
function decimalPlaces(step: number): number {
  if (Number.isInteger(step)) return 0;
  const s = step.toString();
  if (s.includes("e-")) return parseInt(s.split("e-")[1], 10);
  return s.split(".")[1]?.length ?? 0;
}
