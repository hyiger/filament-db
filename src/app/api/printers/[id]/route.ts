import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Printer from "@/models/Printer";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const printer = await Printer.findOne({ _id: id, _deletedAt: null })
      .populate({ path: "installedNozzles", match: { _deletedAt: null } })
      .lean();
    if (!printer) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(printer);
  } catch (err) {
    return errorResponse("Failed to fetch printer", 500, getErrorMessage(err));
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const body = await request.json();

    // Validate that all referenced nozzle IDs exist and are active
    if (body.installedNozzles?.length > 0) {
      const activeCount = await Nozzle.countDocuments({
        _id: { $in: body.installedNozzles },
        _deletedAt: null,
      });
      if (activeCount !== body.installedNozzles.length) {
        return errorResponse("One or more selected nozzles no longer exist.", 400);
      }
    }

    const printer = await Printer.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { new: true, runValidators: true }
    ).lean();
    if (!printer) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(printer);
  } catch (err) {
    return errorResponse("Failed to update printer", 500, getErrorMessage(err));
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;

    // Prevent deleting a printer referenced by filament calibrations
    const referencingCount = await Filament.countDocuments({
      _deletedAt: null,
      "calibrations.printer": id,
    });
    if (referencingCount > 0) {
      return errorResponse(
        `Cannot delete this printer — it is referenced by ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}. Remove its calibrations from those filaments first.`,
        400,
      );
    }

    const printer = await Printer.findByIdAndUpdate(
      id,
      { _deletedAt: new Date() },
      { new: true }
    ).lean();
    if (!printer) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponse("Failed to delete printer", 500, getErrorMessage(err));
  }
}
