/**
 * Bambu Studio filament-preset (.json) → Filament DB import.
 *
 * Bambu Studio forked OrcaSlicer (which forked PrusaSlicer), and the
 * filament-preset JSON schema is identical to OrcaSlicer's: every value is
 * a single-element array (multi-extruder convention), and the keys match.
 * The single Bambu-specific tweak is `from: "User"`. So this parser inverts
 * `filamentToOrcaSlicerKeys` (see `src/lib/orcaSlicerBundle.ts`) and works
 * for both Bambu Studio and OrcaSlicer filament JSONs.
 *
 * What it does NOT touch:
 *   - Mongo writes — pure parser/mapper. Routes own the upsert.
 *   - Variant resolution — exporter calls `resolveFilamentForExport`; on
 *     import we just produce a flat update payload and let the route apply
 *     it to whichever filament (by name or by id) it targets.
 *   - Spool data, dryCycles, usageHistory — Bambu profiles don't carry
 *     these, so the importer never overwrites them.
 *
 * Calibration handling (the meaningful design decision):
 *   - Bambu calibration values (`filament_flow_ratio`,
 *     `pressure_advance`, `filament_retract_length`, etc.) live IN the
 *     filament preset itself rather than a separate file. We extract
 *     them into `calibrationHints` so the route can decide whether to:
 *       a) match a Printer by `printer_settings_id` and write a
 *          calibrations[] row tagged with the printer + the matched
 *          nozzle, OR
 *       b) fall back to a top-level update (extrusionMultiplier,
 *          maxVolumetricSpeed) when no printer/nozzle context resolves.
 *
 * Round-trip guarantee:
 *   - Every key the exporter writes maps back to the same DB field, OR
 *     ends up in `settings` for passthrough. So export → import → export
 *     produces (modulo array-wrapping whitespace) the same JSON.
 */

// ── Inverse of the BED_TYPE_KEY_MAP in orcaSlicerBundle.ts ────────────
// Bambu/Orca use per-plate keys (cool_plate_temp, hot_plate_temp, …)
// rather than a single bed_temperature. Invert so each plate key tells
// us which `bedTypeTemps[]` entry it belongs in.
const BED_PLATE_KEYS: Record<string, { bedType: string; field: "temperature" | "firstLayerTemperature" }> = {
  cool_plate_temp: { bedType: "Cool Plate", field: "temperature" },
  cool_plate_temp_initial_layer: { bedType: "Cool Plate", field: "firstLayerTemperature" },
  eng_plate_temp: { bedType: "Engineering Plate", field: "temperature" },
  eng_plate_temp_initial_layer: { bedType: "Engineering Plate", field: "firstLayerTemperature" },
  hot_plate_temp: { bedType: "Hot Plate", field: "temperature" },
  hot_plate_temp_initial_layer: { bedType: "Hot Plate", field: "firstLayerTemperature" },
  textured_plate_temp: { bedType: "Textured PEI Plate", field: "temperature" },
  textured_plate_temp_initial_layer: { bedType: "Textured PEI Plate", field: "firstLayerTemperature" },
  textured_cool_plate_temp: { bedType: "Textured Cool Plate", field: "temperature" },
  textured_cool_plate_temp_initial_layer: { bedType: "Textured Cool Plate", field: "firstLayerTemperature" },
};

/**
 * Keys that map to top-level structured DB fields. Anything else ends up
 * in the `settings` passthrough bag so a future export reproduces it.
 *
 * Anything in this set is "owned" by the structured schema and must NOT
 * also land in `settings` — otherwise export would emit it twice and the
 * settings copy would shadow the structured one on re-import.
 */
