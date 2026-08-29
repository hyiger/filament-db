/**
 * Applier-side helper for the Bambu Studio importer. Sibling to the
 * pure-parser `bambuStudioImport.ts`; lives separately because it has Mongo
 * dependencies (Printer / Nozzle lookups for the calibration context match)
 * and the parser deliberately stays DB-free. Shared by the two import routes:
 * `POST /api/filaments/bambustudio` (upsert by name) and
 * `POST /api/filaments/{id}/bambustudio` (target pinned by id).
 */

import Printer from "@/models/Printer";
import { settingValuesEqual } from "./slicerSettings";
import Nozzle from "@/models/Nozzle";
import {
  mergeSlicerSettings,
  type SettingsMergeResult,
} from "@/lib/slicerSettings";
import { resolveSyncBackColor } from "@/lib/prusaSlicerBundle";
import { stripLegacyMachineCondition } from "@/lib/stripLegacyNozzleCondition";
import { isUpdateNozzleRangeInverted, type NozzleTemperatureRange } from "@/lib/temperatureRange";
import type {
  BambuParseResult,
  CalibrationHints,
  ParsedFilament,
} from "@/lib/bambuStudioImport";

/** Loose shape for the `existing` filament parameter (the full Mongoose doc
 * type has stricter null-vs-undefined on its embedded arrays).
 *
 * The inheritable scalar fields (type, vendor, density, cost, diameter,
 * maxVolumetricSpeed, shrinkageXY, shrinkageZ) are read by
 * `buildStructuredUpdate` to decide whether a variant has a stale local
 * override worth `$unset`-ing. They MUST be populated on whatever the caller
 * passes — stripping them makes the unset path silently unreachable. */
export interface ExistingFilamentForApply {
  type?: string | null;
  vendor?: string | null;
  /** GH #883: read by resolveSyncBackColor to detect the spec-pure coextruded
   *  shape (null primary + populated secondaries) and suppress writing the
   *  exported secondary echo back onto the null primary. */
  color?: string | null;
  secondaryColors?: string[] | null;
  diameter?: number | null;
  density?: number | null;
  cost?: number | null;
  maxVolumetricSpeed?: number | null;
  shrinkageXY?: number | null;
  shrinkageZ?: number | null;
  temperatures?: Record<string, unknown>;
  bedTypeTemps?: Array<{
    bedType: string;
    temperature?: number | null;
    firstLayerTemperature?: number | null;
  }>;
  settings?: Record<string, unknown>;
  calibrations?: unknown[];
  /** GH #1021: nozzle-tick refs for the legacy-condition ingestion guard
   * (stripLegacyMachineCondition). Both routes pass full docs, so this is
   * present whenever the filament has ticks. */
  compatibleNozzles?: unknown;
  /** GH #403: variant detection. When the existing doc is a variant
   * (has a parentId), inheritable scalars whose parsed value already
   * matches what the parent provides should be SKIPPED — writing the
   * field would pin the variant's local value and sever inheritance.
   * `parent` is the resolved parent doc (or null if not a variant). */
  parentId?: string | null;
  parent?: Record<string, unknown> | null;
}

export interface BambuUpdatePayload {
  /** The `$set` body for `Filament.updateOne` / `findOneAndUpdate`, or
   * the doc body passed to `Filament.create`. Already contains structured
   * fields, settings, and the calibrations[] row (when resolved). */
  update: Record<string, unknown>;
  /** Field names that must be `$unset` on the variant doc — the import
   * matched the parent's value, but the variant currently carries a stale
   * local override. Empty for root filaments and create-branch calls. */
  unsetKeys: string[];
  /** Settings-merge outcome — passed back so the caller can include
   * `settingsAdded` in the response and return early on a size-cap error. */
  settingsResult: SettingsMergeResult;
  /** Calibration resolution outcome — included in the response so the
   * UI can show "applied to printer X / nozzle Y" or the unresolved
   * nudge. */
  calibrationOutcome: CalibrationOutcome;
  /** GH #892: true when the resulting EFFECTIVE nozzle range (this update's
   * own range, with endpoints the variant leaves null inherited from its
   * parent) is inverted (min > max). The per-field 0–600 schema validators
   * can't express the cross-field relationship, so both Bambu routes reject
   * with 400 when this is set — matching the OrcaSlicer sync route. */
  nozzleRangeInverted: boolean;
}

