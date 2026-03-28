import { NextRequest, NextResponse } from "next/server";
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

  return NextResponse.json({ filaments });
}
