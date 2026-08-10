import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { upsertImportRows } from "@/lib/importFilaments";
import { trimEntityNames, type MinimalTrimDb } from "@/lib/trimEntityNames";

/**
 * GH #1116 — a name is an identity key, so edge whitespace must not survive.
 *
 * `Drybox #1 ` and `Drybox #1` were two distinct rows that render identically
 * everywhere in the app, and the CSV round-trip manufactured the second one.
 * These tests pin the three halves of the fix that need a real database: the
 * schema setter, the migration that repairs what is already stored, and the
 * importer's trimmed matching key.
 */
describe("entity names are trimmed on write (#1116)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Location: any;
  let Filament: any;
  let Nozzle: any;
  let Printer: any;
  let BedType: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    for (const [name, mod] of [
      ["Filament", await import("@/models/Filament")],
      ["Location", await import("@/models/Location")],
      ["Nozzle", await import("@/models/Nozzle")],
      ["Printer", await import("@/models/Printer")],
      ["BedType", await import("@/models/BedType")],
    ] as const) {
      if (!mongoose.models[name]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mongoose.model(name, (mod as any).default.schema);
      }
    }
    Location = mongoose.models.Location;
    Filament = mongoose.models.Filament;
    Nozzle = mongoose.models.Nozzle;
    Printer = mongoose.models.Printer;
    BedType = mongoose.models.BedType;
  });

  it("trims on create, across all five uniquely-named models", async () => {
    const loc = await Location.create({ name: "Drybox #1 ", kind: "drybox" });
    expect(loc.name).toBe("Drybox #1");
    const fil = await Filament.create({ name: " PLA Basic", vendor: "V", type: "PLA" });
    expect(fil.name).toBe("PLA Basic");
    const noz = await Nozzle.create({ name: "0.4 Brass\t", diameter: 0.4, type: "Brass" });
    expect(noz.name).toBe("0.4 Brass");
    const prn = await Printer.create({
      name: " MK4 ",
      manufacturer: "Prusa",
      printerModel: "MK4",
    });
    expect(prn.name).toBe("MK4");
    const bed = await BedType.create({ name: "Textured PEI ", material: "PEI" });
    expect(bed.name).toBe("Textured PEI");
  });

  it("trims on updateOne and findOneAndUpdate too", async () => {
    const loc = await Location.create({ name: "Shelf", kind: "shelf" });
    await Location.updateOne({ _id: loc._id }, { $set: { name: "Shelf A " } });
    expect((await Location.findById(loc._id)).name).toBe("Shelf A");
    const after = await Location.findOneAndUpdate(
      { _id: loc._id },
      { $set: { name: "  Shelf B" } },
      { returnDocument: "after" },
    );
    expect(after.name).toBe("Shelf B");
  });

  it("a whitespace-only name is rejected by `required`, not stored as empty", async () => {
    await expect(Location.create({ name: "   ", kind: "shelf" })).rejects.toThrow();
  });
});

