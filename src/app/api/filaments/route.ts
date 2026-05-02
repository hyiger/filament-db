import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse, handleDuplicateKeyError } from "@/lib/apiErrorHandler";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function GET(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const type = searchParams.get("type");
    const vendor = searchParams.get("vendor");
    const search = searchParams.get("search");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (type) filter.type = type;
    if (vendor) filter.vendor = vendor;
    if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };

    // Project to FilamentSummary shape: drop heavy spool subfields
    // (photoDataUrl, usageHistory, dryCycles), keep only the temperatures
    // the list renders, and surface `hasCalibrations` so the noCalibration
    // quick filter has a signal it can act on without fetching every doc.
    // The full document is still available via /api/filaments/{id}.
    //
    // tdsUrl is included on top of FilamentSummary because FilamentForm
    // (src/app/filaments/FilamentForm.tsx) calls this endpoint with
    // ?vendor=... to derive vendor-keyed TDS suggestions and reads
    // f.tdsUrl off each result. Dropping the field silently empties the
    // suggestion list on create/edit.
    const filaments = await Filament.aggregate([
      { $match: filter },
      { $sort: { name: 1 } },
      // Look up parent's calibrations so hasCalibrations reflects the
      // *effective* state rather than the variant's own array. Variants
      // with empty calibrations inherit from their parent (see
      // resolveFilament in src/lib/resolveFilament.ts), so projecting
      // only the variant's own array would falsely flag inheriting
      // variants under the noCalibration filter.
      {
        $lookup: {
          from: "filaments",
          localField: "parentId",
          foreignField: "_id",
          as: "_parent",
          pipeline: [{ $project: { calibrations: 1 } }],
        },
      },
      {
        $project: {
          name: 1,
          vendor: 1,
          type: 1,
          color: 1,
          cost: 1,
          density: 1,
          parentId: 1,
          spoolWeight: 1,
          netFilamentWeight: 1,
          totalWeight: 1,
          lowStockThreshold: 1,
          tdsUrl: 1,
          "temperatures.nozzle": 1,
          "temperatures.bed": 1,
          hasCalibrations: {
            $or: [
              { $gt: [{ $size: { $ifNull: ["$calibrations", []] } }, 0] },
              {
                $gt: [
                  {
                    $size: {
                      $ifNull: [
                        { $arrayElemAt: ["$_parent.calibrations", 0] },
                        [],
                      ],
                    },
                  },
                  0,
                ],
              },
            ],
          },
          spools: {
            $map: {
              input: { $ifNull: ["$spools", []] },
              as: "s",
              in: {
                _id: "$$s._id",
                // PrinterForm's AMS slot picker renders each option as
                // `s.label || s._id.slice(-4)`, so dropping label degrades
                // every choice to a 4-char id and breaks multi-spool
                // identification.
                label: "$$s.label",
                totalWeight: "$$s.totalWeight",
                retired: "$$s.retired",
              },
            },
          },
        },
      },
    ]);
    return NextResponse.json(filaments);
  } catch (err) {
    return errorResponse("Failed to fetch filaments", 500, getErrorMessage(err));
  }
}

export async function POST(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  delete body._id;
  delete body._deletedAt;
  delete body.createdAt;
  delete body.updatedAt;
  delete body.__v;
  delete body.instanceId;
  delete body.syncId;

  // If an initial totalWeight is provided, auto-create a spool entry
  if (body.totalWeight != null && (!body.spools || body.spools.length === 0)) {
    body.spools = [{ label: "", totalWeight: body.totalWeight }];
    body.totalWeight = null;
  }

  try {
    // Validate parentId if provided
    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
      if (!parent) {
        return errorResponse("Parent filament not found", 400);
      }
      // Prevent nested inheritance (parent cannot itself be a variant)
      if (parent.parentId) {
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      // Variants should inherit diameter from the parent unless the client
      // explicitly provides one. Without this, Mongoose's schema default of
      // 1.75 materialises on the new variant and silently overrides a
      // parent's non-1.75 diameter (e.g. 2.85mm). GH #106.
      if (body.diameter === undefined || body.diameter === null || body.diameter === "") {
        body.diameter = null;
      }
    }

    const filament = await Filament.create(body);
    return NextResponse.json(filament, { status: 201 });
  } catch (err: unknown) {
    const dupResponse = handleDuplicateKeyError(err, "filament");
    if (dupResponse) return dupResponse;
    return errorResponse("Failed to create filament", 500, getErrorMessage(err));
  }
}
