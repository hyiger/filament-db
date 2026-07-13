/**
 * Generate OrcaSlicer-compatible JSON profiles from Filament DB filaments.
 *
 * OrcaSlicer uses JSON filament profiles where all values are single-element
 * arrays (for multi-extruder support). This module bridges Filament DB's
 * structured schema to OrcaSlicer's JSON format by:
 *
 * 1. Mapping core DB fields to OrcaSlicer key names (which differ from PrusaSlicer)
 * 2. Wrapping all values in arrays per OrcaSlicer convention
 * 3. Mapping bed-type-specific temperatures to OrcaSlicer plate keys
 *    (cool_plate_temp, hot_plate_temp, eng_plate_temp, textured_plate_temp, etc.)
 * 4. Merging with the `settings` catch-all for OrcaSlicer-specific keys not in the schema
 *
 * Calibration overrides (flow ratio, pressure advance, retraction) are applied
 * dynamically by OrcaSlicer via `GET /api/filaments/:id/calibration?format=orcaslicer`
 * when the printer/nozzle/plate context changes — they are NOT baked into the profiles.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

/**
 * The single hex string a slicer preset should carry for a multi-color
 * filament. When neither a primary nor a secondary exists this returns
 * `null` so the `set()` helper skips the key entirely and OrcaSlicer
 * falls back to its own default — rather than emitting a forced
 * `#808080` gray the user never picked (Codex P2 on PR #485).
 */
function slicerExportColor(filament: FilamentDoc): string | null {
  if (filament.color != null && filament.color !== "") return filament.color;
  if (Array.isArray(filament.secondaryColors) && filament.secondaryColors.length > 0) {
    const first = filament.secondaryColors[0];
    if (first != null && first !== "") return first;
  }
  return null;
}

/**
 * OrcaSlicer bed-type name → config key prefix mapping.
 *
 * OrcaSlicer uses separate config keys per plate type rather than a single
 * bed_temperature key. The bedTypeTemps array in Filament DB maps to these.
 */
const BED_TYPE_KEY_MAP: Record<string, { temp: string; initial: string }> = {
  "Cool Plate":         { temp: "cool_plate_temp",          initial: "cool_plate_temp_initial_layer" },
  "Engineering Plate":  { temp: "eng_plate_temp",           initial: "eng_plate_temp_initial_layer" },
  "Hot Plate":          { temp: "hot_plate_temp",           initial: "hot_plate_temp_initial_layer" },
  "Textured PEI Plate": { temp: "textured_plate_temp",      initial: "textured_plate_temp_initial_layer" },
  "Textured Cool Plate":{ temp: "textured_cool_plate_temp", initial: "textured_cool_plate_temp_initial_layer" },
};

/**
 * Map a resolved Filament DB document to OrcaSlicer JSON key-value pairs.
 * All values are wrapped in single-element arrays per OrcaSlicer convention.
 * Structured DB fields take precedence over the settings bag.
 *
 * GH #950.4: when a representative `calibration` is supplied, its tuned values
 * (flow ratio, pressure advance, retraction, fan speeds, per-calibration temps)
 * are BAKED on top of the base keys via calibrationToOrcaSlicerKeys. Unlike the
 * PrusaSlicer fork (which applies calibration dynamically via GET .../calibration),
 * stock Bambu Studio has no such module, so without baking those values never
 * reach an exported preset and prints revert to defaults. Pressure advance IS
 * baked here (calibrationToOrcaSlicerKeys emits it) — the opposite of PrusaSlicer's
 * deliberate omission — precisely because there is no dynamic fallback for Bambu.
 */