/** Structured-projection result: `set` is the `$set` body; `unset` lists
 *  variant fields to clear (see BambuUpdatePayload.unsetKeys). */
export interface StructuredUpdateResult {
  set: Record<string, unknown>;
  unset: string[];
}

/**
 * One-shot builder used by both the bulk and per-id routes to turn a parsed
 * Bambu profile + the existing filament doc into the update payload. The bulk
 * route calls this from each phase of its upsert (active / trashed /
 * race-on-create) since `existing` differs per phase. `existing === null` is
 * the create branch: no merge anchor, no settings carryover, no calibration
 * row dedup.
 */
export async function prepareBambuUpdate(
  parsed: BambuParseResult,
  existing: ExistingFilamentForApply | null,
): Promise<BambuUpdatePayload> {
  const { set: update, unset: unsetKeys } = buildStructuredUpdate(
    parsed.filament,
    existing,
  );

  const settingsResult = mergeSlicerSettings(
    (existing?.settings as Record<string, unknown>) || {},
    parsed.filament.settings,
    // The parser already excludes structured keys we own from
    // `parsed.filament.settings`, so the owned-keys set is empty here.
    new Set<string>(),
  );
  // GH #950: also write when the merge PURGED a never-baggable key from the
  // existing bag (`removed`) — matching the OrcaSlicer route. Otherwise a sync
  // that only updates structured fields never persists the cleaned bag, and a
  // stale filament_settings_id/filamentdb_id keeps shadowing later exports.
  // GH #1021: same ingestion guard as the PrusaSlicer/Orca sync + INI import
  // boundaries — a pre-cleanup Bambu/Orca JSON carries the machine-derived
  // nozzle condition as passthrough, and re-persisting it would resurrect the
  // hidden-preset bug. Strip it (→ "") when the INCOMING profile owns the key
  // and it provenance-matches the target's effective ticks; incoming-only, so
  // a profile that omits the key never re-judges a stored post-cleanup pin.
  // Creates (`existing === null`) have no ticks to test against.
  if (
    existing &&
    parsed.filament.settings &&
    Object.prototype.hasOwnProperty.call(parsed.filament.settings, "compatible_printers_condition")
  ) {
    await stripLegacyMachineCondition(settingsResult.settings, existing);
  }
  if (settingsResult.added.length > 0 || settingsResult.removed.length > 0) {
    update.settings = settingsResult.settings;
  }

  const calibrationOutcome = await resolveAndApplyCalibration(
    parsed.filament,
    parsed.calibrationHints,
    update,
    existing,
  );

  // GH #950: chamber_temperature has NO top-level filament field — its only
  // structured home is calibrations[].chamberTemp, written ONLY when a
  // printer/nozzle context resolves. The parser excludes the chamber keys from
  // the settings passthrough bag (CALIBRATION_KEYS), so an unresolved profile
  // would silently DROP the value; fall back to preserving the raw chamber
  // keys in the bag ("misfiled but survives"). A RESOLVED profile keeps
  // chamber in calibrations[].chamberTemp and out of the filament-global bag.
  //
  // Base on the MERGED settings bag, NOT `update.settings` — which is only
  // assigned when the merge added keys, so it can be undefined here, and
  // starting from {} would make the later `$set` REPLACE the whole bag,
  // dropping existing keys. Skip when the merge errored (the route 400s on it)
  // so we never build on a partial bag.
  if (parsed.calibrationHints.chamberTemp != null && !settingsResult.error) {
    if (!calibrationOutcome.applied) {
      // Unresolved: no structural home → preserve the raw chamber keys in the
      // bag, routed through the CAPPED merge so appending them can't bypass
      // MAX_SETTINGS_KEYS; an over-cap result surfaces as settingsResult.error
      // → the route 400s instead of silently over-filling.
      const chamberMerge = mergeSlicerSettings(
        settingsResult.settings,
        {
          chamber_temperature: String(parsed.calibrationHints.chamberTemp),
          activate_chamber_temp_control: "1",
        },
        new Set(),
      );
      if (chamberMerge.error) settingsResult.error = chamberMerge.error;
      else update.settings = chamberMerge.settings;
    } else if (
      "chamber_temperature" in settingsResult.settings ||
      "activate_chamber_temp_control" in settingsResult.settings
    ) {
      // The chamber value went to calibrations[].chamberTemp (authoritative).
      // Strip any STALE raw chamber keys carried over from a PRIOR unresolved
      // import — otherwise they'd re-export as a filament-global value that
      // double-counts the calibration. The parser already excludes the
      // INCOMING chamber keys, so this only clears a carry-over from `existing`.
      const settings = { ...settingsResult.settings };
      delete settings.chamber_temperature;
      delete settings.activate_chamber_temp_control;
      update.settings = settings;
    }
  }

  // GH #1075: a variant's export flattens its settings bag through
  // resolveFilament's shallow parent-merge, so the exported preset echoes
  // every passthrough key the variant merely INHERITS. Persisting the merged
  // bag verbatim would pin those echoed keys as local overrides and silently
  // sever GH #106 live inheritance (same rule as splitInheritedImportSet's
  // settings branch in importFilaments.ts — keep in sync). Apply it to the
  // FINALIZED bag — after mergeSlicerSettings, the legacy-condition strip, and
  // the chamber fallback, so those keys need no special-casing: drop every key
  // whose value strictly equals the parent's. Because `update.settings` is a
  // whole-object $set, the filtered write also self-heals a STORED
  // parent-equal pin (GH #971 posture). Gated on the bag actually being
  // written — a sync that never touches the bag keeps the no-write behaviour.
  // A missing or malformed parent settings object proves nothing, so the bag
  // writes verbatim.
  const parentSettings =
    existing?.parentId && existing.parent ? existing.parent.settings : null;
  if (
    update.settings &&
    parentSettings &&
    typeof parentSettings === "object" &&
    !Array.isArray(parentSettings)
  ) {
    const bag = update.settings as Record<string, unknown>;
    const parentBag = parentSettings as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bag)) {
      // GH #678: element-wise, or a parent-equal ARRAY value pins as a
      // variant override and parent edits stop propagating.
      if (!settingValuesEqual(parentBag[key], value)) filtered[key] = value;
    }
    update.settings = filtered;
  }

  // GH #892: reject an inverted nozzle range, mirroring the OrcaSlicer sync
  // route. `update.temperatures` is a full replace, so it IS the effective own
  // range; the variant inherits any null endpoint from its resolved parent.
  // The caller maps true → 400. Gate on whether THIS profile actually carried
  // a range endpoint — buildStructuredUpdate copies the stored endpoints into
  // update.temperatures regardless, so without the gate an unrelated sync
  // against legacy data with an already-inverted range would 400 (matches the
  // OrcaSlicer route's `touchesNozzleRange` gate).
  const incoming = parsed.filament.temperatures;
  const rangeTouched =
    incoming?.nozzleRangeMin != null || incoming?.nozzleRangeMax != null;
  const nozzleRangeInverted =
    rangeTouched &&
    isUpdateNozzleRangeInverted(
      update,
      existing?.temperatures as NozzleTemperatureRange | undefined,
      (existing?.parent?.temperatures as NozzleTemperatureRange | undefined) ?? null,
    );

  return { update, unsetKeys, settingsResult, calibrationOutcome, nozzleRangeInverted };
}

