import { NextRequest, NextResponse } from "next/server";
import { mapHeaders, rowToImport, upsertImportRows } from "@/lib/importFilaments";
import { parseCsv, CsvRowLimitExceededError } from "@/lib/parseCsv";
import { assertMultipartFormData, getErrorMessage, errorResponse, checkFileSize } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

const MAX_IMPORT_ROWS = 10_000;
// GH #888: in non-header mode parseCsv counts EVERY parsed row (header +
// blank lines) toward its cap, before this route filters blanks — so the
// parse-time cap is a generous PHYSICAL/DoS bound, and the strict
// MAX_IMPORT_ROWS DATA-row cap is enforced below after blanks are filtered.
const MAX_PHYSICAL_ROWS = MAX_IMPORT_ROWS * 2;

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

    // GH #309: strip a leading UTF-8 BOM — left in place it becomes part of
    // the first header cell and the required-column check rejects an
    // otherwise-valid file.
    const content = (await file.text()).replace(/^\uFEFF/, "");
    // GH #888: the shared parser is embedded-newline-aware (a
    // split-on-newlines parser shredded quoted multi-line cells across
    // rows) and enforces the row cap itself. header:false → positional
    // string[][]; positional mode also sidesteps the object-key __proto__
    // vector (keys come from `mapping`, not the file).
    /** Physical start line of each parsed record (GH #1115). */
    const recordLines: number[] = [];
    let parsedRaw: string[][];
    try {
      parsedRaw = parseCsv(content, {
        header: false,
        maxRows: MAX_PHYSICAL_ROWS,
        recordLines,
      }) as string[][];
    } catch (err) {
      if (err instanceof CsvRowLimitExceededError) {
        return errorResponse(`Import too large: exceeds the ${MAX_IMPORT_ROWS} row limit.`, 400);
      }
      throw err;
    }
    // Non-header parseCsv returns EVERY row verbatim, including blank
    // lines — drop blanks so a trailing newline doesn't become a junk data
    // row. GH #1115: keep each surviving row's PHYSICAL line number, from
    // the PARSER (not the array index): a quoted field may contain newlines
    // (this app's own export quotes them), so one record can span several
    // physical lines and an index-derived number would drift low.
    const parsedWithLines = parsedRaw
      .map((r, i) => ({ values: r, line: recordLines[i] ?? i + 1 }))
      .filter(({ values }) => values.some((v) => v.trim() !== ""));
    const parsed = parsedWithLines.map((p) => p.values);

    if (parsed.length < 2) {
      return errorResponse(
        "CSV file must have a header row and at least one data row",
        400,
      );
    }
    // Enforce the business DATA-row cap AFTER filtering blanks so a capped
    // export with a trailing blank line isn't falsely rejected.
    if (parsed.length - 1 > MAX_IMPORT_ROWS) {
      return errorResponse(
        `Import too large: ${parsed.length - 1} rows exceeds the ${MAX_IMPORT_ROWS} limit.`,
        400,
      );
    }

    const mapping = mapHeaders(parsed[0]);

    // Verify required columns exist
    const mappedKeys = mapping.filter(Boolean);
    if (!mappedKeys.includes("name") || !mappedKeys.includes("vendor") || !mappedKeys.includes("type")) {
      return errorResponse("CSV must include Name, Vendor, and Type columns", 400);
    }

    const rows = parsed.slice(1).map((values) => rowToImport(values, mapping));
    const sourceLines = parsedWithLines.slice(1).map((p) => p.line);

    const result = await upsertImportRows(rows, sourceLines);

    return NextResponse.json({
      // GH #605: `result.errors` (present only when non-empty) carries
      // per-row non-fatal notes (e.g. a template target's stripped color).
      // GH #1115: created + updated + skipped === total, so the headline
      // reports created+updated "of" total rather than claiming skipped
      // rows were imported.
      message: `Imported ${result.created + result.updated} of ${result.total} filaments (${result.created} new, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""})${result.errors ? `. ${result.errors.length} note(s).` : ""}`,
      ...result,
    });
  } catch (err) {
    return errorResponse("Failed to import CSV", 500, getErrorMessage(err));
  }
}
