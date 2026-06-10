import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listBedTypes, POST as createBedType } from "@/app/api/bed-types/route";
import {
  GET as getBedType,
  PUT as updateBedType,
  DELETE as deleteBedType,
} from "@/app/api/bed-types/[id]/route";

/**
 * Route-level tests for /api/bed-types. Bed types are referenced from
 * Filament.calibrations[].bedType, and the DELETE handler must refuse to
 * silently break those references.
 */
describe("/api/bed-types", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BedType: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;

  beforeEach(async () => {
    const bedMod = await import("@/models/BedType");
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    // Printer is needed by the bed-types GET — it reverse-looks-up which
    // printers reference each bed type for the "Available On" column.
    const prtMod = await import("@/models/Printer");
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    BedType = mongoose.models.BedType;
    Filament = mongoose.models.Filament;
    Nozzle = mongoose.models.Nozzle;
    await BedType.syncIndexes();
  });

  function jsonReq(url: string, body?: unknown, method: "GET" | "POST" | "PUT" = body ? "POST" : "GET") {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  describe("GET /api/bed-types", () => {
    it("returns bed types sorted by name", async () => {
      await BedType.create({ name: "Smooth PEI", material: "PEI" });
      await BedType.create({ name: "Glass", material: "Glass" });
      await BedType.create({ name: "Textured PEI", material: "PEI" });

      const res = await listBedTypes(jsonReq("http://localhost/api/bed-types"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.map((b: { name: string }) => b.name)).toEqual([
        "Glass",
        "Smooth PEI",
        "Textured PEI",
      ]);
    });

    it("filters by material", async () => {
      await BedType.create({ name: "Smooth PEI", material: "PEI" });
      await BedType.create({ name: "Glass", material: "Glass" });
      await BedType.create({ name: "Textured PEI", material: "PEI" });

      const res = await listBedTypes(jsonReq("http://localhost/api/bed-types?material=PEI"));
      const body = await res.json();
      expect(body.map((b: { name: string }) => b.name).sort()).toEqual([
        "Smooth PEI",
        "Textured PEI",
      ]);
    });

    it("excludes soft-deleted bed types", async () => {
      await BedType.create({ name: "Live", material: "PEI" });
      await BedType.create({
        name: "Trashed",
        material: "PEI",
        _deletedAt: new Date(),
      });
      const res = await listBedTypes(jsonReq("http://localhost/api/bed-types"));
      const body = await res.json();
      expect(body.map((b: { name: string }) => b.name)).toEqual(["Live"]);
    });
  });

  describe("POST /api/bed-types", () => {
    it("creates a bed type and strips identity fields", async () => {
      const res = await createBedType(
        jsonReq("http://localhost/api/bed-types", {
          _id: "ffffffffffffffffffffffff",
          syncId: "leak",
          name: "Smooth PEI",
          material: "PEI",
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("Smooth PEI");
      expect(body._id).not.toBe("ffffffffffffffffffffffff");
      expect(body.syncId).toBeUndefined();
    });

    it("returns 409 on duplicate name", async () => {
      await BedType.create({ name: "Smooth PEI", material: "PEI" });
      const res = await createBedType(
        jsonReq("http://localhost/api/bed-types", { name: "Smooth PEI", material: "PEI" }),
      );
      expect(res.status).toBe(409);
    });

    it("allows reusing the name of a soft-deleted bed type", async () => {
      const trashed = await BedType.create({ name: "Smooth PEI", material: "PEI" });
      trashed._deletedAt = new Date();
      await trashed.save();

      const res = await createBedType(
        jsonReq("http://localhost/api/bed-types", { name: "Smooth PEI", material: "PEI" }),
      );
      expect(res.status).toBe(201);
    });

    it("returns 400 on invalid JSON", async () => {
      const req = new NextRequest("http://localhost/api/bed-types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      });
      const res = await createBedType(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/bed-types/{id}", () => {
    it("refuses if a filament's calibrations.bedType still references it", async () => {
      const bed = await BedType.create({ name: "Smooth PEI", material: "PEI" });
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "PLA",
        vendor: "T",
        type: "PLA",
        calibrations: [{ nozzle: noz._id, bedType: bed._id }],
      });

      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/referenced by/i);
    });

    it("refuses if a TRASHED filament's calibration still references it (#629)", async () => {
      // Inverts the pre-#629 behavior: a trashed filament can be restored,
      // which would resurrect a dangling calibration bedType ref if the
      // bed type were deleted in the meantime — so trashed referrers block
      // the delete too.
      const bed = await BedType.create({ name: "Smooth PEI", material: "PEI" });
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "Trashed PLA",
        vendor: "T",
        type: "PLA",
        calibrations: [{ nozzle: noz._id, bedType: bed._id }],
        _deletedAt: new Date(),
      });

      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/trash/i);
      const after = await BedType.findById(bed._id);
      expect(after._deletedAt).toBeNull();
    });

    it("ignores _purged filament tombstones when checking refs (#629)", async () => {
      // Purged rows are gone forever — they must NOT block the delete.
      const bed = await BedType.create({ name: "Smooth PEI", material: "PEI" });
      const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "Purged PLA",
        vendor: "T",
        type: "PLA",
        calibrations: [{ nozzle: noz._id, bedType: bed._id }],
        _deletedAt: new Date(),
        _purged: true,
      });

      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(200);
    });

    it("refuses if a printer still installs it (Codex P2 on PR #248)", async () => {
      // Bed types became printer-attachable via Printer.installedBedTypes.
      // Deleting one while a printer still references it would leave a
      // dangling ObjectId that populated reads silently drop — so the
      // DELETE handler must guard printer refs too, mirroring nozzles.
      const Printer = mongoose.models.Printer;
      const bed = await BedType.create({ name: "Textured PEI", material: "PEI" });
      await Printer.create({
        name: "Core One",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedBedTypes: [bed._id],
      });

      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/installed on .* printer/i);
      // The bed type was not soft-deleted.
      const after = await BedType.findById(bed._id);
      expect(after._deletedAt).toBeNull();
    });

    it("ignores soft-deleted printers when checking printer refs", async () => {
      const Printer = mongoose.models.Printer;
      const bed = await BedType.create({ name: "Cool Plate", material: "Glass" });
      await Printer.create({
        name: "Trashed Printer",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedBedTypes: [bed._id],
        _deletedAt: new Date(),
      });

      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(200);
    });

    it("refuses if an active filament names it in bedTypeTemps (#557)", async () => {
      // `bedTypeTemps[].bedType` is a free-text slicer surface key, not a
      // BedType ObjectId ref — but deleting a catalog bed type whose name a
      // filament's per-surface temperature table still uses would silently
      // remove a selectable surface that existing data depends on. The
      // guard matches by name.
      const bed = await BedType.create({ name: "Textured PEI", material: "PEI" });
      await Filament.create({
        name: "PETG",
        vendor: "T",
        type: "PETG",
        bedTypeTemps: [{ bedType: "Textured PEI", temperature: 80 }],
      });

      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/per-bed-type temperatures/i);
      // The bed type was not soft-deleted.
      const after = await BedType.findById(bed._id);
      expect(after._deletedAt).toBeNull();
    });

    it("refuses if a TRASHED filament names it in bedTypeTemps (#557 / #629)", async () => {
      // Inverts the pre-#629 behavior: restore would resurrect the
      // dependency on the deleted surface, so trashed filaments count in
      // the bedTypeTemps name check too.
      const bed = await BedType.create({ name: "Smooth PEI", material: "PEI" });
      await Filament.create({
        name: "Trashed PETG",
        vendor: "T",
        type: "PETG",
        bedTypeTemps: [{ bedType: "Smooth PEI", temperature: 70 }],
        _deletedAt: new Date(),
      });

      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/per-bed-type temperatures/i);
      const after = await BedType.findById(bed._id);
      expect(after._deletedAt).toBeNull();
    });

    it("ignores _purged filaments and unrelated surface names in the bedTypeTemps check (#557 / #629)", async () => {
      const bed = await BedType.create({ name: "Smooth PEI", material: "PEI" });
      // Purged filament that names it — gone forever, must not block.
      await Filament.create({
        name: "Purged PETG",
        vendor: "T",
        type: "PETG",
        bedTypeTemps: [{ bedType: "Smooth PEI", temperature: 70 }],
        _deletedAt: new Date(),
        _purged: true,
      });
      // Active filament that names a DIFFERENT surface — must not block.
      await Filament.create({
        name: "Other PETG",
        vendor: "T",
        type: "PETG",
        bedTypeTemps: [{ bedType: "Glass", temperature: 70 }],
      });

      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(200);
      const after = await BedType.findById(bed._id);
      expect(after._deletedAt).not.toBeNull();
    });

    it("soft-deletes a bed type with no references", async () => {
      const bed = await BedType.create({ name: "Standalone", material: "Glass" });
      const res = await deleteBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(200);
      const after = await BedType.findById(bed._id);
      expect(after._deletedAt).not.toBeNull();
    });
  });

  describe("PUT /api/bed-types/{id}", () => {
    it("updates fields", async () => {
      const bed = await BedType.create({ name: "Old", material: "PEI" });
      const res = await updateBedType(
        jsonReq(
          `http://localhost/api/bed-types/${bed._id}`,
          { name: "New", notes: "rough" },
          "PUT",
        ),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("New");
    });

    it("returns 404 for a soft-deleted bed type", async () => {
      const bed = await BedType.create({
        name: "Trashed",
        material: "PEI",
        _deletedAt: new Date(),
      });
      const res = await updateBedType(
        jsonReq(`http://localhost/api/bed-types/${bed._id}`, { name: "X" }, "PUT"),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/bed-types/{id}", () => {
    it("returns 404 for a soft-deleted bed type", async () => {
      const bed = await BedType.create({
        name: "Gone",
        material: "PEI",
        _deletedAt: new Date(),
      });
      const res = await getBedType(
        new NextRequest(`http://localhost/api/bed-types/${bed._id}`),
        { params: Promise.resolve({ id: String(bed._id) }) },
      );
      expect(res.status).toBe(404);
    });
  });
});
