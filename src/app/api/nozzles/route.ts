import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";
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
    return NextResponse.json(nozzles);
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
    const nozzle = await Nozzle.create(body);
    return NextResponse.json(nozzle, { status: 201 });
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "nozzle");
    if (dupResponse) return dupResponse;
    return errorResponse("Failed to create nozzle", 500, getErrorMessage(err));
  }
}
