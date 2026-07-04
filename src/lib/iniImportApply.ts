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
 * detect a stale variant override to clear. GH #950.8b: `settings` is now projected
 * too so `splitInheritedImportSet`'s per-key merge runs for a variant — it stores
 * only settings keys that DIFFER from the parent (parent-equal keys keep
 * inheriting) instead of pinning the whole resolved bag. `buildIniUpdate` then
 * dot-flattens the resulting `settings` object into `settings.<k>` `$set` keys, so
 * the write MERGES into the stored subdocument — preserving both inheritance and
 * keys the section omitted (e.g. openprinttag_slug/_uuid, the OPT re-sync linkage).
 * `stripStructuredSettings` still removes the top-level shadows first. GH #951 / #950.8b.
 */
const INI_INHERITANCE_PROJECTION =
  "_id parentId vendor type cost density diameter maxVolumetricSpeed inherits " +
  "spoolWeight shrinkageXY shrinkageZ temperatures settings";

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
 * GH #950.8b: convert a whole `settings` object in an update `$set` body into
 * `settings.<key>` DOT-keys, so the write MERGES into the stored settings
 * subdocument instead of REPLACING it. A whole-object `$set: { settings }` dropped
 * every key the incoming section didn't carry — notably settings.openprinttag_slug
 * / _uuid (the #607 OPT re-sync linkage) when importing a foreign/hand-crafted INI
 * by name over an OPT-linked filament. Dot-keys preserve omitted keys, matching the
 * per-id sync route's mergeSlicerSettings semantics (INI import is additive for
 * settings; key DELETION is not expressible via bulk import). Runs AFTER
 * `splitInheritedImportSet` so the variant per-key inheritance diff still operates
 * on the whole object. An empty incoming bag emits no settings key → the stored bag
 * is left untouched (an empty `$set:{settings:{}}` would previously have wiped it).
 */
function mergeSettingsDotKeys(setBody: Record<string, unknown>): Record<string, unknown> {
  const settings = setBody.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return setBody;
  }
  const { settings: _drop, ...rest } = setBody;
  void _drop;
  const out: Record<string, unknown> = { ...rest };
  for (const [k, v] of Object.entries(settings as Record<string, unknown>)) {
    out[`settings.${k}`] = v;
  }
  return out;
}

/**
 * GH #969 (Codex on #950.8b): compute the `settings.<k>` $unset keys that
 * restore variant settings inheritance under the dot-key MERGE.
 *
 * `splitInheritedImportSet` filters a settings key OUT of `set.settings` when
 * the incoming value equals the parent's — meaning "the variant should inherit
 * this key". Under the OLD whole-object `$set: { settings: filtered }` that was
 * self-enforcing: the replace dropped EVERY key not in `filtered`, so any local
 * override of an inherited key vanished for free. #950.8b switched to a dot-key
 * merge (`mergeSettingsDotKeys`) to preserve keys the section OMITS (e.g.
 * `openprinttag_slug` — the #607 OPT linkage), but the merge emits nothing for a
 * filtered-out key, so a stored variant override SURVIVES. That regresses
 * inheritance for section-carried keys: an override like `settings.cooling = "0"`
 * (round 1) — OR one that already equals the parent, e.g. `settings.cooling = "1"`
 * (round 2, this fix) — stays pinned. The parent-EQUAL pin resolves to the right
 * value today but is still a stored local override, so a later parent edit would
 * NOT propagate through `resolveFilament`'s shallow settings merge.
 *
 * So for every incoming settings key whose value matches the parent (i.e. the
 * variant should inherit it) that the variant STILL has as a local override,
 * emit a `settings.<k>` $unset — restoring the pre-#950.8b drop while keeping
 * #950.8b's omitted-key preservation (the loop only touches section keys). A
 * PRESENCE check (`hasOwnProperty`), not a value comparison: settings values are
 * `string | null` and `resolveFilament` merges them shallowly with no
 * empty=inherit rule, so any present key is a genuine override worth clearing.
 * The keys this returns are disjoint from `mergeSettingsDotKeys`'s emitted
 * `settings.<k>` $set keys (matches-parent vs differs-from-parent), so $set and
 * $unset never collide on the same path.
 *
 * Note the intentional divergence from the SCALAR inheritance path
 * (`splitInheritedImportSet`), which clears only a DIVERGENT override and leaves
 * a parent-equal one pinned: scalars were always field-level (never a
 * whole-object replace), so that's their established semantics; settings had
 * whole-object semantics, and this restores them.
 */
