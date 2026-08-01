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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Reject non-numeric totalWeight and non-string label up front so Mongoose
  // doesn't silently store bad types that break downstream weight math.
  const validation = validateSpoolBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // remainingWeight is a PUT-only convenience: resolving it to an absolute
  // totalWeight needs the spool's tare, which only makes sense for an existing
  // spool. Reject it loudly on create rather than silently dropping it (the
  // create path writes totalWeight directly).
  if ((body as Record<string, unknown>).remainingWeight !== undefined) {
    return NextResponse.json(
      {
        error:
          "remainingWeight is only supported when updating a spool (PUT); use totalWeight when creating one",
      },
      { status: 400 },
    );
  }

  // GH #203: validateSpoolBody (POST mode) defaults missing fields to
  // empty string / null, so an empty `{}` request previously created a
  // phantom spool with no label, no weight, no metadata. Require the
  // caller to explicitly supply something — totalWeight or any of the
  // other meaningful fields. The CSV importer enforces the same
  // contract via its required-column check on `totalWeight`.
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

    // GH #425: validate the filament id up front — a garbage id used to
    // surface as a 500 "Failed to add spool" from a downstream CastError
    // rather than a 400 with a useful message.
    if (!mongoose.isValidObjectId(id)) {
      return errorResponse("Invalid filament id", 400);
    }

    // GH #953: a new spool's locationId must reference an active Location, so a
    // dangling ref can't persist and produce a phantom "no location" group in
    // every location-grouped view.
    const locGuard = await assertActiveSpoolLocation(Location, validation.locationId);
    if (locGuard) return locGuard;

    // Only push fields the validator captured. Previously the $push
    // dropped lotNumber / purchaseDate / openedDate / locationId /
    // photoDataUrl / retired even when the client supplied them — a
    // separate latent bug paired with the empty-body phantom (GH #203).
    const newSpool: Record<string, unknown> = {};
    // #732: stamp the spool id explicitly ($push doesn't reliably apply the
    // schema default). Phase 4: a client may register an EXPLICIT id (e.g. a
    // Prusa roll id — charset/length already validated); it's uniqueness-checked
    // vs other spools so the match path stays unambiguous. Otherwise
    // auto-generate.
    if (validation.instanceId !== undefined) {
      // Best-effort uniqueness: a read-then-write check, not a DB unique
      // constraint (the spools.instanceId index is non-unique multikey). A
      // concurrent identical manual entry could slip a duplicate through; the
      // matcher tolerates that by returning ambiguous candidates rather than an
      // arbitrary pick, and auto-generated ids never collide — acceptable for a
      // single-user/self-host app (a DB-level guard is deferred to a Phase-5
      // spool-syncId migration).
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
    // lives on its color variants, never on the template itself. Enforced
    // forward only: spools a legacy parent already carries stay untouched,
    // but no NEW spool may land here (same variant-existence check the
    // DELETE guard uses). The check-push-recheck-compensate sequence lives
    // in pushSpoolWithTemplateGuard so a concurrent first-variant creation
    // between check and $push can't strand a fresh spool on a template —
    // the guard re-checks after the push and pulls the spool back out.
    //
    // Review P1-a companion: the guard runs inside the same per-id lock
    // the promotion paths take (belt), so within this process a spool push
    // and a first-variant promotion strictly serialize — a spool accepted
    // here is visible to the promotion's fresh snapshot and moves with the
    // inventory; one queued behind a promotion sees hasVariants=true and
    // 400s. The guard's own re-check + compensating $pull stays (braces)
    // for writers outside the process (see src/lib/filamentMutex.ts).
    const result = await runExclusive(filamentLockKey(id), () =>
      pushSpoolWithTemplateGuard(Filament, id, newSpool, hasVariants),
    );

    if (result.outcome === "template") {
      // Shared body constant (codex round 3, Finding B) so this route and
      // the Prusament importer answer byte-identically.
      return NextResponse.json(TEMPLATE_NO_SPOOLS_BODY, { status: 400 });
    }
    if (result.outcome === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // GH #341: align with the other create endpoints (nozzles, printers,
    // bed-types, locations, filaments, print-history) which all return 201
    // on a successful POST. This used to return 200 which violates the
    // documented REST semantics and trips polite HTTP clients.
    return NextResponse.json(result.filament, { status: 201 });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to add spool");
  }
}
