import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/snapshot/route";

/**
 * These tests cover the snapshot GET/POST round-trip with a focus on the
 * bedTypes collection being correctly exported and restored. Prior to this
 * fix, snapshots silently dropped all bed types — a restore would wipe every
 * plate definition and break every calibration referencing one.
 *
 * They use the shared in-memory MongoDB instance set up in tests/setup.ts.
 */
describe("snapshot route — bedTypes round-trip", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BedType: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;

  beforeEach(async () => {
    delete mongoose.models.BedType;
    delete mongoose.models.Filament;
    delete mongoose.models.Nozzle;
    delete mongoose.models.Printer;
    BedType = (await import("@/models/BedType")).default;
    Filament = (await import("@/models/Filament")).default;
    Nozzle = (await import("@/models/Nozzle")).default;
    Printer = (await import("@/models/Printer")).default;
  });

  it("GET includes bedTypes in the snapshot payload", async () => {
    await BedType.create({ name: "Smooth PEI", material: "PEI" });
    await BedType.create({ name: "Textured PEI", material: "PEI" });

    const res = await GET();
    const snapshot = await res.json();

    expect(snapshot.version).toBe(2);
    expect(Array.isArray(snapshot.collections.bedTypes)).toBe(true);
    expect(snapshot.collections.bedTypes).toHaveLength(2);
    const names = snapshot.collections.bedTypes.map((b: { name: string }) => b.name).sort();
    expect(names).toEqual(["Smooth PEI", "Textured PEI"]);
  });

  it("POST restore replaces bedTypes from the snapshot", async () => {
    // Pre-existing bed type that should be wiped by the restore
    await BedType.create({ name: "Old Plate", material: "Glass" });

    const snapshot = {
      version: 2,
      createdAt: new Date().toISOString(),
      collections: {
        filaments: [],
        nozzles: [],
        printers: [],
        bedTypes: [
          { name: "Restored PEI", material: "PEI", notes: "" },
          { name: "Restored Glass", material: "Glass", notes: "hot" },
        ],
      },
    };

    const req = new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.restored.bedTypes).toBe(2);

    const bedTypes = await BedType.find({}).lean();
    expect(bedTypes).toHaveLength(2);
    const names = bedTypes.map((b: { name: string }) => b.name).sort();
    expect(names).toEqual(["Restored Glass", "Restored PEI"]);
  });

  it("POST restore of a v1 snapshot (no bedTypes) leaves the collection empty, not undefined", async () => {
    // Upgrading users with an older snapshot should still be able to restore.
    const snapshot = {
      version: 1,
      createdAt: new Date().toISOString(),
      collections: {
        filaments: [],
        nozzles: [],
        printers: [],
      },
    };

    await BedType.create({ name: "Pre-restore", material: "PEI" });

    const req = new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.restored.bedTypes).toBe(0);

    const bedTypes = await BedType.find({}).lean();
    expect(bedTypes).toHaveLength(0);
  });

  it("POST restore preserves calibration.bedType references through ObjectId rehydration", async () => {
    // End-to-end: export a filament whose calibration references a BedType,
    // restore the snapshot, and verify the reference still resolves.
    const printer = await Printer.create({
      name: "Test",
      manufacturer: "TestCo",
      printerModel: "T1",
    });
    const nozzle = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const bedType = await BedType.create({ name: "Smooth PEI", material: "PEI" });
    await Filament.create({
      name: "Test PLA",
      vendor: "TestVendor",
      type: "PLA",
      color: "#ff0000",
      calibrations: [
        {
          printer: printer._id,
          nozzle: nozzle._id,
          bedType: bedType._id,
          extrusionMultiplier: 1.0,
        },
      ],
    });

    // Export
    const exportRes = await GET();
    const snapshotPayload = JSON.parse(await exportRes.text());

    // Wipe and re-import
    await Filament.deleteMany({});
    await BedType.deleteMany({});
    await Nozzle.deleteMany({});
    await Printer.deleteMany({});

    const req = new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshotPayload),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const restored = await Filament.findOne({ name: "Test PLA" }).lean();
    expect(restored).toBeTruthy();
    expect(restored.calibrations[0].bedType).toBeDefined();
    // After restoreTypes, bedType should be an ObjectId, not a string
    expect(restored.calibrations[0].bedType.toString()).toBe(bedType._id.toString());
  });
});
