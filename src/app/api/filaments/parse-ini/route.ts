import { NextRequest, NextResponse } from "next/server";
import { parseIniFilaments } from "@/lib/parseIni";
import { checkFileSize } from "@/lib/apiErrorHandler";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const sizeError = checkFileSize(file);
    if (sizeError) return sizeError;

    const content = await file.text();
    const filaments = parseIniFilaments(content);

    if (filaments.length === 0) {
      return NextResponse.json(
        { error: "No filament profiles found in the INI file" },
        { status: 400 }
      );
    }

    return NextResponse.json({ filaments });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to parse INI file", details: message },
      { status: 500 }
    );
  }
}
