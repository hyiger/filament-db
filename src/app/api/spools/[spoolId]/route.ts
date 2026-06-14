import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { resolveFilament } from "@/lib/resolveFilament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * GET /api/spools/{spoolId}
 *
 * Resolve a single spool by its subdocument id to the filament that owns it
 * plus the spool itself. Powers the mobile scanner's spool-level deep links
 * (the label QR's `?spool=<spoolId>` link, GH #595): the phone scans the QR,
 * resolves the spool here, and opens the filament detail with that spool
 * highlighted — without having to know the parent filament id up front.
 *
 * The filament is inheritance-resolved (variants get their parent's values)
 * so the response is a complete view, mirroring `GET /api/filaments/{id}`.
 * Read-only, so no trusted-origin guard (matches the other GET routes).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ spoolId: string }> },
) {
  try {
    await dbConnect();
    const { spoolId } = await params;

    if (!mongoose.isValidObjectId(spoolId)) {
      return errorResponse("Invalid spool id", 400);
    }

    const filament = await Filament.findOne({
      "spools._id": spoolId,
      _deletedAt: null,
    }).lean();
    if (!filament) {
      return errorResponse("Spool not found", 404);
    }

    // The matched spool subdocument (the query guarantees one exists).
    const spool = (filament.spools ?? []).find(
      (s) => String(s._id) === String(spoolId),
    );
    if (!spool) {
      return errorResponse("Spool not found", 404);
    }

    // Resolve inheritance for variants so the caller gets a complete view.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolved: any = filament;
    if (filament.parentId) {
      const parent = await Filament.findOne({
        _id: filament.parentId,
        _deletedAt: null,
      }).lean();
      resolved = resolveFilament(filament, parent);
    }

    return NextResponse.json({ filament: resolved, spool });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to resolve spool");
  }
}
