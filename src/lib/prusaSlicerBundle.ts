/**
 * Generate a PrusaSlicer-compatible INI config bundle from Filament DB filaments.
 *
 * PrusaSlicer's load_configbundle() expects [filament:Name] sections with the
 * full set of PrusaSlicer keys (filament_type, filament_vendor, temperature,
 * bed_temperature, etc.). This module bridges Filament DB's structured schema
 * to PrusaSlicer's flat INI format by:
 *
 * 1. Writing core PrusaSlicer keys from structured DB fields (temps, density, cost, etc.)
 * 2. Merging with the `settings` catch-all for PrusaSlicer-specific keys not in the schema
 *    (fan settings, retraction, gcode, ramming, etc.)
 * 3. Applying calibration overrides per nozzle/printer combination
 * 4. Applying preset overrides for temperature/extrusion variants
 *
 * The structured DB fields always take precedence — they represent the canonical
 * values in Filament DB. The `settings` bag provides passthrough for keys that
 * Filament DB doesn't model (e.g. filament_ramming_parameters, start_filament_gcode).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

export interface BundleOptions {
  /** Filter by filament type (e.g. "PLA", "PETG") */
  type?: string;
  /** Filter by vendor name */
  vendor?: string;
  /** Filter by specific filament IDs */
  ids?: string[];
}

/**
 * Map a resolved Filament DB document to PrusaSlicer INI key-value pairs.
 * Structured DB fields are mapped to their PrusaSlicer equivalents.
 * The `settings` bag is merged underneath (DB fields win on conflict).
 */
export function filamentToSlicerKeys(
  filament: FilamentDoc,
): Record<string, string | null> {
  // Start with the settings bag as the base — these are passthrough
  // PrusaSlicer keys preserved from a previous import
  const keys: Record<string, string | null> = { ...(filament.settings || {}) };

  // Map structured DB fields → PrusaSlicer INI keys.
  // These override anything in the settings bag.
  const set = (key: string, value: unknown) => {
    if (value != null && value !== "") {
      keys[key] = String(value);
    } else if (key in keys && keys[key] === null) {
      // The settings bag has nil for this key (from a previous import).
      // Remove it so PrusaSlicer uses its built-in defaults instead of
      // interpreting nil as "reset to zero" for numeric fields.
      delete keys[key];
    }
    // If the settings bag has an actual string value, preserve it.
    // If the key isn't in the settings bag at all, don't add it.
  };

  // Core identification
  set("filament_type", filament.type);
  set("filament_vendor", filament.vendor);
  set("filament_colour", filament.color);
  set("filament_diameter", filament.diameter);
  set("filament_density", filament.density);
  set("filament_cost", filament.cost);
  set("filament_spool_weight", filament.spoolWeight);
  set("filament_max_volumetric_speed", filament.maxVolumetricSpeed);

  // Temperatures
  const temps = filament.temperatures || {};
  set("temperature", temps.nozzle);
  set("first_layer_temperature", temps.nozzleFirstLayer);
  set("bed_temperature", temps.bed);
  set("first_layer_bed_temperature", temps.bedFirstLayer);

  // Filament settings ID (use Filament DB name as the ID)
  if (!keys.filament_settings_id) {
    keys.filament_settings_id = filament.name || "";
  }

  // Notes — preserve existing, or use Filament DB notes
  if (!keys.filament_notes && filament.notes) {
    keys.filament_notes = filament.notes;
  }

  // Soluble / abrasive flags
  if (filament.soluble != null) set("filament_soluble", filament.soluble ? "1" : "0");
  if (filament.abrasive != null) set("filament_abrasive", filament.abrasive ? "1" : "0");

  // Shrinkage
  if (filament.shrinkageXY != null)
    set("filament_shrinkage_compensation_xy", filament.shrinkageXY);
  if (filament.shrinkageZ != null)
    set("filament_shrinkage_compensation_z", filament.shrinkageZ);

  // Inherits (PrusaSlicer preset inheritance)
  if (filament.inherits) {
    keys.inherits = filament.inherits;
  }

  return keys;
}

/**
 * Write a single [filament:Name] section to the output lines array.
 */
function writeSection(
  lines: string[],
  name: string,
  keys: Record<string, string | null>,
  overrides?: Record<string, string>,
) {
  lines.push(`[filament:${name}]`);

  const merged = { ...keys };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value != null) merged[key] = value;
    }
  }

  // Sort keys for consistent output
  const sortedKeys = Object.keys(merged).sort();
  for (const key of sortedKeys) {
    const value = merged[key];
    if (value === null) {
      // Preserve nil for settings bag values (means "inherit from parent" in PrusaSlicer)
      lines.push(`${key} = nil`);
    } else if (value !== undefined) {
      lines.push(`${key} = ${value}`);
    }
  }

  lines.push("");
}

