import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
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
  /**
   * Reach the condition the raw-driver fallback exists for: an untrimmed row
   * present at import time.
   *
   * Doing that by index manipulation does not work. Mongoose's `autoIndex`
   * rebuilds the schema's unique `name_1` in the BACKGROUND on first model
   * use, so a plain index planted here races that build — locally about half
   * the runs, and it was a real CI failure (IndexKeySpecsConflict, because
   * MongoDB auto-names both indexes `name_1`).
   *
   * So settle the migration instead: one no-op import flips
   * `cached.migrations.trimEntityNames`, after which the pass does not run
   * again in this process and a row inserted through the raw driver survives
   * untrimmed. That models the production states that matter — a row the pass
   * had to leave alone, or a collection it skipped — without depending on
   * which one, and without fighting autoIndex.
   */
  async function settleTrimMigration() {
    await upsertImportRows([
      { name: "Settle Probe", vendor: "V", type: "PLA" },
    ]);
    await Filament.deleteMany({ name: "Settle Probe" });
  }

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
    await settleTrimMigration();
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
  });

  it("matches a surviving legacy row even when the IMPORT name is canonical (Codex P1)", async () => {
    // The predicate has to be on the STORED value. Keying it on the input's
    // spelling missed the ordinary case: importing a canonical "PLA Canon"
    // against a surviving "PLA Canon " produced no candidates at all, and the
    // importer created a second row beside it.
    await settleTrimMigration();
    await mongoose.connection.collection("filaments").insertOne({
      name: "PLA Canon ", vendor: "V", type: "PLA", _deletedAt: null, spools: [], cost: 1,
    });

    const result = await upsertImportRows([
      { name: "PLA Canon", vendor: "V", type: "PLA", cost: 42 },
    ]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(await Filament.countDocuments({})).toBe(1);
  });

  it("matches across DIFFERENT edge whitespace on the two sides", async () => {
    await settleTrimMigration();
    await mongoose.connection.collection("filaments").insertOne({
      name: "  PLA Both", vendor: "V", type: "PLA", _deletedAt: null, spools: [], cost: 1,
    });

    const result = await upsertImportRows([
      { name: "PLA Both  ", vendor: "V", type: "PLA", cost: 7 },
    ]);

    expect(result.created).toBe(0);
    expect(await Filament.countDocuments({})).toBe(1);
  });

  it("scans when the indexed lookup found only a TOMBSTONE (Codex P2)", async () => {
    // With the collection skipped, an active "PLA Ghost " can coexist with a
    // soft-deleted "PLA Ghost". Counting the tombstone as "found" skipped the
    // scan, so the importer resurrected the tombstone and left TWO active
    // rows rendering identically.
    await settleTrimMigration();
    await mongoose.connection.collection("filaments").insertMany([
      { name: "PLA Ghost", vendor: "V", type: "PLA", _deletedAt: new Date(), spools: [], cost: 1 },
      { name: "PLA Ghost ", vendor: "V", type: "PLA", _deletedAt: null, spools: [], cost: 2 },
    ]);

    const result = await upsertImportRows([
      { name: "PLA Ghost", vendor: "V", type: "PLA", cost: 42 },
    ]);

    expect(result.created).toBe(0);
    // Exactly one ACTIVE row, and it is the one that was already active.
    expect(await Filament.countDocuments({ _deletedAt: null })).toBe(1);
    const active = await Filament.findOne({ _deletedAt: null });
    expect(active.cost).toBe(42);
  });

  it("matches a name whose whitespace only JS trim() strips (Codex P2)", async () => {
    // MongoDB's $trim default set is ASCII; it does not strip U+FEFF, which
    // String.prototype.trim does — and the schema setter uses the latter.
    await settleTrimMigration();
    await mongoose.connection.collection("filaments").insertOne({
      name: "PLA Bom\uFEFF", vendor: "V", type: "PLA", _deletedAt: null, spools: [], cost: 1,
    });

    const result = await upsertImportRows([
      { name: "PLA Bom", vendor: "V", type: "PLA", cost: 42 },
    ]);

    expect(result.created).toBe(0);
    expect(await Filament.countDocuments({ _deletedAt: null })).toBe(1);
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

  /**
   * GH #1116 (Codex P2, round 22): a peer upgraded from the pre-#303 schema
   * still carries the LEGACY plain unique `name_1`, which covers DELETED rows
   * too. Two trashed rows named "X" and "X " are perfectly legal under the
   * partial index this repo intends, but collide under that one.
   *
   * The conflict is classified INACTIVE (no active row is involved) and
   * inactive conflicts deliberately do not block — so the migration SETTLED on
   * it. `coreModelIndexes` then replaces the legacy index later in the same
   * connect, making the write safe, but nothing retried: the tombstone stayed
   * untrimmed forever, and restoring it (which only touches `_deletedAt`) made
   * an untrimmed name ACTIVE and unreachable through Mongoose name queries —
   * GH #1116 itself, on a database that had reported the migration complete.
   */
  it("defers a trim that only the legacy plain unique index blocks", async () => {
    const db = () => mongoose.connection.db as unknown as MinimalTrimDb;
    const col = mongoose.connection.collection("locations");
    // Stand up the LEGACY index: plain unique, no partial filter.
    await col.dropIndexes().catch(() => {});
    await col.createIndex({ name: 1 }, { unique: true, name: "legacy_name_1" });

    const deletedAt = new Date();
    await col.insertMany([
      { name: "Shelf", kind: "shelf", _deletedAt: deletedAt },
      { name: "Shelf ", kind: "shelf", _deletedAt: deletedAt },
    ]);

    const res = await trimEntityNames(db());

    // The row could not be trimmed...
    const stillUntrimmed = await col.findOne({ name: "Shelf " });
    expect(stillUntrimmed).not.toBeNull();
    // ...and that MUST be reported as retryable, not settled. Both halves
    // matter: `active` stays false (nothing for a human to fix), while
    // `deferred` is what keeps the caller from marking the migration done.
    expect(res.conflicts.some((c) => c.active)).toBe(false);
    expect(res.deferred.length).toBeGreaterThan(0);
    expect(res.deferred[0].collection).toBe("locations");

    // Once the intended partial index is in place the identical pass succeeds,
    // which is exactly why settling on it was wrong.
    await col.dropIndex("legacy_name_1");
    await col.createIndex(
      { name: 1 },
      { unique: true, partialFilterExpression: { _deletedAt: null } },
    );
    const after = await trimEntityNames(db());
    expect(after.deferred.length).toBe(0);
    expect(await col.findOne({ name: "Shelf " })).toBeNull();
    expect(await col.countDocuments({ name: "Shelf" })).toBe(2);
  });

  /**
   * GH #1116 (Codex P2, round 27). The deferred test asks about INDEX
   * COVERAGE, not schema activeness, and the two disagree on exactly one
   * value: `_deletedAt: ""`.
   *
   * Mongoose casts an empty string to null on a Date path, so the schema calls
   * such a row active. MongoDB does not — a partial filter of
   * `{ _deletedAt: null }` matches null and missing only, so a stored `""` sits
   * OUTSIDE the partial index. A duplicate key on it can therefore only have
   * come from the legacy plain index, which is the retryable case; classifying
   * it as a real conflict let the migration settle and stranded the row.
   */
  it("defers an empty-string tombstone the legacy index blocks", async () => {
    const db = () => mongoose.connection.db as unknown as MinimalTrimDb;
    const col = mongoose.connection.collection("locations");
    await col.dropIndexes().catch(() => {});
    await col.createIndex({ name: 1 }, { unique: true, name: "legacy_name_1" });

    // `_deletedAt: ""` — the legacy shape. Schema-active, index-uncovered.
    await col.insertMany([
      { name: "Bin", kind: "shelf", _deletedAt: "" },
      { name: "Bin ", kind: "shelf", _deletedAt: "" },
    ]);

    const res = await trimEntityNames(db());

    expect(await col.findOne({ name: "Bin " })).not.toBeNull();
    expect(res.deferred.length).toBeGreaterThan(0);
    expect(res.deferred[0].collection).toBe("locations");

    await col.dropIndex("legacy_name_1");
    await col.createIndex(
      { name: 1 },
      { unique: true, partialFilterExpression: { _deletedAt: null } },
    );
    const after = await trimEntityNames(db());
    expect(after.deferred.length).toBe(0);
    expect(await col.findOne({ name: "Bin " })).toBeNull();
  });
});

/**
 * GH #1116 (Codex round 29) — the WRONG-MATCH and MISSED-COLLISION hazards.
 *
 * Three distinct ways the cast bites, and the earlier work only covered the
 * first:
 *   (A) a MISS then a create  -> a duplicate                (survivor fallback)
 *   (B) a MISS in a GUARD     -> the guard wrongly permits  (survivor fallback)
 *   (C) a WRONG MATCH         -> the wrong row is used      (exact-spelling)
 *
 * "Read-only" was never a valid exemption for (C): reading the wrong row hands
 * back another filament's data. "Refuses, never creates" was never valid for
 * (B): failing to refuse is exactly how the guard creates a duplicate.
 */
describe("wrong-match and missed-collision hazards (#1116)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
    await Filament.collection.deleteMany({});
  });

  async function seedBothSpellings() {
    const canonical = await Filament.collection.insertOne({
      name: "Amb PLA", vendor: "V", type: "PLA", cost: 1,
      _deletedAt: null, spools: [], settings: {},
    });
    const raw = await Filament.collection.insertOne({
      name: "Amb PLA ", vendor: "V", type: "PLA", cost: 2,
      _deletedAt: null, spools: [], settings: {},
    });
    return { canonicalId: canonical.insertedId, rawId: raw.insertedId };
  }

  it("(C) matchFilament returns the row actually named, not the canonical one", async () => {
    const { rawId } = await seedBothSpellings();
    const { matchFilament } = await import("@/lib/matchFilament");

    const res = await matchFilament({ name: "Amb PLA " });
    // A confident match, and the RIGHT one — an NFC scan must not
    // auto-associate the tag with a different filament.
    expect(res.match).not.toBeNull();
    expect(String((res.match as { _id: unknown })._id)).toBe(String(rawId));
  });

  it("(C) a single-filament export exports the row that was addressed", async () => {
    const { rawId } = await seedBothSpellings();
    const { resolveFilamentForExport } = await import("@/lib/singleFilamentExport");

    const doc = await resolveFilamentForExport("Amb PLA ");
    expect(doc).not.toBeNull();
    expect(String(doc!._id)).toBe(String(rawId));
  });

  it("(B) a rename onto a surviving untrimmed name is REFUSED", async () => {
    const { rawId } = await seedBothSpellings();
    const other = await Filament.create({ name: "Other PLA", vendor: "V", type: "PLA" });
    const { PUT } = await import("@/app/api/filaments/[id]/route");

    const res = await PUT(
      new NextRequest(`http://localhost/api/filaments/${other._id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Amb PLA" }),
      }),
      { params: Promise.resolve({ id: String(other._id) }) },
    );

    // Without the survivor check this returned 200 and left TWO active rows
    // rendering as "Amb PLA" — the raw index strings differ, so no E11000.
    expect(res.status).toBe(409);
    // And nothing was renamed.
    expect((await Filament.collection.findOne({ _id: other._id }))!.name).toBe("Other PLA");
    expect((await Filament.collection.findOne({ _id: rawId }))!.name).toBe("Amb PLA ");
  });

  it("(B) a reparent+rename onto a survivor 409s BEFORE promoting the parent", async () => {
    // Fail-fast before the irreversible bit. A confirmed reparent that also
    // renames onto a surviving untrimmed name must not promote the carrying
    // parent — moving its color and spools onto a new variant — and only then
    // report failure.
    // ONLY the survivor — no canonical row. With both present the ordinary
    // cast check finds the canonical one and the survivor path is never
    // exercised, which is exactly how the first version of this test passed
    // against the unfixed code.
    await Filament.collection.insertOne({
      name: "Amb PLA ", vendor: "V", type: "PLA", cost: 2,
      _deletedAt: null, spools: [], settings: {},
    });
    // A LEGACY carrying parent: has its own color and a spool, no variants yet.
    const parent = await Filament.create({
      name: "Carrier PLA", vendor: "V", type: "PLA", color: "#123456",
      spools: [{ totalWeight: 1000 }],
    });
    const target = await Filament.create({ name: "Target PLA", vendor: "V", type: "PLA" });
    const { PUT } = await import("@/app/api/filaments/[id]/route");

    const res = await PUT(
      new NextRequest(`http://localhost/api/filaments/${target._id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Amb PLA",            // collides with the survivor "Amb PLA "
          parentId: String(parent._id),
          promoteParent: true,        // confirmed — the gate WOULD promote
        }),
      }),
      { params: Promise.resolve({ id: String(target._id) }) },
    );

    expect(res.status).toBe(409);
    // The parent is completely untouched — no promotion happened.
    const fresh = await Filament.collection.findOne({ _id: parent._id });
    expect(fresh!.color).toBe("#123456");
    expect(fresh!.spools).toHaveLength(1);
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
  });
});

