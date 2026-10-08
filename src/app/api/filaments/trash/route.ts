import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { optTagsAwaitReview } from "@/lib/optTagLegacy";

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
    // `_purged: true` is the "delete forever" tombstone — kept on disk so
    // hybrid sync can propagate the purge, but never shown in trash again.
    //
    // GH #477: mirror the active list aggregation's effective-array merge
    // (`$lookup` + own-array-wins) so a trashed variant inheriting its
    // parent's multi-color data renders the same here as everywhere else.
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
          pipeline: [{ $project: { secondaryColors: 1, optTags: 1, optTagsSpec: 1 } }],
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
          // GH #1227 (Codex P2 r11): the marker of the row supplying the array
          // — folded into `_optTagsAwaitReview` below and stripped.
          _optTagsSourceSpec: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$optTags", []] } }, 0] },
              "$optTagsSpec",
              { $arrayElemAt: ["$_parent.optTagsSpec", 0] },
            ],
          },
          cost: 1,
          parentId: 1,
          _deletedAt: 1,
        },
      },
    ]);
    for (const row of trashed as Array<Record<string, unknown>>) {
      row._optTagsAwaitReview = optTagsAwaitReview({
        optTags: row.optTags as number[] | undefined,
        optTagsSpec: row._optTagsSourceSpec as boolean | undefined,
      });
      delete row._optTagsSourceSpec;
    }
    return NextResponse.json(trashed);
  } catch (err) {
    return errorResponse("Failed to list trash", 500, getErrorMessage(err));
  }
}
