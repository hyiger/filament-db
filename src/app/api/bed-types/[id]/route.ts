import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import BedType from "@/models/BedType";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

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
    return errorResponse("Failed to fetch bed type", 500, getErrorMessage(err));
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
    const bedType = await BedType.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { new: true, runValidators: true }
    ).lean();
    if (!bedType) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(bedType);
  } catch (err) {
    return errorResponse("Failed to update bed type", 500, getErrorMessage(err));
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const bedType = await BedType.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
      { new: true }
    ).lean();
    if (!bedType) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponse("Failed to delete bed type", 500, getErrorMessage(err));
  }
}
