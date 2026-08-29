import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import SharedCatalog from "@/models/SharedCatalog";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { pickSharedFilamentFields } from "@/lib/sharePublicFields";

/**
 * GET /api/share — list all shared catalogs the user has published.
 */
export async function GET() {
  try {
    await dbConnect();
    const catalogs = await SharedCatalog.find({ _deletedAt: null })
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
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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
  // GH #630: a non-ObjectId entry would CastError inside the `$in` query
  // into a 500 — validate up front and 400.
  const invalidIds = (body.filamentIds as unknown[]).filter(
    (id) => typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id),
  );
  if (invalidIds.length > 0) {
    return errorResponse(
      `Invalid filament ID(s): ${invalidIds.map(String).join(", ")}`,
      400,
    );
  }

  try {
    await dbConnect();

    const rawFilaments = await Filament.find({
      _id: { $in: body.filamentIds },
      _deletedAt: null,
    }).lean();

    if (rawFilaments.length === 0) {
      return errorResponse("No matching filaments found", 404);
    }

    // Collect referenced IDs across every filament so the downloader can
    // rehydrate nozzle/printer/bedType refs on the destination side.
    const nozzleIds = new Set<string>();
    const printerIds = new Set<string>();
    const bedTypeIds = new Set<string>();
    for (const f of rawFilaments) {
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

    // GH #1122: project each filament down to an ALLOW-LIST. A deny-list
    // leaks by default — /share/{slug} is unauthenticated, so every field
    // added to the schema afterwards became public unless someone
    // remembered to deny it (it already published `cost` alongside internal
    // bookkeeping). See src/lib/sharePublicFields.ts for what is on the
    // list and why.
    const filaments = rawFilaments.map((f) =>
      pickSharedFilamentFields(f as unknown as Record<string, unknown>),
    );

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
    // GH #426: a malformed `expiresAt` parses to Invalid Date — persisted,
    // it makes the catalog effectively immortal (`$gt: now` compares
    // against NaN and the expiry branch is silently bypassed). Reject up
    // front.
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return errorResponse("expiresAt is not a valid date", 400);
    }

    // GH #282: the catalog document must stay under MongoDB's 16MB BSON
    // limit — reject with a clear message before the write rather than
    // letting Mongo hard-fail mid-insert.
    const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024; // 12MB — headroom under 16MB
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      return errorResponse(
        `This catalog is too large to publish (${(payloadBytes / 1024 / 1024).toFixed(1)}MB). ` +
          `Select fewer filaments — the limit is ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB.`,
        413,
      );
    }

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
