import { describe, it, expect } from "vitest";
import { parseCsv } from "@/lib/parseCsv";

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
});
