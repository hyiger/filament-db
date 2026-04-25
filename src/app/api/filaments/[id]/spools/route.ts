import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { validateSpoolBody } from "@/lib/validateSpoolBody";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Reject non-numeric totalWeight and non-string label up front so Mongoose
  // doesn't silently store bad types that break downstream weight math.
  const validation = validateSpoolBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    await dbConnect();
    const { id } = await params;

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      {
        $push: {
          spools: {
            label: validation.label,
            totalWeight: validation.totalWeight,
          },
        },
      },
      { returnDocument: "after" }
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
