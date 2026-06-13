import type { DecodedOpenPrintTag } from "./openprinttag-decode";

/**
 * Map a tag decoded by `POST /api/nfc/decode` (a `DecodedOpenPrintTag`) into a
 * Filament DB creation payload — the server-side mapper behind create-from-scan
 * (mobile Phase 2, plan §4.4). The phone never reproduces this mapping: it
 * POSTs `{ tagData }` and the server builds the document, so the field mapping
 * lives in exactly one place (design rule #1).
 *
 * Mirrors `mapToFilamentPayload` (the OpenPrintTag community-DB importer in
 * `openprinttagBrowser.ts`) so a filament created from a physical tag matches
 * one imported from the same material in the OPT database — sourcing from the
 * decoded NFC shape instead of `OPTMaterial`, and capturing the couple of extra
 * fields a physical tag carries (shore A hardness, the tag's own diameter).
 * The decoded `tags` are ALREADY numeric `OPT_TAG` enum values (the decoder
 * resolved the bit flags), so unlike the `OPTMaterial` path there is no
 * string→enum step.
 *
 * Pure + DB-free (unit-tested). Spool subdocs / usage history are never
 * produced here (plan §4.4) — create makes the filament only; the user adds a
 * spool afterward via the existing spool routes.
 *
 * `name` / `vendor` / `type` are `required` on the schema. The tag is
 * best-effort; the create screen prefills these and requires non-empty values,
 * which arrive as `overrides` and win over the mapper output. When the tag
 * carries no vendor/type and the caller supplies no override, `Filament.create`
 * rejects with a required-field error — correct, not a silent bad document.
 */
export function decodedTagToFilamentPayload(
  decoded: DecodedOpenPrintTag,
): Record<string, unknown> {
  const brand = decoded.brandName?.trim() || "";
  const material = decoded.materialName?.trim() || "";
  const type = decoded.materialType?.trim() || "";
  // NOTE: the tag's spool_uid is deliberately NOT adopted as the new filament's
  // instanceId. instanceId is system-assigned (auto-generated, partial-unique)
  // and the POST handler strips any client-supplied value on purpose — and
  // tagData is unsigned client JSON, so adopting spool_uid would make instanceId
  // client-writable (a forgeable scan-match target) and could 409 against the
  // unique index. A re-scan of this filament's physical tag instead resolves
  // through the decode route's heuristic (vendor+type / name) path
  // (matchedBy:"heuristic" → the scanner offers "open existing or create"), so
  // re-scans still find it without re-opening the instanceId guard.

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

  return {
    name,
    vendor: brand || null,
    type: type || null,
    // Preserve a null primary for coextruded / multi-color tags (secondaries
    // but no primary) — same posture as mapToFilamentPayload (GH #477). Only
    // fall back to gray when the tag carries no colors at all.
    color: decoded.color || (secondaryColors.length > 0 ? null : "#808080"),
    secondaryColors,
    density: decoded.density ?? null,
    // Prefer the tag's own diameter — a physical 2.85mm tag is authoritative —
    // and fall back to the 1.75 the OPT importer assumes when the tag omits it.
    diameter: decoded.diameter ?? 1.75,
    temperatures: {
      nozzle: decoded.nozzleTemp ?? null,
      nozzleFirstLayer: null,
      nozzleRangeMin: decoded.nozzleTempMin ?? null,
      nozzleRangeMax: decoded.nozzleTemp ?? null,
      bed: decoded.bedTemp ?? null,
      bedFirstLayer: null,
      standby: decoded.preheatTemp ?? null,
    },
    dryingTemperature: decoded.dryingTemperature ?? null,
    dryingTime: decoded.dryingTime ?? null,
    shoreHardnessA: decoded.shoreHardnessA ?? null,
    shoreHardnessD: decoded.shoreHardnessD ?? null,
    transmissionDistance: decoded.transmissionDistance ?? null,
    // Nominal roll weight + empty-spool tare as filament-level defaults (NOT a
    // spool subdoc — §4.4 never fabricates spools). spoolWeight feeds the
    // remaining-weight math (totalWeight = remainingWeight + spoolWeight) when
    // the user later adds a spool; netFilamentWeight is the nominal full weight.
    netFilamentWeight: decoded.weightGrams ?? null,
    spoolWeight: decoded.emptySpoolWeight ?? null,
    optTags: Array.isArray(decoded.tags) ? decoded.tags : [],
  };
}
