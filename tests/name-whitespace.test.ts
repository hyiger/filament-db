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

  it("leaves a colliding pair alone and names it", async () => {
    await Location.create({ name: "Drybox #1", kind: "drybox" });
    await mongoose.connection
      .collection("locations")
      .insertOne({ name: "Drybox #1 ", kind: "drybox", _deletedAt: null });

    // The partial unique index has to exist for the collision to surface as
    // E11000 — dbConnect's coreModelIndexes pass builds it in production.
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
      { collection: "locations", name: "Drybox #1 " },
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
