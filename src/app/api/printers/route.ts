import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Printer from "@/models/Printer";
import Nozzle from "@/models/Nozzle";

export async function GET(request: NextRequest) {
  await dbConnect();

  const searchParams = request.nextUrl.searchParams;
  const manufacturer = searchParams.get("manufacturer");

  const filter: Record<string, unknown> = { _deletedAt: null };
  if (manufacturer) filter.manufacturer = manufacturer;

  const printers = await Printer.find(filter)
    .sort({ manufacturer: 1, name: 1 })
    .populate({ path: "installedNozzles", match: { _deletedAt: null } })
    .lean();
  return NextResponse.json(printers);
}

export async function POST(request: NextRequest) {
  await dbConnect();

  const body = await request.json();

  // Validate that all referenced nozzle IDs exist and are active
  if (body.installedNozzles?.length > 0) {
    const activeCount = await Nozzle.countDocuments({
      _id: { $in: body.installedNozzles },
      _deletedAt: null,
    });
    if (activeCount !== body.installedNozzles.length) {
      return NextResponse.json(
        { error: "One or more selected nozzles no longer exist." },
        { status: 400 },
      );
    }
  }

  const printer = await Printer.create(body);
  return NextResponse.json(printer, { status: 201 });
}
