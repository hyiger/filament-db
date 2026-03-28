import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";
import Filament from "@/models/Filament";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;
  const nozzle = await Nozzle.findById(id).lean();
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
  const nozzle = await Nozzle.findByIdAndUpdate(id, body, {
    new: true,
    runValidators: true,
  }).lean();
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

  const nozzle = await Nozzle.findByIdAndDelete(id).lean();
  if (!nozzle) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ message: "Deleted" });
}
