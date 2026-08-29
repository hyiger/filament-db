import { NextResponse } from "next/server";
import { getSpoolExportRows, SPOOL_EXPORT_COLUMNS } from "@/lib/exportSpools";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { csvCell } from "@/lib/csvWriter";

/**
 * GET /api/spools/export-csv — bulk export every spool as CSV (GH #139).
 *
 * The leading columns intentionally use the same headers as
 * `/api/spools/import` so the file is round-trippable without renaming.
 * Cells go through `csvCell()` (RFC 4180 escaping + formula-injection
 * neutralisation — a leading apostrophe on `=`/`+`/`-`/`@`/tab/CR).
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
