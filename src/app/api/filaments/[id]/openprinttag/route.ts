import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import { generateOpenPrintTagBinary } from "@/lib/openprinttag";
import { resolveFilament } from "@/lib/resolveFilament";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await dbConnect();
  const { id } = await params;

  const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
  if (!filament) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Resolve inherited values if this is a variant
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolved: any = filament;
  if (filament.parentId) {
    const parent = await Filament.findOne({ _id: filament.parentId, _deletedAt: null }).lean();
    resolved = resolveFilament(filament, parent);
  }

  // Compute actual remaining weight from scale reading if available
  let actualWeightGrams: number | null = null;
  if (resolved.totalWeight != null && resolved.spoolWeight != null) {
    actualWeightGrams = Math.max(0, resolved.totalWeight - resolved.spoolWeight);
  }

  const binary = generateOpenPrintTagBinary({
    materialName: resolved.name,
    brandName: resolved.vendor,
    materialType: resolved.type,
    color: resolved.color,
    density: resolved.density,
    diameter: resolved.diameter,
    nozzleTemp: resolved.temperatures?.nozzle,
    nozzleTempFirstLayer: resolved.temperatures?.nozzleFirstLayer,
    bedTemp: resolved.temperatures?.bed,
    bedTempFirstLayer: resolved.temperatures?.bedFirstLayer,
    chamberTemp:
      resolved.settings?.chamber_temperature != null
        ? Number(resolved.settings.chamber_temperature)
        : null,
    weightGrams: resolved.netFilamentWeight ?? null,
    actualWeightGrams,
    emptySpoolWeight: resolved.spoolWeight ?? null,
    spoolUid: filament.instanceId ?? null,
    dryingTemperature: resolved.dryingTemperature ?? null,
    dryingTime: resolved.dryingTime ?? null,
    transmissionDistance: resolved.transmissionDistance ?? null,
    abrasive: resolved.settings?.filament_abrasive === "1",
    soluble: resolved.settings?.filament_soluble === "1",
    shoreHardnessA: resolved.shoreHardnessA ?? null,
    shoreHardnessD: resolved.shoreHardnessD ?? null,
    optTags: resolved.optTags ?? [],
  });

  const safeName = resolved.name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_");

  return new NextResponse(Buffer.from(binary) as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="openprinttag_${safeName}.bin"`,
      "Content-Length": String(binary.byteLength),
    },
  });
}
