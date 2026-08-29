import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

/**
 * GET /api/filaments/colors — distinct `(colorName, color)` pairs across
 * non-deleted filaments, for the FilamentForm colorName typeahead. Same
 * name + same hex collapse to one row; different hexes under the same name
 * are kept as SEPARATE suggestions on purpose — the picker shows the
 * swatch so the user can pick the right shade.
 */
export async function GET() {
  try {
    await dbConnect();
    // The color filter is defensive — the schema default is "#808080", but
    // a malformed import could land null.
    const docs: Array<{ _id: { name: string; hex: string } }> = await Filament.aggregate([
      {
        $match: {
          _deletedAt: null,
          colorName: { $exists: true, $nin: [null, ""] },
          color: { $exists: true, $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: { name: "$colorName", hex: "$color" },
        },
      },
    ]);
    const pairs = docs
      .map((d) => ({ name: d._id.name, hex: d._id.hex }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json(pairs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to fetch colors", detail: message }, { status: 500 });
  }
}
