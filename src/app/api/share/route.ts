import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import SharedCatalog from "@/models/SharedCatalog";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/share — list all shared catalogs the user has published.
 */
export async function GET() {
  try {
    await dbConnect();
    const catalogs = await SharedCatalog.find({})
      .select("slug title description expiresAt viewCount createdAt updatedAt")
      .sort({ createdAt: -1 })
      .lean();
    return NextResponse.json(catalogs);
  } catch (err) {
    return errorResponse("Failed to list shared catalogs", 500, getErrorMessage(err));
  }
}

/**
 * POST /api/share — publish a new shared catalog.
 *
 * Body: { title: string, description?: string, filamentIds: string[], expiresAt?: string }
 *
 * Resolves the listed filaments plus every nozzle/printer/bedType they
 * reference, denormalises them into the catalog payload, and returns the
 * public slug. The snapshot is static: later edits to the source filaments
 * do not change what someone else downloaded.
 */
export async function POST(request: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  if (!body || typeof body !== "object") {
    return errorResponse("Request body must be an object", 400);
  }
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return errorResponse("title is required", 400);
  }
  // Length bounds keep a pathological publisher from writing multi-MB
  // documents into the shared catalog; the UI surfaces far smaller caps.
  if (body.title.length > 200) {
    return errorResponse("title must be 200 characters or fewer", 400);
  }
  if (typeof body.description === "string" && body.description.length > 5000) {
    return errorResponse("description must be 5000 characters or fewer", 400);
  }
  if (!Array.isArray(body.filamentIds) || body.filamentIds.length === 0) {
    return errorResponse("filamentIds must be a non-empty array", 400);
  }
  if (body.filamentIds.length > 500) {
    return errorResponse("filamentIds may contain at most 500 entries", 400);
  }

  try {
    await dbConnect();

    const filaments = await Filament.find({
      _id: { $in: body.filamentIds },
      _deletedAt: null,
    }).lean();

    if (filaments.length === 0) {
      return errorResponse("No matching filaments found", 404);
    }

    // Collect referenced IDs across every filament so the downloader can
    // rehydrate nozzle/printer/bedType refs on the destination side.
    const nozzleIds = new Set<string>();
    const printerIds = new Set<string>();
    const bedTypeIds = new Set<string>();
    for (const f of filaments) {
      for (const nid of f.compatibleNozzles || []) nozzleIds.add(String(nid));
      for (const cal of f.calibrations || []) {
        if (cal.nozzle) nozzleIds.add(String(cal.nozzle));
        if (cal.printer) printerIds.add(String(cal.printer));
        if (cal.bedType) bedTypeIds.add(String(cal.bedType));
      }
    }

    const [nozzles, printers, bedTypes] = await Promise.all([
      Nozzle.find({ _id: { $in: Array.from(nozzleIds) }, _deletedAt: null }).lean(),
      Printer.find({ _id: { $in: Array.from(printerIds) }, _deletedAt: null }).lean(),
      BedType.find({ _id: { $in: Array.from(bedTypeIds) }, _deletedAt: null }).lean(),
    ]);

    const payload = {
      version: 1,
      createdAt: new Date().toISOString(),
      filaments,
      nozzles,
      printers,
      bedTypes,
    };

    const expiresAt =
      typeof body.expiresAt === "string" && body.expiresAt
        ? new Date(body.expiresAt)
        : null;

    const catalog = await SharedCatalog.create({
      title: body.title.trim(),
      description: typeof body.description === "string" ? body.description : "",
      payload,
      expiresAt,
    });

    return NextResponse.json(
      { slug: catalog.slug, title: catalog.title, createdAt: catalog.createdAt },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse("Failed to publish shared catalog", 500, getErrorMessage(err));
  }
}
