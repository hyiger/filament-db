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
 *
 * GH #182 / Codex P2 on PR #190: variants commonly store
 * `spoolWeight: null` and inherit from their parent. Resolve the inherited
 * value here so the compare page's "On hand" math (which subtracts
 * spoolWeight from each spool's totalWeight) doesn't fall through to 0
 * for inherited cases. A future broader-resolution change (#184) will
 * resolve every inheritable field; this PR scopes the fix to the field
 * the on-hand math needs.
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

    // Resolve inherited spoolWeight for any variant whose own field is null.
    // One batched fetch covers every parent in the result set.
    const parentIds = Array.from(
      new Set(
        filaments
          .filter((f) => f.parentId && (f.spoolWeight === null || f.spoolWeight === undefined))
          .map((f) => String(f.parentId)),
      ),
    );
    const parentSpoolWeights = parentIds.length
      ? new Map(
          (
            await Filament.find({ _id: { $in: parentIds } })
              .select("spoolWeight")
              .lean()
          ).map((p) => [String(p._id), p.spoolWeight ?? null]),
        )
      : new Map<string, number | null>();

    const resolved = filaments.map((f) => {
      if (f.spoolWeight !== null && f.spoolWeight !== undefined) return f;
      if (!f.parentId) return f;
      const inherited = parentSpoolWeights.get(String(f.parentId));
      return inherited != null ? { ...f, spoolWeight: inherited } : f;
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
