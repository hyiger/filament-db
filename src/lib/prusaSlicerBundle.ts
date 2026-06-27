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
 *
 * One section is generated per filament. Calibration overrides (extrusion
 * multiplier, pressure advance, retraction, max volumetric speed) are applied
 * dynamically by PrusaSlicer Filament Edition via `GET /api/filaments/:name/calibration`
 * when the printer/nozzle context changes — they are NOT baked into the bundle.
 *
 * The structured DB fields always take precedence — they represent the canonical
 * values in Filament DB. The `settings` bag provides passthrough for keys that
 * Filament DB doesn't model (e.g. filament_ramming_parameters, start_filament_gcode).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

/**
 * The single hex string a slicer preset should carry for a multi-color
 * filament. Differs from `displayColor()` in one important way: when
 * neither a primary nor a secondary exists, this returns `null` so the
 * `set()` helper skips the key entirely and the slicer falls back to its
 * own default — rather than emitting a forced `#808080` gray the user
 * never picked (Codex P2 on PR #485).
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
  // Slicer presets are single-color — coextruded / multi-color filaments
  // surface their primary, falling back to the first secondary when the
  // primary is null (the spec-aligned "coextruded" shape). When NEITHER
  // a primary nor a secondary exists `slicerExportColor` returns null so
  // `set` is a no-op and the slicer uses its own default — we never
  // invent a gray the user did not pick. Secondary colors beyond the
  // primary are intentionally dropped; the detail page's slicer-export
  // menu warns the user about this trade-off.
  set("filament_colour", slicerExportColor(filament));
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

  // #867: round-trip the STABLE Filament DB id so the sync-back can match by id
  // (resilient to a renamed preset) instead of only by the mutable name. The
  // fork registers `filamentdb_id` as a config option — PrusaSlicer drops
  // unknown keys on load, so this only "sticks" with the FilamentDB fork. Always
  // emitted (the _id is canonical); harmless to stock PrusaSlicer, which ignores it.
  if (filament._id != null) {
    keys.filamentdb_id = String(filament._id);
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

  // Filaments synced from Filament DB are intended to be usable on every
  // printer in the slicer — Filament DB doesn't model per-printer
  // restrictions. PrusaSlicer treats an empty `compatible_printers` +
  // `compatible_printers_condition` pair as "no restriction", so write
  // those defaults if (and only if) the upstream settings bag doesn't
  // already pin them to something specific from a previous import.
  // Without this, presets sync into PrusaSlicer but the active printer's
  // filament list filters them out — the Filaments tab dropdown skips
  // them, programmatic Tab::select_preset falls back to the closest
  // compatible default, and the scan-stream-driven auto-select can't
  // switch to a scanned tag.
  if (!("compatible_printers" in keys)) {
    keys.compatible_printers = "";
  }
  // #872: derive compatible_printers_condition from the filament's compatible
  // nozzle diameters, e.g. `nozzle_diameter[0]==0.4 or nozzle_diameter[0]==0.6`,
  // so a synced preset only shows up for printers whose nozzle matches. Gated so a
  // round-tripped user-pinned condition (already in the settings bag) wins, and
  // only applied when we actually have populated diameters — otherwise the empty
  // "no restriction" default below still applies.
  // Derive only when the key is ABSENT or an EMPTY STRING — both mean "no
  // restriction" (a round-tripped `compatible_printers_condition = ` stores "").
  // A NON-EMPTY string is a user pin, and `null` is PrusaSlicer's `nil`
  // inheritance marker (parseIniFilaments → null, writeSection re-emits it as
  // `nil`) — BOTH must be preserved, not overwritten by the derivation (Codex P2).
  if (
    (!("compatible_printers_condition" in keys) ||
      keys.compatible_printers_condition === "") &&
    Array.isArray(filament.compatibleNozzles)
  ) {
    const diameters = Array.from(
      new Set(
        filament.compatibleNozzles
          .map((n: unknown) =>
            n != null &&
            typeof n === "object" &&
            typeof (n as { diameter?: unknown }).diameter === "number"
              ? (n as { diameter: number }).diameter
              : null,
          )
          .filter((d): d is number => typeof d === "number" && d > 0),
      ),
    ).sort((a, b) => a - b);
    if (diameters.length > 0) {
      keys.compatible_printers_condition = diameters
        .map((d) => `nozzle_diameter[0]==${d}`)
        .join(" or ");
    }
  }

  if (!("compatible_printers_condition" in keys)) {
    keys.compatible_printers_condition = "";
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

    // Output one preset per filament — nozzle-specific calibration data
    // is applied dynamically by PrusaSlicer when the printer changes
    // (via the /api/filaments/{name}/calibration endpoint).
    writeSection(lines, filament.name, slicerKeys);
  }

  return lines.join("\n");
}
