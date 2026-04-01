import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import { resolveFilament, hasVariants } from "@/lib/resolveFilament";

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
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // If this is a variant, resolve inherited values from parent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolved: any = filament;
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
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to fetch filament", detail: message }, { status: 500 });
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
        return NextResponse.json({ error: "Parent filament not found" }, { status: 400 });
      }
      // Prevent circular references
      if (parent.parentId) {
        return NextResponse.json(
          { error: "Cannot set a variant as parent (no nested inheritance)" },
          { status: 400 },
        );
      }
      // Prevent self-reference
      if (body.parentId === id) {
        return NextResponse.json({ error: "Cannot be your own parent" }, { status: 400 });
      }
    }

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { new: true, runValidators: true }
    ).lean();
    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(filament);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to update filament", detail: message }, { status: 500 });
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
      return NextResponse.json(
        { error: "Cannot delete a filament that has color variants. Delete the variants first." },
        { status: 400 },
      );
    }

    const filament = await Filament.findByIdAndUpdate(
      id,
      { _deletedAt: new Date() },
      { new: true }
    ).lean();
    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to delete filament", detail: message }, { status: 500 });
  }
}
