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

import { serializeIniValue, serializeIniValueList } from "./parseIni";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

/**
 * The single hex string a slicer preset should carry for a multi-color
 * filament. Differs from `displayColor()` in one important way: when
 * neither a primary nor a secondary exists, this returns `null` so the
 * `set()` helper skips the key entirely and the slicer falls back to its
 * own default — rather than emitting a forced `#808080` gray the user
 * never picked.
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
 * GH #913: a VARIANT that INHERITS its parent's coextruded colors has
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
  // inherited-coextruded variant is detected (GH #913).
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
 * Keys stripped from a collapsed section's stored settings bag: the routing
 * hints (never data) plus `filament_settings_id` — GH #950: the export
 * re-derives filament_settings_id from the filament's CURRENT name, so keeping a
 * stale copy in the bag would make a renamed filament export its old name.
 */
const SETTINGS_STRIP_KEYS = [...IMPORT_ROUTING_HINT_KEYS, "filament_settings_id"];

/**
 * A parsed INI section after collapsing. `temperatures`/`maxVolumetricSpeed` are
 * OPTIONAL because a collapsed per-nozzle section omits them (they were baked
 * per-nozzle, so an UPDATE must not overwrite the base filament's shared values).
 */
export type CollapsedFilamentData = Omit<
  import("./parseIni").FilamentData,
  | "temperatures"
  | "maxVolumetricSpeed"
  | "cost"
  | "density"
  | "diameter"
  | "color"
  | "vendor"
  | "type"
  | "inherits"
