import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getExportRows, EXPORT_COLUMNS } from "@/lib/exportFilaments";

export async function GET() {
  const rows = await getExportRows();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Filament DB";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Filaments");

  // Define columns
  sheet.columns = EXPORT_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.key === "name" ? 30 : c.key === "tdsUrl" ? 40 : c.key === "vendor" ? 20 : 16,
  }));

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2D2D3D" },
  };
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };

  // Add data rows
  for (const row of rows) {
    const dataRow = sheet.addRow(
      EXPORT_COLUMNS.reduce(
        (acc, c) => {
          acc[c.key] = row[c.key];
          return acc;
        },
        {} as Record<string, unknown>,
      ),
    );

    // Color the "Color" cell background
    const colorIdx = EXPORT_COLUMNS.findIndex((c) => c.key === "color");
    if (colorIdx >= 0 && row.color) {
      const cell = dataRow.getCell(colorIdx + 1);
      const hex = row.color.replace("#", "").toUpperCase();
      if (/^[0-9A-F]{6}$/.test(hex)) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: `FF${hex}` },
        };
        // Use white or black text based on luminance
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        cell.font = { color: { argb: lum > 0.5 ? "FF000000" : "FFFFFFFF" } };
      }
    }
  }

  // Auto-filter
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: rows.length + 1, column: EXPORT_COLUMNS.length },
  };

  // Freeze header row
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = await workbook.xlsx.writeBuffer();

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="filaments.xlsx"',
    },
  });
}
