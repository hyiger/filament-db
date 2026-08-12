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
import {
  findSurvivorId,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import { splitInheritedImportSet } from "@/lib/importFilaments";
import { stripTemplateFieldsForWrite } from "@/lib/templateStrip";
import { firstVariantGateInfo } from "@/lib/firstVariantGate";
import { clearOrphanedParentThreshold } from "@/lib/promoteParent";
import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { isDuplicateKeyError } from "@/lib/apiErrorHandler";
import { INI_TOP_LEVEL_SETTING_KEYS } from "@/lib/parseIni";
import { NEVER_BAGGED_KEYS } from "@/lib/slicerSettings";
import { stripLegacyMachineCondition } from "@/lib/stripLegacyNozzleCondition";
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
  // compatibleNozzles: refs only, for the GH #1021 r10 legacy-condition
  // ingestion guard in buildIniUpdate (stripLegacyMachineCondition).
  "spoolWeight shrinkageXY shrinkageZ temperatures settings compatibleNozzles";

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
 * GH #969 (Codex on #950.8b): compute the `settings.<k>` $unset keys that keep a
 * variant tracking its parent for section-carried settings keys under the
 * dot-key MERGE.
 *
 * Why clearing is correct: a bundle export resolves a variant through
 * `resolveFilament`, so a *pinned* key (`variant.settings.cooling = "1"`) and an
 * *inherited* one (variant blank, parent `"1"`) BOTH flatten to the same
 * `cooling = 1` in the exported section. The INI format can't express pin-vs-
 * inherit intent, so on re-import the only safe default for a key the section
 * reports equal to the parent is to drop the local override and let the variant
 * track the parent live (GH #106).
 *
 * Why a dedicated $unset is needed: `splitInheritedImportSet` already filters a
 * parent-equal key OUT of `set.settings` (so `mergeSettingsDotKeys` never writes
 * it). But #950.8b switched the settings write from a whole-object `$set` to a
 * per-key dot-key merge so keys the section OMITS survive (e.g.
 * `openprinttag_slug` — the #607 OPT linkage). The merge only touches keys it
 * emits, so a *stored* variant override of a now-inherited key SURVIVES — whether
 * it diverges (`cooling = "0"`, round 1) or already equals the parent
 * (`cooling = "1"`, round 2, this fix; resolves right today but wouldn't track a
 * later parent edit through resolveFilament's shallow settings merge). So for
 * every incoming settings key the section reports equal to the parent that the
 * variant STILL has locally, emit a `settings.<k>` $unset. A PRESENCE check
 * (`hasOwnProperty`), not a value comparison: settings values are `string | null`
 * and resolveFilament merges them shallowly with NO empty=inherit rule, so any
 * present key is a genuine override worth clearing.
 *
 * Disjointness: the loop only ever touches keys the section carries (so OMITTED
 * keys stay put), and it emits ONLY parent-equal keys while `mergeSettingsDotKeys`
 * emits ONLY differs-from-parent keys — disjoint, so $set and $unset never
 * collide on one path. That invariant holds because BOTH sides key off the same
 * strict parent-equality predicate (`splitInheritedImportSet`'s `!==`); a future
 * change to one must keep the other in lockstep.
 *
 * Sibling paths (GH #971, now fixed): the SCALAR / temperature / secondaryColors
 * branches of `splitInheritedImportSet` now also clear a parent-*equal* pin
 * (presence-based `$unset`), matching this settings self-heal across all three
 * shared call sites (CSV import, per-id sync, INI import). The one remaining
 * asymmetry is that THIS settings self-heal is still wired only into the INI
 * path; the per-id PrusaSlicer sync route doesn't yet clear stored parent-equal
 * settings pins — tracked in GH #972.
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
 * Keys that must never persist in the settings bag on an INI import — the exact
 * set the incoming section is stripped of, so the existing-doc purge mirrors it:
 *   - NEVER_BAGGED_KEYS: routing/id hints (filament_settings_id / filamentdb_id
 *     / filamentdb_nozzle) — stripped from incoming by the collapse step.
 *   - INI_TOP_LEVEL_SETTING_KEYS: settings-bag SHADOWS of top-level fields
 *     (temperature, filament_cost, filament_type, …) — stripped from incoming by
 *     `stripStructuredSettings`.
 */
const STALE_SETTINGS_SHADOW_KEYS = new Set<string>([
  ...NEVER_BAGGED_KEYS,
  ...INI_TOP_LEVEL_SETTING_KEYS,
]);

/**
 * GH #969 (Codex rounds 4 & 5): $unset stale shadow keys still stored on the
 * EXISTING doc's settings. The incoming section is already stripped of both key
 * classes (routing/id hints AND top-level-field shadows), and the dot-key merge
 * (#950.8b) only writes keys it emits — so a LEGACY stored shadow (from older
 * import code) SURVIVES. That's harmful because `filamentToSlicerKeys` seeds the
 * export from the settings bag and only overrides a key when the resolved
 * top-level value is truthy: a stale `settings.filament_settings_id` keeps
 * overriding the re-derived current name, and a stale `settings.temperature`
 * resurfaces once the canonical top-level field goes null/inherited. The
 * pre-#950.8b whole-object replace dropped these for free (the stripped incoming
 * replaced the bag); restore that purge explicitly. OPT keys
 * (openprinttag_slug/_uuid) are NOT in either set, so they're preserved. Disjoint
 * from every $set path (the incoming never carries these keys) and from the
 * self-heal/inheritance $unsets (different keys), so no path collision.
 */
function staleSettingsShadowUnset(existing: LeanFilament): string[] {
  const settings =
    existing.settings && typeof existing.settings === "object" && !Array.isArray(existing.settings)
      ? (existing.settings as Record<string, unknown>)
      : null;
  if (!settings) return [];
  const unset: string[] = [];
  for (const k of STALE_SETTINGS_SHADOW_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, k)) unset.push(`settings.${k}`);
  }
  return unset;
}

/**
 * Build the atomic Mongo update body ({ $set } + optional { $unset }) for a
 * name-matched INI import target. For a variant it applies the inheritance
 * split; for a root (or a variant whose parent is missing/trashed — nothing to
 * inherit) it writes the flattened doc verbatim. Every UPDATE path also purges
 * legacy stale settings shadows (GH #969 r4/r5, staleSettingsShadowUnset).
 */
async function buildIniUpdate(
  collapsed: CollapsedFilamentData,
  existing: LeanFilament,
): Promise<Record<string, unknown>> {
  // GH #1021 (Codex P1 r10): a PRE-upgrade INI still carries the
  // machine-derived nozzle condition the old export stamped; re-persisting it
  // would resurrect the hidden-preset bug after the one-shot DB cleanup.
  // Strip it (→ "") when it provenance-matches the target's effective ticks.
  // All three update paths (active / resurrect / create-race) funnel through
  // here; fresh creates carry no ticks to test against and are unguarded.
  // Codex P2 r15: strip a per-invocation CLONE of the settings bag, never the
  // shared section object — the caller reuses `collapsed` across its fallback
  // phases, and a strip decision based on THIS row's ticks must not leak into
  // a later phase's different target (or the create path).
  const scoped: CollapsedFilamentData = { ...collapsed, settings: { ...collapsed.settings } };
  await stripLegacyMachineCondition(scoped.settings, existing);
  const flat = toUpdateSet(scoped);
  const purge = staleSettingsShadowUnset(existing);
  // Attach the stale-shadow purge (+ any caller unsets) to a `$set`-only body.
  const withUnset = (
    out: Record<string, unknown>,
    extra: string[] = [],
  ): Record<string, unknown> => {
    const keys = [...extra, ...purge];
    if (keys.length > 0) out.$unset = Object.fromEntries(keys.map((k) => [k, ""]));
    return out;
  };

  // Root (or a variant with no resolvable parent): merge settings via dot-keys so
  // the write doesn't replace the whole bag (GH #950.8b).
  if (!existing.parentId) return withUnset({ $set: mergeSettingsDotKeys(flat) });

  const parent = await Filament.findOne({ _id: existing.parentId, _deletedAt: null })
    .select(INI_INHERITANCE_PROJECTION)
    .lean();
  if (!parent) return withUnset({ $set: mergeSettingsDotKeys(flat) });

  const split = splitInheritedImportSet(flat, existing, parent as LeanFilament);
  // Dot-flatten AFTER the per-key inheritance diff so its settings branch saw the
  // whole object; the resulting keys then MERGE rather than replace (GH #950.8b).
  // GH #969: the dot-key merge only writes the keys it emits, so a stored variant
  // settings override the section now reports equal to the parent would stay
  // pinned. Clear those via per-key `settings.<k>` $unsets so the variant keeps
  // tracking the parent (disjoint from the $set dot-keys above — see the
  // settingsSelfHealUnset docblock).
  return withUnset({ $set: mergeSettingsDotKeys(split.set) }, [
    ...split.unset,
    ...settingsSelfHealUnset(flat.settings, existing, parent as LeanFilament),
  ]);
}

export type IniUpsertOutcome = "created" | "updated";

/**
 * GH #605 (codex P2, slicer-sync sweep): optional per-row reporting hooks.
 * `onTemplateFieldsStripped` fires when the name-matched target was a
 * TEMPLATE (≥1 live variant) and the section's per-variant fields (`color`
 * — the INI's `filament_colour` — plus the rest of the shared
 * TEMPLATE_STRIP_FIELDS) were stripped rather than re-materialized on it.
 * The strip never fails the row (the rest of the section still applies);
 * the routes surface the note through their per-row `errors` channel,
 * matching the atlas importer's posture. A callback (not a changed return
 * shape) so existing callers/tests of the "created"/"updated" outcome stay
 * untouched.
 */
export interface IniUpsertOptions {
  onTemplateFieldsStripped?: (fields: string[]) => void;
}

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
  options?: IniUpsertOptions,
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
  /** The row the preset's own `filamentdb_id` selected, when it is a
   *  trim-equal match. Phase 1 must use THIS row rather than re-resolving by
   *  name — see below. */
  let idSelected: { _id: Parameters<typeof Filament.findById>[0]; name?: unknown } | null = null;
  if (fid && /^[a-f0-9]{24}$/i.test(fid)) {
    const byId = await Filament.findOne({ _id: fid, _deletedAt: null })
      .select("_id name")
      .lean();
    // GH #1116 (Codex P1): compare TRIMMED, or this guard fires on the exact
    // survivor the fallback below exists to repair. `parseIni` trims a section
    // name, while an `_id` lookup returns the RAW stored value — so a row the
    // migration could not trim resolves as `"PLA "` against a section named
    // `"PLA"`, and the ordinary exported-INI round trip threw here before ever
    // reaching phase 1. Differing only by edge whitespace is not the ambiguity
    // this guard is about (a renamed preset vs a copied id): it is one
    // identity, recorded in two spellings, and the update normalizes it.
    if (byId && String(byId.name ?? "").trim() !== name.trim()) {
      throw new Error(
        `filamentdb_id ${fid} resolves to "${byId.name}", but this section is named ` +
          `"${name}" — not imported (rename the section to match, or resolve the id/name conflict).`,
      );
    }
    idSelected = byId ?? null;
  }

  // GH #1116 (Codex P1): once the id has SELECTED a row, keep it.
  //
  // Accepting a trim-equal pair above and then re-resolving by name below
  // sends the update to the wrong row: with an active `"PLA"` and a survivor
  // `"PLA "`, an exported INI carrying the SURVIVOR's `filamentdb_id` passes
  // the guard, and the canonical-first query in phase 1 then selects `"PLA"` —
  // so the survivor's settings are written onto the canonical bystander. The
  // id is the more specific address; it wins.
  const idSelectedIsSurvivor =
    idSelected !== null && String(idSelected.name ?? "") !== name;

  // Phase 1 — update an existing ACTIVE row.
  let existingActive = idSelected
    ? await Filament.findOne({ _id: idSelected._id, _deletedAt: null })
        .select(INI_INHERITANCE_PROJECTION)
        .lean()
    : // name-lookup-ok: the survivor fallback below covers the cast case
      await Filament.findOne({ name, _deletedAt: null })
        .select(INI_INHERITANCE_PROJECTION)
        .lean();
  let activeIsSurvivor = idSelectedIsSurvivor && existingActive != null;
  if (!existingActive) {
    // GH #1116 (Codex P1): the miss may be a LOOKUP failure rather than an
    // absence — the setter casts this query, so it cannot select a row whose
    // stored name is still raw. Re-read through the SAME projection so the
    // shape the caller depends on is unchanged.
    const survivorId = await findSurvivorId(
      Filament.collection as unknown as MinimalNameCollection,
      name,
      { _deletedAt: null },
    );
    if (survivorId) {
      existingActive = await Filament.findOne({ _id: survivorId, _deletedAt: null })
        .select(INI_INHERITANCE_PROJECTION)
        .lean();
      activeIsSurvivor = existingActive != null;
    }
  }
  if (existingActive) {
    const update = await buildIniUpdate(collapsed, existingActive);
    // GH #605 (codex P2, slicer-sync sweep): the name-matched target may be a
    // TEMPLATE (≥1 live variant) — strip the per-variant fields the section
    // echoes (`color` from filament_colour; the shared TEMPLATE_STRIP_FIELDS)
    // instead of re-materializing them, with the SAME semantics as the PUT
    // (non-null only; a null passes — though INI can't express one for color:
    // parseIni folds `filament_colour = nil` into its gray default).
    // Decision + write share the per-id mutex the promotion paths lock (PUT
    // review P1-c). The strip never fails the row; it's reported through the
    // caller's hook only when the write actually landed (a rename race that
    // misses the filter falls through to CREATE, where nothing was stripped
    // from — phase 3 uses `collapsed`, not this $set body).
    const { doc, stripped } = await runExclusive(
      filamentLockKey(existingActive._id),
      async () => {
        const stripped = await stripTemplateFieldsForWrite(
          Filament,
          existingActive._id,
          update.$set as Record<string, unknown>,
        );
        const doc = await Filament.findOneAndUpdate(
          // `name` re-checked so a concurrent rename in the read→write window
          // misses here and falls through (rather than the by-id write reverting
          // the rename via the `name` in `$set`). GH #951 (Codex).
          // GH #1116: the `name` clause CANNOT be used against a survivor —
          // it is Mongoose-cast, so it asks for the trimmed form and can never
          // match the raw stored value. Left in, the by-`_id` write would miss
          // and fall straight through to the phase-3 create, making the
          // survivor lookup above completely inert. `_id` + `_deletedAt` still
          // pin the row we resolved and its liveness; only the #951
          // concurrent-rename check is given up, and only for a row that is
          // already in the degraded state the migration reports.
          activeIsSurvivor
            ? { _id: existingActive._id, _deletedAt: null }
            : { _id: existingActive._id, name, _deletedAt: null },
          update,
          { runValidators: true, context: "query", returnDocument: "after" },
        );
        return { doc, stripped };
      },
    );
    if (doc) {
      if (stripped.length > 0) options?.onTemplateFieldsStripped?.(stripped);
      return "updated";
    }
    // Soft-deleted or renamed between read and write → fall through to phase 2/3.
  }

  // Phase 2 — resurrect a TRASHED (non-purged) row of the same name rather
  // than creating a duplicate that would strand the trashed record (its
  // restore would 409 forever on the name conflict). GH #297.
  let existingTrashed = await Filament.findOne({
    name,
    _deletedAt: { $ne: null },
    _purged: { $ne: true },
  })
    .select(INI_INHERITANCE_PROJECTION)
    .lean();
  let trashedIsSurvivor = false;
  if (!existingTrashed) {
    const survivorId = await findSurvivorId(
      Filament.collection as unknown as MinimalNameCollection,
      name,
      { _deletedAt: { $ne: null }, _purged: { $ne: true } },
    );
    if (survivorId) {
      existingTrashed = await Filament.findOne({
        _id: survivorId,
        _deletedAt: { $ne: null },
        _purged: { $ne: true },
      })
        .select(INI_INHERITANCE_PROJECTION)
        .lean();
      trashedIsSurvivor = existingTrashed != null;
    }
  }
  if (existingTrashed) {
    const update = await buildIniUpdate(collapsed, existingTrashed);
    // GH #605: no template strip on the resurrect — a TRASHED doc cannot have
    // live variants (soft-deleting a parent with variants is refused, in-lock
    // with the trash write since round 8 F3 — the same per-filament mutex the
    // first-variant gates lock, so the check can't be raced by a mid-flight
    // first variant; restoring a variant under a trashed parent is refused;
    // variant creation requires an ACTIVE parent), so the revived row is never
    // a TEMPLATE at this write. But that only covers one direction — the
    // revived row may itself be a VARIANT (GH #1073): with it trashed,
    // `hasVariants` reads false, so its parent may legitimately have
    // re-acquired spools/inventory as a standalone. Reviving the row would
    // surface the FIRST live variant of an inventory-carrying parent — the
    // stranded-inventory state #605 forbids — so the resurrect runs through
    // the same adoption gate the CSV importer uses (firstVariantGateInfo),
    // inside the parent's mutex; a gated section FAILS this row (throw → the
    // routes' per-row errors[] channel) instead of resurrecting.
    //
    // Splice the tombstone clear into the $set so the resurrect is one atomic
    // write; any $unset for stale variant overrides composes alongside.
    update.$set = {
      ...(update.$set as Record<string, unknown>),
      _deletedAt: null,
    };
    const doResurrect = () =>
      Filament.findOneAndUpdate(
        // `name` re-checked for the same rename-race reason as phase 1.
        trashedIsSurvivor
          ? { _id: existingTrashed._id, _deletedAt: { $ne: null }, _purged: { $ne: true } }
          : { _id: existingTrashed._id, name, _deletedAt: { $ne: null }, _purged: { $ne: true } },
        update,
        { runValidators: true, context: "query", returnDocument: "after" },
      );
    let resurrected;
    if (existingTrashed.parentId) {
      const parentKey = String(existingTrashed.parentId);
      resurrected = await runExclusive(filamentLockKey(parentKey), async () => {
        const gate = await firstVariantGateInfo(Filament, existingTrashed.parentId);
        if (gate.reason) throw new Error(gate.reason);
        const doc = await doResurrect();
        // Round 7 P2 parity with the CSV importer: an ungated first variant
        // of a threshold-ONLY parent just surfaced — the parent's
        // lowStockThreshold is now dead config; clear it AFTER the write
        // (parent state change last), still inside the per-parent lock.
        // Re-checking hasVariants (rather than trusting the pre-write
        // snapshot) covers a resurrect that missed its filter (purged /
        // renamed mid-window) — no variant surfaced, the threshold stays.
        if (gate.orphanedThreshold && (await hasVariants(Filament, parentKey))) {
          await clearOrphanedParentThreshold(Filament, existingTrashed.parentId);
        }
        return doc;
      });
    } else {
      resurrected = await doResurrect();
    }
    if (resurrected) return "updated";
    // Purged/restored/renamed between read and write → fall through to phase 3.
  }

  // Phase 3 — create. INI sections never carry a parentId, so a freshly
  // created filament is always a root: no inheritance to preserve here, and
  // the nested `temperatures` object rides straight into the create.
  try {
    // name-lookup-ok: post-E11000 recovery: the index proved an exact stored-string match
    await Filament.create({ ...collapsed });
    return "created";
  } catch (createErr) {
    if (!isDuplicateKeyError(createErr)) throw createErr;
    // A concurrent import created this name between our phase-1 read and the
    // create. Recompute the update against THAT row (it may be a variant) and
    // apply it as if we'd taken phase 1, so parallel identical imports stay
    // idempotent instead of throwing.
    // name-lookup-ok: post-E11000 recovery; the index proved an exact stored-string match
    const racing = await Filament.findOne({ name, _deletedAt: null })
      .select(INI_INHERITANCE_PROJECTION)
      .lean();
    if (!racing) throw createErr;
    // GH #605: the racing row is an ACTIVE existing doc — same template strip
    // as phase 1 (a concurrent import may have landed a parent that already
    // has variants).
    const raceUpdate = await buildIniUpdate(collapsed, racing);
    const { doc: merged, stripped } = await runExclusive(
      filamentLockKey(racing._id),
      async () => {
        const stripped = await stripTemplateFieldsForWrite(
          Filament,
          racing._id,
          raceUpdate.$set as Record<string, unknown>,
        );
        const doc = await Filament.findOneAndUpdate(
          // `name` re-checked for the same rename-race reason as phase 1.
          { _id: racing._id, name, _deletedAt: null },
          raceUpdate,
          { runValidators: true, context: "query", returnDocument: "after" },
        );
        return { doc, stripped };
      },
    );
    if (!merged) throw createErr;
    if (stripped.length > 0) options?.onTemplateFieldsStripped?.(stripped);
    return "updated";
  }
}
