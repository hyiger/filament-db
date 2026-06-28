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
 * GH #883: the inverse guard for `slicerExportColor` on a slicer SYNC-BACK.
 *
 * A coextruded / multi-color filament is stored spec-pure as `color: null` +
 * a populated `secondaryColors[]`. The export above gives the slicer ONE
 * representative color — `secondaryColors[0]` — under the single colour key.
 * On sync-back the slicer echoes that hex back, and a naïve mapping would write
 * it onto the null primary, leaving a hybrid (real primary + secondaries) that
 * no longer matches the user's coextruded shape.
 *
 * Decide what (if anything) to write to `color` from an incoming slicer hex:
 *   - no incoming hex                                   → undefined (don't write)
 *   - stored is coextruded AND incoming == secondaries[0] (case-insensitive)
 *       → undefined: it's the exported echo, preserve the null primary
 *   - otherwise                                         → the incoming hex
 *       (a genuine user edit, OR a normal single-color filament — write it)
 *
 * Returns `undefined` to mean "leave `color` unchanged".
 *
 * GH #913 (Codex P2): a VARIANT that INHERITS its parent's coextruded colors has
 * its OWN `secondaryColors` empty (array-fallback inheritance, #477/#106) — the
 * export resolves the parent first, so the slicer gets the PARENT's
 * `secondaryColors[0]`. Pass the resolved `parent` so the guard compares against
 * the EFFECTIVE secondaries and recognizes the inherited-coextruded case too.
 */
export function resolveSyncBackColor(
  stored: { color?: string | null; secondaryColors?: string[] | null } | null | undefined,
  incomingHex: string | null | undefined,
  parent?: { secondaryColors?: string[] | null } | null,
): string | undefined {
  if (incomingHex == null || incomingHex === "") return undefined;
  const primary = stored?.color;
  // secondaryColors is array-fallback inheritable: a variant with an empty own
  // array inherits the parent's. Resolve the EFFECTIVE secondaries so an
  // inherited-coextruded variant is detected (Codex P2 #913).
  let secondaries = stored?.secondaryColors;
  if ((!Array.isArray(secondaries) || secondaries.length === 0) && parent) {
    secondaries = parent.secondaryColors;
  }
  const isCoextruded =
    (primary == null || primary === "") &&
    Array.isArray(secondaries) &&
    secondaries.length > 0;
  if (isCoextruded) {
    const echo = secondaries![0];
    if (typeof echo === "string" && echo.toLowerCase() === incomingHex.toLowerCase()) {
      return undefined; // the exported representative color — keep null primary
    }
  }
  return incomingHex;
}

/**
 * Map a resolved Filament DB document to PrusaSlicer INI key-value pairs.
 * Structured DB fields are mapped to their PrusaSlicer equivalents.
 * The `settings` bag is merged underneath (DB fields win on conflict).
 */
/**
 * #872: the canonical "<Ø> <type> [HF]" suffix that distinguishes a per-nozzle
 * preset — e.g. "0.4 Diamondback", "0.4 Brass HF". Used to NAME the exported preset
 * (`<base> <suffix>`) AND as the `filamentdb_nozzle` hint, and re-derived on the
 * sync-back so a per-nozzle preset is recognized and its calibration routed.
 * Returns "" for a nozzle with no diameter (caller emits the base preset instead).
 */
export function nozzleSuffix(
  nozzle: { diameter?: number; type?: string; highFlow?: boolean } | null | undefined,
): string {
  if (!nozzle || nozzle.diameter == null) return "";
  return `${nozzle.diameter} ${nozzle.type ?? ""}${nozzle.highFlow ? " HF" : ""}`
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * #872: keys an export BAKES into a per-nozzle suffixed section. They are
 * nozzle-specific (NOT the base filament's shared identity), so they are
 * stripped when a round-tripped suffixed section is collapsed back to its base
 * on bulk import — otherwise one nozzle's baked value would pollute the base
 * filament's settings bag (and `compatible_printers_condition` would carry one
 * nozzle's scope). `temperature`/`filament_max_volumetric_speed` are handled
 * separately (the keys are omitted entirely so an UPDATE can't clobber the base).
 */
const PER_NOZZLE_BAKED_SETTING_KEYS = [
  "extrusion_multiplier",
  "filament_retract_length",
  "filament_retract_speed",
  "filament_retract_lift",
  "min_fan_speed",
  "max_fan_speed",
  "bridge_fan_speed",
  "temperature",
  "first_layer_temperature",
  "bed_temperature",
  "first_layer_bed_temperature",
  "filament_max_volumetric_speed",
  "compatible_printers_condition",
];

/** Routing hints an export emits; consumed for matching, never stored as data. */
const IMPORT_ROUTING_HINT_KEYS = ["filamentdb_id", "filamentdb_nozzle"];

/**
 * A parsed INI section after collapsing. `temperatures`/`maxVolumetricSpeed` are
 * OPTIONAL because a collapsed per-nozzle section omits them (they were baked
 * per-nozzle, so an UPDATE must not overwrite the base filament's shared values).
 */
export type CollapsedFilamentData = Omit<
  import("./parseIni").FilamentData,
  "temperatures" | "maxVolumetricSpeed" | "cost" | "density" | "diameter" | "color" | "vendor" | "type"
> & {
  temperatures?: import("./parseIni").FilamentData["temperatures"];
  maxVolumetricSpeed?: number | null;
  cost?: number | null;
  density?: number | null;
  diameter?: number;
  color?: string;
  vendor?: string;
  type?: string;
};

/**
 * #872: collapse Filament DB's OWN per-nozzle suffixed sections back to their
 * base filament so a bundle round-trip (export → bulk import) UPDATES the
 * original filament instead of spawning suffixed orphan records ("PLA 0.4 Brass",
 * "PLA 0.6 Brass"). A section is a per-nozzle export iff it carries a
 * `filamentdb_nozzle` hint; siblings share one `filamentdb_id`. The collapsed
 * base drops the nozzle-specific baked keys + routing hints and OMITS temps /
 * max-vol (so an update can't clobber the base's shared values). The per-nozzle
 * calibration model is deliberately NOT reconstructed here — snapshot/restore is
 * the lossless round-trip; this only prevents the orphan-duplication regression.
 * Non-hinted sections pass through with the routing hints stripped.
 */
export function collapsePerNozzleImportSections(
  filaments: import("./parseIni").FilamentData[],
): CollapsedFilamentData[] {
  const out: CollapsedFilamentData[] = [];
  const seenGroups = new Set<string>();
  for (const f of filaments) {
    const hint = (f.settings.filamentdb_nozzle ?? "").trim();
    if (!hint) {
      // Pass through, but never persist routing hints as settings data.
      const settings = { ...f.settings };
      for (const k of IMPORT_ROUTING_HINT_KEYS) delete settings[k];
      out.push({ ...f, settings });
      continue;
    }
    // Per-nozzle suffixed section → fold back into its base filament.
    const baseName = f.name.endsWith(` ${hint}`)
      ? f.name.slice(0, f.name.length - hint.length - 1).trim()
      : f.name;
    const id = (f.settings.filamentdb_id ?? "").trim();
    const groupKey = id ? `id:${id}` : `name:${baseName.toLowerCase()}`;
    if (seenGroups.has(groupKey)) continue; // a sibling already represents the base
    seenGroups.add(groupKey);
    const settings = { ...f.settings };
    for (const k of [...PER_NOZZLE_BAKED_SETTING_KEYS, ...IMPORT_ROUTING_HINT_KEYS]) {
      delete settings[k];
    }
    // Drop temperatures + maxVolumetricSpeed (baked per-nozzle): omitting the keys
    // means the importer's $set never overwrites the base filament's shared values.
    const { temperatures, maxVolumetricSpeed, cost, density, diameter, color, vendor, type, ...sharedFields } = f;
    void temperatures;
    void maxVolumetricSpeed;
    const collapsed: CollapsedFilamentData = { ...sharedFields, name: baseName, settings };
    // Carry a shared field ONLY when the suffixed section actually SUPPLIED it (the
    // source INI key is present) — otherwise parseIni's defaults (null / "#808080" /
    // 1.75 / "Unknown") would $set over the base filament's real cost/density/color/
    // diameter/vendor/type on an update (Codex P3). The normal export bakes all of
    // these from the base, so they still round-trip; only a partial/hand-crafted
    // section drops them (its fresh-create then fails the required-field validation,
    // surfaced as a per-row error rather than persisting an "Unknown" record).
    if ("filament_cost" in f.settings) collapsed.cost = cost;
    if ("filament_density" in f.settings) collapsed.density = density;
    if ("filament_diameter" in f.settings) collapsed.diameter = diameter;
    if ("filament_colour" in f.settings) collapsed.color = color;
    if ("filament_vendor" in f.settings) collapsed.vendor = vendor;
    if ("filament_type" in f.settings) collapsed.type = type;
    out.push(collapsed);
  }
  return out;
}

export function filamentToSlicerKeys(
  filament: FilamentDoc,
  // #872: when present, BAKE this per-nozzle calibration's filament-level values
  // into the preset (for a multi-nozzle filament exported as N flat presets, since
  // PrusaSlicer has no parent/child for user presets). Pressure advance is
  // printer-scoped and stays dynamic via the /calibration endpoint — not baked.
  calibration?: FilamentDoc,
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

  // #872: bake the per-nozzle calibration's FILAMENT-LEVEL values into this preset
  // (multi-nozzle export). Only filament-scoped keys are baked; pressure_advance is
  // a PRINTER setting and stays dynamic via the fork's /calibration endpoint. The
  // explicit nozzle-diameter condition + filamentdb_nozzle hint scope the preset and
  // let the sync-back route updates to the right calibration entry.
  if (calibration) {
    set("extrusion_multiplier", calibration.extrusionMultiplier);
    set("filament_max_volumetric_speed", calibration.maxVolumetricSpeed);
    set("filament_retract_length", calibration.retractLength);
    set("filament_retract_speed", calibration.retractSpeed);
    set("filament_retract_lift", calibration.retractLift);
    set("temperature", calibration.nozzleTemp);
    set("first_layer_temperature", calibration.nozzleTempFirstLayer);
    set("bed_temperature", calibration.bedTemp);
    set("first_layer_bed_temperature", calibration.bedTempFirstLayer);
    set("min_fan_speed", calibration.fanMinSpeed);
    set("max_fan_speed", calibration.fanMaxSpeed);
    set("bridge_fan_speed", calibration.fanBridgeSpeed);
    const nz = calibration.nozzle;
    if (nz && typeof nz === "object" && nz.diameter != null) {
      keys.compatible_printers_condition = `nozzle_diameter[0]==${nz.diameter}`;
      keys.filamentdb_nozzle = nozzleSuffix(nz);
    }
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
    // #872: group calibrations by DISTINCT nozzle (diameter + type), preferring the
    // any-printer/any-bed "default" entry as each nozzle's representative.
    const byNozzle = new Map<string, FilamentDoc>();
    for (const cal of Array.isArray(filament.calibrations) ? filament.calibrations : []) {
      const nz = cal?.nozzle;
      if (!nz || typeof nz !== "object" || nz.diameter == null) continue;
      // #872: a standard and a high-flow nozzle of the same Ø+type are DISTINCT
      // physical nozzles (the sync route disambiguates them via ?high_flow=), so
      // key on highFlow too — otherwise they'd collapse into one preset.
      // Case-fold the type in the grouping key so a casing variant ("Brass" vs
      // "brass") collapses into ONE preset, agreeing with the case-insensitive
      // type match on the sync-back + /calibration read paths (the human-readable
      // suffix/hint still uses the representative nozzle's original-cased type).
      const key = `${nz.diameter}|${(nz.type ?? "").trim().toLowerCase()}|${nz.highFlow ? "HF" : ""}`;
      const existing = byNozzle.get(key);
      const isDefault = cal.printer == null && cal.bedType == null;
      const existingIsDefault =
        existing && existing.printer == null && existing.bedType == null;
      if (!existing || (isDefault && !existingIsDefault)) byNozzle.set(key, cal);
    }

    if (byNozzle.size >= 2) {
      // Multiple nozzle profiles → one FLAT preset per nozzle, name suffixed with the
      // nozzle (e.g. "Inslogic PA12-CF 0.4 Diamondback") because PrusaSlicer has no
      // parent/child for USER filament presets. Each bakes its nozzle's filament-level
      // calibration; all share one filamentdb_id and carry a filamentdb_nozzle hint
      // so the sync-back routes updates to the right per-nozzle calibration entry.
      for (const cal of byNozzle.values()) {
        writeSection(
          lines,
          `${filament.name} ${nozzleSuffix(cal.nozzle)}`,
          filamentToSlicerKeys(filament, cal),
        );
      }
    } else {
      // 0 or 1 distinct nozzle → a single preset (unchanged). Any per-nozzle
      // calibration is applied dynamically by the fork when the printer changes
      // (GET /api/filaments/{name}/calibration).
      writeSection(lines, filament.name, filamentToSlicerKeys(filament));
    }
  }

  return lines.join("\n");
}
