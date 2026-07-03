/**
 * Applier-side helper for the two PrusaSlicer INI bulk importers:
 *   - `POST /api/filaments/import`      (multipart file upload — UI flow)
 *   - `POST /api/filaments/prusaslicer` (text/plain body — script flow)
 *
 * Both parse the bundle the same way (`collapsePerNozzleImportSections(
 * parseIniFilaments(...))`) and then upsert each collapsed section by NAME.
 * This module owns the write half so the two routes can't drift — and so the
 * GH #951 variant-inheritance fix lands in one place.
 *
 * GH #951: the bundle EXPORT resolves a variant through `resolveFilament`, so
 * each variant's flat `[filament:Name]` section carries the parent's
 * cost/density/temperatures/… as materialised values. The old importers
 * `$set` that whole doc onto the name-matched variant, pinning every inherited
 * field as a local override and severing GH #106 live inheritance on an
 * otherwise-idempotent round-trip. We reuse the CSV importer's battle-tested
 * `splitInheritedImportSet` (GH #628 / #649): for a variant target, drop each
 * inheritable field whose incoming value equals the parent's (keep inheriting)
 * and `$unset` a stale diverging override so inheritance resumes.
 *
 * The three-phase atomic upsert (active → resurrect-trashed → create/race)
 * mirrors `src/app/api/filaments/bambustudio/route.ts`: read the target, then
 * write by `_id` with the soft-delete state re-checked in the filter so a
 * concurrent delete/purge/restore in the read→write window falls through to
 * the next phase instead of silently mis-writing (the same safety the old
 * single-op `findOneAndUpdate({name})` had, kept intact).
 */

import Filament from "@/models/Filament";
import { splitInheritedImportSet } from "@/lib/importFilaments";
import { isDuplicateKeyError } from "@/lib/apiErrorHandler";
import { INI_TOP_LEVEL_SETTING_KEYS } from "@/lib/parseIni";
import type { CollapsedFilamentData } from "@/lib/prusaSlicerBundle";

/**
 * Fields a collapsed INI section can carry that participate in
 * variant→parent inheritance (the top-level fields `parseIniFilaments` lifts:
 * vendor/type/cost/density/diameter/maxVolumetricSpeed/inherits/spoolWeight/
 * shrinkageXY/shrinkageZ + the four temp subfields). Projected on the variant
 * AND its parent so `splitInheritedImportSet` can compare incoming vs parent and
 * detect a stale variant override to clear. `settings` is deliberately NOT
 * projected: after `stripStructuredSettings` removes the top-level shadows the
 * bag holds only genuine passthrough keys, so `splitInheritedImportSet` writes it
 * through unchanged (its settings branch no-ops when the parent's settings are
 * absent). GH #951 (Codex).
 */
const INI_INHERITANCE_PROJECTION =
  "_id parentId vendor type cost density diameter maxVolumetricSpeed inherits " +
  "spoolWeight shrinkageXY shrinkageZ temperatures";

/** Loosely-typed lean filament — same posture as resolveFilament / importFilaments. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LeanFilament = Record<string, any>;

/**
 * Flatten the collapsed section into an update `$set` body: nested
 * `temperatures` → `temperatures.<sub>` DOT-keys. Dot-keys (a) let
 * `splitInheritedImportSet` compare each temp subfield independently against
 * the parent, and (b) merge into the stored subdoc instead of replacing it —
 * so a whole-object `$set` no longer wipes untouched sibling temps
 * (`nozzleRangeMin`/`nozzleRangeMax`/`standby`) the INI bundle never carries.
 * A collapsed per-nozzle section omits `temperatures` entirely (#872), so no
 * temp key is emitted and the base filament's shared temps are left alone.
 */
function toUpdateSet(collapsed: CollapsedFilamentData): Record<string, unknown> {
  const { temperatures, ...rest } = collapsed;
  const flat: Record<string, unknown> = { ...rest };
  if (temperatures) {
    for (const [sub, val] of Object.entries(temperatures)) {
      flat[`temperatures.${sub}`] = val;
    }
  }
  return flat;
}

/**
 * Build the atomic Mongo update body ({ $set } + optional { $unset }) for a
 * name-matched INI import target. For a variant it applies the inheritance
 * split; for a root (or a variant whose parent is missing/trashed — nothing to
 * inherit) it writes the flattened doc verbatim.
 */
async function buildIniUpdate(
  collapsed: CollapsedFilamentData,
  existing: LeanFilament,
): Promise<Record<string, unknown>> {
  const flat = toUpdateSet(collapsed);
  if (!existing.parentId) return { $set: flat };

  const parent = await Filament.findOne({ _id: existing.parentId, _deletedAt: null })
    .select(INI_INHERITANCE_PROJECTION)
    .lean();
  if (!parent) return { $set: flat };

  const split = splitInheritedImportSet(flat, existing, parent as LeanFilament);
  const out: Record<string, unknown> = { $set: split.set };
  if (split.unset.length > 0) {
    out.$unset = Object.fromEntries(split.unset.map((k) => [k, ""]));
  }
  return out;
}

export type IniUpsertOutcome = "created" | "updated";