const STRUCTURED_KEYS = new Set<string>([
  // identity
  "filament_id",
  "name",
  "filament_settings_id",
  "filament_type",
  "filament_vendor",
  "filament_colour",
  "filament_color",
  "filament_diameter",
  "filament_density",
  "filament_cost",
  "filament_max_volumetric_speed",
  // `filament_soluble` deliberately NOT here — the Filament model has no
  // `soluble` column, so even if the parser extracted it Mongoose strict
  // mode would silently drop the value on the update. Letting it fall
  // through to the settings bag preserves the round-trip exactly the way
  // we handle other model-less Bambu keys (Codex P1 on PR #387 round 2).
  // `filament_notes` is NOT here either, for the same reason (GH #620):
  // the model has no top-level `notes` column (the form stores notes in
  // the settings bag as `filament_notes`), so listing it as structured
  // destroyed the value — strict mode stripped the write AND the key was
  // excluded from the settings bag. Riding the bag keeps it lossless and
  // makes imported notes show up in the form's Notes field.
  "filament_shrink",
  "filament_shrinkage_compensation_z",
  // temperatures
  "nozzle_temperature",
  "nozzle_temperature_initial_layer",
  "nozzle_temperature_range_low",
  "nozzle_temperature_range_high",
  // bed-plate temps (handled by BED_PLATE_KEYS)
  ...Object.keys(BED_PLATE_KEYS),
  // schema bookkeeping — never useful at the app level
  "type",
  "version",
  "instantiation",
  "from",
]);

/**
 * Calibration-relevant keys we lift out for the route to apply. The
 * exact set mirrors `calibrationToOrcaSlicerKeys` on the export side.
 *
 * Listed here AND in STRUCTURED_KEYS — the route consumes them via
 * `calibrationHints` and the parser does NOT also store them in the
 * settings bag (otherwise the calibration row's values would race the
 * top-level passthrough on round-trip).
 */
// Codex P1 on PR #387: keys listed here are pulled into `calibrationHints`
// and EXCLUDED from the settings bag. Any key in this set that isn't also
// extracted into a hint would be silently dropped on import — round-trip
// breaks. So a key only belongs here when:
//   1. The parser extracts it into a `CalibrationHints` field, AND
//   2. The applier writes that field to the calibrations[] row.
//
// Round 3 (Codex P1 #387): the previous round let
// `additional_cooling_fan_speed` and `overhang_fan_speed` fall through
// to settings because the parser had no matching hint. But the repo's
// exporter (`calibrationToOrcaSlicerKeys` in
// `src/lib/orcaSlicerBundle.ts`) actually emits the fan/retraction
// values under THESE Bambu/Orca-canonical names:
//
//   calibration.fanMinSpeed     → overhang_fan_speed
//   calibration.fanMaxSpeed     → additional_cooling_fan_speed
//   calibration.retractLength   → filament_retraction_length
//   calibration.retractSpeed    → filament_retraction_speed
//   calibration.retractLift     → filament_z_hop
//
// So the round-trip export → import was silently dropping these — the
// values landed in settings rather than the calibrations[] row. Pull
// each through CALIBRATION_KEYS + extract into the right hint field
// below. Older aliases (`fan_min_speed`, `filament_retract_*`) stay
// listed as fallbacks so hand-edited / older profiles still work.
const CALIBRATION_KEYS = new Set<string>([
  "filament_flow_ratio",
  "filament_extrusion_multiplier",
  "pressure_advance",
  "filament_retraction_length",
  "filament_retraction_speed",
  "filament_z_hop",
  "filament_retract_length",
  "filament_retract_speed",
  "filament_retract_lift",
  "filament_max_volumetric_speed", // also structured (top-level)
  "overhang_fan_speed",
  "additional_cooling_fan_speed",
  "fan_min_speed",
  "fan_max_speed",
  "bridge_fan_speed",
  "chamber_temperature",
  "activate_chamber_temp_control",
]);

/**
 * Resolve a Bambu/Orca JSON value (always a single-element array of
 * stringified values) to a scalar. Returns `undefined` for absent,
 * empty-array, or empty-string values so callers can use `??` chains.
 */
