import { NextRequest, NextResponse } from "next/server";
import {
  survivorNameConflict,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { nextCloneName, clonePeerNamePattern } from "@/lib/nozzleConflicts";

/**
 * POST /api/nozzles/{id}/clone (GH #232) — clone a nozzle into a new
 * physical-instance row under a "Name #2" / "Name #3" suffix (PrinterForm's
 * 409-conflict resolution). The clone shares every spec field but gets a
 * fresh `_id`, a null `syncId` (the sync engine assigns one on first
 * publish), and fresh timestamps. It is NOT auto-attached to any printer —
 * the caller does the follow-up assignment; this endpoint deliberately
 * doesn't know which printer triggered the clone.
 */
/** How many `#N` suffixes to probe before giving up. Each miss consumes one,
 *  so the loop terminates on its own; this only bounds a pathological DB. */
const MAX_CLONE_SUFFIX_PROBES = 50;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { id } = await params;

    const source = await Nozzle.findOne({ _id: id, _deletedAt: null }).lean();
    if (!source) {
      return errorResponse("Source nozzle not found", 404);
    }

    // Pick the next available "Name #N" suffix. GH #298: the pattern is
    // anchored at both ends, so it matches only the base name + its
    // numbered clones — not unrelated siblings sharing a prefix.
    const peers = await Nozzle.find({
      _deletedAt: null,
      name: { $regex: clonePeerNamePattern(source.name) },
    })
      .select("name")
      .lean();
    const peerNames = peers.map((p) => p.name);
    const firstName = nextCloneName(source.name, peerNames);

    // GH #1116: the GENERATED name needs the survivor check too — the peer
    // regex misses an untrimmed survivor, so with an active `"0.4 #2 "` it
    // would pick `"0.4 #2"` and the clone would render identically to the
    // row it failed to see. ADVANCE past a survivor rather than refusing: a
    // survivor is a permanent state (the migration leaves it because it
    // cannot be repaired automatically), so a 409 would make cloning
    // impossible forever even though the next suffix is free — treat it as
    // an occupied suffix and take the next candidate.
    let newName = firstName;
    let attempt = 0;
    let nameConflict: string | null = null;
    // Bounded: each miss consumes one suffix, so this terminates; the cap
    // only stops a pathological database from spinning.
    while (attempt < MAX_CLONE_SUFFIX_PROBES) {
      nameConflict = await survivorNameConflict(
        Nozzle.collection as unknown as MinimalNameCollection,
        newName,
      );
      if (!nameConflict) break;
      attempt += 1;
      newName = nextCloneName(source.name, [...peerNames, newName]);
    }
    if (nameConflict) {
      return errorResponse(
        `Could not find a free name for the clone (last tried "${newName}").`,
        409,
      );
    }

    const cloned = await Nozzle.create({
      name: newName,
      diameter: source.diameter,
      type: source.type,
      highFlow: source.highFlow,
      hardened: source.hardened,
      notes: source.notes,
      // syncId intentionally omitted — let the sync engine assign on
      // first publish. Copying the parent's syncId would make the two
      // rows collide as duplicates.
    });

    return NextResponse.json(cloned, { status: 201 });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to clone nozzle");
  }
}
