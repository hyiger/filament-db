/**
 * Cross-field validation for filament temperature ranges.
 *
 * The Add/Edit Filament form and the filament API both silently accepted an
 * inverted nozzle range — e.g. Nozzle Range Min 300 with Max 200 — even
 * though min/max each have their own 0–600 bounds. A min greater than the
 * max is physically nonsense, so reject it (#574).
 */

export interface NozzleTemperatureRange {
  nozzleRangeMin?: number | null;
  nozzleRangeMax?: number | null;
}

/**
 * True only when BOTH ends of the nozzle range are present finite numbers and
 * min > max. A lone min or max, a null/blank end, or a non-numeric value is
 * not "inverted" — partial ranges are legitimate.
 */
export function isInvertedNozzleRange(
  t: NozzleTemperatureRange | null | undefined,
): boolean {
  if (!t) return false;
  const min = t.nozzleRangeMin;
  const max = t.nozzleRangeMax;
  return (
    typeof min === "number" &&
    Number.isFinite(min) &&
    typeof max === "number" &&
    Number.isFinite(max) &&
    min > max
  );
}
