/**
 * Minimal RFC 4180-ish CSV parser. Purpose-built for this app (spool
 * import, future inventory exports) — avoids a dependency on papaparse
 * for what is, in practice, a 50-row paste from a spreadsheet.
 *
 * Handles:
 *   - quoted fields with embedded commas and newlines
 *   - doubled quotes ("") as an escaped quote inside a quoted field
 *   - LF, CR, and CRLF line endings
 *   - leading/trailing whitespace around unquoted values (trimmed)
 *
 * Does NOT handle:
 *   - BOMs (caller should strip if needed)
 *   - header-row detection (caller passes headers explicitly or uses
 *     the first row as headers)
 */

export interface CsvParseOptions {
  /** If true (default), the first row is used as column headers and each
   * resulting row is an object keyed by header name. If false, rows are
   * returned as string[] arrays. */
  header?: boolean;
  /** Cap on the number of data rows the parser will emit. Defaults to 10,000
   * — enough for any realistic spool inventory paste, cheap to enforce, and
   * prevents an accidental multi-MB export from locking the UI. Set
   * explicitly to raise/lower. */
  maxRows?: number;
}

/** Thrown when the input exceeds `maxRows`. Caller can distinguish this
 * from a parse error by instanceof. */
export class CsvRowLimitExceededError extends Error {
  constructor(public readonly limit: number) {
    super(`CSV exceeds maximum row count (${limit})`);
    this.name = "CsvRowLimitExceededError";
  }
}

export function parseCsv(
  input: string,
  opts: CsvParseOptions = { header: true },
): Array<Record<string, string>> | string[][] {
  const maxRows = opts.maxRows ?? 10_000;
  // `maxRows` caps emitted DATA rows (per CsvParseOptions). The guard
  // below runs mid-parse against the raw row count, which in header mode
  // includes the not-yet-stripped header row — so allow one extra raw
  // row there. Without this the header silently counted toward the cap,
  // turning `maxRows: N` into an `N-1` data-row ceiling in header mode.
  const rawRowCap = opts.header ? maxRows + 1 : maxRows;
  const rows: string[][] = [];
  // GH #512: count non-blank rows for the cap so an Excel paste with
  // trailing newlines (or a CSV with section-separator blank rows)
  // doesn't throw CsvRowLimitExceededError even when the EMITTED row
  // count would be under the cap. Blank rows are still kept in `rows`
  // because non-header callers expect them; the per-iteration check
  // just stops counting them toward maxRows.
  let nonBlankRowCount = 0;
  const isBlankRow = (r: string[]): boolean =>
    r.length === 0 || (r.length === 1 && r[0] === "");
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside quoted field
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    // Not in quotes
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // Handle CRLF by skipping the LF; bare CR also treated as a line end.
      row.push(field);
      rows.push(row);
      if (!isBlankRow(row)) nonBlankRowCount++;
      field = "";
      row = [];
      i++;
      if (input[i] === "\n") i++;
      if (nonBlankRowCount > rawRowCap) throw new CsvRowLimitExceededError(maxRows);
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      if (!isBlankRow(row)) nonBlankRowCount++;
      field = "";
      row = [];
      i++;
      if (nonBlankRowCount > rawRowCap) throw new CsvRowLimitExceededError(maxRows);
      continue;
    }
    field += ch;
    i++;
  }

  // Flush any trailing field/row that didn't end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
    if (!isBlankRow(row)) nonBlankRowCount++;
    if (nonBlankRowCount > rawRowCap) throw new CsvRowLimitExceededError(maxRows);
  }

  // Strip outer whitespace from unquoted strings — we keep quoted values
  // untouched for callers that need literal content.
  // (This is a compromise; full CSV semantics would preserve all whitespace.)
  const trimmed = rows.map((r) => r.map((v) => v.trim()));

  if (!opts.header) return trimmed;

  if (trimmed.length === 0) return [];
  const headers = trimmed[0];
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < trimmed.length; r++) {
    // Skip fully-empty rows (common when a file ends with a blank line)
    if (trimmed[r].every((v) => v === "")) continue;
    // GH #296: build the row with a null prototype. With a plain `{}`,
    // a header literally named `__proto__` would trigger the prototype
    // setter instead of creating an own property — silently dropping
    // that column's data and mutating the object's prototype. A
    // null-prototype object has no such setter; `__proto__` /
    // `constructor` / `prototype` become ordinary own keys.
    const obj: Record<string, string> = Object.create(null);
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = trimmed[r][c] ?? "";
    }
    out.push(obj);
  }
  return out;
}
