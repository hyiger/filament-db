import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import {
  gateFirstVariantAdoption,
  promotionRequired409Body,
} from "@/lib/createVariantGated";

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
 *
 * GH #605 (codex round 4, F6): restoring a trashed VARIANT can mint its
 * parent's first live variant — and the parent may have re-acquired carrying
 * state (a color, spools, legacy inventory) while it sat variant-less. That
 * is the same restructuring event the create/PUT paths gate, so the restore
 * runs the same adoption gate: 409 `parent_promotion_required` until the
 * caller repeats the request with `{ "promoteParent": true }` in the body,
 * which promotes the parent first. The body is optional — a bare POST (the
 * pre-existing contract) behaves exactly as before for every non-gated case.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // Optional body: `{ promoteParent: true }` confirms the F6 adoption gate.
  // Restore historically takes no body, so absent/invalid JSON means false.
  let promoteParent = false;
  try {
    const body = await request.json();
    promoteParent = (body as { promoteParent?: unknown })?.promoteParent === true;
  } catch {
    /* no body — the pre-existing bare-POST contract */
  }

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

    if (trashed.parentId) {
      // GH #223: refuse to restore a variant whose parent is still in the
      // trash. Without this guard the variant ends up with `parentId`
      // pointing at a doc whose `_deletedAt != null`, and every read path
      // filters parents by `_deletedAt: null` — so the variant renders
      // with no inheritance (empty cost, density, temperatures, etc.) and
      // the user sees a half-broken row with no obvious cause. Better to
      // surface the dependency and let the caller restore the parent
      // first, then the variant.
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

      // GH #605 (codex round 4, F6): the adoption gate — see the route
      // docblock. The un-delete save runs via `onReady`, INSIDE the parent's
      // lock hold, so no window exists between the gate's decision and the
      // revive: a concurrent write that would hand the parent carrying state
      // serializes on the same key (the PUT/atlas/OPT-sync writers all lock
      // it) and lands either before the gate (which then 409s/promotes) or
      // after the restore (where the PUT's template strip catches it).
      const adoption = await gateFirstVariantAdoption(Filament, trashed.parentId, {
        promoteParent,
        // The promotion copy must never squat on the reviving doc's name.
        adoptedName: trashed.name,
        onReady: async () => {
          trashed._deletedAt = null;
          // Same validateModifiedOnly rationale as the standalone path below.
          await trashed.save({ validateModifiedOnly: true });
        },
      });
      if (adoption.outcome === "parent_not_found") {
        // The parent was active above but vanished before the gate's in-lock
        // re-fetch — same dependency 409 as the pre-check.
        return errorResponse(
          `Cannot restore: this variant's parent is still in the trash. Restore the parent first.`,
          409,
        );
      }
      if (adoption.outcome === "promotion_required") {
        return NextResponse.json(promotionRequired409Body(adoption), { status: 409 });
      }

      return NextResponse.json({ message: "Restored", _id: String(trashed._id) });
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
