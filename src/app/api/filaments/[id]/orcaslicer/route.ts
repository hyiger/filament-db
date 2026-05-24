import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { generateOrcaSlicerProfiles } from "@/lib/orcaSlicerBundle";
import {
  resolveFilamentForExport,
  exportFilenameStem,
} from "@/lib/singleFilamentExport";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { mergeSlicerSettings } from "@/lib/slicerSettings";

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
 * GET /api/filaments/{id}/orcaslicer
 *
 * Download a single filament as an OrcaSlicer filament-preset (`.json`).
 *
 * Distinct from the bundle route `GET /api/filaments/orcaslicer`, which
 * returns a JSON *array* consumed by the OrcaSlicer FilamentDB module.
 * This route returns one preset object with a download header so the
 * detail-page "Export" button produces a file ready for OrcaSlicer's
 * filament-preset import. Variants are resolved against their parent.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;

    const filament = await resolveFilamentForExport(id);
    if (!filament) {
      return errorResponse("Filament not found", 404);
    }

    // generateOrcaSlicerProfiles works on an array — take the single
    // profile object, not the [obj] wrapper, so the file imports as one
    // preset rather than a list.
    const profile = generateOrcaSlicerProfiles([filament])[0];
    const stem = exportFilenameStem(filament.name);

    return new NextResponse(JSON.stringify(profile, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stem}.json"`,
      },
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to export filament for OrcaSlicer");
  }
}

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
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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

    // Merge any unknown top-level keys into the settings passthrough bag.
    // GH #266: bounded merge — caps key count and per-value size so a
    // sync write can't bloat the embedded `settings` field unboundedly.
    const merge = mergeSlicerSettings(
      (filament.settings as Record<string, unknown>) || {},
      body,
      STRUCTURED_KEYS,
    );
    if (merge.error) {
      return errorResponse(merge.error, 400);
    }
    const settingsAdded = merge.added;
    if (settingsAdded.length > 0) {
      update.settings = merge.settings;
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
