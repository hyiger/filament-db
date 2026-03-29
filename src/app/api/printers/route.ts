import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Printer from "@/models/Printer";

export async function GET(request: NextRequest) {
  await dbConnect();

  const searchParams = request.nextUrl.searchParams;
  const manufacturer = searchParams.get("manufacturer");

  const filter: Record<string, unknown> = { _deletedAt: null };
  if (manufacturer) filter.manufacturer = manufacturer;

  const printers = await Printer.find(filter)
    .sort({ manufacturer: 1, name: 1 })
    .populate("installedNozzles")
    .lean();
  return NextResponse.json(printers);
}

export async function POST(request: NextRequest) {
  await dbConnect();

  const body = await request.json();
  const printer = await Printer.create(body);
  return NextResponse.json(printer, { status: 201 });
}
