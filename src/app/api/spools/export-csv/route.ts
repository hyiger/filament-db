import { NextResponse } from "next/server";
import { getSpoolExportRows, SPOOL_EXPORT_COLUMNS } from "@/lib/exportSpools";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { csvCell } from "@/lib/csvWriter";

/**
 * GET /api/spools/export-csv — bulk export every spool as CSV (GH #139).
 *
 * Mirrors the filament export route: emit a flat CSV one row per spool. The
 * leading columns intentionally use the same headers as `/api/spools/import`
 * (filament, vendor, label, totalWeight, lotNumber, purchaseDate, openedDate,
 * location) so the file is round-trippable without column renaming.
 *
 * Cells go through `csvCell()` from `@/lib/csvWriter`, which combines RFC
 * 4180 escaping with formula-injection neutralisation — user-controlled
 * fields (filament name, vendor, label, location, etc.) starting with `=`,
 * `+`, `-`, `@`, tab, or CR get a leading apostrophe so spreadsheet apps
 * treat them as text. (Codex P2 on PR #141.)
 */

export async function GET() {
  try {
    const rows = await getSpoolExportRows();

    const header = SPOOL_EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(",");
    const dataLines = rows.map((row) =>
      SPOOL_EXPORT_COLUMNS.map((c) => csvCell(row[c.key])).join(","),
    );

    const csv = [header, ...dataLines].join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="spools.csv"',
      },
    });
  } catch (err) {
    return errorResponse("Failed to export spools CSV", 500, getErrorMessage(err));
  }
}
