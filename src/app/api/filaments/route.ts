import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse, handleDuplicateKeyError } from "@/lib/apiErrorHandler";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function GET(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const type = searchParams.get("type");
    const vendor = searchParams.get("vendor");
    const search = searchParams.get("search");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (type) filter.type = type;
    if (vendor) filter.vendor = vendor;
    if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };

    const filaments = await Filament.find(filter).sort({ name: 1 }).lean();
    return NextResponse.json(filaments);
  } catch (err) {
    return errorResponse("Failed to fetch filaments", 500, getErrorMessage(err));
  }
}

export async function POST(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  delete body._id;
  delete body._deletedAt;
  delete body.createdAt;
  delete body.updatedAt;
  delete body.__v;
  delete body.instanceId;
  delete body.syncId;

  // If an initial totalWeight is provided, auto-create a spool entry
  if (body.totalWeight != null && (!body.spools || body.spools.length === 0)) {
    body.spools = [{ label: "", totalWeight: body.totalWeight }];
    body.totalWeight = null;
  }

  try {
    // Validate parentId if provided
    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
      if (!parent) {
        return errorResponse("Parent filament not found", 400);
      }
      // Prevent nested inheritance (parent cannot itself be a variant)
      if (parent.parentId) {
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      // Variants should inherit diameter from the parent unless the client
      // explicitly provides one. Without this, Mongoose's schema default of
      // 1.75 materialises on the new variant and silently overrides a
      // parent's non-1.75 diameter (e.g. 2.85mm). GH #106.
      if (body.diameter === undefined || body.diameter === null || body.diameter === "") {
        body.diameter = null;
      }
    }

    const filament = await Filament.create(body);
    return NextResponse.json(filament, { status: 201 });
  } catch (err: unknown) {
    const dupResponse = handleDuplicateKeyError(err, "filament");
    if (dupResponse) return dupResponse;
    return errorResponse("Failed to create filament", 500, getErrorMessage(err));
  }
}