function settingsSelfHealUnset(
  incoming: unknown,
  variant: LeanFilament,
  parent: LeanFilament,
): string[] {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return [];
  const parentSettings =
    parent.settings && typeof parent.settings === "object" && !Array.isArray(parent.settings)
      ? (parent.settings as Record<string, unknown>)
      : null;
  const variantSettings =
    variant.settings && typeof variant.settings === "object" && !Array.isArray(variant.settings)
      ? (variant.settings as Record<string, unknown>)
      : null;
  if (!parentSettings || !variantSettings) return [];
  const unset: string[] = [];
  for (const [sk, sv] of Object.entries(incoming as Record<string, unknown>)) {
    // Only keys the section says should INHERIT (incoming matches parent); a
    // divergent value is written through mergeSettingsDotKeys' $set instead.
    if (parentSettings[sk] !== sv) continue;
    // Clear ANY local override of that key — divergent OR parent-equal — so the
    // variant truly inherits and future parent edits propagate.
    if (Object.prototype.hasOwnProperty.call(variantSettings, sk)) {
      unset.push(`settings.${sk}`);
    }
  }
  return unset;
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
  // Root (or a variant with no resolvable parent): merge settings via dot-keys so
  // the write doesn't replace the whole bag (GH #950.8b).
  if (!existing.parentId) return { $set: mergeSettingsDotKeys(flat) };

  const parent = await Filament.findOne({ _id: existing.parentId, _deletedAt: null })
    .select(INI_INHERITANCE_PROJECTION)
    .lean();
  if (!parent) return { $set: mergeSettingsDotKeys(flat) };

  const split = splitInheritedImportSet(flat, existing, parent as LeanFilament);
  // Dot-flatten AFTER the per-key inheritance diff so its settings branch saw the
  // whole object; the resulting keys then MERGE rather than replace (GH #950.8b).
  const out: Record<string, unknown> = { $set: mergeSettingsDotKeys(split.set) };
  // GH #969: the dot-key merge preserves omitted keys but no longer wipes a stale
  // variant settings override that now matches the parent — restore that self-heal
  // with per-key `settings.<k>` $unsets (disjoint from the $set dot-keys above).
  const unsetKeys = [
    ...split.unset,
    ...settingsSelfHealUnset(flat.settings, existing, parent as LeanFilament),
  ];
  if (unsetKeys.length > 0) {
    out.$unset = Object.fromEntries(unsetKeys.map((k) => [k, ""]));
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

  // GH #950: id-first refuse-ambiguous. When the section round-trips a
  // `filamentdb_id` (the filament _id) that resolves to an ACTIVE filament whose
  // stored name DIFFERS from the section name, the case is ambiguous — a renamed
  // preset (id right) vs a copied/stale id pointing at the wrong row,
  // indistinguishable here. Refuse (throw → per-row skip) rather than silently
  // renaming/mutating the wrong filament OR creating an orphan under the section
  // name. Mirrors the per-id sync route's name_id_mismatch conservatism. A
  // matching name — or a stale/absent id — falls through to the name-based
  // upsert below.
  const fid = collapsed.filamentdbId;
  if (fid && /^[a-f0-9]{24}$/i.test(fid)) {
    const byId = await Filament.findOne({ _id: fid, _deletedAt: null })
      .select("_id name")
      .lean();
    if (byId && byId.name !== name) {
      throw new Error(
        `filamentdb_id ${fid} resolves to "${byId.name}", but this section is named ` +
          `"${name}" — not imported (rename the section to match, or resolve the id/name conflict).`,
      );
    }
  }

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
