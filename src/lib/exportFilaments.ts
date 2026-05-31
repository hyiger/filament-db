import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { resolveFilament } from "@/lib/resolveFilament";

export interface ExportRow {
  name: string;
  vendor: string;
  type: string;
  color: string | null;
  /** GH #477: comma-separated multi-color hexes (e.g.
   *  "#FF0000,#00FF00,#0000FF"). Empty string when the filament has
   *  no secondary colors. CSV-friendly representation — round-trips
   *  through the importer's split-on-comma rule. */
  secondaryColors: string;
  diameter: number;
  cost: number | null;
  density: number | null;
  nozzleTemp: number | null;
  nozzleFirstLayerTemp: number | null;
  bedTemp: number | null;
  bedFirstLayerTemp: number | null;
  maxVolumetricSpeed: number | null;
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  spoolCount: number;
  dryingTemperature: number | null;
  dryingTime: number | null;
  transmissionDistance: number | null;
  glassTempTransition: number | null;
  heatDeflectionTemp: number | null;
  shoreHardnessA: number | null;
  shoreHardnessD: number | null;
  minPrintSpeed: number | null;
  maxPrintSpeed: number | null;
  colorName: string | null;
  spoolType: string | null;
  nozzleRangeMin: number | null;
  nozzleRangeMax: number | null;
  standbyTemp: number | null;
  tdsUrl: string | null;
  instanceId: string;
  /**
   * Parent/variant relationship surfaced for round-trip clarity (Codex /
   * user feedback on the v1.30 export): `parentName` is the name of the
   * parent filament when this row is a variant (empty for roots/parents),
   * and `variantCount` is how many variants this row has (>0 only for
   * parents). The export already inherits-flattens variant values via
   * resolveFilament, so without these two columns the relationship is
   * invisible in CSV/XLSX even though the app uses it heavily.
   *
   * Slicer-bound exports (PrusaSlicer / OrcaSlicer / Bambu) intentionally
   * don't include these — slicers have no concept of variants and need
   * every row to stand alone.
   */
  parentName: string | null;
  variantCount: number;
}

export const EXPORT_COLUMNS: { key: keyof ExportRow; header: string }[] = [
  { key: "name", header: "Name" },
  { key: "vendor", header: "Vendor" },
  { key: "type", header: "Type" },
  { key: "color", header: "Color" },
  // GH #477: multi-color hexes joined with commas. Round-trips through
  // the importer's split-on-comma + per-entry hex validation.
  { key: "secondaryColors", header: "Secondary Colors" },
  { key: "diameter", header: "Diameter (mm)" },
  { key: "cost", header: "Cost" },
  { key: "density", header: "Density (g/cm³)" },
  { key: "nozzleTemp", header: "Nozzle Temp (°C)" },
  { key: "nozzleFirstLayerTemp", header: "Nozzle First Layer (°C)" },
  { key: "bedTemp", header: "Bed Temp (°C)" },
  { key: "bedFirstLayerTemp", header: "Bed First Layer (°C)" },
  { key: "maxVolumetricSpeed", header: "Max Vol. Speed (mm³/s)" },
  { key: "spoolWeight", header: "Spool Weight (g)" },
  { key: "netFilamentWeight", header: "Net Filament Weight (g)" },
  { key: "spoolCount", header: "Spools" },
  { key: "dryingTemperature", header: "Drying Temp (°C)" },
  { key: "dryingTime", header: "Drying Time (min)" },
  { key: "transmissionDistance", header: "HueForge TD" },
  { key: "glassTempTransition", header: "Glass Transition Tg (°C)" },
  { key: "heatDeflectionTemp", header: "Heat Deflection HDT (°C)" },
  { key: "shoreHardnessA", header: "Shore A" },
  { key: "shoreHardnessD", header: "Shore D" },
  { key: "minPrintSpeed", header: "Min Print Speed (mm/s)" },
  { key: "maxPrintSpeed", header: "Max Print Speed (mm/s)" },
  { key: "colorName", header: "Color Name" },
  { key: "spoolType", header: "Spool Type" },
  { key: "nozzleRangeMin", header: "Nozzle Range Min (°C)" },
  { key: "nozzleRangeMax", header: "Nozzle Range Max (°C)" },
  { key: "standbyTemp", header: "Standby Temp (°C)" },
  { key: "tdsUrl", header: "TDS URL" },
  { key: "instanceId", header: "Instance ID" },
  // Parent/variant relationship — empty for roots, populated for variants
  // (Parent) and parents (Variant Count). Placed at the end so existing
  // consumers that read columns by header index keep working.
  { key: "parentName", header: "Parent" },
  { key: "variantCount", header: "Variant Count" },
];

