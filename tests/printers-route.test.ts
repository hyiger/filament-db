import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listPrinters, POST as createPrinter } from "@/app/api/printers/route";
import {
  GET as getPrinter,
  PUT as updatePrinter,
  DELETE as deletePrinter,
} from "@/app/api/printers/[id]/route";

/**
 * Route-level tests for /api/printers. Model has its own tests; this
 * exercises route behaviour:
 *   - GET filtering by manufacturer + populated installedNozzles
 *   - POST validation of installedNozzles refs (active only)
 *   - DELETE cascade guard against Filament.calibrations.printer
 *   - Duplicate-name 409 from the partial unique index
 */
describe("/api/printers", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const printerMod = await import("@/models/Printer");
    const nozzleMod = await import("@/models/Nozzle");
    const filamentMod = await import("@/models/Filament");
    // BedType must be registered too — the printers routes now
    // .populate("installedBedTypes"), and setup.ts wipes mongoose.models
    // between tests.
    const bedTypeMod = await import("@/models/BedType");
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozzleMod.default.schema);
    if (!mongoose.models.Filament) mongoose.model("Filament", filamentMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedTypeMod.default.schema);
    Printer = mongoose.models.Printer;
    Nozzle = mongoose.models.Nozzle;
    Filament = mongoose.models.Filament;
    await Printer.syncIndexes();
  });

  function jsonReq(url: string, body?: unknown, method: "GET" | "POST" | "PUT" = body ? "POST" : "GET") {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  describe("GET /api/printers", () => {
    it("returns printers with installedNozzles populated", async () => {
      const noz = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
      await Printer.create({
        name: "X1C",
        manufacturer: "Bambu",
        printerModel: "X1C",
        installedNozzles: [noz._id],
      });

      const res = await listPrinters(jsonReq("http://localhost/api/printers"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].installedNozzles).toHaveLength(1);
      expect(body[0].installedNozzles[0].name).toBe("0.4 Brass");
    });

    it("filters by manufacturer", async () => {
      await Printer.create({ name: "Mk4", manufacturer: "Prusa", printerModel: "Mk4" });
      await Printer.create({ name: "X1C", manufacturer: "Bambu", printerModel: "X1C" });
      await Printer.create({ name: "Core One", manufacturer: "Prusa", printerModel: "Core One" });

      const res = await listPrinters(jsonReq("http://localhost/api/printers?manufacturer=Prusa"));
      const body = await res.json();
      expect(body.map((p: { name: string }) => p.name).sort()).toEqual(["Core One", "Mk4"]);
    });

    it("excludes soft-deleted printers", async () => {
      await Printer.create({ name: "Live", manufacturer: "X", printerModel: "L" });
      await Printer.create({
        name: "Trashed",
        manufacturer: "X",
        printerModel: "T",
        _deletedAt: new Date(),
      });

      const res = await listPrinters(jsonReq("http://localhost/api/printers"));
      const body = await res.json();
      expect(body.map((p: { name: string }) => p.name)).toEqual(["Live"]);
    });

    it("populates only non-deleted nozzles in installedNozzles", async () => {
      const live = await Nozzle.create({ name: "Live nozzle", diameter: 0.4, type: "Brass" });
      const dead = await Nozzle.create({
        name: "Dead nozzle",
        diameter: 0.6,
        type: "Brass",
        _deletedAt: new Date(),
      });
      await Printer.create({
        name: "Has both refs",
        manufacturer: "X",
        printerModel: "P",
        installedNozzles: [live._id, dead._id],
      });

      const res = await listPrinters(jsonReq("http://localhost/api/printers"));
      const body = await res.json();
      // populate({ match: { _deletedAt: null } }) returns null for unmatched refs
      const populated = body[0].installedNozzles.filter((n: unknown) => n != null);
      expect(populated).toHaveLength(1);
      expect(populated[0].name).toBe("Live nozzle");
    });
  });

  describe("POST /api/printers", () => {
    it("creates a printer and strips identity fields", async () => {
      const res = await createPrinter(
        jsonReq("http://localhost/api/printers", {
          _id: "ffffffffffffffffffffffff",
          syncId: "leak-attempt",
          name: "X1C",
          manufacturer: "Bambu",
          printerModel: "X1C",
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body._id).not.toBe("ffffffffffffffffffffffff");
      expect(body.syncId).toBeUndefined();
      expect(body.name).toBe("X1C");
    });

    it("rejects POST when an installedNozzles entry references a deleted nozzle", async () => {
      const live = await Nozzle.create({ name: "L", diameter: 0.4, type: "Brass" });
      const dead = await Nozzle.create({
        name: "D",
        diameter: 0.4,
        type: "Brass",
        _deletedAt: new Date(),
      });

      const res = await createPrinter(
        jsonReq("http://localhost/api/printers", {
          name: "Bad refs",
          manufacturer: "X",
          printerModel: "P",
          installedNozzles: [live._id, dead._id],
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no longer exist/i);
    });

    it("returns 409 on duplicate name", async () => {
      await Printer.create({ name: "Mk4", manufacturer: "Prusa", printerModel: "Mk4" });
      const res = await createPrinter(
        jsonReq("http://localhost/api/printers", {
          name: "Mk4",
          manufacturer: "Prusa",
          printerModel: "Mk4",
        }),
      );
      expect(res.status).toBe(409);
    });

    it("returns 400 on invalid JSON", async () => {
      const req = new NextRequest("http://localhost/api/printers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      });
      const res = await createPrinter(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/printers/{id}", () => {
    it("refuses if a filament calibration still references the printer", async () => {
      const printer = await Printer.create({
        name: "Mk4",
        manufacturer: "Prusa",
        printerModel: "Mk4",
      });
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "Calibrated PLA",
        vendor: "T",
        type: "PLA",
        calibrations: [{ nozzle: noz._id, printer: printer._id, extrusionMultiplier: 0.95 }],
      });

      const res = await deletePrinter(
        new NextRequest(`http://localhost/api/printers/${printer._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/referenced by/i);
    });

    it("refuses if a TRASHED filament's calibration still references it (#629)", async () => {
      // Inverts the pre-#629 behavior: a trashed filament can be restored,
      // which would resurrect a dangling calibration printer ref if the
      // printer were deleted in the meantime — so trashed referrers block
      // the delete too.
      const printer = await Printer.create({
        name: "Mk4",
        manufacturer: "Prusa",
        printerModel: "Mk4",
      });
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "Trashed PLA",
        vendor: "T",
        type: "PLA",
        calibrations: [{ nozzle: noz._id, printer: printer._id }],
        _deletedAt: new Date(),
      });

      const res = await deletePrinter(
        new NextRequest(`http://localhost/api/printers/${printer._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/trash/i);
      const after = await Printer.findById(printer._id);
      expect(after._deletedAt).toBeNull();
    });

    it("ignores _purged filament tombstones when checking refs (#629)", async () => {
      // Purged rows are gone forever — they must NOT block the delete.
      const printer = await Printer.create({
        name: "Mk4",
        manufacturer: "Prusa",
        printerModel: "Mk4",
      });
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "Purged PLA",
        vendor: "T",
        type: "PLA",
        calibrations: [{ nozzle: noz._id, printer: printer._id }],
        _deletedAt: new Date(),
        _purged: true,
      });

      const res = await deletePrinter(
        new NextRequest(`http://localhost/api/printers/${printer._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(200);
    });

    it("soft-deletes a printer with no references", async () => {
      const printer = await Printer.create({
        name: "Standalone",
        manufacturer: "X",
        printerModel: "P",
      });
      const res = await deletePrinter(
        new NextRequest(`http://localhost/api/printers/${printer._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(200);
      const after = await Printer.findById(printer._id);
      expect(after._deletedAt).not.toBeNull();
    });
  });

  describe("PUT /api/printers/{id}", () => {
    it("updates basic fields including new v1.11 profile fields", async () => {
      const printer = await Printer.create({
        name: "Mk4",
        manufacturer: "Prusa",
        printerModel: "Mk4",
      });
      const res = await updatePrinter(
        jsonReq(
          `http://localhost/api/printers/${printer._id}`,
          {
            buildVolume: { x: 250, y: 210, z: 220 },
            maxFlow: 24,
            enclosed: false,
            autoBedLevel: true,
          },
          "PUT",
        ),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.buildVolume).toEqual({ x: 250, y: 210, z: 220 });
      expect(body.maxFlow).toBe(24);
      expect(body.autoBedLevel).toBe(true);
    });

    it("returns 404 for a soft-deleted printer", async () => {
      const printer = await Printer.create({
        name: "Trashed",
        manufacturer: "X",
        printerModel: "P",
        _deletedAt: new Date(),
      });
      const res = await updatePrinter(
        jsonReq(`http://localhost/api/printers/${printer._id}`, { name: "X" }, "PUT"),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("amsSlots[].spoolId validation (#631)", () => {
    // The dedicated assignment route (PUT /api/spools/[spoolId]/assignment)
    // verifies the spool exists on an active filament and rejects retired
    // spools; the printer POST/PUT used to write `amsSlots` verbatim,
    // bypassing both checks.

    async function makeSpool(opts: { retired?: boolean; deleted?: boolean } = {}) {
      const filament = await Filament.create({
        name: `Slot PLA ${new mongoose.Types.ObjectId()}`,
        vendor: "T",
        type: "PLA",
        spools: [{ label: "S1", totalWeight: 1000, retired: opts.retired ?? false }],
        _deletedAt: opts.deleted ? new Date() : null,
      });
      return String(filament.spools[0]._id);
    }

    function printerBody(amsSlots: unknown, name = "AMS Printer") {
      return { name, manufacturer: "Bambu", printerModel: "X1C", amsSlots };
    }

    it("POST rejects a retired spool in a slot with 400 naming the slot", async () => {
      const spoolId = await makeSpool({ retired: true });
      const res = await createPrinter(
        jsonReq(
          "http://localhost/api/printers",
          printerBody([{ slotName: "Slot 1", spoolId }]),
        ),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/retired/i);
      expect(body.error).toMatch(/Slot "Slot 1"/);
      expect(await Printer.countDocuments({ name: "AMS Printer" })).toBe(0);
    });

    it("POST rejects a nonexistent spoolId with 400", async () => {
      const res = await createPrinter(
        jsonReq(
          "http://localhost/api/printers",
          printerBody([
            { slotName: "Slot 1", spoolId: new mongoose.Types.ObjectId().toString() },
          ]),
        ),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/spool not found/i);
    });

    it("POST rejects a spool whose filament is soft-deleted", async () => {
      const spoolId = await makeSpool({ deleted: true });
      const res = await createPrinter(
        jsonReq(
          "http://localhost/api/printers",
          printerBody([{ slotName: "Slot 1", spoolId }]),
        ),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/spool not found/i);
    });

    it("PUT rejects a retired spool and leaves the printer unchanged", async () => {
      const printer = await Printer.create({
        name: "PUT Slot Printer",
        manufacturer: "Bambu",
        printerModel: "X1C",
        amsSlots: [{ slotName: "Slot 1", spoolId: null }],
      });
      const spoolId = await makeSpool({ retired: true });

      const res = await updatePrinter(
        jsonReq(
          `http://localhost/api/printers/${printer._id}`,
          { amsSlots: [{ slotName: "Slot 1", spoolId }] },
          "PUT",
        ),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/retired/i);

      const fresh = await Printer.findById(printer._id);
      expect(fresh.amsSlots[0].spoolId).toBeNull();
    });

    it("PUT rejects a non-ObjectId spoolId with 400 (not a CastError 500)", async () => {
      const printer = await Printer.create({
        name: "Bad Id Printer",
        manufacturer: "Bambu",
        printerModel: "X1C",
      });
      const res = await updatePrinter(
        jsonReq(
          `http://localhost/api/printers/${printer._id}`,
          { amsSlots: [{ slotName: "Slot 1", spoolId: "not-an-id" }] },
          "PUT",
        ),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not a valid id/i);
    });

    it("PUT accepts a valid active-spool assignment", async () => {
      const printer = await Printer.create({
        name: "Valid Slot Printer",
        manufacturer: "Bambu",
        printerModel: "X1C",
        amsSlots: [{ slotName: "Slot 1", spoolId: null }],
      });
      const spoolId = await makeSpool();

      const res = await updatePrinter(
        jsonReq(
          `http://localhost/api/printers/${printer._id}`,
          { amsSlots: [{ slotName: "Slot 1", spoolId }] },
          "PUT",
        ),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(200);
      const fresh = await Printer.findById(printer._id);
      expect(String(fresh.amsSlots[0].spoolId)).toBe(spoolId);
    });

    // Codex P2 on #646: the same active spool in two slots of one printer
    // payload would pass per-slot validation, and clearSpoolsFromOtherPrinters
    // excludes the current printer so it wouldn't self-heal — violating the
    // one-spool-one-slot invariant.
    it("POST rejects the same spool in two slots of one printer with 400", async () => {
      const spoolId = await makeSpool();
      const res = await createPrinter(
        jsonReq(
          "http://localhost/api/printers",
          printerBody([
            { slotName: "Slot 1", spoolId },
            { slotName: "Slot 2", spoolId },
          ]),
        ),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/more than one slot/i);
      expect(body.error).toMatch(/Slot "Slot 2"/);
      expect(await Printer.countDocuments({ name: "AMS Printer" })).toBe(0);
    });

    // Codex P2 round 2 on #646: ObjectId hex is case-insensitive and
    // Mongoose casts both casings to the same spool, so the duplicate
    // check must normalize before comparing — a raw-string Set would miss
    // the same id sent lowercase in one slot and uppercase in another.
    it("rejects the same spool in two slots even when the id casing differs", async () => {
      const spoolId = await makeSpool();
      const res = await createPrinter(
        jsonReq(
          "http://localhost/api/printers",
          printerBody([
            { slotName: "Slot 1", spoolId },
            { slotName: "Slot 2", spoolId: spoolId.toUpperCase() },
          ]),
        ),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/more than one slot/i);
      expect(await Printer.countDocuments({ name: "AMS Printer" })).toBe(0);
    });

    it("POST and PUT accept null/empty spoolId slots", async () => {
      const postRes = await createPrinter(
        jsonReq(
          "http://localhost/api/printers",
          printerBody(
            [
              { slotName: "Slot 1", spoolId: null },
              { slotName: "Slot 2" },
            ],
            "Empty Slots Printer",
          ),
        ),
      );
      expect(postRes.status).toBe(201);
      const created = await postRes.json();

      const putRes = await updatePrinter(
        jsonReq(
          `http://localhost/api/printers/${created._id}`,
          { amsSlots: [{ slotName: "Slot 1", spoolId: null }] },
          "PUT",
        ),
        { params: Promise.resolve({ id: String(created._id) }) },
      );
      expect(putRes.status).toBe(200);
    });
  });

  describe("GET /api/printers/{id}", () => {
    it("returns the printer with populated nozzles", async () => {
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      const printer = await Printer.create({
        name: "X1C",
        manufacturer: "Bambu",
        printerModel: "X1C",
        installedNozzles: [noz._id],
      });
      const res = await getPrinter(
        new NextRequest(`http://localhost/api/printers/${printer._id}`),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installedNozzles[0].name).toBe("0.4");
    });
  });
});
