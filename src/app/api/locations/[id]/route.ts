import { NextRequest, NextResponse } from "next/server";
import {
  survivorNameConflict,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Location from "@/models/Location";
import Filament from "@/models/Filament";
import {
  summarizeLocationBlockers,
  locationBlockerMessage,
  type LocationBlockerDoc,
} from "@/lib/locationDeleteBlockers";
import { errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { locationSpoolRefFilter } from "@/lib/entityDependents";
import { isValidIsoDateString } from "@/lib/validateSpoolBody";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const location = await Location.findOne({ _id: id, _deletedAt: null }).lean();
    if (!location) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(location);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to fetch location");
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
    const { id } = await params;
    // GH #424: explicit allowlist — spreading the body would leave every
    // future Location schema field automatically client-writable; a new
    // field must be opted in here.
    const update: Record<string, unknown> = {};
    if ("name" in body) update.name = body.name;
    if ("kind" in body) update.kind = body.kind;
    if ("humidity" in body) update.humidity = body.humidity;
    if ("desiccantChangedAt" in body) {
      // Mongoose ROLLS OVER an ISO-shaped-but-impossible date rather than
      // rejecting it — validate the string first (GH #372 posture).
      const raw = body.desiccantChangedAt;
      if (raw !== null && !(typeof raw === "string" && isValidIsoDateString(raw))) {
        return errorResponse("desiccantChangedAt must be an ISO date string or null", 400);
      }
      update.desiccantChangedAt = raw;
    }
    if ("notes" in body) update.notes = body.notes;
    // GH #1116: a RENAME needs the same trimmed check as the create — the
    // index compares raw stored strings, so renaming onto a surviving
    // untrimmed spelling does not collide and leaves two rows rendering
    // identically. `id` excludes this row itself.
    const nameConflict = await survivorNameConflict(
      Location.collection as unknown as MinimalNameCollection,
      (body as { name?: unknown }).name,
      id,
    );
    if (nameConflict) {
      return errorResponse(
        `A location with that name already exists: "${String((body as { name?: unknown }).name).trim()}"`,
        409,
      );
    }
    const location = await Location.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      update,
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!location) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(location);
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "location");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to update location");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { id } = await params;

    // Refuse to delete a location any spool still references — reassign
    // first. GH #629: trashed filaments count too (a restore would
    // resurrect a dangling locationId); only `_purged` tombstones don't
    // block. GH #1106: retired spools also block (excluding them would
    // delete the location out from under them); the response names the
    // filaments and splits the counts so the UI can say which bucket is
    // holding the location.
    //
    // TRAP: aggregate() performs NO query casting. Passing the raw `id`
    // string against an ObjectId-typed `spools.locationId` matches NOTHING
    // and the delete would silently succeed — the explicit ObjectId
    // construction is load-bearing, and it needs the isValidObjectId guard
    // above it (a malformed id throws a BSONError here).
    if (!mongoose.isValidObjectId(id)) {
      return errorResponse("Invalid location id", 400);
    }
    const locationOid = new mongoose.Types.ObjectId(id);
    const blockerRows = await Filament.aggregate([
      // Predicate shared with the dependents counter
      // (src/lib/entityDependents.ts) — the two must not drift. Passed the
      // ObjectId because $match performs no casting (the trap above).
      { $match: locationSpoolRefFilter(locationOid) },
      {
        $project: {
          name: 1,
          // CLAUDE.md quirk: { $eq: ["$missingField", null] } is FALSE in
          // aggregation — missing is its own BSON type. Wrap in $ifNull first.
          trashed: { $ne: [{ $ifNull: ["$_deletedAt", null] }, null] },
          activeSpoolsHere: {
            $size: {
              $filter: {
                input: { $ifNull: ["$spools", []] },
                as: "s",
                cond: {
                  $and: [
                    { $eq: ["$$s.locationId", locationOid] },
                    { $ne: ["$$s.retired", true] },
                  ],
                },
              },
            },
          },
          retiredSpoolsHere: {
            $size: {
              $filter: {
                input: { $ifNull: ["$spools", []] },
                as: "s",
                cond: {
                  $and: [
                    { $eq: ["$$s.locationId", locationOid] },
                    { $eq: ["$$s.retired", true] },
                  ],
                },
              },
            },
          },
        },
      },
      // Deterministic sampling for the names we surface.
      { $sort: { name: 1 } },
    ]);

    const blockers = summarizeLocationBlockers(blockerRows as LocationBlockerDoc[]);
    if (blockers.blocked) {
      return NextResponse.json(
        {
          error: locationBlockerMessage(blockers),
          code: "location_in_use",
          locationId: id,
          ...blockers,
        },
        { status: 400 },
      );
    }

    const location = await Location.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
      { returnDocument: "after" }
    ).lean();
    if (!location) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete location");
  }
}