/**
 * Project the parsed payload to the subset of model fields we update.
 * `null`/`undefined` keys are intentionally omitted so a partial Bambu
 * profile doesn't blank pre-existing values on an existing filament.
 */
export function buildStructuredUpdate(
  parsed: ParsedFilament,
  existing: ExistingFilamentForApply | null,
): StructuredUpdateResult {
  const u: Record<string, unknown> = {};
  const unset: string[] = [];

  // GH #403: when the existing doc is a variant, only PIN an inheritable
  // scalar when the parsed value DIFFERS from what the parent provides —
  // otherwise leave the variant inheriting dynamically via `resolveFilament`.
  // Exception: if the imported value matches the parent AND the variant
  // currently carries its own diverging value, a no-op would leave that stale
  // override in place forever; emit `$unset` so inheritance resumes.
  // `color` is intentionally NOT inheritable, so it sets unconditionally below.
  const parent = existing?.parent ?? null;
  const isVariantWithParent = !!(existing?.parentId && parent);
  const existingRow = existing as Record<string, unknown> | null;
  const variantHasLocalValue = (key: string): boolean => {
    if (!existingRow) return false;
    const v = existingRow[key];
    return v != null && v !== "";
  };

  // The Filament schema declares `vendor` and `type` required, so routing
  // them into `$unset` with `runValidators: true` (which both Bambu routes
  // pass) would fail validation — leave those variant overrides in place.
  // Optional fields are safe to unset (`resolveFilament` falls back to the
  // parent). Matches the form-side rule: required fields never get cleared.
  const REQUIRED_FIELDS = new Set<string>(["type", "vendor"]);

  const setIfNotInherited = (
    key: string,
    parsedVal: unknown,
  ) => {
    if (parsedVal == null) return;
    if (isVariantWithParent && parent && parent[key] === parsedVal) {
      if (
        !REQUIRED_FIELDS.has(key) &&
        variantHasLocalValue(key) &&
        existingRow?.[key] !== parsedVal
      ) {
        unset.push(key);
      }
      return;
    }
    u[key] = parsedVal;
  };

  setIfNotInherited("type", parsed.type);
  setIfNotInherited("vendor", parsed.vendor);
  // not inheritable. GH #883: for a coextruded filament (null primary +
  // secondaries) the export echoes secondaryColors[0] as the single color, so
  // suppress writing that echo back onto the null primary; undefined = leave it.
  if (parsed.color != null) {
    // GH #913: pass the parent so an inherited-coextruded variant is detected.
    const resolvedColor = resolveSyncBackColor(
      existing,
      parsed.color,
      parent as { secondaryColors?: string[] | null } | null,
    );
    if (resolvedColor !== undefined) u.color = resolvedColor;
  }
  setIfNotInherited("diameter", parsed.diameter);
  setIfNotInherited("density", parsed.density);
  setIfNotInherited("cost", parsed.cost);
  setIfNotInherited("maxVolumetricSpeed", parsed.maxVolumetricSpeed);
  setIfNotInherited("shrinkageXY", parsed.shrinkageXY);
  setIfNotInherited("shrinkageZ", parsed.shrinkageZ);

  // Temperatures: merge with whatever's already on the doc so we don't
  // clobber e.g. nozzleRangeMin when the import only carries `nozzle`.
  //
  // GH #1008 F5 (import-side guard — the export stays unchanged):
  // `hot_plate_temp` double-maps on BOTH sides. The export emits it from
  // `temperatures.bed` and then re-emits it from the "Hot Plate" bedTypeTemps
  // entry (which wins when both exist); the parser inverts it into BOTH
  // `temperatures.bed` AND a "Hot Plate" bedTypeTemps entry. So bed=60 +
  // bedTypeTemps=[{Hot Plate, 65}] exports hot_plate_temp=65 only, and
  // syncing that profile back used to rewrite the generic bed temp 60→65.
  // Guard: when the parsed profile carries a distinct "Hot Plate" entry AND
  // the target already has a bed temp (its own, or — for a variant —
  // inherited, mirroring resolveFilament's own ?? parent), keep the stored
  // value and do NOT merge the parsed hot-plate value into `temperatures.bed`.
  // The plate-specific value still lands in bedTypeTemps["Hot Plate"] below,
  // so nothing is lost. A fresh import (no existing bed temp anywhere) still
  // seeds bed from hot_plate_temp. Same guard for `bedFirstLayer` /
  // hot_plate_temp_initial_layer — the identical double-mapping.
  const t = parsed.temperatures;
  let tempKeys = Object.entries(t).filter(([, v]) => v != null);
  const hotPlate = parsed.bedTypeTemps.find((e) => e.bedType === "Hot Plate");
  if (hotPlate) {
    const ownTemps =
      (existing?.temperatures as Record<string, unknown> | undefined) ?? {};
    const inheritedTemps = isVariantWithParent
      ? ((parent?.temperatures as Record<string, unknown> | undefined) ?? {})
      : {};
    const hasEffectiveBed = (sub: "bed" | "bedFirstLayer") =>
      (ownTemps[sub] ?? inheritedTemps[sub]) != null;
    tempKeys = tempKeys.filter(([key, value]) => {
      const guarded =
        (key === "bed" && hotPlate.temperature != null) ||
        (key === "bedFirstLayer" && hotPlate.firstLayerTemperature != null);
      if (!guarded || !hasEffectiveBed(key as "bed" | "bedFirstLayer")) return true;
      // A PARENT-EQUAL incoming value must still reach the F4 nulling branch
      // below — the hot-plate key is the only Bambu field that can express
      // "set my bed back to the parent's", and filtering it here left a stale
      // divergent variant pin un-healable forever. Only a parent-DIVERGENT
      // hot-plate value is suppressed (the F5 data-loss case this guard exists
      // for). `inheritedTemps` is {} for a standalone filament.
      return value != null && value === inheritedTemps[key];
    });
  }
  if (tempKeys.length > 0) {
    const mergedTemps: Record<string, unknown> = {
      ...((existing?.temperatures as Record<string, unknown>) || {}),
      ...Object.fromEntries(tempKeys),
    };
    // GH #1008 F4 (sibling of GH #403's scalar guard): a variant's export
    // flattens its inherited temps through resolveFilament, so syncing that
    // preset back used to pin the parent's temps on the variant, severing
    // GH #106 live inheritance. Reset each merged subfield whose value EQUALS
    // the parent's to null — the inherit sentinel resolveFilament reads —
    // so inheritance resumes; divergent values stay as genuine overrides.
    // Null-in-the-object rather than a `$unset` because `u.temperatures` must
    // STAY a nested full-replace object: the bulk route's create path spreads
    // this update into `Filament.create`, where dotted keys would be silently
    // dropped by strict mode (and a $unset would conflict with the object
    // $set on the same path). Also self-heals a stale parent-equal pin the
    // profile didn't touch (GH #971 posture).
    if (isVariantWithParent && parent) {
      const parentTemps =
        (parent.temperatures as Record<string, unknown> | undefined) ?? {};
      for (const sub of Object.keys(mergedTemps)) {
        const v = mergedTemps[sub];
        if (v != null && v === parentTemps[sub]) mergedTemps[sub] = null;
      }
    }
    u.temperatures = mergedTemps;
  }

  if (parsed.bedTypeTemps.length > 0) {
    // Bambu's plate keys are authoritative for the materials present in
    // the file; merge into the existing array by bedType name,
    // replacing matching entries and appending new ones. Normalise
    // null → undefined so the spread below doesn't reintroduce nulls
    // the model permits but the parser doesn't.
    type BedEntry = {
      bedType: string;
      temperature?: number;
      firstLayerTemperature?: number;
    };
    const existingBedTypes: BedEntry[] = (existing?.bedTypeTemps || []).map((e) => ({
      bedType: e.bedType,
      temperature: e.temperature ?? undefined,
      firstLayerTemperature: e.firstLayerTemperature ?? undefined,
    }));
    const byName = new Map<string, BedEntry>(existingBedTypes.map((e) => [e.bedType, e]));
    for (const entry of parsed.bedTypeTemps) {
      byName.set(entry.bedType, { ...byName.get(entry.bedType), ...entry });
    }
    const mergedBedTypes = [...byName.values()];
    // GH #1008 F4: bedTypeTemps inherits as a WHOLE array (empty === inherit,
    // GH #106/#477 array-fallback in resolveFilament). A variant's export
    // flattens the parent's plate list, so syncing it back used to materialize
    // a full copy on the variant that shadows every later parent edit. When
    // the merged array deep-equals the parent's effective array, write `[]` —
    // the inherit sentinel — instead of the copy; writing [] (rather than
    // skipping) also self-heals a stale materialized copy that now matches the
    // parent (GH #971 posture). A divergent merged array still writes.
    if (
      isVariantWithParent &&
      parent &&
      bedTypeTempsEqualParent(mergedBedTypes, parent.bedTypeTemps)
    ) {
      u.bedTypeTemps = [];
    } else {
      u.bedTypeTemps = mergedBedTypes;
    }
  }

  return { set: u, unset };
}

