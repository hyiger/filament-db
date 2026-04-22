import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

/**
 * Top-level body keys that map to structured Filament DB fields.
 * Any other keys are merged into the settings bag for passthrough on
 * next export (so OrcaSlicer-specific settings round-trip cleanly).
 */
const STRUCTURED_KEYS = new Set([
  "type",
  "vendor",
  "color",
  "density",
  "cost",
  "diameter",
  "maxVolumetricSpeed",
  "temperatures",
]);

/**
 * POST /api/filaments/{id}/orcaslicer
 *
 * Sync filament settings back from OrcaSlicer. Accepts a JSON body with
 * OrcaSlicer config keys and maps them back to Filament DB structured fields.
 *
 * The filament is looked up by name (URL-encoded) or ObjectId.
 * Structured fields are updated on the model; any other top-level keys are
 * stored in the `settings` bag for passthrough on next export.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Guard JSON parsing — malformed bodies should return 400, not 500
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 }
    );
  }

  try {
    await dbConnect();
    const { id } = await params;

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
    if (body.temperatures && typeof body.temperatures === "object") {
      const src = body.temperatures as Record<string, unknown>;
      const temps: Record<string, unknown> = {};
      if (src.nozzle != null) temps.nozzle = src.nozzle;
      if (src.nozzleFirstLayer != null) temps.nozzleFirstLayer = src.nozzleFirstLayer;
      if (src.bed != null) temps.bed = src.bed;
      if (src.bedFirstLayer != null) temps.bedFirstLayer = src.bedFirstLayer;
      if (src.nozzleRangeMin != null) temps.nozzleRangeMin = src.nozzleRangeMin;
      if (src.nozzleRangeMax != null) temps.nozzleRangeMax = src.nozzleRangeMax;
      if (Object.keys(temps).length > 0) {
        update.temperatures = { ...filament.temperatures, ...temps };
      }
    }

    // Merge any unknown top-level keys into the settings passthrough bag
    const settings = (filament.settings as Record<string, unknown>) || {};
    const settingsAdded: string[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!STRUCTURED_KEYS.has(key)) {
        settings[key] = value as string | string[] | null;
        settingsAdded.push(key);
      }
    }
    if (settingsAdded.length > 0) {
      update.settings = settings;
    }

    await Filament.updateOne({ _id: filament._id }, { $set: update });

    return NextResponse.json({
      success: true,
      filament: filament.name,
      updated: Object.keys(update),
      settingsAdded,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to sync from OrcaSlicer", detail: message },
      { status: 500 }
    );
  }
}
