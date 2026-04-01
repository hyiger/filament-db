import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse, handleDuplicateKeyError } from "@/lib/apiErrorHandler";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  const searchParams = request.nextUrl.searchParams;
  const type = searchParams.get("type");
  const vendor = searchParams.get("vendor");
  const search = searchParams.get("search");

  const filter: Record<string, unknown> = { _deletedAt: null };
  if (type) filter.type = type;
  if (vendor) filter.vendor = vendor;
  if (search) filter.name = { $regex: search, $options: "i" };

  const filaments = await Filament.find(filter).sort({ name: 1 }).lean();
  return NextResponse.json(filaments);
}

export async function POST(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  const body = await request.json();

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
  }

  // If an initial totalWeight is provided, auto-create a spool entry
  if (body.totalWeight != null && (!body.spools || body.spools.length === 0)) {
    body.spools = [{ label: "", totalWeight: body.totalWeight }];
    body.totalWeight = null;
  }

  try {
    const filament = await Filament.create(body);
    return NextResponse.json(filament, { status: 201 });
  } catch (err: unknown) {
    const dupResponse = handleDuplicateKeyError(err, "filament");
    if (dupResponse) return dupResponse;
    return errorResponse("Failed to create filament", 500, getErrorMessage(err));
  }
}