> & {
  /** GH #1008 F3: subfields individually optional — the non-hinted collapse
   *  deletes each temp the section didn't supply so the importer's dot-key
   *  `$set` can't null a stored value (leave-when-omitted, same as the
   *  scalars); the whole object is dropped when no subfield remains. */
  temperatures?: Partial<import("./parseIni").FilamentData["temperatures"]>;
  maxVolumetricSpeed?: number | null;
  cost?: number | null;
  density?: number | null;
  diameter?: number;
  color?: string;
  vendor?: string;
  type?: string;
  /** GH #1008 F3: optional/deletable — omitted when the section carries no
   *  `inherits` key (parseIni materialises `inherits: null` either way). An
   *  EXPLICIT `inherits = nil` keeps the key (null value) and writes through. */
  inherits?: string | null;
  /** GH #950: the section's round-tripped `filamentdb_id` routing hint (the
   *  filament _id). Carried for id-first resolution in `upsertIniFilament`;
   *  NEVER persisted (stripped from the settings bag above). */
  filamentdbId?: string;
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
    // Routing hints are always scalars; a (nonsensical) array here reads as absent.
    const rawHint = f.settings.filamentdb_nozzle;
    const hint = typeof rawHint === "string" ? rawHint.trim() : "";
    if (!hint) {
      // Pass through, but never persist routing hints / re-derived keys.
      const settings = { ...f.settings };
      for (const k of SETTINGS_STRIP_KEYS) delete settings[k];
      // GH #1008 F3: CLONE `temperatures` — the `...f` spread below would share
      // the source object's reference, and the per-subfield deletes further down
      // must not corrupt the caller's parsed FilamentData.
      const collapsed: CollapsedFilamentData = {
        ...f,
        settings,
        temperatures: { ...f.temperatures },
      };
      // GH #950: leave-when-omitted. parseIni fills absent fields with defaults
      // (null / "#808080" / 1.75 / "Unknown"); $set-ing those over a name-matched
      // existing filament CLOBBERS its real values on a partial/hand-crafted
      // section. Drop each field the section didn't actually supply (same idiom
      // the hinted branch below uses). The normal export writes all of them, so
      // a full round-trip is unaffected.
      if (!("filament_cost" in f.settings)) delete collapsed.cost;
      if (!("filament_density" in f.settings)) delete collapsed.density;
      if (!("filament_diameter" in f.settings)) delete collapsed.diameter;
      if (!("filament_colour" in f.settings)) delete collapsed.color;
      if (!("filament_vendor" in f.settings)) delete collapsed.vendor;
      if (!("filament_type" in f.settings)) delete collapsed.type;
      if (!("filament_max_volumetric_speed" in f.settings)) delete collapsed.maxVolumetricSpeed;
      // GH #1008 F3: extend the same rule to the four temp SUBFIELDS and
      // `inherits`, which the #950 guard above skipped. parseIni ALWAYS
      // materialises `temperatures` as {nozzle: null, …} and `inherits: null`
      // when the keys are absent — riding those through gets dot-flattened by
      // the importer and `$set`s every stored temp (and inherits) to null on a
      // name-matched filament. Real PrusaSlicer user presets are
      // `inherits = <system preset>` + only the diverged keys, so the partial
      // section is the NORMAL shape, not an edge case. An EXPLICIT
      // `temperature = nil` / `inherits = nil` keeps its key present in
      // f.settings and still writes null through (a deliberate reset).
      const temps = collapsed.temperatures!;
      if (!("temperature" in f.settings)) delete temps.nozzle;
      if (!("first_layer_temperature" in f.settings)) delete temps.nozzleFirstLayer;
      if (!("bed_temperature" in f.settings)) delete temps.bed;
      if (!("first_layer_bed_temperature" in f.settings)) delete temps.bedFirstLayer;
      if (Object.keys(temps).length === 0) delete collapsed.temperatures;
      if (!("inherits" in f.settings)) delete collapsed.inherits;
      const rawFid = f.settings.filamentdb_id;
      const fid = typeof rawFid === "string" ? rawFid.trim() : "";
      if (fid) collapsed.filamentdbId = fid; // GH #950: id-first resolution hint
      out.push(collapsed);
      continue;
    }
    // Per-nozzle suffixed section → fold back into its base filament.
    const baseName = f.name.endsWith(` ${hint}`)
      ? f.name.slice(0, f.name.length - hint.length - 1).trim()
      : f.name;
    const rawId = f.settings.filamentdb_id;
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const groupKey = id ? `id:${id}` : `name:${baseName.toLowerCase()}`;
    if (seenGroups.has(groupKey)) continue; // a sibling already represents the base
    seenGroups.add(groupKey);
    const settings = { ...f.settings };
    for (const k of [...PER_NOZZLE_BAKED_SETTING_KEYS, ...SETTINGS_STRIP_KEYS]) {
      // GH #950: compatible_printers_condition is
      // normally "baked" (an auto-derived nozzle_diameter[...] value, different per
      // suffixed section) so it's stripped and re-derived on the next export. But
      // the 950.2 export now also carries a USER PIN (a non-derived restriction) or
      // the `nil` inheritance marker through the per-nozzle sections — and since the
      // importer $set-s the WHOLE settings bag, unconditionally stripping those
      // would DESTROY the pin on export→import (lossy). Strip ONLY the auto-derived
      // shape (contains `nozzle_diameter[`) or an empty "no restriction"; preserve a
      // user pin (any other non-empty string) and nil (null) so they round-trip.
      // (The single-nozzle / non-hinted branch never strips this key, so it already
      // round-trips there.)
      if (k === "compatible_printers_condition") {
        const v = settings[k];
        // Match ONLY the exact auto-derived shape — one or
        // more `nozzle_diameter[<n>]==<number>` terms joined by ` or ` (the
        // calibration bake emits a single term, the non-calibration derivation an
        // ` or `-joined set). A substring test would wrongly strip a legitimate
        // user pin that merely REFERENCES a nozzle diameter, e.g.
        // `printer_model==MK4 and nozzle_diameter[0]==0.4`.
        // GH #1040: each term may carry the HF discriminator tail the new bake
        // emits (` and nozzle_high_flow[0]` / ` and ! nozzle_high_flow[0]`,
        // spaced `! ` only — the machine shape). Without this, one sibling's
        // HF-tailed condition would be misread as a user pin, frozen into the
        // base filament's settings bag, and stamped on EVERY fan-out section by
        // the export gate — hiding the standard preset from standard printers,
        // worse than the bug it fixes.
        const isDerived = isAnyMachineDerivedNozzleCondition(v);
        const isEmpty = v === "" || v === undefined;
        if (isDerived || isEmpty) delete settings[k];
        // else: user pin (non-derived string) or nil (null) → keep for round-trip.
        continue;
      }
      delete settings[k];
    }
    // Drop temperatures + maxVolumetricSpeed (baked per-nozzle): omitting the keys
    // means the importer's $set never overwrites the base filament's shared values.
    const { temperatures, maxVolumetricSpeed, cost, density, diameter, color, vendor, type, ...sharedFields } = f;
    void temperatures;
    void maxVolumetricSpeed;
    const collapsed: CollapsedFilamentData = { ...sharedFields, name: baseName, settings };
    if (id) collapsed.filamentdbId = id; // GH #950: id-first resolution hint
    // GH #1008 F3: same `inherits` leave-when-omitted as the non-hinted branch —
    // a suffixed section without an `inherits` key must not `$set` null over the
    // base's stored value. (Temps / max-vol are already omitted wholesale above;
    // an explicit `inherits = nil` keeps the key and writes null through.)
    if (!("inherits" in f.settings)) delete collapsed.inherits;
    // Carry a shared field ONLY when the suffixed section actually SUPPLIED it (the
    // source INI key is present) — otherwise parseIni's defaults (null / "#808080" /
    // 1.75 / "Unknown") would $set over the base filament's real cost/density/color/
    // diameter/vendor/type on an update. The normal export bakes all of
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

/**
 * The baked per-nozzle `compatible_printers_condition` (GH #1040).
 *
 * `includeHfTerm` appends the high-flow discriminator, using the fork's
 * per-extruder `nozzle_high_flow` printer option — the exact construct
 * Prusa's own MK4S system profiles use (`... and nozzle_high_flow[0]` /
 * `... and ! nozzle_high_flow[0]`; note the SPACED `! `, matching those
 * field-tested profiles). It is emitted ONLY when the fan-out group carries
 * two same-diameter nozzles differing in highFlow — the one case diameter
 * alone cannot disambiguate. Unambiguous exports keep the plain diameter
 * condition so nothing that is visible today disappears (the GH #1021
 * lesson). On a slicer without `nozzle_high_flow` the expression fails
 * open — visible everywhere, i.e. today's behavior.
 */
export function perNozzleCondition(
  nz: { diameter: number; highFlow?: boolean | null },
  includeHfTerm: boolean,
): string {
  const base = `nozzle_diameter[0]==${nz.diameter}`;
  if (!includeHfTerm) return base;
  return nz.highFlow ? `${base} and nozzle_high_flow[0]` : `${base} and ! nozzle_high_flow[0]`;
}

/**
 * Matches every condition string the per-nozzle bake (either vintage) can
 * MACHINE-WRITE for a nozzle of `diameter`: the pre-#1040 plain shape and
 * both HF-tailed polarities. Byte-shape matching on purpose — a user pin
 * that merely REFERENCES these variables (`printer_model=="MK4" and
 * nozzle_diameter[0]==0.4`, or an unspaced `!nozzle_high_flow[0]` someone
 * typed by hand) does NOT match and is preserved.
 */
export function isMachineDerivedPerNozzleCondition(
  value: unknown,
  diameter: number,
): boolean {
  if (typeof value !== "string") return false;
  // A DB diameter is a plain number; escaping the dot is all a numeric
  // string can need, and avoids fragile character-class escapes here.
  const d = String(diameter).replace(/\./g, "\\.");
  return new RegExp(
    `^nozzle_diameter\\[0\\]==${d}(?: and (?:! )?nozzle_high_flow\\[0\\])?$`,
  ).test(value);
}

/**
 * Matches ANY condition string a Filament DB exporter (any vintage) can have
 * machine-written: one or more `nozzle_diameter[0]==D` terms joined by
 * ` or `, each optionally carrying the HF discriminator tail. The
 * single-nozzle predicate above anchors to ONE known diameter; this one is
 * the diameter-agnostic union used where the writing nozzle is unknown —
 * the bulk-import collapse and the export-time normalization in the bake.
 *
 * INDEX [0] ONLY (PR #1045): every exporter vintage has only ever
 * written extruder index 0 — the bake, the or-joined derivation, and the
 * #1021 legacy strip all say `[0]`. A user's multi-extruder pin such as
 * `nozzle_diameter[1]==0.4` is NOT a shape we ever emitted, and a `\d+`
 * index here classified it as machine-derived — overwriting a legitimate
 * pin with an index-0 bake.
 */
export function isAnyMachineDerivedNozzleCondition(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^nozzle_diameter\[0\]==\d+(?:\.\d+)?(?: and (?:! )?nozzle_high_flow\[0\])?(?: or nozzle_diameter\[0\]==\d+(?:\.\d+)?(?: and (?:! )?nozzle_high_flow\[0\])?)*$/.test(
      value,
    )
  );
}

