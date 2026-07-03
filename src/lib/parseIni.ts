// Note: this type is specific to PrusaSlicer INI parsing and differs from
// the shared Filament types in src/types/filament.ts (which cover DB documents).
export interface FilamentData {
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: number | null;
  density: number | null;
  diameter: number;
  temperatures: {
    nozzle: number | null;
    nozzleFirstLayer: number | null;
    bed: number | null;
    bedFirstLayer: number | null;
  };
  maxVolumetricSpeed: number | null;
  inherits: string | null;
  // GH #951 (Codex): spool weight + shrinkage are lifted to top-level (like
  // cost/density) so their settings-bag shadow can be stripped without data
  // loss. OPTIONAL and set ONLY when the source INI key is present — an omitted
  // key must not become `$set: null` and clobber an existing value on a root
  // (the "carry only when supplied" idiom the per-nozzle collapse also uses).
  spoolWeight?: number | null;
  shrinkageXY?: number | null;
  shrinkageZ?: number | null;
  settings: Record<string, string | null>;
}

/**
 * GH #951 (Codex): the INI keys that `flushFilament` below lifts into a
 * TOP-LEVEL `FilamentData` field (rather than leaving only in the `settings`
 * passthrough bag). The bulk INI importers strip these from the stored
 * `settings` bag so a variant that inherits one of them doesn't keep a stale
 * shadow copy that leaks back into exports (`filamentToSlicerKeys` seeds `keys`
 * from `settings`, so a shadow survives when the resolved top-level value is
 * null). Every key here round-trips via its top-level field, so stripping loses
 * nothing. Keep this in lockstep with the `currentSettings.*` reads in
 * `flushFilament` — `tests/parseIni.test.ts` pins that invariant.
 */
export const INI_TOP_LEVEL_SETTING_KEYS = [
  "filament_vendor",
  "filament_type",
  "filament_colour",
  "filament_cost",
  "filament_density",
  "filament_diameter",
  "filament_max_volumetric_speed",
  "temperature",
  "first_layer_temperature",
  "bed_temperature",
  "first_layer_bed_temperature",
  "inherits",
  "filament_spool_weight",
  "filament_shrinkage_compensation_xy",
  "filament_shrinkage_compensation_z",
] as const;

export function parseIniFilaments(content: string): FilamentData[] {
  const filaments: FilamentData[] = [];
  const lines = content.split("\n");

  let currentName: string | null = null;
  let currentSettings: Record<string, string | null> = {};

  function flushFilament() {
    if (currentName && Object.keys(currentSettings).length > 0) {
      const parseNum = (val: string | null | undefined): number | null => {
        if (!val || val === "nil" || val === "") return null;
        const cleaned = val.replace("%", "");
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
      };

      const nilOrVal = (val: string | null | undefined): string | null => {
        if (!val || val === "nil") return null;
        return val;
      };

      const fd: FilamentData = {
        name: currentName!,
        vendor: currentSettings.filament_vendor || "Unknown",
        type: currentSettings.filament_type || "Unknown",
        color: currentSettings.filament_colour || "#808080",
        cost: parseNum(currentSettings.filament_cost),
        density: parseNum(currentSettings.filament_density),
        diameter: parseNum(currentSettings.filament_diameter) ?? 1.75,
        temperatures: {
          nozzle: parseNum(currentSettings.temperature),
          nozzleFirstLayer: parseNum(currentSettings.first_layer_temperature),
          bed: parseNum(currentSettings.bed_temperature),
          bedFirstLayer: parseNum(currentSettings.first_layer_bed_temperature),
        },
        maxVolumetricSpeed: parseNum(currentSettings.filament_max_volumetric_speed),
        inherits: nilOrVal(currentSettings.inherits),
        settings: { ...currentSettings },
      };
      // GH #951 (Codex): lift spool weight + shrinkage to top-level ONLY when the
      // source key is present, so an INI that omits them leaves the field
      // `undefined` (→ omitted from the importer's `$set`) rather than nulling a
      // value already on the row. See the FilamentData comment above.
      if ("filament_spool_weight" in currentSettings) {
        fd.spoolWeight = parseNum(currentSettings.filament_spool_weight);
      }
      if ("filament_shrinkage_compensation_xy" in currentSettings) {
        fd.shrinkageXY = parseNum(currentSettings.filament_shrinkage_compensation_xy);
      }
      if ("filament_shrinkage_compensation_z" in currentSettings) {
        fd.shrinkageZ = parseNum(currentSettings.filament_shrinkage_compensation_z);
      }
      filaments.push(fd);
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      flushFilament();

      const sectionName = sectionMatch[1];
      if (sectionName.startsWith("filament:")) {
        const parsedName = sectionName.substring("filament:".length).trim();
        if (!parsedName) {
          currentName = null;
          currentSettings = {};
          continue;
        }
        currentName = parsedName;
        currentSettings = {};
      } else {
        currentName = null;
        currentSettings = {};
      }
      continue;
    }

    if (currentName) {
      // GH #955: skip comment lines (`#` and `;` are both INI/PrusaSlicer
      // comment markers) and blanks — an in-section comment that happens to
      // contain `=` would otherwise become a junk settings key. Real preset
      // keys are `[a-z0-9_]` identifiers that never start with `#`/`;`.
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        let value: string | null = trimmed.substring(eqIndex + 1).trim();
        if (value === "nil") value = null;
        currentSettings[key] = value;
      }
    }
  }

  flushFilament();
  return filaments;
}
