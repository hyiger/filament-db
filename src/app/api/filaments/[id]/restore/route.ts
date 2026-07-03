import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * POST /api/filaments/{id}/restore — un-soft-delete a filament.
 *
 * Sets `_deletedAt` back to null, surfacing the filament in the regular list
 * again. There's one tricky case: the partial unique index on `name` only
 * covers non-deleted documents, so while a filament was in the trash, a new
 * filament with the same name could have been created. In that case the
 * restore would violate the index. We detect that up front and refuse with
 * a clear error so the user can rename one or the other rather than getting
 * a Mongo duplicate-key error.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { id } = await params;

    // Match the same filter the trash listing uses — a `_purged` row is a
    // "delete forever" tombstone and shouldn't be revivable from the API.
    const trashed = await Filament.findOne({
      _id: id,
      _deletedAt: { $ne: null },
      _purged: { $ne: true },
    });
    if (!trashed) {
      return errorResponse("Filament not in trash", 404);
    }

    // Name collision check: if a non-deleted filament now uses this name,
    // restoring would violate the partial unique index. Fail with a useful
    // message so the caller can rename one or the other.
    const conflict = await Filament.findOne({
      name: trashed.name,
      _deletedAt: null,
      _id: { $ne: trashed._id },
    })
      .select("_id")
      .lean();
    if (conflict) {
      return errorResponse(
        `Cannot restore: another active filament named "${trashed.name}" already exists. Rename one of them first.`,
        409,
      );
    }

    // GH #223: refuse to restore a variant whose parent is still in the
    // trash. Without this guard the variant ends up with `parentId`
    // pointing at a doc whose `_deletedAt != null`, and every read path
    // filters parents by `_deletedAt: null` — so the variant renders
    // with no inheritance (empty cost, density, temperatures, etc.) and
    // the user sees a half-broken row with no obvious cause. Better to
    // surface the dependency and let the caller restore the parent
    // first, then the variant.
    if (trashed.parentId) {
      const parent = await Filament.findOne({
        _id: trashed.parentId,
        _deletedAt: null,
      })
        .select("_id name")
        .lean();
      if (!parent) {
        return errorResponse(
          `Cannot restore: this variant's parent is still in the trash. Restore the parent first.`,
          409,
        );
      }
    }

    trashed._deletedAt = null;
    // GH #905/#954: restore only mutates `_deletedAt`, so validate ONLY the
    // modified path. A full-document save() runs the #337 numeric min/max
    // validators against every field — a legacy out-of-range value (written
    // before those validators, or via a pre-#872 unvalidated calibration
    // update) would throw a ValidationError → 400, permanently stranding the
    // doc in the trash (the PUT handler filters `_deletedAt: null`, so the user
    // can't edit it back into range). This is the missed GH #905 call site.
    await trashed.save({ validateModifiedOnly: true });

    return NextResponse.json({ message: "Restored", _id: String(trashed._id) });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to restore filament");
  }
}
