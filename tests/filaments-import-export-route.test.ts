import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as importFilaments } from "@/app/api/filaments/import/route";
import { POST as prusaImport } from "@/app/api/filaments/prusaslicer/route";
import { POST as parseIni } from "@/app/api/filaments/parse-ini/route";
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

    it("#872: a multi-nozzle bundle round-trip updates the base filament, not orphan suffixed rows", async () => {
      const base = await Filament.create({
        name: "PLA",
        vendor: "Generic",
        type: "PLA",
        temperatures: { nozzle: 210, bed: 60 },
      });
      // What a Filament DB multi-nozzle export emits: two suffixed sections that
      // share one filamentdb_id, each with a filamentdb_nozzle hint + baked temps.
      const ini = `[filament:PLA 0.4 Brass]
filament_type = PLA
filament_vendor = Generic
temperature = 205
filamentdb_id = ${base._id}
filamentdb_nozzle = 0.4 Brass
extrusion_multiplier = 0.95

[filament:PLA 0.6 Brass]
filament_type = PLA
filament_vendor = Generic
temperature = 215
filamentdb_id = ${base._id}
filamentdb_nozzle = 0.6 Brass
filament_max_volumetric_speed = 20
`;
      const file = new File([ini], "bundle.ini", { type: "text/plain" });
      const res = await importFilaments(
        multipartReq("http://localhost/api/filaments/import", file),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // Collapsed to ONE base filament — no orphan suffixed records created.
      expect(body.created).toBe(0);
      expect(body.updated).toBe(1);
      expect(await Filament.findOne({ name: "PLA 0.4 Brass" })).toBeNull();
      expect(await Filament.findOne({ name: "PLA 0.6 Brass" })).toBeNull();
      const fresh = await Filament.findById(base._id);
      // Base temps are NOT clobbered by either nozzle's baked value, and the
      // routing hints / baked per-nozzle keys never land in the settings bag.
      expect(fresh.temperatures.nozzle).toBe(210);
      expect(fresh.settings?.filamentdb_id).toBeUndefined();
      expect(fresh.settings?.filamentdb_nozzle).toBeUndefined();
      expect(fresh.settings?.extrusion_multiplier).toBeUndefined();
    });
  });

  describe("POST /api/filaments/prusaslicer (bundle import)", () => {
    it("#872: collapses suffixed sections back to the base on a bundle round-trip", async () => {
      const base = await Filament.create({
        name: "PETG",
        vendor: "Generic",
        type: "PETG",
        temperatures: { nozzle: 240 },
      });
      const ini = `[filament:PETG 0.4 Brass]
filament_type = PETG
filament_vendor = Generic
temperature = 235
filamentdb_id = ${base._id}
filamentdb_nozzle = 0.4 Brass

[filament:PETG 0.6 Brass]
filament_type = PETG
filament_vendor = Generic
temperature = 245
filamentdb_id = ${base._id}
filamentdb_nozzle = 0.6 Brass
`;
      const res = await prusaImport(
        new NextRequest("http://localhost/api/filaments/prusaslicer", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: ini,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(0);
      expect(body.updated).toBe(1);
      expect(await Filament.findOne({ name: "PETG 0.4 Brass" })).toBeNull();
      expect(await Filament.findOne({ name: "PETG 0.6 Brass" })).toBeNull();
      const fresh = await Filament.findById(base._id);
      expect(fresh.temperatures.nozzle).toBe(240); // not clobbered by 235/245
    });

    it("#872: a hint-only collapsed section does NOT clobber the base's vendor/type/cost/density/color", async () => {
      const base = await Filament.create({
        name: "ABS",
        vendor: "Generic",
        type: "ABS",
        color: "#1a2b3c",
        cost: 30,
        density: 1.04,
      });
      // A fully partial suffixed section: only the routing hints, NO shared fields.
      const ini = `[filament:ABS 0.4 Brass]
filamentdb_id = ${base._id}
filamentdb_nozzle = 0.4 Brass
`;
      const res = await prusaImport(
        new NextRequest("http://localhost/api/filaments/prusaslicer", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: ini,
        }),
      );
      expect(res.status).toBe(200);
      const fresh = await Filament.findById(base._id);
      expect(fresh.vendor).toBe("Generic"); // not clobbered to "Unknown"
      expect(fresh.type).toBe("ABS"); // not clobbered to "Unknown"
      expect(fresh.color).toBe("#1a2b3c"); // not clobbered to #808080
      expect(fresh.cost).toBe(30); // not nulled
      expect(fresh.density).toBe(1.04); // not nulled
    });

    it("#872: a bad partial section degrades to a per-row error (200 + errors[]), not a whole-bundle 500", async () => {
      // One valid section + one partial per-nozzle section that collapses to a NEW
      // base "Ghost" with no vendor/type → create fails the required-field validation.
      const ini = `[filament:Good PLA]
filament_type = PLA
filament_vendor = Acme
temperature = 210

[filament:Ghost 0.4 Brass]
filamentdb_nozzle = 0.4 Brass
`;
      const res = await prusaImport(
        new NextRequest("http://localhost/api/filaments/prusaslicer", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: ini,
        }),
      );
      expect(res.status).toBe(200); // NOT 500 — the bad row is isolated
      const body = await res.json();
      expect(body.created).toBe(1); // Good PLA still created
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatch(/Ghost/);
      expect(await Filament.findOne({ name: "Good PLA" })).toBeTruthy();
      expect(await Filament.findOne({ name: "Ghost" })).toBeNull();
    });
  });

  describe("POST /api/filaments/parse-ini (#872 prefill)", () => {
    it("collapses suffixed sections so the prefill shows the base name, no baked keys", async () => {
      const ini = `[filament:PLA 0.4 Brass]
filament_type = PLA
filament_vendor = Generic
temperature = 205
filamentdb_id = 64b000000000000000000003
filamentdb_nozzle = 0.4 Brass
extrusion_multiplier = 0.95

[filament:PLA 0.6 Brass]
filament_type = PLA
filament_vendor = Generic
temperature = 215
filamentdb_id = 64b000000000000000000003
filamentdb_nozzle = 0.6 Brass
`;
      const file = new File([ini], "export.ini", { type: "text/plain" });
      const res = await parseIni(multipartReq("http://localhost/api/filaments/parse-ini", file));
      expect(res.status).toBe(200);
      const { filaments } = await res.json();
      expect(filaments).toHaveLength(1); // collapsed
      expect(filaments[0].name).toBe("PLA"); // de-suffixed, not "PLA 0.4 Brass"
      expect(filaments[0].settings.filamentdb_nozzle).toBeUndefined();
      expect(filaments[0].settings.extrusion_multiplier).toBeUndefined();
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

    it("#888: handles a quoted cell with an embedded newline without shredding the next row", async () => {
      // The middle cell spans two physical lines; a row follows it. The old
      // parser split on \n before quote-parsing → it shredded this into bogus
      // rows. parseCsv keeps the quoted newline intact.
      const csv =
        'name,vendor,type,colorName\r\n' +
        '"Multi PLA",MyVendor,PLA,"Galaxy\r\nBlack"\r\n' +
        '"Second PLA",MyVendor,PETG,Red\r\n';
      const file = new File([csv], "filaments.csv", { type: "text/csv" });
      const res = await importCsv(
        multipartReq("http://localhost/api/filaments/import-csv", file),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(2); // exactly two rows, not a shredded extra

      const multi = await Filament.findOne({ name: "Multi PLA" });
      expect(multi).toBeTruthy();
      expect(multi.colorName).toContain("Galaxy");
      expect(multi.colorName).toContain("Black"); // embedded newline preserved
      const second = await Filament.findOne({ name: "Second PLA" });
      expect(second).toBeTruthy();
      expect(second.type).toBe("PETG"); // the row after the multi-line cell is intact
      // No junk filament from a shredded fragment.
      expect(await Filament.findOne({ name: 'Black"' })).toBeNull();
    });

    it("#888: a trailing blank/separator line does not count toward the data-row cap", async () => {
      // Codex P2: the data-row cap applies AFTER blanks are filtered, so a valid
      // file with a trailing blank line isn't falsely rejected as "too large".
      const csv =
        "name,vendor,type\r\n" +
        '"Blank Tail PLA",MyVendor,PLA\r\n' +
        "\r\n"; // trailing blank line
      const file = new File([csv], "filaments.csv", { type: "text/csv" });
      const res = await importCsv(
        multipartReq("http://localhost/api/filaments/import-csv", file),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(1);
      expect(await Filament.findOne({ name: "Blank Tail PLA" })).toBeTruthy();
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