/**
 * Order-insensitive deep equality between the merged bedTypeTemps array and
 * the parent's effective array (a parent is never itself a variant, so its own
 * array IS its effective array). null/undefined are collapsed (the model
 * stores null defaults where the parser emits undefined). Conservative on
 * malformed parent data (duplicate bedTypes, non-array): returns false so the
 * merged array writes through.
 */
function bedTypeTempsEqualParent(
  merged: Array<{
    bedType: string;
    temperature?: number | null;
    firstLayerTemperature?: number | null;
  }>,
  parentArr: unknown,
): boolean {
  if (!Array.isArray(parentArr) || parentArr.length !== merged.length) {
    return false;
  }
  const byType = new Map<
    string,
    { temperature?: number | null; firstLayerTemperature?: number | null }
  >();
  for (const raw of parentArr) {
    const e = raw as {
      bedType?: unknown;
      temperature?: number | null;
      firstLayerTemperature?: number | null;
    };
    if (typeof e.bedType !== "string" || byType.has(e.bedType)) return false;
    byType.set(e.bedType, e);
  }
  return merged.every((m) => {
    const p = byType.get(m.bedType);
    return (
      p != null &&
      (m.temperature ?? null) === (p.temperature ?? null) &&
      (m.firstLayerTemperature ?? null) === (p.firstLayerTemperature ?? null)
    );
  });
}

