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
  // A blank row from a spreadsheet export can carry delimiters — `,\n`
  // parses to `["", ""]`, not `[""]` — so "blank" means every field is
  // empty after trimming (matches the header-mode output skip below).
  const isBlankRow = (r: string[]): boolean =>
    r.length === 0 || r.every((v) => v.trim() === "");

  // Codex P2 round 3 on PR #536: the cap must bound BUFFERED memory, not
  // just the emitted-row count. In header mode, blank rows are filtered
  // out of the output (the `trimmed[r].every` skip below), so:
  //   - GH #512: they must NOT count toward maxRows (an Excel paste with
  //     trailing newlines / section-separator blanks shouldn't throw
  //     when the emitted row count is under the cap), AND
  //   - they must NOT be buffered at all — otherwise a flood of blank /
  //     comma-only lines accumulates `rows` unbounded and the DoS guard
  //     is bypassed by rows it's "exempting". So in header mode we
  //     simply discard blank rows during parsing.
  // In non-header mode every parsed row is RETURNED verbatim
  // (`if (!opts.header) return trimmed`), so every row — blank or not —
  // is both buffered AND counted.
  //
  // `rows.length` is therefore the count of rows that will actually be
  // returned (header mode: header + non-blank data; non-header: all),
  // so the emitted-row cap check is just `rows.length > rawRowCap`.
  //
  // Codex P2 round 4 on PR #536: keep a SEPARATE physical-row cap too.
  // Because header-mode blank rows are discarded before the emitted cap,
  // a blank / comma-only-line flood ("3 data rows + 10M blank lines")
  // would otherwise make the parser scan the entire input even though
  // those lines never count toward maxRows — tying up the import route
  // (`/api/spools/import` calls parseCsv with no separate body cap).
  // The physical cap counts EVERY parsed line (blanks + header) and is
  // set generously — one full `maxRows` worth of blank lines beyond the
  // data cap — so legitimate trailing / section-separator blanks pass
  // while an abusive flood trips it.
  const physicalRowCap = rawRowCap + maxRows;
  let physicalRowCount = 0;
  const commitRow = (r: string[]): void => {
    physicalRowCount++;
    if (physicalRowCount > physicalRowCap) {
      throw new CsvRowLimitExceededError(maxRows);
    }
    if (opts.header && isBlankRow(r)) return; // discard — never buffered
    rows.push(r);
    if (rows.length > rawRowCap) throw new CsvRowLimitExceededError(maxRows);
  };

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
      field = "";
      i++;
      if (input[i] === "\n") i++;
      commitRow(row);
      row = [];
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      i++;
      commitRow(row);
      row = [];
      continue;
    }
    field += ch;
    i++;
  }

  // Flush any trailing field/row that didn't end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    commitRow(row);
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
