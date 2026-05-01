import { NextResponse } from "next/server";
import { getSpoolExportRows, SPOOL_EXPORT_COLUMNS } from "@/lib/exportSpools";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/spools/export-csv — bulk export every spool as CSV (GH #139).
 *
 * Mirrors the filament export route: emit a flat CSV one row per spool. The
 * leading columns intentionally use the same headers as `/api/spools/import`
 * (filament, vendor, label, totalWeight, lotNumber, purchaseDate, openedDate,
 * location) so the file is round-trippable without column renaming.
 */

function escapeCsv(value: string | number | boolean | null): string {
  if (value == null) return "";
  const str = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET() {
  try {
    const rows = await getSpoolExportRows();

    const header = SPOOL_EXPORT_COLUMNS.map((c) => escapeCsv(c.header)).join(",");
    const dataLines = rows.map((row) =>
      SPOOL_EXPORT_COLUMNS.map((c) => escapeCsv(row[c.key])).join(","),
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