/**
 * GH #951 (Codex): drop the structured keys that also live in a top-level
 * `FilamentData` field from the raw INI `settings` bag. `parseIniFilaments`
 * dumps every `key=value` line into `settings`, so the bag shadows the
 * top-level fields. On a VARIANT re-import the top-level scalars are correctly
 * left inheriting (null), but the settings-bag shadow would survive verbatim
 * and leak back into exports (`filamentToSlicerKeys` seeds `keys` from the
 * settings bag, then only overwrites when the resolved top-level value is
 * truthy — a null resolved value with a non-null shadow is a no-op). Stripping
 * keeps the settings bag to genuine passthrough keys, matching the per-id sync
 * route (which already excludes STRUCTURED_KEYS). Returns a shallow clone so
 * the caller's parsed object isn't mutated; every stripped key round-trips via
 * its top-level field, so nothing is lost.
 */
function stripStructuredSettings(collapsed: CollapsedFilamentData): CollapsedFilamentData {
  if (!collapsed.settings) return collapsed;
  const settings = { ...collapsed.settings };
  for (const k of INI_TOP_LEVEL_SETTING_KEYS) delete settings[k];
  return { ...collapsed, settings };
}

/**
 * Upsert a single collapsed INI section, preserving variant inheritance
 * (GH #951). Three atomic phases (active → resurrect-trashed → create/race).
 * Returns whether the row was created or updated. Throws on a genuine create
 * failure (validation, non-duplicate driver error); callers wrap per-row for
 * error isolation, exactly as the routes did before.
 *
 * Each phase reads the target by name then writes by `_id` — the `name` is
 * ALSO kept in the write filter so a concurrent rename in the read→write
 * window makes the write miss and fall through (create a fresh row) instead of
 * reverting the rename / pinning this section onto the renamed filament. This
 * restores the old single-op `findOneAndUpdate({ name })` semantics (the Bambu
 * bulk route stays safe differently — it never puts `name` in its `$set`).
 */
export async function upsertIniFilament(
  section: CollapsedFilamentData,
): Promise<IniUpsertOutcome> {
  // Strip the settings-bag shadows of top-level fields up front so every write
  // path (update / resurrect / create / race) and both roots and variants see
  // a clean settings bag — in particular the phase-3 `Filament.create` below
  // spreads `collapsed` directly rather than going through `buildIniUpdate`.
  const collapsed = stripStructuredSettings(section);
  const name = collapsed.name;

  // Phase 1 — update an existing ACTIVE row.
  const existingActive = await Filament.findOne({ name, _deletedAt: null })
    .select(INI_INHERITANCE_PROJECTION)
    .lean();
  if (existingActive) {
    const updated = await Filament.findOneAndUpdate(
      // `name` re-checked so a concurrent rename in the read→write window
      // misses here and falls through (rather than the by-id write reverting
      // the rename via the `name` in `$set`). GH #951 (Codex).
      { _id: existingActive._id, name, _deletedAt: null },
      await buildIniUpdate(collapsed, existingActive),
      { runValidators: true, context: "query", returnDocument: "after" },
    );
    if (updated) return "updated";
    // Soft-deleted or renamed between read and write → fall through to phase 2/3.
  }

  // Phase 2 — resurrect a TRASHED (non-purged) row of the same name rather
  // than creating a duplicate that would strand the trashed record (its
  // restore would 409 forever on the name conflict). GH #297.
  const existingTrashed = await Filament.findOne({
    name,
    _deletedAt: { $ne: null },
    _purged: { $ne: true },
  })
    .select(INI_INHERITANCE_PROJECTION)
    .lean();
  if (existingTrashed) {
    const update = await buildIniUpdate(collapsed, existingTrashed);
    // Splice the tombstone clear into the $set so the resurrect is one atomic
    // write; any $unset for stale variant overrides composes alongside.
    update.$set = {
      ...(update.$set as Record<string, unknown>),
      _deletedAt: null,
    };
    const resurrected = await Filament.findOneAndUpdate(
      // `name` re-checked for the same rename-race reason as phase 1.
      { _id: existingTrashed._id, name, _deletedAt: { $ne: null }, _purged: { $ne: true } },
      update,
      { runValidators: true, context: "query", returnDocument: "after" },
    );
    if (resurrected) return "updated";
    // Purged/restored/renamed between read and write → fall through to phase 3.
  }

  // Phase 3 — create. INI sections never carry a parentId, so a freshly
  // created filament is always a root: no inheritance to preserve here, and
  // the nested `temperatures` object rides straight into the create.
  try {
    await Filament.create({ ...collapsed });
    return "created";
  } catch (createErr) {
    if (!isDuplicateKeyError(createErr)) throw createErr;
    // A concurrent import created this name between our phase-1 read and the
    // create. Recompute the update against THAT row (it may be a variant) and
    // apply it as if we'd taken phase 1, so parallel identical imports stay
    // idempotent instead of throwing.
    const racing = await Filament.findOne({ name, _deletedAt: null })
      .select(INI_INHERITANCE_PROJECTION)
      .lean();
    if (!racing) throw createErr;
    const merged = await Filament.findOneAndUpdate(
      // `name` re-checked for the same rename-race reason as phase 1.
      { _id: racing._id, name, _deletedAt: null },
      await buildIniUpdate(collapsed, racing),
      { runValidators: true, context: "query", returnDocument: "after" },
    );
    if (!merged) throw createErr;
    return "updated";
  }
}
