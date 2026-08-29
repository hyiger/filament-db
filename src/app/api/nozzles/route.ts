import { NextRequest, NextResponse } from "next/server";
import {
  survivorNameConflict,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import { getErrorMessage, errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { validateNozzlePrinterAssignment } from "@/lib/nozzlePrinterAssignment";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const searchParams = request.nextUrl.searchParams;
    const diameter = searchParams.get("diameter");
    const type = searchParams.get("type");
    const highFlow = searchParams.get("highFlow");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (diameter) { const v = parseFloat(diameter); if (!isNaN(v)) filter.diameter = v; }
    if (type) filter.type = type;
    if (highFlow) filter.highFlow = highFlow === "true";

    const nozzles = await Nozzle.find(filter).sort({ diameter: 1, type: 1 }).lean();

    // Attach the printers each nozzle is installed in (reverse lookup
    // through Printer.installedNozzles — no schema change needed) so the UI
    // can differentiate otherwise-identical nozzles.
    const printers = await Printer.find({ _deletedAt: null })
      .select("_id name installedNozzles")
      .lean();
    const nozzleIdToPrinters = new Map<string, { _id: string; name: string }[]>();
    for (const p of printers) {
      for (const nid of p.installedNozzles || []) {
        const key = String(nid);
        const list = nozzleIdToPrinters.get(key) ?? [];
        list.push({ _id: String(p._id), name: p.name });
        nozzleIdToPrinters.set(key, list);
      }
    }
    const enriched = nozzles.map((n) => ({
      ...n,
      printers: nozzleIdToPrinters.get(String(n._id)) ?? [],
    }));

    return NextResponse.json(enriched);
  } catch (err) {
    return errorResponse("Failed to fetch nozzles", 500, getErrorMessage(err));
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
    delete body.instanceId;
    delete body.syncId;
    // Pull `printerIds` out — it's not a Nozzle field; we use it to update
    // the reverse Printer.installedNozzles relationship after creation.
    const rawPrinterIds: unknown = body.printerIds;
    delete body.printerIds;
    delete body.printers;

    // GH #1083: validate the assignment BEFORE Nozzle.create (shared helper
    // with the PUT route: dedupe → at most one printer → valid ObjectId →
    // live target) — a rejected assignment must not leave a committed
    // nozzle behind, and a multi-printer array would bypass the
    // one-printer-per-nozzle invariant (#232).
    const assignment = await validateNozzlePrinterAssignment(
      rawPrinterIds,
      (targetId) =>
        Printer.findOne({ _id: targetId, _deletedAt: null }, { _id: 1 }).lean(),
    );
    if (!assignment.ok) {
      return errorResponse(assignment.message, 400);
    }

    // GH #1116: the partial unique index compares RAW stored strings, so a
    // submitted "0.4 Brass" beside a surviving untrimmed "0.4 Brass " would
    // write an indistinguishable duplicate. Ask the trimmed question
    // explicitly, in the same 409 shape handleDuplicateKeyError produces.
    const nameConflict = await survivorNameConflict(
      Nozzle.collection as unknown as MinimalNameCollection,
      body.name,
    );
    if (nameConflict) {
      return errorResponse(
        `A nozzle with that name already exists: "${String(body.name).trim()}"`,
        409,
      );
    }
    const nozzle = await Nozzle.create(body);

    if (assignment.targetId) {
      await Printer.updateMany(
        { _id: assignment.targetId, _deletedAt: null },
        { $addToSet: { installedNozzles: nozzle._id } }
      );
    }

    return NextResponse.json(nozzle, { status: 201 });
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "nozzle");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to create nozzle");
  }
}
