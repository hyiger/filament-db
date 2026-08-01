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
      ["PrintHistory", await import("@/models/PrintHistory")],
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
    // Exactly the requested variant — no promoted sibling was spawned.
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(1);
    // Round 7 P2: the parent is a template now, and a threshold there is
    // dead config (form hides it, PUT strips it, the dashboard could still
    // evaluate it) — the ungated first-variant creation clears it. It does
    // NOT move to the variant: the variant is a new filament, not a copy.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBeNull();
    const variant = await Filament.findOne({ parentId: parent._id }).lean();
    expect(variant.lowStockThreshold ?? null).toBeNull();
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
    // Round 8 F2: a normal conversion is a FRESH promotion.
    expect(body.resumed).toBe(false);

    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBeNull();
    expect(fresh.colorName).toBeNull();
    expect(fresh.spools).toEqual([]);
  });

  it("promote: RESUMES an interrupted promotion (marker + token-paired copy) instead of minting a ' (2)' duplicate — round 8 F2 / round 10", async () => {
    // Manufacture the interrupted state directly: the durable marker was
    // stamped (step 0) and the copy created carrying the token (step 1,
    // spool subdoc _ids verbatim), but the run died before the parent
    // clear. Round 10: the marker/token pair — not the copied values — is
    // what proves this state.
    const parent = await seedCarryingParent({ colorName: "Steel Blue" });
    const token = "route-resume-token";
    await Filament.updateOne(
      { _id: parent._id },
      { $set: { promotionInFlight: { token, at: new Date() } } },
    );
    const parentLean = await Filament.findById(parent._id).lean();
    await Filament.create({
      name: "Carrying PLA — Steel Blue",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      color: parentLean.color,
      colorName: parentLean.colorName,
      spools: parentLean.spools,
      promotedByToken: token,
    });

    // "Convert to template" is the documented recovery path for exactly this
    // state — it must adopt the partial copy, not duplicate the inventory.
    const res = await promoteReq(String(parent._id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resumed).toBe(true);
    expect(body.variant.name).toBe("Carrying PLA — Steel Blue");
    expect(body.parent.spools).toEqual([]);
    expect(body.parent.color).toBeNull();
    // Completion dropped the marker atomically with the clear.
    expect(body.parent.promotionInFlight ?? null).toBeNull();

    // Exactly ONE copy; the family carries the two rolls once.
    const copies = await Filament.find({ parentId: parent._id, _deletedAt: null }).lean();
    expect(copies).toHaveLength(1);
    expect(copies[0].spools).toHaveLength(2);
    expect(
      copies[0].spools.map((s: { _id: unknown }) => String(s._id)),
    ).toEqual(parentLean.spools.map((s: { _id: unknown }) => String(s._id)));
  });

  // ── round 9 F1: gate RETRIES resume interrupted promotions too ──────────

  it("create RETRY after an interrupted promotion resumes it first (round 9 F1 / round 10 marker): 201, parent clean, refs remapped, one promotion copy", async () => {
    const PrintHistory = mongoose.models.PrintHistory;
    const Printer = mongoose.models.Printer;
    // Manufacture the interrupted state: marker stamped, promotion copy
    // created carrying the token (verbatim spool subdoc ids), but the
    // original confirmed run died before the remap and the clear — the
    // parent still carries, and external refs still point at it.
    const parent = await seedCarryingParent({ colorName: "Steel Blue" });
    const token = "gate-retry-token";
    await Filament.updateOne(
      { _id: parent._id },
      { $set: { promotionInFlight: { token, at: new Date() } } },
    );
    const parentLean = await Filament.findById(parent._id).lean();
    const partial = await Filament.create({
      name: "Carrying PLA — Steel Blue",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      color: parentLean.color,
      colorName: parentLean.colorName,
      spools: parentLean.spools,
      promotedByToken: token,
    });
    const job = await PrintHistory.create({
      jobLabel: "ref job",
      startedAt: new Date(),
      usage: [{ filamentId: parent._id, spoolId: parentLean.spools[0]._id, grams: 10 }],
    });
    const printer = await Printer.create({
      name: "AMS Printer",
      manufacturer: "Bambu Lab",
      printerModel: "X1C",
      amsSlots: [{ slotName: "A1", filamentId: parent._id, spoolId: parentLean.spools[1]._id }],
    });

    // The RETRY of the original confirmed request. Before round 9 the gate
    // skipped promotion entirely (hasVariants is true because of the partial
    // copy) and created the variant with the parent still carrying and every
    // ref still stale.
    const res = await createFilament(
      jsonReq(variantBody(parent._id, { promoteParent: true })),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).name).toBe("Carrying PLA — Red");

    // The parent ends clean, marker gone.
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBeNull();
    expect(freshParent.colorName).toBeNull();
    expect(freshParent.spools).toEqual([]);
    expect(freshParent.promotionInFlight ?? null).toBeNull();

    // External refs got their owed remap onto the adopted partial copy.
    const freshJob = await PrintHistory.findById(job._id).lean();
    expect(String(freshJob.usage[0].filamentId)).toBe(String(partial._id));
    const freshPrinter = await Printer.findById(printer._id).lean();
    expect(String(freshPrinter.amsSlots[0].filamentId)).toBe(String(partial._id));

    // Exactly ONE promotion copy — the family is the adopted copy plus the
    // requested variant, and only the copy holds the rolls (no " (2)"
    // duplicate of the inventory).
    const family = await Filament.find({ parentId: parent._id, _deletedAt: null }).lean();
    expect(family).toHaveLength(2);
    const carrying = family.filter(
      (f: { spools: unknown[] }) => (f.spools ?? []).length > 0,
    );
    expect(carrying).toHaveLength(1);
    expect(String(carrying[0]._id)).toBe(String(partial._id));
    expect(
      carrying[0].spools.map((s: { _id: unknown }) => String(s._id)),
    ).toEqual(parentLean.spools.map((s: { _id: unknown }) => String(s._id)));
  });

  it("legacy carrying template (spools, no partial copy) stays untouched on a non-first variant create — round 9 F1 enforce-forward", async () => {
    // A genuine pre-#605 legacy shape: the parent carries color+spools AND
    // has a live variant that is NOT a promotion copy (its own name, its own
    // color, none of the parent's spool subdoc ids).
    const parent = await seedCarryingParent({ colorName: "Steel Blue" });
    await Filament.create({
      name: "Carrying PLA — Mint",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      color: "#00FF88",
    });
    const parentBefore = await Filament.findById(parent._id).lean();

    const res = await createFilament(jsonReq(variantBody(parent._id)));
    expect(res.status).toBe(201);

    // Enforce-forward: the legacy parent's carried state is exactly as it
    // was — no resume fired, no promotion copy was minted.
    expect(await Filament.findById(parent._id).lean()).toEqual(parentBefore);
    expect(
      await Filament.findOne({ name: "Carrying PLA — Steel Blue" }).lean(),
    ).toBeNull();
  });

  it("legacy carrying template (no spools, promotion-style variant name) stays untouched — no marker means no resume", async () => {
    // Round 10: resume detection is marker-driven ONLY. A variant whose
    // name matches the deterministic promotion name is just a variant when
    // no promotionInFlight/promotedByToken pair exists — the parent must be
    // left exactly as-is.
    const parent = await Filament.create({
      name: "Legacy Colorful PLA",
      vendor: "V",
      type: "PLA",
      color: "#336699",
      colorName: "Steel Blue",
    });
    await Filament.create({
      name: "Legacy Colorful PLA — Steel Blue",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      color: "#FF00FF",
    });
    const parentBefore = await Filament.findById(parent._id).lean();

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Legacy Colorful PLA — Red" })),
    );
    expect(res.status).toBe(201);

    expect(await Filament.findById(parent._id).lean()).toEqual(parentBefore);
  });

  it("round 10 (the codex P1 repro): a LEGITIMATE lookalike child — auto-style name, WHOLE carried set equal — is never adopted; both inventory records survive", async () => {
    // The round-9 heuristic's failure mode: a legacy carrying template
    // whose child coincides on the deterministic promotion name AND the
    // full carried set (color / colorName / totalWeight / threshold —
    // 1000 g is the ubiquitous full-spool value, and auto-style names are
    // plausible from manual pre-#605 organizing). These are SEPARATE
    // inventory records that merely hold equal values — value equality is
    // not record identity. The old resume would have cleared the parent's
    // fields without creating the sibling that should have received them,
    // silently losing one 1000 g record. With marker-driven detection
    // there is no marker, so nothing fires.
    const parent = await Filament.create({
      name: "Legacy Stock PLA",
      vendor: "V",
      type: "PLA",
      color: "#336699",
      colorName: "Steel Blue",
      totalWeight: 1000,
      lowStockThreshold: 200,
    });
    const lookalike = await Filament.create({
      name: "Legacy Stock PLA — Steel Blue", // exactly the auto-style name
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      color: "#336699",
      colorName: "Steel Blue",
      totalWeight: 1000, // a SEPARATE full spool, coincidentally equal
      lowStockThreshold: 200,
    });
    const parentBefore = await Filament.findById(parent._id).lean();

    // A new (non-first) variant lands under the carrying template.
    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Legacy Stock PLA — Red" })),
    );
    expect(res.status).toBe(201);

    // NO resume: the parent is byte-for-byte untouched — its 1000 g record
    // included — and the lookalike keeps its own 1000 g record. Two
    // records, still two records.
    expect(await Filament.findById(parent._id).lean()).toEqual(parentBefore);
    const freshLookalike = await Filament.findById(lookalike._id).lean();
    expect(freshLookalike.totalWeight).toBe(1000);
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.totalWeight).toBe(1000);
    expect(freshParent.colorName).toBe("Steel Blue");
    expect(freshParent.lowStockThreshold).toBe(200);
  });

  // ── round 10: step-boundary interruptions, retried via gate AND /promote ─

  /** Manufacture a carrying parent frozen at a protocol step boundary.
   *  `step` 0 = marker stamped, no copy; 1 = marker + token-paired copy,
   *  refs unmapped; 2 = marker + copy + refs already remapped (the
   *  completing clear is all that's owed). Returns the pieces the
   *  assertions need. */
  async function seedInterruptedAt(step: 0 | 1 | 2, name: string) {
    const PrintHistory = mongoose.models.PrintHistory;
    const token = `boundary-token-${name}`;
    const parent = await seedCarryingParent({ name, colorName: "Steel Blue" });
    await Filament.updateOne(
      { _id: parent._id },
      { $set: { promotionInFlight: { token, at: new Date() } } },
    );
    const parentLean = await Filament.findById(parent._id).lean();
    let copy = null;
    if (step >= 1) {
      copy = await Filament.create({
        name: `${name} — Steel Blue`,
        vendor: "V",
        type: "PLA",
        parentId: parent._id,
        color: parentLean.color,
        colorName: parentLean.colorName,
        spools: parentLean.spools,
        promotedByToken: token,
      });
    }
    // An external ref that must end up on the promotion copy: still on the
    // parent at steps 0/1, already remapped at step 2.
    const refTarget = step === 2 && copy ? copy._id : parent._id;
    const job = await PrintHistory.create({
      jobLabel: "boundary job",
      startedAt: new Date(),
      usage: [{ filamentId: refTarget, spoolId: parentLean.spools[0]._id, grams: 5 }],
    });
    return { parent, parentLean, copy, job, token };
  }

  /** The shared end-state contract: exactly one promotion copy holding the
   *  rolls, parent clean, marker gone, the external ref on the copy. */
  async function expectRecovered(
    seeded: Awaited<ReturnType<typeof seedInterruptedAt>>,
    opts: { extraVariants?: number } = {},
  ) {
    const PrintHistory = mongoose.models.PrintHistory;
    const freshParent = await Filament.findById(seeded.parent._id).lean();
    expect(freshParent.color).toBeNull();
    expect(freshParent.colorName).toBeNull();
    expect(freshParent.spools).toEqual([]);
    expect(freshParent.promotionInFlight ?? null).toBeNull();

    const family = await Filament.find({
      parentId: seeded.parent._id,
      _deletedAt: null,
    }).lean();
    const carrying = family.filter(
      (f: { spools: unknown[] }) => (f.spools ?? []).length > 0,
    );
    expect(carrying).toHaveLength(1);
    expect(
      carrying[0].spools.map((s: { _id: unknown }) => String(s._id)),
    ).toEqual(seeded.parentLean.spools.map((s: { _id: unknown }) => String(s._id)));
    if (seeded.copy) {
      // Steps 1/2: the pre-existing token-paired copy was ADOPTED, not
      // duplicated.
      expect(String(carrying[0]._id)).toBe(String(seeded.copy._id));
    }
    if (opts.extraVariants != null) {
      expect(family).toHaveLength(1 + opts.extraVariants);
    }

    const freshJob = await PrintHistory.findById(seeded.job._id).lean();
    expect(String(freshJob.usage[0].filamentId)).toBe(String(carrying[0]._id));
  }

  for (const step of [0, 1, 2] as const) {
    it(`interrupted after step ${step}, retried via the CREATE gate: one copy, parent clean, marker gone`, async () => {
      const seeded = await seedInterruptedAt(step, `Gate Boundary ${step} PLA`);

      // The retry of the original confirmed request. At step 0 the parent
      // is still variant-less, so this runs the full (gated) promotion,
      // REUSING the lingering token; at steps 1/2 the gate's probe adopts
      // the token-paired copy and completes what is owed.
      const res = await createFilament(
        jsonReq(
          variantBody(seeded.parent._id, {
            name: `Gate Boundary ${step} PLA — Red`,
            promoteParent: true,
          }),
        ),
      );
      expect(res.status).toBe(201);

      // Family = the (one) promotion copy + the requested variant.
      await expectRecovered(seeded, { extraVariants: 1 });
      // The copy is paired with the run's token — at step 0 the retry
      // reused the crashed run's marker token rather than stacking.
      const carrying = await Filament.findOne({
        parentId: seeded.parent._id,
        _deletedAt: null,
        "spools.0": { $exists: true },
      }).lean();
      expect(carrying.promotedByToken).toBe(seeded.token);
    });

    it(`interrupted after step ${step}, retried via /promote: one copy, parent clean, marker gone`, async () => {
      const seeded = await seedInterruptedAt(step, `Promote Boundary ${step} PLA`);
      // /promote requires a live variant. At step 0 no copy exists yet, so
      // give the legacy template an unrelated pre-existing variant (the
      // realistic shape: the crashed run was itself a /promote on a
      // template that already had variants).
      let extraVariants = 0;
      if (step === 0) {
        await Filament.create({
          name: `Promote Boundary ${step} PLA — Mint`,
          vendor: "V",
          type: "PLA",
          parentId: seeded.parent._id,
          color: "#00FF88",
        });
        extraVariants = 1;
      }

      const res = await promoteReq(String(seeded.parent._id));
      expect(res.status).toBe(200);
      const body = await res.json();
      // Steps 1/2 adopt the existing copy (resumed); step 0 has nothing to
      // adopt — a fresh copy is created under the reused token.
      expect(body.resumed).toBe(step !== 0);

      await expectRecovered(seeded, { extraVariants });
      const carrying = await Filament.findOne({
        parentId: seeded.parent._id,
        _deletedAt: null,
        "spools.0": { $exists: true },
      }).lean();
      expect(carrying.promotedByToken).toBe(seeded.token);
    });
  }

  // ── round 10: stale markers are lazily cleared, never resumed ───────────

  it("a stale marker on a NON-carrying template is lazily cleared by a gate pass — no resume, even with a token-paired variant present", async () => {
    // The manufactured shape: a run crashed mid-protocol and the parent's
    // carried state was later cleared by hand — marker still set, a
    // token-paired variant still around, but parentPromotionState.needed
    // is false. Nothing may resume (there is nothing to move); the marker
    // is dropped as housekeeping.
    const token = "stale-token-gate";
    const parent = await Filament.create({
      name: "Stale Marker Template",
      vendor: "V",
      type: "PLA",
      color: null,
      promotionInFlight: { token, at: new Date() },
    });
    const paired = await Filament.create({
      name: "Stale Marker Template — Steel Blue",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      color: "#336699",
      totalWeight: 800,
      promotedByToken: token,
    });

    const res = await createFilament(
      jsonReq(variantBody(parent._id, { name: "Stale Marker Template — Red" })),
    );
    expect(res.status).toBe(201);

    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.promotionInFlight ?? null).toBeNull();
    // No resume side effects: the paired variant is untouched and no
    // promotion copy was minted.
    const freshPaired = await Filament.findById(paired._id).lean();
    expect(freshPaired.totalWeight).toBe(800);
    expect(freshPaired.promotedByToken).toBe(token);
    expect(
      await Filament.countDocuments({ parentId: parent._id, _deletedAt: null }),
    ).toBe(2); // the paired variant + the one just created
  });

  it("promote: a stale marker on a non-carrying template → 400 nothing_to_convert AND the marker is lazily cleared", async () => {
    const parent = await Filament.create({
      name: "Stale Marker Promote Template",
      vendor: "V",
      type: "PLA",
      color: null,
      promotionInFlight: { token: "stale-token-promote", at: new Date() },
    });
    await Filament.create({
      name: "Stale Marker Promote Template — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });

    const res = await promoteReq(String(parent._id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("nothing_to_convert");

    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.promotionInFlight ?? null).toBeNull();
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
