import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

/**
 * GH #1149 — `GET /api/name-conflicts`. The twins are seeded via the RAW
 * driver on purpose: Mongoose's trim setter would normalize `"X "` on insert
 * (that untrimmed rows exist at all is a raw-write/legacy phenomenon, which
 * is the whole GH #1116 story).
 */
describe("GET /api/name-conflicts (GH #1149)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GET: any;

  beforeEach(async () => {
    const mods = [
      ["Filament", await import("@/models/Filament")],
      ["Printer", await import("@/models/Printer")],
      ["PrintHistory", await import("@/models/PrintHistory")],
      ["Location", await import("@/models/Location")],
    ] as const;
    for (const [name, mod] of mods) {
      if (!mongoose.models[name]) mongoose.model(name, mod.default.schema);
    }
    GET = (await import("@/app/api/name-conflicts/route")).GET;
  });

  const raw = (name: string) => mongoose.connection.collection(name);

  it("returns [] on a healthy database", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).conflicts).toEqual([]);
  });

  it("names an active collision with its twin and dependent counts", async () => {
    const winner = await raw("locations").insertOne({
      name: "Drybox 1", _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const blocked = await raw("locations").insertOne({
      name: "Drybox 1 ", _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    // One spool referencing the BLOCKED row — the rename-only gate.
    await mongoose.models.Filament.create({
      name: "Dependent PLA", vendor: "V", type: "PLA",
      spools: [{ totalWeight: 1000, locationId: blocked.insertedId }],
    });

    const res = await GET();
    const body = await res.json();
    expect(body.conflicts).toHaveLength(1);
    const c = body.conflicts[0];
    expect(c.collection).toBe("locations");
    expect(c.name).toBe("Drybox 1 ");
    expect(c.id).toBe(String(blocked.insertedId));
    expect(c.trimsTo).toBe("Drybox 1");
    expect(c.reason).toBe("collision");
    expect(c.collidesWith).toEqual({ id: String(winner.insertedId), name: "Drybox 1" });
    expect(c.dependents).toEqual({
      total: 1,
      breakdown: { filamentsWithSpoolsHere: 1 },
    });
  });

  it("reports a whitespace-only name as empty-name with zero dependents", async () => {
    await raw("printers").insertOne({
      name: "   ", _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await GET();
    const body = await res.json();
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].reason).toBe("empty-name");
    expect(body.conflicts[0].trimsTo).toBeNull();
    expect(body.conflicts[0].dependents.total).toBe(0);
  });

  it("hides inactive conflicts — tombstoned rows and purge-zombie clashes", async () => {
    // Tombstoned whitespace-only row: a conflict, but not an ACTIVE one.
    await raw("locations").insertOne({
      name: "  ", _deletedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });
    // A filament blocked only by a hidden purge zombie: classified inactive
    // (nothing a human can act on), so it must not surface either.
    await raw("filaments").insertOne({
      name: "Z", vendor: "V", type: "PLA", spools: [], instanceId: "nc-zombie-1",
      _deletedAt: null, _purged: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await raw("filaments").insertOne({
      name: "Z ", vendor: "V", type: "PLA", spools: [], instanceId: "nc-blocked-1",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await GET();
    expect((await res.json()).conflicts).toEqual([]);
  });

  it("performs no repairs — the blocked row is untouched afterwards", async () => {
    await raw("locations").insertOne({
      name: "Keep ", _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await raw("locations").insertOne({
      name: "Keep", _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await GET();
    expect(await raw("locations").countDocuments({ name: "Keep " })).toBe(1);
  });
});
