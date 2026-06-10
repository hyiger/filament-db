import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Location from "@/models/Location";
import Filament from "@/models/Filament";
import { errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const location = await Location.findOne({ _id: id, _deletedAt: null }).lean();
    if (!location) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(location);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to fetch location");
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
    // GH #424: PUT was spreading the entire request body and stripping
    // only a handful of internal fields. That left every future Location
    // schema field automatically client-writable, including any
    // ownership / sharing flags added later. Use an explicit allowlist
    // (matches the Filament PUT pattern) so the editable surface is
    // documented in the code and a new field has to be opted in.
    const update: Record<string, unknown> = {};
    if ("name" in body) update.name = body.name;
    if ("kind" in body) update.kind = body.kind;
    if ("humidity" in body) update.humidity = body.humidity;
    if ("notes" in body) update.notes = body.notes;
    const location = await Location.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      update,
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!location) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(location);
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "location");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to update location");
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

    // Prevent deleting a location that is referenced by any spool. Users
    // should reassign spools to another location (or null) first.
    //
    // GH #629: trashed filaments count too — a filament in the trash can be
    // restored, which would resurrect a dangling locationId ref if the
    // location were deleted in the meantime. Only `_purged` tombstones are
    // gone forever and don't block.
    const referencingCount = await Filament.countDocuments({
      _purged: { $ne: true },
      "spools.locationId": id,
    });
    if (referencingCount > 0) {
      return errorResponse(
        `Cannot delete this location — it is referenced by spools in ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}, possibly including filaments in the trash. Reassign those spools to another location (or permanently delete the trashed filaments) first.`,
        400,
      );
    }

    const location = await Location.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
      { returnDocument: "after" }
    ).lean();
    if (!location) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete location");
  }
}
