import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Printer from "@/models/Printer";
import Filament from "@/models/Filament";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;
  const printer = await Printer.findOne({ _id: id, _deletedAt: null })
    .populate("installedNozzles")
    .lean();
  if (!printer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(printer);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;
  const body = await request.json();
  const printer = await Printer.findOneAndUpdate(
    { _id: id, _deletedAt: null },
    body,
    { new: true, runValidators: true }
  ).lean();
  if (!printer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(printer);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;

  // Prevent deleting a printer referenced by filament calibrations
  const referencingCount = await Filament.countDocuments({
    _deletedAt: null,
    "calibrations.printer": id,
  });
  if (referencingCount > 0) {
    return NextResponse.json(
      {
        error: `Cannot delete this printer — it is referenced by ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}. Remove its calibrations from those filaments first.`,
      },
      { status: 400 },
    );
  }

  const printer = await Printer.findByIdAndUpdate(
    id,
    { _deletedAt: new Date() },
    { new: true }
  ).lean();
  if (!printer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ message: "Deleted" });
}
