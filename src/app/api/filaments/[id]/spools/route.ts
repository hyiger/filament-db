import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { validateSpoolBody } from "@/lib/validateSpoolBody";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

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
  ];
  const supplied = meaningfulKeys.some((k) => rawBody[k] !== undefined);
  if (!supplied) {
    return NextResponse.json(
      {
        error:
          "At least one of label, totalWeight, lotNumber, purchaseDate, openedDate, locationId, photoDataUrl, or retired is required",
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

    // Only push fields the validator captured. Previously the $push
    // dropped lotNumber / purchaseDate / openedDate / locationId /
    // photoDataUrl / retired even when the client supplied them — a
    // separate latent bug paired with the empty-body phantom (GH #203).
    const newSpool: Record<string, unknown> = {};
    if (validation.label !== undefined) newSpool.label = validation.label;
    if (validation.totalWeight !== undefined) newSpool.totalWeight = validation.totalWeight;
    if (validation.lotNumber !== undefined) newSpool.lotNumber = validation.lotNumber;
    if (validation.purchaseDate !== undefined) newSpool.purchaseDate = validation.purchaseDate;
    if (validation.openedDate !== undefined) newSpool.openedDate = validation.openedDate;
    if (validation.locationId !== undefined) newSpool.locationId = validation.locationId;
    if (validation.photoDataUrl !== undefined) newSpool.photoDataUrl = validation.photoDataUrl;
    if (validation.retired !== undefined) newSpool.retired = validation.retired;

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { $push: { spools: newSpool } },
      { returnDocument: "after" }
    ).lean();

    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // GH #341: align with the other create endpoints (nozzles, printers,
    // bed-types, locations, filaments, print-history) which all return 201
    // on a successful POST. This used to return 200 which violates the
    // documented REST semantics and trips polite HTTP clients.
    return NextResponse.json(filament, { status: 201 });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to add spool");
  }
}