export function filamentToSlicerKeys(
  filament: FilamentDoc,
  // #872: when present, BAKE this per-nozzle calibration's filament-level values
  // into the preset (for a multi-nozzle filament exported as N flat presets, since
  // PrusaSlicer has no parent/child for user presets). Pressure advance is
  // printer-scoped and stays dynamic via the /calibration endpoint — not baked.
  calibration?: FilamentDoc,
  // GH #1040: append the high-flow discriminator to the baked condition —
  // set by the fan-out when THIS nozzle's diameter appears in the group with
  // both highFlow states (see perNozzleCondition).
  includeHfTerm = false,
): Record<string, string | string[] | null> {
  // Start with the settings bag as the base — these are passthrough
  // PrusaSlicer keys preserved from a previous import
  const keys: Record<string, string | string[] | null> = { ...(filament.settings || {}) };

  // GH #1021: legacy machine-derived nozzle conditions
  // (`nozzle_diameter[0]==D [or ...]`, persisted into `settings` by pre-#1021
  // round-trips) are cleared ONCE by the `legacyNozzleConditions` startup
  // migration (src/lib/mongodb.ts), NOT here. Post-migration, any condition in
  // the bag is user-authored by construction — including a pure nozzle-only
  // one — so this export passes every non-empty value through untouched. An
  // export-time purge could not distinguish a user's pure nozzle pin from a
  // stale machine value; the one-shot migration resolves it by removing the
  // only source of machine-written values.

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

  // GH #950: filament_soluble / filament_abrasive live ONLY in the settings bag
  // (the schema has no such fields), and the `keys` seed above already carries
  // them from `filament.settings`. The old `set(..., filament.soluble)` read a
  // field that's always undefined — a dead no-op — so it's removed.

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
      // GH #950: gate the baked condition the same way the non-calibration
      // derivation below is — a round-tripped user pin (non-empty string) or the
      // `nil` inheritance marker (null) must win. Only set when the key is absent
      // or an empty-string "no restriction". `filamentdb_nozzle` stays
      // unconditional — it's a routing hint for THIS nozzle, not a user setting.
      // PR #1045: ALSO re-derive over a MACHINE-SHAPED bag value. The
      // pre-fix tick-less sync leak kept re-polluting the shared bag AFTER
      // the #1021 one-shot cleanup, so "post-cleanup pure nozzle condition =
      // user pin by construction" does not hold on real installs — a stale
      // `nozzle_diameter[0]==0.4` in the bag would win this gate and keep
      // the HF fix inert until the next lucky sync re-stripped it. Scoped to
      // the per-nozzle BAKE path (these sections are machine-generated); a
      // user pin byte-identical to a machine shape being re-derived here is
      // the same accepted residue as the existing #1021/#950 guards. Genuine
      // pins (compound conditions, unspaced `!`) never match and still win.
      if (
        !("compatible_printers_condition" in keys) ||
        keys.compatible_printers_condition === "" ||
        isAnyMachineDerivedNozzleCondition(keys.compatible_printers_condition)
      ) {
        keys.compatible_printers_condition = perNozzleCondition(nz, includeHfTerm);
      }
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
  // GH #1021 (reverts the #872 derivation): compatible_printers_condition is NO
  // LONGER derived from the filament's compatibleNozzles ticks. Ticking
  // "compatible nozzles" is bookkeeping metadata, but the derived
  // `nozzle_diameter[0]==D` condition made PrusaSlicer silently HIDE the preset
  // for any printer whose nozzle diameter wasn't ticked — and because variants
  // inherit the parent's compatibleNozzles (empty === inherit, GH #106), one
  // parent's ticks vanished whole filament groups from the slicer with no
  // visible cause. The nozzle-diameter condition remains ONLY where it is
  // structurally meaningful: the per-nozzle calibrated fan-out presets (the
  // calibration bake above), whose values are tuned for exactly one nozzle.
  // Round-tripped user pins (a non-empty string) and PrusaSlicer's `nil`
  // inheritance marker (null) still pass through untouched via the settings bag.
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
  keys: Record<string, string | string[] | null>,
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
    } else if (Array.isArray(value)) {
      // GH #678: a multi-valued bag entry (compatible_printers et al.) emits
      // PrusaSlicer's coStrings form. String(value) would comma-join —
      // which the slicer reads back as ONE value with commas in it.
      // A SINGLETON array collapses to the scalar
      // convention — the strict list grammar needs two elements, so an
      // emitted one-element list would re-import as a quoted wire scalar
      // and garble the next Orca export. Single-element array ≡ scalar is
      // the parser convention everywhere else.
      if (value.length === 0) {
        lines.push(`${key} = `);
      } else if (value.length === 1) {
        lines.push(`${key} = ${serializeIniValue(String(value[0]), key)}`);
      } else {
        lines.push(`${key} = ${serializeIniValueList(value)}`);
      }
    } else if (value !== undefined) {
      // GH #1070: a raw \r/\n inside a bag value would split the emitted
      // `key = value` line — PrusaSlicer rejects the whole bundle over one
      // in-section line without `=`, and a re-import parses the continuation
      // lines as INI (key/section injection). serializeIniValue transforms
      // ONLY such values into PrusaSlicer's quoted-escaped form; every
      // single-line value — including already-escaped fork-shaped
      // `"...\n..."` strings — passes through byte-identical.
      // The key scopes the legacy form-wrapper strip to the three keys the
      // pre-#1070 form actually wrote (see serializeIniValue).
      lines.push(`${key} = ${serializeIniValue(String(value), key)}`);
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
      //
      // GH #1040: when a diameter appears with BOTH highFlow states in the group,
      // diameter alone cannot disambiguate the two presets and each section's
      // condition additionally encodes its nozzle's HF flag. Diameters present in
      // only one state keep the plain condition (today's visibility).
      const hfStatesByDiameter = new Map<number, Set<boolean>>();
      for (const cal of byNozzle.values()) {
        const nz = cal.nozzle as { diameter: number; highFlow?: boolean | null };
        const states = hfStatesByDiameter.get(nz.diameter) ?? new Set<boolean>();
        states.add(!!nz.highFlow);
        hfStatesByDiameter.set(nz.diameter, states);
      }
      for (const cal of byNozzle.values()) {
        const nz = cal.nozzle as { diameter: number };
        const ambiguous = (hfStatesByDiameter.get(nz.diameter)?.size ?? 0) > 1;
        writeSection(
          lines,
          `${filament.name} ${nozzleSuffix(cal.nozzle)}`,
          filamentToSlicerKeys(filament, cal, ambiguous),
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
