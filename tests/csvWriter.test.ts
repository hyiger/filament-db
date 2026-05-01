import { describe, it, expect } from "vitest";
import { csvCell, isFormulaCandidate, unsanitizeCsvCell } from "@/lib/csvWriter";

/**
 * Codex P2 on PR #141 — without sanitisation, an attacker who controls
 * any user-editable string field (filament name, vendor, spool label,
 * location name, lot number, …) can ship a CSV that executes formulas
 * when opened in Excel / Google Sheets. csvCell prefixes leading-trigger
 * strings with a single quote so the spreadsheet treats them as text.
 */
describe("csvCell — RFC 4180 escaping", () => {
  it("returns empty string for null / undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("passes plain strings through", () => {
    expect(csvCell("Generic PLA")).toBe("Generic PLA");
  });

  it("converts numbers / booleans without quoting", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
  });

  it("quotes strings containing commas, quotes, or newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvCell("multi\nline")).toBe('"multi\nline"');
  });
});

describe("csvCell — formula injection neutralisation", () => {
  it("prefixes strings starting with = with an apostrophe", () => {
    expect(csvCell("=cmd|'/C calc'!A0")).toBe("'=cmd|'/C calc'!A0");
  });

  it("prefixes strings starting with +, -, @, tab, or CR", () => {
    expect(csvCell("+evil()")).toBe("'+evil()");
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tinject")).toBe("'\tinject");
    expect(csvCell("\rinject")).toBe("'\rinject");
  });

  it("still escapes the prefixed value when it also contains a comma", () => {
    // Combined sanitization + quoting: the apostrophe goes inside the
    // quoted cell. Codex's report case includes commas inside formulas.
    expect(csvCell("=HYPERLINK(\"https://evil\",\"x\")")).toBe(
      '"\'=HYPERLINK(""https://evil"",""x"")"',
    );
  });

  it("does NOT prefix numbers that happen to be negative", () => {
    // A negative *number* is safe to write — a leading `-` with no other
    // characters is rendered as a number by spreadsheets, not a formula.
    // Only `string`-typed inputs go through the formula guard.
    expect(csvCell(-1)).toBe("-1");
  });

  it("does NOT prefix strings that have a trigger char anywhere except position 0", () => {
    expect(csvCell("Vendor=ACME")).toBe("Vendor=ACME");
    expect(csvCell("PLA+ blend")).toBe("PLA+ blend");
  });

  it("does NOT prefix the empty string", () => {
    expect(csvCell("")).toBe("");
  });
});

describe("unsanitizeCsvCell — inverse of csvCell's formula guard", () => {
  it("strips the leading apostrophe when followed by a formula trigger", () => {
    expect(unsanitizeCsvCell("'=foo")).toBe("=foo");
    expect(unsanitizeCsvCell("'+evil()")).toBe("+evil()");
    expect(unsanitizeCsvCell("'-1+2")).toBe("-1+2");
    expect(unsanitizeCsvCell("'@SUM(A1)")).toBe("@SUM(A1)");
    expect(unsanitizeCsvCell("'\tinject")).toBe("\tinject");
    expect(unsanitizeCsvCell("'\rinject")).toBe("\rinject");
  });

  it("leaves apostrophe-prefixed strings alone when the next char is benign", () => {
    expect(unsanitizeCsvCell("'70s blue")).toBe("'70s blue");
    expect(unsanitizeCsvCell("'apostrophe")).toBe("'apostrophe");
    expect(unsanitizeCsvCell("'a")).toBe("'a");
  });

  it("leaves non-apostrophe-prefixed values alone", () => {
    expect(unsanitizeCsvCell("Generic PLA")).toBe("Generic PLA");
    expect(unsanitizeCsvCell("=foo")).toBe("=foo"); // no leading apostrophe → no change
    expect(unsanitizeCsvCell("")).toBe("");
  });

  it("round-trips with csvCell for formula-leading values", () => {
    const original = "=cmd|'/C calc'!A0";
    // csvCell wraps in quotes because of the comma; unsanitize handles
    // the un-wrapped value the parser would hand back.
    const exported = csvCell(original);
    // Strip the RFC4180 quote wrap that csvCell applied because of the
    // embedded comma: the parseCsv layer would have already done that
    // before handing the cell to unsanitizeCsvCell.
    const unwrapped = exported.startsWith('"') && exported.endsWith('"')
      ? exported.slice(1, -1).replace(/""/g, '"')
      : exported;
    expect(unsanitizeCsvCell(unwrapped)).toBe(original);
  });

  it("round-trips with csvCell for plain formula triggers (no embedded commas)", () => {
    expect(unsanitizeCsvCell(csvCell("=A1+B1"))).toBe("=A1+B1");
    expect(unsanitizeCsvCell(csvCell("+1"))).toBe("+1");
    expect(unsanitizeCsvCell(csvCell("-1"))).toBe("-1");
    expect(unsanitizeCsvCell(csvCell("@SUM"))).toBe("@SUM");
  });
});

describe("isFormulaCandidate", () => {
  it("returns true for strings starting with formula triggers", () => {
    expect(isFormulaCandidate("=A1")).toBe(true);
    expect(isFormulaCandidate("+1")).toBe(true);
    expect(isFormulaCandidate("-2")).toBe(true);
    expect(isFormulaCandidate("@SUM")).toBe(true);
    expect(isFormulaCandidate("\trce")).toBe(true);
    expect(isFormulaCandidate("\rrce")).toBe(true);
  });

  it("returns false for safe strings, non-strings, and empties", () => {
    expect(isFormulaCandidate("Hello")).toBe(false);
    expect(isFormulaCandidate("")).toBe(false);
    expect(isFormulaCandidate(null)).toBe(false);
    expect(isFormulaCandidate(undefined)).toBe(false);
    expect(isFormulaCandidate(42)).toBe(false);
    expect(isFormulaCandidate(true)).toBe(false);
  });
});
