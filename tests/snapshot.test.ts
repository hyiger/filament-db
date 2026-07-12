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

  it("re-tombstones a purged-but-active zombie on restore (GH #1009 Codex P2)", async () => {
    // A snapshot from an install affected by the purged-zombie bug carries a
    // filament with _purged: true but _deletedAt: null — an active zombie the
    // startup migration won't re-repair this process. Restore must normalize it.
    const snapshot = {
      version: 3,
      createdAt: new Date().toISOString(),
      collections: {
        filaments: [
          { name: "Zombie PLA", vendor: "T", type: "PLA", _purged: true, _deletedAt: null },
          { name: "Live PLA", vendor: "T", type: "PLA" },
        ],
        nozzles: [], printers: [], bedTypes: [], locations: [], printHistory: [], sharedCatalogs: [],
      },
    };
    const res = await POST(new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    }));
    expect(res.status).toBe(200);

    // The zombie is restored but re-tombstoned: _purged stays true AND
    // _deletedAt is now set, so it's out of the active set (no visible zombie).
    const zombie = await Filament.findOne({ name: "Zombie PLA" }).lean();
    expect(zombie._purged).toBe(true);
    expect(zombie._deletedAt).not.toBeNull();
    expect(zombie._deletedAt).toBeInstanceOf(Date);
    // A normal row is untouched (still active).
    const live = await Filament.findOne({ name: "Live PLA" }).lean();
    expect(live._deletedAt ?? null).toBeNull();
  });

  it("rejects a null row with a clean 400, not a 500 (GH #1009 Codex P3)", async () => {
    // Pre-existing data must survive an invalid restore untouched.
    await BedType.create({ name: "Keep Me", material: "PEI" });

    const snapshot = {
      version: 3,
      createdAt: new Date().toISOString(),
      collections: {
        filaments: [null], // a null element passes the array-shape check
        nozzles: [], printers: [], bedTypes: [], locations: [], printHistory: [], sharedCatalogs: [],
      },
    };
    const res = await POST(new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    }));
    // Pre-fix: restoreTypes(null) threw outside the try → 500. Now a clean 400.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/filaments\[0\]/);

    // DB untouched — the pre-existing bed type is still there.
    expect(await BedType.countDocuments({ name: "Keep Me" })).toBe(1);
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

  it("#889: rejects a raw body whose declared Content-Length exceeds the cap (413, no buffering)", async () => {
    const req = new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(51 * 1024 * 1024), // > 50 MB cap
      },
      body: JSON.stringify({ version: 2, createdAt: new Date().toISOString(), collections: {} }),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("#890: restore coerces ObjectId-array fields but leaves other 24-hex string arrays as strings", async () => {
    const nozzleHex = "aaaaaaaaaaaaaaaaaaaaaaaa"; // valid 24-hex → real nozzle ref
    const notARef = "bbbbbbbbbbbbbbbbbbbbbbbb"; // 24-hex but NOT an ObjectId field
    const snapshot = {
      version: 2,
      createdAt: new Date().toISOString(),
      collections: {
        filaments: [
          {
            name: "Coerce guard",
            vendor: "QA",
            type: "PLA",
            // A 24-hex string riding in the Mixed settings bag inside an array.
            // The array branch must NOT coerce it (key isn't an OID array field).
            settings: { customRefs: [notARef] },
          },
        ],
        nozzles: [],
        printers: [
          {
            name: "P1",
            manufacturer: "X",
            printerModel: "1",
            installedNozzles: [nozzleHex], // genuine ObjectId array → must coerce
          },
        ],
      },
    };
    const req = new NextRequest("http://localhost/api/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const printer = await Printer.findOne({ name: "P1" }).lean();
    expect(printer.installedNozzles[0]).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(printer.installedNozzles[0])).toBe(nozzleHex);

    const fil = await Filament.findOne({ name: "Coerce guard" }).lean();
    expect(typeof fil.settings.customRefs[0]).toBe("string"); // NOT coerced to ObjectId
    expect(fil.settings.customRefs[0]).toBe(notARef);
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

  it("rejects an invalid snapshot with 400 BEFORE wiping anything (GH #259/#333, #1004 F2)", async () => {
    // Pre-existing data that must survive an invalid restore attempt.
    await Filament.create({ name: "Survivor PLA", vendor: "T", type: "PLA" });

    const snapshot = {
      version: 4,
      createdAt: new Date().toISOString(),
      collections: {
        // `vendor` is a required field — this document fails schema
        // validation. #1004 F2: pre-validation now catches it BEFORE the
        // destructive wipe, so the failure is a clean 400 with the DB
        // untouched (pre-fix: wipe → ordered insertMany throw → rollback).
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
    // The restore must NOT silently succeed on an invalid import — and must
    // not wipe first either.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/nothing was changed/i);
    expect(body.error).toMatch(/filaments\[0\]/);

    // Pre-existing data untouched; the invalid document never landed.
    const all = await Filament.find({}).lean();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Survivor PLA");
  });

  /**
   * GH #1004 F2 — THE P1 PIN. The rollback used to re-hydrate the backup
   * through full Mongoose validation with `ordered: false` +
   * `throwOnValidationError: false`, silently DROPPING any legacy doc that
   * no longer passes the CURRENT schema (exactly the population the #905
   * `validateModifiedOnly` fixes exist for) while the response claimed a
   * complete rollback. With `lean: true` the backup is reinserted
   * byte-identically.
   *
   * Recipe: a legacy-invalid doc (cost: -5, inserted via the raw driver —
   * bypassing Mongoose like a pre-#337 install) + a snapshot that PASSES
   * per-doc pre-validation but fails at the DRIVER level mid-insert (two
   * docs sharing an _id → E11000), so the wipe-then-rollback path runs.
   */
  it("rollback preserves legacy docs that fail current validation (GH #1004 F2)", async () => {
    await Filament.collection.insertOne({
      name: "Legacy Invalid",
      vendor: "Old",
      type: "PLA",
      cost: -5, // violates cost.min on the current schema
      _deletedAt: null,
    });

    const dupId = new mongoose.Types.ObjectId().toString();
    const snapshot = {
      version: 4,
      createdAt: new Date().toISOString(),
      collections: {
        // Each doc is individually VALID (passes pre-validation), but the
        // shared _id makes the ordered insertMany throw a driver-level
        // E11000 on the second doc → the catch wipes + rolls back.
        filaments: [
          { _id: dupId, name: "Dup A", vendor: "V", type: "PLA" },
          { _id: dupId, name: "Dup B", vendor: "V", type: "PLA" },
        ],
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
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/rolled back/i);

    // The legacy doc SURVIVED the rollback verbatim (pre-fix: silently
    // dropped because cost: -5 fails re-validation).
    const legacy = await Filament.collection.findOne({ name: "Legacy Invalid" });
    expect(legacy).not.toBeNull();
    expect(legacy!.cost).toBe(-5);

    // And the snapshot's docs did not land.
    expect(await Filament.collection.countDocuments({ name: /^Dup / })).toBe(0);
  });

  /**
   * #732 Phase 5: filaments are snapshotted whole, so each embedded spool's
   * per-spool `instanceId` must survive a full GET → restore round-trip.
   * No special handling exists for it — this guards that none is ever
   * needed (e.g. if a future change started projecting spool subfields).
   */
  it("snapshot/restore round-trip preserves each spool's instanceId (#732 Phase 5)", async () => {
    const seed = await Filament.create({
      name: "Snapshot Spools",
      vendor: "T",
      type: "PLA",
      spools: [
        { label: "A", totalWeight: 1000, instanceId: "snap-roll-1" },
        { label: "B", totalWeight: 900, instanceId: "snap-roll-2" },
      ],
    });
    const ids = (seed.spools as { instanceId: string }[]).map((s) => s.instanceId);
    expect(ids).toEqual(["snap-roll-1", "snap-roll-2"]);

    // Export, then feed the GET output straight back into the restore.
    const getRes = await GET(new NextRequest("http://localhost/api/snapshot"));
    const snapshot = await getRes.json();
    const exported = snapshot.collections.filaments.find(
      (f: { name: string }) => f.name === "Snapshot Spools",
    );
    expect(exported.spools.map((s: { instanceId: string }) => s.instanceId)).toEqual([
      "snap-roll-1",
      "snap-roll-2",
    ]);

    const res = await POST(
      new NextRequest("http://localhost/api/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot),
      }),
    );
    expect(res.status).toBe(200);

    const fresh = await Filament.findOne({ name: "Snapshot Spools" }).lean();
    expect(fresh.spools.map((s: { instanceId: string }) => s.instanceId)).toEqual([
      "snap-roll-1",
      "snap-roll-2",
    ]);
  });

  // GH #953 finding 4: restore must fail closed on a snapshot it can't fully
  // apply, BEFORE the destructive wipe — never wipe the DB and then report
  // success while silently dropping data.
  describe("restore version + shape validation (#953)", () => {
    function postSnapshot(snapshot: unknown) {
      return POST(
        new NextRequest("http://localhost/api/snapshot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(snapshot),
        }),
      );
    }

    it("rejects a snapshot from a newer version with 400 and does NOT wipe", async () => {
      const canary = await Location.create({ name: "Canary Loc" });
      const res = await postSnapshot({
        version: 5,
        createdAt: new Date().toISOString(),
        // A v5 file could carry a new/renamed collection the v4 restore would drop.
        collections: { filaments: [], nozzles: [], printers: [], bedTypes: [] },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/newer version/i);
      // The pre-existing data survives — no wipe happened.
      expect(await Location.countDocuments({ _id: canary._id })).toBe(1);
    });

    it("rejects an empty collections object with 400 and does NOT wipe", async () => {
      const canary = await Location.create({ name: "Canary Loc 2" });
      const res = await postSnapshot({
        version: 4,
        createdAt: new Date().toISOString(),
        collections: {},
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/no recognized collections/i);
      expect(await Location.countDocuments({ _id: canary._id })).toBe(1);
    });

    it("rejects a non-object collections value (collections: 1) with 400 and does NOT wipe", async () => {
      const canary = await Location.create({ name: "Canary Loc 3" });
      const res = await postSnapshot({
        version: 4,
        createdAt: new Date().toISOString(),
        collections: 1,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/missing or malformed/i);
      expect(await Location.countDocuments({ _id: canary._id })).toBe(1);
    });

    it("rejects collections with only unrecognized keys with 400 and does NOT wipe", async () => {
      const canary = await Location.create({ name: "Canary Loc 4" });
      const res = await postSnapshot({
        version: 4,
        createdAt: new Date().toISOString(),
        collections: { spoolsCollection: [{ foo: 1 }] },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/no recognized collections/i);
      expect(await Location.countDocuments({ _id: canary._id })).toBe(1);
    });

    it("rejects a present collection whose value is not an array, and does NOT wipe (Codex P1)", async () => {
      const canary = await Location.create({ name: "Canary Loc 5" });
      // `locations: {}` passes the key-presence guard but isn't an array — the
      // destructure would leave it non-array, `.length` undefined, every insert
      // skipped after the wipe. Must 400 before the destructive path.
      const res = await postSnapshot({
        version: 4,
        createdAt: new Date().toISOString(),
        collections: { locations: {} },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/must be an array/i);
      expect(await Location.countDocuments({ _id: canary._id })).toBe(1);

      // Also a scalar under a known key.
      const canary2 = await Location.create({ name: "Canary Loc 6" });
      const res2 = await postSnapshot({
        version: 4,
        createdAt: new Date().toISOString(),
        collections: { filaments: 1 },
      });
      expect(res2.status).toBe(400);
      expect(await Location.countDocuments({ _id: canary2._id })).toBe(1);
    });

    it("still restores a snapshot with no version field (older/hand-written) when collections are recognized", async () => {
      await Location.create({ name: "Pre-existing Loc" });
      const res = await postSnapshot({
        createdAt: new Date().toISOString(),
        collections: { locations: [{ name: "Restored No-Version" }] },
      });
      expect(res.status).toBe(200);
      const names = (await Location.find({}).lean()).map((l: { name: string }) => l.name);
      expect(names).toEqual(["Restored No-Version"]);
    });
  });
});
