import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
  await dbConnect();
  const { id, spoolId } = await params;
  const body = await request.json();

  const update: Record<string, unknown> = {};
  if (body.totalWeight !== undefined) update["spools.$.totalWeight"] = body.totalWeight;
  if (body.label !== undefined) update["spools.$.label"] = body.label;

  const filament = await Filament.findOneAndUpdate(
    { _id: id, _deletedAt: null, "spools._id": spoolId },
    { $set: update },
    { new: true }
  ).lean();

  if (!filament) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(filament);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
  await dbConnect();
  const { id, spoolId } = await params;

  const filament = await Filament.findOneAndUpdate(
    { _id: id, _deletedAt: null },
    { $pull: { spools: { _id: spoolId } } },
    { new: true }
  ).lean();

  if (!filament) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(filament);
}
