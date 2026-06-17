import { describe, it, expect, beforeEach, vi } from "vitest";
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

    it("partial-column update preserves existing metadata (Codex P1 PR #172)", async () => {
      // Seed a spool with full metadata. A re-import that only includes
      // filament/totalWeight/spoolId (e.g. bulk weight tweak) must NOT
      // null out label/lotNumber/dates/location on the matched spool.
      const f = await Filament.create({
        name: "PETG Yellow",
        vendor: "Test",
        type: "PETG",
        spools: [
          {
            label: "Yellow shelf #2",
            totalWeight: 950,
            lotNumber: "LOT-007",
            purchaseDate: new Date("2025-01-15"),
            openedDate: new Date("2025-02-01"),
          },
        ],
      });
      const spoolId = String(f.spools[0]._id);

      const csv =
        "filament,totalWeight,spoolId\n" +
        `PETG Yellow,825,${spoolId}\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.updated).toBe(1);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1);
      const updated = fresh.spools[0];
      expect(updated.totalWeight).toBe(825);                // updated
      expect(updated.label).toBe("Yellow shelf #2");        // preserved
      expect(updated.lotNumber).toBe("LOT-007");            // preserved
      expect(updated.purchaseDate?.toISOString().slice(0, 10)).toBe("2025-01-15"); // preserved
      expect(updated.openedDate?.toISOString().slice(0, 10)).toBe("2025-02-01");   // preserved
    });

    it("explicit empty cell on update path clears the field (round-trip with full export)", async () => {
      // Distinguishing "column absent" from "column present + empty" is
      // the round-trip contract: an exported CSV that includes label as
      // an empty cell means the spool genuinely has no label, and the
      // re-import should respect that.
      const f = await Filament.create({
        name: "TPU Pink",
        vendor: "Test",
        type: "TPU",
        spools: [{ label: "Old label", totalWeight: 800 }],
      });
      const spoolId = String(f.spools[0]._id);

      const csv =
        "filament,totalWeight,label,spoolId\n" +
        `TPU Pink,800,,${spoolId}\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.updated).toBe(1);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].label).toBe(""); // explicitly cleared
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
      const updatedSpool = fresh.spools.find(
        (s: { _id: { toString(): string }; totalWeight: number }) =>
          String(s._id) === existingId,
      );
      expect(updatedSpool?.totalWeight).toBe(800);
    });
  });

  // GH #370: a per-row save() failure (e.g. mongoose VersionError under
  // concurrent writers) must not abort the whole batch. Pre-fix the throw
  // escaped the row loop into the outer 500 catch and the user lost the
  // already-processed rows' results entirely.
  // GH #525.1: a paste of N spools for the same filament must hit the
  // filament collection ONCE (cached find) and save ONCE (batched), not
  // N finds + N saves.
  describe("filament cache + batched save (N+1 fix)", () => {
    it("imports many spools of one filament with a single find + single save", async () => {
      await Filament.create({ name: "Bulk PLA", vendor: "V", type: "PLA" });

      // The route holds its own module-default Filament reference (the
      // beforeEach re-registration replaces mongoose.models.Filament but the
      // route's import is cached), so spy on the module default to observe
      // the route's actual findOne calls.
      const RouteFilament = (await import("@/models/Filament")).default;
      const findSpy = vi.spyOn(RouteFilament, "findOne");
      const saveSpy = vi.spyOn(mongoose.Model.prototype, "save");
      try {
        const rows = Array.from({ length: 20 }, (_, n) => `Bulk PLA,${800 + n}`).join("\n");
        const res = await importSpools(csvRequest(`filament,totalWeight\n${rows}\n`));
        const body = await res.json();
        expect(body.imported).toBe(20);
        expect(body.failed).toBe(0);

        // The filament was looked up exactly once (cache hit for rows 2-20).
        const bulkFinds = findSpy.mock.calls.filter(
          (c) => (c[0] as { name?: string })?.name === "Bulk PLA",
        );
        expect(bulkFinds).toHaveLength(1);
        // And saved exactly once — all 20 spools persisted in one write.
        expect(saveSpy).toHaveBeenCalledTimes(1);

        const fresh = await Filament.findOne({ name: "Bulk PLA" });
        expect(fresh.spools).toHaveLength(20);
      } finally {
        findSpy.mockRestore();
        saveSpy.mockRestore();
      }
    });
  });

  // Codex P1 on PR #546: two rows for the SAME filament that resolve via
  // different cache keys (one omits vendor, one supplies the matching vendor)
  // used to hydrate two separate Mongoose document instances for the same
  // _id. Only the bucket's instance was saved, so the other row's spool was
  // silently dropped while the row still reported ok. Every row for a given
  // filament must accumulate onto the one saved instance.
  describe("mixed vendor-presence rows for the same filament (#546)", () => {
    it("persists ALL spools when rows alternate omitted + matching vendor", async () => {
      const f = await Filament.create({ name: "PLA", vendor: "Vendor A", type: "PLA" });
      const csv =
        "filament,vendor,totalWeight\n" +
        `PLA,,800\n` + // no vendor → matches by name
        `PLA,Vendor A,900\n` + // matching vendor → same _id, different cache key
        `PLA,,700\n`; // no vendor again
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(3);
      expect(body.failed).toBe(0);
      expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

      // The bug dropped the matching-vendor row's spool: pre-fix this was 2.
      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(3);
      expect(fresh.spools.map((s: { totalWeight: number }) => s.totalWeight).sort()).toEqual([700, 800, 900]);
    });

    // Codex P2 on PR #547: registering the touched bucket BEFORE date
    // validation meant a row that resolved a filament but then failed
    // validation still got the filament save()'d (no mutation, wasted write).
    // A row that fails validation must leave its filament completely untouched.
    it("does not save a filament whose only row fails date validation", async () => {
      const f = await Filament.create({ name: "Untouched", vendor: "V", type: "PLA" });
      const saveSpy = vi.spyOn(mongoose.Model.prototype, "save");
      try {
        const csv =
          "filament,totalWeight,purchaseDate\n" +
          `Untouched,800,2025-02-29\n`; // impossible date → row fails
        const res = await importSpools(csvRequest(csv));
        const body = await res.json();
        expect(body.imported).toBe(0);
        expect(body.failed).toBe(1);
        // No mutation occurred, so the filament must not be saved at all.
        expect(saveSpy).not.toHaveBeenCalled();
      } finally {
        saveSpy.mockRestore();
      }
      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(0);
    });
  });

  describe("per-row save failure isolation", () => {
    it("continues processing remaining rows when one save() throws", async () => {
      await Filament.create({ name: "PLA Red", vendor: "V", type: "PLA" });
      await Filament.create({ name: "PLA Blue", vendor: "V", type: "PLA" });
      await Filament.create({ name: "PLA Green", vendor: "V", type: "PLA" });

      // Throw on the second save() call only — simulates a transient
      // VersionError from a concurrent writer on row 2.
      let callCount = 0;
      const realSave = mongoose.Model.prototype.save;
      const spy = vi
        .spyOn(mongoose.Model.prototype, "save")
        .mockImplementation(async function (this: mongoose.Document, ...args: unknown[]) {
          callCount += 1;
          if (callCount === 2) {
            const err = new mongoose.Error.VersionError(this, 0, ["spools"]);
            throw err;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return realSave.apply(this, args as any);
        });

      try {
        const csv =
          "filament,totalWeight\n" +
          `PLA Red,800\n` +
          `PLA Blue,900\n` +
          `PLA Green,1000\n`;
        const res = await importSpools(csvRequest(csv));
        expect(res.status).toBe(200);
        const body = await res.json();

        // Two saves succeeded (rows 1 and 3); one failed (row 2).
        expect(body.imported).toBe(2);
        expect(body.failed).toBe(1);
        expect(body.results).toHaveLength(3);
        expect(body.results[0]).toMatchObject({ ok: true, filament: "PLA Red" });
        expect(body.results[1]).toMatchObject({ ok: false });
        expect(body.results[1].error).toMatch(/save failed/i);
        expect(body.results[2]).toMatchObject({ ok: true, filament: "PLA Green" });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // GH #372 (Codex follow-up): a CSV row carrying an ISO-shaped but
  // impossible calendar date (e.g. "2025-02-29") must NOT silently shift
  // the spool to a different day via JS Date normalisation.
  describe("date validity in CSV rows", () => {
    it("rejects rows with an impossible purchaseDate without persisting the spool", async () => {
      await Filament.create({ name: "PETG White", vendor: "V", type: "PETG" });

      const csv =
        "filament,totalWeight,purchaseDate\n" +
        // Feb 29 in a non-leap year — pre-fix would have stored as March 1.
        `PETG White,1000,2025-02-29\n` +
        // A real leap-year Feb 29 — should be accepted.
        `PETG White,1000,2024-02-29\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.failed).toBe(1);
      expect(body.imported).toBe(1);
      expect(body.results[0]).toMatchObject({ ok: false });
      expect(body.results[0].error).toMatch(/purchaseDate/);
      expect(body.results[1]).toMatchObject({ ok: true });

      // Only the leap-year row materialised as a spool.
      const fresh = await Filament.findOne({ name: "PETG White" });
      expect(fresh.spools).toHaveLength(1);
      expect(fresh.spools[0].purchaseDate?.toISOString().slice(0, 10)).toBe("2024-02-29");
    });

    it("rejects rows with an impossible openedDate", async () => {
      await Filament.create({ name: "ABS Black", vendor: "V", type: "ABS" });

      const csv =
        "filament,totalWeight,openedDate\n" +
        `ABS Black,1000,2025-04-31\n`;  // April only has 30 days
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/openedDate/);

      const fresh = await Filament.findOne({ name: "ABS Black" });
      expect(fresh.spools).toHaveLength(0);
    });

    // Codex P2 on PR #375: a row failing date validation must not leave
    // behind an auto-created Location. resolveLocationId upserts by name,
    // so if validation ran AFTER the upsert an invalid CSV row would
    // dirty the catalog with a phantom location even though no spool
    // ever materialised.
    it("does not auto-create a Location when the row fails date validation", async () => {
      await Filament.create({ name: "Orphan Test", vendor: "V", type: "PLA" });
      const phantomLocationName = "Phantom Cabinet From Bad Row";

      const csv =
        "filament,totalWeight,purchaseDate,location\n" +
        `Orphan Test,1000,2025-02-29,${phantomLocationName}\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/purchaseDate/);

      const phantom = await Location.findOne({ name: phantomLocationName });
      expect(phantom).toBeNull();

      const fresh = await Filament.findOne({ name: "Orphan Test" });
      expect(fresh.spools).toHaveLength(0);
    });
  });

  // #732 Phase 5: the spool CSV exporter now emits each spool's OWN
  // `instanceId`. The importer must honour that column so a per-spool id
  // round-trips, while still guarding uniqueness (vs other spools, other
  // filaments' top-level ids, and other rows in the same CSV).
  describe("#732 Phase 5: instanceId column", () => {
    it("stamps a user-supplied instanceId on a newly created spool", async () => {
      const f = await Filament.create({ name: "Prusa Roll", vendor: "Prusa", type: "PLA" });
      const csv =
        "filament,totalWeight,instanceId\n" +
        `Prusa Roll,950,1086170252\n`; // numeric Prusament roll id
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(0);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1);
      expect(fresh.spools[0].instanceId).toBe("1086170252");
    });

    it("auto-generates an instanceId when the column is absent", async () => {
      const f = await Filament.create({ name: "Auto Id", vendor: "Test", type: "PLA" });
      const res = await importSpools(csvRequest("filament,totalWeight\nAuto Id,800\n"));
      expect((await res.json()).imported).toBe(1);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
    });

    it("auto-generates when the instanceId cell is present but empty", async () => {
      const f = await Filament.create({ name: "Empty Id", vendor: "Test", type: "PLA" });
      const res = await importSpools(
        csvRequest("filament,totalWeight,instanceId\nEmpty Id,800,\n"),
      );
      expect((await res.json()).imported).toBe(1);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
    });

    it("round-trips: re-importing an export keeps each spool's own id (no self-collision)", async () => {
      const f = await Filament.create({
        name: "Round Trip Id",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 1000 }],
      });
      const spoolId = String(f.spools[0]._id);
      const instanceId = f.spools[0].instanceId as string;

      // The exact row the exporter now emits — spoolId + the spool's own id.
      const csv =
        "filament,totalWeight,spoolId,instanceId\n" +
        `Round Trip Id,950,${spoolId},${instanceId}\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.updated).toBe(1);
      expect(body.failed).toBe(0);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1); // NOT doubled
      expect(fresh.spools[0].instanceId).toBe(instanceId); // unchanged
      expect(fresh.spools[0].totalWeight).toBe(950);
    });

    it("does NOT change an existing spool's id via the UPDATE path — the column is honored on create only", async () => {
      // Contract: instanceId is informational on update. Even a deliberate,
      // distinct id in the cell leaves the spool's id alone (per-spool id
      // edits go through the detail-page editor, not bulk CSV). The row's
      // other fields still update.
      const f = await Filament.create({
        name: "No CSV Rewrite",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 1000 }],
      });
      const spoolId = String(f.spools[0]._id);
      const original = f.spools[0].instanceId as string;

      const csv =
        "filament,totalWeight,spoolId,instanceId\n" +
        `No CSV Rewrite,950,${spoolId},custom-id.7\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.failed).toBe(0);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].instanceId).toBe(original); // id untouched
      expect(fresh.spools[0].totalWeight).toBe(950); // metadata still updated
    });

    it("leaves an existing spool's id untouched when the instanceId cell is empty", async () => {
      const f = await Filament.create({
        name: "Keep Id",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 1000 }],
      });
      const spoolId = String(f.spools[0]._id);
      const original = f.spools[0].instanceId as string;

      const csv =
        "filament,totalWeight,spoolId,instanceId\n" +
        `Keep Id,800,${spoolId},\n`;
      const res = await importSpools(csvRequest(csv));
      expect((await res.json()).updated).toBe(1);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].instanceId).toBe(original); // unchanged
      expect(fresh.spools[0].totalWeight).toBe(800); // weight still updated
    });

    it("rejects a malformed instanceId without persisting the spool or a Location", async () => {
      await Filament.create({ name: "Bad Id", vendor: "Test", type: "PLA" });
      const csv =
        "filament,totalWeight,instanceId,location\n" +
        `Bad Id,800,has spaces!,Phantom Shelf\n`; // space + ! are invalid
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/instanceId/);

      const fresh = await Filament.findOne({ name: "Bad Id" });
      expect(fresh.spools).toHaveLength(0);
      // Side-effect-free: the bad row must not have auto-created the Location.
      expect(await Location.findOne({ name: "Phantom Shelf" })).toBeNull();
    });

    it("rejects an instanceId already used by another spool (409-style row error)", async () => {
      await Filament.create({
        name: "Owner",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 1000, instanceId: "shared0001" }],
      });
      const target = await Filament.create({ name: "Taker", vendor: "Test", type: "PLA" });

      const csv =
        "filament,totalWeight,instanceId\n" +
        `Taker,800,shared0001\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/already used/);

      const fresh = await Filament.findById(target._id);
      expect(fresh.spools).toHaveLength(0);
    });

    it("rejects an instanceId colliding with another filament's top-level id", async () => {
      // matchFilament resolves spool ids BEFORE the filament-level fallback,
      // so a spool id equal to another filament's top-level id would shadow
      // that filament's labels/tags (Codex P2). isSpoolInstanceIdTaken guards
      // both halves.
      await Filament.create({
        name: "Top Level",
        vendor: "Test",
        type: "PLA",
        instanceId: "toplevel99",
      });
      const target = await Filament.create({ name: "Spool Owner", vendor: "Test", type: "PLA" });

      const csv =
        "filament,totalWeight,instanceId\n" +
        `Spool Owner,800,toplevel99\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/already used/);

      const fresh = await Filament.findById(target._id);
      expect(fresh.spools).toHaveLength(0);
    });

    it("ignores a legacy filament-level id in the column (pre-Phase-5 export round-trip)", async () => {
      // Codex P2 on PR #742: before this phase the exporter wrote the
      // FILAMENT's top-level id into the instanceId column for EVERY spool
      // row, alongside spoolId. Re-importing such a CSV must NOT (a) fail rows
      // 2..N as within-batch dups or (b) rewrite either spool's own id to the
      // filament id. Because the column is honored on CREATE only and these
      // are UPDATE rows (spoolId matches), the id is left untouched — the old
      // idempotent spoolId-keyed metadata update is preserved.
      const f = await Filament.create({
        name: "Legacy Export",
        vendor: "Test",
        type: "PLA",
        spools: [
          { label: "A", totalWeight: 1000 },
          { label: "B", totalWeight: 900 },
        ],
      });
      const filamentLevelId = f.instanceId as string;
      const spoolIdA = String(f.spools[0]._id);
      const spoolIdB = String(f.spools[1]._id);
      const ownIdA = f.spools[0].instanceId as string;
      const ownIdB = f.spools[1].instanceId as string;
      // Fresh-created spools get their own distinct ids, none equal to the
      // filament's top-level id — so this test exercises the real rewrite risk.
      expect(ownIdA).not.toBe(filamentLevelId);
      expect(ownIdB).not.toBe(filamentLevelId);

      // The exact shape a pre-Phase-5 export produced: both rows carry the
      // filament-level id in the instanceId column.
      const csv =
        "filament,totalWeight,spoolId,instanceId\n" +
        `Legacy Export,950,${spoolIdA},${filamentLevelId}\n` +
        `Legacy Export,880,${spoolIdB},${filamentLevelId}\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(2);
      expect(body.updated).toBe(2);
      expect(body.failed).toBe(0); // NOT a within-batch dup failure

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(2);
      const a = fresh.spools.find((s: { label: string }) => s.label === "A");
      const b = fresh.spools.find((s: { label: string }) => s.label === "B");
      expect(a.instanceId).toBe(ownIdA); // own id untouched, NOT rewritten
      expect(b.instanceId).toBe(ownIdB);
      expect(a.totalWeight).toBe(950); // weight update still applied
      expect(b.totalWeight).toBe(880);
    });

    it("honors a cell equal to the filament's top-level id on the CREATE path (carry-over preservation)", async () => {
      // Codex P2 follow-up: the legacy guard is scoped to the UPDATE path. On
      // CREATE, a real per-spool id that equals the filament's top-level id
      // (e.g. a Phase-1 carry-over spool re-created from its printed label /
      // NFC tag) must be HONORED, not silently regenerated. No existing spool
      // holds the id here, so isSpoolInstanceIdTaken permits it.
      const f = await Filament.create({ name: "Carryover Create", vendor: "Test", type: "PLA" });
      const fid = f.instanceId as string;

      const csv =
        "filament,totalWeight,instanceId\n" +
        `Carryover Create,800,${fid}\n`; // no spoolId → CREATE path
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.created).toBe(1);
      expect(body.failed).toBe(0);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1);
      expect(fresh.spools[0].instanceId).toBe(fid); // honored, NOT regenerated
    });

    it("rejects a CREATE row whose id equals an existing spool's id (incl. a carry-over spool)", async () => {
      // Safety counterpart to the above: if a spool already carries the
      // filament's top-level id (carry-over), creating ANOTHER spool with that
      // same id is a genuine collision and must be refused — the create path
      // doesn't blanket-ignore the value, it uniqueness-checks it.
      const f = await Filament.create({ name: "Carryover Exists", vendor: "Test", type: "PLA" });
      const fid = f.instanceId as string;
      // Give an existing spool that exact id (simulating the carry-over).
      f.spools.push({ label: "carry", totalWeight: 1000, instanceId: fid });
      await f.save();

      const csv =
        "filament,totalWeight,instanceId\n" +
        `Carryover Exists,800,${fid}\n`; // CREATE path, id already held
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.failed).toBe(1);
      expect(body.results[0].error).toMatch(/already used/);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1); // no second spool created
    });

    it("legacy export into a FRESH db fails the duplicate rows loudly (known transitional edge)", async () => {
      // Documents the one residual edge of the create-only contract: a
      // pre-Phase-5 CSV (filament-level id repeated across every row) imported
      // into a fresh DB hits the CREATE path for all rows, so a multi-spool
      // filament's rows collide on the same id. The first row creates; the rest
      // fail LOUDLY (surfaced per-row), NOT silently. Full backup restores use
      // /api/snapshot/restore, not this path. Pinned so the loud behavior is
      // intentional and a future change is a conscious decision.
      const f = await Filament.create({ name: "Legacy Fresh", vendor: "Test", type: "PLA" });
      const legacyId = "abcdef0123"; // the old filament-level id, repeated

      const csv =
        "filament,totalWeight,spoolId,instanceId\n" +
        `Legacy Fresh,1000,${new mongoose.Types.ObjectId()},${legacyId}\n` +
        `Legacy Fresh,900,${new mongoose.Types.ObjectId()},${legacyId}\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.created).toBe(1); // first row creates with the id
      expect(body.failed).toBe(1); // second fails loudly, not silently
      expect(body.results[1].ok).toBe(false);
      expect(body.results[1].error).toMatch(/more than one row/);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1);
    });

    it("#546 dual-instance: two update rows for the same spool both apply (mutation lands on the bucket doc)", async () => {
      // Two rows for the SAME filament resolve via different cache keys (one
      // omits vendor, one supplies it) → separate Mongoose instances for one
      // _id. Both UPDATE the SAME spool. The mutation must land on the bucket
      // doc (the single saved instance), or the second row's weight update is
      // silently dropped. The instanceId column is ignored on update, so the
      // spool keeps its original id.
      const f = await Filament.create({
        name: "DualInst",
        vendor: "VendG",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 1000 }],
      });
      const spoolId = String(f.spools[0]._id);
      const originalId = f.spools[0].instanceId as string;

      const csv =
        "filament,vendor,totalWeight,spoolId,instanceId\n" +
        `DualInst,,800,${spoolId},gnew000001\n` + // no vendor → instance A
        `DualInst,VendG,900,${spoolId},gnew000001\n`; // vendor → instance B
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(2);
      expect(body.failed).toBe(0);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1);
      expect(fresh.spools[0].instanceId).toBe(originalId); // id untouched on update
      expect(fresh.spools[0].totalWeight).toBe(900); // last write wins, not dropped
    });

    it("rejects the SECOND of two rows claiming the same instanceId within one CSV", async () => {
      // Within-batch dedup: the first row's new id isn't persisted until the
      // post-loop save(), so the DB check can't catch the collision — the
      // in-loop Set must.
      const f = await Filament.create({ name: "Batch Dup", vendor: "Test", type: "PLA" });
      const csv =
        "filament,totalWeight,instanceId\n" +
        `Batch Dup,800,dupe123456\n` +
        `Batch Dup,900,dupe123456\n`;
      const res = await importSpools(csvRequest(csv));
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.results[0].ok).toBe(true);
      expect(body.results[1].ok).toBe(false);
      expect(body.results[1].error).toMatch(/more than one row/);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1);
      expect(fresh.spools[0].instanceId).toBe("dupe123456");
    });
  });
});
