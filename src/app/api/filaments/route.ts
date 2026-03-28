import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function GET(request: NextRequest) {
  await dbConnect();

  const searchParams = request.nextUrl.searchParams;
  const type = searchParams.get("type");
  const vendor = searchParams.get("vendor");
  const search = searchParams.get("search");

  const filter: Record<string, unknown> = {};
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
    const parent = await Filament.findById(body.parentId).lean();
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

  const filament = await Filament.create(body);
  return NextResponse.json(filament, { status: 201 });
}
