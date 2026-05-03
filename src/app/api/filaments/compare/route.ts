import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { IFilament } from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/filaments/compare?ids=a,b,c — fetch multiple filaments for the
 * comparison view in one round trip.
 *
 * Variants are resolved against their parent so columns like cost, density,
 * temperatures, drying-time, and spoolWeight (the on-hand math reads it)
 * render the inherited values when the variant left those fields blank —
 * matching the detail page, list, and exports. Pre-fix Compare returned
 * the raw documents and showed `—` for any inheritable field the variant
 * didn't override (GH #184) and miscalculated the "On hand" row for
 * inherited spoolWeight (Codex P2 on PR #190). The single resolveFilament
 * pass handles both.
 *
 * Returns populated calibration refs so the UI can render printer/nozzle/
 * bedType names directly.
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();
    const idsParam = request.nextUrl.searchParams.get("ids");
    if (!idsParam) {
      return errorResponse("ids query parameter is required", 400);
    }
    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return errorResponse("ids must contain at least one filament id", 400);
    }
    if (ids.length > 8) {
      return errorResponse("Comparing more than 8 filaments at once is not supported", 400);
    }

    const filaments = await Filament.find({ _id: { $in: ids }, _deletedAt: null })
      .populate("compatibleNozzles")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .lean();

    // Fetch parents for any variant in the result so resolveFilament can
    // merge inherited fields (cost, density, temperatures, drying info,
    // spoolWeight, etc.). One batched query for all parent ids; the
    // common case (no variants) hits zero extra queries.
    const parentIds = Array.from(
      new Set(
        filaments
          .map((f) => f.parentId && String(f.parentId))
          .filter((id): id is string => !!id),
      ),
    );
    const parents = parentIds.length
      ? ((await Filament.find({ _id: { $in: parentIds }, _deletedAt: null })
          .populate("compatibleNozzles")
          .populate("calibrations.nozzle")
          .populate("calibrations.printer")
          .populate("calibrations.bedType")
          .lean()) as IFilament[])
      : [];
    const parentById = new Map(parents.map((p) => [String(p._id), p]));

    const resolved = filaments.map((f) => {
      if (!f.parentId) return f;
      const parent = parentById.get(String(f.parentId));
      return parent ? resolveFilament(f, parent) : f;
    });

    // Return in the same order the caller requested so the UI's columns
    // match the incoming list.
    const byId = new Map(resolved.map((f) => [String(f._id), f]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

    return NextResponse.json(ordered);
  } catch (err) {
    return errorResponse("Failed to fetch filaments for comparison", 500, getErrorMessage(err));
  }
}
