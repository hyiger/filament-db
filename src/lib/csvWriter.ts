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
  if (typeof value === "string" && str.length > 0 && FORMULA_TRIGGERS.includes(str[0])) {
    str = "'" + str;
  }

  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
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
