import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { POST as importXlsx } from "@/app/api/filaments/import-xlsx/route";
import Filament from "@/models/Filament";

/**
 * GH #1079 item 1 — XLSX import must normalize ExcelJS OBJECT cell values
 * (rich text, hyperlink, formula, error) to primitives before handing them
 * to `rowToImport`, which assumes primitives (`String(val)` / `Number(val)`).
 *
 * Pre-fix, a user who opened the app's own `filaments.xlsx` export in
 * Excel, bolded part of a Name (rich text) or replaced a Cost with a
 * formula, and re-imported got the literal name `"[object Object]"`
 * (collapsing several such rows onto one record, since the importer
 * matches by name) and a `null` cost that ERASED the stored value on the
 * name-matched update path.
 *
 * Every fixture here is built with the repo's own exceljs and round-tripped
 * through `workbook.xlsx.load` — the same code path the route runs — so the
 * cell shapes are the real ones, not hand-mocked.
 */
describe("POST /api/filaments/import-xlsx — object cell normalization (GH #1079)", () => {
  function multipartReq(url: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    return new NextRequest(url, { method: "POST", body: fd });
  }

  async function xlsxFile(
    build: (sheet: ExcelJS.Worksheet) => void,
  ): Promise<File> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Filaments");
    build(sheet);
    const buffer = await workbook.xlsx.writeBuffer();
    return new File([buffer], "filaments.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  beforeEach(async () => {
    await Filament.deleteMany({ name: /PLA/ });
  });

  it("imports rich-text names as concatenated text, formula costs as their result, and hyperlink TDS URLs as the target", async () => {
    const file = await xlsxFile((sheet) => {
      sheet.addRow(["Name", "Vendor", "Type", "Cost", "TDS URL"]);
      const row = sheet.addRow([]);
      row.getCell(1).value = {
        richText: [{ text: "Rich " }, { font: { bold: true }, text: "PLA" }],
      };
      row.getCell(2).value = "V";
      row.getCell(3).value = "PLA";
      row.getCell(4).value = { formula: "20+5", result: 25 };
      row.getCell(5).value = {
        text: "Datasheet",
        hyperlink: "https://example.com/tds.pdf",
      };
    });

    const res = await importXlsx(
      multipartReq("http://localhost/api/filaments/import-xlsx", file),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);

    // Rich text joined — never "[object Object]".
    const doc = await Filament.findOne({ name: "Rich PLA", _deletedAt: null });
    expect(doc).not.toBeNull();
    expect(doc!.cost).toBe(25);
    // tdsUrl column prefers the hyperlink TARGET — the display text
    // ("Datasheet") would fail the schema's http(s) validator.
    expect(doc!.tdsUrl).toBe("https://example.com/tds.pdf");
    expect(await Filament.countDocuments({ name: "[object Object]" })).toBe(0);
  });

  it("does not clear a stored cost when a name-matched update carries a formula-valued Cost", async () => {
    await Filament.create({
      name: "Formula PLA",
      vendor: "V",
      type: "PLA",
      cost: 19,
    });

    const file = await xlsxFile((sheet) => {
      sheet.addRow(["Name", "Vendor", "Type", "Cost"]);
      const row = sheet.addRow([]);
      row.getCell(1).value = "Formula PLA";
      row.getCell(2).value = "V";
      row.getCell(3).value = "PLA";
      row.getCell(4).value = { formula: "10*3", result: 30 };
    });

    const res = await importXlsx(
      multipartReq("http://localhost/api/filaments/import-xlsx", file),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);

    // Pre-fix: Number({formula, result}) → NaN → null → `doc.cost =
    // row.cost ?? null` erased the stored 19 with no per-row error.
    const doc = await Filament.findOne({ name: "Formula PLA", _deletedAt: null });
    expect(doc!.cost).toBe(30);
  });

  it("treats an error-valued formula as an empty cell and recurses into a hyperlink's rich-text display text", async () => {
    await Filament.create({
      name: "Err PLA",
      vendor: "V",
      type: "PLA",
      cost: 12,
    });

    const file = await xlsxFile((sheet) => {
      sheet.addRow(["Name", "Vendor", "Type", "Cost", "Color Name"]);
      const row = sheet.addRow([]);
      row.getCell(1).value = "Err PLA";
      row.getCell(2).value = "V";
      row.getCell(3).value = "PLA";
      // An error-valued formula (`{formula, result: {error}}`) normalizes
      // to null — the same empty cell the CSV path produces, which the
      // update path clears (consistent with an empty CSV Cost cell) —
      // never a NaN-poisoned "[object Object]" coercion.
      row.getCell(4).value = { formula: "1/0", result: { error: "#DIV/0!" } };
      // A hyperlink whose display TEXT is itself rich text — the one-hop
      // recursion (`normalizeCellValue(obj.text, …, depth + 1)`) joins it.
      // (ExcelJS cannot WRITE a rich-text formula result — the XLSX format
      // caches formula results as plain values — so this is the writable
      // shape that exercises the same nested-object recursion.)
      // ExcelJS's HyperlinkValue TYPE declares `text: string`, but the
      // library round-trips a rich-text `text` object at runtime (verified
      // by the assertion below) — hence the cast.
      row.getCell(5).value = {
        text: { richText: [{ text: "Galaxy" }, { text: " Black" }] },
        hyperlink: "https://example.com/color",
      } as unknown as ExcelJS.CellValue;
    });

    const res = await importXlsx(
      multipartReq("http://localhost/api/filaments/import-xlsx", file),
    );
    expect(res.status).toBe(200);

    const doc = await Filament.findOne({ name: "Err PLA", _deletedAt: null });
    expect(doc!.cost).toBeNull();
    expect(doc!.colorName).toBe("Galaxy Black");
  });

  it("uses the display text for a hyperlink cell in a non-tdsUrl column", async () => {
    const file = await xlsxFile((sheet) => {
      sheet.addRow(["Name", "Vendor", "Type"]);
      const row = sheet.addRow([]);
      row.getCell(1).value = {
        text: "Linked PLA",
        hyperlink: "https://example.com/product",
      };
      row.getCell(2).value = "V";
      row.getCell(3).value = "PLA";
    });

    const res = await importXlsx(
      multipartReq("http://localhost/api/filaments/import-xlsx", file),
    );
    expect(res.status).toBe(200);
    expect(
      await Filament.findOne({ name: "Linked PLA", _deletedAt: null }),
    ).not.toBeNull();
  });

  it("maps a rich-text HEADER cell (a bolded column title) instead of failing the required-column check", async () => {
    const file = await xlsxFile((sheet) => {
      const header = sheet.addRow(["", "Vendor", "Type"]);
      header.getCell(1).value = {
        richText: [{ font: { bold: true }, text: "Name" }],
      };
      sheet.addRow(["Header PLA", "V", "PLA"]);
    });

    const res = await importXlsx(
      multipartReq("http://localhost/api/filaments/import-xlsx", file),
    );
    expect(res.status).toBe(200);
    expect(
      await Filament.findOne({ name: "Header PLA", _deletedAt: null }),
    ).not.toBeNull();
  });
});
