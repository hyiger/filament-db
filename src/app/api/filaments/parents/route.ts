import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { errorResponseFromCaught } from "@/lib/apiErrorHandler";

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

    // Annotate each option with whether it currently has non-deleted
    // variants (a filament is only a parent when ≥1 variant points at it) —
    // drives the picker's cross-hatch vs solid swatch. One `distinct` is
    // cheaper than per-row `countDocuments`.
    const parentIdsWithVariants = await Filament.distinct("parentId", {
      _deletedAt: null,
      parentId: { $in: parents.map((p) => p._id) },
    });
    const hasVariantsSet = new Set(parentIdsWithVariants.map((id) => String(id)));
    const annotated = parents.map((p) => ({
      ...p,
      hasVariants: hasVariantsSet.has(String(p._id)),
    }));

    return NextResponse.json(annotated);
  } catch (err) {
    // GH #267: a non-ObjectId `exclude` makes Mongoose throw a CastError
    // when casting `{ _id: { $ne: exclude } }`. errorResponseFromCaught
    // maps CastError → 400 (bad client input) instead of a generic 500.
    return errorResponseFromCaught(err, "Failed to fetch parents");
  }
}
