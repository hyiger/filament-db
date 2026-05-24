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
    // GH #295: re-register every model via mongoose.model(name, schema).
    // setup.ts wipes mongoose.models between tests, and a plain
    // `import` returns the module-cached model object — which is no
    // longer in the registry after the wipe, so any `.populate()` the
    // snapshot/restore route might gain in future would throw "Schema
    // hasn't been registered". Registering through the registry (the
    // pattern locations-route.test.ts / print-history.test.ts use)
    // keeps the test robust against that.
    const bedMod = await import("@/models/BedType");
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const prtMod = await import("@/models/Printer");
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    BedType = mongoose.models.BedType;
    Filament = mongoose.models.Filament;
    Nozzle = mongoose.models.Nozzle;
    Printer = mongoose.models.Printer;
  });

  it("GET includes bedTypes in the snapshot payload", async () => {
    await BedType.create({ name: "Smooth PEI", material: "PEI" });
    await BedType.create({ name: "Textured PEI", material: "PEI" });

    const res = await GET(new NextRequest("http://localhost/api/snapshot"));
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
    const exportRes = await GET(new NextRequest("http://localhost/api/snapshot"));
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
    const exportRes = await GET(new NextRequest("http://localhost/api/snapshot"));
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

/**
 * v3 snapshot also added Location and PrintHistory. The bedType test above
 * verifies the export side picks up the new collections via
 * snapshot.version >= 2; these tests verify the full round-trip for
 * Location and PrintHistory specifically — without them, a regression
 * that silently drops either collection from the restore code path would
 * not surface until a user actually tried to recover from a snapshot and
 * found their inventory locations or print history were gone.
 */
describe("snapshot route — Location + PrintHistory round-trip", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Location: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;

  beforeEach(async () => {
    delete mongoose.models.Filament;
    delete mongoose.models.Nozzle;
    delete mongoose.models.Printer;
    delete mongoose.models.BedType;
    delete mongoose.models.Location;
    delete mongoose.models.PrintHistory;
    Filament = (await import("@/models/Filament")).default;
    Nozzle = (await import("@/models/Nozzle")).default;
    Printer = (await import("@/models/Printer")).default;
    // BedType registered for side effect (rehydration of calibrations.bedType
    // refs); this suite doesn't use the handle directly.
    await import("@/models/BedType");
    Location = (await import("@/models/Location")).default;
    PrintHistory = (await import("@/models/PrintHistory")).default;
  });

  it("GET includes locations and printHistory in the snapshot payload", async () => {
    await Location.create({ name: "Drybox 1", kind: "drybox", humidity: 18 });
    await Location.create({ name: "Garage shelf", kind: "shelf" });

    const res = await GET(new NextRequest("http://localhost/api/snapshot"));
    const snapshot = await res.json();

    expect(snapshot.version).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(snapshot.collections.locations)).toBe(true);
    expect(snapshot.collections.locations).toHaveLength(2);
    expect(Array.isArray(snapshot.collections.printHistory)).toBe(true);
  });

  it("POST restore replaces locations from the snapshot", async () => {
    // Pre-existing location that should be wiped
    await Location.create({ name: "Old shelf", kind: "shelf" });

    const snapshot = {
      version: 3,
      createdAt: new Date().toISOString(),
      collections: {
        filaments: [],
        nozzles: [],
        printers: [],
        bedTypes: [],
        locations: [
          { name: "Restored Drybox", kind: "drybox", humidity: 22, notes: "" },
          { name: "Restored Cabinet", kind: "cabinet", humidity: null, notes: "" },
        ],
        printHistory: [],
      },
    };

    const res = await POST(
      new NextRequest("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot),
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.restored.locations).toBe(2);

    const locs = await Location.find({}).lean();
    expect(locs).toHaveLength(2);
    expect(locs.map((l: { name: string }) => l.name).sort()).toEqual([
      "Restored Cabinet",
      "Restored Drybox",
    ]);
  });

  it("POST restore preserves PrintHistory entries with their filament refs", async () => {
    // Build a print history entry referencing a real filament so the
    // restore can rehydrate ObjectId fields correctly.
    const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
    const printer = await Printer.create({
      name: "Mk4",
      manufacturer: "Prusa",
      printerModel: "Mk4",
    });
    const filament = await Filament.create({
      name: "PLA",
      vendor: "T",
      type: "PLA",
      compatibleNozzles: [noz._id],
    });
    await PrintHistory.create({
      jobLabel: "benchy",
      printerId: printer._id,
      usage: [{ filamentId: filament._id, grams: 12.3 }],
      startedAt: new Date(),
      source: "manual",
    });

    // Export full snapshot, wipe, restore.
    const exportRes = await GET(new NextRequest("http://localhost/api/snapshot"));
    const snapshotPayload = JSON.parse(await exportRes.text());

    await PrintHistory.deleteMany({});
    await Filament.deleteMany({});
    await Printer.deleteMany({});
    await Nozzle.deleteMany({});

    const restoreRes = await POST(
      new NextRequest("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshotPayload),
      }),
    );
    expect(restoreRes.status).toBe(200);

    const phs = await PrintHistory.find({}).lean();
    expect(phs).toHaveLength(1);
    expect(phs[0].jobLabel).toBe("benchy");
    // ObjectId rehydration: filamentId and printerId should both be
    // ObjectIds on disk after restore (not strings) so populate works
    // and queries by id continue to function.
    expect(phs[0].usage[0].filamentId.toString()).toBe(filament._id.toString());
    expect(phs[0].printerId.toString()).toBe(printer._id.toString());
  });

  it("POST restore preserves PrintHistory syncId values (issue #361)", async () => {
    // PrintHistory participates in hybrid sync via `syncId` (mirroring
    // every other synced collection). The snapshot restore now inserts
    // through Mongoose schemas in strict mode, which silently strips
    // unknown keys. Without `syncId` declared on PrintHistorySchema,
    // a restored row would lose its sync identity and the next sync
    // cycle would treat it as a new/unpaired record. Lock down that
    // the field round-trips through export → wipe → restore.
    const filament = await Filament.create({
      name: "Sync PLA",
      vendor: "T",
      type: "PLA",
    });
    const SYNC_ID = "ph-sync-id-from-atlas-7a8b9c";
    await PrintHistory.create({
      jobLabel: "sync-test-job",
      printerId: null,
      usage: [{ filamentId: filament._id, grams: 5.5 }],
      startedAt: new Date(),
      source: "manual",
      syncId: SYNC_ID,
    });

    const exportRes = await GET(new NextRequest("http://localhost/api/snapshot"));
    const snapshotPayload = JSON.parse(await exportRes.text());

    await PrintHistory.deleteMany({});
    await Filament.deleteMany({});

    const restoreRes = await POST(
      new NextRequest("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshotPayload),
      }),
    );
    expect(restoreRes.status).toBe(200);

    const ph = await PrintHistory.findOne({ jobLabel: "sync-test-job" }).lean();
    expect(ph).not.toBeNull();
    expect(ph?.syncId).toBe(SYNC_ID);
  });

  it("POST restore round-trips spool.locationId references through Location ObjectId rehydration", async () => {
    // The harder case: a spool subdocument holds a locationId pointing at
    // a real Location. After export → wipe → restore, the restored
    // spool's locationId must still resolve to the right (restored)
    // Location document.
    const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
    const loc = await Location.create({ name: "Active Drybox", kind: "drybox" });
    await Filament.create({
      name: "PLA",
      vendor: "T",
      type: "PLA",
      compatibleNozzles: [noz._id],
      spools: [{ label: "Spool 1", totalWeight: 1000, locationId: loc._id }],
    });

    const exportRes = await GET(new NextRequest("http://localhost/api/snapshot"));
    const snapshotPayload = JSON.parse(await exportRes.text());

    await Filament.deleteMany({});
    await Location.deleteMany({});
    await Nozzle.deleteMany({});

    const restoreRes = await POST(
      new NextRequest("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshotPayload),
      }),
    );
    expect(restoreRes.status).toBe(200);

    const restoredLoc = await Location.findOne({ name: "Active Drybox" });
    const restoredFil = await Filament.findOne({ name: "PLA" }).lean();
    expect(restoredFil.spools[0].locationId.toString()).toBe(
      restoredLoc._id.toString(),
    );
  });

  it("rejects a snapshot with an invalid document and rolls back (GH #259/#333)", async () => {
    // Pre-existing data that must survive a failed restore.
    await Filament.create({ name: "Survivor PLA", vendor: "T", type: "PLA" });

    const snapshot = {
      version: 4,
      createdAt: new Date().toISOString(),
      collections: {
        // `vendor` is a required field — this document fails schema
        // validation, so the `ordered: true` insertMany throws.
        filaments: [{ name: "Invalid Filament", type: "PLA" }],
        nozzles: [],
        printers: [],
        bedTypes: [],
        locations: [],
        printHistory: [],
        sharedCatalogs: [],
      },
    };

    const res = await POST(
      new NextRequest("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot),
      }),
    );
    // The restore must NOT silently succeed on an invalid import.
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/rolled back/i);

    // Pre-existing data was restored; the invalid document never landed.
    const all = await Filament.find({}).lean();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Survivor PLA");
  });
});