export interface CalibrationOutcome {
  applied: boolean;
  unresolved: boolean;
  context?: {
    printerId: string;
    printerName: string;
    nozzleId: string;
    nozzleDiameter: number;
  };
}

/**
 * Try to match the printer hint in the parsed profile to a Printer doc
 * and one of its installed nozzles. When that succeeds we add/update a
 * `calibrations[]` entry on `update`. When it fails, the
 * maxVolumetricSpeed value still lands as a top-level update (handled
 * in `buildStructuredUpdate`) but per-nozzle-only hints are dropped.
 */
export async function resolveAndApplyCalibration(
  parsed: ParsedFilament,
  hints: CalibrationHints,
  update: Record<string, unknown>,
  existing: { calibrations?: unknown[] } | null,
): Promise<CalibrationOutcome> {
  // Decouple "attempt resolution" from "warn": TRY to resolve a printer/nozzle
  // whenever a chamber temp is present, even though chamber is excluded from
  // `hasAnyHint`. The UNRESOLVED WARNING stays gated on `hasAnyHint` — chamber
  // has a settings-bag fallback (see prepareBambuUpdate), so a chamber-only
  // profile that can't resolve loses nothing and must not surface a misleading
  // "calibration unresolved" toast. Also attempt resolution when the profile
  // DISABLES chamber heating — a resolved context lets us CLEAR a pre-existing
  // calibrations[].chamberTemp so the disable takes (else /calibration
  // re-enables it).
  const wantsResolution =
    hints.hasAnyHint || hints.chamberTemp != null || hints.chamberDisabled === true;
  if (!wantsResolution) {
    return { applied: false, unresolved: false };
  }

  const ctx = await matchPrinterNozzle(hints);
  if (!ctx) {
    // Per-nozzle hints (if any) are dropped → warn. A chamber-only profile has
    // its settings-bag fallback, so its presence alone does NOT warn.
    return { applied: false, unresolved: hints.hasAnyHint };
  }

  const row: Record<string, unknown> = {
    printer: ctx.printerId,
    nozzle: ctx.nozzleId,
  };
  // Chamber: write a new value, or (on an explicit disable) null to clear it. This
  // is the ONE thing a chamber-only sync (enabled or disabled) writes to the row.
  if (hints.chamberTemp != null) row.chamberTemp = hints.chamberTemp; // GH #950
  else if (hints.chamberDisabled === true) row.chamberTemp = null;
  // All NON-chamber calibration values + ordinary temps: copied ONLY when
  // there's a real per-nozzle hint. A chamber-only sync (enable or disable)
  // must NOT pin the profile's top-level-homed temps / max-vol into
  // calibrations[] — those already land via buildStructuredUpdate, and a
  // fabricated per-nozzle override would later shadow user-edited top-level
  // values. Max-vol is excluded from hasAnyHint precisely because it has a
  // top-level home.
  if (hints.hasAnyHint) {
    if (hints.extrusionMultiplier != null) row.extrusionMultiplier = hints.extrusionMultiplier;
    if (hints.maxVolumetricSpeed != null) row.maxVolumetricSpeed = hints.maxVolumetricSpeed;
    if (hints.pressureAdvance != null) row.pressureAdvance = hints.pressureAdvance;
    if (hints.retractLength != null) row.retractLength = hints.retractLength;
    if (hints.retractSpeed != null) row.retractSpeed = hints.retractSpeed;
    if (hints.retractLift != null) row.retractLift = hints.retractLift;
    if (hints.fanMinSpeed != null) row.fanMinSpeed = hints.fanMinSpeed;
    if (hints.fanMaxSpeed != null) row.fanMaxSpeed = hints.fanMaxSpeed;
    if (hints.fanBridgeSpeed != null) row.fanBridgeSpeed = hints.fanBridgeSpeed;
    if (parsed.temperatures.nozzle != null) row.nozzleTemp = parsed.temperatures.nozzle;
    if (parsed.temperatures.nozzleFirstLayer != null) row.nozzleTempFirstLayer = parsed.temperatures.nozzleFirstLayer;
    if (parsed.temperatures.bed != null) row.bedTemp = parsed.temperatures.bed;
    if (parsed.temperatures.bedFirstLayer != null) row.bedTempFirstLayer = parsed.temperatures.bedFirstLayer;
  }

  // Normalize to PLAIN objects before spreading: the routes pass a HYDRATED
  // Mongoose doc, so `existing.calibrations[i]` are subdocuments whose
  // schema-field data lives in `_doc` (prototype getters, NOT own enumerable
  // props) — `{ ...subdoc }` drops that data and silently loses the row's
  // other fields. `.toObject()` materialises the real data; plain objects
  // (unit tests) pass through unchanged.
  const existingRows = ((existing?.calibrations as Array<Record<string, unknown>>) || []).map(
    (c) => {
      const maybe = c as { toObject?: () => Record<string, unknown> };
      return typeof maybe?.toObject === "function" ? maybe.toObject() : c;
    },
  );
  const idx = existingRows.findIndex(
    (c) =>
      String(c.printer) === ctx.printerId && String(c.nozzle) === ctx.nozzleId,
  );
  const merged = [...existingRows];
  if (idx >= 0) {
    merged[idx] = { ...merged[idx], ...row };
  } else {
    // Create a row only when there's real data to store — a per-nozzle hint,
    // or an ENABLED chamber value. A bare chamber CLEAR (chamberTemp === null)
    // with no matching row has nothing to clear; don't fabricate an empty row.
    if (!hints.hasAnyHint && row.chamberTemp == null) {
      return { applied: false, unresolved: false };
    }
    merged.push(row);
  }
  update.calibrations = merged;

  return { applied: true, unresolved: false, context: ctx };
}

