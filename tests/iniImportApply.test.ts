import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { upsertIniFilament } from "@/lib/iniImportApply";
import { parseIniFilaments } from "@/lib/parseIni";
import { collapsePerNozzleImportSections } from "@/lib/prusaSlicerBundle";
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

  /** Blind the first `nulls` findOne calls (returning a null .select().lean()
   *  chain) so the upsert takes the phase-3 create path even though an active
   *  row exists; later calls hit the real model. Simulates "the row appeared
   *  between our phase reads and our create". */
  function blindFindOneCalls(nulls: number) {
    const orig = Filament.findOne.bind(Filament);
    let calls = 0;
    vi.spyOn(Filament, "findOne").mockImplementation((...args: unknown[]) => {
      calls += 1;
      if (calls <= nulls) {
        return { select: () => ({ lean: async () => null }) };
      }
      return orig(...args);
    });
  }

  it("rethrows the E11000 when the racing row is renamed before the merge write (merged=null)", async () => {
    await Filament.create({ name: "MergeMiss PLA", vendor: "Acme", type: "PLA" });
    // Phases 1+2 see nothing; the create loses the (simulated) race; the
    // racing lookup (call 3) finds the real row but renames it mid-flight so
    // the name-pinned merge write misses → the original E11000 propagates.
    const orig = Filament.findOne.bind(Filament);
    let calls = 0;
    vi.spyOn(Filament, "findOne").mockImplementation((...args: unknown[]) => {
      calls += 1;
      if (calls <= 2) return { select: () => ({ lean: async () => null }) };
      const query = orig(...args);
      return {
        select: () => ({
          lean: async () => {
            const snap = await query.lean();
            if (snap) {
              await Filament.updateOne({ _id: snap._id }, { $set: { name: "MergeMiss Renamed" } });
            }
            return snap;
          },
        }),
      };
    });
    vi.spyOn(Filament, "create").mockImplementation(async () => {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    });

    await expect(upsertIniFilament(section("MergeMiss PLA"))).rejects.toMatchObject({
      code: 11000,
    });
    // The renamed row was not clobbered by the section (restore the spies
    // first — the blinded findOne fake doesn't implement plain .lean()).
    vi.restoreAllMocks();
    const renamed = await Filament.findOne({ name: "MergeMiss Renamed" }).lean();
    expect(renamed.cost ?? null).toBeNull();
  });

  // ── GH #605: the create-race merge path applies the same template strip as
  //    phase 1 — a concurrent import may have landed a parent that already has
  //    variants by the time the E11000 recovery re-targets it. ───────────────

  it("strips template fields on the create-race merge target and reports via the hook", async () => {
    const parent = await Filament.create({
      name: "Race Tmpl PLA",
      vendor: "Acme",
      type: "PLA",
      color: null,
    });
    await Filament.create({
      name: "Race Tmpl PLA — Red",
      vendor: "Acme",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });
    // Simulate the race: the template "appears" only at the racing lookup.
    blindFindOneCalls(2);
    vi.spyOn(Filament, "create").mockImplementation(async () => {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    });

    const strips: string[][] = [];
    const outcome = await upsertIniFilament(
      { ...section("Race Tmpl PLA"), color: "#00FF00" },
      { onTemplateFieldsStripped: (fields) => strips.push(fields) },
    );
    expect(outcome).toBe("updated");
    expect(strips).toEqual([["color"]]);

    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color ?? null).toBeNull(); // template stayed colorless
    expect(fresh.cost).toBe(25); // the rest of the section still applied
  });

  // ── Defensive guards on a section WITHOUT a settings bag (only reachable
  //    for direct callers — parseIni always materialises `settings`). ────────

  it("tolerates a section with no settings bag on a ROOT target (mergeSettingsDotKeys pass-through)", async () => {
    const existing = await Filament.create({
      name: "NoBag PLA",
      vendor: "Old",
      type: "PLA",
      settings: { keep_me: "v" },
    });
    const { settings: _drop, ...noBag } = section("NoBag PLA");
    void _drop;
    const outcome = await upsertIniFilament({ ...noBag, vendor: "New" } as CollapsedFilamentData);
    expect(outcome).toBe("updated");
    const fresh = await Filament.findById(existing._id).lean();
    expect(fresh.vendor).toBe("New");
    expect(fresh.settings.keep_me).toBe("v"); // stored bag untouched
  });

  it("tolerates a section with no settings bag on a VARIANT target (self-heal no-op)", async () => {
    const parent = await Filament.create({
      name: "NoBag Parent",
      vendor: "Acme",
      type: "PLA",
      settings: { cooling: "1" },
    });
    const variant = await Filament.create({
      name: "NoBag Variant",
      vendor: "Acme",
      type: "PLA",
      color: "#cc0000",
      parentId: parent._id,
      settings: { cooling: "0" },
    });
    const outcome = await upsertIniFilament({
      name: "NoBag Variant",
      inherits: null,
    } as unknown as CollapsedFilamentData);
    expect(outcome).toBe("updated");
    const fresh = await Filament.findById(variant._id).lean();
    expect(fresh.settings.cooling).toBe("0"); // no incoming bag → nothing healed
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

  // ── GH #969: the dot-key settings merge (#950.8b) preserves omitted keys but
  //    no longer wipes a stale variant override that now matches the parent.
  //    `buildIniUpdate` restores that self-heal with per-key `settings.<k>`
  //    $unsets, disjoint from the merge's $set dot-keys. ──────────────────────
  describe("variant settings self-heal (GH #969)", () => {
    const variantSection = (
      name: string,
      settings: Record<string, string>,
    ): CollapsedFilamentData => ({ name, settings, inherits: null });

    it("unsets a stale override that now matches the parent, preserves an omitted key", async () => {
      const parent = await Filament.create({
        name: "SH Parent",
        vendor: "Acme",
        type: "PLA",
        settings: { cooling: "1" },
      });
      const variant = await Filament.create({
        name: "SH Variant",
        vendor: "Acme",
        type: "PLA",
        color: "#cc0000",
        parentId: parent._id,
        settings: { cooling: "0", keep_me: "v" },
      });
      const outcome = await upsertIniFilament(variantSection("SH Variant", { cooling: "1" }));
      expect(outcome).toBe("updated");
      const fresh = await Filament.findById(variant._id).lean();
      expect(fresh.settings.cooling).toBeUndefined(); // self-healed → inherits parent "1"
      expect(fresh.settings.keep_me).toBe("v"); // omitted key preserved (merge, not replace)
    });

    it("writes a differing key while leaving a matching-but-unowned key to inherit", async () => {
      const parent = await Filament.create({
        name: "Diff Parent",
        vendor: "Acme",
        type: "PLA",
        settings: { fan: "50", theme: "dark" },
      });
      const variant = await Filament.create({
        name: "Diff Variant",
        vendor: "Acme",
        type: "PLA",
        color: "#00cc00",
        parentId: parent._id,
        settings: { extra: "old" }, // a variant-only key absent from the parent
      });
      // fan differs from parent → written; theme matches parent AND the variant
      // has no local override → neither set nor unset (keeps inheriting); extra is
      // absent from the parent → a genuine override, written through (not unset).
      const outcome = await upsertIniFilament(
        variantSection("Diff Variant", { fan: "80", theme: "dark", extra: "new" }),
      );
      expect(outcome).toBe("updated");
      const fresh = await Filament.findById(variant._id).lean();
      expect(fresh.settings.fan).toBe("80"); // divergent value written through
      expect(fresh.settings.theme).toBeUndefined(); // matches parent, unowned → inherits
      expect(fresh.settings.extra).toBe("new"); // absent from parent → override written, not healed
    });

    it("clears a parent-EQUAL local override so a future parent edit propagates (GH #969 round 2)", async () => {
      const parent = await Filament.create({
        name: "Eq Parent",
        vendor: "Acme",
        type: "PLA",
        settings: { cooling: "1" },
      });
      const variant = await Filament.create({
        name: "Eq Variant",
        vendor: "Acme",
        type: "PLA",
        color: "#cc00cc",
        parentId: parent._id,
        // Local override that ALREADY equals the parent — functionally
        // inheriting now, but pinned: a future parent edit wouldn't propagate.
        settings: { cooling: "1" },
      });
      const outcome = await upsertIniFilament(variantSection("Eq Variant", { cooling: "1" }));
      expect(outcome).toBe("updated");
      const fresh = await Filament.findById(variant._id).lean();
      // Pin cleared → the key is truly inherited now.
      expect(fresh.settings.cooling).toBeUndefined();
      // Prove propagation: edit the parent, the variant now tracks it.
      await Filament.updateOne({ _id: parent._id }, { $set: { "settings.cooling": "2" } });
      const { resolveFilament } = await import("@/lib/resolveFilament");
      const freshParent = await Filament.findById(parent._id).lean();
      const freshVariant = await Filament.findById(variant._id).lean();
      expect(resolveFilament(freshVariant, freshParent).settings.cooling).toBe("2");
    });

    it("self-heals on the RESURRECT path — a trashed variant's pin is cleared alongside the tombstone (phase 2)", async () => {
      const parent = await Filament.create({
        name: "Res Parent",
        vendor: "Acme",
        type: "PLA",
        settings: { cooling: "1" },
      });
      // A TRASHED variant with a parent-equal pin — resurrected by the import.
      const variant = await Filament.create({
        name: "Res Variant",
        vendor: "Acme",
        type: "PLA",
        color: "#cccc00",
        parentId: parent._id,
        settings: { cooling: "1" },
        _deletedAt: new Date(),
      });
      const outcome = await upsertIniFilament(variantSection("Res Variant", { cooling: "1" }));
      expect(outcome).toBe("updated");
      const fresh = await Filament.findById(variant._id).lean();
      expect(fresh._deletedAt).toBeNull(); // resurrected
      expect(fresh.settings.cooling).toBeUndefined(); // pin cleared on resurrect ($unset rode along)
    });

    it("does not throw when the variant carries no settings at all", async () => {
      const parent = await Filament.create({
        name: "NoSet Parent",
        vendor: "Acme",
        type: "PLA",
        settings: { cooling: "1" },
      });
      const variant = await Filament.create({
        name: "NoSet Variant",
        vendor: "Acme",
        type: "PLA",
        color: "#0000cc",
        parentId: parent._id,
        // no settings field
      });
      const outcome = await upsertIniFilament(variantSection("NoSet Variant", { cooling: "1" }));
      expect(outcome).toBe("updated");
      const fresh = await Filament.findById(variant._id).lean();
      // Nothing to heal; the matching key keeps inheriting (no phantom local write).
      expect(fresh.settings?.cooling).toBeUndefined();
    });
  });

  // ── GH #1008 F3: end-to-end leave-when-omitted for temps + inherits through
  //    the REAL pipeline (parseIni → collapse → upsert). Pre-fix, a section
  //    omitting the temp keys rode parseIni's all-null `temperatures` (and
  //    `inherits: null`) into the importer's dot-key $set and wiped all four
  //    stored temps + inherits on a name-matched filament. ────────────────────
  describe("legacy nozzle-condition ingestion guard (GH #1021 r10)", () => {
    it("strips a provenance-matching machine condition on update; preserves a mismatched pin", async () => {
      const Nozzle = (await import("@/models/Nozzle")).default;
      const n4 = await Nozzle.create({ name: "Ini 0.4", diameter: 0.4, type: "Brass" });
      await Filament.create({
        name: "Ini Legacy PLA",
        vendor: "Acme",
        type: "PLA",
        compatibleNozzles: [n4._id],
      });
      // A pre-upgrade INI export of this filament carries the stamped
      // machine-derived condition — re-importing must NOT re-persist it.
      const outcome = await upsertIniFilament({
        ...section("Ini Legacy PLA"),
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4", cooling: "1" },
      });
      expect(outcome).toBe("updated");
      const fresh = await Filament.findOne({ name: "Ini Legacy PLA" }).lean();
      expect(fresh!.settings?.compatible_printers_condition).toBe("");
      expect(fresh!.settings?.cooling).toBe("1");

      // A pure nozzle pin that does NOT match the ticks is user input — kept.
      const outcome2 = await upsertIniFilament({
        ...section("Ini Legacy PLA"),
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.8" },
      });
      expect(outcome2).toBe("updated");
      const fresh2 = await Filament.findOne({ name: "Ini Legacy PLA" }).lean();
      expect(fresh2!.settings?.compatible_printers_condition).toBe("nozzle_diameter[0]==0.8");
    });

    it("never mutates the caller's section object (r15: phase fallbacks must not inherit a strip)", async () => {
      const Nozzle = (await import("@/models/Nozzle")).default;
      const n6 = await Nozzle.create({ name: "Ini 0.6", diameter: 0.6, type: "Brass" });
      await Filament.create({
        name: "Ini Mut PLA",
        vendor: "Acme",
        type: "PLA",
        compatibleNozzles: [n6._id],
      });
      const input = {
        ...section("Ini Mut PLA"),
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.6" },
      };
      const outcome = await upsertIniFilament(input);
      expect(outcome).toBe("updated");
      const fresh = await Filament.findOne({ name: "Ini Mut PLA" }).lean();
      expect(fresh!.settings?.compatible_printers_condition).toBe(""); // stripped in the WRITE…
      // …but the caller's payload is untouched — a fallback phase (or the
      // create path) re-judges against ITS OWN target, not this row's ticks.
      expect(input.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.6");
    });
  });

  describe("leave-when-omitted temps + inherits (GH #1008 F3)", () => {
    /** Parse a raw INI through the actual import pipeline (parse → collapse). */
    const collapse = (ini: string) => collapsePerNozzleImportSections(parseIniFilaments(ini));

    it("a section with NO temp keys and NO inherits preserves all four stored temps + inherits", async () => {
      const existing = await Filament.create({
        name: "Prusament PLA",
        vendor: "Prusa",
        type: "PLA",
        temperatures: { nozzle: 215, nozzleFirstLayer: 220, bed: 60, bedFirstLayer: 65 },
        inherits: "Prusament PLA @MK4S",
      });
      // The realistic PrusaSlicer user-preset shape: only the diverged key(s).
      const [section] = collapse(
        `[filament:Prusament PLA]\nfilament_retract_length = 1.2\n`,
      );
      expect(await upsertIniFilament(section)).toBe("updated");
      const fresh = await Filament.findById(existing._id).lean();
      expect(fresh.temperatures.nozzle).toBe(215);
      expect(fresh.temperatures.nozzleFirstLayer).toBe(220);
      expect(fresh.temperatures.bed).toBe(60);
      expect(fresh.temperatures.bedFirstLayer).toBe(65);
      expect(fresh.inherits).toBe("Prusament PLA @MK4S");
      expect(fresh.settings.filament_retract_length).toBe("1.2"); // the diverged key landed
    });

    it("a PARTIAL temp section updates only the supplied subfield; siblings + inherits survive", async () => {
      const existing = await Filament.create({
        name: "Partial PLA",
        vendor: "Prusa",
        type: "PLA",
        temperatures: { nozzle: 215, bed: 60 },
        inherits: "*PLA*",
      });
      const [section] = collapse(`[filament:Partial PLA]\ntemperature = 230\n`);
      expect(await upsertIniFilament(section)).toBe("updated");
      const fresh = await Filament.findById(existing._id).lean();
      expect(fresh.temperatures.nozzle).toBe(230); // supplied → updated
      expect(fresh.temperatures.bed).toBe(60); // omitted → survives
      expect(fresh.inherits).toBe("*PLA*"); // omitted → survives
    });

    it("an explicit `inherits = nil` still clears the stored inherits (deliberate reset writes through)", async () => {
      const existing = await Filament.create({
        name: "NilInherits PLA",
        vendor: "Prusa",
        type: "PLA",
        inherits: "*PLA*",
      });
      const [section] = collapse(`[filament:NilInherits PLA]\ninherits = nil\n`);
      expect(await upsertIniFilament(section)).toBe("updated");
      const fresh = await Filament.findById(existing._id).lean();
      expect(fresh.inherits ?? null).toBeNull();
    });
  });

  // ── GH #1073: the phase-2 resurrect runs the shared first-variant adoption
  //    gate. A trashed VARIANT makes hasVariants read false, so its parent may
  //    legitimately have re-acquired inventory as a standalone — a bare
  //    resurrect would strand that inventory on a template with no
  //    confirmation. ───────────────────────────────────────────────────────
  describe("phase-2 resurrect adoption gate (GH #1073)", () => {
    /** Parent + trashed variant fixture. The variant is created live (direct
     *  model write — no route gate involved) and then soft-deleted. */
    async function trashedVariant(
      parentDoc: Record<string, unknown>,
      variantName: string,
    ) {
      const parent = await Filament.create(parentDoc);
      const variant = await Filament.create({
        name: variantName,
        vendor: "Acme",
        type: "PLA",
        parentId: parent._id,
      });
      await Filament.updateOne(
        { _id: variant._id },
        { $set: { _deletedAt: new Date() } },
      );
      return { parent, variant };
    }

    it("gates the resurrect of a trashed variant whose active parent holds a spool — row errors, nothing mutated", async () => {
      const { parent, variant } = await trashedVariant(
        {
          name: "Regrown INI Parent",
          vendor: "Acme",
          type: "PLA",
          color: null,
          spools: [{ label: "new roll", totalWeight: 900 }],
        },
        "Trashed INI Variant",
      );

      await expect(upsertIniFilament(section("Trashed INI Variant"))).rejects.toThrow(
        /still holds its own inventory/,
      );

      // The variant stays trashed; the parent is untouched (spools intact,
      // still no live variants).
      const freshVariant = await Filament.findById(variant._id).lean();
      expect(freshVariant._deletedAt).not.toBeNull();
      const freshParent = await Filament.findById(parent._id).lean();
      expect(freshParent.spools).toHaveLength(1);
      expect(freshParent.spools[0].label).toBe("new roll");
    });

    it("a no-inventory parent lets the resurrect proceed", async () => {
      const { parent, variant } = await trashedVariant(
        {
          name: "Clean INI Parent",
          vendor: "Acme",
          type: "PLA",
          color: null,
        },
        "Revivable INI Variant",
      );

      expect(await upsertIniFilament(section("Revivable INI Variant"))).toBe("updated");

      const freshVariant = await Filament.findById(variant._id).lean();
      expect(freshVariant._deletedAt ?? null).toBeNull();
      expect(String(freshVariant.parentId)).toBe(String(parent._id));
    });

    it("resurrecting the first variant of a threshold-ONLY parent clears the dead threshold (after the write)", async () => {
      const { parent, variant } = await trashedVariant(
        {
          name: "Threshold INI Parent",
          vendor: "Acme",
          type: "PLA",
          color: null,
          lowStockThreshold: 100,
        },
        "Threshold INI Variant",
      );

      expect(await upsertIniFilament(section("Threshold INI Variant"))).toBe("updated");

      const freshVariant = await Filament.findById(variant._id).lean();
      expect(freshVariant._deletedAt ?? null).toBeNull();
      // The parent is a template now — the leftover alarm is dead config and
      // was cleared AFTER the write (round 7 P2 parity with the CSV importer).
      const freshParent = await Filament.findById(parent._id).lean();
      expect(freshParent.lowStockThreshold ?? null).toBeNull();
    });

    it("a SECOND variant's resurrect under a spool-holding legacy template proceeds (nothing left to gate)", async () => {
      const { parent, variant } = await trashedVariant(
        {
          name: "Legacy INI Template",
          vendor: "Acme",
          type: "PLA",
          spools: [{ label: "legacy roll", totalWeight: 500 }],
        },
        "Second INI Variant",
      );
      // A sibling variant is still LIVE, so the parent is already a template —
      // the enforce-forward legacy shape stays untouched and nothing gates.
      await Filament.create({
        name: "Live INI Sibling",
        vendor: "Acme",
        type: "PLA",
        parentId: parent._id,
      });

      expect(await upsertIniFilament(section("Second INI Variant"))).toBe("updated");
      const freshVariant = await Filament.findById(variant._id).lean();
      expect(freshVariant._deletedAt ?? null).toBeNull();
    });
  });
});

/**
 * GH #1116 (Codex P1, round 24). `trimEntityNames` can leave a raw untrimmed
 * row behind — a skipped collection, or a row whose trim would collide. The
 * INI importer then cannot see it (the `trim: true` setter casts the query),
 * falls through all three phases, and CREATES a second active filament that
 * renders identically to the one it failed to find.
 *
 * Two halves have to work, and the second is easy to miss: fixing only the
 * LOOKUP leaves the fix completely inert, because the phase-1 write filter
 * re-pins `name` (the GH #951 rename guard) and that clause is cast too — so
 * the by-`_id` update would miss and fall through to the create anyway.
 */
describe("upsertIniFilament — a surviving untrimmed row (GH #1116)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
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

  it("updates the survivor in place instead of creating a twin", async () => {
    // Raw driver on purpose — a Mongoose create would trim it.
    await Filament.collection.insertOne({
      name: "Survivor PLA ",
      vendor: "Acme",
      type: "PLA",
      cost: 1,
      _deletedAt: null,
      spools: [],
    });

    const outcome = await upsertIniFilament(section("Survivor PLA"));
    expect(outcome).toBe("updated");

    // One row, not two — and the write landed on the row that was there.
    const rows = await Filament.collection.find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBe(25);
    // The update also normalizes the stored name, because `name` rides the
    // $set and the setter trims it on the way in.
    expect(rows[0].name).toBe("Survivor PLA");
  });

  it("resurrects a surviving untrimmed TRASHED row rather than stranding it", async () => {
    // Left behind, this strands the tombstone: the new active row owns the
    // name, so the trashed row's restore 409s forever (GH #297).
    await Filament.collection.insertOne({
      name: "Trashed Survivor ",
      vendor: "Acme",
      type: "PLA",
      cost: 1,
      _deletedAt: new Date(),
      spools: [],
    });

    const outcome = await upsertIniFilament(section("Trashed Survivor"));
    expect(outcome).toBe("updated");

    const rows = await Filament.collection.find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]._deletedAt).toBeNull();
    expect(rows[0].name).toBe("Trashed Survivor");
  });
});

