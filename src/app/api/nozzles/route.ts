import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import { getErrorMessage, errorResponse, handleDuplicateKeyError } from "@/lib/apiErrorHandler";

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

    // Attach the list of printers each nozzle is installed in, so the UI can
    // differentiate otherwise-identical nozzles (e.g. a Diamondback 0.4 in the
    // Core One vs. the H2D). Uses the reverse lookup through
    // Printer.installedNozzles so no schema change is needed.
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
    const printerIds: string[] | undefined = Array.isArray(body.printerIds)
      ? body.printerIds
      : undefined;
    delete body.printerIds;
    delete body.printers;

    const nozzle = await Nozzle.create(body);

    if (printerIds && printerIds.length > 0) {
      await Printer.updateMany(
        { _id: { $in: printerIds }, _deletedAt: null },
        { $addToSet: { installedNozzles: nozzle._id } }
      );
    }

    return NextResponse.json(nozzle, { status: 201 });
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "nozzle");
    if (dupResponse) return dupResponse;
    return errorResponse("Failed to create nozzle", 500, getErrorMessage(err));
  }
}