/**
 * Parse `printer_settings_id` (or the compatible_printers fallback)
 * into a model name + nozzle diameter, look up a Printer that matches,
 * and pick the unique installed nozzle at that diameter.
 *
 * Bambu printer_settings_id format examples:
 *   "Bambu Lab P1S 0.4 nozzle"
 *   "Bambu Lab X1C 0.6 nozzle"
 *   "Prusa Core One 0.4"
 */
async function matchPrinterNozzle(hints: CalibrationHints): Promise<
  | {
      printerId: string;
      printerName: string;
      nozzleId: string;
      nozzleDiameter: number;
    }
  | null
> {
  const hint = hints.printerSettingsId ?? hints.compatiblePrinters;
  if (!hint) return null;

  // Extract trailing diameter. The "nozzle" suffix is optional because
  // some exports omit it (Prusa-format presets, OrcaSlicer custom names).
  const diameterMatch = hint.match(/(\d+(?:\.\d+)?)\s*(?:nozzle)?\s*$/i);
  if (!diameterMatch) return null;
  const diameter = Number(diameterMatch[1]);
  if (!Number.isFinite(diameter) || diameter <= 0) return null;

  const modelHint = hint
    .slice(0, diameterMatch.index)
    .trim()
    .replace(/[-—]\s*$/, "");
  if (!modelHint) return null;

  // Find printers whose name CONTAINS the model hint (case-insensitive) —
  // users name printers freely, so contains is a pragmatic heuristic. Collect
  // ALL matches and punt to unresolved when >1: silently picking the first
  // would tag the calibration nondeterministically. Same posture as the
  // ambiguous-nozzle branch below.
  const printers = await Printer.find({ _deletedAt: null })
    .populate("installedNozzles")
    .lean();
  const re = new RegExp(escapeRegex(modelHint), "i");
  const matches = printers.filter(
    (p) => re.test(p.name) || re.test(`${p.manufacturer} ${p.printerModel}`),
  );
  if (matches.length !== 1) return null;
  const matched = matches[0];

  // `installedNozzles` is typed as ObjectId[] on the model, but
  // `.populate()` replaces those refs with the full Nozzle docs at
  // runtime. Cast through `unknown` so TS lets us read the populated shape.
  const candidates =
    ((matched.installedNozzles as unknown) as Array<{ _id: unknown; diameter: number }> | undefined) ?? [];
  const sameDiameter = candidates.filter(
    (n) => Math.abs(n.diameter - diameter) < 0.001,
  );
  if (sameDiameter.length === 1) {
    return {
      printerId: String(matched._id),
      printerName: matched.name,
      nozzleId: String(sameDiameter[0]._id),
      nozzleDiameter: diameter,
    };
  }
  if (sameDiameter.length === 0) {
    // Fallback: the matched printer has no nozzle at this diameter installed —
    // adopt a global-catalog nozzle only when EXACTLY one candidate exists
    // (`findOne` was non-deterministic when multiple global nozzles share the
    // diameter); otherwise punt to unresolved.
    const globalCandidates = await Nozzle.find({
      diameter,
      _deletedAt: null,
    }).lean();
    if (globalCandidates.length !== 1) return null;
    return {
      printerId: String(matched._id),
      printerName: matched.name,
      nozzleId: String(globalCandidates[0]._id),
      nozzleDiameter: diameter,
    };
  }
  // >1 candidate — ambiguous (e.g. Brass + ObXidian 0.4 on the same
  // machine). Punt rather than guess; the caller surfaces unresolved.
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
