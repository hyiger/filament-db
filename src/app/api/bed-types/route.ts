import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import BedType from "@/models/BedType";
import Printer from "@/models/Printer";
import { getErrorMessage, errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const searchParams = request.nextUrl.searchParams;
    const material = searchParams.get("material");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (material) filter.material = material;

    const bedTypes = await BedType.find(filter).sort({ name: 1 }).lean();

    // Attach the list of printers each bed type is available on, mirroring
    // the nozzle list's "Installed In" enrichment. Bed types are a shared
    // catalog, so a single bed type can appear on many printers — the
    // reverse lookup runs through Printer.installedBedTypes.
    const printers = await Printer.find({ _deletedAt: null })
      .select("_id name installedBedTypes")
      .lean();
    const bedTypeIdToPrinters = new Map<string, { _id: string; name: string }[]>();
    for (const p of printers) {
      for (const bid of p.installedBedTypes || []) {
        const key = String(bid);
        const list = bedTypeIdToPrinters.get(key) ?? [];
        list.push({ _id: String(p._id), name: p.name });
        bedTypeIdToPrinters.set(key, list);
      }
    }
    const enriched = bedTypes.map((b) => ({
      ...b,
      printers: bedTypeIdToPrinters.get(String(b._id)) ?? [],
    }));

    return NextResponse.json(enriched);
  } catch (err) {
    return errorResponse("Failed to fetch bed types", 500, getErrorMessage(err));
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
    delete body.syncId;
    const bedType = await BedType.create(body);
    return NextResponse.json(bedType, { status: 201 });
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "bed type");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to create bed type");
  }
}
