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
 */
export function filamentToOrcaSlicerKeys(
  filament: FilamentDoc,
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
  set("filament_colour", filament.color);
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

  // Soluble flag
  if (filament.soluble != null) set("filament_soluble", filament.soluble ? "1" : "0");

  // Shrinkage
  if (filament.shrinkageXY != null) set("filament_shrink", String(filament.shrinkageXY) + "%");
  if (filament.shrinkageZ != null) set("filament_shrinkage_compensation_z", filament.shrinkageZ);

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

  return keys;
}

/**
 * Generate an array of OrcaSlicer-format filament profile objects
 * from resolved Filament DB documents.
 */
export function generateOrcaSlicerProfiles(filaments: FilamentDoc[]): Record<string, string[] | string>[] {
  return filaments.map((filament) => {
    const orcaKeys = filamentToOrcaSlicerKeys(filament);

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