describe("trimEntityNames against a real database (#1116)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Location: any;

  beforeEach(async () => {
    const mod = await import("@/models/Location");
    if (!mongoose.models.Location) mongoose.model("Location", mod.default.schema);
    Location = mongoose.models.Location;
  });

  const db = () => mongoose.connection.db as unknown as MinimalTrimDb;

  it("repairs a legacy untrimmed row written past the setter", async () => {
    // The raw driver bypasses Mongoose setters — this is how the state was
    // reached before `trim: true` existed (and how hybrid sync still writes).
    const { insertedId } = await mongoose.connection
      .collection("locations")
      .insertOne({ name: "Drybox #1 ", kind: "drybox", _deletedAt: null });

    const res = await trimEntityNames(db());
    expect(res.conflicts).toEqual([]);
    expect((await Location.findById(insertedId)).name).toBe("Drybox #1");
  });

  it("creates the partial unique index it relies on, when it is missing (Codex P2)", async () => {
    // The pre-write clash check and the write are not atomic, so without the
    // index two concurrent writers can both normalize to the same name — and
    // the later coreModelIndexes pass then refuses to build it at all,
    // leaving the collection with NO uniqueness enforcement.
    await mongoose.connection.collection("locations").dropIndexes().catch(() => {});
    await mongoose.connection
      .collection("locations")
      .insertOne({ name: "Indexed Later ", kind: "drybox", _deletedAt: null });

    await trimEntityNames(db());

    const indexes = await mongoose.connection.collection("locations").indexes();
    expect(
      indexes.some(
        (i) => i.unique && (i.key as Record<string, number>)?.name === 1,
      ),
    ).toBe(true);
    // …and the row was still trimmed.
    expect(await Location.findOne({ name: "Indexed Later" })).not.toBeNull();
  });

  it("accepts a LEGACY plain unique name index instead of skipping (Codex P1)", async () => {
    // A peer upgraded from pre-#303 still carries the plain unique `name_1`.
    // createIndex then refuses with IndexOptionsConflict — but that index is
    // STRICTER than the partial one requested, so the pass is serialized and
    // must carry on. Skipping would be permanent on Atlas, which never runs
    // the syncIndexes() pass that would replace the legacy index.
    await mongoose.connection.collection("locations").dropIndexes().catch(() => {});
    await mongoose.connection.collection("locations").createIndex({ name: 1 }, { unique: true });
    await mongoose.connection
      .collection("locations")
      .insertOne({ name: "Legacy Indexed ", kind: "drybox", _deletedAt: null });

    const res = await trimEntityNames(db());

    expect(res.skipped).toEqual([]);
    expect(await Location.findOne({ name: "Legacy Indexed" })).not.toBeNull();
    // The legacy index is left in place — replacing it is coreModelIndexes' job.
    await mongoose.connection.collection("locations").dropIndexes().catch(() => {});
  });

  it("REFUSES an index that doesn't cover every active row (Codex P1)", async () => {
    // A partial filter narrower than `{_deletedAt: null}` — this one misses
    // legacy rows where the field is absent entirely — leaves precisely the
    // rows being trimmed unserialized, which is the whole hazard.
    await mongoose.connection.collection("locations").dropIndexes().catch(() => {});
    await mongoose.connection
      .collection("locations")
      .createIndex(
        { name: 1 },
        { unique: true, partialFilterExpression: { _deletedAt: { $exists: true } } },
      );
    await mongoose.connection
      .collection("locations")
      .insertOne({ name: "Narrow Filter ", kind: "drybox", _deletedAt: null });

    const res = await trimEntityNames(db());

    expect(res.skipped.map((s) => s.collection)).toContain("locations");
    // Untouched — writing unserialized is what this refuses to do.
    const raw = await mongoose.connection
      .collection("locations")
      .findOne({ name: "Narrow Filter " });
    expect(raw).not.toBeNull();
    await mongoose.connection.collection("locations").dropIndexes().catch(() => {});
  });

  it("leaves a colliding pair alone and names it", async () => {
    await Location.create({ name: "Drybox #1", kind: "drybox" });
    await mongoose.connection
      .collection("locations")
      .insertOne({ name: "Drybox #1 ", kind: "drybox", _deletedAt: null });

    // The partial unique index has to exist for the collision to surface as
    // E11000 — the pass builds it itself now, and dbConnect's
    // coreModelIndexes pass also does in production.
    // Built with the DRIVER rather than `syncIndexes()`: tests/setup.ts DROPS
    // every collection between tests, which takes its indexes with it, and
    // Mongoose's index-state machinery made rebuilding it order-dependent
    // enough to fail only under a loaded full-suite run. A direct createIndex
    // resolves when the index exists, full stop.
    await mongoose.connection
      .collection("locations")
      .createIndex(
        { name: 1 },
        { unique: true, partialFilterExpression: { _deletedAt: null } },
      );
    // Precondition, so a future failure here says WHY rather than just
    // reporting the wrong count two lines down.
    const indexes = await mongoose.connection.collection("locations").indexes();
    expect(indexes.some((i) => i.unique && i.key?.name === 1)).toBe(true);

    const res = await trimEntityNames(db());
    expect(res.trimmed).toBe(0);
    expect(res.conflicts).toEqual([
      // `active` distinguishes a conflict that can actually make two hybrid
      // peers disagree about identity from a permanent, harmless one on a
      // tombstone — only the former gates a sync (GH #1116, Codex P1).
      { collection: "locations", name: "Drybox #1 ", active: true },
    ]);
    // Both rows still exist — visible and editable, not silently merged.
    expect(await Location.countDocuments({})).toBe(2);
  });
});

