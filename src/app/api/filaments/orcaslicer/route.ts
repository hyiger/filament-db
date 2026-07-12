import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { generateOrcaSlicerProfiles } from "@/lib/orcaSlicerBundle";
import { errorResponse } from "@/lib/apiErrorHandler";

/** 24-hex ObjectId, for validating user-supplied `?ids=` before a `$in`. */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * GET /api/filaments/orcaslicer
 *
 * Export filaments as OrcaSlicer-compatible JSON profiles.
 * All structured Filament DB fields are mapped to their OrcaSlicer
 * equivalents (nozzle_temperature, hot_plate_temp, filament_flow_ratio, etc.)
 * with values wrapped in arrays per OrcaSlicer multi-extruder convention.
 *
 * Query params:
 *   type   — filter by filament type (e.g. PLA, PETG)
 *   vendor — filter by vendor name
 *   ids    — comma-separated list of filament IDs
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const { searchParams } = request.nextUrl;
    const typeFilter = searchParams.get("type");
    const vendorFilter = searchParams.get("vendor");
    const idsFilter = searchParams.get("ids");

    // Build query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = { _deletedAt: null };
    if (typeFilter) query.type = typeFilter;
    if (vendorFilter) query.vendor = vendorFilter;
    if (idsFilter) {
      // Validate each id is a real ObjectId before the $in — an invalid value
      // would otherwise throw a Mongoose CastError and 500 (#677).
      const ids = idsFilter.split(",").map((id) => id.trim()).filter(Boolean);
      const bad = ids.filter((id) => !OBJECT_ID_RE.test(id));
      if (bad.length > 0) {
        return errorResponse(`Invalid filament ID(s): ${bad.join(", ")}`, 400);
      }
      query._id = { $in: ids };
    }

    const filaments = await Filament.find(query)
      .sort({ name: 1 })
      // GH #1005 F2: the OrcaSlicer bundle mapping never reads spools; exclude
      // the whole array (photoDataUrl blobs + usageHistory ledgers) so a
      // slicer startup doesn't deserialize hundreds of MB to emit the JSON.
      .select("-spools")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .lean();

    // Build parent lookup for resolving variants
    const parentMap = new Map<string, (typeof filaments)[number]>();
    for (const f of filaments) {
      if (!f.parentId) {
        parentMap.set(f._id.toString(), f);
      }
    }

    // If a variant's parent isn't in the filtered results, batch-fetch missing parents
    const missingParentIds = [
      ...new Set(
        filaments
          .filter((f) => f.parentId && !parentMap.has(f.parentId.toString()))
          .map((f) => f.parentId!.toString()),
      ),
    ];
    if (missingParentIds.length > 0) {
      const missingParents = await Filament.find({
        _id: { $in: missingParentIds },
        _deletedAt: null,
      })
        .select("-spools") // GH #1005 F2: bundle generation never reads spools
        .populate("calibrations.nozzle")
        .populate("calibrations.printer")
        .populate("calibrations.bedType")
        .lean();
      for (const parent of missingParents) {
        parentMap.set(parent._id.toString(), parent);
      }
    }

    // Resolve variants
    const resolved = filaments.map((f) =>
      f.parentId
        ? resolveFilament(f, parentMap.get(f.parentId.toString()))
        : f,
    );

    const profiles = generateOrcaSlicerProfiles(resolved);

    return NextResponse.json(profiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to export OrcaSlicer profiles", detail: message },
      { status: 500 },
    );
  }
}

/**
 * GH #341: bulk OrcaSlicer bundle IMPORT is not yet implemented (the
 * corresponding PrusaSlicer route supports POST). OrcaSlicer profiles
 * are JSON, not INI, and the orcaSlicerBundle lib only exposes
 * serialisers; a parser + per-key mapper would be a follow-up.
 *
 * Returning an explicit 501 with a clear message — instead of letting
 * Next.js auto-respond with 405 — documents the gap and points callers
 * at the per-preset POST that DOES exist
 * (`POST /api/filaments/{id}/orcaslicer`).
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Bulk OrcaSlicer bundle import is not yet supported. Use POST /api/filaments/{id}/orcaslicer to sync an individual preset back, or import a PrusaSlicer INI bundle (POST /api/filaments/prusaslicer) which IS supported.",
    },
    { status: 501 },
  );
}