/**
 * GH #1116 (Codex P1). Accepting a trim-equal id/name pair and then
 * re-resolving by NAME sends the update to the wrong row: with an active
 * "PLA" and a survivor "PLA ", an exported INI carrying the SURVIVOR's
 * `filamentdb_id` passes the guard, and the canonical-first query then selects
 * "PLA" — writing the survivor's settings onto the canonical bystander.
 */
describe("upsertIniFilament — an id-selected survivor keeps the update (GH #1116)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
    await Filament.collection.deleteMany({});
  });

  const section = (name: string, filamentdbId?: string): CollapsedFilamentData => ({
    name,
    vendor: "Acme",
    type: "PLA",
    color: "#808080",
    cost: 77,
    density: 1.24,
    diameter: 1.75,
    temperatures: { nozzle: 210, nozzleFirstLayer: null, bed: 60, bedFirstLayer: null },
    maxVolumetricSpeed: null,
    inherits: null,
    settings: {},
    ...(filamentdbId ? { filamentdbId } : {}),
  });

  it("writes to the row the id names, not the canonical twin", async () => {
    const canonical = await Filament.collection.insertOne({
      name: "PLA", vendor: "Acme", type: "PLA", cost: 1,
      instanceId: "wsini001", _deletedAt: null, spools: [], settings: {},
    });
    const survivor = await Filament.collection.insertOne({
      name: "PLA ", vendor: "Acme", type: "PLA", cost: 2,
      instanceId: "wsini002", _deletedAt: null, spools: [], settings: {},
    });

    const outcome = await upsertIniFilament(
      section("PLA", String(survivor.insertedId)),
    );
    expect(outcome).toBe("updated");

    // The survivor got the settings...
    const s2 = await Filament.collection.findOne({ _id: survivor.insertedId });
    expect(s2!.cost).toBe(77);
    // ...and the bystander is untouched. That is the whole point.
    const c2 = await Filament.collection.findOne({ _id: canonical.insertedId });
    expect(c2!.cost).toBe(1);
    expect(c2!.name).toBe("PLA");
  });
});
