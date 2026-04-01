import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { mapHeaders, rowToImport, upsertImportRows } from "@/lib/importFilaments";
import { getErrorMessage, errorResponse, checkFileSize } from "@/lib/apiErrorHandler";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return errorResponse("No file provided", 400);
    }

    // Validate file size (max 10 MB)
    const sizeError = checkFileSize(file);
    if (sizeError) return sizeError;

    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);

    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) {
      return errorResponse(
        "XLSX file must have a header row and at least one data row",
        400,
      );
    }

    // Read header row
    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      while (headers.length < colNumber - 1) headers.push("");
      headers.push(String(cell.value ?? ""));
    });

    const mapping = mapHeaders(headers);

    // Verify required columns exist
    const mappedKeys = mapping.filter(Boolean);
    if (!mappedKeys.includes("name") || !mappedKeys.includes("vendor") || !mappedKeys.includes("type")) {
      return errorResponse("XLSX must include Name, Vendor, and Type columns", 400);
    }

    // Read data rows
    const rows = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const values: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        while (values.length < colNumber - 1) values.push(null);
        values.push(cell.value);
      });

      // Skip completely empty rows
      if (values.every((v) => v == null || v === "")) continue;

      rows.push(rowToImport(values, mapping));
    }

    if (rows.length === 0) {
      return errorResponse("No data rows found in the XLSX file", 400);
    }

    const result = await upsertImportRows(rows);

    return NextResponse.json({
      message: `Imported ${result.total} filaments (${result.created} new, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""})`,
      ...result,
    });
  } catch (err) {
    return errorResponse("Failed to import XLSX", 500, getErrorMessage(err));
  }
}