/**
 * Apply calibration overrides (nozzle/printer-specific values) to a set of
 * PrusaSlicer keys, returning the overrides dict.
 */
function buildCalibrationOverrides(
  cal: FilamentDoc,
  baseSettings: Record<string, string | null>,
): Record<string, string> {
  const overrides: Record<string, string> = {};

  if (cal.extrusionMultiplier != null)
    overrides.extrusion_multiplier = String(cal.extrusionMultiplier);
  if (cal.maxVolumetricSpeed != null)
    overrides.filament_max_volumetric_speed = String(cal.maxVolumetricSpeed);
  if (cal.retractLength != null)
    overrides.filament_retract_length = String(cal.retractLength);
  if (cal.retractSpeed != null)
    overrides.filament_retract_speed = String(cal.retractSpeed);
  if (cal.retractLift != null)
    overrides.filament_retract_lift = String(cal.retractLift);

  if (cal.pressureAdvance != null) {
    const gcode = baseSettings.start_filament_gcode as string | null;
    if (gcode && /M572\s+S[\d.]+/.test(gcode)) {
      overrides.start_filament_gcode = gcode.replace(
        /M572\s+S[\d.]+/,
        `M572 S${cal.pressureAdvance}`,
      );
    } else if (gcode) {
      overrides.start_filament_gcode = `${gcode}\\nM572 S${cal.pressureAdvance}`;
    } else {
      overrides.start_filament_gcode = `M572 S${cal.pressureAdvance}`;
    }
  }

  return overrides;
}

/**
 * Apply preset overrides (temperature/extrusion variants) to a set of overrides.
 */
function buildPresetOverrides(
  preset: FilamentDoc,
): Record<string, string> {
  const overrides: Record<string, string> = {};

  if (preset.extrusionMultiplier != null)
    overrides.extrusion_multiplier = String(preset.extrusionMultiplier);
  if (preset.temperatures?.nozzle != null)
    overrides.temperature = String(preset.temperatures.nozzle);
  if (preset.temperatures?.nozzleFirstLayer != null)
    overrides.first_layer_temperature = String(preset.temperatures.nozzleFirstLayer);
  if (preset.temperatures?.bed != null)
    overrides.bed_temperature = String(preset.temperatures.bed);
  if (preset.temperatures?.bedFirstLayer != null)
    overrides.first_layer_bed_temperature = String(preset.temperatures.bedFirstLayer);

  return overrides;
}

/**
 * Generate a PrusaSlicer-compatible INI config bundle from an array of
 * resolved Filament DB documents.
 *
 * Each filament produces one or more [filament:Name] sections depending on
 * whether it has calibrations and/or presets.
 */
export function generatePrusaSlicerBundle(filaments: FilamentDoc[]): string {
  const lines: string[] = [];
  lines.push("# PrusaSlicer config bundle generated by Filament DB");
  lines.push(`# ${new Date().toISOString()}`);
  lines.push("");

  for (const filament of filaments) {
    const slicerKeys = filamentToSlicerKeys(filament);

    const calibrations = (filament.calibrations || []) as FilamentDoc[];
    const presets = (filament.presets || []) as FilamentDoc[];

    if (calibrations.length > 0) {
      for (const cal of calibrations) {
        if (!cal.nozzle) continue;
        const nozzleSuffix = cal.nozzle.name || `${cal.nozzle.diameter}mm`;
        const printerPrefix = cal.printer ? `${cal.printer.name} ` : "";
        const calOverrides = buildCalibrationOverrides(cal, slicerKeys);

        if (presets.length > 0) {
          for (const preset of presets) {
            const combined = {
              ...calOverrides,
              ...buildPresetOverrides(preset),
            };
            writeSection(
              lines,
              `${filament.name} ${printerPrefix}${nozzleSuffix} ${preset.label}`,
              slicerKeys,
              combined,
            );
          }
        } else {
          writeSection(
            lines,
            `${filament.name} ${printerPrefix}${nozzleSuffix}`,
            slicerKeys,
            calOverrides,
          );
        }
      }
    } else if (presets.length > 0) {
      for (const preset of presets) {
        writeSection(
          lines,
          `${filament.name} ${preset.label}`,
          slicerKeys,
          buildPresetOverrides(preset),
        );
      }
    } else {
      writeSection(lines, filament.name, slicerKeys);
    }
  }

  return lines.join("\n");
}
