import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";
import Filament from "@/models/Filament";
import Printer from "@/models/Printer";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;
  const nozzle = await Nozzle.findOne({ _id: id, _deletedAt: null }).lean();
  if (!nozzle) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(nozzle);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;
  const body = await request.json();
  const nozzle = await Nozzle.findOneAndUpdate(
    { _id: id, _deletedAt: null },
    body,
    { new: true, runValidators: true }
  ).lean();
  if (!nozzle) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(nozzle);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
    return NextResponse.json(
      {
        error: `Cannot delete this nozzle — it is referenced by ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}. Remove it from those filaments first.`,
      },
      { status: 400 },
    );
  }

  // Prevent deleting a nozzle that is installed on any printer
  const printerCount = await Printer.countDocuments({
    _deletedAt: null,
    installedNozzles: id,
  });
  if (printerCount > 0) {
    return NextResponse.json(
      {
        error: `Cannot delete this nozzle — it is installed on ${printerCount} printer${printerCount !== 1 ? "s" : ""}. Remove it from those printers first.`,
      },
      { status: 400 },
    );
  }

  const nozzle = await Nozzle.findByIdAndUpdate(
    id,
    { _deletedAt: new Date() },
    { new: true }
  ).lean();
  if (!nozzle) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ message: "Deleted" });
}
