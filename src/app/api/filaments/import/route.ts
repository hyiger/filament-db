import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { parseIniFilaments } from "@/lib/parseIni";
import { collapsePerNozzleImportSections } from "@/lib/prusaSlicerBundle";
import { upsertIniFilament } from "@/lib/iniImportApply";
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
    // base filament so a bundle round-trip updates the original instead of
    // spawning "<base> <Ø> <type>" orphan records (Codex P2). NOTE the per-nozzle
    // calibration model is NOT reconstructed from a flat bundle — a fresh import of
    // a multi-nozzle export lands the base filament without its baked temps /
    // calibrations by design; Settings → Backup & Restore is the lossless path.
    const filaments = collapsePerNozzleImportSections(parseIniFilaments(content));

    if (filaments.length === 0) {
      return NextResponse.json(
        { error: "No filament profiles found in the INI file" },
        { status: 400 }
      );
    }

    // GH #297: cap the bundle size — mirrors parseCsv's 10k maxRows.
    // A huge bundle would otherwise drive unbounded sequential writes.
    const MAX_IMPORT_FILAMENTS = 10_000;
    if (filaments.length > MAX_IMPORT_FILAMENTS) {
      return NextResponse.json(
        {
          error: `Import too large: ${filaments.length} profiles exceeds the ${MAX_IMPORT_FILAMENTS} limit.`,
        },
        { status: 400 },
      );
    }

    await dbConnect();

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const filament of filaments) {
      try {
        // GH #951: the three-phase atomic upsert (active → resurrect-trashed →
        // create/race) lives in `upsertIniFilament`, shared with
        // POST /api/filaments/prusaslicer, and preserves variant→parent
        // inheritance — the export flattens a variant's inherited values
        // through resolveFilament, so re-importing must NOT pin them as local
        // overrides (that would sever GH #106 live inheritance). See
        // src/lib/iniImportApply.ts.
        const outcome = await upsertIniFilament(filament);
        if (outcome === "created") created++;
        else updated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${filament.name}: ${msg}`);
      }
    }

    const result: Record<string, unknown> = {
      message: `Imported ${created + updated} filaments (${created} new, ${updated} updated)`,
      total: created + updated,
      created,
      updated,
    };
    if (errors.length > 0) {
      result.errors = errors;
      result.message = `${result.message}. ${errors.length} error(s).`;
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to import filaments", detail: message },
      { status: 500 },
    );
  }
}
