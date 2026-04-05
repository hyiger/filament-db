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
  settings: Record<string, string | null>;
}

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

      filaments.push({
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
      });
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      flushFilament();

      const sectionName = sectionMatch[1];
      if (sectionName.startsWith("filament:")) {
        currentName = sectionName.substring("filament:".length);
        currentSettings = {};
      } else {
        currentName = null;
        currentSettings = {};
      }
      continue;
    }

    if (currentName) {
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
