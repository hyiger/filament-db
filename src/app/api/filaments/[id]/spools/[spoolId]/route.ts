import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { validateSpoolBody } from "@/lib/validateSpoolBody";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
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
      { new: true }
    ).lean();

    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(filament);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to update spool", detail: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
  try {
    await dbConnect();
    const { id, spoolId } = await params;

    // Require the spool to exist on the filament. Without this guard, a
    // $pull with a missing spoolId is a silent no-op — the client gets a
    // 200 and can't tell whether the delete actually happened.
    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null, "spools._id": spoolId },
      { $pull: { spools: { _id: spoolId } } },
      { new: true }
    ).lean();

    if (!filament) {
      return NextResponse.json(
        { error: "Filament or spool not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(filament);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to delete spool", detail: message }, { status: 500 });
  }
}
