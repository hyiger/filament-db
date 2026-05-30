import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
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

    const update: Record<string, unknown> = {};
    if (validation.totalWeight !== undefined) update["spools.$.totalWeight"] = validation.totalWeight;
    if (validation.label !== undefined) update["spools.$.label"] = validation.label;
    if (validation.locationId !== undefined) update["spools.$.locationId"] = validation.locationId;
    if (validation.photoDataUrl !== undefined) update["spools.$.photoDataUrl"] = validation.photoDataUrl;
    if (validation.retired !== undefined) update["spools.$.retired"] = validation.retired;
    if (validation.lotNumber !== undefined) update["spools.$.lotNumber"] = validation.lotNumber;
    if (validation.purchaseDate !== undefined) update["spools.$.purchaseDate"] = validation.purchaseDate;
    if (validation.openedDate !== undefined) update["spools.$.openedDate"] = validation.openedDate;

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

    // GH #268: retiring a spool excludes it from inventory, so it must
    // not stay loaded in a printer AMS slot — the assignment route
    // already refuses to *assign* a retired spool. Clear it from every
    // slot, the same way the spool DELETE handler does.
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

    // Require the spool to exist on the filament. Without this guard, a
    // $pull with a missing spoolId is a silent no-op — the client gets a
    // 200 and can't tell whether the delete actually happened.
    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null, "spools._id": spoolId },
      { $pull: { spools: { _id: spoolId } } },
      { returnDocument: "after" }
    ).lean();

    if (!filament) {
      return NextResponse.json(
        { error: "Filament or spool not found" },
        { status: 404 },
      );
    }

    // GH #242 — a deleted spool must not linger in a printer AMS slot.
    await assignSpoolToSlot(Printer, spoolId, null);

    return NextResponse.json(filament);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete spool");
  }
}
