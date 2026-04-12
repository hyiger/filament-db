import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

/**
 * POST /api/filaments/{id}/orcaslicer
 *
 * Sync filament settings back from OrcaSlicer. Accepts a JSON body with
 * OrcaSlicer config keys and maps them back to Filament DB structured fields.
 *
 * The filament is looked up by name (URL-encoded) or ObjectId.
 * Only structured fields are updated; unknown keys are stored in the
 * settings bag for passthrough on next export.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const body = await request.json();

    // Find filament by name or ObjectId
    const decodedName = decodeURIComponent(id);
    let filament = await Filament.findOne({ name: decodedName, _deletedAt: null });
    if (!filament && /^[a-f0-9]{24}$/i.test(id)) {
      filament = await Filament.findOne({ _id: id, _deletedAt: null });
    }

    if (!filament) {
      return NextResponse.json(
        { error: `Filament not found: ${decodedName}` },
        { status: 404 }
      );
    }

    // Map OrcaSlicer keys back to DB fields
    const update: Record<string, unknown> = {};

    if (body.type != null) update.type = body.type;
    if (body.vendor != null) update.vendor = body.vendor;
    if (body.color != null) update.color = body.color;
    if (body.density != null) update.density = body.density;
    if (body.cost != null) update.cost = body.cost;
    if (body.diameter != null) update.diameter = body.diameter;
    if (body.maxVolumetricSpeed != null) update.maxVolumetricSpeed = body.maxVolumetricSpeed;

    // Temperatures
    if (body.temperatures) {
      const temps: Record<string, number | null> = {};
      if (body.temperatures.nozzle != null) temps.nozzle = body.temperatures.nozzle;
      if (body.temperatures.nozzleFirstLayer != null) temps.nozzleFirstLayer = body.temperatures.nozzleFirstLayer;
      if (body.temperatures.bed != null) temps.bed = body.temperatures.bed;
      if (body.temperatures.bedFirstLayer != null) temps.bedFirstLayer = body.temperatures.bedFirstLayer;
      if (body.temperatures.nozzleRangeMin != null) temps.nozzleRangeMin = body.temperatures.nozzleRangeMin;
      if (body.temperatures.nozzleRangeMax != null) temps.nozzleRangeMax = body.temperatures.nozzleRangeMax;
      if (Object.keys(temps).length > 0) {
        update.temperatures = { ...filament.temperatures, ...temps };
      }
    }

    await Filament.updateOne({ _id: filament._id }, { $set: update });

    return NextResponse.json({
      success: true,
      filament: filament.name,
      updated: Object.keys(update),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to sync from OrcaSlicer", detail: message },
      { status: 500 }
    );
  }
}
