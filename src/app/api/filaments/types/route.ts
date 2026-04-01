import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function GET() {
  try {
    await dbConnect();
    const types: string[] = await Filament.distinct("type", { _deletedAt: null });
    return NextResponse.json(types.sort());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to fetch types", detail: message }, { status: 500 });
  }
}
