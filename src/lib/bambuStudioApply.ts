/**
 * Applier-side helper for the Bambu Studio importer. Sibling to the
 * pure-parser `bambuStudioImport.ts`; lives separately because it has
 * Mongo dependencies (Printer / Nozzle lookups for the calibration
 * context match) and the parser deliberately stays DB-free so tests can
 * exercise the mapping with no fixtures.
 *
 * Shared by the two import routes:
 *   - `POST /api/filaments/bambustudio` (upsert by name)
 *   - `POST /api/filaments/{id}/bambustudio` (target pinned by id)
 *
 * Both call:
 *   1. `buildStructuredUpdate` — projects the parsed payload to the
 *      subset of model fields we update, merging into existing values
 *      so a partial Bambu profile doesn't blank pre-existing data.
 *   2. `resolveAndApplyCalibration` — tries to match the printer hint
 *      in the profile to a Printer doc + one of its installed nozzles,
 *      and either writes a `calibrations[]` row or signals unresolved.
 */

import Printer from "@/models/Printer";
import Nozzle from "@/models/Nozzle";
import {
  mergeSlicerSettings,
  type SettingsMergeResult,
} from "@/lib/slicerSettings";
import { resolveSyncBackColor } from "@/lib/prusaSlicerBundle";
import type {
  BambuParseResult,
  CalibrationHints,
  ParsedFilament,
} from "@/lib/bambuStudioImport";

/**
 * Project the parsed payload to the subset of model fields we update.
 * `null`/`undefined` keys are intentionally omitted so a partial Bambu
 * profile doesn't blank pre-existing values on an existing filament.
 */
/** Loose shape for the `existing` filament parameter. The full Mongoose
 * doc type has stricter null-vs-undefined on its embedded arrays
 * (`number | null` vs `number | undefined`) — only `bedType` is read
 * here for dedup, so accept anything with that field.
 *
 * Codex P1 on PR #473 round 2: the inheritable scalar fields below
 * (type, vendor, density, cost, diameter, maxVolumetricSpeed,
 * shrinkageXY, shrinkageZ) are read by `buildStructuredUpdate` to
 * decide whether a variant has a stale local override worth
 * `$unset`-ing. They MUST be populated on whatever the caller passes —
 * the previous augment helpers stripped them, so the unset path was
 * unreachable in practice even though the unit tests passed against
 * the unstripped shape. */
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
   * matched the parent's value, but the variant currently carries a
   * stale local override that's diverged from the parent. Empty for
   * root filaments and create-branch calls. (Codex P1 on PR #473.) */
  unsetKeys: string[];
  /** Settings-merge outcome — passed back so the caller can include
   * `settingsAdded` in the response and return early on a size-cap error. */
  settingsResult: SettingsMergeResult;
  /** Calibration resolution outcome — included in the response so the
   * UI can show "applied to printer X / nozzle Y" or the unresolved
   * nudge. */
  calibrationOutcome: CalibrationOutcome;
}

/** Structured-projection result. `set` is the `$set` body; `unset` lists
 *  variant fields that should be cleared (the import matched the
 *  parent's value but the variant had a stale local override that would
 *  otherwise persist). Empty `unset` for root filaments. */
export interface StructuredUpdateResult {
  set: Record<string, unknown>;
  unset: string[];
}

