import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";
import Filament from "@/models/Filament";
import Printer from "@/models/Printer";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const nozzle = await Nozzle.findOne({ _id: id, _deletedAt: null }).lean();
    if (!nozzle) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(nozzle);
  } catch (err) {
    return errorResponse("Failed to fetch nozzle", 500, getErrorMessage(err));
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
    const nozzle = await Nozzle.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { new: true, runValidators: true }
    ).lean();
    if (!nozzle) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(nozzle);
  } catch (err) {
    return errorResponse("Failed to update nozzle", 500, getErrorMessage(err));
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;

    // Prevent deleting a nozzle that is referenced by any filament
    const referencingCount = await Filament.countDocuments({
      _deletedAt: null,
      $or: [
        { compatibleNozzles: id },
        { "calibrations.nozzle": id },
      ],
    });
    if (referencingCount > 0) {
      return errorResponse(
        `Cannot delete this nozzle — it is referenced by ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}. Remove it from those filaments first.`,
        400,
      );
    }

    // Prevent deleting a nozzle that is installed on any printer
    const printerCount = await Printer.countDocuments({
      _deletedAt: null,
      installedNozzles: id,
    });
    if (printerCount > 0) {
      return errorResponse(
        `Cannot delete this nozzle — it is installed on ${printerCount} printer${printerCount !== 1 ? "s" : ""}. Remove it from those printers first.`,
        400,
      );
    }

    const nozzle = await Nozzle.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
      { new: true }
    ).lean();
    if (!nozzle) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponse("Failed to delete nozzle", 500, getErrorMessage(err));
  }
}
