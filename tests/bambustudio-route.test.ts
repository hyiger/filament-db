import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

/**
 * Route-level tests for the Bambu Studio importer (`POST
 * /api/filaments/bambustudio` + `POST /api/filaments/{id}/bambustudio`).
 *
 * Covers:
 *   - both content-types (multipart upload + raw JSON body)
 *   - upsert by name on the bulk route + id-pinned target on the per-id route
 *   - calibration auto-detect when a Printer + matching nozzle exist
 *   - calibration "unresolved" path when the printer hint doesn't match
 *   - required-field validation on create
 *   - non-multipart / non-JSON body rejection
 *
 * Schema re-registration in beforeEach is the same pattern as the other
 * route-level tests (tests/setup.ts wipes mongoose.models between tests).
 */
describe("Bambu Studio importer routes", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Printer: any;
  let Nozzle: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const prtMod = await import("@/models/Printer");
    const nozMod = await import("@/models/Nozzle");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    Filament = mongoose.models.Filament;
    Printer = mongoose.models.Printer;
    Nozzle = mongoose.models.Nozzle;
  });

  function multipartReq(url: string, profile: unknown) {
    const fd = new FormData();
    fd.append("file", new File([JSON.stringify(profile)], "preset.json", { type: "application/json" }));
    return new NextRequest(url, { method: "POST", body: fd });
  }

  function jsonReq(url: string, profile: unknown) {
    return new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(profile),
    });
  }

  function minimalProfile(overrides: Record<string, unknown> = {}) {
    return {
      type: "filament",
      from: "User",
      filament_settings_id: ["QA Bambu PLA"],
      filament_type: ["PLA"],
      filament_vendor: ["QA Labs"],
      filament_diameter: ["1.75"],
      nozzle_temperature: ["210"],
      hot_plate_temp: ["60"],
      ...overrides,
    };
  }

  describe("POST /api/filaments/bambustudio (bulk / upsert by name)", () => {
    it("creates a new filament from a multipart upload", async () => {
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        multipartReq("http://localhost/api/filaments/bambustudio", minimalProfile()),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(true);
      expect(body.name).toBe("QA Bambu PLA");

      const stored = await Filament.findOne({ name: "QA Bambu PLA" });
      expect(stored).toBeTruthy();
      expect(stored.type).toBe("PLA");
      expect(stored.vendor).toBe("QA Labs");
      expect(stored.diameter).toBe(1.75);
      expect(stored.temperatures.nozzle).toBe(210);
      expect(stored.temperatures.bed).toBe(60);
    });

    it("updates an existing filament when the name matches (raw JSON body)", async () => {
      await Filament.create({
        name: "QA Bambu PLA",
        vendor: "QA Labs",
        type: "PLA",
        diameter: 1.75,
        temperatures: { nozzle: 200, bed: 50 },
      });

      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({ nozzle_temperature: ["225"], hot_plate_temp: ["65"] }),
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
      expect(body.created).toBe(false);

      const stored = await Filament.findOne({ name: "QA Bambu PLA" });
      expect(stored.temperatures.nozzle).toBe(225);
      expect(stored.temperatures.bed).toBe(65);
    });

    it("preserves filament_notes in the settings bag through import (GH #620)", async () => {
      // The Filament model has no top-level `notes` field — pre-fix the
      // importer extracted filament_notes as a structured field, Mongoose
      // strict mode silently stripped it, and the key was also excluded
      // from the settings bag: the value was destroyed. It must land in
      // `settings.filament_notes` so re-export emits it verbatim.
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        multipartReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({ filament_notes: ["Dried 6h @ 55C before printing"] }),
        ),
      );
      expect(res.status).toBe(200);

      const stored = await Filament.findOne({ name: "QA Bambu PLA" });
      expect(stored.settings.filament_notes).toBe("Dried 6h @ 55C before printing");
      // No phantom top-level field should appear either.
      expect(stored.notes).toBeUndefined();
    });

    it("requires filament_type AND filament_vendor on create", async () => {
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const noType = await POST(
        multipartReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({ filament_type: [] }),
        ),
      );
      expect(noType.status).toBe(400);
      expect((await noType.json()).error).toMatch(/filament_type/);

      const noVendor = await POST(
        multipartReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({ filament_vendor: [] }),
        ),
      );
      expect(noVendor.status).toBe(400);
      expect((await noVendor.json()).error).toMatch(/filament_vendor/);
    });

    it("rejects an oversized multipart upload with 413 (Codex P2 #387 r2)", async () => {
      // The route caps multipart uploads at 10 MB. A real Bambu preset
      // JSON is single-digit KB; reject obviously-over-budget bodies
      // before `file.text()` materialises them in memory.
      const huge = "x".repeat(11 * 1024 * 1024); // 11 MB > MAX_UPLOAD_SIZE
      const fd = new FormData();
      fd.append(
        "file",
        new File([huge], "huge.json", { type: "application/json" }),
      );
      const req = new NextRequest("http://localhost/api/filaments/bambustudio", {
        method: "POST",
        body: fd,
      });
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(req);
      expect(res.status).toBe(413);
    });

    it("rejects a non-multipart / non-JSON body with 400", async () => {
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const req = new NextRequest("http://localhost/api/filaments/bambustudio", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not a profile",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("resurrects a TRASHED filament of the same name instead of creating a duplicate (Codex P1 #387 r5)", async () => {
      // GH #213 trash workflow: a trashed (non-purged) filament owns
      // the name (partial-unique index is on _deletedAt: null only). If
      // import created a second active row, the trashed one's restore
      // would 409 forever on the name conflict — the same trap the INI
      // importer fixed in #297.
      const trashed = await Filament.create({
        name: "QA Bambu PLA",
        vendor: "Old Vendor",
        type: "PLA",
        diameter: 1.75,
        _deletedAt: new Date(),
      });

      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({ filament_vendor: ["New Vendor"] }),
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // Resurrected = `updated`, not `created`.
      expect(body.updated).toBe(true);
      expect(body.created).toBe(false);
      // The SAME _id as the trashed row — no second active doc.
      expect(body.filamentId).toBe(String(trashed._id));

      // On disk: exactly one row, _deletedAt cleared, fields updated.
      const all = await Filament.find({ name: "QA Bambu PLA" });
      expect(all).toHaveLength(1);
      expect(all[0]._deletedAt).toBeNull();
      expect(all[0].vendor).toBe("New Vendor");
    });

    it("recovers from a concurrent create race by updating the racing winner (Codex P2 #387 r5)", async () => {
      // Simulate the race: phase-1 findOne returns null, but between
      // that and the create() call another request wins and inserts a
      // row with the same name. The partial-unique index throws E11000
      // for our create; the route catches it, re-fetches the racing
      // winner, and falls through to a normal phase-1 update.
      //
      // Subtlety: `tests/setup.ts` clears `mongoose.models` after every
      // test, so the route module's cached `import Filament from ...`
      // reference goes stale after the first run. Reset module cache
      // BEFORE re-importing the route, then capture the SAME Filament
      // the route will actually call create on, then spy on THAT.
      vi.resetModules();
      Filament = (await import("@/models/Filament")).default;

      const { POST } = await import("@/app/api/filaments/bambustudio/route");

      // Patch Filament.create exactly ONCE to throw an E11000 the
      // first time it's called. In the catch path the route falls back
      // to findOneAndUpdate, so a real row needs to exist when it
      // looks. Set that up in the same spy.
      const realCreate = Filament.create.bind(Filament);
      const e11000 = Object.assign(new Error("E11000 duplicate key"), {
        code: 11000,
      });
      const spy = vi
        .spyOn(Filament, "create")
        .mockImplementationOnce(async () => {
          // Pretend the racing winner already inserted while we were
          // about to call create. Insert a row through the real path,
          // THEN throw E11000 as if our own create had collided.
          await realCreate({
            name: "QA Bambu PLA",
            vendor: "Racing Winner",
            type: "PLA",
            diameter: 1.75,
          });
          throw e11000;
        });

      try {
        const res = await POST(
          jsonReq(
            "http://localhost/api/filaments/bambustudio",
            minimalProfile({ filament_vendor: ["From Bambu"] }),
          ),
        );
        const body = await res.json();
        if (res.status !== 200) {
          // Debugging aid: surface what the route actually returned so a
          // failure here doesn't bottom out at a meaningless assertion.
          throw new Error(`unexpected status ${res.status}: ${JSON.stringify(body)}`);
        }
        expect(res.status).toBe(200);
        // `updated` because we converged on the racing winner instead
        // of creating a second row.
        expect(body.updated).toBe(true);
        expect(body.created).toBe(false);
        // Exactly one active row with the merged values from BOTH the
        // racing winner (existing) and our Bambu import (override).
        const all = await Filament.find({ name: "QA Bambu PLA" });
        expect(all).toHaveLength(1);
        expect(all[0].vendor).toBe("From Bambu"); // import overrode
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 400 on a payload missing the identifier", async () => {
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq("http://localhost/api/filaments/bambustudio", { filament_type: ["PLA"] }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/filament_settings_id/);
    });
  });

  describe("calibration auto-detect", () => {
    async function seedPrinterWithNozzle() {
      const nozzle = await Nozzle.create({
        name: "P1S 0.4 Brass",
        diameter: 0.4,
        type: "Brass",
      });
      const printer = await Printer.create({
        name: "Bambu Lab P1S",
        manufacturer: "Bambu Lab",
        printerModel: "P1S",
        installedNozzles: [nozzle._id],
      });
      return { printer, nozzle };
    }

    it("attaches calibration values to the matching printer + nozzle", async () => {
      const { printer, nozzle } = await seedPrinterWithNozzle();
      const { POST } = await import("@/app/api/filaments/bambustudio/route");

      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({
            printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
            filament_flow_ratio: ["0.978"],
            pressure_advance: ["0.028"],
            filament_retract_length: ["0.8"],
          }),
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.calibrationApplied).toBe(true);
      expect(body.calibrationContext.printerName).toBe("Bambu Lab P1S");
      expect(body.calibrationContext.nozzleDiameter).toBe(0.4);

      const stored = await Filament.findOne({ name: "QA Bambu PLA" });
      const cal = stored.calibrations.find(
        (c: { printer: unknown; nozzle: unknown }) =>
          String(c.printer) === String(printer._id) && String(c.nozzle) === String(nozzle._id),
      );
      expect(cal).toBeTruthy();
      expect(cal.extrusionMultiplier).toBe(0.978);
      expect(cal.pressureAdvance).toBe(0.028);
      expect(cal.retractLength).toBe(0.8);
    });

    it("flags calibrationUnresolved when no printer matches the hint", async () => {
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({
            printer_settings_id: ["Some Other Brand 0.4 nozzle"],
            filament_flow_ratio: ["0.99"],
          }),
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.calibrationApplied).toBeFalsy();
      expect(body.calibrationUnresolved).toBe(true);
    });

    it("flags unresolved when matched printer has no nozzle at the diameter AND the global catalog has >1 candidate (Codex P2 #387 r4)", async () => {
      // The matched printer has no 0.4 installed; the global catalog
      // has two — Brass + Hardened — both at 0.4. The previous
      // `Nozzle.findOne` fallback would pick whichever Mongo returned
      // first; now we require a unique global match or punt.
      const big = await Nozzle.create({ name: "Brass 0.6", diameter: 0.6, type: "Brass" });
      await Nozzle.create({ name: "Cat Brass 0.4", diameter: 0.4, type: "Brass" });
      await Nozzle.create({ name: "Cat Hardened 0.4", diameter: 0.4, type: "Hardened Steel" });
      // Printer's only INSTALLED nozzle is a 0.6, so the 0.4 hint
      // forces the global-catalog fallback path.
      await Printer.create({
        name: "Bambu Lab P1S",
        manufacturer: "Bambu Lab",
        printerModel: "P1S",
        installedNozzles: [big._id],
      });
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({
            printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
            filament_flow_ratio: ["0.99"],
          }),
        ),
      );
      const body = await res.json();
      expect(body.calibrationApplied).toBeFalsy();
      expect(body.calibrationUnresolved).toBe(true);
    });

    it("falls back to the global catalog when matched printer has no nozzle at diameter AND exactly one candidate exists (Codex P2 #387 r4)", async () => {
      // Same setup but only ONE 0.4 nozzle in the global catalog —
      // adoption is unambiguous, calibration applies. This is the
      // helpful branch the user originally wanted: "I forgot to attach
      // the only 0.4 I own to the printer, just use it."
      const big = await Nozzle.create({ name: "Brass 0.6", diameter: 0.6, type: "Brass" });
      const onlyFour = await Nozzle.create({ name: "The 0.4", diameter: 0.4, type: "Brass" });
      const printer = await Printer.create({
        name: "Bambu Lab P1S",
        manufacturer: "Bambu Lab",
        printerModel: "P1S",
        installedNozzles: [big._id],
      });
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({
            printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
            filament_flow_ratio: ["0.99"],
          }),
        ),
      );
      const body = await res.json();
      expect(body.calibrationApplied).toBe(true);
      expect(body.calibrationContext.printerName).toBe("Bambu Lab P1S");
      expect(body.calibrationContext.nozzleDiameter).toBe(0.4);

      const stored = await Filament.findOne({ name: "QA Bambu PLA" });
      const cal = stored.calibrations.find(
        (c: { printer: unknown; nozzle: unknown }) =>
          String(c.printer) === String(printer._id) && String(c.nozzle) === String(onlyFour._id),
      );
      expect(cal).toBeTruthy();
    });

    it("flags unresolved when the printer hint matches MULTIPLE printers (Codex P2 #387)", async () => {
      // Two printers whose names BOTH contain the hint substring "Bambu
      // Lab P1S" — the previous `printers.find(...)` would silently
      // pick whichever Mongo returned first, tagging calibration to the
      // wrong record. Now ambiguous → unresolved.
      const nozzle = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
      await Printer.create({
        name: "Bambu Lab P1S",
        manufacturer: "Bambu Lab",
        printerModel: "P1S",
        installedNozzles: [nozzle._id],
      });
      await Printer.create({
        name: "Bambu Lab P1S (downstairs)",
        manufacturer: "Bambu Lab",
        printerModel: "P1S",
        installedNozzles: [nozzle._id],
      });

      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({
            printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
            filament_flow_ratio: ["0.99"],
          }),
        ),
      );
      const body = await res.json();
      expect(body.calibrationApplied).toBeFalsy();
      expect(body.calibrationUnresolved).toBe(true);
    });

    it("rejects an update that violates the model's numeric validators (Codex P2 #387)", async () => {
      // GH #337 added `min` validators on cost/density/temperatures.
      // The Bambu update path now passes `runValidators: true` so a
      // profile with e.g. a negative density gets a 4xx instead of
      // silently persisting bad data.
      await Filament.create({
        name: "QA Bambu PLA",
        vendor: "QA Labs",
        type: "PLA",
        diameter: 1.75,
      });
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile({ filament_density: ["-1"] }),
        ),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      // The on-disk filament was NOT mutated to the bad value.
      const stored = await Filament.findOne({ name: "QA Bambu PLA" });
      expect(stored.density).not.toBe(-1);
    });

    it("doesn't flag unresolved when there are no calibration hints at all", async () => {
      await seedPrinterWithNozzle();
      const { POST } = await import("@/app/api/filaments/bambustudio/route");
      const res = await POST(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          minimalProfile(), // no calibration values
        ),
      );
      const body = await res.json();
      expect(body.calibrationApplied).toBeFalsy();
      expect(body.calibrationUnresolved).toBeFalsy();
    });
  });

  describe("POST /api/filaments/[id]/bambustudio (per-id sync)", () => {
    it("pins by id and ignores the parsed filament name", async () => {
      const target = await Filament.create({
        name: "Original Name",
        vendor: "QA",
        type: "PLA",
        diameter: 1.75,
      });

      const { POST } = await import("@/app/api/filaments/[id]/bambustudio/route");
      const res = await POST(
        jsonReq(
          `http://localhost/api/filaments/${target._id}/bambustudio`,
          minimalProfile({
            filament_settings_id: ["DIFFERENT NAME"], // ignored — pinned by id
            nozzle_temperature: ["230"],
          }),
        ),
        { params: Promise.resolve({ id: String(target._id) }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
      expect(body.name).toBe("Original Name"); // name didn't change

      const stored = await Filament.findById(target._id);
      expect(stored.name).toBe("Original Name");
      expect(stored.temperatures.nozzle).toBe(230);
    });

    it("returns 400 for a malformed id", async () => {
      const { POST } = await import("@/app/api/filaments/[id]/bambustudio/route");
      const res = await POST(
        jsonReq("http://localhost/api/filaments/not-an-id/bambustudio", minimalProfile()),
        { params: Promise.resolve({ id: "not-an-id" }) },
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 if the filament is soft-deleted between findOne and updateOne (Codex P2 #387 r6)", async () => {
      // Simulate the soft-delete race: the initial findOne returns the
      // doc, but by the time the updateOne fires it's been tombstoned.
      // Without the `_deletedAt: null` clause in the update filter
      // (plus the matchedCount check) the route would happily update
      // the deleted row and return updated:true, lying to the client.
      vi.resetModules();
      Filament = (await import("@/models/Filament")).default;
      const target = await Filament.create({
        name: "QA Bambu PLA",
        vendor: "QA",
        type: "PLA",
        diameter: 1.75,
      });
      // Soft-delete it now, AFTER our `Filament.create` but BEFORE the
      // route runs — and spy on findOne to return the pre-delete view
      // of the doc, simulating the race window (the real DB now has
      // `_deletedAt` set, so the update filter's `_deletedAt: null`
      // matches zero docs and the route 404s).
      await Filament.updateOne({ _id: target._id }, { $set: { _deletedAt: new Date() } });
      const fakeActive = { ...target.toObject(), _deletedAt: null };
      const spy = vi.spyOn(Filament, "findOne").mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (() => ({ lean: async () => fakeActive, exec: async () => fakeActive, then: (cb: any) => cb(fakeActive) })) as any,
      );

      try {
        const { POST } = await import("@/app/api/filaments/[id]/bambustudio/route");
        const res = await POST(
          jsonReq(`http://localhost/api/filaments/${target._id}/bambustudio`, minimalProfile()),
          { params: Promise.resolve({ id: String(target._id) }) },
        );
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toMatch(/deleted/i);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when the filament doesn't exist", async () => {
      const { POST } = await import("@/app/api/filaments/[id]/bambustudio/route");
      const missing = "000000000000000000000000";
      const res = await POST(
        jsonReq(`http://localhost/api/filaments/${missing}/bambustudio`, minimalProfile()),
        { params: Promise.resolve({ id: missing }) },
      );
      expect(res.status).toBe(404);
    });

    // Codex P1 on PR #473 round 2: pin the augment-helper wire-up. The
    // unit tests in tests/bambuStudioApply.test.ts verify the
    // $unset-on-revert-to-parent behavior of buildStructuredUpdate, but
    // they pass in a hand-built `existing` shape that already includes
    // the inheritable scalars. If the route's augment helper strips
    // those scalars (as the first round of this PR did), the unset path
    // is unreachable at runtime. This test goes through the real route
    // with a real variant to prove the wire-up.
    it("$unsets a stale variant override when the parsed value matches the parent (Codex P1 PR #473 r2)", async () => {
      const parent = await Filament.create({
        name: "QA Parent",
        vendor: "QA",
        type: "PLA",
        diameter: 1.75,
        density: 1.24,
      });
      // Variant with a stale local density that diverges from the parent.
      const variant = await Filament.create({
        name: "QA Variant",
        vendor: "QA",
        type: "PLA",
        diameter: 1.75,
        density: 1.30,
        parentId: parent._id,
      });
      // Sanity: variant has its own density before the sync.
      const before = await Filament.findById(variant._id).lean();
      expect((before as { density: number }).density).toBe(1.30);

      const { POST } = await import("@/app/api/filaments/[id]/bambustudio/route");
      const res = await POST(
        jsonReq(
          `http://localhost/api/filaments/${variant._id}/bambustudio`,
          minimalProfile({
            // Sync an import whose density MATCHES the parent — the
            // stale variant override should be cleared.
            filament_density: ["1.24"],
          }),
        ),
        { params: Promise.resolve({ id: String(variant._id) }) },
      );
      expect(res.status).toBe(200);

      const after = await Filament.findById(variant._id).lean();
      // Density should be unset (undefined or null) on the variant
      // doc — `resolveFilament` then falls back to the parent's 1.24.
      // `$unset` removes the field; depending on Mongoose schema
      // defaults the lean read may surface it as undefined or null.
      const afterDensity = (after as { density?: number | null }).density;
      expect(afterDensity == null).toBe(true);
    });

    it("succeeds (does NOT $unset required fields) when stale type/vendor match parent (Codex P2 PR #473 r3)", async () => {
      // Required schema fields can't be $unset under `runValidators:
      // true` — the write would fail with a validation error. Pin the
      // route behaviour: a sync that matches the parent's `type` AND
      // `vendor` (both required) should succeed without trying to
      // unset them. An optional field like density alongside still
      // gets unset.
      const parent = await Filament.create({
        name: "QA Parent Required",
        vendor: "Polymaker",
        type: "PLA",
        diameter: 1.75,
        density: 1.24,
      });
      const variant = await Filament.create({
        name: "QA Variant Required",
        vendor: "OldVendor", // stale; differs from parent
        type: "PLA+", // stale; differs from parent
        diameter: 1.75,
        density: 1.30, // stale; differs from parent
        parentId: parent._id,
      });

      const { POST } = await import("@/app/api/filaments/[id]/bambustudio/route");
      const res = await POST(
        jsonReq(
          `http://localhost/api/filaments/${variant._id}/bambustudio`,
          minimalProfile({
            filament_type: ["PLA"], // matches parent
            filament_vendor: ["Polymaker"], // matches parent
            filament_density: ["1.24"], // matches parent
          }),
        ),
        { params: Promise.resolve({ id: String(variant._id) }) },
      );
      expect(res.status).toBe(200); // would be 500 if required-field $unset slipped through

      const after = await Filament.findById(variant._id).lean();
      // Required fields stay pinned (would fail validation if cleared).
      expect((after as { type: string }).type).toBe("PLA+");
      expect((after as { vendor: string }).vendor).toBe("OldVendor");
      // Optional `density` got cleared so it now inherits from parent.
      const afterDensity = (after as { density?: number | null }).density;
      expect(afterDensity == null).toBe(true);
    });
  });
});
