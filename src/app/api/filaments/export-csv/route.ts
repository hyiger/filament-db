import { NextResponse } from "next/server";
import { getExportRows, EXPORT_COLUMNS } from "@/lib/exportFilaments";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { csvCell } from "@/lib/csvWriter";

/**
 * GET /api/filaments/export-csv — bulk export every filament as CSV.
 *
 * Cells flow through `csvCell()` from `@/lib/csvWriter`, which combines
 * RFC 4180 escaping with formula-injection neutralisation — user-
 * controlled fields (name, vendor, color name, etc.) starting with `=`,
 * `+`, `-`, `@`, tab, or CR get a leading apostrophe so spreadsheet apps
 * treat them as text rather than formulas. (Codex P2 on PR #141.)
 */

export async function GET() {
  try {
    const rows = await getExportRows();

    const header = EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(",");
    const dataLines = rows.map((row) =>
      EXPORT_COLUMNS.map((c) => csvCell(row[c.key])).join(","),
    );

    const csv = [header, ...dataLines].join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="filaments.csv"',
      },
    });
  } catch (err) {
    return errorResponse("Failed to export CSV", 500, getErrorMessage(err));
  }
}
