import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function GET() {
  await dbConnect();
  const vendors: string[] = await Filament.distinct("vendor", { _deletedAt: null });
  return NextResponse.json(vendors.sort());
}
