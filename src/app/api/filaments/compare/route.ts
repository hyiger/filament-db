import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/filaments/compare?ids=a,b,c — fetch multiple filaments for the
 * comparison view in one round trip.
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

    // Return in the same order the caller requested so the UI's columns
    // match the incoming list.
    const byId = new Map(filaments.map((f) => [String(f._id), f]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

    return NextResponse.json(ordered);
  } catch (err) {
    return errorResponse("Failed to fetch filaments for comparison", 500, getErrorMessage(err));
  }
}
