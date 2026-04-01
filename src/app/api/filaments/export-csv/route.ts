import { NextResponse } from "next/server";
import { getExportRows, EXPORT_COLUMNS } from "@/lib/exportFilaments";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

function escapeCsv(value: string | number | null): string {
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET() {
  try {
    const rows = await getExportRows();

    const header = EXPORT_COLUMNS.map((c) => escapeCsv(c.header)).join(",");
    const dataLines = rows.map((row) =>
      EXPORT_COLUMNS.map((c) => escapeCsv(row[c.key])).join(","),
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
