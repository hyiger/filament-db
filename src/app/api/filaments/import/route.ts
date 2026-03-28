import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { parseIniFilaments } from "@/lib/parseIni";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const content = await file.text();
  const filaments = parseIniFilaments(content);

  if (filaments.length === 0) {
    return NextResponse.json(
      { error: "No filament profiles found in the INI file" },
      { status: 400 }
    );
  }

  await dbConnect();

  let created = 0;
  let updated = 0;

  for (const filament of filaments) {
    const existing = await Filament.findOne({ name: filament.name, _deletedAt: null });
    if (existing) {
      await Filament.updateOne({ name: filament.name }, filament);
      updated++;
    } else {
      await Filament.create(filament);
      created++;
    }
  }

  return NextResponse.json({
    message: `Imported ${filaments.length} filaments (${created} new, ${updated} updated)`,
    total: filaments.length,
    created,
    updated,
  });
}
