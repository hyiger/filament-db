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
 * Either shape can also arrive wrapped in a Mongo `$set` operator
 * (`{"$set":{"temperatures.nozzleRangeMin":300}}`), which the route forwards
 * to `findOneAndUpdate` verbatim — so both the top level and `$set` are
 * scanned (Codex P2 on PR #577, round 2).
 *
 * Returns null when the update touches neither nozzle-range endpoint (no
 * range change to validate).
 */
export function effectiveNozzleRangeForUpdate(
  body: Record<string, unknown>,
  storedTemps: NozzleTemperatureRange | null | undefined,
): NozzleTemperatureRange | null {
  // The endpoints can live at the top level or inside `$set`; scan both.
  const sources: Record<string, unknown>[] = [body];
  if (body && typeof body.$set === "object" && body.$set !== null) {
    sources.push(body.$set as Record<string, unknown>);
  }

  // A full `temperatures` object (top-level or under $set) replaces the
  // subdoc, so it fully determines the effective range.
  for (const src of sources) {
    if (src.temperatures && typeof src.temperatures === "object") {
      return src.temperatures as NozzleTemperatureRange;
    }
  }

  // Dotted-path endpoints merge into the stored subdoc; take whichever
  // endpoints the update specifies, falling back to stored for the rest.
  let hasMin = false;
  let hasMax = false;
  let min: number | string | null | undefined;
  let max: number | string | null | undefined;
  for (const src of sources) {
    if (Object.prototype.hasOwnProperty.call(src, "temperatures.nozzleRangeMin")) {
      hasMin = true;
      min = src["temperatures.nozzleRangeMin"] as number | string | null;
    }
    if (Object.prototype.hasOwnProperty.call(src, "temperatures.nozzleRangeMax")) {
      hasMax = true;
      max = src["temperatures.nozzleRangeMax"] as number | string | null;
    }
  }
  if (!hasMin && !hasMax) return null;
  return {
    nozzleRangeMin: hasMin ? min : storedTemps?.nozzleRangeMin,
    nozzleRangeMax: hasMax ? max : storedTemps?.nozzleRangeMax,
  };
}

/**
 * Resolve a variant's effective nozzle range the way resolveFilament does —
 * each endpoint falls back to the parent's when the variant's own is
 * null/undefined (`variant ?? parent`). A variant that sets only one endpoint
 * inherits the other, which can yield an inverted EFFECTIVE range (e.g. own
 * min 300 + inherited parent max 200) the variant renders/exports even though
 * its own body looked like a harmless partial range (Codex P2 r3 on #577).
 *
 * Pass the variant's own (post-update) range as `own` and the parent's range
 * as `parent`; for a standalone (no parent) pass `parent = null` and the own
 * range is returned unchanged.
 */
export function inheritNozzleRangeFromParent(
  own: NozzleTemperatureRange | null,
  parent: NozzleTemperatureRange | null | undefined,
): NozzleTemperatureRange | null {
  if (!own && !parent) return null;
  const o = own ?? {};
  return {
    nozzleRangeMin: o.nozzleRangeMin ?? parent?.nozzleRangeMin ?? null,
    nozzleRangeMax: o.nozzleRangeMax ?? parent?.nozzleRangeMax ?? null,
  };
}
