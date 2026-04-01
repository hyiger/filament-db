import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function GET() {
  try {
    await dbConnect();
    const vendors: string[] = await Filament.distinct("vendor", { _deletedAt: null });
    return NextResponse.json(vendors.sort());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to fetch vendors", detail: message }, { status: 500 });
  }
}
