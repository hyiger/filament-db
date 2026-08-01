import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { GET } from "@/app/api/filaments/export-xlsx/route";

/**
 * Route test for GET /api/filaments/export-xlsx. Previously uncovered. Loads
 * the emitted bytes back through ExcelJS to prove it's a valid workbook with
 * a header row + one data row per filament, and the right download headers.
 */
describe("GET /api/filaments/export-xlsx", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("streams a valid .xlsx workbook with one data row per filament", async () => {
    await Filament.create({
      name: "Galaxy Black",
      vendor: "Prusa",
      type: "PETG",
      color: "#292929",
    });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toContain("filaments.xlsx");

    const buf = Buffer.from(await res.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    // ExcelJS's `load(buffer: Buffer)` typedef clashes with @types/node's
    // generic Buffer<ArrayBufferLike>; runtime is a real Node Buffer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(buf as any);
    const sheet = wb.getWorksheet("Filaments");
    expect(sheet).toBeTruthy();
    // header row (1) + one data row (2)
    expect(sheet!.rowCount).toBe(2);
    const dataRow = sheet!.getRow(2).values as unknown[];
    expect(dataRow).toContain("Galaxy Black");
  });

  it("exports a null-color filament without throwing (GH #605 — cleared color)", async () => {
    await Filament.create({
      name: "Colorless Template PLA",
      vendor: "Generic",
      type: "PLA",
      color: null,
    });

    const res = await GET();
    expect(res.status).toBe(200);

    const buf = Buffer.from(await res.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(buf as any);
    const sheet = wb.getWorksheet("Filaments");
    expect(sheet!.rowCount).toBe(2);
    const dataRow = sheet!.getRow(2).values as unknown[];
    expect(dataRow).toContain("Colorless Template PLA");
  });

  it("returns a workbook with just the header when there are no filaments", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
    const sheet = wb.getWorksheet("Filaments");
    expect(sheet!.rowCount).toBe(1); // header only
  });
});
