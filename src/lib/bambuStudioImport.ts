/**
 * Bambu Studio filament-preset (.json) → Filament DB import.
 *
 * Bambu Studio forked OrcaSlicer, and the filament-preset JSON schema is
 * identical to OrcaSlicer's: every value is a single-element array
 * (multi-extruder convention); the one Bambu-specific tweak is `from:
 * "User"`. This parser inverts `filamentToOrcaSlicerKeys` (see
 * `src/lib/orcaSlicerBundle.ts`) and works for both slicers' JSONs.
 *
 * Pure parser/mapper — no Mongo writes, no variant resolution (routes own
 * both). Spool data, dryCycles, and usageHistory are never touched: Bambu
 * profiles don't carry them, so the importer never overwrites them.
 * Calibration values live IN the preset; they're extracted into
 * `calibrationHints` for the route/applier to place.
 *
 * Round-trip guarantee: every key the exporter writes maps back to the same
 * DB field, OR ends up in `settings` for passthrough.
 */

import { wrapIniString } from "./parseIni";

// Inverse of the BED_TYPE_KEY_MAP in orcaSlicerBundle.ts (keep in sync).
// Bambu/Orca use per-plate keys rather than a single bed_temperature.
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
  // `filament_soluble` and `filament_notes` (GH #620) are deliberately NOT
  // here — the model has no matching column, so listing them as structured
  // destroys the value (strict mode strips the write AND the key is excluded
  // from the settings bag). Riding the bag keeps them lossless.
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
 * Calibration-relevant keys lifted into `calibrationHints` for the route to
 * apply — the exact set mirrors `calibrationToOrcaSlicerKeys` on the export
 * side (keep in sync). Keys here are EXCLUDED from the settings bag, so a key
 * in this set that isn't also extracted into a hint is silently dropped on
 * import. A key only belongs here when:
 *   1. The parser extracts it into a `CalibrationHints` field, AND
 *   2. The applier writes that field to the calibrations[] row.
 *
 * The exporter's Bambu/Orca-canonical names:
 *   calibration.fanMinSpeed     → overhang_fan_speed
 *   calibration.fanMaxSpeed     → additional_cooling_fan_speed
 *   calibration.retractLength   → filament_retraction_length
 *   calibration.retractSpeed    → filament_retraction_speed
 *   calibration.retractLift     → filament_z_hop
 * Older aliases (`fan_min_speed`, `filament_retract_*`) stay listed as
 * fallbacks so hand-edited / older profiles still work.
 */
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
  settings: Record<string, string | string[]>;
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
  /** GH #950: the profile EXPLICITLY disabled chamber heating
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

  // Shrinkage. GH #1008 F1: `filament_shrink` is Orca/Bambu's 100-based
  // "remaining size" (94% → 6% shrink; 100% or absent → no shrink), so convert
  // to the DB's 0-based shrinkage: `100 - value`. A stock profile's default
  // 100% (or "98%") thus stores 0 (or 2), not a bogus 100/98. `shrinkageZ` uses
  // the PrusaSlicer-named 0-based key, so it stays raw.
  const shrink = num(json.filament_shrink);
  if (shrink != null) filament.shrinkageXY = 100 - shrink;
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
    // Canonical Bambu/Orca key names first; shorter aliases as fallback
    // (see the CALIBRATION_KEYS docblock).
    retractLength:
      num(json.filament_retraction_length) ?? num(json.filament_retract_length),
    retractSpeed:
      num(json.filament_retraction_speed) ?? num(json.filament_retract_speed),
    retractLift: num(json.filament_z_hop) ?? num(json.filament_retract_lift),
    maxVolumetricSpeed: num(json.filament_max_volumetric_speed),
    fanMinSpeed: num(json.overhang_fan_speed) ?? num(json.fan_min_speed),
    fanMaxSpeed:
      num(json.additional_cooling_fan_speed) ?? num(json.fan_max_speed),
    fanBridgeSpeed: num(json.bridge_fan_speed),
    // GH #950: activate_chamber_temp_control="0" means chamber heating is
    // OFF, so don't import the temperature (matches the exporter).
    chamberTemp:
      unwrap(json.activate_chamber_temp_control) === "0"
        ? undefined
        : num(json.chamber_temperature),
    // Record an explicit disable so the applier can CLEAR a pre-existing
    // calibrations[].chamberTemp (a bare absence must not clear).
    chamberDisabled: unwrap(json.activate_chamber_temp_control) === "0",
    hasAnyHint: false,
  };
  // `maxVolumetricSpeed` is deliberately EXCLUDED from hasAnyHint: it also
  // lands on the top-level filament field, so an unresolved printer/nozzle
  // context loses nothing and must not trip the misleading "calibration
  // unresolved" warning. `chamberTemp` is excluded for the same reason —
  // when unresolved, `prepareBambuUpdate` preserves the raw chamber keys in
  // the settings bag, so nothing is dropped.
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
  // Anything not plucked into a structured field or calibration hint is
  // stashed for the next export round-trip; mergeSlicerSettings (in the
  // route) applies size caps.
  for (const [key, value] of Object.entries(json)) {
    if (STRUCTURED_KEYS.has(key)) continue;
    if (CALIBRATION_KEYS.has(key)) {
      // The chamber keys are normally routed structurally or via the
      // applier's settings-bag fallback — but BOTH require an EFFECTIVE
      // chamberTemp. When the chamber is DISABLED, the parse above clears
      // chamberTemp, so the settings bag is the value's ONLY home; keep the
      // raw chamber keys there so a disabled-chamber profile still round-trips.
      const isChamberKey =
        key === "chamber_temperature" || key === "activate_chamber_temp_control";
      if (!isChamberKey || calibrationHints.chamberTemp != null) continue;
      // else: disabled/ineffective chamber → fall through and store the raw key.
    }
    // GH #678: a genuinely multi-valued key (e.g. compatible_printers with
    // several combos) is stored AS an array — every consumer is array-aware
    // (PrusaSlicer exporter via serializeIniValueList, Orca/Bambu exporter
    // natively, the edit form's `;`-join, splitInheritedImportSet's
    // element-wise compare). Single- and zero-element arrays keep the scalar
    // collapse below BYTE-IDENTICAL — the Orca/Bambu one-element convention
    // is the common case and every round-trip/string-equality path depends
    // on it.
    // `compatible_printers_condition` is a single EXPRESSION, not a list —
    // preserving an array would bypass the GH #1021 legacy-condition
    // ingestion strip entirely (stripLegacyMachineCondition's grammar is
    // string-only, by design), so a pre-upgrade multi-extruder profile could
    // re-persist the machine-derived restriction and hide the preset again.
    // First-element collapse keeps the guard sound.
    const isScalarOnlyKey = key === "compatible_printers_condition";
    if (Array.isArray(value) && value.length > 1 && !isScalarOnlyKey) {
      // Elements are stored RAW: arrays never ride the scalar `key = value`
      // INI path — the PrusaSlicer emitter quotes/escapes via
      // serializeIniValueList and the Orca/Bambu exporter passes raw arrays
      // natively. Wrapping elements here double-encoded them on the Prusa
      // side and exported escape text as CONTENT on the Orca side.
      filament.settings[key] = value.map((el) => String(el));
      continue;
    }
    const s = unwrap(value);
    if (s == null) continue;
    // GH #1070: the settings bag is WIRE-CANONICAL (see src/lib/parseIni.ts's
    // codec docblock) — a raw multi-line string stored here (Orca/Bambu JSON
    // carries real newlines in e.g. filament_notes) would hit
    // serializeIniValue's legacy-wrapper heuristic on the next PrusaSlicer
    // export, stripping boundary quotes that are genuine CONTENT. Escaping at
    // ingestion removes the ambiguity; single-line values stay byte-identical.
    filament.settings[key] = /[\r\n]/.test(s) ? wrapIniString(s) : s;
  }

  return { filament, calibrationHints };
}
