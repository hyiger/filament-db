import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("dbConnect failed in GET /api/filaments:", message);
    return NextResponse.json(
      { error: "Database connection failed", detail: message },
      { status: 500 },
    );
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
  await dbConnect();

  const body = await request.json();

  // Validate parentId if provided
  if (body.parentId) {
    const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
    if (!parent) {
      return NextResponse.json({ error: "Parent filament not found" }, { status: 400 });
    }
    // Prevent nested inheritance (parent cannot itself be a variant)
    if (parent.parentId) {
      return NextResponse.json(
        { error: "Cannot set a variant as parent (no nested inheritance)" },
        { status: 400 },
      );
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
    // Duplicate key (e.g. name already exists)
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: number }).code === 11000) {
      const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue;
      const field = keyValue ? Object.keys(keyValue)[0] : "field";
      const value = keyValue ? Object.values(keyValue)[0] : "unknown";
      return NextResponse.json(
        { error: `A filament with that ${field} already exists: "${value}"` },
        { status: 409 },
      );
    }
    throw err;
  }
}
