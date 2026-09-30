import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoClient, ObjectId } from "mongodb";
import { NextRequest } from "next/server";
import { POST as importAtlas } from "@/app/api/filaments/import-atlas/route";
import { filamentLockKey, runExclusive } from "@/lib/filamentMutex";
import { assignSpoolToSlot } from "@/lib/spoolSlots";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { DELETE as deletePrintHistory } from "@/app/api/print-history/[id]/route";

// Same bypass as tests/import-atlas-template-spools.test.ts (GH #626):
// assertSafeMongoUri would reject the in-memory mongod's plain
// mongodb://127.0.0.1 URI; the guard has its own dedicated suite.
vi.mock("@/lib/mongoUriGuard", () => ({
  assertSafeMongoUri: vi.fn(async () => {}),
}));

/**
 * GH #1209 — re-importing a same-name filament REPLACED the local spools
 * array, carrying `instanceId`s over by position: every local spool `_id` was
 * swapped for the source's, so printer slots, print-history refunds and
 * `?spool=` links went on naming subdocuments that no longer existed. Spools
 * now merge by `_id`.
 */
describe("POST /api/filaments/import-atlas — spool identity on re-import (GH #1209)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Printer: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  function remoteUri() {
    const parsed = new URL((process.env.MONGODB_URI as string).replace("mongodb://", "http://"));
    return `mongodb://${parsed.host}/atlas-spool-identity-src`;
  }

  async function withRemote<T>(fn: (col: ReturnType<ReturnType<MongoClient["db"]>["collection"]>) => Promise<T>) {
    const client = await new MongoClient(remoteUri()).connect();
    try {
      return await fn(client.db().collection("filaments"));
    } finally {
      await client.close();
    }
  }

  async function runImport(remoteIds: ObjectId[]) {
    const res = await importAtlas(
      new NextRequest("http://localhost/api/filaments/import-atlas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: remoteUri(), filamentIds: remoteIds.map(String) }),
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    const printerMod = await import("@/models/Printer");
    const printHistoryMod = await import("@/models/PrintHistory");
    if (!mongoose.models.Filament) mongoose.model("Filament", filamentMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.PrintHistory) mongoose.model("PrintHistory", printHistoryMod.default.schema);
    Filament = filamentMod.default;
    Printer = printerMod.default;
    await withRemote((col) => col.deleteMany({}));
    await Filament.deleteMany({ name: /^Atlas / });
  });

  it("keeps a local spool's _id and references when re-importing from an independent database", async () => {
    // The issue's scenario: local spool S, loaded in a printer slot and
    // debited by a print job; the source's same-name filament has its own R.
    const local = await Filament.create({
      name: "Atlas Indie PLA",
      vendor: "V",
      type: "PLA",
      spools: [{ label: "S", totalWeight: 1000 }],
    });
    const S = local.spools[0];
    const printer = await Printer.create({
      name: "Atlas Printer",
      manufacturer: "M",
      printerModel: "P",
      amsSlots: [{ slotName: "A1", filamentId: local._id, spoolId: S._id }],
    });
    const job = await (
      await postPrintHistory(
        new NextRequest("http://localhost/api/print-history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jobLabel: "before import",
            usage: [{ filamentId: String(local._id), spoolId: String(S._id), grams: 100 }],
          }),
        }),
      )
    ).json();

    const remoteId = new ObjectId();
    const R = new ObjectId();
    await withRemote((col) =>
      col.insertOne({
        _id: remoteId,
        name: "Atlas Indie PLA",
        vendor: "V",
        type: "PLA",
        _deletedAt: null,
        spools: [{ _id: R, label: "R", totalWeight: 750, instanceId: "SPOOFED" }],
      }),
    );
    const body = await runImport([remoteId]);
    expect(body.updated).toBe(1);
    expect(body.errors).toEqual([
      "Atlas Indie PLA: kept 1 local spool(s) the source doesn't have — delete any that duplicate an imported roll",
    ]);

    const fresh = await Filament.findById(local._id).lean();
    expect(fresh.spools.map((s: { _id: unknown }) => String(s._id))).toEqual([String(S._id), String(R)]);
    expect(fresh.spools[0].instanceId).toBe(S.instanceId);
    expect(fresh.spools[0].totalWeight).toBe(900);
    expect(fresh.spools[1].instanceId).toMatch(/^[0-9a-f]{10}$/);
    expect(fresh.spools[1].instanceId).not.toBe("SPOOFED");

    // The slot still names a spool that exists…
    const slotSpool = (await Printer.findById(printer._id).lean()).amsSlots[0].spoolId;
    expect(await Filament.exists({ "spools._id": slotSpool })).toBeTruthy();
    // …and undoing the earlier job still refunds that spool.
    const del = await deletePrintHistory(
      new NextRequest(`http://localhost/api/print-history/${job._id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: job._id }) },
    );
    expect(del.status).toBe(200);
    expect((await Filament.findById(local._id).lean()).spools[0].totalWeight).toBe(1000);
  });

  it("applies source changes to matched spools, keeps local additions, and bumps __v", async () => {
    const remoteId = new ObjectId();
    const A = new ObjectId();
    await withRemote((col) =>
      col.insertOne({
        _id: remoteId,
        name: "Atlas Lineage PLA",
        vendor: "V",
        type: "PLA",
        _deletedAt: null,
        spools: [{ _id: A, label: "A", totalWeight: 1000 }],
      }),
    );
    await runImport([remoteId]);
    const first = await Filament.findOne({ name: "Atlas Lineage PLA" });
    const instanceA = first.spools[0].instanceId;
    expect(String(first.spools[0]._id)).toBe(String(A));
    first.spools.push({ label: "added locally", totalWeight: 500 });
    await first.save();
    const versionBefore = (await Filament.findById(first._id).lean()).__v;

    await withRemote((col) => col.updateOne({ _id: remoteId }, { $set: { "spools.0.totalWeight": 640 } }));
    const body = await runImport([remoteId]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/kept 1 local spool/);

    const fresh = await Filament.findById(first._id).lean();
    expect(fresh.spools.map((s: { label: string }) => s.label)).toEqual(["A", "added locally"]);
    expect(fresh.spools[0].totalWeight).toBe(640);
    expect(fresh.spools[0].instanceId).toBe(instanceA);
    expect(fresh.__v).toBeGreaterThan(versionBefore);
  });

  it("keeps a matched spool's photo when the source omits it, and sanitizes one it sends", async () => {
    const remoteId = new ObjectId();
    const A = new ObjectId();
    const B = new ObjectId();
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    await withRemote((col) =>
      col.insertOne({
        _id: remoteId,
        name: "Atlas Photo PLA",
        vendor: "V",
        type: "PLA",
        _deletedAt: null,
        spools: [
          { _id: A, label: "A", photoDataUrl: photo },
          { _id: B, label: "B", photoDataUrl: photo },
        ],
      }),
    );
    await runImport([remoteId]);
    await withRemote((col) =>
      col.updateOne(
        { _id: remoteId },
        {
          $set: {
            spools: [
              { _id: A, label: "A" },
              { _id: B, label: "B", photoDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
            ],
          },
        },
      ),
    );
    await runImport([remoteId]);
    const [a, b] = (await Filament.findOne({ name: "Atlas Photo PLA" }).lean()).spools;
    expect(a.photoDataUrl).toBe(photo);
    expect(b.photoDataUrl).toBeNull();
  });

  it("keeps each instanceId with its own roll when the source reorders its spools", async () => {
    const remoteId = new ObjectId();
    const A = new ObjectId();
    const B = new ObjectId();
    const doc = { _id: remoteId, name: "Atlas Order PLA", vendor: "V", type: "PLA", _deletedAt: null };
    await withRemote((col) =>
      col.insertOne({ ...doc, spools: [{ _id: A, label: "A" }, { _id: B, label: "B" }] }),
    );
    await runImport([remoteId]);
    const before = await Filament.findOne({ name: "Atlas Order PLA" }).lean();
    const byId = Object.fromEntries(before.spools.map((s: { _id: unknown; instanceId: string }) => [String(s._id), s.instanceId]));

    await withRemote((col) =>
      col.updateOne({ _id: remoteId }, { $set: { spools: [{ _id: B, label: "B" }, { _id: A, label: "A" }] } }),
    );
    const body = await runImport([remoteId]);
    expect(body.errors).toBeUndefined();
    const after = await Filament.findOne({ name: "Atlas Order PLA" }).lean();
    for (const s of after.spools) expect(s.instanceId).toBe(byId[String(s._id)]);
  });

  it("never gives one spool _id a second owner, across repeated imports", async () => {
    const holder = await Filament.create({
      name: "Atlas Holder PLA",
      vendor: "V",
      type: "PLA",
      spools: [{ label: "held", totalWeight: 800 }],
    });
    const K = holder.spools[0]._id;
    const remoteId = new ObjectId();
    await withRemote((col) =>
      col.insertOne({
        _id: remoteId,
        name: "Atlas Renamed PLA",
        vendor: "V",
        type: "PLA",
        _deletedAt: null,
        spools: [{ _id: new ObjectId(String(K)), label: "same roll" }],
      }),
    );
    for (let run = 0; run < 2; run++) {
      const body = await runImport([remoteId]);
      expect(body.errors).toEqual([
        "Atlas Renamed PLA: skipped 1 spool(s) another local filament already holds",
      ]);
    }
    expect(await Filament.countDocuments({ "spools._id": K })).toBe(1);
    expect((await Filament.findOne({ name: "Atlas Renamed PLA" }).lean()).spools).toEqual([]);
  });

  // The write casts "true", 1 and "yes" to true like `true` itself, so the
  // retirement must be detected from those too (Codex review on PR #1217).
  it.each([true, "true", 1, "yes"])("clears a spool the source retires (retired: %j) from its printer slot", async (retired) => {
    const remoteId = new ObjectId();
    const A = new ObjectId();
    const name = `Atlas Retire PLA ${JSON.stringify(retired)}`;
    const doc = { _id: remoteId, name, vendor: "V", type: "PLA", _deletedAt: null };
    await withRemote((col) => col.insertOne({ ...doc, spools: [{ _id: A, totalWeight: 900 }] }));
    await runImport([remoteId]);
    const local = await Filament.findOne({ name }).lean();
    const printer = await Printer.create({
      name: `Atlas Retire Printer ${JSON.stringify(retired)}`,
      manufacturer: "M",
      printerModel: "P",
      amsSlots: [{ slotName: "A1", filamentId: local._id, spoolId: A }],
    });

    await withRemote((col) => col.updateOne({ _id: remoteId }, { $set: { "spools.0.retired": retired } }));
    await runImport([remoteId]);
    expect((await Filament.findById(local._id).lean()).spools[0].retired).toBe(true);
    const slot = (await Printer.findById(printer._id).lean()).amsSlots[0];
    expect(slot.spoolId).toBeNull();
  });

  it("clears the slot of a spool already retired locally, retrying an interrupted cleanup", async () => {
    const remoteId = new ObjectId();
    const A = new ObjectId();
    const doc = { _id: remoteId, name: "Atlas Retry Retire PLA", vendor: "V", type: "PLA", _deletedAt: null };
    await withRemote((col) => col.insertOne({ ...doc, spools: [{ _id: A, totalWeight: 900 }] }));
    await runImport([remoteId]);
    const local = await Filament.findOne({ name: "Atlas Retry Retire PLA" }).lean();
    const printer = await Printer.create({
      name: "Atlas Retry Retire Printer",
      manufacturer: "M",
      printerModel: "P",
      amsSlots: [{ slotName: "A1", filamentId: local._id, spoolId: A }],
    });
    // An earlier import retired the spool, then stopped before clearing its slot.
    await Filament.collection.updateOne({ _id: local._id }, { $set: { "spools.0.retired": true } });
    await withRemote((col) => col.updateOne({ _id: remoteId }, { $set: { "spools.0.retired": true } }));

    await runImport([remoteId]);
    const slot = (await Printer.findById(printer._id).lean()).amsSlots[0];
    expect(slot.spoolId).toBeNull();
  });

  /** A local filament whose spool A is loaded in a printer slot, and a source
   *  copy of it that now retires A. */
  async function retiredSpoolInSlot(tag: string) {
    const remoteId = new ObjectId();
    const A = new ObjectId();
    const name = `Atlas ${tag} PLA`;
    await withRemote((col) =>
      col.insertOne({ _id: remoteId, name, vendor: "V", type: "PLA", _deletedAt: null, spools: [{ _id: A, totalWeight: 900 }] }),
    );
    await runImport([remoteId]);
    const local = await Filament.findOne({ name }).lean();
    const printer = await Printer.create({
      name: `Atlas ${tag} Printer`,
      manufacturer: "M",
      printerModel: "P",
      amsSlots: [{ slotName: "A1", filamentId: local._id, spoolId: A }],
    });
    await withRemote((col) => col.updateOne({ _id: remoteId }, { $set: { "spools.0.retired": true } }));
    return { remoteId, A, local, printer };
  }

  // Codex review on PR #1217: cleared after the filament's key was released,
  // an un-retire and reload landing in between had its valid slot emptied.
  it("clears retired slots before releasing the filament's lock", async () => {
    const { remoteId, A, local, printer } = await retiredSpoolInSlot("Lock Order");
    const slotId = printer.amsSlots[0]._id;
    const original = Printer.updateMany.bind(Printer);
    let competitor: Promise<void> | undefined;
    const spy = vi.spyOn(Printer, "updateMany").mockImplementation(async (...args: unknown[]) => {
      if (!competitor) {
        // The import's clear. Un-retire and reload the spool under the
        // filament's key, as a spool PUT and a slot assignment would.
        competitor = runExclusive(filamentLockKey(local._id), async () => {
          await Filament.updateOne({ _id: local._id, "spools._id": A }, { $set: { "spools.$.retired": false } });
          await assignSpoolToSlot(Printer, A, { printerId: String(printer._id), slotId: String(slotId) }, local._id);
        });
        // While the import holds the key the competitor can't start, so this
        // times out; after the release it finishes first.
        await Promise.race([competitor, new Promise((r) => setTimeout(r, 300))]);
      }
      return original(...args);
    });
    try {
      await runImport([remoteId]);
      await competitor;
    } finally {
      spy.mockRestore();
    }
    const slot = (await Printer.findById(printer._id).lean()).amsSlots[0];
    expect(String(slot.spoolId)).toBe(String(A));
  });

  it("reports a failed slot clear as a note, and the next import retries it", async () => {
    const { remoteId, printer } = await retiredSpoolInSlot("Clear Fails");
    const spy = vi.spyOn(Printer, "updateMany").mockRejectedValueOnce(new Error("printer write failed"));
    let body: { updated: number; errors?: string[] };
    try {
      body = await runImport([remoteId]);
    } finally {
      spy.mockRestore();
    }
    expect(body.updated).toBe(1);
    expect(body.errors?.join("\n")).toMatch(/couldn't clear retired spools from printer slots \(printer write failed\)/);
    expect((await Printer.findById(printer._id).lean()).amsSlots[0].spoolId).not.toBeNull();

    await runImport([remoteId]);
    expect((await Printer.findById(printer._id).lean()).amsSlots[0].spoolId).toBeNull();
  });

  // Codex review on PR #1217: two imports adding the same source spool to
  // different local filaments each saw it unowned, and both kept it.
  it("gives a spool one owner when two imports add it at once", async () => {
    const X = new ObjectId();
    const [one, two] = [new ObjectId(), new ObjectId()];
    await withRemote((col) =>
      col.insertMany([
        { _id: one, name: "Atlas Race One PLA", vendor: "V", type: "PLA", _deletedAt: null, spools: [{ _id: X, totalWeight: 900 }] },
        { _id: two, name: "Atlas Race Two PLA", vendor: "V", type: "PLA", _deletedAt: null, spools: [{ _id: X, totalWeight: 900 }] },
      ]),
    );
    // Hold each import's ownership query until both have run it, or 300 ms
    // pass (serialized, the second can't run it until the first has written).
    const original = Filament.find.bind(Filament);
    let arrived = 0;
    let bothArrived!: () => void;
    const barrier = new Promise<void>((r) => (bothArrived = r));
    const spy = vi.spyOn(Filament, "find").mockImplementation((...args: unknown[]) => {
      const filter = args[0] as Record<string, unknown> | undefined;
      if (!filter || !("spools._id" in filter)) return original(...args);
      if (++arrived === 2) bothArrived();
      return {
        lean: async () => {
          await Promise.race([barrier, new Promise((r) => setTimeout(r, 300))]);
          return original(...args).lean();
        },
      };
    });
    let bodies: { errors?: string[] }[];
    try {
      bodies = await Promise.all([runImport([one]), runImport([two])]);
    } finally {
      spy.mockRestore();
    }
    expect(await Filament.countDocuments({ "spools._id": X })).toBe(1);
    expect(bodies.flatMap((b) => b.errors ?? []).join("\n")).toMatch(/skipped 1 spool\(s\) another local filament already holds/);
  });

  it("merges into a trashed row it resurrects, keeping that row's spool identity", async () => {
    const trashed = await Filament.create({
      name: "Atlas Trashed PLA",
      vendor: "V",
      type: "PLA",
      spools: [{ label: "S", totalWeight: 700 }],
      _deletedAt: new Date(),
    });
    const S = trashed.spools[0];
    const remoteId = new ObjectId();
    await withRemote((col) =>
      col.insertOne({
        _id: remoteId,
        name: "Atlas Trashed PLA",
        vendor: "V",
        type: "PLA",
        _deletedAt: null,
        spools: [{ _id: new ObjectId(String(S._id)), label: "S", totalWeight: 650 }],
      }),
    );
    const body = await runImport([remoteId]);
    expect(body.updated).toBe(1);
    const fresh = await Filament.findById(trashed._id).lean();
    expect(fresh._deletedAt).toBeNull();
    expect(fresh.spools).toHaveLength(1);
    expect(String(fresh.spools[0]._id)).toBe(String(S._id));
    expect(fresh.spools[0].instanceId).toBe(S.instanceId);
    expect(fresh.spools[0].totalWeight).toBe(650);
  });

  it("reports one failing row and still imports the rest", async () => {
    const good = new ObjectId();
    const bad = new ObjectId();
    await withRemote((col) =>
      col.insertMany([
        { _id: good, name: "Atlas Good PLA", vendor: "V", type: "PLA", _deletedAt: null },
        { _id: bad, name: "Atlas Bad PLA", vendor: "V", type: "PLA", cost: -5, _deletedAt: null },
      ]),
    );
    const body = await runImport([good, bad]);
    expect(body.created).toBe(1);
    expect(body.message).toMatch(/^Imported 1 filament \(1 new, 0 updated\)/);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/^Atlas Bad PLA: not imported — /);
    expect(await Filament.exists({ name: "Atlas Good PLA" })).toBeTruthy();
  });
});
