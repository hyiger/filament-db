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
    // GH #424: PUT was spreading the entire request body and stripping
    // only a handful of internal fields. That left every future Location
    // schema field automatically client-writable, including any
    // ownership / sharing flags added later. Use an explicit allowlist
    // (matches the Filament PUT pattern) so the editable surface is
    // documented in the code and a new field has to be opted in.
    const update: Record<string, unknown> = {};
    if ("name" in body) update.name = body.name;
    if ("kind" in body) update.kind = body.kind;
    if ("humidity" in body) update.humidity = body.humidity;
    if ("desiccantChangedAt" in body) {
      // Mongoose casts an ISO-shaped-but-impossible date (Feb 30, month 13)
      // by rolling it over rather than rejecting it, so validate the string
      // explicitly first — same posture as the spool date fields (GH #372).
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

    // Prevent deleting a location that is referenced by any spool. Users
    // should reassign spools to another location (or null) first.
    //
    // GH #629: trashed filaments count too — a filament in the trash can be
    // restored, which would resurrect a dangling locationId ref if the
    // location were deleted in the meantime. Only `_purged` tombstones are
    // gone forever and don't block.
    //
    // GH #1106: the blocking PREDICATE below is byte-identical to the old
    // countDocuments — excluding retired spools would delete the location out
    // from under them and leave a dangling locationId. What changed is the
    // REPORTING: the old message said "N filaments, possibly including
    // filaments in the trash", which is unactionable when the /locations row
    // beside the button reads "Spools 0" (it counted only non-retired spools
    // on active filaments). Now the response names the filaments and splits
    // the counts, so the UI can say which bucket is holding the location.
    //
    // TRAP: aggregate() performs NO query casting, unlike the countDocuments
    // this replaces. Passing the raw `id` string against an ObjectId-typed
    // `spools.locationId` matches NOTHING, and the delete would silently
    // succeed. The explicit ObjectId construction is load-bearing — and it
    // needs the isValidObjectId guard above it, because a malformed id throws
    // a BSONError here rather than the Mongoose CastError the old path
    // produced.
    if (!mongoose.isValidObjectId(id)) {
      return errorResponse("Invalid location id", 400);
    }
    const locationOid = new mongoose.Types.ObjectId(id);
    const blockerRows = await Filament.aggregate([
      // Predicate shared with GH #1149's dependents counter — see
      // src/lib/entityDependents.ts; the two must not drift. Passed the
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
