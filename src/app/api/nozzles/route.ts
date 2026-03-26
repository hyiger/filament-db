import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";

export async function GET(request: NextRequest) {
  await dbConnect();

  const searchParams = request.nextUrl.searchParams;
  const diameter = searchParams.get("diameter");
  const type = searchParams.get("type");
  const highFlow = searchParams.get("highFlow");

  const filter: Record<string, unknown> = {};
  if (diameter) filter.diameter = parseFloat(diameter);
  if (type) filter.type = type;
  if (highFlow) filter.highFlow = highFlow === "true";

  const nozzles = await Nozzle.find(filter).sort({ diameter: 1, type: 1 }).lean();
  return NextResponse.json(nozzles);
}

export async function POST(request: NextRequest) {
  await dbConnect();

  const body = await request.json();
  const nozzle = await Nozzle.create(body);
  return NextResponse.json(nozzle, { status: 201 });
}
