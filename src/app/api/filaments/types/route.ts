import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function GET() {
  await dbConnect();
  const types: string[] = await Filament.distinct("type", { _deletedAt: null });
  return NextResponse.json(types.sort());
}
