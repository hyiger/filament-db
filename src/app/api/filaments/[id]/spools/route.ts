import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await dbConnect();
  const { id } = await params;
  const body = await request.json();

  const filament = await Filament.findOne({ _id: id, _deletedAt: null });
  if (!filament) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  filament.spools.push({
    label: body.label || "",
    totalWeight: body.totalWeight ?? null,
  });

  await filament.save();

  const updated = await Filament.findById(id).lean();
  return NextResponse.json(updated);
}
