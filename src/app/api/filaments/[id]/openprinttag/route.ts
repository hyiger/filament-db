import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import { generateOpenPrintTagBinary } from "@/lib/openprinttag";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await dbConnect();
  const { id } = await params;

  const filament = await Filament.findById(id).lean();
  if (!filament) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const binary = generateOpenPrintTagBinary({
    materialName: filament.name,
    brandName: filament.vendor,
    materialType: filament.type,
    color: filament.color,
    density: filament.density,
    diameter: filament.diameter,
    nozzleTemp: filament.temperatures?.nozzle,
    nozzleTempFirstLayer: filament.temperatures?.nozzleFirstLayer,
    bedTemp: filament.temperatures?.bed,
    bedTempFirstLayer: filament.temperatures?.bedFirstLayer,
    chamberTemp:
      filament.settings?.chamber_temperature != null
        ? Number(filament.settings.chamber_temperature)
        : null,
  });

  const safeName = filament.name
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