/**
 * One-shot builder used by both the bulk and per-id routes to turn a
 * parsed Bambu profile + the existing filament doc into the update
 * payload. Centralises:
 *   1. structured-field projection (buildStructuredUpdate)
 *   2. settings-bag merge with size caps (mergeSlicerSettings)
 *   3. calibration row dedup + resolve (resolveAndApplyCalibration)
 *
 * The bulk route calls this from each phase of its upsert (active /
 * trashed / race-on-create branch) since `existing` differs per phase.
 * The per-id route calls it once with the pinned target.
 *
 * `existing === null` is the create branch: no merge anchor, no
 * settings carryover, no calibration row dedup against existing rows.
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
    // Already-structured keys we own — pulled into `update` above; the
    // parser already excludes them from `parsed.filament.settings`, so
    // pass an empty owned-keys set here (the merge has no extra keys
    // to strip).
    new Set<string>(),
  );
  if (settingsResult.added.length > 0) {
    update.settings = settingsResult.settings;
  }

  const calibrationOutcome = await resolveAndApplyCalibration(
    parsed.filament,
    parsed.calibrationHints,
    update,
    existing,
  );

  return { update, unsetKeys, settingsResult, calibrationOutcome };
}

export function buildStructuredUpdate(
  parsed: ParsedFilament,
  existing: ExistingFilamentForApply | null,
): StructuredUpdateResult {
  const u: Record<string, unknown> = {};
  const unset: string[] = [];

  // GH #403: when the existing doc is a variant of another filament,
  // only PIN an inheritable scalar to the variant when the parsed
  // value DIFFERS from what the parent already provides. If the parent
  // already carries the same value, leave the variant alone so it
  // continues to inherit dynamically via `resolveFilament` at read
  // time. Same class as the GH #106 / #223 / #265 guards the
  // PrusaSlicer-sync path uses.
  //
  // Codex P1 on PR #473: "leave the variant alone" only works when the
  // variant doesn't ALREADY carry a stale local override. If the
  // imported value matches the parent AND the variant currently has its
  // own diverging value, a no-op leaves the stale value in place forever
  // (it would never be cleared by a subsequent identical-to-parent
  // import either). Emit an `$unset` for that field so the variant
  // returns to inheriting from the parent — which is what the user
  // expects when their slicer profile finally agrees with the parent.
  //
  // `color` is intentionally NOT inheritable (each variant has its
  // own color — that's the whole point of being a variant) so it
  // sets unconditionally below.
  const parent = existing?.parent ?? null;
  const isVariantWithParent = !!(existing?.parentId && parent);
  const existingRow = existing as Record<string, unknown> | null;
  const variantHasLocalValue = (key: string): boolean => {
    if (!existingRow) return false;
    const v = existingRow[key];
    return v != null && v !== "";
  };

  // Codex P2 on PR #473 round 3: the Filament schema declares `vendor`
  // and `type` as required. Routing them into `$unset` with
  // `runValidators: true` (which both Bambu routes pass) would fail
  // schema validation. For required fields, leave the variant override
  // in place — it's still serving its purpose (it's not null), even if
  // it now happens to equal the parent's value. Optional fields
  // (density, cost, diameter, etc.) are safe to unset because the
  // schema accepts missing/null and `resolveFilament` falls back to
  // the parent. This matches the rule the form-side honours too:
  // required fields never get cleared, only re-pointed.
  const REQUIRED_FIELDS = new Set<string>(["type", "vendor"]);

  const setIfNotInherited = (
    key: string,
    parsedVal: unknown,
  ) => {
    if (parsedVal == null) return;
    if (isVariantWithParent && parent && parent[key] === parsedVal) {
      // Parent already carries this exact value. If the variant doc
      // currently has a stale local value for this field AND the field
      // is safe to unset (not required by the schema), emit $unset so
      // inheritance resumes; otherwise leave the variant alone.
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
  const t = parsed.temperatures;
  const tempKeys = Object.entries(t).filter(([, v]) => v != null);
  if (tempKeys.length > 0) {
    u.temperatures = {
      ...((existing?.temperatures as Record<string, unknown>) || {}),
      ...Object.fromEntries(tempKeys),
    };
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
    u.bedTypeTemps = [...byName.values()];
  }

  return { set: u, unset };
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
  if (!hints.hasAnyHint) {
    return { applied: false, unresolved: false };
  }

  const ctx = await matchPrinterNozzle(hints);
  if (!ctx) {
    return { applied: false, unresolved: true };
  }

  const row: Record<string, unknown> = {
    printer: ctx.printerId,
    nozzle: ctx.nozzleId,
  };
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

  const existingRows = (existing?.calibrations as Array<Record<string, unknown>>) || [];
  const idx = existingRows.findIndex(
    (c) =>
      String(c.printer) === ctx.printerId && String(c.nozzle) === ctx.nozzleId,
  );
  const merged = [...existingRows];
  if (idx >= 0) {
    merged[idx] = { ...merged[idx], ...row };
  } else {
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

  // The substring up to the diameter is the printer-name hint.
  const modelHint = hint
    .slice(0, diameterMatch.index)
    .trim()
    .replace(/[-—]\s*$/, "");
  if (!modelHint) return null;

  // Find printers whose name CONTAINS the model hint (case-insensitive).
  // Users name their printers freely ("My Bambu", "Prusa in the garage"),
  // so the contains check on either side is a pragmatic heuristic.
  //
  // Codex P2 on PR #387: collect ALL matches and punt to unresolved when
  // >1 — silently picking the first when "Bambu Lab P1S" matches both
  // "Bambu Lab P1S" and "Bambu Lab P1S (downstairs)" would tag the
  // calibration to whichever Mongo returned first (nondeterministic, and
  // wrong on average). Same posture as the ambiguous-nozzle branch
  // below.
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
    // Fallback: the matched printer doesn't have a nozzle at this
    // diameter installed yet, but maybe a matching one exists in the
    // global catalog. Codex P2 on PR #387 round 4: `findOne` here was
    // non-deterministic when MULTIPLE global nozzles share the
    // diameter (Brass / Hardened / ObXidian variants — common). Use
    // `find` + a length check so we only adopt a global nozzle when
    // exactly one candidate exists; otherwise punt to unresolved, same
    // posture as the in-printer ambiguous branch right below.
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
