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

  const filament = await Filament.findOne({ _id: id, _deletedAt: null });
  if (!filament) {
    return NextResponse.json({ error: "Filament not found" }, { status: 404 });
  }

  const spool = filament.spools.id(spoolId);
  if (!spool) {
    return NextResponse.json({ error: "Spool not found" }, { status: 404 });
  }

  if (body.totalWeight !== undefined) spool.totalWeight = body.totalWeight;
  if (body.label !== undefined) spool.label = body.label;

  await filament.save();

  const updated = await Filament.findById(id).lean();
  return NextResponse.json(updated);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
  await dbConnect();
  const { id, spoolId } = await params;

  const filament = await Filament.findOne({ _id: id, _deletedAt: null });
  if (!filament) {
    return NextResponse.json({ error: "Filament not found" }, { status: 404 });
  }

  const spool = filament.spools.id(spoolId);
  if (!spool) {
    return NextResponse.json({ error: "Spool not found" }, { status: 404 });
  }

  spool.deleteOne();
  await filament.save();

  const updated = await Filament.findById(id).lean();
  return NextResponse.json(updated);
}
