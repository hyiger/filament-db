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
    //
    // GH #477: variants inherit `secondaryColors` and `optTags` from
    // their parent (array-fallback inheritance per resolveFilament). A
    // trashed variant whose own arrays are empty must still render the
    // parent's multi-color data — otherwise a deleted variant under a
    // coextruded parent shows as a gray/solid dot in the trash UI even
    // though it inherits stripes everywhere else in the app. Mirror the
    // active list aggregation's `$lookup` + effective-array merge here
    // so trash agrees with the rest of the app. (Codex P2 on PR #486.)
    const trashed = await Filament.aggregate([
      {
        $match: {
          _deletedAt: { $ne: null },
          _purged: { $ne: true },
        },
      },
      { $sort: { _deletedAt: -1 } },
      {
        $lookup: {
          from: "filaments",
          localField: "parentId",
          foreignField: "_id",
          as: "_parent",
          pipeline: [{ $project: { secondaryColors: 1, optTags: 1 } }],
        },
      },
      {
        $project: {
          name: 1,
          vendor: 1,
          type: 1,
          color: 1,
          // Effective secondaryColors — variant's own non-empty array wins,
          // else fall through to the parent's.
          secondaryColors: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$secondaryColors", []] } }, 0] },
              "$secondaryColors",
              { $ifNull: [{ $arrayElemAt: ["$_parent.secondaryColors", 0] }, []] },
            ],
          },
          // Effective optTags — same array-fallback rule. The trash swatch
          // calls `deriveArrangement(item.optTags)`, so an inherited
          // coextruded variant needs to surface the parent's tag 29 here.
          optTags: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$optTags", []] } }, 0] },
              "$optTags",
              { $ifNull: [{ $arrayElemAt: ["$_parent.optTags", 0] }, []] },
            ],
          },
          cost: 1,
          parentId: 1,
          _deletedAt: 1,
        },
      },
    ]);
    return NextResponse.json(trashed);
  } catch (err) {
    return errorResponse("Failed to list trash", 500, getErrorMessage(err));
  }
}
