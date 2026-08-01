import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import { POST as promotePOST } from "@/app/api/filaments/[id]/promote/route";

/**
 * GH #605 — Phase 2b: the parent-promotion flow.
 *
 * Creating the FIRST variant of a parent that still carries variant state —
 * a real color, a color name, its own spools, or a legacy inventory
 * totalWeight — promotes the parent to a template: that state moves to a
 * NEW sibling variant. The spoolWeight/netFilamentWeight SPEC pair never
 * moves (GH #1048): it stays on the template, where variants inherit it.
 * The move is a side effect on a second document, so it demands an
 * explicit opt-in:
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

  it("colorName-only parent (no hex, no spools) still gates → 409, name uses the colorName", async () => {
    const parent = await Filament.create({
      name: "Named Colorless PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      colorName: "Galaxy Black",
    });

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Named Colorless PLA — Red" })),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("parent_promotion_required");
    expect(body.parentColor).toBeNull();
    expect(body.spoolCount).toBe(0);
    expect(body.variantName).toBe("Named Colorless PLA — Galaxy Black");
  });

  it("totalWeight-only parent (legacy inventory weight) gates → 409", async () => {
    const parent = await Filament.create({
      name: "Weighed Colorless PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      totalWeight: 1250,
    });

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Weighed Colorless PLA — Red" })),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("parent_promotion_required");
  });

  it("a parent with ONLY the SPEC pair (spoolWeight/netFilamentWeight) does NOT gate → 201, spec stays put", async () => {
    const parent = await Filament.create({
      name: "Spec-Only PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      spoolWeight: 250,
      netFilamentWeight: 1000,
    });

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Spec-Only PLA — Red" })),
    );
    expect(res.status).toBe(201);
    // Exactly the requested variant — no promoted sibling was spawned.
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(1);
    // The template keeps its spec (GH #1048) …
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.spoolWeight).toBe(250);
    expect(fresh.netFilamentWeight).toBe(1000);
    // … and the new variant inherits it.
    const created = await res.json();
    const { resolveEffectiveFilament } = await import("@/lib/resolveEffectiveFilament");
    const variantLean = await Filament.findById(created._id).lean();
    const { effective } = await resolveEffectiveFilament(variantLean);
    expect(effective.spoolWeight).toBe(250);
    expect(effective.netFilamentWeight).toBe(1000);
  });

  it("a parent with ONLY a lowStockThreshold does NOT gate → 201 (review P2: no inventory to protect)", async () => {
    const parent = await Filament.create({
      name: "Threshold-Only PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      lowStockThreshold: 150,
    });

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Threshold-Only PLA — Red" })),
    );
    expect(res.status).toBe(201);
    // Exactly the requested variant — no promoted sibling was spawned; the
    // threshold stays where it was (nothing moved, nothing was gated).
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(1);
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBe(150);
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
      lowStockThreshold: 300,
    });
    const parentLean = await Filament.findById(parent._id).lean();

    const res = await createFilament(jsonReq(variantBody(parent._id, { promoteParent: true })));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.name).toBe("Carrying PLA — Red");
    expect(String(created.parentId)).toBe(String(parent._id));
    // The flag is a control knob, never a stored field.
    expect(created.promoteParent).toBeUndefined();

    // The promoted copy: named by the colorName rule, carrying the moved
    // state. The SPEC pair (spoolWeight/netFilamentWeight) is NOT copied —
    // the variant's own fields stay blank and inherit from the template.
    const promoted = await Filament.findOne({ name: "Carrying PLA — Steel Blue" }).lean();
    expect(promoted).toBeTruthy();
    expect(String(promoted.parentId)).toBe(String(parent._id));
    expect(promoted.color).toBe("#336699");
    expect(promoted.colorName).toBe("Steel Blue");
    expect(promoted.spoolWeight ?? null).toBeNull();
    expect(promoted.netFilamentWeight ?? null).toBeNull();
    // Review P2: the low-stock alarm moved with the inventory it watches.
    expect(promoted.lowStockThreshold).toBe(300);
    expect(promoted.spools).toHaveLength(2);
    expect(promoted.spools.map((s: { label: string }) => s.label)).toEqual(["roll 1", "roll 2"]);
    // Physical-roll identity preserved — and since codex round 4 (F1) the
    // subdoc _id too, so persisted (filamentId, spoolId) references keep
    // their spoolId half stable through the promotion.
    for (const [i, s] of promoted.spools.entries()) {
      expect(s.instanceId).toBe(parentLean.spools[i].instanceId);
      expect(String(s._id)).toBe(String(parentLean.spools[i]._id));
    }

    // The parent ends colorless + inventory-free — but RETAINS the SPEC
    // pair (GH #1048: the product line's tare + nominal net weight stay on
    // the template so the whole family inherits them).
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBeNull();
    expect(fresh.colorName).toBeNull();
    expect(fresh.spools).toEqual([]);
    expect(fresh.lowStockThreshold).toBeNull();
    expect(fresh.spoolWeight).toBe(240);
    expect(fresh.netFilamentWeight).toBe(1000);

    // Both variants live under the template.
    expect(await Filament.countDocuments({ parentId: parent._id, _deletedAt: null })).toBe(2);

    // And the variants INHERIT the spec pair (resolved view) — the
    // denominator for remaining-percentage math comes from the template.
    const { resolveEffectiveFilament } = await import("@/lib/resolveEffectiveFilament");
    const { effective } = await resolveEffectiveFilament(promoted);
    expect(effective.spoolWeight).toBe(240);
    expect(effective.netFilamentWeight).toBe(1000);
    expect(effective._inherited).toContain("spoolWeight");
    expect(effective._inherited).toContain("netFilamentWeight");
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

  // Review F1 (P1): a confirmed promoteParent retry whose body passes the
  // route's bespoke guards but fails MONGOOSE validation must 400 BEFORE the
  // promotion runs — never promote-then-fail-the-create, which would leave
  // the parent permanently restructured behind an error response.
  it("a schema-invalid requested variant (bad color hex) fails BEFORE the promotion — parent untouched", async () => {
    const parent = await seedCarryingParent({ colorName: "Steel Blue" });

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { promoteParent: true, color: "#bad" })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/color must be a #RRGGBB hex string/i);

    // Parent completely untouched: color/colorName/spools intact …
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.colorName).toBe("Steel Blue");
    expect(fresh.spools).toHaveLength(2);
    // … and NO promoted sibling (nor the requested variant) was created.
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
  });

  it("a schema-invalid requested variant (negative cost) fails BEFORE the promotion — parent untouched", async () => {
    const parent = await seedCarryingParent();

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { promoteParent: true, cost: -5 })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cost must be >= 0/i);

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

  it("promote: SPEC-only template (spoolWeight/netFilamentWeight) → nothing_to_convert; totalWeight-only converts and retains spec", async () => {
    // Spec alone is not "carrying" — same predicate as the create gate.
    const specOnly = await Filament.create({
      name: "Spec Template PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      spoolWeight: 250,
      netFilamentWeight: 1000,
    });
    await Filament.create({
      name: "Spec Template PLA — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: specOnly._id,
    });
    const resSpec = await promoteReq(String(specOnly._id));
    expect(resSpec.status).toBe(400);
    expect((await resSpec.json()).error).toBe("nothing_to_convert");

    // A legacy inventory totalWeight DOES convert — it moves to the new
    // variant while the spec pair stays on the template.
    const weighed = await Filament.create({
      name: "Weighed Template PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      totalWeight: 1250,
      spoolWeight: 250,
      netFilamentWeight: 1000,
    });
    await Filament.create({
      name: "Weighed Template PLA — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: weighed._id,
    });
    const res = await promoteReq(String(weighed._id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variant.totalWeight).toBe(1250);
    expect(body.variant.spoolWeight ?? null).toBeNull();
    expect(body.variant.netFilamentWeight ?? null).toBeNull();
    expect(body.parent.totalWeight).toBeNull();
    expect(body.parent.spoolWeight).toBe(250);
    expect(body.parent.netFilamentWeight).toBe(1000);
  });

  it("promote: threshold-only template → nothing_to_convert; a carrying one moves the threshold with the inventory", async () => {
    // Review P2: lowStockThreshold alone is not "carrying" — same predicate
    // as the create gate.
    const thresholdOnly = await Filament.create({
      name: "Threshold Template PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      lowStockThreshold: 100,
    });
    await Filament.create({
      name: "Threshold Template PLA — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: thresholdOnly._id,
    });
    const resThreshold = await promoteReq(String(thresholdOnly._id));
    expect(resThreshold.status).toBe(400);
    expect((await resThreshold.json()).error).toBe("nothing_to_convert");
    // Untouched — no promotion ran.
    const freshThresholdOnly = await Filament.findById(thresholdOnly._id).lean();
    expect(freshThresholdOnly.lowStockThreshold).toBe(100);

    // But when the parent DOES carry inventory, the threshold rides along:
    // it alarms on the spools/totalWeight being moved.
    const carrying = await Filament.create({
      name: "Alarmed Template PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      totalWeight: 900,
      lowStockThreshold: 250,
    });
    await Filament.create({
      name: "Alarmed Template PLA — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: carrying._id,
    });
    const res = await promoteReq(String(carrying._id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variant.totalWeight).toBe(900);
    expect(body.variant.lowStockThreshold).toBe(250);
    expect(body.parent.totalWeight).toBeNull();
    expect(body.parent.lowStockThreshold).toBeNull();
  });

  it("promote: 400 on a malformed id, 404 on a missing one", async () => {
    expect((await promoteReq("not-an-objectid")).status).toBe(400);
    expect((await promoteReq(new mongoose.Types.ObjectId().toString())).status).toBe(404);
  });
});
