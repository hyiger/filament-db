import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Location from "@/models/Location";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

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
    return errorResponse("Failed to fetch location", 500, getErrorMessage(err));
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
    delete body._id;
    delete body._deletedAt;
    delete body.createdAt;
    delete body.updatedAt;
    delete body.__v;
    delete body.syncId;
    const location = await Location.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!location) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(location);
  } catch (err) {
    return errorResponse("Failed to update location", 500, getErrorMessage(err));
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;

    // Prevent deleting a location that is referenced by any spool. Users
    // should reassign spools to another location (or null) first.
    const referencingCount = await Filament.countDocuments({
      _deletedAt: null,
      "spools.locationId": id,
    });
    if (referencingCount > 0) {
      return errorResponse(
        `Cannot delete this location — it is referenced by spools in ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}. Reassign those spools to another location first.`,
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
    return errorResponse("Failed to delete location", 500, getErrorMessage(err));
  }
}
