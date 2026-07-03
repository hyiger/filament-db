import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listTrash } from "@/app/api/filaments/trash/route";
import { POST as restoreFilament } from "@/app/api/filaments/[id]/restore/route";
import { DELETE as deleteFilament } from "@/app/api/filaments/[id]/route";

/**
 * Coverage for the v1.14+ trash workflow:
 *   1. soft-deleted filaments appear in /api/filaments/trash
 *   2. restoring a trashed filament makes it visible again, unless
 *      another active filament has reused its name (409)
 *   3. permanent delete works only on already-trashed docs and refuses
 *      to orphan trashed variants
 */
describe("Filament trash workflow", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  async function softDelete(id: string) {
    const req = new NextRequest(`http://localhost/api/filaments/${id}`, {
      method: "DELETE",
    });
    return deleteFilament(req, { params: Promise.resolve({ id }) });
  }

  async function permanentDelete(id: string) {
    const req = new NextRequest(
      `http://localhost/api/filaments/${id}?permanent=true`,
      { method: "DELETE" },
    );
    return deleteFilament(req, { params: Promise.resolve({ id }) });
  }

  it("GET /trash returns soft-deleted filaments, sorted newest first", async () => {
    const a = await Filament.create({ name: "Trashed A", vendor: "T", type: "PLA" });
    const b = await Filament.create({ name: "Active", vendor: "T", type: "PLA" });
    const c = await Filament.create({ name: "Trashed C", vendor: "T", type: "PLA" });

    // Trash A first, then C, so C appears first in the result.
    await softDelete(String(a._id));
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct timestamps
    await softDelete(String(c._id));

    const res = await listTrash();
    const items = await res.json();
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe("Trashed C");
    expect(items[1].name).toBe("Trashed A");
    // The active filament is not in trash
    expect(items.some((i: { _id: string }) => i._id === String(b._id))).toBe(false);
  });

  it("GH #477: trashed variants surface their parent's secondaryColors + optTags", async () => {
    // A trashed variant with its own arrays empty must inherit the
    // parent's multi-color data — otherwise a deleted variant under a
    // coextruded parent would render as a gray/solid dot in the trash
    // UI even though it inherits stripes everywhere else in the app.
    // (Codex P2 on PR #486 r6.)
    const parent = await Filament.create({
      name: "Tri-color silk",
      vendor: "T",
      type: "PLA",
      color: null,
      secondaryColors: ["#FF0000", "#00FF00", "#0000FF"],
      optTags: [29], // coextruded
    });
    const variant = await Filament.create({
      name: "Tri-color silk — Glossy",
      vendor: "T",
      type: "PLA",
      parentId: parent._id,
      // intentionally no secondaryColors / optTags — inherits from parent
    });
    await softDelete(String(variant._id));

    const res = await listTrash();
    const items = await res.json();
    const row = items.find((i: { _id: string }) => i._id === String(variant._id));
    expect(row).toBeDefined();
    expect(row.secondaryColors).toEqual(["#FF0000", "#00FF00", "#0000FF"]);
    expect(row.optTags).toEqual([29]);
  });

  it("GH #477: a trashed variant with its own secondaryColors overrides the parent", async () => {
    // Array-fallback inheritance: variant's own non-empty array wins.
    const parent = await Filament.create({
      name: "Parent multi",
      vendor: "T",
      type: "PLA",
      color: null,
      secondaryColors: ["#FF0000", "#00FF00"],
      optTags: [29],
    });
    const variant = await Filament.create({
      name: "Variant override",
      vendor: "T",
      type: "PLA",
      parentId: parent._id,
      secondaryColors: ["#111111", "#222222"],
      optTags: [28], // gradient instead of coextruded
    });
    await softDelete(String(variant._id));

    const res = await listTrash();
    const items = await res.json();
    const row = items.find((i: { _id: string }) => i._id === String(variant._id));
    expect(row).toBeDefined();
    expect(row.secondaryColors).toEqual(["#111111", "#222222"]);
    expect(row.optTags).toEqual([28]);
  });

  it("restore brings a trashed filament back, then it disappears from /trash", async () => {
    const f = await Filament.create({
      name: "Restore me",
      vendor: "T",
      type: "PLA",
    });
    await softDelete(String(f._id));

    const restoreRes = await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${f._id}/restore`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(restoreRes.status).toBe(200);

    const trashListRes = await listTrash();
    const trashList = await trashListRes.json();
    expect(trashList).toHaveLength(0);

    const live = await Filament.findById(f._id);
    expect(live._deletedAt).toBeNull();
  });

  it("GH #954/#905: restores a trashed filament carrying a legacy out-of-range field", async () => {
    // Insert directly via the driver so the #337 numeric validators don't reject
    // the out-of-range value on the way in — mimicking a doc created before
    // those validators existed, already soft-deleted. A full-document save on
    // restore would throw a ValidationError (400) and strand it in the trash.
    const _id = new mongoose.Types.ObjectId();
    await Filament.collection.insertOne({
      _id,
      name: "Legacy Out-Of-Range",
      vendor: "T",
      type: "PLA",
      temperatures: { nozzle: 999 }, // above the max-600 validator
      _deletedAt: new Date(),
    });

    const restoreRes = await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${_id}/restore`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(_id) }) },
    );
    expect(restoreRes.status).toBe(200);

    const live = await Filament.findById(_id);
    expect(live._deletedAt).toBeNull();
    // The out-of-range field is untouched (validate-modified-only left it alone).
    expect(live.temperatures.nozzle).toBe(999);
  });

  it("restore refuses with 409 when an active filament has reused the name", async () => {
    const f = await Filament.create({
      name: "Reused name",
      vendor: "T",
      type: "PLA",
    });
    await softDelete(String(f._id));
    // User created a new filament with the same name while the old was trashed
    await Filament.create({ name: "Reused name", vendor: "T", type: "PLA" });

    const restoreRes = await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${f._id}/restore`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(restoreRes.status).toBe(409);
    const body = await restoreRes.json();
    expect(body.error).toMatch(/already exists/i);

    // The trashed one stays trashed
    const stillTrashed = await Filament.findById(f._id);
    expect(stillTrashed._deletedAt).not.toBeNull();
  });

  it("permanent delete only works on trashed filaments and leaves a tombstone", async () => {
    const live = await Filament.create({
      name: "Still active",
      vendor: "T",
      type: "PLA",
    });
    const res = await permanentDelete(String(live._id));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/in the trash/i);

    // Soft-delete it first, then permanent works
    await softDelete(String(live._id));
    const ok = await permanentDelete(String(live._id));
    expect(ok.status).toBe(200);

    // Important: the row is NOT physically deleted. The hybrid sync engine
    // pairs docs across peers by syncId and treats "missing on one side"
    // as a fresh insert from the other — so a hard delete would get
    // resurrected from the trashed peer on the next sync. Instead we keep
    // a `_purged: true` tombstone that sync propagates to the peer.
    const tombstone = await Filament.findById(live._id);
    expect(tombstone).not.toBeNull();
    expect(tombstone._purged).toBe(true);
    expect(tombstone._deletedAt).not.toBeNull();
  });

  it("a `_purged` tombstone does not appear in the trash listing", async () => {
    const f = await Filament.create({ name: "Hidden tombstone", vendor: "T", type: "PLA" });
    await softDelete(String(f._id));
    await permanentDelete(String(f._id));

    const res = await listTrash();
    const items = await res.json();
    expect(items.find((i: { _id: string }) => i._id === String(f._id))).toBeUndefined();
  });

  it("restore refuses (404) on a `_purged` tombstone", async () => {
    const f = await Filament.create({ name: "Cannot resurrect", vendor: "T", type: "PLA" });
    await softDelete(String(f._id));
    await permanentDelete(String(f._id));

    const res = await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${f._id}/restore`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(404);
  });

  it("permanent-delete on an already-purged filament is rejected (idempotent 400)", async () => {
    const f = await Filament.create({ name: "Already purged", vendor: "T", type: "PLA" });
    await softDelete(String(f._id));
    const first = await permanentDelete(String(f._id));
    expect(first.status).toBe(200);
    // Second call should return the same "not in trash" error since the
    // tombstone is no longer considered "in the trash".
    const second = await permanentDelete(String(f._id));
    expect(second.status).toBe(400);
  });

  it("permanent delete of a parent refuses if trashed variants point at it", async () => {
    const parent = await Filament.create({
      name: "PLA Basic",
      vendor: "T",
      type: "PLA",
    });
    const variant = await Filament.create({
      name: "PLA Basic Black",
      vendor: "T",
      type: "PLA",
      parentId: parent._id,
    });

    // Soft-delete the variant first (the constraint blocks parent-with-active-
    // variants soft delete), then trash the parent.
    await softDelete(String(variant._id));
    await softDelete(String(parent._id));

    // Permanently deleting the parent while the variant is also trashed
    // would orphan the variant — the route should refuse.
    const res = await permanentDelete(String(parent._id));
    expect(res.status).toBe(400);
    const body = await res.json();
    // GH #884: error reworded to "still has variants" (the guard counts ALL
    // non-purged variants — active or trashed — not just trashed ones).
    expect(body.error).toMatch(/still has variants/i);

    // Permanently delete the variant first → parent purge then succeeds.
    // After variant purge the variant is a `_purged` tombstone, which the
    // parent's variant-count check skips (we don't count tombstones as
    // "still in the trash").
    const variantPurge = await permanentDelete(String(variant._id));
    expect(variantPurge.status).toBe(200);
    const parentPurge = await permanentDelete(String(parent._id));
    expect(parentPurge.status).toBe(200);
  });
});
