import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const body = await request.json();

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      {
        $push: {
          spools: {
            label: body.label || "",
            totalWeight: body.totalWeight ?? null,
          },
        },
      },
      { new: true }
    ).lean();

    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(filament);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to add spool", detail: message }, { status: 500 });
  }
}
