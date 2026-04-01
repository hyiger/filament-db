import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { IFilament } from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import { resolveFilament, hasVariants } from "@/lib/resolveFilament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const filament = await Filament.findOne({ _id: id, _deletedAt: null })
      .populate("compatibleNozzles")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }

    // If this is a variant, resolve inherited values from parent
    let resolved: IFilament | ReturnType<typeof resolveFilament> = filament;
    if (filament.parentId) {
      const parent = await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
        .populate("compatibleNozzles")
        .populate("calibrations.nozzle")
        .populate("calibrations.printer")
        .lean();
      resolved = resolveFilament(filament, parent);
    }

    // If this is a parent, include its variants
    const variants = await Filament.find({ parentId: id, _deletedAt: null })
      .select("name color cost")
      .sort({ name: 1 })
      .lean();

    return NextResponse.json({ ...resolved, _variants: variants });
  } catch (err) {
    return errorResponse("Failed to fetch filament", 500, getErrorMessage(err));
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

    // Validate parentId if provided
    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
      if (!parent) {
        return errorResponse("Parent filament not found", 400);
      }
      // Prevent circular references
      if (parent.parentId) {
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      // Prevent self-reference
      if (body.parentId === id) {
        return errorResponse("Cannot be your own parent", 400);
      }
    }

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { new: true, runValidators: true }
    ).lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(filament);
  } catch (err) {
    return errorResponse("Failed to update filament", 500, getErrorMessage(err));
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;

    // Prevent deleting a parent that has variants
    if (await hasVariants(Filament, id)) {
      return errorResponse(
        "Cannot delete a filament that has color variants. Delete the variants first.",
        400,
      );
    }

    const filament = await Filament.findByIdAndUpdate(
      id,
      { _deletedAt: new Date() },
      { new: true }
    ).lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponse("Failed to delete filament", 500, getErrorMessage(err));
  }
}
