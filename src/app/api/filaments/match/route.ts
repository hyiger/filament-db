import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export async function GET(request: NextRequest) {
  await dbConnect();

  const params = request.nextUrl.searchParams;
  const name = params.get("name");
  const vendor = params.get("vendor");
  const type = params.get("type");

  // 1. Exact name match (case-insensitive)
  if (name) {
    const exact = await Filament.findOne({
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
    }).lean();
    if (exact) {
      return NextResponse.json({ match: exact, candidates: [] });
    }
  }

  // 2. Vendor + type match
  const candidates = [];
  if (vendor && type) {
    const vendorTypeMatches = await Filament.find({
      vendor: { $regex: escapeRegex(vendor), $options: "i" },
      type: { $regex: `^${escapeRegex(type)}$`, $options: "i" },
    })
      .sort({ name: 1 })
      .limit(5)
      .lean();
    candidates.push(...vendorTypeMatches);
  }

  // 3. Vendor-only matches (if vendor+type found nothing)
  if (candidates.length === 0 && vendor) {
    const vendorMatches = await Filament.find({
      vendor: { $regex: escapeRegex(vendor), $options: "i" },
    })
      .sort({ name: 1 })
      .limit(5)
      .lean();
    candidates.push(...vendorMatches);
  }

  // Best candidate becomes the match if there's exactly one vendor+type hit
  const match = candidates.length === 1 ? candidates[0] : null;

  return NextResponse.json({
    match,
    candidates: match ? [] : candidates,
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
