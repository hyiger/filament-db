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
});
