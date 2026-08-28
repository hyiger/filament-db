import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { mapHeaders, rowToImport, upsertImportRows } from "@/lib/importFilaments";
import { assertMultipartFormData, getErrorMessage, errorResponse, checkFileSize } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * GH #1079: normalize an ExcelJS `cell.value` to a primitive. ExcelJS
 * returns OBJECTS for rich-text / hyperlink / formula / error cells, but
 * `rowToImport` assumes primitives — a bolded Name would import as
 * `"[object Object]"` (collapsing several rows onto ONE record, since the
 * importer matches by name) and a formula-valued Cost as `null`, which the
 * name-matched update path then writes through, ERASING the stored cost.
 *
 * Rules (shared by the header loop and the data-row loop; the CSV path is
 * immune — its cells are always strings):
 *   - `null` / primitives / `Date` pass through.
 *   - `{richText}` joins the runs' text.
 *   - `{text, hyperlink}` uses the display text, EXCEPT when the column
 *     maps to `tdsUrl` (`preferHyperlink`) — there the hyperlink TARGET is
 *     what round-trips (`tdsUrl` is http(s)-validated, and a friendly
 *     display text like "Datasheet" would fail validation).
 *   - `{formula, result}` recurses once into the result.
 *   - `{error}` and any unrecognized object become `null` — the same
 *     "empty cell" the CSV path produces, never `"[object Object]"`.
 */
function normalizeCellValue(
  value: unknown,
  preferHyperlink = false,
  depth = 0,
): unknown {
  if (value == null) return null;
  if (typeof value !== "object" || value instanceof Date) return value;
  // Bound the recursion — anything deeper than one formula hop plus one
  // nested shape is malformed input; normalize to the empty cell rather
  // than risk a cycle.
  if (depth > 2) return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.richText)) {
    return obj.richText
      .map((run) => {
        const text = (run as Record<string, unknown> | null)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  if ("hyperlink" in obj) {
    if (preferHyperlink && typeof obj.hyperlink === "string") return obj.hyperlink;
    // The display text may itself be a rich-text object.
    return normalizeCellValue(obj.text, false, depth + 1);
  }
  if ("formula" in obj || "sharedFormula" in obj) {
    return normalizeCellValue(obj.result, preferHyperlink, depth + 1);
  }
  return null;
}

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

    // GH #627: cap the row count (mirrors the INI + CSV importers).
    // Checked on the sheet's physical rowCount BEFORE the per-cell read
    // loop so an enormous sheet is rejected without iterating it.
    const MAX_IMPORT_ROWS = 10_000;
    if (sheet.rowCount - 1 > MAX_IMPORT_ROWS) {
      return errorResponse(
        `Import too large: ${sheet.rowCount - 1} rows exceeds the ${MAX_IMPORT_ROWS} limit.`,
        400,
      );
    }

    // Read header row
    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      while (headers.length < colNumber - 1) headers.push("");
      // GH #1079: a rich-text header would stringify as "[object Object]"
      // and fail the required-column mapping below.
      headers.push(String(normalizeCellValue(cell.value) ?? ""));
    });

    const mapping = mapHeaders(headers);

    // Verify required columns exist
    const mappedKeys = mapping.filter(Boolean);
    if (!mappedKeys.includes("name") || !mappedKeys.includes("vendor") || !mappedKeys.includes("type")) {
      return errorResponse("XLSX must include Name, Vendor, and Type columns", 400);
    }

    // Read data rows
    const rows = [];
    /** Physical sheet row for each entry in `rows` (GH #1115). */
    const sourceLines: number[] = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const values: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        while (values.length < colNumber - 1) values.push(null);
        // `values[i]` aligns with `mapping[i]` (both padded to
        // colNumber - 1) — the tdsUrl column prefers the hyperlink TARGET
        // (see normalizeCellValue).
        values.push(
          normalizeCellValue(cell.value, mapping[colNumber - 1] === "tdsUrl"),
        );
      });

      // Skip completely empty rows
      if (values.every((v) => v == null || v === "")) continue;

      rows.push(rowToImport(values, mapping));
      // GH #1115: the sheet row number, so a skip reason names the row the
      // user is actually looking at (not one shifted by blank rows).
      sourceLines.push(r);
    }

    if (rows.length === 0) {
      return errorResponse("No data rows found in the XLSX file", 400);
    }

    const result = await upsertImportRows(rows, sourceLines);

    return NextResponse.json({
      // GH #605: `result.errors` (present only when non-empty) carries
      // per-row non-fatal notes (e.g. a template target's stripped color).
      // GH #1115: `total` counts skipped rows too, so the message reports
      // created+updated "of" total.
      message: `Imported ${result.created + result.updated} of ${result.total} filaments (${result.created} new, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""})${result.errors ? `. ${result.errors.length} note(s).` : ""}`,
      ...result,
    });
  } catch (err) {
    return errorResponse("Failed to import XLSX", 500, getErrorMessage(err));
  }
}