export function filamentToOrcaSlicerKeys(
  filament: FilamentDoc,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calibration?: Record<string, any> | null,
): Record<string, string[]> {
  const keys: Record<string, string[]> = {};

  // Pull in settings bag first (passthrough for OrcaSlicer-specific keys).
  // Settings bag values may be plain strings or already arrays.
  const settings = filament.settings || {};
  for (const [key, value] of Object.entries(settings)) {
    if (value == null) continue;
    keys[key] = Array.isArray(value) ? value.map(String) : [String(value)];
  }

  // Helper: set a key only if value is non-null. Structured fields override settings bag.
  const set = (key: string, value: unknown) => {
    if (value != null && value !== "") {
      keys[key] = [String(value)];
    }
  };

  // Core identification
  set("filament_type", filament.type);
  set("filament_vendor", filament.vendor);
  // Slicer presets are single-color — coextruded / multi-color filaments
  // surface their primary, falling back to the first secondary when the
  // primary is null (the spec-aligned "coextruded" shape). When NEITHER
  // a primary nor a secondary exists `slicerExportColor` returns null so
  // `set` is a no-op and OrcaSlicer uses its own default — we never
  // invent a gray the user did not pick. Secondary colors beyond the
  // primary are intentionally dropped; the detail page's slicer-export
  // menu warns the user about this trade-off.
  set("filament_colour", slicerExportColor(filament));
  set("filament_diameter", filament.diameter);
  set("filament_density", filament.density);
  set("filament_cost", filament.cost);
  set("filament_max_volumetric_speed", filament.maxVolumetricSpeed);

  // Temperatures — OrcaSlicer uses different key names than PrusaSlicer
  const temps = filament.temperatures || {};
  set("nozzle_temperature", temps.nozzle);
  set("nozzle_temperature_initial_layer", temps.nozzleFirstLayer);
  set("nozzle_temperature_range_low", temps.nozzleRangeMin);
  set("nozzle_temperature_range_high", temps.nozzleRangeMax);

  // Default bed temp → hot_plate_temp (OrcaSlicer's default plate type)
  set("hot_plate_temp", temps.bed);
  set("hot_plate_temp_initial_layer", temps.bedFirstLayer);

  // Bed-type-specific temperatures
  const bedTypeTemps = filament.bedTypeTemps || [];
  for (const entry of bedTypeTemps) {
    const mapping = BED_TYPE_KEY_MAP[entry.bedType];
    if (mapping) {
      set(mapping.temp, entry.temperature);
      set(mapping.initial, entry.firstLayerTemperature);
    }
  }

  // Filament settings ID
  if (!keys.filament_settings_id) {
    set("filament_settings_id", filament.name);
  }

  // Notes
  if (!keys.filament_notes && filament.notes) {
    set("filament_notes", filament.notes);
  }

  // GH #950: filament_soluble lives only in the settings bag (no schema field);
  // the settings passthrough above already carries it. The old
  // `set(..., filament.soluble)` read an always-undefined field — removed.

  // Shrinkage. GH #1008 F1: Orca/Bambu's `filament_shrink` is a 100-based
  // "remaining size" (94% = the part measures 94 mm per 100 mm; default 100% =
  // no shrink), whereas the DB stores 0-based shrinkage (0% = none) — the same
  // convention as PrusaSlicer's `filament_shrinkage_compensation_xy`. Convert at
  // the boundary: emit `100 - shrinkageXY`. A 0 emits Orca's EXPLICIT no-shrink
  // value `100%` (Codex P2 on #1016): the Bambu importer only sets shrinkageXY
  // when the key is present, and buildStructuredUpdate skips undefined — so an
  // absent key on a no-shrink export would leave a stale non-zero value in
  // place when re-imported over an existing filament, making zero shrinkage
  // un-round-trippable on updates. Only null (never set) omits the key.
  // `shrinkageZ` rides the PrusaSlicer-named 0-based key, so it stays raw.
  if (filament.shrinkageXY != null) {
    set("filament_shrink", String(100 - filament.shrinkageXY) + "%");
  }
  if (filament.shrinkageZ != null) set("filament_shrinkage_compensation_z", filament.shrinkageZ);

  // GH #950.4: bake the representative calibration on top (flow/PA/retraction/fans/
  // per-calibration temps). Calibration values WIN over the structured/settings
  // defaults above — they're the tuned per-nozzle numbers the user dialed in.
  if (calibration) {
    for (const [k, v] of Object.entries(calibrationToOrcaSlicerKeys(calibration))) {
      keys[k] = v;
    }
  }

  return keys;
}

/**
 * Map calibration data to OrcaSlicer JSON key-value pairs (array format).
 */
export function calibrationToOrcaSlicerKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calibration: Record<string, any>,
): Record<string, string[]> {
  const keys: Record<string, string[]> = {};

  const set = (key: string, value: unknown) => {
    if (value != null) {
      keys[key] = [String(value)];
    }
  };

  set("filament_flow_ratio", calibration.extrusionMultiplier);
  set("pressure_advance", calibration.pressureAdvance);
  set("filament_max_volumetric_speed", calibration.maxVolumetricSpeed);
  set("filament_retraction_length", calibration.retractLength);
  set("filament_retraction_speed", calibration.retractSpeed);
  set("filament_z_hop", calibration.retractLift);
  set("nozzle_temperature", calibration.nozzleTemp);
  set("nozzle_temperature_initial_layer", calibration.nozzleTempFirstLayer);
  set("hot_plate_temp", calibration.bedTemp);
  set("hot_plate_temp_initial_layer", calibration.bedTempFirstLayer);
  set("activate_chamber_temp_control", calibration.chamberTemp != null ? "1" : undefined);
  if (calibration.chamberTemp != null) {
    // OrcaSlicer doesn't have a direct chamber temp key in filament config;
    // pass through as a settings key
    keys["chamber_temperature"] = [String(calibration.chamberTemp)];
  }
  set("overhang_fan_speed", calibration.fanMinSpeed);
  set("additional_cooling_fan_speed", calibration.fanMaxSpeed);
  // GH #508: bridge_fan_speed flows IN via bambuStudioImport
  // (CALIBRATION_KEYS includes it; calibrationHints.fanBridgeSpeed
  // persists onto Filament.calibrations[].fanBridgeSpeed) but the
  // export side was missing it — every export → user-edits-in-Bambu →
  // re-import → re-export cycle silently dropped the bridge fan speed.
  // Pinned in the bambuStudioImport round-trip test.
  set("bridge_fan_speed", calibration.fanBridgeSpeed);

  return keys;
}

/**
 * GH #950.4: pick the ONE calibration to bake into a filament's single exported
 * preset — the any-printer / any-bed "default" entry (printer == null && bedType
 * == null) preferred, else the first calibration. Orca/Bambu presets are a single
 * .json, so a filament with more than one calibration collapses to this
 * representative (the detail page shows a notice whenever any calibration is
 * dropped — see droppedCalibrationCount).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickRepresentativeCalibration(filament: FilamentDoc): Record<string, any> | null {
  const cals = Array.isArray(filament.calibrations) ? filament.calibrations : [];
  if (cals.length === 0) return null;
  return cals.find((c) => c && c.printer == null && c.bedType == null) ?? cals[0];
}

/**
 * GH #950.4 / #969 (Codex round 3): how many calibrations the single Orca/Bambu
 * .json export will DROP. `pickRepresentativeCalibration` bakes exactly one, so
 * every other calibration is lost — regardless of whether it's on a different
 * nozzle OR the SAME nozzle with a different bed type / printer. The detail page
 * warns when this is > 0. (The original counted DISTINCT nozzles, which silently
 * collapsed same-nozzle tuning contexts and under-warned — the bug this fixes.)
 */
export function droppedCalibrationCount(filament: FilamentDoc): number {
  const cals = Array.isArray(filament.calibrations) ? filament.calibrations : [];
  return Math.max(0, cals.length - 1);
}

/**
 * Generate an array of OrcaSlicer-format filament profile objects
 * from resolved Filament DB documents.
 */
/**
 * GH #950.4 / #969 (Codex round 5): `bakeCalibration` is OPT-IN and defaults to
 * false. Baking is only correct for the SINGLE-preset download paths
 * (`GET /api/filaments/{id}/{orcaslicer,bambustudio}`), which are manual imports
 * with no dynamic calibration module. The BULK bundle (`GET /api/filaments/orcaslicer`)
 * feeds the OrcaSlicer FilamentDB module, which fetches `/calibration?format=orcaslicer`
 * for the ACTIVE nozzle/bed at print time — baking the any-printer/any-bed
 * representative there would seed every profile with wrong-context tuning until
 * (or unless) the dynamic fetch overwrites it. So the bulk route leaves this off.
 */
export function generateOrcaSlicerProfiles(
  filaments: FilamentDoc[],
  { bakeCalibration = false }: { bakeCalibration?: boolean } = {},
): Record<string, string[] | string>[] {
  return filaments.map((filament) => {
    // Bake the representative calibration only on the opt-in single-preset path
    // so tuned flow/PA/retraction/fan values reach a standalone preset (stock
    // Bambu / a manually-imported Orca .json has no dynamic fallback).
    const orcaKeys = filamentToOrcaSlicerKeys(
      filament,
      bakeCalibration ? pickRepresentativeCalibration(filament) : null,
    );

    return {
      // Metadata fields (plain strings, not arrays)
      name: filament.name || "",
      type: "filament",
      filament_id: `fdb_${filament._id?.toString() || ""}`,
      from: "filament_db",
      instantiation: "true",
      // All slicer settings as arrays
      ...orcaKeys,
    };
  });
}
