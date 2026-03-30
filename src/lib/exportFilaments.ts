import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { resolveFilament } from "@/lib/resolveFilament";

export interface ExportRow {
  name: string;
  vendor: string;
  type: string;
  color: string;
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
  tdsUrl: string | null;
  instanceId: string;
}

export const EXPORT_COLUMNS: { key: keyof ExportRow; header: string }[] = [
  { key: "name", header: "Name" },
  { key: "vendor", header: "Vendor" },
  { key: "type", header: "Type" },
  { key: "color", header: "Color" },
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
  { key: "tdsUrl", header: "TDS URL" },
  { key: "instanceId", header: "Instance ID" },
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

  return filaments.map((filament) => {
    const resolved = filament.parentId
      ? resolveFilament(filament, parentMap.get(filament.parentId.toString()))
      : filament;

    return {
      name: resolved.name,
      vendor: resolved.vendor,
      type: resolved.type,
      color: resolved.color,
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
      tdsUrl: resolved.tdsUrl ?? null,
      instanceId: filament.instanceId ?? "",
    };
  });
}