function unwrap(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const first = value[0];
    if (first == null) return undefined;
    const s = String(first);
    return s === "" ? undefined : s;
  }
  if (typeof value === "string") return value === "" ? undefined : value;
  return String(value);
}

/** Numeric coerce that returns `undefined` for non-finite inputs so we
 * never write `NaN` into the model. */
function num(value: unknown): number | undefined {
  const s = unwrap(value);
  if (s == null) return undefined;
  // Strip a trailing "%" because filament_shrink ships as "0.5%".
  const cleaned = s.endsWith("%") ? s.slice(0, -1) : s;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

export interface ParsedTemperatures {
  nozzle?: number;
  nozzleFirstLayer?: number;
  bed?: number;
  bedFirstLayer?: number;
  nozzleRangeMin?: number;
  nozzleRangeMax?: number;
}

export interface ParsedBedTypeTemp {
  bedType: string;
  temperature?: number;
  firstLayerTemperature?: number;
}

export interface ParsedFilament {
  /** Display name, from `filament_settings_id` (preferred) or top-level `name`. */
  name: string;
  /** Bambu's stable identifier, if present. Useful for re-import matching. */
  filamentId?: string;
  /** Material type — `filament_type`. */
  type?: string;
  vendor?: string;
  color?: string;
  diameter?: number;
  density?: number;
  cost?: number;
  maxVolumetricSpeed?: number;
  shrinkageXY?: number;
  shrinkageZ?: number;
  temperatures: ParsedTemperatures;
  bedTypeTemps: ParsedBedTypeTemp[];
  /** Unknown / round-trippable keys. Goes into `settings` on the model. */
  settings: Record<string, string>;
}

export interface CalibrationHints {
  /** Bambu's printer reference, used to auto-detect a Printer + nozzle. */
  printerSettingsId?: string;
  /** Compatible-printers selector string, used as a fallback match. */
  compatiblePrinters?: string;
  /** Flow ratio (filament_flow_ratio) → calibrations[].extrusionMultiplier. */
  extrusionMultiplier?: number;
  pressureAdvance?: number;
  retractLength?: number;
  retractSpeed?: number;
  retractLift?: number;
  maxVolumetricSpeed?: number;
  fanMinSpeed?: number;
  fanMaxSpeed?: number;
  fanBridgeSpeed?: number;
  /** GH #950: chamber temperature → calibrations[].chamberTemp. The export
   * emits it (orcaSlicerBundle), so parse it back for a lossless round-trip. */
  chamberTemp?: number;
  /** GH #950 (Codex r5): the profile EXPLICITLY disabled chamber heating
   * (activate_chamber_temp_control="0"). Distinct from chamberTemp being absent —
   * a disable must CLEAR a pre-existing calibrations[].chamberTemp on the resolved
   * path, else /calibration re-enables chamber heat on the next round-trip. */
  chamberDisabled?: boolean;
  /** True when at least one calibration-relevant value was present. The
   * route uses this to decide whether to upsert a calibrations[] row vs
   * leave the filament's calibration data alone. */
  hasAnyHint: boolean;
}

export interface BambuParseResult {
  filament: ParsedFilament;
  calibrationHints: CalibrationHints;
}

/**
 * Parse a Bambu Studio / OrcaSlicer filament-preset JSON into an
 * app-shaped payload + calibration hints. Throws on a payload that is
 * not a JSON object or has no usable name.
 */
export function parseBambuStudioProfile(raw: unknown): BambuParseResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Bambu Studio profile must be a JSON object");
  }
  const json = raw as Record<string, unknown>;

  const name =
    unwrap(json.filament_settings_id) ??
    unwrap(json.name) ??
    unwrap(json.filament_id);
  if (!name) {
    throw new Error(
      'Bambu Studio profile is missing an identifier — expected "filament_settings_id" or "name"',
    );
  }

  const filament: ParsedFilament = {
    name,
    filamentId: unwrap(json.filament_id),
    type: unwrap(json.filament_type),
    vendor: unwrap(json.filament_vendor),
    color: unwrap(json.filament_colour) ?? unwrap(json.filament_color),
    diameter: num(json.filament_diameter),
    density: num(json.filament_density),
    cost: num(json.filament_cost),
    maxVolumetricSpeed: num(json.filament_max_volumetric_speed),
    temperatures: {
      nozzle: num(json.nozzle_temperature),
      nozzleFirstLayer: num(json.nozzle_temperature_initial_layer),
      nozzleRangeMin: num(json.nozzle_temperature_range_low),
      nozzleRangeMax: num(json.nozzle_temperature_range_high),
      // Default plate (hot_plate_temp) doubles as the top-level bed temp
      // on the export side, so invert that here too. The plate-specific
      // entry still ends up in bedTypeTemps below.
      bed: num(json.hot_plate_temp),
      bedFirstLayer: num(json.hot_plate_temp_initial_layer),
    },
    bedTypeTemps: [],
    settings: {},
  };

  // Shrinkage — "0.5%" → 0.5
  const shrink = num(json.filament_shrink);
  if (shrink != null) filament.shrinkageXY = shrink;
  const shrinkZ = num(json.filament_shrinkage_compensation_z);
  if (shrinkZ != null) filament.shrinkageZ = shrinkZ;

  // ── Bed-plate temps → bedTypeTemps[] ────────────────────────────────
  // Collect per-bed-type entries by name, then emit only those with at
  // least one value set.
  const byBedType = new Map<string, ParsedBedTypeTemp>();
  for (const [key, mapping] of Object.entries(BED_PLATE_KEYS)) {
    const v = num(json[key]);
    if (v == null) continue;
    let entry = byBedType.get(mapping.bedType);
    if (!entry) {
      entry = { bedType: mapping.bedType };
      byBedType.set(mapping.bedType, entry);
    }
    entry[mapping.field] = v;
  }
  filament.bedTypeTemps = [...byBedType.values()];

  // ── Calibration hints ───────────────────────────────────────────────
  const calibrationHints: CalibrationHints = {
    printerSettingsId:
      unwrap(json.printer_settings_id) ??
      unwrap(json.compatible_printers_condition),
    compatiblePrinters: unwrap(json.compatible_printers),
    extrusionMultiplier:
      num(json.filament_flow_ratio) ?? num(json.filament_extrusion_multiplier),
    pressureAdvance: num(json.pressure_advance),
    // Canonical Bambu/Orca key names (`filament_retraction_*`,
    // `filament_z_hop`) come first; the shorter aliases stay as a
    // fallback so hand-edited or older profiles still parse. Round-trip
    // through the repo's own export → import path now works again
    // (Codex P1 on PR #387 round 3).
    retractLength:
      num(json.filament_retraction_length) ?? num(json.filament_retract_length),
    retractSpeed:
      num(json.filament_retraction_speed) ?? num(json.filament_retract_speed),
    retractLift: num(json.filament_z_hop) ?? num(json.filament_retract_lift),
    maxVolumetricSpeed: num(json.filament_max_volumetric_speed),
    // Same canonical-first pattern: the exporter writes
    // `overhang_fan_speed` for fanMinSpeed and
    // `additional_cooling_fan_speed` for fanMaxSpeed; the old
    // `fan_min_speed`/`fan_max_speed` names stay as fallback aliases.
    fanMinSpeed: num(json.overhang_fan_speed) ?? num(json.fan_min_speed),
    fanMaxSpeed:
      num(json.additional_cooling_fan_speed) ?? num(json.fan_max_speed),
    fanBridgeSpeed: num(json.bridge_fan_speed),
    // GH #950: honor the enable flag — activate_chamber_temp_control="0" means
    // chamber heating is OFF, so don't import the temperature (matches the
    // exporter, which only emits chamber_temperature when chamberTemp != null).
    chamberTemp:
      unwrap(json.activate_chamber_temp_control) === "0"
        ? undefined
        : num(json.chamber_temperature),
    // GH #950 (Codex r5): record an explicit disable so the applier can CLEAR a
    // pre-existing calibrations[].chamberTemp (a bare absence must not clear).
    chamberDisabled: unwrap(json.activate_chamber_temp_control) === "0",
    hasAnyHint: false,
  };
  // Codex P3 on PR #387 round 6: `maxVolumetricSpeed` is the ONE
  // calibration-relevant value that ALSO lands on the top-level filament
  // field (`buildStructuredUpdate` writes it). When it's the only hint
  // present and we can't resolve a printer/nozzle context, nothing is
  // actually lost — the top-level update carries the value. Flagging
  // `calibrationUnresolved: true` in that case drove a misleading
  // warning toast on successful imports. Exclude it from `hasAnyHint`
  // so we only enter the unresolved path when there's per-nozzle data
  // that would actually be dropped.
  //
  // GH #950 (Codex P2 on PR #968): `chamberTemp` is EXCLUDED for the same
  // reason. Its structured home (calibrations[].chamberTemp) needs a resolved
  // printer/nozzle, but when that can't be resolved `prepareBambuUpdate` falls
  // back to preserving the raw chamber keys in the settings passthrough bag
  // (the "misfiled but survives" state #950 rates acceptable) — so a
  // chamber-only standalone profile loses nothing and must NOT trip the
  // unresolved warning.
  calibrationHints.hasAnyHint =
    calibrationHints.extrusionMultiplier != null ||
    calibrationHints.pressureAdvance != null ||
    calibrationHints.retractLength != null ||
    calibrationHints.retractSpeed != null ||
    calibrationHints.retractLift != null ||
    calibrationHints.fanMinSpeed != null ||
    calibrationHints.fanMaxSpeed != null ||
    calibrationHints.fanBridgeSpeed != null;

  // ── Settings bag passthrough ────────────────────────────────────────
  // Anything we didn't pluck into a structured field OR a calibration
  // hint gets stashed for the next export round-trip. mergeSlicerSettings
  // (in the route) applies size caps; here we just stringify.
  for (const [key, value] of Object.entries(json)) {
    if (STRUCTURED_KEYS.has(key)) continue;
    if (CALIBRATION_KEYS.has(key)) {
      // GH #950 (Codex P1 on PR #968 r2): the chamber keys are normally excluded
      // here and routed structurally (calibrations[].chamberTemp) or via the
      // applier's settings-bag fallback — but BOTH require an EFFECTIVE chamberTemp.
      // When the chamber is DISABLED (activate_chamber_temp_control="0"), the parse
      // above clears chamberTemp, so neither path carries the value and the settings
      // bag is its ONLY home. Keep the raw chamber keys in the bag in that case so a
      // disabled-chamber profile still round-trips (they rode the bag pre-#950.3).
      const isChamberKey =
        key === "chamber_temperature" || key === "activate_chamber_temp_control";
      if (!isChamberKey || calibrationHints.chamberTemp != null) continue;
      // else: disabled/ineffective chamber → fall through and store the raw key.
    }
    // NOTE (#678, deferred): unwrap() collapses a multi-element array to its
    // first element, so a multi-printer `compatible_printers` loses the rest on
    // a Bambu/Orca round-trip. A faithful fix can't just store the array here —
    // the `settings` bag is shared by the PrusaSlicer exporter (which would
    // comma-join an array into one invalid INI line) and the edit form (which
    // String-casts + `.replace()`s several keys). Round-tripping multi-valued
    // keys needs arch-aware serialization in each exporter; tracked on #678.
    const s = unwrap(value);
    if (s == null) continue;
    filament.settings[key] = s;
  }

  return { filament, calibrationHints };
}
