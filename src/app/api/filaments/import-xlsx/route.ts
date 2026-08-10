import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { mapHeaders, rowToImport, upsertImportRows } from "@/lib/importFilaments";
import { assertMultipartFormData, getErrorMessage, errorResponse, checkFileSize } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * GH #1079 item 1: normalize an ExcelJS `cell.value` to a primitive.
 *
 * ExcelJS returns OBJECTS for rich-text cells (`{richText: [...]}`),
 * hyperlink cells (`{text, hyperlink}`), formula cells (`{formula, result}`
 * / `{sharedFormula, result}`) and error cells (`{error}`), but
 * `rowToImport` assumes primitives — string fields go through `String(val)`
 * and numeric fields through `Number(val)`. So a user who opened the app's
 * own `filaments.xlsx` export in Excel, bolded part of a Name (making the
 * cell rich text) or replaced a Cost with a formula, and re-imported it got:
 *   - the literal name `"[object Object]"` (and since the importer matches
 *     by name, several such rows collapse onto ONE record), and
 *   - a formula-valued Cost importing as `null`, which on the name-matched
 *     update path (`doc.cost = row.cost ?? null`) ERASES the stored cost
 *     with no error reported for the row.
 *
 * Rules (shared by the header loop and the data-row loop; the CSV path is
 * immune — its cells are always strings — and `rowToImport` stays
 * untouched):
 *   - `null` stays `null`; strings / numbers / booleans / `Date` instances
 *     pass through (`rowToImport` already handles those).
 *   - `{richText}` joins the runs' text — equivalent to ExcelJS's own
 *     `cell.text` for rich-text cells.
 *   - `{text, hyperlink}` uses the display text, EXCEPT when the column
 *     maps to `tdsUrl` (`preferHyperlink`) — there the hyperlink TARGET is
 *     what round-trips: `Filament.tdsUrl` is http(s)-validated, Excel
 *     auto-links pasted URLs, and a friendly display text ("Datasheet")
 *     would fail validation while the target is the real URL.
 *   - `{formula, result}` recurses once into the result — a result can
 *     itself be rich text, a hyperlink shape, a Date, or an error object.
 *   - `{error}` (e.g. `#DIV/0!`) and any unrecognized object become `null`
 *     — the same "empty cell" the CSV path produces, never
 *     `"[object Object]"`.
 */
function normalizeCellValue(
  value: unknown,
  preferHyperlink = false,
  depth = 0,
): unknown {
  if (value == null) return null;
  if (typeof value !== "object" || value instanceof Date) return value;
  // Bound the recursion: one formula hop may expose one more object shape
  // (rich text / hyperlink / error). Anything deeper is malformed input and
  // normalizes to the empty cell rather than risking a cycle.
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

    // GH #627 item 1: cap the row count — mirrors the INI importer's
    // GH #297 cap and the CSV importer's identical guard. Checked on the
    // sheet's physical rowCount BEFORE the per-cell read loop so an
    // enormous sheet is rejected without iterating it.
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
      // GH #1079 item 1: a rich-text header (a user bolding "Name" in
      // Excel) used to stringify as "[object Object]" and fail the
      // required-column mapping below.
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
        // GH #1079 item 1: `values[i]` aligns with `mapping[i]` (both are
        // padded to colNumber - 1), so the column's mapped key is known
        // here — the tdsUrl column prefers the hyperlink TARGET over the
        // display text (see normalizeCellValue's docblock).
        values.push(
          normalizeCellValue(cell.value, mapping[colNumber - 1] === "tdsUrl"),
        );
      });

      // Skip completely empty rows
      if (values.every((v) => v == null || v === "")) continue;

      rows.push(rowToImport(values, mapping));
      // GH #1115: the sheet row number, so a skip reason names the row the
      // user is actually looking at rather than one shifted up by every blank
      // row above it.
      sourceLines.push(r);
    }

    if (rows.length === 0) {
      return errorResponse("No data rows found in the XLSX file", 400);
    }

    const result = await upsertImportRows(rows, sourceLines);

    return NextResponse.json({
      // GH #605: `result.errors` (present only when non-empty) carries
      // per-row non-fatal notes — e.g. a template target whose echoed
      // color/colorName the update stripped. Surfaced in the toast via the
      // note count, same wording as the atlas importer.
      // GH #1115: see the matching note in the CSV route — `total` counts
      // skipped rows, so it never described what was imported.
      message: `Imported ${result.created + result.updated} of ${result.total} filaments (${result.created} new, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""})${result.errors ? `. ${result.errors.length} note(s).` : ""}`,
      ...result,
    });
  } catch (err) {
    return errorResponse("Failed to import XLSX", 500, getErrorMessage(err));
  }
}
