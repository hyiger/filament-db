import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId, isSpoolInstanceIdTaken } from "@/models/Filament";
import Location from "@/models/Location";
import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { pushSpoolWithTemplateGuard, TEMPLATE_NO_SPOOLS_BODY } from "@/lib/spoolTemplateGuard";
import { validateSpoolBody } from "@/lib/validateSpoolBody";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { errorResponse, errorResponseFromCaught, assertActiveSpoolLocation } from "@/lib/apiErrorHandler";
import {
  parseSpoolResponseShape,
  findSpoolByInstanceId,
  INVALID_SHAPE_MESSAGE,
} from "@/lib/spoolResponseShape";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // GH #1027: ?shape=spool returns just the created spool (with its
  // server-minted _id + instanceId) instead of the whole filament doc.
  const shape = parseSpoolResponseShape(request.nextUrl.searchParams);
  if (shape === null) {
    return errorResponse(INVALID_SHAPE_MESSAGE, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate up front so Mongoose doesn't silently store bad types that
  // break downstream weight math.
  const validation = validateSpoolBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // remainingWeight is a PUT-only convenience — reject it loudly on create
  // rather than silently dropping it.
  if ((body as Record<string, unknown>).remainingWeight !== undefined) {
    return NextResponse.json(
      {
        error:
          "remainingWeight is only supported when updating a spool (PUT); use totalWeight when creating one",
      },
      { status: 400 },
    );
  }

  // GH #203: validateSpoolBody (POST mode) defaults missing fields, so an
  // empty `{}` request would create a phantom spool. Require the caller to
  // explicitly supply something meaningful (the CSV importer enforces the
  // same contract via its required `totalWeight` column).
  const rawBody = body as Record<string, unknown>;
  const meaningfulKeys = [
    "label",
    "totalWeight",
    "lotNumber",
    "purchaseDate",
    "openedDate",
    "locationId",
    "photoDataUrl",
    "retired",
    // #732 Phase 4: an id-only create (e.g. registering a Prusa roll id) is
    // meaningful — don't trip the empty-body phantom-spool guard.
    "instanceId",
  ];
  const supplied = meaningfulKeys.some((k) => rawBody[k] !== undefined);
  if (!supplied) {
    return NextResponse.json(
      {
        error:
          "At least one of label, totalWeight, lotNumber, purchaseDate, openedDate, locationId, photoDataUrl, retired, or instanceId is required",
      },
      { status: 400 },
    );
  }

  try {
    await dbConnect();
    const { id } = await params;

    // GH #425: validate the id up front — a garbage id would CastError into
    // a 500 instead of a 400.
    if (!mongoose.isValidObjectId(id)) {
      return errorResponse("Invalid filament id", 400);
    }

    // GH #953: a new spool's locationId must reference an active Location —
    // a dangling ref breaks every location-grouped view.
    const locGuard = await assertActiveSpoolLocation(Location, validation.locationId);
    if (locGuard) return locGuard;

    // Only push fields the validator captured.
    const newSpool: Record<string, unknown> = {};
    // #732: stamp the spool id explicitly ($push doesn't reliably apply the
    // schema default). A client may register an EXPLICIT id (e.g. a Prusa
    // roll id), uniqueness-checked vs other spools; otherwise auto-generate.
    if (validation.instanceId !== undefined) {
      // Best-effort uniqueness: read-then-write, not a DB unique constraint
      // (the spools.instanceId index is non-unique multikey). A concurrent
      // identical manual entry could slip a duplicate through; the matcher
      // tolerates that (ambiguous candidates, never an arbitrary pick).
      if (await isSpoolInstanceIdTaken(validation.instanceId, undefined, id)) {
        return errorResponse("That spool ID is already used by another spool", 409);
      }
      newSpool.instanceId = validation.instanceId;
    } else {
      newSpool.instanceId = generateInstanceId();
    }
    if (validation.label !== undefined) newSpool.label = validation.label;
    if (validation.totalWeight !== undefined) newSpool.totalWeight = validation.totalWeight;
    if (validation.lotNumber !== undefined) newSpool.lotNumber = validation.lotNumber;
    if (validation.purchaseDate !== undefined) newSpool.purchaseDate = validation.purchaseDate;
    if (validation.openedDate !== undefined) newSpool.openedDate = validation.openedDate;
    if (validation.locationId !== undefined) newSpool.locationId = validation.locationId;
    if (validation.photoDataUrl !== undefined) newSpool.photoDataUrl = validation.photoDataUrl;
    if (validation.retired !== undefined) newSpool.retired = validation.retired;

    // GH #605: a filament with ≥1 live variant is a TEMPLATE — inventory
    // lives on its variants, never on the template. Enforced forward only:
    // spools a legacy parent already carries stay untouched, but no NEW
    // spool may land here. The check-push-recheck-compensate sequence lives
    // in pushSpoolWithTemplateGuard so a concurrent first-variant creation
    // between check and $push can't strand a fresh spool on a template.
    //
    // The guard runs inside the same per-id lock the promotion paths take
    // (belt), so in-process a spool push and a first-variant promotion
    // strictly serialize; the guard's own re-check + compensating $pull
    // stays (braces) for writers outside the process.
    const result = await runExclusive(filamentLockKey(id), () =>
      pushSpoolWithTemplateGuard(Filament, id, newSpool, hasVariants),
    );

    if (result.outcome === "template") {
      // Shared body constant so this route and the Prusament importer
      // answer byte-identically.
      return NextResponse.json(TEMPLATE_NO_SPOOLS_BODY, { status: 400 });
    }
    if (result.outcome === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // GH #1027: locate the created spool by the instanceId this route
    // always stamps — the fresh subdoc's _id is minted by the $push, so
    // instanceId is the only pre-known handle. The null guard is
    // unreachable-in-practice defensiveness.
    if (shape === "spool") {
      const spool = findSpoolByInstanceId(
        result.filament.spools,
        newSpool.instanceId as string,
      );
      if (!spool) {
        return errorResponseFromCaught(
          new Error("created spool missing from post-push document"),
          "Failed to add spool",
        );
      }
      return NextResponse.json({ spool }, { status: 201 });
    }
    // GH #341: 201 on create, aligned with the other create endpoints.
    return NextResponse.json(result.filament, { status: 201 });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to add spool");
  }
}
