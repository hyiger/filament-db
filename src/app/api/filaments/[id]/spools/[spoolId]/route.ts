import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId, isSpoolInstanceIdTaken } from "@/models/Filament";
import Printer from "@/models/Printer";
import { validateSpoolBody } from "@/lib/validateSpoolBody";
import Location from "@/models/Location";
import { assignSpoolToSlot } from "@/lib/spoolSlots";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { errorResponse, errorResponseFromCaught, assertActiveSpoolLocation } from "@/lib/apiErrorHandler";
import {
  parseSpoolResponseShape,
  findSpoolById,
  INVALID_SHAPE_MESSAGE,
} from "@/lib/spoolResponseShape";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // GH #1027: ?shape=spool slims the response to the affected spool; the
  // default stays the whole filament doc (the contract shipped clients parse).
  const shape = parseSpoolResponseShape(request.nextUrl.searchParams);
  if (shape === null) {
    return errorResponse(INVALID_SHAPE_MESSAGE, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate up front — the positional `$` operator bypasses Mongoose
  // subdocument validation.
  const validation = validateSpoolBody(body, { partial: true });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // remainingWeight is a convenience input that resolves to an absolute
  // totalWeight; accepting both in one request would be ambiguous.
  if (validation.totalWeight !== undefined && validation.remainingWeight !== undefined) {
    return errorResponse("Provide either totalWeight or remainingWeight, not both", 400);
  }

  try {
    await dbConnect();
    const { id, spoolId } = await params;

    // GH #425: validate ObjectIds up front — a garbage id would CastError
    // into a 500 instead of a 400.
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(spoolId)) {
      return errorResponse("Invalid filament or spool id", 400);
    }

    // GH #953: a moved-to location must reference an active Location, or a
    // dangling ref persists (e.g. a queued offline move replayed after the
    // location was deleted) and breaks every location-grouped view.
    const locGuard = await assertActiveSpoolLocation(Location, validation.locationId);
    if (locGuard) return locGuard;

    // GH #605: the whole read-decide-write section runs under the same
    // per-filament mutex the promotion paths hold. Unserialized, the
    // positional write could land BETWEEN a promotion's snapshot and its
    // clearing write — the copy minted from the pre-edit snapshot, the
    // parent cleared, the 200-acknowledged edit silently lost. In-lock,
    // either this PUT runs first (the promotion's fresh snapshot carries
    // the edit onto the variant) or the promotion runs first and the
    // filters below no longer match (post-promotion staleness already
    // 404s). Single key, no nested locks.
    return await runExclusive(filamentLockKey(id), async () => {
      // #732 Phase 4: edit or regenerate the spool's instanceId.
      // `regenerate` wins and mints a fresh id; a user-entered id is
      // uniqueness-checked vs OTHER spools (excludeSpoolId = spoolId).
      let finalInstanceId: string | undefined;
      if (validation.regenerate === true) {
        finalInstanceId = generateInstanceId();
      } else if (validation.instanceId !== undefined) {
        // Best-effort uniqueness (read-then-write, not a DB unique
        // constraint). A concurrent identical manual entry could slip
        // through; the matcher tolerates that (ambiguous candidates, never
        // an arbitrary pick).
        if (await isSpoolInstanceIdTaken(validation.instanceId, spoolId, id)) {
          return errorResponse("That spool ID is already used by another spool", 409);
        }
        finalInstanceId = validation.instanceId;
      }

      // Convert a remainingWeight input to an absolute totalWeight by
      // adding the spool's tare (own spoolWeight, else the parent's; 0g
      // fallback matches the inventory aggregations so totals reconcile).
      // remainingWeight === null clears the weight.
      let computedTotalWeight: number | null | undefined;
      if (validation.remainingWeight !== undefined) {
        const filamentDoc = await Filament.findOne(
          { _id: id, _deletedAt: null, "spools._id": spoolId },
          { spoolWeight: 1, parentId: 1 },
        ).lean<{ spoolWeight: number | null; parentId: mongoose.Types.ObjectId | null } | null>();
        if (!filamentDoc) {
          return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
        if (validation.remainingWeight === null) {
          computedTotalWeight = null;
        } else {
          let tare = filamentDoc.spoolWeight;
          if ((tare === null || tare === undefined) && filamentDoc.parentId) {
            const parent = await Filament.findById(filamentDoc.parentId, {
              spoolWeight: 1,
            }).lean<{ spoolWeight: number | null } | null>();
            tare = parent?.spoolWeight ?? null;
          }
          computedTotalWeight = validation.remainingWeight + (tare ?? 0);
        }
      }

      const update: Record<string, unknown> = {};
      if (computedTotalWeight !== undefined) {
        update["spools.$.totalWeight"] = computedTotalWeight;
      } else if (validation.totalWeight !== undefined) {
        update["spools.$.totalWeight"] = validation.totalWeight;
      }
      if (validation.label !== undefined) update["spools.$.label"] = validation.label;
      if (validation.locationId !== undefined) update["spools.$.locationId"] = validation.locationId;
      if (validation.photoDataUrl !== undefined) update["spools.$.photoDataUrl"] = validation.photoDataUrl;
      if (validation.retired !== undefined) update["spools.$.retired"] = validation.retired;
      if (validation.lotNumber !== undefined) update["spools.$.lotNumber"] = validation.lotNumber;
      if (validation.purchaseDate !== undefined) update["spools.$.purchaseDate"] = validation.purchaseDate;
      if (validation.openedDate !== undefined) update["spools.$.openedDate"] = validation.openedDate;
      if (finalInstanceId !== undefined) update["spools.$.instanceId"] = finalInstanceId;

      if (Object.keys(update).length === 0) {
        return NextResponse.json(
          { error: "No updatable fields provided" },
          { status: 400 },
        );
      }

      const filament = await Filament.findOneAndUpdate(
        { _id: id, _deletedAt: null, "spools._id": spoolId },
        { $set: update },
        { returnDocument: "after" }
      ).lean();

      if (!filament) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      // GH #268: a retired spool must not stay loaded in an AMS slot. Clear
      // AFTER the write — the $set filter already proved the spool belongs
      // to THIS filament (`assignSpoolToSlot` clears globally by spoolId,
      // so a pre-clear before the ownership check could strip another
      // filament's slot). PUT doesn't need clear-before for retryability:
      // unlike DELETE the spool stays findable, so a retry re-runs both.
      if (validation.retired === true) {
        await assignSpoolToSlot(Printer, spoolId, null);
      }

      // GH #1027: the $set filter matched `spools._id`, so the null guard
      // is unreachable-in-practice defensiveness.
      if (shape === "spool") {
        const spool = findSpoolById(filament.spools, spoolId);
        if (!spool) {
          return errorResponse("Spool not found", 404);
        }
        return NextResponse.json({ spool });
      }
      return NextResponse.json(filament);
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to update spool");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // GH #1027: for DELETE, ?shape=spool returns a deleted-marker — the
  // post-$pull doc no longer contains the spool, so there's nothing to echo.
  const shape = parseSpoolResponseShape(request.nextUrl.searchParams);
  if (shape === null) {
    return errorResponse(INVALID_SHAPE_MESSAGE, 400);
  }

  try {
    await dbConnect();
    const { id, spoolId } = await params;

    // GH #425: same ObjectId guard as PUT.
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(spoolId)) {
      return errorResponse("Invalid filament or spool id", 400);
    }

    // GH #605: the exists-precheck → slot-clear → $pull sequence runs under
    // the per-filament mutex — unserialized, a promotion's snapshot could
    // copy the spool onto the promoted variant after the precheck and the
    // $pull would then remove it from the parent AFTER the copy was minted:
    // a 200-acknowledged delete whose spool RESURRECTS on the variant.
    // Single key, no nested locks.
    return await runExclusive(filamentLockKey(id), async () => {
      // GH #886: clear the spool from AMS slots BEFORE removing it (the
      // #261/#333 ordering). If the slot-clear threw AFTER the $pull, every
      // retry would 404 before reaching the clear (the `spools._id` filter
      // no longer matches), leaving a dangling, uncleanable ref. The
      // precondition read keeps the 404 contract without clearing slots for
      // a spool that doesn't exist.
      const exists = await Filament.exists({
        _id: id,
        _deletedAt: null,
        "spools._id": spoolId,
      });
      if (!exists) {
        return NextResponse.json(
          { error: "Filament or spool not found" },
          { status: 404 },
        );
      }
      // GH #242 — a deleted spool must not linger in a printer AMS slot.
      // Idempotent updateMany, so a failure leaves the spool present and
      // the whole op retryable.
      await assignSpoolToSlot(Printer, spoolId, null);

      const filament = await Filament.findOneAndUpdate(
        { _id: id, _deletedAt: null, "spools._id": spoolId },
        { $pull: { spools: { _id: spoolId } } },
        { returnDocument: "after" }
      ).lean();

      if (!filament) {
        // A concurrent delete won the race; the slot is already cleared.
        return NextResponse.json(
          { error: "Filament or spool not found" },
          { status: 404 },
        );
      }

      // GH #886: best-effort clear AGAIN after the $pull — a concurrent
      // assignment could slot this spool in the pre-clear→$pull window,
      // leaving Printer.amsSlots[] pointing at a now-deleted spool. The
      // spool is already gone, so a failure here is harmless.
      await assignSpoolToSlot(Printer, spoolId, null).catch(() => {});

      if (shape === "spool") {
        return NextResponse.json({ deleted: true, spoolId });
      }
      return NextResponse.json(filament);
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete spool");
  }
}