describe("filament import matches a legacy untrimmed row (#1116)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", mod.default.schema);
    Filament = mongoose.models.Filament;
  });

  it("UPDATES the stored row instead of creating a near-identical duplicate", async () => {
    // Legacy state: stored untrimmed (written past the setter), and the export
    // now QUOTES it, so the row arrives with its whitespace intact.
    await mongoose.connection.collection("filaments").insertOne({
      name: "PLA Basic ",
      vendor: "V",
      type: "PLA",
      _deletedAt: null,
      spools: [],
    });

    const result = await upsertImportRows([
      { name: "PLA Basic ", vendor: "V", type: "PLA", cost: 25 },
    ]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(await Filament.countDocuments({})).toBe(1);
  });

  it("does not CREATE a duplicate when the untrimmed row survived the migration (Codex P1)", async () => {
    // Reaching this state takes care: `upsertImportRows` calls dbConnect,
    // whose trim pass would normally repair the row before the import runs.
    // The reachable survival route is a SKIPPED collection — no adequate
    // unique name index, so the pass deliberately writes nothing. A plain
    // NON-unique index on `name` produces exactly that: createIndex conflicts
    // on the options, and the existing index is not unique, so the pass
    // refuses to write unserialized.
    //
    // Such a row is invisible to every Mongoose query, because a String
    // schema setter applies to QUERY values too. Without the raw-driver
    // load the import creates a SECOND record beside it — the duplicate this
    // whole change exists to stop.
    await mongoose.connection.collection("filaments").dropIndexes().catch(() => {});
    await mongoose.connection.collection("filaments").createIndex({ name: 1 });
    await mongoose.connection.collection("filaments").insertOne({
      name: "PLA Legacy ", vendor: "V", type: "PLA", _deletedAt: null, spools: [], cost: 1,
    });

    const result = await upsertImportRows([
      { name: "PLA Legacy ", vendor: "V", type: "PLA", cost: 42 },
    ]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(await Filament.countDocuments({})).toBe(1);
    // Better than merely avoiding the duplicate: the update goes through the
    // schema setter, so finding the row also REPAIRS its name — the thing the
    // migration couldn't do without a serializing index.
    const raw = await mongoose.connection
      .collection("filaments")
      .findOne({ name: "PLA Legacy" });
    expect(raw).not.toBeNull();
    expect(raw!.cost).toBe(42);
    await mongoose.connection.collection("filaments").dropIndexes().catch(() => {});
  });

  it("matches a surviving legacy row even when the IMPORT name is canonical (Codex P1)", async () => {
    // The predicate has to be on the STORED value. Keying it on the input's
    // spelling missed the ordinary case: importing a canonical "PLA Canon"
    // against a surviving "PLA Canon " produced no candidates at all, and the
    // importer created a second row beside it.
    await mongoose.connection.collection("filaments").dropIndexes().catch(() => {});
    await mongoose.connection.collection("filaments").createIndex({ name: 1 });
    await mongoose.connection.collection("filaments").insertOne({
      name: "PLA Canon ", vendor: "V", type: "PLA", _deletedAt: null, spools: [], cost: 1,
    });

    const result = await upsertImportRows([
      { name: "PLA Canon", vendor: "V", type: "PLA", cost: 42 },
    ]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(await Filament.countDocuments({})).toBe(1);
    await mongoose.connection.collection("filaments").dropIndexes().catch(() => {});
  });

  it("matches across DIFFERENT edge whitespace on the two sides", async () => {
    await mongoose.connection.collection("filaments").dropIndexes().catch(() => {});
    await mongoose.connection.collection("filaments").createIndex({ name: 1 });
    await mongoose.connection.collection("filaments").insertOne({
      name: "  PLA Both", vendor: "V", type: "PLA", _deletedAt: null, spools: [], cost: 1,
    });

    const result = await upsertImportRows([
      { name: "PLA Both  ", vendor: "V", type: "PLA", cost: 7 },
    ]);

    expect(result.created).toBe(0);
    expect(await Filament.countDocuments({})).toBe(1);
    await mongoose.connection.collection("filaments").dropIndexes().catch(() => {});
  });

  it("a whitespace-only name is reported as a missing required field", async () => {
    const result = await upsertImportRows([
      { name: "   ", vendor: "V", type: "PLA" },
    ]);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows?.[0].reason).toContain("Missing required field");
  });

  it("still creates a genuinely new row", async () => {
    const result = await upsertImportRows([
      { name: "Fresh PLA ", vendor: "V", type: "PLA" },
    ]);
    expect(result.created).toBe(1);
    expect(await Filament.findOne({ name: "Fresh PLA" })).not.toBeNull();
  });
});
