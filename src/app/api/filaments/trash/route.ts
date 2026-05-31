import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/filaments/trash — list soft-deleted filaments.
 *
 * Returns a lightweight projection sorted by deletion time (newest first).
 * The full document is still in the collection, just hidden from the regular
 * list endpoint by the `_deletedAt: null` filter. Restore via
 * POST /api/filaments/{id}/restore; permanent delete via
 * DELETE /api/filaments/{id}?permanent=true.
 */
export async function GET() {
  try {
    await dbConnect();
    // `_purged: true` is the "delete forever" tombstone — the row is kept
    // on disk so the hybrid sync engine can propagate the purge to peers,
    // but it should never appear in the trash UI again.
    const trashed = await Filament.find({
      _deletedAt: { $ne: null },
      _purged: { $ne: true },
    })
      // GH #477: secondaryColors so the trash row's swatch can render
      // coextruded filaments faithfully — without it a trashed row with
      // color: null would have no color data at all on the wire.
      .select("name vendor type color secondaryColors cost _deletedAt parentId")
      .sort({ _deletedAt: -1 })
      .lean();
    return NextResponse.json(trashed);
  } catch (err) {
    return errorResponse("Failed to list trash", 500, getErrorMessage(err));
  }
}
