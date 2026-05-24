import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { nextCloneName, clonePeerNamePattern } from "@/lib/nozzleConflicts";

/**
 * POST /api/nozzles/{id}/clone
 *
 * GH #232 — clone an existing nozzle into a new physical-instance row.
 *
 * Use case: PrinterForm just hit a 409 conflict (the nozzle the user
 * picked is already installed in another printer). The "Clone" choice
 * from the resolution modal calls this endpoint to mint an
 * identically-specced nozzle under a "Name #2" / "Name #3" suffix, then
 * assigns the new id to this printer instead of the conflicting one.
 *
 * The clone shares every spec field (diameter, type, highFlow, hardened,
 * notes) but starts with a fresh `_id`, fresh `syncId` (null — the hybrid-
 * sync engine assigns one on first publish), and fresh timestamps. It is
 * NOT auto-attached to any printer — the caller is responsible for the
 * follow-up assignment, because this endpoint deliberately doesn't know
 * which printer triggered the clone.
 */
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

    // Pick the next available "Name #N" suffix among non-deleted nozzles
    // so the clone is visually distinguishable from its siblings in the
    // /nozzles list. GH #298: the pattern is anchored at both ends, so
    // it matches only the base name + its numbered clones — not
    // unrelated siblings that share a prefix.
    const peers = await Nozzle.find({
      _deletedAt: null,
      name: { $regex: clonePeerNamePattern(source.name) },
    })
      .select("name")
      .lean();
    const newName = nextCloneName(
      source.name,
      peers.map((p) => p.name),
    );

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
