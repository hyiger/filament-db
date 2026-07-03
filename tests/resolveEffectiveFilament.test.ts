import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { resolveEffectiveFilament } from "@/lib/resolveEffectiveFilament";

/**
 * DB-backed tests for `resolveEffectiveFilament` (GH #607).
 *
 * The function loads the parent via the Filament model, so it needs the
 * mongodb-memory-server from tests/setup.ts. The setup wipes `mongoose.models`
 * between tests, so the schema is re-registered in `beforeEach` (mirrors the
 * pattern in tests/opt-resync-route.test.ts).
 *
 * Coverage focus: the line-42 branch — a variant whose `parentId` resolves to
 * NO loadable parent (soft-deleted or missing) falls back to
 * `{ effective: <raw doc>, parentEffective: null }`.
 */

describe("resolveEffectiveFilament (GH #607)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  it("returns the raw doc with null parentEffective for a root filament (no parentId)", async () => {
    const root = await Filament.create({
      name: "Root PLA",
      vendor: "Acme",
      type: "PLA",
      density: 1.24,
    });
    const lean = await Filament.findById(root._id).lean();

    const { effective, parentEffective } = await resolveEffectiveFilament(lean);

    // Root: doc returned unchanged, no parent to resolve.
    expect(parentEffective).toBeNull();
    expect(effective).toBe(lean);
    expect((effective as Record<string, unknown>).density).toBe(1.24);
  });

  it("falls back to the raw doc + null parentEffective when the parentId points at NO existing filament (line 42)", async () => {
    // Variant referencing a parentId that was never created.
    const ghostParentId = new mongoose.Types.ObjectId();
    const variant = await Filament.create({
      name: "Orphan Variant",
      vendor: "Acme",
      type: "PLA",
      parentId: ghostParentId,
      density: 2.5,
    });
    const lean = await Filament.findById(variant._id).lean();

    const { effective, parentEffective } = await resolveEffectiveFilament(lean);

    // Parent can't be loaded → no resolution, raw doc returned as-is.
    expect(parentEffective).toBeNull();
    expect(effective).toBe(lean);
    expect((effective as Record<string, unknown>).density).toBe(2.5);
  });

  it("falls back to the raw doc + null parentEffective when the parent is soft-deleted (line 42)", async () => {
    const parent = await Filament.create({
      name: "Soft-deleted Parent",
      vendor: "Acme",
      type: "PLA",
      density: 1.3,
    });
    // Soft-delete the parent — the finder filters on `_deletedAt: null`.
    await Filament.updateOne({ _id: parent._id }, { $set: { _deletedAt: new Date() } });

    const variant = await Filament.create({
      name: "Variant of deleted parent",
      vendor: "Acme",
      type: "PLA",
      parentId: parent._id,
      // density left unset — would inherit if the parent were loadable.
    });
    const lean = await Filament.findById(variant._id).lean();

    const { effective, parentEffective } = await resolveEffectiveFilament(lean);

    // The soft-deleted parent is unreachable, so no inheritance happens.
    expect(parentEffective).toBeNull();
    expect(effective).toBe(lean);
    // The variant's own (unset) density stays null — NOT inherited (1.3).
    expect((effective as Record<string, unknown>).density ?? null).toBeNull();
  });

  it("resolves a variant against a live parent, inheriting unset fields", async () => {
    const parent = await Filament.create({
      name: "Live Parent",
      vendor: "Acme",
      type: "PLA",
      density: 1.24,
      dryingTemperature: 45,
    });
    const variant = await Filament.create({
      name: "Live Variant",
      vendor: "Acme",
      type: "PLA",
      parentId: parent._id,
      // density unset → inherits 1.24; dryingTemperature overridden.
      dryingTemperature: 55,
    });
    const lean = await Filament.findById(variant._id).lean();

    const { effective, parentEffective } = await resolveEffectiveFilament(lean);

    expect(parentEffective).not.toBeNull();
    expect((effective as Record<string, unknown>).density).toBe(1.24); // inherited
    expect((effective as Record<string, unknown>).dryingTemperature).toBe(55); // own value
    // parentEffective carries the parent's own values.
    expect((parentEffective as Record<string, unknown>).density).toBe(1.24);
    expect((parentEffective as Record<string, unknown>).dryingTemperature).toBe(45);
  });

  it("resolves parentEffective recursively when the parent is itself a variant", async () => {
    const grandparent = await Filament.create({
      name: "Grandparent",
      vendor: "Acme",
      type: "PLA",
      density: 1.11,
    });
    const parent = await Filament.create({
      name: "Middle Parent",
      vendor: "Acme",
      type: "PLA",
      parentId: grandparent._id,
      // density unset → parentEffective should inherit 1.11 from grandparent.
    });
    const variant = await Filament.create({
      name: "Leaf Variant",
      vendor: "Acme",
      type: "PLA",
      parentId: parent._id,
    });
    const lean = await Filament.findById(variant._id).lean();

    const { parentEffective } = await resolveEffectiveFilament(lean);

    // The parent is a variant of the grandparent, so its EFFECTIVE density
    // reflects the inherited 1.11 — proving the recursive parent resolution.
    expect(parentEffective).not.toBeNull();
    expect((parentEffective as Record<string, unknown>).density).toBe(1.11);
  });

  // GH #954: a parentId cycle in corrupted data (the API guards against nested
  // inheritance, but a direct DB write / bad migration could create one) used to
  // recurse forever awaiting Filament.findOne — the request never returned. The
  // seen-set guard must make it terminate. If the guard regressed, these tests
  // time out (the failure the fix prevents) rather than passing.
  it("terminates on a two-node parentId cycle instead of hanging", async () => {
    const a = await Filament.create({ name: "Cycle A", vendor: "Acme", type: "PLA", density: 1.2 });
    const b = await Filament.create({ name: "Cycle B", vendor: "Acme", type: "PLA", density: 1.3 });
    // Corrupt data: A → B → A (bypasses the API's no-nested-inheritance guard).
    await Filament.updateOne({ _id: a._id }, { $set: { parentId: b._id } });
    await Filament.updateOne({ _id: b._id }, { $set: { parentId: a._id } });
    const lean = await Filament.findById(a._id).lean();

    const result = await resolveEffectiveFilament(lean);
    // The point: it RETURNS a well-formed result rather than recursing forever.
    expect(result).toHaveProperty("effective");
    expect(result).toHaveProperty("parentEffective");
  });

  it("terminates on a self-referential parentId", async () => {
    const a = await Filament.create({ name: "Self Cycle", vendor: "Acme", type: "PLA", density: 1.5 });
    await Filament.updateOne({ _id: a._id }, { $set: { parentId: a._id } });
    const lean = await Filament.findById(a._id).lean();

    const result = await resolveEffectiveFilament(lean);
    // The point is termination (no infinite recursion). A self-reference is
    // loadable (the doc is its own parent), so parentEffective is that doc's
    // resolved value — the guard fires one level down. Both shapes present.
    expect(result).toHaveProperty("effective");
    expect(result).toHaveProperty("parentEffective");
  });
});
