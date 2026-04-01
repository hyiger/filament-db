import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Nozzle from "@/models/Nozzle";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const searchParams = request.nextUrl.searchParams;
    const diameter = searchParams.get("diameter");
    const type = searchParams.get("type");
    const highFlow = searchParams.get("highFlow");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (diameter) filter.diameter = parseFloat(diameter);
    if (type) filter.type = type;
    if (highFlow) filter.highFlow = highFlow === "true";

    const nozzles = await Nozzle.find(filter).sort({ diameter: 1, type: 1 }).lean();
    return NextResponse.json(nozzles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to fetch nozzles", detail: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await dbConnect();

    const body = await request.json();
    const nozzle = await Nozzle.create(body);
    return NextResponse.json(nozzle, { status: 201 });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: number }).code === 11000) {
      return NextResponse.json({ error: "A nozzle with that name already exists" }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to create nozzle", detail: message }, { status: 500 });
  }
}
