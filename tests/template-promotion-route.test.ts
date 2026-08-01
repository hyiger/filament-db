import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import { POST as promotePOST } from "@/app/api/filaments/[id]/promote/route";

/**
 * GH #605 — Phase 2b: the parent-promotion flow.
 *
 * Creating the FIRST variant of a parent that still carries a real color or
 * its own spools promotes the parent to a template — its color/spools move
 * to a NEW sibling variant. The move is a side effect on a second document,
 * so it demands an explicit opt-in:
 *   - no `promoteParent: true` → structured 409 `parent_promotion_required`
 *     naming exactly what would happen (parentColor, spoolCount, the
 *     would-be variant name);
 *   - with the flag → promoted copy created FIRST, parent cleared LAST,
 *     then the requested variant is created.
 *
 * POST /api/filaments/{id}/promote is the same promotion at the user's
 * explicit initiative ("Convert to template" on a legacy parent).
 */
describe("GH #605 — parent promotion (409 + promoteParent + /promote)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mods = [
      ["Filament", await import("@/models/Filament")],
      ["Nozzle", await import("@/models/Nozzle")],
      ["Printer", await import("@/models/Printer")],
      ["BedType", await import("@/models/BedType")],
      ["Location", await import("@/models/Location")],
    ] as const;
    for (const [name, mod] of mods) {
      if (!mongoose.models[name]) mongoose.model(name, mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  function jsonReq(body: unknown) {
    return new NextRequest("http://localhost/api/filaments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function promoteReq(id: string) {
    return promotePOST(
      new NextRequest(`http://localhost/api/filaments/${id}/promote`, { method: "POST" }),
      { params: Promise.resolve({ id }) },
    );
  }

  /** A standalone that would become a carrying parent: color + 2 spools. */
  async function seedCarryingParent(extra: Record<string, unknown> = {}) {
    return Filament.create({
      name: "Carrying PLA",
      vendor: "V",
      type: "PLA",
      color: "#336699",
      spools: [
        { label: "roll 1", totalWeight: 1000 },
        { label: "roll 2", totalWeight: 750 },
      ],
      ...extra,
    });
  }

  function variantBody(parentId: unknown, extra: Record<string, unknown> = {}) {
    return {
      name: "Carrying PLA — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: String(parentId),
      ...extra,
    };
  }

  // ── the 409 gate ─────────────────────────────────────────────────────────

  it("first variant of a carrying parent without the flag → 409 with parentColor/spoolCount/variantName, nothing created", async () => {
    const parent = await seedCarryingParent();

    const res = await createFilament(jsonReq(variantBody(parent._id)));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("parent_promotion_required");
    expect(body.parentName).toBe("Carrying PLA");
    expect(body.parentColor).toBe("#336699");
    expect(body.spoolCount).toBe(2);
    expect(body.variantName).toBe("Carrying PLA — Original");

    // No variant created, parent untouched.
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
  });

  it("the 409's variantName uses the parent's colorName and never squats on the requested name", async () => {
    const parent = await seedCarryingParent({ colorName: "Steel Blue" });

    // Request a variant named exactly like the would-be promoted copy —
    // the resolver must step past it.
    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Carrying PLA — Steel Blue" })),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.variantName).toBe("Carrying PLA — Steel Blue (2)");
  });

  it("spools-only parent (color already null) still gates with parentColor null", async () => {
    const parent = await Filament.create({
      name: "Spooled Colorless PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      spools: [{ label: "", totalWeight: 500 }],
    });

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Spooled Colorless PLA — Red" })),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.parentColor).toBeNull();
    expect(body.spoolCount).toBe(1);
  });

  it("first variant of a CLEAN parent (color null, no spools) needs no flag → 201, no promotion copy", async () => {
    const parent = await Filament.create({
      name: "Clean PLA",
      vendor: "V",
      type: "PLA",
      color: null,
    });

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Clean PLA — Red" })),
    );
    expect(res.status).toBe(201);
    // Exactly the requested variant, no promoted sibling.
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(1);
  });

  it("second variant onward → no 409 even when the parent still carries legacy state", async () => {
    const parent = await seedCarryingParent();
    // A pre-existing live variant (legacy parent — enforce forward only).
    await Filament.create({
      name: "Carrying PLA — Blue",
      vendor: "V",
      type: "PLA",
      color: "#0000FF",
      parentId: parent._id,
    });

    const res = await createFilament(jsonReq(variantBody(parent._id)));
    expect(res.status).toBe(201);
    // Legacy state untouched (the explicit /promote action handles it).
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
  });

  // ── the confirmed promotion ──────────────────────────────────────────────

  it("with promoteParent: true → promoted copy carries color+spools, parent cleared, requested variant created", async () => {
    const parent = await seedCarryingParent({
      colorName: "Steel Blue",
      spoolWeight: 240,
      netFilamentWeight: 1000,
    });
    const parentLean = await Filament.findById(parent._id).lean();

    const res = await createFilament(jsonReq(variantBody(parent._id, { promoteParent: true })));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.name).toBe("Carrying PLA — Red");
    expect(String(created.parentId)).toBe(String(parent._id));
    // The flag is a control knob, never a stored field.
    expect(created.promoteParent).toBeUndefined();

    // The promoted copy: named by the colorName rule, carrying the moved state.
    const promoted = await Filament.findOne({ name: "Carrying PLA — Steel Blue" }).lean();
    expect(promoted).toBeTruthy();
    expect(String(promoted.parentId)).toBe(String(parent._id));
    expect(promoted.color).toBe("#336699");
    expect(promoted.colorName).toBe("Steel Blue");
    expect(promoted.spoolWeight).toBe(240);
    expect(promoted.netFilamentWeight).toBe(1000);
    expect(promoted.spools).toHaveLength(2);
    expect(promoted.spools.map((s: { label: string }) => s.label)).toEqual(["roll 1", "roll 2"]);
    // Physical-roll identity preserved, fresh subdoc ids.
    for (const [i, s] of promoted.spools.entries()) {
      expect(s.instanceId).toBe(parentLean.spools[i].instanceId);
      expect(String(s._id)).not.toBe(String(parentLean.spools[i]._id));
    }

    // The parent ends colorless + inventory-free.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBeNull();
    expect(fresh.colorName).toBeNull();
    expect(fresh.spools).toEqual([]);
    expect(fresh.spoolWeight).toBeNull();
    expect(fresh.netFilamentWeight).toBeNull();

    // Both variants live under the template.
    expect(await Filament.countDocuments({ parentId: parent._id, _deletedAt: null })).toBe(2);
  });

  it("promoted-name collision: an existing row already holds the base name → ' (2)' suffix", async () => {
    await Filament.create({ name: "Carrying PLA — Original", vendor: "V", type: "PLA" });
    const parent = await seedCarryingParent();

    const res = await createFilament(jsonReq(variantBody(parent._id, { promoteParent: true })));
    expect(res.status).toBe(201);

    const promoted = await Filament.findOne({
      name: "Carrying PLA — Original (2)",
      parentId: parent._id,
    }).lean();
    expect(promoted).toBeTruthy();
    expect(promoted.color).toBe("#336699");
  });

  it("a duplicate requested name fails BEFORE the promotion — parent left untouched", async () => {
    await Filament.create({ name: "Carrying PLA — Red", vendor: "V", type: "PLA" });
    const parent = await seedCarryingParent();

    const res = await createFilament(jsonReq(variantBody(parent._id, { promoteParent: true })));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/i);

    // Not promoted: color + spools still on the parent, no copy created.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
  });

  // ── POST /api/filaments/{id}/promote — "Convert to template" ────────────

  it("promote: moves a legacy parent's color+spools to a new variant and clears the parent", async () => {
    const parent = await seedCarryingParent({ colorName: "Steel Blue" });
    await Filament.create({
      name: "Carrying PLA — Blue",
      vendor: "V",
      type: "PLA",
      color: "#0000FF",
      parentId: parent._id,
    });

    const res = await promoteReq(String(parent._id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variant.name).toBe("Carrying PLA — Steel Blue");
    expect(body.variant.color).toBe("#336699");
    expect(body.variant.spools).toHaveLength(2);
    expect(body.parent.color).toBeNull();
    expect(body.parent.spools).toEqual([]);

    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBeNull();
    expect(fresh.colorName).toBeNull();
    expect(fresh.spools).toEqual([]);
  });

  it("promote: 400 not_a_template for a standalone (no live variants)", async () => {
    const standalone = await seedCarryingParent({ name: "Standalone Carrying PLA" });
    const res = await promoteReq(String(standalone._id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_a_template");
  });

  it("promote: 400 not_a_template when the only variant is soft-deleted", async () => {
    const parent = await seedCarryingParent();
    await Filament.create({
      name: "Carrying PLA — Gone",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      _deletedAt: new Date(),
    });
    const res = await promoteReq(String(parent._id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_a_template");
  });

  it("promote: 400 not_a_template for a variant target", async () => {
    const parent = await Filament.create({ name: "Root PLA", vendor: "V", type: "PLA", color: null });
    const variant = await Filament.create({
      name: "Root PLA — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });
    const res = await promoteReq(String(variant._id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_a_template");
  });

  it("promote: 400 nothing_to_convert for an already-clean template", async () => {
    const parent = await Filament.create({ name: "Clean Template PLA", vendor: "V", type: "PLA", color: null });
    await Filament.create({
      name: "Clean Template PLA — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });
    const res = await promoteReq(String(parent._id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("nothing_to_convert");
  });

  it("promote: 400 on a malformed id, 404 on a missing one", async () => {
    expect((await promoteReq("not-an-objectid")).status).toBe(400);
    expect((await promoteReq(new mongoose.Types.ObjectId().toString())).status).toBe(404);
  });
});
