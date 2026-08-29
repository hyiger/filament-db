import { NextRequest, NextResponse } from "next/server";
import {
  survivorNameConflict,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import dbConnect from "@/lib/mongodb";
import Location from "@/models/Location";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { isValidIsoDateString } from "@/lib/validateSpoolBody";

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

    // Attach per-location spool counts in one aggregation.
    //
    // GH #182: subtract the effective `spoolWeight` (tare) from each
    // spool's `totalWeight` (clamped at 0) so the grams figure reports
    // REMAINING filament, not the gross scale reading — otherwise N spools
    // over-report by N × empty-spool-mass. `spoolWeight` is inheritable, so
    // the $lookup resolves the parent's value ($ifNull chain: own → parent
    // → 0).
    const counts = await Filament.aggregate([
      { $match: { _deletedAt: null } },
      // GH #1005 F4: drop the heavy per-spool subfields (incl. dryCycles —
      // no dry stats are computed here) before the $unwind streams them.
      { $unset: ["spools.photoDataUrl", "spools.usageHistory", "spools.dryCycles"] },
      // Parent lookup for inherited spoolWeight; $arrayElemAt on the empty
      // array safely returns null.
      {
        $lookup: {
          from: "filaments",
          localField: "parentId",
          foreignField: "_id",
          as: "_parent",
          pipeline: [{ $project: { spoolWeight: 1 } }],
        },
      },
      { $unwind: "$spools" },
      // GH #1106: the retired filter lives in the accumulators, not $match,
      // so one pass yields both numbers — a location holding only retired
      // spools used to read "Spools 0" and then refuse to delete, telling
      // the user to reassign spools the same row said didn't exist.
      { $match: { "spools.locationId": { $ne: null } } },
      {
        $group: {
          _id: "$spools.locationId",
          // { $eq: [..., true] } reproduces the old { $ne: true } semantics
          // for missing / false / legacy values (the schema default is false).
          spoolCount: { $sum: { $cond: [{ $eq: ["$spools.retired", true] }, 0, 1] } },
          retiredSpoolCount: { $sum: { $cond: [{ $eq: ["$spools.retired", true] }, 1, 0] } },
          totalGrams: {
            $sum: {
              // TRAP: this $cond is load-bearing. Without it, dropping the
              // retired filter from $match above would silently start adding
              // retired spools into every location's gram total.
              $cond: [
                { $eq: ["$spools.retired", true] },
                0,
                {
                  $max: [
                    0,
                    {
                      $subtract: [
                        { $ifNull: ["$spools.totalWeight", 0] },
                        {
                          $ifNull: [
                            "$spoolWeight",
                            { $ifNull: [{ $arrayElemAt: ["$_parent.spoolWeight", 0] }, 0] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    ]);
    const countsByLocation = new Map(counts.map((c) => [String(c._id), c]));

    const enriched = locations.map((l) => {
      const stats = countsByLocation.get(String(l._id));
      return {
        ...l,
        spoolCount: stats?.spoolCount ?? 0,
        retiredSpoolCount: stats?.retiredSpoolCount ?? 0,
        totalGrams: stats?.totalGrams ?? 0,
      };
    });

    return NextResponse.json(enriched);
  } catch (err) {
    return errorResponse("Failed to fetch locations", 500, getErrorMessage(err));
  }
}

export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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
    // Same explicit ISO check as the PUT path: Mongoose rolls an
    // impossible-but-ISO-shaped date over instead of rejecting it (GH #372).
    if (body.desiccantChangedAt != null &&
        !(typeof body.desiccantChangedAt === "string" &&
          isValidIsoDateString(body.desiccantChangedAt))) {
      return errorResponse("desiccantChangedAt must be an ISO date string or null", 400);
    }
    // GH #1116: the partial unique index compares RAW stored strings, so a
    // submitted "Drybox" beside a surviving untrimmed "Drybox " would write
    // an indistinguishable duplicate. Ask the trimmed question explicitly,
    // in the same 409 shape handleDuplicateKeyError produces so the client
    // contract is unchanged.
    const nameConflict = await survivorNameConflict(
      Location.collection as unknown as MinimalNameCollection,
      body.name,
    );
    if (nameConflict) {
      return errorResponse(
        `A location with that name already exists: "${String(body.name).trim()}"`,
        409,
      );
    }
    const location = await Location.create(body);
    return NextResponse.json(location, { status: 201 });
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "location");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to create location");
  }
}
