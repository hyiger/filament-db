import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { generateOrcaSlicerProfiles } from "@/lib/orcaSlicerBundle";

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
      query._id = { $in: idsFilter.split(",").map((id) => id.trim()) };
    }

    const filaments = await Filament.find(query)
      .sort({ name: 1 })
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
