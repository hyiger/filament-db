import { NextRequest, NextResponse } from "next/server";
import { parseIniFilaments } from "@/lib/parseIni";
import { collapsePerNozzleImportSections } from "@/lib/prusaSlicerBundle";
import { assertMultipartFormData, checkFileSize } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // GH #338: bad content-type is client input, not a server fault — 400 + clear message.
  const ctError = assertMultipartFormData(request);
  if (ctError) return ctError;
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const sizeError = checkFileSize(file);
    if (sizeError) return sizeError;

    const content = await file.text();
    // #872: fold Filament DB's own per-nozzle suffixed sections back into their
    // base so the new-filament prefill shows the base name (not "PLA 0.4 Brass")
    // and doesn't carry one nozzle's baked values into the form (Codex P2).
    const filaments = collapsePerNozzleImportSections(parseIniFilaments(content));

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
