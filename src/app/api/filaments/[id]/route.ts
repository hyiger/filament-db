import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import { resolveFilament, hasVariants } from "@/lib/resolveFilament";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;
  const filament = await Filament.findById(id)
    .populate("compatibleNozzles")
    .populate("calibrations.nozzle")
    .lean();
  if (!filament) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // If this is a variant, resolve inherited values from parent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolved: any = filament;
  if (filament.parentId) {
    const parent = await Filament.findById(filament.parentId)
      .populate("compatibleNozzles")
      .populate("calibrations.nozzle")
      .lean();
    resolved = resolveFilament(filament, parent);
  }

  // If this is a parent, include its variants
  const variants = await Filament.find({ parentId: id, _deletedAt: null })
    .select("name color cost")
    .sort({ name: 1 })
    .lean();

  return NextResponse.json({ ...resolved, _variants: variants });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;
  const body = await request.json();

  // Validate parentId if provided
  if (body.parentId) {
    const parent = await Filament.findById(body.parentId).lean();
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

  const filament = await Filament.findByIdAndUpdate(id, body, {
    new: true,
    runValidators: true,
  }).lean();
  if (!filament) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(filament);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
}
