import { describe, it, expect } from "vitest";
import { parseCsv, CsvRowLimitExceededError } from "@/lib/parseCsv";

describe("parseCsv", () => {
  it("parses a basic header+rows CSV", () => {
    const csv = "a,b,c\n1,2,3\n4,5,6\n";
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5", c: "6" },
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    const csv = 'name,value\n"Smith, John",42\n';
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows).toEqual([{ name: "Smith, John", value: "42" }]);
  });

  it("handles embedded quotes via doubled quotes", () => {
    const csv = 'quote,author\n"She said ""hi""","Me"\n';
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows).toEqual([{ quote: 'She said "hi"', author: "Me" }]);
  });

  it("handles CRLF line endings", () => {
    const csv = "a,b\r\n1,2\r\n3,4\r\n";
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: "1", b: "2" });
  });

  it("handles a trailing row without a newline", () => {
    const csv = "a,b\n1,2";
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("skips fully empty rows", () => {
    const csv = "a,b\n1,2\n\n3,4\n";
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
  });

  it("handles quoted newlines (multi-line field)", () => {
    const csv = 'name,note\n"Alice","line1\nline2"\n';
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows[0]).toEqual({ name: "Alice", note: "line1\nline2" });
  });

  it("returns string[][] when header: false", () => {
    const csv = "1,2,3\n4,5,6\n";
    const rows = parseCsv(csv, { header: false }) as string[][];
    expect(rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("parses a realistic spool import CSV", () => {
    const csv =
      "filament,vendor,label,totalWeight,lotNumber,purchaseDate,location\n" +
      'Prusament PLA Galaxy Black,Prusa,"Spool 1",1000,LOT-A,2025-01-01,Drybox #1\n' +
      "Bambu PLA Basic,Bambu,,820,,,Garage\n";
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].filament).toBe("Prusament PLA Galaxy Black");
    expect(rows[0].location).toBe("Drybox #1");
    expect(rows[1].label).toBe("");
  });

  it("returns empty array on empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("trims unquoted whitespace around values", () => {
    const csv = "a,b\n  1  ,  2  \n";
    const rows = parseCsv(csv) as Array<Record<string, string>>;
    expect(rows[0]).toEqual({ a: "1", b: "2" });
  });

  // GH #294: pin the exact row-limit boundary so an off-by-one or a
  // 2x-too-large cap on the CSV DoS guard would fail a test. Per the
  // CsvParseOptions contract, `maxRows` caps emitted DATA rows — the
  // header row is NOT counted toward it.
  describe("maxRows row-limit guard", () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => `r${i}`).join("\n");

    it("accepts exactly maxRows rows and rejects maxRows + 1 (header: false)", () => {
      // header:false → every parsed row is a data row, 1:1 with the cap.
      const atLimit = parseCsv(rows(4), { header: false, maxRows: 4 }) as string[][];
      expect(atLimit).toHaveLength(4);
      expect(() => parseCsv(rows(5), { header: false, maxRows: 4 })).toThrow(
        CsvRowLimitExceededError,
      );
    });

    it("excludes the header row from the maxRows data-row cap (header: true)", () => {
      // header + 4 data == 4 data rows == maxRows → accepted.
      expect(
        parseCsv("h\nd1\nd2\nd3\nd4", { header: true, maxRows: 4 }),
      ).toHaveLength(4);
      // header + 5 data == 5 data rows > maxRows → rejected.
      expect(() =>
        parseCsv("h\nd1\nd2\nd3\nd4\nd5", { header: true, maxRows: 4 }),
      ).toThrow(CsvRowLimitExceededError);
    });

    // GH #512: blank lines (Excel paste with trailing newlines,
    // section-separator blanks) used to count toward the cap, so a
    // maxRows-rows file with even one trailing blank would throw
    // CsvRowLimitExceededError despite emitting <=maxRows rows.
    it("ignores blank rows when enforcing maxRows (header: true)", () => {
      // 2 data rows + 1 trailing blank — emits 2, cap of 2 must accept.
      expect(
        parseCsv("h\nd1\nd2\n\n", { header: true, maxRows: 2 }),
      ).toHaveLength(2);
      // Section-separator blank between data rows also doesn't count.
      expect(
        parseCsv("h\nd1\n\nd2\nd3", { header: true, maxRows: 3 }),
      ).toHaveLength(3);
    });

    it("ignores blank rows when enforcing maxRows (header: false)", () => {
      // 4 data rows + trailing blank — emits 4, cap of 4 must accept.
      const result = parseCsv("a\nb\nc\nd\n\n", { header: false, maxRows: 4 }) as string[][];
      // The result includes the blank row in raw mode; the contract is
      // that the CAP doesn't count it. Emit length is 5 (including blank)
      // but no throw.
      expect(result.length).toBeGreaterThanOrEqual(4);
    });

    it("pins the default 10,000-row cap", () => {
      const atLimit = parseCsv(rows(10_000), { header: false }) as string[][];
      expect(atLimit).toHaveLength(10_000);
      expect(() => parseCsv(rows(10_001), { header: false })).toThrow(
        CsvRowLimitExceededError,
      );
    });
  });

  it("allows a large but under-limit file when maxRows is raised", () => {
    const body = Array.from({ length: 50 }, (_, i) => `${i}`).join("\n");
    const csv = `a\n${body}\n`;
    const rows = parseCsv(csv, { header: true, maxRows: 100 }) as Array<Record<string, string>>;
    expect(rows).toHaveLength(50);
  });
});
