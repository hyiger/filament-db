import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { upsertIniFilament } from "@/lib/iniImportApply";
import type { CollapsedFilamentData } from "@/lib/prusaSlicerBundle";

/**
 * GH #951 — the create/race branch of the shared INI upsert (lines the two
 * routes' happy-path tests can't reach deterministically). Phase 3's E11000
 * recovery only fires when a concurrent writer creates the same name between
 * our phase-1 read and our create — so it's exercised here by mocking
 * `Filament.create` to simulate that race.
 */
describe("upsertIniFilament — create-race recovery (GH #951)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    // Use the module's singleton default export — the SAME object
    // `iniImportApply.ts` imports — so vi.spyOn(Filament, "create") actually
    // intercepts the helper's call. (setup.ts wipes mongoose.models between
    // tests, but the original model class still runs plain CRUD against the DB;
    // re-registering would create a second class the helper doesn't use.)
    Filament = (await import("@/models/Filament")).default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const section = (name: string): CollapsedFilamentData => ({
    name,
    vendor: "Acme",
    type: "PLA",
    color: "#808080",
    cost: 25,
    density: 1.24,
    diameter: 1.75,
    temperatures: { nozzle: 210, nozzleFirstLayer: null, bed: 60, bedFirstLayer: null },
    maxVolumetricSpeed: null,
    inherits: null,
    settings: {},
  });

  it("recovers from a concurrent create (E11000) by updating the racing row", async () => {
    // Simulate the race: phases 1 & 2 find nothing, then a concurrent writer
    // wins the create. The mock persists the row (via the real create) and
    // then throws E11000, exactly as a losing racer would observe.
    const origCreate = Filament.create.bind(Filament);
    vi.spyOn(Filament, "create").mockImplementation(async (doc: unknown) => {
      await origCreate(doc);
      const err = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      throw err;
    });

    const outcome = await upsertIniFilament(section("Race PLA"));
    expect(outcome).toBe("updated");

    // Exactly one row exists — the racing recovery updated it in place.
    const rows = await Filament.find({ name: "Race PLA" });
    expect(rows).toHaveLength(1);
    expect(rows[0].vendor).toBe("Acme");
  });

  it("rethrows a non-duplicate create error unchanged", async () => {
    vi.spyOn(Filament, "create").mockRejectedValue(new Error("disk on fire"));
    await expect(upsertIniFilament(section("Boom PLA"))).rejects.toThrow(/disk on fire/);
  });

  it("rethrows the E11000 when no racing row is found (the winner was deleted)", async () => {
    // create throws E11000 but nothing was actually persisted, so the racing
    // lookup finds no row → the original duplicate error propagates.
    vi.spyOn(Filament, "create").mockImplementation(async () => {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    });
    await expect(upsertIniFilament(section("Ghost PLA"))).rejects.toMatchObject({
      code: 11000,
    });
    expect(await Filament.findOne({ name: "Ghost PLA" })).toBeNull();
  });

  // ── GH #951 (Codex R2-C): a concurrent rename in the read→write window must
  //    not be reverted / mis-targeted; the `name` in each by-_id filter makes
  //    the write miss and fall through to create a fresh row. ────────────────

  /** Wrap findOne so the Nth call renames the row it's about to return. */
  function renameOnCall(nth: number, newName: string) {
    const orig = Filament.findOne.bind(Filament);
    let calls = 0;
    vi.spyOn(Filament, "findOne").mockImplementation((...args: unknown[]) => {
      calls += 1;
      const query = orig(...args);
      if (calls !== nth) return query;
      // Fake the .select().lean() chain: read the real snapshot, then simulate a
      // concurrent rename before the caller's by-_id write runs.
      return {
        select: () => ({
          lean: async () => {
            const snap = await query.lean();
            if (snap) await Filament.updateOne({ _id: snap._id }, { $set: { name: newName } });
            return snap;
          },
        }),
      };
    });
  }

  it("does NOT revert a rename that races the phase-1 update — falls through to create", async () => {
    const original = await Filament.create({ name: "Race X", vendor: "Acme", type: "PLA" });
    renameOnCall(1, "Race Y"); // phase-1 active lookup renames X→Y mid-flight

    const outcome = await upsertIniFilament(section("Race X"));
    expect(outcome).toBe("created");

    // The renamed row is untouched (rename NOT reverted, fields NOT overwritten).
    const renamed = await Filament.findById(original._id).lean();
    expect(renamed.name).toBe("Race Y");
    expect(renamed.cost ?? null).toBeNull(); // section's cost=25 did NOT land here
    // A fresh active "Race X" was created instead.
    const freshX = await Filament.findOne({ name: "Race X", _deletedAt: null }).lean();
    expect(freshX).not.toBeNull();
    expect(String(freshX._id)).not.toBe(String(original._id));
    expect(freshX.cost).toBe(25);
  });

  it("does NOT revert a rename that races the resurrect (phase-2) update", async () => {
    const trashed = await Filament.create({
      name: "Res X",
      vendor: "Acme",
      type: "PLA",
      _deletedAt: new Date(),
    });
    // Call 1 = phase-1 active lookup (no active row → null); call 2 = phase-2
    // trashed lookup → rename it mid-flight.
    renameOnCall(2, "Res Y");

    const outcome = await upsertIniFilament(section("Res X"));
    expect(outcome).toBe("created");

    const renamed = await Filament.findById(trashed._id).lean();
    expect(renamed.name).toBe("Res Y");
    expect(renamed._deletedAt).not.toBeNull(); // NOT resurrected
    const freshX = await Filament.findOne({ name: "Res X", _deletedAt: null }).lean();
    expect(freshX).not.toBeNull();
  });

  it("still updates the matching row normally when no rename races (guards against an over-tight filter)", async () => {
    const existing = await Filament.create({ name: "Plain PLA", vendor: "Old", type: "PLA" });
    const outcome = await upsertIniFilament({ ...section("Plain PLA"), vendor: "New" });
    expect(outcome).toBe("updated");
    const fresh = await Filament.findById(existing._id).lean();
    expect(fresh.vendor).toBe("New");
    // no duplicate created
    expect(await Filament.countDocuments({ name: "Plain PLA" })).toBe(1);
  });

  // ── GH #950: id-first refuse-ambiguous. A section round-tripping a
  //    filamentdb_id that resolves to an ACTIVE filament with a DIFFERENT stored
  //    name is ambiguous (rename vs copied/stale id) → refuse, don't guess. ────
  describe("id-first refuse-ambiguous (GH #950)", () => {
    it("refuses when filamentdb_id resolves to an active filament with a different name", async () => {
      const target = await Filament.create({ name: "Real Name", vendor: "Acme", type: "PLA" });
      // Section is NAMED differently but carries the target's id.
      await expect(
        upsertIniFilament({ ...section("Different Name"), filamentdbId: String(target._id) }),
      ).rejects.toThrow(/resolves to "Real Name"/);
      // Nothing mutated / created.
      expect(await Filament.findById(target._id).lean()).toMatchObject({ name: "Real Name" });
      expect(await Filament.findOne({ name: "Different Name" })).toBeNull();
    });

    it("proceeds normally when filamentdb_id resolves to a filament of the SAME name (a plain update)", async () => {
      const target = await Filament.create({ name: "Match", vendor: "Old", type: "PLA" });
      const outcome = await upsertIniFilament({
        ...section("Match"),
        vendor: "New",
        filamentdbId: String(target._id),
      });
      expect(outcome).toBe("updated");
      expect((await Filament.findById(target._id).lean()).vendor).toBe("New");
    });

    it("falls through to the name-based upsert when filamentdb_id is stale (resolves to nothing)", async () => {
      const staleId = "64b0000000000000000000ff"; // no such filament
      const outcome = await upsertIniFilament({
        ...section("Fresh PLA"),
        filamentdbId: staleId,
      });
      expect(outcome).toBe("created");
      expect(await Filament.findOne({ name: "Fresh PLA", _deletedAt: null })).not.toBeNull();
    });

    it("ignores a non-24-hex filamentdb_id (no id-first check) and upserts by name", async () => {
      const outcome = await upsertIniFilament({
        ...section("Weird Id PLA"),
        filamentdbId: "not-an-objectid",
      });
      expect(outcome).toBe("created");
    });

    it("does NOT refuse against a TRASHED id-match (only active rows are id-authoritative)", async () => {
      // filamentdb_id points at a trashed row of a different name — the id-first
      // check filters `_deletedAt: null`, so it doesn't fire; the name path wins.
      const trashed = await Filament.create({
        name: "Trashed Real",
        vendor: "Acme",
        type: "PLA",
        _deletedAt: new Date(),
      });
      const outcome = await upsertIniFilament({
        ...section("Live Name"),
        filamentdbId: String(trashed._id),
      });
      expect(outcome).toBe("created");
      expect(await Filament.findOne({ name: "Live Name", _deletedAt: null })).not.toBeNull();
    });
  });
});
