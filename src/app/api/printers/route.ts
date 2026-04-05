import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Printer from "@/models/Printer";
import Nozzle from "@/models/Nozzle";
import { getErrorMessage, errorResponse, handleDuplicateKeyError } from "@/lib/apiErrorHandler";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const manufacturer = searchParams.get("manufacturer");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (manufacturer) filter.manufacturer = manufacturer;

    const printers = await Printer.find(filter)
      .sort({ manufacturer: 1, name: 1 })
      .populate({ path: "installedNozzles", match: { _deletedAt: null } })
      .lean();
    return NextResponse.json(printers);
  } catch (err) {
    return errorResponse("Failed to fetch printers", 500, getErrorMessage(err));
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

  // Validate that all referenced nozzle IDs exist and are active
  if (body.installedNozzles?.length > 0) {
    const activeCount = await Nozzle.countDocuments({
      _id: { $in: body.installedNozzles },
      _deletedAt: null,
    });
    if (activeCount !== body.installedNozzles.length) {
      return errorResponse("One or more selected nozzles no longer exist.", 400);
    }
  }

  try {
    const printer = await Printer.create(body);
    return NextResponse.json(printer, { status: 201 });
  } catch (err: unknown) {
    const dupResponse = handleDuplicateKeyError(err, "printer");
    if (dupResponse) return dupResponse;
    return errorResponse("Failed to create printer", 500, getErrorMessage(err));
  }
}
