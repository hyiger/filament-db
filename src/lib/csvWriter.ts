/**
 * Shared CSV cell writer for the export endpoints.
 *
 * Two concerns the caller would otherwise have to remember per call:
 *
 *  1. **RFC 4180 escaping.** Cells containing `,`, `"`, or newline get wrapped
 *     in double quotes; embedded quotes are doubled.
 *
 *  2. **Formula injection.** Excel / Google Sheets evaluate cells starting
 *     with `=`, `+`, `-`, `@`, tab, or carriage return as formulas. Without
 *     mitigation, a user-controlled string like `=cmd|'/C calc'!A0` written
 *     into a filament name turns into RCE on whoever opens the exported CSV.
 *     The OWASP-recommended mitigation is to prefix dangerous-leading cells
 *     with a single quote (`'`), which spreadsheet apps consume as the
 *     "treat as text" marker. The visible apostrophe is acceptable in an
 *     exported file — the alternative (the cell silently executing) is not.
 *     (Codex P2 on PR #141.)
 */

const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Apply the formula-injection guard to a bare string: a leading character
 * in FORMULA_TRIGGERS gets the `'` "treat as text" prefix; everything
 * else passes through untouched. Shared by `csvCell` (CSV exports) and
 * the XLSX export route (GH #627 item 5) so both spreadsheet formats
 * neutralize formula-leading cells from the SAME trigger list — the
 * XLSX side previously skipped the guard entirely.
 */
export function sanitizeFormulaPrefix(value: string): string {
  if (value.length > 0 && FORMULA_TRIGGERS.includes(value[0])) {
    return "'" + value;
  }
  // GH #649/#955 (Codex P3): a value that GENUINELY starts with an apostrophe
  // RUN of any length immediately followed by a trigger (e.g. `'+95A`, `''+95A`)
  // is exported unguarded by the clause above (its first char isn't a trigger),
  // yet `unsanitizeCsvCell` would strip one of those real apostrophes on import
  // — corrupting the name. Prepend one apostrophe so the unguard restores
  // exactly one, keeping the round trip lossless for a run of ANY length. A
  // genuine `'70s` / `''70s` (apostrophe run + benign char) is still left
  // alone — only the ambiguous run-then-trigger shape needs disambiguating.
  let n = 0;
  while (n < value.length && value[n] === "'") n++;
  if (n >= 1 && n < value.length && FORMULA_TRIGGERS.includes(value[n])) {
    return "'" + value;
  }
  return value;
}

/**
 * Convert a CSV cell value into its safe, properly-escaped string form.
 *
 *  - `null` / `undefined` → empty string
 *  - booleans → `"true"` / `"false"`
 *  - numbers → `String(n)`
 *  - strings → escaped + sanitised; first char in FORMULA_TRIGGERS gets a
 *    leading `'` prefix
 *
 * Always returns a value that's safe to concatenate with commas in a CSV.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value == null) return "";
  let str: string;
  if (typeof value === "boolean") {
    str = value ? "true" : "false";
  } else if (typeof value === "number") {
    str = String(value);
  } else {
    str = value;
  }

  // Formula-injection guard. Numbers and booleans don't need this — only
  // strings, which are the only fields a user can populate freely.
  if (typeof value === "string") {
    str = sanitizeFormulaPrefix(str);
  }

  // GH #627 item 4: `\r` must trigger quoting too (RFC 4180). A bare CR
  // mid-string emitted unquoted is treated as a row terminator by
  // parseCsv (and by spec-compliant readers), splitting the row on
  // round-trip. Leading CR was already neutralized by the formula guard
  // above, but a CR in the middle of a cell slipped through unquoted.
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Internal helper exposed for testing — returns true iff `value` would
 * be prefixed with the formula-neutralizing single quote.
 */
export function isFormulaCandidate(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    FORMULA_TRIGGERS.includes(value[0])
  );
}

/**
 * Inverse of `csvCell`'s formula guard: strip a leading `'` if it's
 * sitting in front of a formula-trigger character. This is what the CSV
 * importers run user-supplied string fields through so a value exported
 * with the guard (`'=foo`) round-trips back to its original form (`=foo`).
 *
 * The strip is conservative — it only fires on the exact `'` + trigger
 * pattern that `csvCell` produces. A value that genuinely starts with `'`
 * followed by a non-trigger character (e.g. `'70s blue`) is left alone.
 *
 * GH #649/#955 (Codex P3): `sanitizeFormulaPrefix` prepends one apostrophe for a
 * value that genuinely begins with an apostrophe RUN of any length + a trigger,
 * so that shape unwinds by exactly one here too — `'+95A` (guarded `+95A`) →
 * `+95A`, `''+95A` (guarded genuine `'+95A`) → `'+95A`, `'''+95A` → `''+95A`. A
 * run + benign char (`'70s`, `''70s`) is untouched.
 *
 * Codex P2 follow-up to PR #144: without this, exporting then re-
 * importing a row whose filament name / vendor / location starts with
 * a trigger char would either fail to match an existing filament (the
 * import is exact-string-match on `filament`) or persist the apostrophe
 * verbatim into the document.
 */
export function unsanitizeCsvCell(value: string): string {
  let n = 0;
  while (n < value.length && value[n] === "'") n++;
  // Bare-trigger guard: exactly one apostrophe + trigger → strip one.
  if (n === 1 && value.length >= 2 && FORMULA_TRIGGERS.includes(value[1])) {
    return value.slice(1);
  }
  // Run guard: >=2 apostrophes + trigger → strip exactly one.
  if (n >= 2 && n < value.length && FORMULA_TRIGGERS.includes(value[n])) {
    return value.slice(1);
  }
  return value;
}
