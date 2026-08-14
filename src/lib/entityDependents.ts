/**
 * GH #1149 — the per-collection "what depends on this row" definition, in ONE
 * place.
 *
 * Two consumers with one predicate set, so they cannot drift:
 *   - the DELETE guards on the entity routes (locations / nozzles / printers /
 *     bed-types), which REFUSE a delete while dependents exist;
 *   - `GET /api/name-conflicts`, which uses the counts to decide whether a
 *     trim-collision row can be offered "Move to trash" (dependent-less
 *     duplicate) or only "Rename" (dependents follow the row untouched).
 *
 * The predicates are extracted VERBATIM from the guards, including their two
 * deliberate asymmetries (both documented on the original sites):
 *   - Filament-side references count TRASHED filaments too (GH #629): a
 *     trashed filament can be restored, which would resurrect a dangling ref.
 *     Only `_purged` tombstones are gone forever.
 *   - Printer-side references keep `_deletedAt: null`: printers have no
 *     trash/restore loop, so a soft-deleted printer's refs can never
 *     resurrect — counting them would block with no way to clear.
 *
 * Filaments have no DELETE guard to extract from (their DELETE is the trash
 * workflow), so their definition is new here: live variants, print-history
 * usage, AMS slot dedications — plus the row's OWN spools, counted by the
 * caller from the document (a row holding inventory should be renamed, not
 * trashed, without an explicit look).
 */

import type { Types } from "mongoose";
import Filament from "@/models/Filament";
import Printer from "@/models/Printer";
import PrintHistory from "@/models/PrintHistory";
import type { TrimmableCollection } from "@/lib/trimEntityNames";

/** Filaments whose spools live in this location (GH #629 trash rule).
 *  Accepts an ObjectId because its guard consumer is an AGGREGATE $match,
 *  which performs NO query casting (the trap documented on that route) —
 *  a string id there would match nothing and silently allow the delete. */
export function locationSpoolRefFilter(
  locationId: string | Types.ObjectId,
): Record<string, unknown> {
  return { _purged: { $ne: true }, "spools.locationId": locationId };
}

/** Filaments referencing this nozzle via ticks or calibrations (GH #629). */
export function nozzleFilamentRefFilter(nozzleId: string): Record<string, unknown> {
  return {
    _purged: { $ne: true },
    $or: [{ compatibleNozzles: nozzleId }, { "calibrations.nozzle": nozzleId }],
  };
}

/** Live printers with this nozzle installed (no-trash-loop rule). */
export function nozzlePrinterRefFilter(nozzleId: string): Record<string, unknown> {
  return { _deletedAt: null, installedNozzles: nozzleId };
}

/** Filaments with a calibration scoped to this printer (GH #629). */
export function printerCalibrationRefFilter(printerId: string): Record<string, unknown> {
  return { _purged: { $ne: true }, "calibrations.printer": printerId };
}

/** Filaments with a calibration scoped to this bed type (GH #629). */
export function bedTypeCalibrationRefFilter(bedTypeId: string): Record<string, unknown> {
  return { _purged: { $ne: true }, "calibrations.bedType": bedTypeId };
}

/** Live printers with this bed type installed (no-trash-loop rule). */
export function bedTypePrinterRefFilter(bedTypeId: string): Record<string, unknown> {
  return { _deletedAt: null, installedBedTypes: bedTypeId };
}

/** Filaments naming this bed SURFACE by free-text name (GH #557 + #629). */
export function bedTypeTempRefFilter(bedTypeName: string): Record<string, unknown> {
  return { _purged: { $ne: true }, "bedTypeTemps.bedType": bedTypeName };
}

export interface DependentCounts {
  total: number;
  /** Per-reference-type counts, keys stable for UI rendering. */
  breakdown: Record<string, number>;
}

/**
 * Count everything that depends on one row, by the SAME predicates the
 * DELETE guards refuse on.
 *
 * `name` is the row's STORED name verbatim (needed only by bedtypes' GH #557
 * free-text surface references — those key on the string, not the id).
 * String ids are fine: Mongoose casts them on ObjectId paths in
 * countDocuments, and the array-membership filters compare strings the same
 * way the guards already do.
 */
export async function countEntityDependents(
  collection: TrimmableCollection,
  id: string,
  name: string,
): Promise<DependentCounts> {
  const breakdown: Record<string, number> = {};
  switch (collection) {
    case "locations": {
      breakdown.filamentsWithSpoolsHere = await Filament.countDocuments(
        locationSpoolRefFilter(id),
      );
      break;
    }
    case "nozzles": {
      breakdown.filaments = await Filament.countDocuments(nozzleFilamentRefFilter(id));
      breakdown.printers = await Printer.countDocuments(nozzlePrinterRefFilter(id));
      break;
    }
    case "printers": {
      breakdown.filamentCalibrations = await Filament.countDocuments(
        printerCalibrationRefFilter(id),
      );
      break;
    }
    case "bedtypes": {
      breakdown.filamentCalibrations = await Filament.countDocuments(
        bedTypeCalibrationRefFilter(id),
      );
      breakdown.printers = await Printer.countDocuments(bedTypePrinterRefFilter(id));
      breakdown.filamentBedTemps = await Filament.countDocuments(
        bedTypeTempRefFilter(name),
      );
      break;
    }
    case "filaments": {
      // No DELETE guard exists to mirror — the filament DELETE is the trash
      // workflow. This definition gates only the conflict surface's
      // "Move to trash" offer, so it errs toward counting.
      breakdown.liveVariants = await Filament.countDocuments({
        parentId: id,
        _deletedAt: null,
      });
      // `spools._id` only (#1005 posture): a bare `spools` projection would
      // stream every photoDataUrl blob and usage ledger just to take a
      // length; the nested projection keeps one stub element per spool.
      const own = await Filament.findById(id).select("spools._id").lean<{
        spools?: unknown[];
      } | null>();
      breakdown.ownSpools = Array.isArray(own?.spools) ? own.spools.length : 0;
      breakdown.printHistoryJobs = await PrintHistory.countDocuments({
        _deletedAt: null,
        "usage.filamentId": id,
      });
      breakdown.amsSlots = await Printer.countDocuments({
        _deletedAt: null,
        "amsSlots.filamentId": id,
      });
      break;
    }
  }
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown };
}
