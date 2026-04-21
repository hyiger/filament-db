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
    // Attach the list of printers this nozzle is installed in (reverse lookup
    // through Printer.installedNozzles) so the edit form can show the current
    // assignment.
    const printers = await Printer.find({
      _deletedAt: null,
      installedNozzles: id,
    })
      .select("_id name")
      .lean();
    return NextResponse.json({ ...nozzle, printers });
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
    delete body.__v;
    delete body.instanceId;
    delete body.syncId;

    // If the client sent `printerIds`, sync Printer.installedNozzles to match:
    // any printer in the list gets this nozzle added, any other printer that
    // currently has it installed gets it removed. This lets the nozzle edit
    // form manage the assignment from the nozzle side while the Printer form
    // continues to manage it from the printer side.
    const printerIds: string[] | undefined = Array.isArray(body.printerIds)
      ? body.printerIds
      : undefined;
    delete body.printerIds;
    delete body.printers; // never persist the enrichment on the Nozzle doc

    const nozzle = await Nozzle.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { new: true, runValidators: true }
    ).lean();
    if (!nozzle) {
      return errorResponse("Not found", 404);
    }

    if (printerIds !== undefined) {
      // Add this nozzle to every printer in the list (idempotent)
      if (printerIds.length > 0) {
        await Printer.updateMany(
          { _id: { $in: printerIds }, _deletedAt: null },
          { $addToSet: { installedNozzles: id } }
        );
      }
      // Remove this nozzle from any other printer that currently has it
      await Printer.updateMany(
        { _id: { $nin: printerIds }, _deletedAt: null, installedNozzles: id },
        { $pull: { installedNozzles: id } }
      );
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
