import type { Types } from "mongoose";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import {
  LEGACY_NOZZLE_CONDITION_RE,
  isLegacyMachineNozzleCondition,
} from "./legacyNozzleConditions";

/**
 * GH #1021 (Codex P1 r10) — the INGESTION half of the legacy nozzle-condition
 * fix. The one-shot DB cleanup (src/lib/legacyNozzleConditions.ts) runs once,
 * but a PRE-UPGRADE PrusaSlicer-fork preset or exported INI still carries the
 * machine-derived `nozzle_diameter[0]==D [or ...]` condition the old export
 * stamped — and every later sync-back / re-import would re-persist it into
 * the settings bag, resurrecting the hidden-preset bug with the one-shot
 * spent. So the slicer WRITE BOUNDARIES (per-id PrusaSlicer + OrcaSlicer
 * sync, bulk INI import update/resurrect phases) strip an incoming value that
 * provenance-matches this filament's ticks.
 *
 * Same provenance predicate as the migration: strip ONLY when the incoming
 * value byte-equals the legacy derivation from the target's effective
 * compatibleNozzles (own list, else the parent's). A pure nozzle pin that
 * does NOT match the ticks is preserved as user input. The accepted residue
 * also matches the migration's: a user pin byte-identical to the current tick
 * derivation is indistinguishable from the artifact and is stripped; an
 * artifact whose ticks changed since it was stamped no longer matches and
 * persists (visible in the bag, hand-clearable). A fresh CREATE has no ticks
 * to test against, so creates are not guarded (nothing provable there).
 *
 * Mutates `settings` in place (sets the key to "", the round-trip
 * "no restriction" representation). One indexed nozzles query, only on the
 * rare regex hit.
 */
export async function stripLegacyMachineCondition(
  settings: Record<string, unknown> | null | undefined,
  target: { compatibleNozzles?: unknown; parentId?: unknown },
): Promise<void> {
  if (!settings) return;
  const value = settings.compatible_printers_condition;
  if (typeof value !== "string" || !LEGACY_NOZZLE_CONDITION_RE.test(value)) return;

  // Effective ticks: own non-empty list, else the parent's (resolveFilament's
  // rule — what the old exporter derived from).
  let refs: unknown[] | null =
    Array.isArray(target.compatibleNozzles) && target.compatibleNozzles.length > 0
      ? target.compatibleNozzles
      : null;
  if (!refs && target.parentId != null) {
    const parent = await Filament.findOne({ _id: target.parentId, _deletedAt: null })
      .select("compatibleNozzles")
      .lean();
    const parentRefs = (parent as { compatibleNozzles?: unknown } | null)?.compatibleNozzles;
    refs = Array.isArray(parentRefs) && parentRefs.length > 0 ? parentRefs : null;
  }
  if (!refs) return; // no tick provenance → nothing provable, keep the value

  // Entries may be ObjectId refs (unpopulated route docs) or populated nozzle
  // docs — normalize to ids and resolve diameters in one indexed query.
  const ids = refs
    .map((r) =>
      r != null && typeof r === "object" && "_id" in (r as object)
        ? (r as { _id: unknown })._id
        : r,
    )
    .filter((x) => x != null);
  const nozzles = ids.length
    ? await Nozzle.find({ _id: { $in: ids as unknown as Types.ObjectId[] } })
        .select("diameter")
        .lean()
    : [];
  if (isLegacyMachineNozzleCondition(value, nozzles)) {
    settings.compatible_printers_condition = "";
  }
}
