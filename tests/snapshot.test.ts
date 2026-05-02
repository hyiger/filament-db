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

    // Snapshot version bumps whenever a new collection joins the payload —
    // v3 added locations + printHistory on top of v2's bedTypes. Older
    // versions still restore (see the v1 test below).
    expect(snapshot.version).toBeGreaterThanOrEqual(2);
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

  /**
   * GH #158 regression guard.
   *
   * Pre-fix the snapshot payload deliberately excluded SharedCatalog —
   * but /api/snapshot/delete (the danger-zone wipe) DID clear it. So a
   * snapshot → delete-all → restore round-trip silently dropped every
   * published share link. The fix makes the snapshot symmetric with
   * the delete: SharedCatalog is now part of the export and restore.
   */
  it("snapshot/restore round-trip preserves SharedCatalog (GH #158)", async () => {
    // Re-register SharedCatalog model after the per-test wipe.
    delete mongoose.models.SharedCatalog;
    const SharedCatalog = (await import("@/models/SharedCatalog")).default;

    // Seed a published catalog
    const seed = await SharedCatalog.create({
      slug: "test-share-abc123",
      title: "Shareable PLA",
      description: "A test share",
      payload: { version: 1, createdAt: new Date().toISOString(), filaments: [{ name: "X" }], nozzles: [], printers: [], bedTypes: [] },
      viewCount: 7,
    });

    // Export
    const exportRes = await GET();
    const snapshot = JSON.parse(await exportRes.text());
    expect(snapshot.version).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(snapshot.collections.sharedCatalogs)).toBe(true);
    expect(snapshot.collections.sharedCatalogs).toHaveLength(1);
    expect(snapshot.collections.sharedCatalogs[0].slug).toBe("test-share-abc123");
    expect(snapshot.collections.sharedCatalogs[0].viewCount).toBe(7);

    // Wipe and restore
    await SharedCatalog.deleteMany({});
    expect(await SharedCatalog.countDocuments({})).toBe(0);

    const req = new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.restored.sharedCatalogs).toBe(1);

    const restored = await SharedCatalog.findOne({ slug: "test-share-abc123" }).lean();
    expect(restored).not.toBeNull();
    if (!restored) throw new Error("unreachable — guarded by expect above");
    expect(restored.title).toBe("Shareable PLA");
    expect(restored.viewCount).toBe(7);
    expect(String(restored._id)).toBe(String(seed._id));
  });

  it("POST restore of a snapshot without sharedCatalogs (v3 shape) leaves the collection empty (no crash)", async () => {
    delete mongoose.models.SharedCatalog;
    const SharedCatalog = (await import("@/models/SharedCatalog")).default;
    await SharedCatalog.create({
      slug: "pre-restore-share",
      title: "Pre-restore",
      description: "",
      payload: { version: 1, createdAt: new Date().toISOString(), filaments: [], nozzles: [], printers: [], bedTypes: [] },
    });

    // v3 shape — no sharedCatalogs key
    const snapshot = {
      version: 3,
      createdAt: new Date().toISOString(),
      collections: { filaments: [], nozzles: [], printers: [], bedTypes: [], locations: [], printHistory: [] },
    };

    const req = new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    // No sharedCatalogs in the snapshot → collection wiped (because POST
    // always wipes everything before restoring), and the count comes back
    // 0 — not undefined.
    expect(body.restored.sharedCatalogs).toBe(0);
    expect(await SharedCatalog.countDocuments({})).toBe(0);
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
