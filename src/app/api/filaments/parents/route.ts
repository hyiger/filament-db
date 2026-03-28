import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

/**
 * Returns filaments that can be used as parents (i.e., not already variants themselves).
 * Optionally filter by vendor or search string.
 */
export async function GET(request: NextRequest) {
  await dbConnect();

  const searchParams = request.nextUrl.searchParams;
  const search = searchParams.get("search");
  const exclude = searchParams.get("exclude"); // exclude self when editing

  const filter: Record<string, unknown> = {
    parentId: null, // only standalone/parent filaments can be parents
    _deletedAt: null,
  };
  if (search) {
    filter.name = { $regex: search, $options: "i" };
  }
  if (exclude) {
    filter._id = { $ne: exclude };
  }

  const parents = await Filament.find(filter)
    .select("name vendor type color")
    .sort({ vendor: 1, name: 1 })
    .lean();

  return NextResponse.json(parents);
}
