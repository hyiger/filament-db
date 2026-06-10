import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as importFilaments } from "@/app/api/filaments/import/route";
import { POST as importCsv } from "@/app/api/filaments/import-csv/route";
import { GET as exportFilaments } from "@/app/api/filaments/export/route";
import { GET as exportCsv } from "@/app/api/filaments/export-csv/route";

/**
 * Route-level tests for the filament import/export endpoints. The data
 * transform helpers (parseIniFilaments, generatePrusaSlicerBundle, csvWriter)
 * are exercised by their own unit tests; this file covers HTTP-level
 * behaviour: missing file → 400, empty INI → 400, valid INI upserts,
 * CSV header dispatch, export contents.
 */
describe("/api/filaments/import + export", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    // Register all referenced models — the export route does .populate()
    // for calibrations.nozzle / calibrations.printer / calibrations.bedType,
    // which throws "Schema hasn't been registered" if those models aren't
    // in mongoose.models. setup.ts wipes mongoose.models between tests.
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const prtMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    Filament = mongoose.models.Filament;
    await Filament.syncIndexes();
  });

  function multipartReq(url: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    return new NextRequest(url, { method: "POST", body: fd });
  }

  describe("POST /api/filaments/import (INI)", () => {
    it("returns 400 when no file is attached", async () => {
      const req = new NextRequest("http://localhost/api/filaments/import", {
        method: "POST",
        body: new FormData(),
      });
      const res = await importFilaments(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/file/i);
    });

    it("returns 400 when the INI file contains no filament profiles", async () => {
      const file = new File(["# just a comment\n[printer:Mk4]\nname = Mk4\n"], "empty.ini", {
        type: "text/plain",
      });
      const res = await importFilaments(
        multipartReq("http://localhost/api/filaments/import", file),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no filament profiles/i);
    });

    it("creates new filaments from a valid INI bundle", async () => {
      const ini = `[filament:My PLA Black]
filament_type = PLA
filament_vendor = MyVendor
filament_diameter = 1.75
temperature = 215
bed_temperature = 60
`;
      const file = new File([ini], "filaments.ini", { type: "text/plain" });
      const res = await importFilaments(
        multipartReq("http://localhost/api/filaments/import", file),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(1);
      expect(body.updated).toBe(0);

      const created = await Filament.findOne({ name: "My PLA Black" });
      expect(created).toBeTruthy();
      expect(created.type).toBe("PLA");
    });

    it("updates an existing filament with the same name (upsert behaviour)", async () => {
      await Filament.create({
        name: "My PLA Black",
        vendor: "OldVendor",
        type: "PLA",
      });

      const ini = `[filament:My PLA Black]
filament_type = PLA
filament_vendor = NewVendor
filament_diameter = 1.75
`;
      const file = new File([ini], "filaments.ini", { type: "text/plain" });
      const res = await importFilaments(
        multipartReq("http://localhost/api/filaments/import", file),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(0);
      expect(body.updated).toBe(1);

      const updated = await Filament.findOne({ name: "My PLA Black" });
      expect(updated.vendor).toBe("NewVendor");
    });

    it("resurrects a soft-deleted filament when upserting (no duplicate)", async () => {
      // GH #297: a filament with this name is in the trash. Importing the
      // same name resurrects-and-updates the trashed row rather than
      // creating a second active row that would shadow it — a duplicate
      // would strand the trashed one (its restore would 409 forever on
      // the name conflict).
      const trashed = await Filament.create({
        name: "Trashed PLA",
        vendor: "Old",
        type: "PLA",
        _deletedAt: new Date(),
      });

      const ini = `[filament:Trashed PLA]
filament_type = PLA
filament_vendor = New
`;
      const file = new File([ini], "filaments.ini", { type: "text/plain" });
      const res = await importFilaments(
        multipartReq("http://localhost/api/filaments/import", file),
      );
      expect(res.status).toBe(200);

      const all = await Filament.find({ name: "Trashed PLA" });
      // Only one row — the trashed one was revived, not duplicated.
      expect(all).toHaveLength(1);
      expect(String(all[0]._id)).toBe(String(trashed._id));
      expect(all[0]._deletedAt).toBeNull();
      expect(all[0].vendor).toBe("New");
    });
  });

  describe("POST /api/filaments/import-csv", () => {
    it("returns 400 when no file is attached", async () => {
      const req = new NextRequest("http://localhost/api/filaments/import-csv", {
        method: "POST",
        body: new FormData(),
      });
      const res = await importCsv(req);
      expect(res.status).toBe(400);
    });

    it("imports a basic CSV row", async () => {
      const csv = `name,vendor,type,color
"My CSV PLA",MyVendor,PLA,#ff0000
`;
      const file = new File([csv], "filaments.csv", { type: "text/csv" });
      const res = await importCsv(
        multipartReq("http://localhost/api/filaments/import-csv", file),
      );
      expect(res.status).toBe(200);
      const created = await Filament.findOne({ name: "My CSV PLA" });
      expect(created).toBeTruthy();
      expect(created.color).toBe("#ff0000");
    });
  });

  describe("GET /api/filaments/export (INI bundle)", () => {
    it("returns text/plain with an attachment Content-Disposition", async () => {
      await Filament.create({ name: "Export PLA", vendor: "T", type: "PLA" });
      const res = await exportFilaments();
      expect(res.status).toBe(200);
      // GH #341 aligned this with /api/filaments/prusaslicer (charset=utf-8)
      expect(res.headers.get("Content-Type")).toMatch(/^text\/plain(;\s*charset=utf-8)?$/);
      expect(res.headers.get("Content-Disposition")).toMatch(/attachment.*\.ini/);
      const text = await res.text();
      expect(text).toMatch(/Export PLA/);
    });

    it("excludes soft-deleted filaments from the export", async () => {
      await Filament.create({ name: "Live PLA", vendor: "T", type: "PLA" });
      await Filament.create({
        name: "Trashed PLA",
        vendor: "T",
        type: "PLA",
        _deletedAt: new Date(),
      });
      const res = await exportFilaments();
      const text = await res.text();
      expect(text).toMatch(/Live PLA/);
      expect(text).not.toMatch(/Trashed PLA/);
    });
  });

  describe("GET /api/filaments/export-csv", () => {
    it("returns text/csv with an attachment header", async () => {
      await Filament.create({ name: "CSV Export PLA", vendor: "T", type: "PLA" });
      const res = await exportCsv();
      expect(res.status).toBe(200);
      const ct = res.headers.get("Content-Type") ?? "";
      expect(ct).toMatch(/text\/csv/);
      const text = await res.text();
      expect(text).toMatch(/CSV Export PLA/);
    });

    it("excludes soft-deleted filaments", async () => {
      await Filament.create({ name: "Active CSV", vendor: "T", type: "PLA" });
      await Filament.create({
        name: "Trashed CSV",
        vendor: "T",
        type: "PLA",
        _deletedAt: new Date(),
      });
      const res = await exportCsv();
      const text = await res.text();
      expect(text).toMatch(/Active CSV/);
      expect(text).not.toMatch(/Trashed CSV/);
    });
  });

  describe("import row caps (GH #627)", () => {
    it("rejects a CSV with more than 10,000 data rows with 400", async () => {
      const header = "Name,Vendor,Type";
      const rows = Array.from({ length: 10_001 }, (_, i) => `Cap F${i},V,PLA`);
      const file = new File([[header, ...rows].join("\n")], "big.csv", {
        type: "text/csv",
      });
      const res = await importCsv(
        multipartReq("http://localhost/api/filaments/import-csv", file),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Import too large/);
      expect(body.error).toMatch(/10000/);
      // Nothing was imported.
      expect(await Filament.countDocuments({ name: /^Cap F/ })).toBe(0);
    });

    it("rejects an XLSX with more than 10,000 data rows with 400", async () => {
      const { POST: importXlsx } = await import("@/app/api/filaments/import-xlsx/route");
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Filaments");
      sheet.addRow(["Name", "Vendor", "Type"]);
      for (let i = 0; i < 10_001; i++) {
        sheet.addRow([`Cap X${i}`, "V", "PLA"]);
      }
      const buffer = await workbook.xlsx.writeBuffer();
      const file = new File([buffer], "big.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const res = await importXlsx(
        multipartReq("http://localhost/api/filaments/import-xlsx", file),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Import too large/);
      expect(await Filament.countDocuments({ name: /^Cap X/ })).toBe(0);
    }, 30_000);

    it("rejects an import-atlas request with more than 1,000 filament IDs with 400 (before any network)", async () => {
      const { POST: importAtlas } = await import("@/app/api/filaments/import-atlas/route");
      const ids = Array.from({ length: 1_001 }, (_, i) =>
        i.toString(16).padStart(24, "0"),
      );
      const req = new NextRequest("http://localhost/api/filaments/import-atlas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The cap is checked before the SSRF guard / remote connect, so
        // this hostname is never resolved.
        body: JSON.stringify({
          uri: "mongodb+srv://cluster.example.com/db",
          filamentIds: ids,
        }),
      });
      const res = await importAtlas(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Too many filament IDs/);
    });
  });
});
