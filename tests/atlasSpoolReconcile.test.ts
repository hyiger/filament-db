import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import {
  keyRemoteSpools,
  reconcileImportedSpools,
  remoteSpoolId,
  type LocalSpool,
} from "@/lib/atlasSpoolReconcile";

/** GH #1209: spools merge by `_id` on an Atlas re-import. */
describe("remoteSpoolId", () => {
  it("uses a string ObjectId, lowercased", () => {
    expect(remoteSpoolId({ _id: "65A1B2C3D4E5F60718293A4B" }, "f", 0)).toBe("65a1b2c3d4e5f60718293a4b");
  });

  it("uses an ObjectId instance's hex", () => {
    const id = new ObjectId();
    expect(remoteSpoolId({ _id: id }, "f", 0)).toBe(id.toHexString());
  });

  it("derives a stable id when the spool has none or an unusable one", () => {
    const derived = remoteSpoolId({}, "source-filament", 0);
    expect(derived).toMatch(/^[0-9a-f]{24}$/);
    expect(remoteSpoolId({ label: "x" }, "source-filament", 0)).toBe(derived);
    expect(remoteSpoolId({ _id: "not-an-object-id" }, "source-filament", 0)).toBe(derived);
    expect(remoteSpoolId({ _id: { toHexString: 42 } }, "source-filament", 0)).toBe(derived);
    expect(remoteSpoolId({}, "source-filament", 1)).not.toBe(derived);
    expect(remoteSpoolId({}, "other-filament", 0)).not.toBe(derived);
  });
});

describe("keyRemoteSpools", () => {
  it("keys spools in order and drops malformed entries and repeated ids", () => {
    const a = new ObjectId().toHexString();
    const b = new ObjectId().toHexString();
    const { entries, dropped } = keyRemoteSpools(
      [{ _id: a, n: 1 }, null, "junk", [1], { _id: b, n: 2 }, { _id: a.toUpperCase(), n: 3 }],
      "f",
    );
    expect(entries.map((e) => [e.id, e.spool.n])).toEqual([
      [a, 1],
      [b, 2],
    ]);
    expect(dropped).toBe(4);
  });
});

describe("reconcileImportedSpools", () => {
  const mint = (() => {
    let n = 0;
    return () => `minted${++n}`;
  })();
  const localId = new ObjectId();
  const local = (extra: Partial<LocalSpool> = {}): LocalSpool => ({
    _id: localId,
    instanceId: "localinst1",
    locationId: "loc-1",
    totalWeight: 900,
    label: "local",
    ...extra,
  });

  it("updates a matched spool in place but keeps its local identity and location", () => {
    const r = reconcileImportedSpools(
      [{ id: localId.toHexString(), spool: { _id: "ignored", instanceId: "SPOOFED", locationId: "src-loc", totalWeight: 500, label: "remote" } }],
      [local()],
      new Set(),
      mint,
    );
    expect(r.spools).toEqual([
      { _id: localId, instanceId: "localinst1", locationId: "loc-1", totalWeight: 500, label: "remote" },
    ]);
    expect([r.matched, r.added, r.keptLocal, r.skippedOwned]).toEqual([1, 0, 0, 0]);
    expect(r.newlyRetired).toEqual([]);
  });

  it("keeps local values for keys the source omits, and fills a missing instanceId/location", () => {
    const r = reconcileImportedSpools(
      [{ id: localId.toHexString(), spool: { totalWeight: 400 } }],
      [local({ instanceId: undefined, locationId: undefined })],
      new Set(),
      () => "fresh",
    );
    expect(r.spools[0]).toMatchObject({ label: "local", totalWeight: 400, instanceId: "fresh", locationId: null });
  });

  it("reports a spool the source retires, but not one already retired", () => {
    const other = new ObjectId();
    const r = reconcileImportedSpools(
      [
        { id: localId.toHexString(), spool: { retired: true } },
        { id: other.toHexString(), spool: { retired: true } },
      ],
      [local(), local({ _id: other, retired: true })],
      new Set(),
      mint,
    );
    expect(r.newlyRetired).toEqual([localId.toHexString()]);
  });

  it("reads retired the way the schema casts it", () => {
    const retires = (retired: unknown) =>
      reconcileImportedSpools([{ id: localId.toHexString(), spool: { retired } }], [local()], new Set(), mint)
        .newlyRetired.length === 1;
    for (const v of [true, "true", 1, "1", "yes"]) expect(retires(v)).toBe(true);
    for (const v of [false, "false", 0, "0", "no", null, undefined, "TRUE", 2]) expect(retires(v)).toBe(false);
  });

  it("appends a new source spool with its own id, a minted instanceId and no location", () => {
    const newId = new ObjectId().toHexString();
    const r = reconcileImportedSpools(
      [{ id: newId, spool: { _id: newId, instanceId: "SPOOFED", locationId: "src", totalWeight: 1000 } }],
      [local()],
      new Set(),
      () => "brandnew01",
    );
    expect(r.spools).toHaveLength(2);
    expect(r.spools[0]._id).toBe(localId);
    expect(r.spools[1]).toEqual({ _id: newId, instanceId: "brandnew01", locationId: null, totalWeight: 1000 });
    expect([r.matched, r.added, r.keptLocal]).toEqual([0, 1, 1]);
  });

  it("skips a source spool another local filament already owns", () => {
    const taken = new ObjectId().toHexString();
    const r = reconcileImportedSpools([{ id: taken, spool: {} }], [], new Set([taken]), mint);
    expect(r.spools).toEqual([]);
    expect(r.skippedOwned).toBe(1);
  });

  it("keeps local order and every local spool the source doesn't carry", () => {
    const a = new ObjectId();
    const b = new ObjectId();
    const r = reconcileImportedSpools(
      [{ id: b.toHexString(), spool: { label: "B from source" } }],
      [local({ _id: a, label: "A" }), local({ _id: b, label: "B" })],
      new Set(),
      mint,
    );
    expect(r.spools.map((s) => s.label)).toEqual(["A", "B from source"]);
    expect(r.keptLocal).toBe(1);
  });
});
