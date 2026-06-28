import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId, isSpoolInstanceIdTaken } from "@/models/Filament";
import Printer from "@/models/Printer";
import { validateSpoolBody } from "@/lib/validateSpoolBody";
import { assignSpoolToSlot } from "@/lib/spoolSlots";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Reject non-numeric totalWeight and non-string label up front so we
  // never persist bad types via the positional `$` operator (which
  // bypasses Mongoose subdocument validation).
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

    // GH #425: validate ObjectIds up front. Without this, a garbage id
    // throws CastError on the findOneAndUpdate which fell through to a
    // 500 with "Failed to update spool" — the client got no usable
    // signal that the request was malformed rather than the server
    // being broken. The print-history route does the same up-front
    // check.
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(spoolId)) {
      return errorResponse("Invalid filament or spool id", 400);
    }

    // #732 Phase 4: edit or regenerate the spool's instanceId. `regenerate`
    // wins and mints a fresh id; a user-entered id (charset/length already
    // validated) is checked for uniqueness vs OTHER spools so the match path
    // stays unambiguous — a spool keeps its own id (excludeSpoolId = spoolId).
    let finalInstanceId: string | undefined;
    if (validation.regenerate === true) {
      finalInstanceId = generateInstanceId();
    } else if (validation.instanceId !== undefined) {
      // Best-effort uniqueness (read-then-write, not a DB unique constraint —
      // see the POST route + the spools.instanceId index comment). A concurrent
      // identical manual entry could slip through; the matcher tolerates that
      // (ambiguous candidates, never an arbitrary pick).
      if (await isSpoolInstanceIdTaken(validation.instanceId, spoolId, id)) {
        return errorResponse("That spool ID is already used by another spool", 409);
      }
      finalInstanceId = validation.instanceId;
    }

    // Convert a remainingWeight input to an absolute totalWeight by adding the
    // spool's tare — the filament's own spoolWeight, inherited from the parent
    // when a variant doesn't set its own. The 0g fallback (neither set, legacy
    // data) matches the inventory aggregations in /api/locations and
    // /api/spools/by-location so totals reconcile. remainingWeight === null
    // clears the weight (totalWeight = null), mirroring totalWeight semantics.
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

    // GH #268: a retired spool must not stay loaded in a printer AMS slot (the
    // assignment route already refuses to *assign* a retired spool). Clear AFTER
    // the write — the $set filter (`spools._id`) already proved the spool belongs
    // to THIS filament, so we never clear a spool that belongs to another one
    // (Codex P2 on #886 — `assignSpoolToSlot` clears globally by spoolId, so a
    // pre-clear before the ownership check could strip another filament's slot).
    // PUT doesn't need clear-before for retryability: unlike DELETE the spool
    // stays findable, so a retry re-runs the $set + re-clears.
    if (validation.retired === true) {
      await assignSpoolToSlot(Printer, spoolId, null);
    }

    return NextResponse.json(filament);
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

  try {
    await dbConnect();
    const { id, spoolId } = await params;

    // GH #425: same ObjectId guard as PUT — garbage id used to surface as
    // 500 "Failed to delete spool" rather than 400 "Invalid id".
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(spoolId)) {
      return errorResponse("Invalid filament or spool id", 400);
    }

    // GH #886: clear the spool from AMS slots BEFORE removing it, mirroring the
    // filament-level clear-BEFORE-delete ordering (#261/#333). If the slot-clear
    // threw AFTER the $pull, the spool would be gone but Printer.amsSlots[] would
    // still reference it — and every retry 404s before reaching the clear (the
    // `spools._id` filter no longer matches), leaving a dangling, uncleanable
    // ref. A precondition read keeps the 404 contract for a genuinely missing
    // spool without clearing slots for one that doesn't exist.
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
    // assignSpoolToSlot(..., null) is an idempotent, no-match-safe updateMany,
    // so a failure here leaves the spool present and the whole op retryable.
    await assignSpoolToSlot(Printer, spoolId, null);

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null, "spools._id": spoolId },
      { $pull: { spools: { _id: spoolId } } },
      { returnDocument: "after" }
    ).lean();

    if (!filament) {
      // A concurrent delete removed the spool between the precondition read and
      // the $pull. The slot is already cleared; just report not-found.
      return NextResponse.json(
        { error: "Filament or spool not found" },
        { status: 404 },
      );
    }

    // GH #886 (Codex P2): best-effort clear AGAIN after the $pull. The pre-clear
    // above gives retryability (a clear failure leaves the spool present), but a
    // concurrent assignment could slot this spool in the window between the
    // pre-clear and the $pull — leaving Printer.amsSlots[] pointing at a
    // now-deleted spool. A second clear after the delete closes that window. The
    // spool is already gone, so a failure here is harmless (no retry path needed).
    await assignSpoolToSlot(Printer, spoolId, null).catch(() => {});

    return NextResponse.json(filament);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete spool");
  }
}
