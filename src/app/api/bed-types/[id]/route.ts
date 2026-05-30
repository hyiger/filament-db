import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import BedType from "@/models/BedType";
import Filament from "@/models/Filament";
import Printer from "@/models/Printer";
import { errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const bedType = await BedType.findOne({ _id: id, _deletedAt: null }).lean();
    if (!bedType) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(bedType);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to fetch bed type");
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  try {
    await dbConnect();
    const { id } = await params;
    // GH #424: explicit allowlist so a future schema field isn't
    // automatically client-writable (e.g. an ownership flag).
    const update: Record<string, unknown> = {};
    if ("name" in body) update.name = body.name;
    if ("material" in body) update.material = body.material;
    if ("notes" in body) update.notes = body.notes;
    const bedType = await BedType.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      update,
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!bedType) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(bedType);
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "bed type");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to update bed type");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { id } = await params;

    // Prevent deleting a bed type that is referenced by any filament calibration
    const referencingCount = await Filament.countDocuments({
      _deletedAt: null,
      "calibrations.bedType": id,
    });
    if (referencingCount > 0) {
      return errorResponse(
        `Cannot delete this bed type — it is referenced by ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}. Remove it from those filaments first.`,
        400,
      );
    }

    // Prevent deleting a bed type that is installed on any printer.
    // `installedBedTypes` was added when bed types became printer-
    // attachable — without this guard the bed type could be soft-deleted
    // while printers still hold its ObjectId, leaving dangling refs that
    // the populate(..., match: { _deletedAt: null }) silently drops.
    // Mirrors the printer-reference guard in the nozzle DELETE handler.
    const printerCount = await Printer.countDocuments({
      _deletedAt: null,
      installedBedTypes: id,
    });
    if (printerCount > 0) {
      return errorResponse(
        `Cannot delete this bed type — it is installed on ${printerCount} printer${printerCount !== 1 ? "s" : ""}. Remove it from those printers first.`,
        400,
      );
    }

    const bedType = await BedType.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
      { returnDocument: "after" }
    ).lean();
    if (!bedType) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete bed type");
  }
}
