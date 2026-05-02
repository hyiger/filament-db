import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as importSpools } from "@/app/api/spools/import/route";

/**
 * Tests for the CSV bulk spool import route. parseCsv itself is covered
 * in parseCsv.test.ts; this file validates the glue between the parser,
 * the Filament lookup (with optional vendor disambiguation), and the
 * location-rehydration cache that auto-creates missing locations.
 */
describe("/api/spools/import", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Location: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    const locationMod = await import("@/models/Location");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    if (!mongoose.models.Location) {
      mongoose.model("Location", locationMod.default.schema);
    }
    Filament = mongoose.models.Filament;
    Location = mongoose.models.Location;
  });

  function csvRequest(csv: string, contentType = "text/csv") {
    return new NextRequest("http://localhost/api/spools/import", {
      method: "POST",
      headers: { "content-type": contentType },
      body: csv,
    });
  }

  function jsonRequest(csv: string) {
    return new NextRequest("http://localhost/api/spools/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv }),
    });
  }

  it("imports a matching filament's spool", async () => {
    const f = await Filament.create({
      name: "Prusament PLA Galaxy Black",
      vendor: "Prusa Polymers",
      type: "PLA",
    });

    const csv =
      "filament,totalWeight\n" +
      `Prusament PLA Galaxy Black,950\n`;
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(950);
  });

  it("uses the CSV vendor to guard against mismatched filament names", async () => {
    // Schema enforces unique `name` among non-deleted filaments, so two rows
    // can't actually share a name. But the importer still filters by vendor
    // when it's supplied in the CSV, as a safety check: if the CSV says a
    // vendor the DB row doesn't match, the row should fail rather than
    // quietly attach the spool to the wrong filament.
    const target = await Filament.create({ name: "PLA Black", vendor: "Vendor A", type: "PLA" });

    // Matching vendor — should import successfully.
    const csvMatching =
      "filament,vendor,totalWeight\n" +
      `PLA Black,Vendor A,800\n`;
    const okRes = await importSpools(csvRequest(csvMatching));
    const okBody = await okRes.json();
    expect(okBody.imported).toBe(1);
    expect(okBody.failed).toBe(0);

    // Wrong vendor — should fail the row rather than match by name alone.
    const csvMismatching =
      "filament,vendor,totalWeight\n" +
      `PLA Black,Vendor B,900\n`;
    const failRes = await importSpools(csvRequest(csvMismatching));
    const failBody = await failRes.json();
    expect(failBody.imported).toBe(0);
    expect(failBody.failed).toBe(1);
    const failedRow = failBody.results.find((r: { ok: boolean; error?: string }) => !r.ok);
    expect(failedRow.error).toMatch(/Vendor B/);

    const fresh = await Filament.findById(target._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(800);
  });

  it("auto-creates referenced locations by name", async () => {
    const f = await Filament.create({ name: "Loc Test", vendor: "Test", type: "PLA" });
    const csv =
      "filament,totalWeight,location\n" +
      `Loc Test,500,Drybox 1\n` +
      `Loc Test,600,Drybox 2\n` +
      `Loc Test,700,Drybox 1\n`;

    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(3);

    const locs = await Location.find({ _deletedAt: null }).sort({ name: 1 });
    expect(locs.map((l: { name: string }) => l.name)).toEqual(["Drybox 1", "Drybox 2"]);

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(3);
    // Both Drybox 1 rows should share the same locationId.
    const locIds = fresh.spools.map((s: { locationId: unknown }) => String(s.locationId));
    expect(locIds[0]).toBe(locIds[2]);
    expect(locIds[0]).not.toBe(locIds[1]);
  });

  it("reports per-row errors without aborting the batch", async () => {
    await Filament.create({ name: "Known", vendor: "Test", type: "PLA" });
    const csv =
      "filament,totalWeight\n" +
      `Known,800\n` +
      `Unknown,500\n` +
      `Known,-10\n` +
      `,100\n`;
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(3);
    expect(body.results[1].error).toMatch(/No filament named "Unknown"/);
    expect(body.results[2].error).toMatch(/non-negative/);
    expect(body.results[3].error).toMatch(/filament is required/);
  });

  it("accepts the alternate JSON body shape", async () => {
    await Filament.create({ name: "JSON Path", vendor: "Test", type: "PLA" });
    const csv = "filament,totalWeight\nJSON Path,250\n";
    const res = await importSpools(jsonRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
  });

  it("rejects an empty body with 400", async () => {
    const res = await importSpools(csvRequest(""));
    expect(res.status).toBe(400);
  });

  it("rejects a CSV missing required columns", async () => {
    const res = await importSpools(csvRequest("filament\nOnly-Name\n"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/totalWeight/);
  });

  it("strips a UTF-8 BOM from the start of the body", async () => {
    await Filament.create({ name: "BOM Test", vendor: "Test", type: "PLA" });
    const csv = "\uFEFFfilament,totalWeight\nBOM Test,100\n";
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
  });

  // Codex P2 on PR #141 — round-trip parity with `/api/spools/export-csv`,
  // which emits an empty `totalWeight` cell for spools that genuinely have
  // no recorded weight (e.g. spools created via POST /api/filaments/[id]/spools
  // which defaults to null). Pre-fix the importer coerced "" → 0 because
  // Number("") === 0, silently overwriting null with a meaningless zero.
  it("preserves a null totalWeight when the cell is empty (round-trip parity with the exporter)", async () => {
    const f = await Filament.create({ name: "Round-Trip", vendor: "Test", type: "PLA" });
    const csv = "filament,totalWeight\nRound-Trip,\n";
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBeNull();
  });

  it("still rejects non-numeric or negative totalWeight cells (only blank maps to null)", async () => {
    await Filament.create({ name: "Strict", vendor: "Test", type: "PLA" });
    const csv = "filament,totalWeight\nStrict,abc\nStrict,-5\n";
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(0);
    expect(body.failed).toBe(2);
    expect(body.results[0].error).toMatch(/non-negative/);
    expect(body.results[1].error).toMatch(/non-negative/);
  });

  // Codex P2 follow-up to PR #144 — `csvCell` prefixes formula-leading
  // STRING cells with a `'` so spreadsheets read them as text. The
  // importer must strip that guard so a row exported with a name like
  // `=Eval` round-trips back to the original filament without keeping
  // the apostrophe in the matched/persisted text.
  it("strips the formula-guard apostrophe so an exported '=Name' row matches its filament on re-import", async () => {
    const f = await Filament.create({
      name: "=Generic", // legit-but-formula-shaped filament name
      vendor: "Test",
      type: "PLA",
    });
    // Simulate a row produced by /api/spools/export-csv: the exporter
    // wrote `'=Generic` (apostrophe prefix). The importer must match
    // back to the original filament.
    const csv = "filament,totalWeight\n'=Generic,950\n";
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(950);
  });

  it("strips the formula-guard apostrophe from label / lotNumber / location when present", async () => {
    const f = await Filament.create({ name: "Strip", vendor: "Test", type: "PLA" });
    // Label, lotNumber, and location all start with `=` originally.
    // After export they'd be `'=label` / `'=LOT-1` / `'=Drybox` and
    // re-import must restore the original strings — otherwise the
    // matched location name would be `'=Drybox` (a different row from
    // the original) and analytics on label / lot would diverge.
    const csv =
      "filament,totalWeight,label,lotNumber,location\n" +
      `Strip,500,'=Lab Use,'=LOT-1,'=Drybox\n`;
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);

    const fresh = await Filament.findById(f._id);
    const spool = fresh.spools[0];
    expect(spool.label).toBe("=Lab Use");
    expect(spool.lotNumber).toBe("=LOT-1");
    // resolveLocationId used the unsanitized name; the row should now
    // reference a location with that exact name, not "'=Drybox".
    const Location = (await import("@/models/Location")).default;
    const loc = await Location.findOne({ name: "=Drybox" });
    expect(loc).not.toBeNull();
    expect(spool.locationId.toString()).toBe(loc!._id.toString());
  });

  it("leaves apostrophe-prefixed values alone when the next char isn't a formula trigger ('70s blue)", async () => {
    await Filament.create({ name: "'70s Style", vendor: "Test", type: "PLA" });
    const csv = "filament,totalWeight\n'70s Style,800\n";
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    // Should match — the leading `'` followed by `7` is not a guard
    // pattern, so unsanitize leaves it intact and the filament lookup
    // finds the seeded row.
    expect(body.imported).toBe(1);
  });

  describe("GH #159: round-trip dedup via spoolId", () => {
    it("re-importing an exported CSV updates existing spools instead of duplicating", async () => {
      // Seed a filament with a single spool so we can capture the spoolId
      // the exporter would emit and feed it back through the importer.
      const f = await Filament.create({
        name: "PLA Black",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "Original", totalWeight: 1000 }],
      });
      const seededSpoolId = String(f.spools[0]._id);

      // Re-import the exact row the exporter would produce, including the
      // spoolId column. Pre-fix this would push a NEW spool (doubling
      // the count). Post-fix it should update the existing one.
      const csv =
        "filament,totalWeight,label,spoolId\n" +
        `PLA Black,950,Original,${seededSpoolId}\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.created).toBe(0);
      expect(body.updated).toBe(1);
      expect(body.results[0].action).toBe("updated");

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1); // NOT 2
      expect(String(fresh.spools[0]._id)).toBe(seededSpoolId);
      expect(fresh.spools[0].totalWeight).toBe(950); // updated value persisted
    });

    it("a row whose spoolId doesn't match falls through to create (so foreign exports still work)", async () => {
      const f = await Filament.create({
        name: "PETG Blue",
        vendor: "Test",
        type: "PETG",
      });

      // spoolId from a different DB / filament — exporter from another
      // instance would carry an _id this DB has never seen. The current
      // filament has no spools, so .id() returns null and the row creates.
      const foreignSpoolId = new mongoose.Types.ObjectId().toString();
      const csv =
        "filament,totalWeight,spoolId\n" +
        `PETG Blue,850,${foreignSpoolId}\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.created).toBe(1);
      expect(body.updated).toBe(0);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1);
      expect(fresh.spools[0].totalWeight).toBe(850);
    });

    it("a row with no spoolId column behaves exactly like the legacy create path", async () => {
      const f = await Filament.create({
        name: "TPU Red",
        vendor: "Test",
        type: "TPU",
        spools: [{ label: "Existing", totalWeight: 500 }],
      });

      const csv =
        "filament,totalWeight,label\n" +
        `TPU Red,1000,Newly added\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.created).toBe(1);
      expect(body.updated).toBe(0);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(2); // existing + newly created
      expect(fresh.spools[1].label).toBe("Newly added");
      expect(fresh.spools[1].totalWeight).toBe(1000);
    });

    it("mixed CSV with one update and one create reports both counts correctly", async () => {
      const f = await Filament.create({
        name: "ASA Grey",
        vendor: "Test",
        type: "ASA",
        spools: [{ label: "First", totalWeight: 1000 }],
      });
      const existingId = String(f.spools[0]._id);

      const csv =
        "filament,totalWeight,label,spoolId\n" +
        `ASA Grey,800,First,${existingId}\n` +     // updates existing
        `ASA Grey,1000,Second,\n`;                   // creates new
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(2);
      expect(body.created).toBe(1);
      expect(body.updated).toBe(1);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(2);
      const byId = new Map(fresh.spools.map((s: { _id: { toString(): string }; totalWeight: number; label: string }) => [String(s._id), s]));
      expect(byId.get(existingId)?.totalWeight).toBe(800);
    });
  });
});