export async function getExportRows(): Promise<ExportRow[]> {
  await dbConnect();

  const filaments = await Filament.find({ _deletedAt: null })
    .sort({ name: 1 })
    .lean();

  // Build parent lookup for variant resolution
  const parentMap = new Map<string, (typeof filaments)[number]>();
  for (const f of filaments) {
    if (!f.parentId) {
      parentMap.set(f._id.toString(), f);
    }
  }

  // Count variants per parent for the Variant Count column. A separate map
  // because parentMap above only indexes roots/parents; we need to count
  // how many filaments reference each id as their parentId.
  const variantCountByParent = new Map<string, number>();
  for (const f of filaments) {
    if (f.parentId) {
      const key = f.parentId.toString();
      variantCountByParent.set(key, (variantCountByParent.get(key) ?? 0) + 1);
    }
  }

  return filaments.map((filament) => {
    const parentDoc = filament.parentId
      ? parentMap.get(filament.parentId.toString())
      : undefined;
    const resolved = filament.parentId
      ? resolveFilament(filament, parentDoc)
      : filament;

    return {
      name: resolved.name,
      vendor: resolved.vendor,
      type: resolved.type,
      color: resolved.color,
      secondaryColors: (resolved.secondaryColors ?? []).join(","),
      diameter: resolved.diameter,
      cost: resolved.cost ?? null,
      density: resolved.density ?? null,
      nozzleTemp: resolved.temperatures?.nozzle ?? null,
      nozzleFirstLayerTemp: resolved.temperatures?.nozzleFirstLayer ?? null,
      bedTemp: resolved.temperatures?.bed ?? null,
      bedFirstLayerTemp: resolved.temperatures?.bedFirstLayer ?? null,
      maxVolumetricSpeed: resolved.maxVolumetricSpeed ?? null,
      spoolWeight: resolved.spoolWeight ?? null,
      netFilamentWeight: resolved.netFilamentWeight ?? null,
      spoolCount: resolved.spools?.length || (resolved.totalWeight != null ? 1 : 0),
      dryingTemperature: resolved.dryingTemperature ?? null,
      dryingTime: resolved.dryingTime ?? null,
      transmissionDistance: resolved.transmissionDistance ?? null,
      glassTempTransition: resolved.glassTempTransition ?? null,
      heatDeflectionTemp: resolved.heatDeflectionTemp ?? null,
      shoreHardnessA: resolved.shoreHardnessA ?? null,
      shoreHardnessD: resolved.shoreHardnessD ?? null,
      minPrintSpeed: resolved.minPrintSpeed ?? null,
      maxPrintSpeed: resolved.maxPrintSpeed ?? null,
      colorName: resolved.colorName ?? null,
      spoolType: resolved.spoolType ?? null,
      nozzleRangeMin: resolved.temperatures?.nozzleRangeMin ?? null,
      nozzleRangeMax: resolved.temperatures?.nozzleRangeMax ?? null,
      standbyTemp: resolved.temperatures?.standby ?? null,
      tdsUrl: resolved.tdsUrl ?? null,
      instanceId: filament.instanceId ?? "",
      // Read parentName from the source `filament` (not `resolved`) because
      // resolveFilament doesn't mutate name fields. The variant count
      // applies to whatever this row's _id is — variants always 0, roots
      // are 0 unless they have variants pointing at them.
      parentName: parentDoc?.name ?? null,
      variantCount: variantCountByParent.get(filament._id.toString()) ?? 0,
    };
  });
}