/**
 * GH #1116 (Codex P1, round 31) — the ordinary CRUD writes.
 *
 * These leaned entirely on the partial unique index to reject a duplicate
 * name. That stops working against a survivor: the index compares RAW stored
 * strings, so "Drybox" and a surviving "Drybox " are two different keys and
 * the write succeeds. Before `trim: true` the submitted spelling reached the
 * index unchanged and collided as the user expected; now it is cast first and
 * the collision evaporates.
 */
describe("ordinary CRUD refuses a name that already exists untrimmed (#1116)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Location: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    for (const [name, mod] of [
      ["Location", await import("@/models/Location")],
    ] as const) {
      if (!mongoose.models[name]) {
        mongoose.model(name, (mod as { default: { schema: mongoose.Schema } }).default.schema);
      }
    }
    Location = mongoose.models.Location;
    await Location.collection.deleteMany({});
  });

  it("POST refuses to create beside a surviving untrimmed row", async () => {
    await Location.collection.insertOne({
      name: "Drybox ", kind: "drybox", _deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const { POST } = await import("@/app/api/locations/route");

    const res = await POST(
      new NextRequest("http://localhost/api/locations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Drybox", kind: "drybox" }),
      }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/i);
    expect(await Location.collection.countDocuments({})).toBe(1);
  });

  it("PUT refuses to rename onto a surviving untrimmed row", async () => {
    await Location.collection.insertOne({
      name: "Drybox ", kind: "drybox", _deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const other = await Location.create({ name: "Shelf", kind: "shelf" });
    const { PUT } = await import("@/app/api/locations/[id]/route");

    const res = await PUT(
      new NextRequest(`http://localhost/api/locations/${other._id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Drybox" }),
      }),
      { params: Promise.resolve({ id: String(other._id) }) },
    );

    expect(res.status).toBe(409);
    expect((await Location.collection.findOne({ _id: other._id }))!.name).toBe("Shelf");
  });

  it("a no-op save that echoes the row's OWN name still succeeds", async () => {
    // Self-exclusion: the guard must not 409 the ordinary form echo.
    const loc = await Location.create({ name: "Shelf", kind: "shelf" });
    const { PUT } = await import("@/app/api/locations/[id]/route");
    const res = await PUT(
      new NextRequest(`http://localhost/api/locations/${loc._id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Shelf", notes: "touched" }),
      }),
      { params: Promise.resolve({ id: String(loc._id) }) },
    );
    expect(res.status).toBe(200);
  });
});
