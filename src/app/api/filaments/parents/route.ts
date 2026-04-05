import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns filaments that can be used as parents (i.e., not already variants themselves).
 * Optionally filter by vendor or search string.
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const searchParams = request.nextUrl.searchParams;
    const search = searchParams.get("search");
    const exclude = searchParams.get("exclude"); // exclude self when editing

    const filter: Record<string, unknown> = {
      parentId: null, // only standalone/parent filaments can be parents
      _deletedAt: null,
    };
    if (search) {
      filter.name = { $regex: escapeRegex(search), $options: "i" };
    }
    if (exclude) {
      filter._id = { $ne: exclude };
    }

    const parents = await Filament.find(filter)
      .select("name vendor type color")
      .sort({ vendor: 1, name: 1 })
      .lean();

    return NextResponse.json(parents);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to fetch parents", detail: message }, { status: 500 });
  }
}
