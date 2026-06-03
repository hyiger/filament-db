/**
 * Cross-field validation for filament temperature ranges.
 *
 * The Add/Edit Filament form and the filament API both silently accepted an
 * inverted nozzle range — e.g. Nozzle Range Min 300 with Max 200 — even
 * though min/max each have their own 0–600 bounds. A min greater than the
 * max is physically nonsense, so reject it (#574).
 */

export interface NozzleTemperatureRange {
  // Accept strings too: a non-form API client can send `"300"` as JSON, and
  // the Filament schema's Number paths would cast it on save — so the guard
  // must coerce before comparing or the inverted range slips through (Codex
  // P2 on PR #577).
  nozzleRangeMin?: number | string | null;
  nozzleRangeMax?: number | string | null;
}

/** Coerce a raw request value to a finite number, or null if it isn't one.
 * Mirrors the cast Mongoose applies to the Number schema paths so the guard
 * validates the value that would actually be persisted. */
function toFiniteNumber(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * True only when BOTH ends of the nozzle range resolve to finite numbers and
 * min > max. A lone min or max, a null/blank end, or a non-numeric value is
 * not "inverted" — partial ranges are legitimate. Numeric strings are coerced
 * first so the common JSON-as-string input shape is still caught.
 */
export function isInvertedNozzleRange(
  t: NozzleTemperatureRange | null | undefined,
): boolean {
  if (!t) return false;
  const min = toFiniteNumber(t.nozzleRangeMin);
  const max = toFiniteNumber(t.nozzleRangeMax);
  return min !== null && max !== null && min > max;
}

/**
 * Compute the nozzle range that a PUT body will actually persist, so a
 * partial update can't sneak an inverted range past the guard (Codex P2 on
 * PR #577).
 *
 * Two update shapes reach `findOneAndUpdate`:
 *   - a full `temperatures` object, which REPLACES the whole subdocument —
 *     so the effective range is exactly what the body carries (a partial
 *     object drops the other endpoint, which can't be inverted); and
 *   - dotted paths (`temperatures.nozzleRangeMin` / `…Max`), which MERGE
 *     into the stored subdocument — so the effective range is the incoming
 *     endpoint combined with the stored other endpoint.
 *
 * Returns null when the body touches neither nozzle-range endpoint (no
 * range change to validate).
 */
export function effectiveNozzleRangeForUpdate(
  body: Record<string, unknown>,
  storedTemps: NozzleTemperatureRange | null | undefined,
): NozzleTemperatureRange | null {
  if (body.temperatures && typeof body.temperatures === "object") {
    return body.temperatures as NozzleTemperatureRange;
  }
  const hasMin = Object.prototype.hasOwnProperty.call(
    body,
    "temperatures.nozzleRangeMin",
  );
  const hasMax = Object.prototype.hasOwnProperty.call(
    body,
    "temperatures.nozzleRangeMax",
  );
  if (!hasMin && !hasMax) return null;
  return {
    nozzleRangeMin: hasMin
      ? (body["temperatures.nozzleRangeMin"] as number | string | null)
      : storedTemps?.nozzleRangeMin,
    nozzleRangeMax: hasMax
      ? (body["temperatures.nozzleRangeMax"] as number | string | null)
      : storedTemps?.nozzleRangeMax,
  };
}
