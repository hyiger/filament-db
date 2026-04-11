import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import BedType from "@/models/BedType";
import { getErrorMessage, errorResponse, handleDuplicateKeyError } from "@/lib/apiErrorHandler";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const searchParams = request.nextUrl.searchParams;
    const material = searchParams.get("material");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (material) filter.material = material;

    const bedTypes = await BedType.find(filter).sort({ name: 1 }).lean();
    return NextResponse.json(bedTypes);
  } catch (err) {
    return errorResponse("Failed to fetch bed types", 500, getErrorMessage(err));
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
    delete body.syncId;
    const bedType = await BedType.create(body);
    return NextResponse.json(bedType, { status: 201 });
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "bed type");
    if (dupResponse) return dupResponse;
    return errorResponse("Failed to create bed type", 500, getErrorMessage(err));
  }
}
