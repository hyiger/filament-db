import type { DecodedOpenPrintTag } from "./openprinttag-decode";

/**
 * GH #1008 F6: coerce an `aux` value to a finite number. Aux values ride
 * unvalidated client JSON (`Record<string, unknown>`), so they may arrive as
 * strings or junk — only numbers and non-empty numeric strings pass; anything
 * else (booleans, objects, arrays, "", NaN, Infinity) returns null.
 */
function auxTemp(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * GH #1072: coerce a top-level tag string field. Despite the
 * `DecodedOpenPrintTag` typing, `tagData` is unvalidated client JSON — a
 * non-string here made `.trim` throw OUTSIDE the caller's try/catch as a 500
 * where the route contract promises 400. Junk coerces to "" (field absent)
 * so the payload falls back sensibly.
 */
function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Map a tag decoded by `POST /api/nfc/decode` (a `DecodedOpenPrintTag`) into
 * a Filament DB creation payload — the server-side mapper behind
 * create-from-scan. The phone never reproduces this mapping: it POSTs
 * `{ tagData }` and the server builds the document, so the field mapping
 * lives in exactly one place.
 *
 * Mirrors `mapToFilamentPayload` (the OpenPrintTag community-DB importer in
 * `openprinttagBrowser.ts` — keep in sync) so a filament created from a
 * physical tag matches one imported from the OPT database. The decoded `tags`
 * are ALREADY numeric `OPT_TAG` enum values, so there is no string→enum step.
 *
 * Pure + DB-free. Spool subdocs / usage history are never produced here —
 * create makes the filament only.
 *
 * `name` / `vendor` / `type` are `required` on the schema; the create screen
 * prefills them and its `overrides` win over the mapper output. When the tag
 * carries no vendor/type and the caller supplies no override,
 * `Filament.create` rejects with a required-field error — correct, not a
 * silent bad document.
 */
export function decodedTagToFilamentPayload(
  decoded: DecodedOpenPrintTag,
): Record<string, unknown> {
  const brand = strField(decoded.brandName);
  const material = strField(decoded.materialName);
  const type = strField(decoded.materialType);
  // NOTE: the tag's spool_uid is deliberately NOT adopted as the new
  // filament's instanceId. instanceId is system-assigned and the POST handler
  // strips any client-supplied value on purpose — tagData is unsigned client
  // JSON, so adopting spool_uid would make instanceId client-writable (a
  // forgeable scan-match target) and could 409 against the unique index.
  // Re-scans still resolve through the decode route's heuristic path.

  // Best-effort default name from the tag; the create screen lets the user edit
  // it before submit (it's the unique key, so a sensible default matters).
  // Filament DB writes a filament's FULL name (brand included) into the tag's
  // materialName, while community tags carry the bare material — so only prefix
  // the brand when materialName doesn't already lead with it, else a re-scanned
  // FDB tag would yield "Prusament Prusament PLA …".
  const combined =
    brand && material
      ? material.toLowerCase().startsWith(brand.toLowerCase())
        ? material
        : `${brand} ${material}`
      : "";
  const name = combined || material || brand || type || "Scanned filament";

  const secondaryColors = Array.isArray(decoded.secondaryColors) ? decoded.secondaryColors : [];

  // GH #1008 F6: for an OpenTag3D tag with a RANGED print temp,
  // `decoded.nozzleTemp` is the range MAX, while the Core RECOMMENDED
  // print_temp survives only in `aux.opentag3d_recommended_print_temp_c`
  // (stashed exactly when a distinct max exists). Mapping the max into the
  // everyday `temperatures.nozzle` made write→scan→create asymmetric
  // (nozzle=215/rangeMax=230 scanned back as nozzle=230). Prefer the
  // preserved recommended value; the max stays on `nozzleRangeMax`. Same for
  // bed. Only OpenTag3D decodes populate these aux keys, so OpenPrintTag /
  // Bambu payloads are unchanged.
  const recommendedNozzle = auxTemp(decoded.aux?.opentag3d_recommended_print_temp_c);
  const recommendedBed = auxTemp(decoded.aux?.opentag3d_recommended_bed_temp_c);

  return {
    name,
    vendor: brand || null,
    type: type || null,
    // Preserve a null primary for coextruded / multi-color tags (secondaries
    // but no primary) — same posture as mapToFilamentPayload (GH #477). Only
    // fall back to gray when the tag carries no colors at all. typeof-guarded
    // so a non-string color falls to the fallback instead of riding into the
    // schema validator (GH #1072).
    color:
      (typeof decoded.color === "string" && decoded.color) ||
      (secondaryColors.length > 0 ? null : "#808080"),
    // OpenTag3D carries a plain-text color name (color_name); keep it on create
    // so the saved filament retains the tag's color label (the read dialog shows
    // it). OpenPrintTag tags don't populate this, so it's a no-op for them.
    colorName: strField(decoded.colorName) || null,
    secondaryColors,
    density: decoded.density ?? null,
    // Prefer the tag's own diameter — a physical 2.85mm tag is authoritative —
    // and fall back to the 1.75 the OPT importer assumes when the tag omits it.
    diameter: decoded.diameter ?? 1.75,
    temperatures: {
      // GH #1008 F6: everyday temp = the Core recommended value when the tag
      // preserved one (ranged OpenTag3D); otherwise decoded.nozzleTemp (OPT /
      // Bambu / Core-only OpenTag3D, where it IS the recommended value).
      nozzle: recommendedNozzle ?? decoded.nozzleTemp ?? null,
      nozzleFirstLayer: null,
      nozzleRangeMin: decoded.nozzleTempMin ?? null,
      nozzleRangeMax: decoded.nozzleTemp ?? null,
      bed: recommendedBed ?? decoded.bedTemp ?? null,
      bedFirstLayer: null,
      standby: decoded.preheatTemp ?? null,
    },
    dryingTemperature: decoded.dryingTemperature ?? null,
    dryingTime: decoded.dryingTime ?? null,
    shoreHardnessA: decoded.shoreHardnessA ?? null,
    shoreHardnessD: decoded.shoreHardnessD ?? null,
    transmissionDistance: decoded.transmissionDistance ?? null,
    // OpenTag3D's Extended map carries target/max volumetric speed; keep it so a
    // filament created from the scan retains the limit (and slicer exports do
    // too, instead of a null). OpenPrintTag tags don't populate this.
    maxVolumetricSpeed: decoded.maxVolumetricSpeed ?? null,
    // Nominal roll weight + empty-spool tare as filament-level defaults (NOT a
    // spool subdoc — §4.4 never fabricates spools). spoolWeight feeds the
    // remaining-weight math (totalWeight = remainingWeight + spoolWeight) when
    // the user later adds a spool; netFilamentWeight is the nominal full weight.
    netFilamentWeight: decoded.weightGrams ?? null,
    spoolWeight: decoded.emptySpoolWeight ?? null,
    optTags: Array.isArray(decoded.tags) ? decoded.tags : [],
  };
}
