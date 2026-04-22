import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Location from "@/models/Location";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse, handleDuplicateKeyError } from "@/lib/apiErrorHandler";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const searchParams = request.nextUrl.searchParams;
    const kind = searchParams.get("kind");
    const includeStats = searchParams.get("stats") === "true";

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (kind) filter.kind = kind;

    const locations = await Location.find(filter).sort({ name: 1 }).lean();

    if (!includeStats) {
      return NextResponse.json(locations);
    }

    // Attach spool counts per location so the list page can show "N spools"
    // without the client having to re-query filaments. Uses a single
    // aggregation over Filament.spools since spools are embedded.
    const counts = await Filament.aggregate([
      { $match: { _deletedAt: null } },
      { $unwind: "$spools" },
      { $match: { "spools.retired": { $ne: true }, "spools.locationId": { $ne: null } } },
      {
        $group: {
          _id: "$spools.locationId",
          spoolCount: { $sum: 1 },
          totalGrams: { $sum: { $ifNull: ["$spools.totalWeight", 0] } },
        },
      },
    ]);
    const countsByLocation = new Map(counts.map((c) => [String(c._id), c]));

    const enriched = locations.map((l) => {
      const stats = countsByLocation.get(String(l._id));
      return {
        ...l,
        spoolCount: stats?.spoolCount ?? 0,
        totalGrams: stats?.totalGrams ?? 0,
      };
    });

    return NextResponse.json(enriched);
  } catch (err) {
    return errorResponse("Failed to fetch locations", 500, getErrorMessage(err));
  }
}

export async function POST(request: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  try {
    await dbConnect();

    delete body._id;
    delete body._deletedAt;
    delete body.createdAt;
    delete body.updatedAt;
    delete body.__v;
    delete body.syncId;
    const location = await Location.create(body);
    return NextResponse.json(location, { status: 201 });
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "location");
    if (dupResponse) return dupResponse;
    return errorResponse("Failed to create location", 500, getErrorMessage(err));
  }
}
