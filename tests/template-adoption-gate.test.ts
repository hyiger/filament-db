import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { PUT as putFilament } from "@/app/api/filaments/[id]/route";
import { POST as restoreFilament } from "@/app/api/filaments/[id]/restore/route";

/**
 * GH #605 (codex round 4) — the ADOPTION paths that can mint a carrying
 * parent's first live variant without creating a document:
 *
 *   F2: PUT /api/filaments/{id} introducing a parentId (none → some, or a
 *       re-parent to a different parent) runs the same promotion gate as
 *       the create path — 409 `parent_promotion_required` until the client
 *       repeats the request with `promoteParent: true`.
 *   F3: the PUT's in-lock template strip covers ALL per-variant fields
 *       (color / colorName / lowStockThreshold, not just totalWeight), so a
 *       form loaded pre-promotion and saved post-promotion can't
 *       re-materialize the promoted-away state on the template.
 *   F6: POST /api/filaments/{id}/restore reviving a trashed variant under a
 *       parent that re-acquired carrying state while variant-less gates the
 *       same way (`{ "promoteParent": true }` in the optional body).
 */
describe("GH #605 round 4 — adoption gate (PUT re-parent + restore) and PUT template strips", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    const histMod = await import("@/models/PrintHistory");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    if (!mongoose.models.PrintHistory) mongoose.model("PrintHistory", histMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function jsonReq(url: string, body: unknown, method: string) {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function seedCarryingParent(name = "Carrying Parent") {
    return Filament.create({
      name,
      vendor: "V",
      type: "PLA",
      color: "#336699",
      colorName: "Steel Blue",
      spools: [{ label: "roll", totalWeight: 900 }],
    });
  }

  // ── F2: PUT re-parent adoption gate ─────────────────────────────────────

  it("PUT introducing a parentId onto a carrying variant-less parent → 409 parent_promotion_required, nothing written", async () => {
    const parent = await seedCarryingParent();
    const standalone = await Filament.create({
      name: "Standalone Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
    });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${standalone._id}`,
        { name: "Standalone Red", color: "#FF0000", parentId: String(parent._id) },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(standalone._id) }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("parent_promotion_required");
    expect(body.parentName).toBe("Carrying Parent");
    expect(body.spoolCount).toBe(1);
    expect(body.variantName).toBe("Carrying Parent — Steel Blue");

    // Nothing written on either side.
    const freshTarget = await Filament.findById(standalone._id).lean();
    expect(freshTarget.parentId ?? null).toBeNull();
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBe("#336699");
    expect(freshParent.spools).toHaveLength(1);
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
  });

  it("PUT re-parent with promoteParent: true → parent promoted first, then the PUT applies (flag never persists)", async () => {
    const parent = await seedCarryingParent();
    const standalone = await Filament.create({
      name: "Standalone Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
    });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${standalone._id}`,
        {
          name: "Standalone Red",
          color: "#FF0000",
          parentId: String(parent._id),
          promoteParent: true,
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(standalone._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(String(body.parentId)).toBe(String(parent._id));
    expect(body.promoteParent).toBeUndefined();

    // Parent promoted: cleared, with the promotion copy carrying its state.
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color ?? null).toBeNull();
    expect(freshParent.colorName ?? null).toBeNull();
    expect(freshParent.spools).toHaveLength(0);
    const promoted = await Filament.findOne({ name: "Carrying Parent — Steel Blue" }).lean();
    expect(promoted).toBeTruthy();
    expect(promoted.color).toBe("#336699");
    expect(promoted.spools).toHaveLength(1);

    // The adopted doc is now the parent's variant; the flag never persisted.
    const freshTarget = await Filament.findById(standalone._id).lean();
    expect(String(freshTarget.parentId)).toBe(String(parent._id));
    expect(freshTarget.promoteParent).toBeUndefined();
    expect(await Filament.countDocuments({ parentId: parent._id, _deletedAt: null })).toBe(2);
  });

  it("PUT re-parent to a NON-carrying parent needs no confirmation", async () => {
    const parent = await Filament.create({
      name: "Clean Parent",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    const standalone = await Filament.create({
      name: "Standalone Blue",
      vendor: "V",
      type: "PLA",
      color: "#0000FF",
    });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${standalone._id}`,
        { parentId: String(parent._id) },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(standalone._id) }) },
    );

    expect(res.status).toBe(200);
    // No promotion copy was minted.
    expect(await Filament.countDocuments({ parentId: parent._id, _deletedAt: null })).toBe(1);
  });

  it("PUT echoing the UNCHANGED parentId (form re-save) skips the gate; un-parenting skips it too", async () => {
    // A legacy carrying template: parent still holds color, has a variant.
    const parent = await seedCarryingParent("Legacy Template");
    const variant = await Filament.create({
      name: "Legacy Template — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });

    // Echoing the same parentId back is not a re-parent — no 409, and no
    // silent promotion of the legacy parent.
    const echo = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${variant._id}`,
        { parentId: String(parent._id), cost: 19.99 },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(echo.status).toBe(200);
    let freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBe("#336699");

    // Un-parenting (parentId: null) can't mint a first variant — no gate.
    const unparent = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${variant._id}`,
        { parentId: null },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(unparent.status).toBe(200);
    freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBe("#336699");
    expect(await Filament.countDocuments({ parentId: parent._id, _deletedAt: null })).toBe(0);
  });

  it("PUT re-parenting AWAY from one parent TO a carrying parent gates on the new parent", async () => {
    const oldParent = await Filament.create({
      name: "Old Parent",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    const newParent = await seedCarryingParent("New Carrying Parent");
    const variant = await Filament.create({
      name: "Migrating Variant",
      vendor: "V",
      type: "PLA",
      color: "#00FF00",
      parentId: oldParent._id,
    });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${variant._id}`,
        { parentId: String(newParent._id) },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("parent_promotion_required");
    // The variant still points at its old parent.
    const fresh = await Filament.findById(variant._id).lean();
    expect(String(fresh.parentId)).toBe(String(oldParent._id));
  });

  it("PUT to a TRASHED target never promotes the parent — 404 with no side effect (even confirmed)", async () => {
    const parent = await seedCarryingParent("Untouched Parent");
    const trashed = await Filament.create({
      name: "Trashed Target",
      vendor: "V",
      type: "PLA",
      _deletedAt: new Date(),
    });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${trashed._id}`,
        { parentId: String(parent._id), promoteParent: true },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(trashed._id) }) },
    );

    expect(res.status).toBe(404);
    // The parent was NOT promoted on the way to the error.
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBe("#336699");
    expect(freshParent.spools).toHaveLength(1);
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
  });

  it("confirmed re-parenting PUT with a schema-invalid body → 400 BEFORE any promotion (codex round 6, F1)", async () => {
    // Same defect class as the create path's round-1 fix: the PUT's own
    // write runs runValidators, but only AFTER a confirmed adoption gate has
    // already promoted the parent — so a body that fails Mongoose validation
    // would surface its 400 with the parent's restructuring already
    // irreversible. The round-6 dry-run must reject first, everything
    // untouched.
    const parent = await seedCarryingParent("Prevalidated Parent");
    const standalone = await Filament.create({
      name: "Prevalidated Target",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      cost: 10,
    });
    const parentBefore = await Filament.findById(parent._id).lean();
    const targetBefore = await Filament.findById(standalone._id).lean();

    // cost: -5 violates the schema's min bound.
    const badCost = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${standalone._id}`,
        { parentId: String(parent._id), promoteParent: true, cost: -5 },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(standalone._id) }) },
    );
    expect(badCost.status).toBe(400);
    const badCostBody = await badCost.json();
    expect(badCostBody.error).toMatch(/cost/);

    // A bad color hex fails the same way.
    const badColor = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${standalone._id}`,
        { parentId: String(parent._id), promoteParent: true, color: "not-a-hex" },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(standalone._id) }) },
    );
    expect(badColor.status).toBe(400);
    const badColorBody = await badColor.json();
    expect(badColorBody.error).toMatch(/color/);

    // Parent byte-for-byte untouched — color/spools/state all still there,
    // and no promotion copy was minted.
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent).toEqual(parentBefore);
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
    expect(
      await Filament.findOne({ name: "Prevalidated Parent — Steel Blue" }).lean(),
    ).toBeNull();

    // Target unchanged too — not adopted, values intact.
    const freshTarget = await Filament.findById(standalone._id).lean();
    expect(freshTarget).toEqual(targetBefore);
  });

  // ── F3: the in-lock template strip covers all per-variant fields ────────

  it("a form loaded pre-promotion cannot re-materialize color/colorName/lowStockThreshold/totalWeight on the template", async () => {
    // A clean (promoted) template with one live variant.
    const parent = await Filament.create({
      name: "Promoted Template",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    await Filament.create({
      name: "Promoted Template — Blue",
      vendor: "V",
      type: "PLA",
      color: "#0000FF",
      parentId: parent._id,
    });

    // The stale form echoes the promoted-away values back verbatim.
    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${parent._id}`,
        {
          cost: 21.5,
          color: "#123456",
          colorName: "Deep Blue",
          lowStockThreshold: 150,
          totalWeight: 750,
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(parent._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cost).toBe(21.5); // untouched fields still apply
    expect(body._strippedTemplateFields).toEqual([
      "totalWeight",
      "color",
      "colorName",
      "lowStockThreshold",
    ]);

    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color ?? null).toBeNull();
    expect(fresh.colorName ?? null).toBeNull();
    expect(fresh.lowStockThreshold ?? null).toBeNull();
    expect(fresh.totalWeight ?? null).toBeNull();
  });

  it("a LEGACY carrying parent keeps its stored color after a form-shaped PUT — and the response reports the strip", async () => {
    // Pre-#605 shape: the parent still carries color/colorName/threshold
    // AND has a live variant (enforce-forward: never silently migrated).
    const parent = await Filament.create({
      name: "Legacy Carrying Template",
      vendor: "V",
      type: "PLA",
      color: "#808080",
      colorName: "Gray",
      lowStockThreshold: 200,
    });
    await Filament.create({
      name: "Legacy Carrying Template — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });

    // The edit form resubmits the SEEDED (stored) values verbatim on save.
    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${parent._id}`,
        {
          name: "Legacy Carrying Template",
          color: "#808080",
          colorName: "Gray",
          lowStockThreshold: 200,
          cost: 25,
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(parent._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Stripping means "not applied" — and since the resubmitted value equals
    // the stored one, the legacy parent's behavior is unchanged...
    expect(body._strippedTemplateFields).toEqual([
      "color",
      "colorName",
      "lowStockThreshold",
    ]);
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#808080");
    expect(fresh.colorName).toBe("Gray");
    expect(fresh.lowStockThreshold).toBe(200);
    expect(fresh.cost).toBe(25);
  });

  it("explicit nulls still pass — clearing a legacy template's color/colorName/threshold is cleanup", async () => {
    const parent = await Filament.create({
      name: "Legacy Cleanup Template",
      vendor: "V",
      type: "PLA",
      color: "#808080",
      colorName: "Gray",
      lowStockThreshold: 200,
    });
    await Filament.create({
      name: "Legacy Cleanup Template — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${parent._id}`,
        { color: null, colorName: null, lowStockThreshold: null },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(parent._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._strippedTemplateFields).toBeUndefined();
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBeNull();
    expect(fresh.colorName ?? null).toBeNull();
    expect(fresh.lowStockThreshold).toBeNull();
  });

  it("a standalone (no variants) still takes color/colorName/lowStockThreshold writes unstripped", async () => {
    const f = await Filament.create({ name: "Plain Standalone", vendor: "V", type: "PLA" });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${f._id}`,
        { color: "#ABCDEF", colorName: "Sky", lowStockThreshold: 120 },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._strippedTemplateFields).toBeUndefined();
    const fresh = await Filament.findById(f._id).lean();
    expect(fresh.color).toBe("#ABCDEF");
    expect(fresh.colorName).toBe("Sky");
    expect(fresh.lowStockThreshold).toBe(120);
  });

  // ── F6: restore adoption gate ────────────────────────────────────────────

  function restoreReq(id: string, body?: unknown) {
    return new NextRequest(`http://localhost/api/filaments/${id}/restore`, {
      method: "POST",
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
  }

  it("restoring a variant under a parent that re-acquired carrying state → 409 until confirmed, then promotes and restores", async () => {
    // Round-3 residue shape: the parent's only variant was trashed, then the
    // parent (variant-less again) re-acquired a color + a spool.
    const parent = await Filament.create({
      name: "Reacquired Parent",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    const variant = await Filament.create({
      name: "Reacquired Parent — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
      _deletedAt: new Date(),
    });
    await Filament.updateOne(
      { _id: parent._id },
      {
        $set: {
          color: "#00AA00",
          colorName: "Re-Green",
          spools: [{ label: "new roll", totalWeight: 600 }],
        },
      },
    );

    // Bare POST (the pre-existing contract) → gated.
    const gated = await restoreFilament(restoreReq(String(variant._id)), {
      params: Promise.resolve({ id: String(variant._id) }),
    });
    expect(gated.status).toBe(409);
    const gatedBody = await gated.json();
    expect(gatedBody.error).toBe("parent_promotion_required");
    expect(gatedBody.parentName).toBe("Reacquired Parent");
    expect(gatedBody.variantName).toBe("Reacquired Parent — Re-Green");
    // Still trashed, parent untouched.
    let freshVariant = await Filament.findById(variant._id).lean();
    expect(freshVariant._deletedAt).not.toBeNull();
    let freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBe("#00AA00");

    // Confirmed → promote first, then revive.
    const confirmed = await restoreFilament(
      restoreReq(String(variant._id), { promoteParent: true }),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json();
    expect(confirmedBody.message).toBe("Restored");
    expect(confirmedBody._id).toBe(String(variant._id));

    freshVariant = await Filament.findById(variant._id).lean();
    expect(freshVariant._deletedAt).toBeNull();
    freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color ?? null).toBeNull();
    expect(freshParent.spools).toHaveLength(0);
    const promoted = await Filament.findOne({ name: "Reacquired Parent — Re-Green" }).lean();
    expect(promoted).toBeTruthy();
    expect(promoted.color).toBe("#00AA00");
    expect(promoted.spools).toHaveLength(1);
  });

  it("restoring a variant under a clean parent is ungated (bare POST, no body — the pre-existing contract)", async () => {
    const parent = await Filament.create({
      name: "Clean Restore Parent",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    const variant = await Filament.create({
      name: "Clean Restore Parent — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
      _deletedAt: new Date(),
    });

    const res = await restoreFilament(restoreReq(String(variant._id)), {
      params: Promise.resolve({ id: String(variant._id) }),
    });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(variant._id).lean();
    expect(fresh._deletedAt).toBeNull();
    // No promotion copy was minted.
    expect(await Filament.countDocuments({ parentId: parent._id, _deletedAt: null })).toBe(1);
  });

  it("restoring a variant under a legacy carrying parent that still HAS a live variant skips the gate", async () => {
    const parent = await seedCarryingParent("Legacy Restore Template");
    await Filament.create({
      name: "Legacy Restore Template — Live",
      vendor: "V",
      type: "PLA",
      color: "#00FF00",
      parentId: parent._id,
    });
    const trashed = await Filament.create({
      name: "Legacy Restore Template — Trashed",
      vendor: "V",
      type: "PLA",
      color: "#FF00FF",
      parentId: parent._id,
      _deletedAt: new Date(),
    });

    const res = await restoreFilament(restoreReq(String(trashed._id)), {
      params: Promise.resolve({ id: String(trashed._id) }),
    });
    expect(res.status).toBe(200);
    // Enforce-forward: the legacy carrying state stays put.
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBe("#336699");
  });

  it("restoring a variant whose parent became a VARIANT while it sat in the trash → no-nesting 400, stays trashed (round 8 F1)", async () => {
    // A trashed variant doesn't count toward the PUT's has-children guard,
    // so the parent can legitimately be re-parented while this doc is in
    // the trash — reviving it would then nest inheritance.
    const grandparent = await Filament.create({
      name: "Restore Nesting Root",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    const parent = await Filament.create({
      name: "Reparented Parent",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    const variant = await Filament.create({
      name: "Reparented Parent — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
      _deletedAt: new Date(),
    });
    await Filament.updateOne(
      { _id: parent._id },
      { $set: { parentId: grandparent._id } },
    );

    // Even a confirmed restore is refused — the gate's in-lock re-fetch
    // re-asserts rootness (parent_is_variant).
    const res = await restoreFilament(restoreReq(String(variant._id), { promoteParent: true }), {
      params: Promise.resolve({ id: String(variant._id) }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Cannot set a variant as parent (no nested inheritance)",
    );

    // The variant stays in the trash; no grandchild went live.
    const stillTrashed = await Filament.findOne({
      _id: variant._id,
      _deletedAt: { $ne: null },
    }).lean();
    expect(stillTrashed).not.toBeNull();
    expect(
      await Filament.countDocuments({ parentId: parent._id, _deletedAt: null }),
    ).toBe(0);
  });

  it("restoring a standalone ignores the gate entirely (with or without a body)", async () => {
    const f = await Filament.create({
      name: "Trashed Standalone",
      vendor: "V",
      type: "PLA",
      _deletedAt: new Date(),
    });

    const res = await restoreFilament(restoreReq(String(f._id), { promoteParent: true }), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id).lean();
    expect(fresh._deletedAt).toBeNull();
  });

  // ── round 7 P2: threshold-only parents on the adoption paths ────────────

  async function seedThresholdOnlyParent(name: string) {
    return Filament.create({
      name,
      vendor: "V",
      type: "PLA",
      color: null,
      lowStockThreshold: 175,
    });
  }

  it("PUT re-parent onto a threshold-only parent: no 409, and the parent's dead threshold is cleared AFTER the write", async () => {
    const parent = await seedThresholdOnlyParent("Threshold Adoption Parent");
    const standalone = await Filament.create({
      name: "Adoptee Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
    });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${standalone._id}`,
        { name: "Adoptee Red", color: "#FF0000", parentId: String(parent._id) },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(standalone._id) }) },
    );

    expect(res.status).toBe(200);
    const freshTarget = await Filament.findById(standalone._id).lean();
    expect(String(freshTarget.parentId)).toBe(String(parent._id));
    // The parent is a template now — its threshold was dead config (form
    // hides it, PUT strips it) and got cleared; nothing else changed and no
    // promotion copy was minted.
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.lowStockThreshold).toBeNull();
    expect(await Filament.countDocuments({ parentId: parent._id, _deletedAt: null })).toBe(1);
    // Not moved onto the adopted variant either.
    expect(freshTarget.lowStockThreshold ?? null).toBeNull();
  });

  it("a FAILED re-parent PUT (schema-invalid body) leaves the threshold-only parent untouched", async () => {
    const parent = await seedThresholdOnlyParent("Threshold Untouched Parent");
    const standalone = await Filament.create({
      name: "Invalid Adoptee",
      vendor: "V",
      type: "PLA",
    });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${standalone._id}`,
        { name: "Invalid Adoptee", color: "not-a-hex", parentId: String(parent._id) },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(standalone._id) }) },
    );

    expect(res.status).toBe(400);
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.lowStockThreshold).toBe(175);
    const freshTarget = await Filament.findById(standalone._id).lean();
    expect(freshTarget.parentId ?? null).toBeNull();
  });

  it("restore reviving the first variant under a threshold-only parent clears the dead threshold (bare POST)", async () => {
    const parent = await seedThresholdOnlyParent("Threshold Restore Parent");
    const trashed = await Filament.create({
      name: "Threshold Restore Parent — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
      _deletedAt: new Date(),
    });

    const res = await restoreFilament(restoreReq(String(trashed._id)), {
      params: Promise.resolve({ id: String(trashed._id) }),
    });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(trashed._id).lean();
    expect(fresh._deletedAt).toBeNull();
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.lowStockThreshold).toBeNull();
    // No promotion copy — nothing gated, nothing moved.
    expect(await Filament.countDocuments({ parentId: parent._id, _deletedAt: null })).toBe(1);
  });

  it("restore under a threshold-carrying template that still HAS a live variant leaves it alone", async () => {
    const parent = await seedThresholdOnlyParent("Threshold Populated Template");
    await Filament.create({
      name: "Threshold Populated Template — Live",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
    });
    const trashed = await Filament.create({
      name: "Threshold Populated Template — Trashed",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      _deletedAt: new Date(),
    });

    const res = await restoreFilament(restoreReq(String(trashed._id)), {
      params: Promise.resolve({ id: String(trashed._id) }),
    });
    expect(res.status).toBe(200);
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.lowStockThreshold).toBe(175);
  });
});
