import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listNozzles, POST as createNozzle } from "@/app/api/nozzles/route";
import {
  GET as getNozzle,
  PUT as updateNozzle,
  DELETE as deleteNozzle,
} from "@/app/api/nozzles/[id]/route";

/**
 * Route-level tests for /api/nozzles. The model has its own tests; this
 * file exercises route-only behaviour:
 *
 *   - the printer-enrichment reverse lookup (each nozzle gets a `printers`
 *     array via Printer.installedNozzles), which drives the v1.11
 *     "differentiate Diamondback 0.4 in Core One vs H2D" UX. Untested before.
 *   - duplicate-name 409 from the partial unique index
 *   - DELETE refusal when a Filament still references the nozzle
 *   - DELETE refusal when a Printer still has the nozzle installed
 */
describe("/api/nozzles", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const nozzleMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Nozzle) {
      mongoose.model("Nozzle", nozzleMod.default.schema);
    }
    if (!mongoose.models.Printer) {
      mongoose.model("Printer", printerMod.default.schema);
    }
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Nozzle = mongoose.models.Nozzle;
    Printer = mongoose.models.Printer;
    Filament = mongoose.models.Filament;
    await Nozzle.syncIndexes();
  });

  function jsonReq(url: string, body?: unknown, method: "GET" | "POST" | "PUT" = body ? "POST" : "GET") {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  describe("GET /api/nozzles — printer enrichment", () => {
    it("attaches each printer that has this nozzle installed", async () => {
      // Two physically distinct Diamondback 0.4 nozzles — the partial
      // unique index on `name` forces users to disambiguate by name when
      // tracking them as separate records, hence the suffixes.
      const dbCoreOne = await Nozzle.create({
        name: "Diamondback 0.4 (Core One)",
        diameter: 0.4,
        type: "Diamondback",
      });
      const dbH2D = await Nozzle.create({
        name: "Diamondback 0.4 (H2D)",
        diameter: 0.4,
        type: "Diamondback",
      });
      // A third nozzle that nobody has installed
      const orphan = await Nozzle.create({
        name: "Brass 0.6",
        diameter: 0.6,
        type: "Brass",
      });
      const coreOne = await Printer.create({
        name: "Prusa Core One",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedNozzles: [dbCoreOne._id],
      });
      await Printer.create({
        name: "Bambu H2D",
        manufacturer: "Bambu",
        printerModel: "H2D",
        installedNozzles: [dbH2D._id],
      });

      const res = await listNozzles(jsonReq("http://localhost/api/nozzles"));
      expect(res.status).toBe(200);
      const body = await res.json();

      const findById = (id: mongoose.Types.ObjectId) =>
        body.find((n: { _id: string }) => n._id === String(id));

      const enrichedCoreOne = findById(dbCoreOne._id);
      expect(enrichedCoreOne.printers).toHaveLength(1);
      expect(enrichedCoreOne.printers[0]).toEqual({
        _id: String(coreOne._id),
        name: "Prusa Core One",
      });

      const enrichedH2D = findById(dbH2D._id);
      expect(enrichedH2D.printers).toHaveLength(1);
      expect(enrichedH2D.printers[0].name).toBe("Bambu H2D");

      const enrichedOrphan = findById(orphan._id);
      expect(enrichedOrphan.printers).toEqual([]);
    });

    it("attaches multiple printers when the same nozzle is installed in more than one", async () => {
      const shared = await Nozzle.create({
        name: "Brass 0.4",
        diameter: 0.4,
        type: "Brass",
      });
      await Printer.create({
        name: "Printer A",
        manufacturer: "X",
        printerModel: "A",
        installedNozzles: [shared._id],
      });
      await Printer.create({
        name: "Printer B",
        manufacturer: "X",
        printerModel: "B",
        installedNozzles: [shared._id],
      });

      const res = await listNozzles(jsonReq("http://localhost/api/nozzles"));
      const body = await res.json();
      const enriched = body.find((n: { _id: string }) => n._id === String(shared._id));
      const names = enriched.printers.map((p: { name: string }) => p.name).sort();
      expect(names).toEqual(["Printer A", "Printer B"]);
    });

    it("excludes soft-deleted printers from the printers list", async () => {
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      const live = await Printer.create({
        name: "Live printer",
        manufacturer: "X",
        printerModel: "P1",
        installedNozzles: [noz._id],
      });
      const dead = await Printer.create({
        name: "Dead printer",
        manufacturer: "X",
        printerModel: "P2",
        installedNozzles: [noz._id],
        _deletedAt: new Date(),
      });

      const res = await listNozzles(jsonReq("http://localhost/api/nozzles"));
      const body = await res.json();
      const enriched = body.find((n: { _id: string }) => n._id === String(noz._id));
      expect(enriched.printers).toHaveLength(1);
      expect(enriched.printers[0]._id).toBe(String(live._id));
      // make TS happy — `dead` is otherwise unused
      expect(String(dead._id)).not.toBe(String(live._id));
    });

    it("filters by diameter / type / highFlow", async () => {
      await Nozzle.create({ name: "A", diameter: 0.4, type: "Brass", highFlow: false });
      await Nozzle.create({ name: "B", diameter: 0.6, type: "Brass", highFlow: false });
      await Nozzle.create({ name: "C", diameter: 0.4, type: "Hardened Steel", highFlow: true });

      const byDiameter = await listNozzles(
        jsonReq("http://localhost/api/nozzles?diameter=0.4"),
      );
      expect((await byDiameter.json()).map((n: { name: string }) => n.name).sort()).toEqual(
        ["A", "C"],
      );

      const byType = await listNozzles(
        jsonReq("http://localhost/api/nozzles?type=Brass"),
      );
      expect((await byType.json()).map((n: { name: string }) => n.name).sort()).toEqual([
        "A",
        "B",
      ]);

      const byHF = await listNozzles(
        jsonReq("http://localhost/api/nozzles?highFlow=true"),
      );
      expect((await byHF.json()).map((n: { name: string }) => n.name)).toEqual(["C"]);
    });
  });

  describe("POST /api/nozzles", () => {
    it("creates a nozzle and strips identity fields the client may have sent", async () => {
      const res = await createNozzle(
        jsonReq("http://localhost/api/nozzles", {
          _id: "ffffffffffffffffffffffff", // should be stripped
          syncId: "should-not-stick",
          name: "0.6 Brass",
          diameter: 0.6,
          type: "Brass",
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("0.6 Brass");
      expect(body._id).not.toBe("ffffffffffffffffffffffff");
      // syncId is sparse — strip should leave it unset, not "should-not-stick"
      expect(body.syncId).toBeUndefined();
    });

    it("rejects duplicate names (partial unique index) with 409", async () => {
      await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
      const res = await createNozzle(
        jsonReq("http://localhost/api/nozzles", {
          name: "0.4 Brass",
          diameter: 0.4,
          type: "Brass",
        }),
      );
      expect(res.status).toBe(409);
    });

    it("returns 400 on invalid JSON", async () => {
      const req = new NextRequest("http://localhost/api/nozzles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      const res = await createNozzle(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/nozzles/{id}", () => {
    it("refuses if a filament's compatibleNozzles still references it", async () => {
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "PLA",
        vendor: "T",
        type: "PLA",
        compatibleNozzles: [noz._id],
      });

      const res = await deleteNozzle(
        new NextRequest(`http://localhost/api/nozzles/${noz._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/referenced by/i);
    });

    it("refuses if any printer still has the nozzle installed", async () => {
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Printer.create({
        name: "PA",
        manufacturer: "X",
        printerModel: "A",
        installedNozzles: [noz._id],
      });

      const res = await deleteNozzle(
        new NextRequest(`http://localhost/api/nozzles/${noz._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/installed/i);
    });

    it("refuses if only a TRASHED filament references it (#629)", async () => {
      // A trashed filament can be restored, which would resurrect a
      // dangling nozzle ref if the nozzle were deleted in the meantime —
      // so trashed referrers block the delete too.
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "Trashed PLA",
        vendor: "T",
        type: "PLA",
        calibrations: [{ nozzle: noz._id }],
        _deletedAt: new Date(),
      });

      const res = await deleteNozzle(
        new NextRequest(`http://localhost/api/nozzles/${noz._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/trash/i);
      const after = await Nozzle.findById(noz._id);
      expect(after._deletedAt).toBeNull();
    });

    it("ignores _purged filament tombstones when checking refs (#629)", async () => {
      // Purged rows are gone forever — they must NOT block the delete.
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "Purged PLA",
        vendor: "T",
        type: "PLA",
        compatibleNozzles: [noz._id],
        _deletedAt: new Date(),
        _purged: true,
      });

      const res = await deleteNozzle(
        new NextRequest(`http://localhost/api/nozzles/${noz._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(200);
    });

    it("ignores soft-deleted printers when checking installed refs (#629)", async () => {
      // Printers have no trash/restore loop — a soft-deleted printer's
      // refs can never resurrect, and counting them would block the delete
      // with no way for the user to clear the reference.
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Printer.create({
        name: "Deleted Printer",
        manufacturer: "X",
        printerModel: "A",
        installedNozzles: [noz._id],
        _deletedAt: new Date(),
      });

      const res = await deleteNozzle(
        new NextRequest(`http://localhost/api/nozzles/${noz._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(200);
    });

    it("soft-deletes a nozzle that nothing references", async () => {
      const noz = await Nozzle.create({ name: "0.6", diameter: 0.6, type: "Brass" });
      const res = await deleteNozzle(
        new NextRequest(`http://localhost/api/nozzles/${noz._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(200);
      const after = await Nozzle.findById(noz._id);
      expect(after._deletedAt).not.toBeNull();
    });
  });

  describe("PUT /api/nozzles/{id}", () => {
    it("updates basic fields", async () => {
      const noz = await Nozzle.create({ name: "Old", diameter: 0.4, type: "Brass" });
      const res = await updateNozzle(
        jsonReq(`http://localhost/api/nozzles/${noz._id}`, {
          name: "New",
          notes: "moved to drybox",
        }, "PUT"),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("New");
      expect(body.notes).toBe("moved to drybox");
    });

    it("returns 404 for a soft-deleted nozzle", async () => {
      const noz = await Nozzle.create({
        name: "Trashed",
        diameter: 0.4,
        type: "Brass",
        _deletedAt: new Date(),
      });
      const res = await updateNozzle(
        jsonReq(`http://localhost/api/nozzles/${noz._id}`, { name: "X" }, "PUT"),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/nozzles/{id}", () => {
    it("returns the nozzle when present", async () => {
      const noz = await Nozzle.create({ name: "Single", diameter: 0.4, type: "Brass" });
      const res = await getNozzle(
        new NextRequest(`http://localhost/api/nozzles/${noz._id}`),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("Single");
    });

    it("returns 404 for a soft-deleted nozzle", async () => {
      const noz = await Nozzle.create({
        name: "Gone",
        diameter: 0.4,
        type: "Brass",
        _deletedAt: new Date(),
      });
      const res = await getNozzle(
        new NextRequest(`http://localhost/api/nozzles/${noz._id}`),
        { params: Promise.resolve({ id: String(noz._id) }) },
      );
      expect(res.status).toBe(404);
    });
  });
});
