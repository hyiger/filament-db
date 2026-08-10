import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  parentPromotionState,
  promotionVariantBaseName,
  resolvePromotionVariantName,
  performParentPromotion,
  resumePartialParentPromotion,
} from "@/lib/promoteParent";

/**
 * GH #605 Phase 2b — parent promotion helpers (src/lib/promoteParent.ts).
 *
 * The DB-backed cases run against the real Filament model (mongodb-memory-
 * server via tests/setup.ts); the copy-before-clear ordering contract is
 * pinned with a recording mock model, since order isn't observable from the
 * final DB state alone.
 */
describe("promoteParent (GH #605 Phase 2b)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;
  // The real external-ref pair (codex round 4, F1) most DB-backed cases pass.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let externalRefs: { printHistory: any; printer: any };

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const histMod = await import("@/models/PrintHistory");
    const printerMod = await import("@/models/Printer");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.PrintHistory) mongoose.model("PrintHistory", histMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    Filament = mongoose.models.Filament;
    PrintHistory = mongoose.models.PrintHistory;
    Printer = mongoose.models.Printer;
    externalRefs = { printHistory: PrintHistory, printer: Printer };
  });

  // ── parentPromotionState ────────────────────────────────────────────────

  it("parentPromotionState: color-only, spools-only, both, neither", () => {
    expect(parentPromotionState({ color: "#808080", spools: [] })).toEqual({
      needed: true,
      parentColor: "#808080",
      spoolCount: 0,
      hasColorName: false,
      hasInventoryWeight: false,
    });
    expect(parentPromotionState({ color: null, spools: [{}, {}] })).toEqual({
      needed: true,
      parentColor: null,
      spoolCount: 2,
      hasColorName: false,
      hasInventoryWeight: false,
    });
    expect(parentPromotionState({ color: "#FF0000", spools: [{}] })).toEqual({
      needed: true,
      parentColor: "#FF0000",
      spoolCount: 1,
      hasColorName: false,
      hasInventoryWeight: false,
    });
    expect(parentPromotionState({ color: null, spools: [] })).toEqual({
      needed: false,
      parentColor: null,
      spoolCount: 0,
      hasColorName: false,
      hasInventoryWeight: false,
    });
  });

  it("parentPromotionState: colorName-only and totalWeight-only parents gate too", () => {
    // A color NAME without a hex is still per-variant identity — it names
    // THIS roll's color and must move on promotion.
    expect(parentPromotionState({ color: null, colorName: "Galaxy Black", spools: [] })).toEqual({
      needed: true,
      parentColor: null,
      spoolCount: 0,
      hasColorName: true,
      hasInventoryWeight: false,
    });
    // Whitespace-only colorName is not a name.
    expect(parentPromotionState({ color: null, colorName: "   ", spools: [] })).toEqual({
      needed: false,
      parentColor: null,
      spoolCount: 0,
      hasColorName: false,
      hasInventoryWeight: false,
    });
    // A legacy inventory totalWeight is inventory — it gates.
    expect(parentPromotionState({ color: null, spools: [], totalWeight: 1250 })).toEqual({
      needed: true,
      parentColor: null,
      spoolCount: 0,
      hasColorName: false,
      hasInventoryWeight: true,
    });
  });

  it("parentPromotionState: the SPEC pair alone (spoolWeight/netFilamentWeight) does NOT gate", () => {
    // Spec describes the product line, not a roll — it belongs on the
    // template, where variants inherit it (GH #1048).
    expect(
      parentPromotionState({ color: null, spools: [], spoolWeight: 250, netFilamentWeight: 1000 }),
    ).toEqual({
      needed: false,
      parentColor: null,
      spoolCount: 0,
      hasColorName: false,
      hasInventoryWeight: false,
    });
  });

  it("parentPromotionState: lowStockThreshold alone does NOT gate (review P2 — no inventory to protect)", () => {
    // The threshold MOVES when a promotion runs (see performParentPromotion),
    // but a threshold-only parent carries nothing worth a confirmation gate.
    expect(
      parentPromotionState({ color: null, spools: [], lowStockThreshold: 200 }),
    ).toEqual({
      needed: false,
      parentColor: null,
      spoolCount: 0,
      hasColorName: false,
      hasInventoryWeight: false,
    });
  });

  it("parentPromotionState: empty-string color and missing spools count as nothing", () => {
    expect(parentPromotionState({ color: "" })).toEqual({
      needed: false,
      parentColor: null,
      spoolCount: 0,
      hasColorName: false,
      hasInventoryWeight: false,
    });
  });

  // ── promotionVariantBaseName ────────────────────────────────────────────

  it("promotionVariantBaseName: uses the colorName, trimmed; falls back to Original", () => {
    expect(promotionVariantBaseName("Overture PLA", "Galaxy Black")).toBe(
      "Overture PLA — Galaxy Black",
    );
    expect(promotionVariantBaseName("Overture PLA", "  Space Gray  ")).toBe(
      "Overture PLA — Space Gray",
    );
    expect(promotionVariantBaseName("Overture PLA", null)).toBe("Overture PLA — Original");
    expect(promotionVariantBaseName("Overture PLA", "   ")).toBe("Overture PLA — Original");
  });

  // ── resolvePromotionVariantName ─────────────────────────────────────────

  it("resolvePromotionVariantName: base name when free; (2), (3) on collisions; soft-deleted names are free", async () => {
    expect(await resolvePromotionVariantName(Filament, "Free Name")).toBe("Free Name");

    await Filament.create({ name: "Busy Name", vendor: "V", type: "PLA" });
    expect(await resolvePromotionVariantName(Filament, "Busy Name")).toBe("Busy Name (2)");

    await Filament.create({ name: "Busy Name (2)", vendor: "V", type: "PLA" });
    expect(await resolvePromotionVariantName(Filament, "Busy Name")).toBe("Busy Name (3)");

    // The unique-name index is partial (non-deleted only) — a tombstoned
    // name is genuinely free.
    await Filament.create({
      name: "Trashed Name",
      vendor: "V",
      type: "PLA",
      _deletedAt: new Date(),
    });
    expect(await resolvePromotionVariantName(Filament, "Trashed Name")).toBe("Trashed Name");
  });

  it("resolvePromotionVariantName: alsoTaken names are skipped even though not in the DB", async () => {
    expect(
      await resolvePromotionVariantName(Filament, "Reserved", new Set(["Reserved"])),
    ).toBe("Reserved (2)");
  });

  // ── performParentPromotion (real model) ─────────────────────────────────

  it("moves color/colorName/spools/totalWeight to the new variant, clears them on the parent, and leaves the SPEC pair behind", async () => {
    const parent = await Filament.create({
      name: "Legacy PLA",
      vendor: "V",
      type: "PLA",
      color: "#123456",
      colorName: "Deep Blue",
      diameter: 2.85,
      syncId: "parent-sync-1",
      totalWeight: 1250,
      lowStockThreshold: 200,
      spoolWeight: 250,
      netFilamentWeight: 1000,
      spools: [
        { label: "A", totalWeight: 900 },
        { label: "B", totalWeight: 400, retired: true },
      ],
    });
    const parentLean = await Filament.findById(parent._id).lean();

    const { variant, resumed } = await performParentPromotion(Filament, parentLean, {
      externalRefs,
    });

    // A first run is always FRESH (round 8 F2 return shape).
    expect(resumed).toBe(false);
    // The variant carries the moved state and is named by the colorName rule.
    expect(variant.name).toBe("Legacy PLA — Deep Blue");
    expect(String(variant.parentId)).toBe(String(parent._id));
    expect(variant.color).toBe("#123456");
    expect(variant.colorName).toBe("Deep Blue");
    expect(variant.totalWeight).toBe(1250);
    // Review P2: the low-stock alarm follows the inventory it watches.
    expect(variant.lowStockThreshold).toBe(200);
    // The SPEC pair is NOT copied — the variant's own fields stay blank so
    // it inherits them from the template (GH #1048).
    expect(variant.spoolWeight ?? null).toBeNull();
    expect(variant.netFilamentWeight ?? null).toBeNull();
    // Diameter pinned null → inherits the parent's 2.85 (GH #106 rule).
    expect(variant.diameter).toBeNull();

    // Spools moved VERBATIM: same data, preserved instanceId AND preserved
    // subdoc _id (codex round 4, F1). Subdoc ids only need uniqueness within
    // their parent document — and the parent's copies are cleared in the same
    // operation — so reuse keeps every persisted (filamentId, spoolId)
    // reference's spoolId half stable through the promotion.
    expect(variant.spools).toHaveLength(2);
    expect(variant.spools.map((s: { label: string }) => s.label)).toEqual(["A", "B"]);
    expect(variant.spools[1].retired).toBe(true);
    for (const [i, s] of variant.spools.entries()) {
      expect(String(s._id)).toBe(String(parentLean.spools[i]._id));
      expect(s.instanceId).toBe(parentLean.spools[i].instanceId);
    }

    // Server-owned identity never crosses documents: the variant gets its
    // own instanceId (pre-save hook) and does NOT inherit the parent's
    // syncId — the cleared parent and the new variant sync separately.
    expect(variant.instanceId).toBeTruthy();
    expect(variant.instanceId).not.toBe(parentLean.instanceId);
    expect(variant.syncId ?? null).toBeNull();
    // Round 10: the copy carries its run's token (harmless residue after
    // completion — resume also requires the parent marker, cleared below).
    expect(variant.promotedByToken).toBeTruthy();

    // Parent cleared: colorless, inventory-free — but the SPEC pair
    // (tare + nominal net weight) STAYS on the template.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBeNull();
    expect(fresh.colorName).toBeNull();
    expect(fresh.spools).toEqual([]);
    expect(fresh.totalWeight).toBeNull();
    expect(fresh.lowStockThreshold).toBeNull();
    // Round 10: completion clears the durable marker in the same write.
    expect(fresh.promotionInFlight ?? null).toBeNull();
    expect(fresh.spoolWeight).toBe(250);
    expect(fresh.netFilamentWeight).toBe(1000);
    // The parent's own untouched fields survive.
    expect(fresh.diameter).toBe(2.85);
    expect(fresh.name).toBe("Legacy PLA");

    // And the promoted variant INHERITS the spec pair live (GH #1048) —
    // the whole point of leaving it on the template.
    const { resolveFilament } = await import("@/lib/resolveFilament");
    const variantLean = await Filament.findById(variant._id).lean();
    const resolved = resolveFilament(variantLean, fresh);
    expect(resolved.spoolWeight).toBe(250);
    expect(resolved.netFilamentWeight).toBe(1000);
    expect(resolved._inherited).toContain("spoolWeight");
    expect(resolved._inherited).toContain("netFilamentWeight");
  });

  it("falls back to — Original (with collision suffix) when the parent has no colorName", async () => {
    await Filament.create({ name: "Plain PLA — Original", vendor: "V", type: "PLA" });
    const parent = await Filament.create({
      name: "Plain PLA",
      vendor: "V",
      type: "PLA",
      color: "#808080",
    });

    // Real externalRefs + a spool-less parent: the moved-set remaps are
    // self-gated off on the empty moved set (round 6 F2 moved that gate
    // inside remapExternalSpoolRefs so the Any-spool AMS remap still runs —
    // a no-op here, no printers exist).
    const { variant } = await performParentPromotion(
      Filament,
      await Filament.findById(parent._id).lean(),
      { externalRefs },
    );
    expect(variant.name).toBe("Plain PLA — Original (2)");
  });

  // ── ordering contract (mock model) ──────────────────────────────────────

  // Round 10: the two parent updateOne writes are told apart by payload —
  // the step-0 marker $sets `promotionInFlight` to an OBJECT and nothing
  // else; the completing clear $sets the moved fields (color et al.) to
  // null/empty alongside `promotionInFlight: null` + the `$inc __v`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function classifyParentWrite(update: any): "marker" | "clear" {
    return update?.$set?.color === undefined ? "marker" : "clear";
  }

  it("stamps the marker FIRST, copies SECOND, remaps external refs THIRD, completes LAST", async () => {
    const calls: string[] = [];
    const mockModel = {
      exists: async () => null,
      // Round 10: resume detection is marker-driven; this parent carries no
      // promotionInFlight, so no probe query is ever issued (findOne would
      // throw if called — the mock returning null keeps the contract loose
      // for the name resolution below, which uses exists()).
      findOne: async () => null,
      create: async (body: Record<string, unknown>) => {
        calls.push("create");
        return { ...body, _id: "variant-1" };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateOne: async (_filter: any, update: any) => {
        calls.push(classifyParentWrite(update));
        return { acknowledged: true };
      },
    };
    const mockRefs = {
      printHistory: {
        updateMany: async () => {
          calls.push("remap-history");
          return { acknowledged: true };
        },
      },
      printer: {
        // Two printer writes since round 6 F2: the moved-set remap keys on
        // `spoolId: { $in: ... }`, the Any-spool remap on `spoolId: null` —
        // tell them apart by the $elemMatch shape.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMany: async (filter: any) => {
          calls.push(
            filter?.amsSlots?.$elemMatch?.spoolId === null
              ? "remap-any-slots"
              : "remap-slots",
          );
          return { acknowledged: true };
        },
      },
    };
    // color deliberately null (spools-only promotion) — the copy still runs
    // and the ?? fallbacks stay exercised. One spool so the remap fires:
    // codex round 4 F1 pins remap BETWEEN copy and clear — a crash after the
    // copy leaves references resolving against the parent (spools still
    // there); a crash after the remap leaves them resolving against the
    // variant (which holds the spools, ids preserved). Either way nothing
    // dangles.
    await performParentPromotion(
      mockModel,
      {
        _id: "parent-1",
        name: "P",
        vendor: "V",
        type: "PLA",
        color: null,
        spools: [{ _id: "spool-1", label: "roll" }],
      },
      { externalRefs: mockRefs },
    );
    expect(calls).toEqual([
      "marker",
      "create",
      "remap-history",
      "remap-slots",
      "remap-any-slots",
      "clear",
    ]);
  });

  it("externalRefs: null (unit-test escape hatch) skips the remap entirely", async () => {
    const calls: string[] = [];
    const mockModel = {
      exists: async () => null,
      findOne: async () => null,
      create: async (body: Record<string, unknown>) => {
        calls.push("create");
        return { ...body, _id: "variant-1" };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateOne: async (_filter: any, update: any) => {
        calls.push(classifyParentWrite(update));
        return { acknowledged: true };
      },
    };
    await performParentPromotion(
      mockModel,
      {
        _id: "parent-1",
        name: "P",
        vendor: "V",
        type: "PLA",
        color: null,
        spools: [{ _id: "spool-1", label: "roll" }],
      },
      { externalRefs: null },
    );
    expect(calls).toEqual(["marker", "create", "clear"]);
  });

  it("a failed copy never clears the parent — only the non-destructive marker was written (crash-safe order)", async () => {
    const calls: string[] = [];
    const mockModel = {
      exists: async () => null,
      findOne: async () => null,
      create: async () => {
        throw new Error("boom");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateOne: async (_filter: any, update: any) => {
        calls.push(classifyParentWrite(update));
        return { acknowledged: true };
      },
    };
    await expect(
      performParentPromotion(
        mockModel,
        {
          _id: "parent-1",
          name: "P",
          vendor: "V",
          type: "PLA",
          color: "#123456",
        },
        { externalRefs: null },
      ),
    ).rejects.toThrow("boom");
    // The step-0 marker is the ONLY write that landed — reversible by
    // design (the parent still carries everything; a retried confirmed
    // promotion reuses the token, and if the state is instead cleared by
    // hand the marker is lazily dropped as stale). Never the clear.
    expect(calls).toEqual(["marker"]);
  });

  it("REUSES a lingering marker token (crashed between step 0 and the copy) instead of stacking a second marker", async () => {
    // A parent whose in-lock snapshot already carries a marker but has no
    // token-matched copy — the crash-after-step-0 shape. The retried
    // promotion must not write a new marker (no updateOne with a fresh
    // token) and must stamp the EXISTING token on the copy it creates.
    const calls: Array<{ kind: string; token?: string }> = [];
    const staleToken = "token-from-crashed-run";
    const mockModel = {
      exists: async () => null,
      // The marker-driven probe DOES query here (marker present) — no
      // matching copy exists.
      findOne: async () => null,
      create: async (body: Record<string, unknown>) => {
        calls.push({ kind: "create", token: body.promotedByToken as string });
        return { ...body, _id: "variant-1" };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateOne: async (_filter: any, update: any) => {
        calls.push({ kind: classifyParentWrite(update) });
        return { acknowledged: true };
      },
    };
    const { resumed } = await performParentPromotion(
      mockModel,
      {
        _id: "parent-1",
        name: "P",
        vendor: "V",
        type: "PLA",
        color: "#123456",
        promotionInFlight: { token: staleToken, at: new Date() },
      },
      { externalRefs: null },
    );
    expect(resumed).toBe(false);
    // No second marker write — straight to create (with the reused token),
    // then the completing clear.
    expect(calls).toEqual([
      { kind: "create", token: staleToken },
      { kind: "clear" },
    ]);
  });

  it("a MALFORMED marker (no usable token string) is treated as absent — fresh token, no resume probe", async () => {
    const calls: string[] = [];
    let probed = false;
    const mockModel = {
      exists: async () => null,
      findOne: async () => {
        probed = true;
        return null;
      },
      create: async (body: Record<string, unknown>) => {
        calls.push("create");
        expect(typeof body.promotedByToken).toBe("string");
        expect(body.promotedByToken).not.toBe("");
        return { ...body, _id: "variant-1" };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateOne: async (_filter: any, update: any) => {
        calls.push(classifyParentWrite(update));
        return { acknowledged: true };
      },
    };
    await performParentPromotion(
      mockModel,
      {
        _id: "parent-1",
        name: "P",
        vendor: "V",
        type: "PLA",
        color: "#123456",
        promotionInFlight: { token: "", at: new Date() },
      },
      { externalRefs: null },
    );
    // Nothing can match an empty token, so no probe ran and a REAL marker
    // (fresh token) was stamped before the copy.
    expect(probed).toBe(false);
    expect(calls).toEqual(["marker", "create", "clear"]);
  });

  it("the clear bumps __v so a stale positional spool save VersionErrors instead of phantom-writing onto the template (codex round 3 sweep)", async () => {
    // A hydrated doc loaded BEFORE the promotion, holding a positional
    // modification to an existing spool — the shape of the print-history
    // debit/refund saves and a CSV import's update-only bucket. Without the
    // clear's `$inc __v`, save()'s VERSION_WHERE filter still matches the
    // promoted parent and $sets `spools.0.totalWeight` onto the cleared
    // array, materializing a phantom spool fragment on the template
    // (verified by repro). With the bump it VersionErrors — the conflict
    // path every one of those callers already handles.
    const parent = await Filament.create({
      name: "Version Bump Parent",
      vendor: "V",
      type: "PLA",
      color: "#336699",
      spools: [{ label: "roll", totalWeight: 1000 }],
    });
    const stale = await Filament.findById(parent._id);
    stale.spools[0].totalWeight = 500;

    await performParentPromotion(Filament, parent.toObject(), { externalRefs });

    await expect(stale.save()).rejects.toMatchObject({ name: "VersionError" });
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.spools).toHaveLength(0); // template stayed clean
    // The inventory lives (only) on the promoted variant, unchanged.
    const variant = await Filament.findOne({ parentId: parent._id }).lean();
    expect(variant.spools).toHaveLength(1);
    expect(variant.spools[0].totalWeight).toBe(1000);
  });

  // ── codex round 4, F1: external (filamentId, spoolId) refs follow ───────

  it("remaps PrintHistory usage + Printer AMS slots onto the promoted variant; entries outside the moved set are untouched", async () => {
    const parent = await Filament.create({
      name: "Referenced PLA",
      vendor: "V",
      type: "PLA",
      color: "#445566",
      spools: [
        { label: "in history", totalWeight: 900 },
        { label: "in AMS", totalWeight: 400 },
      ],
    });
    const other = await Filament.create({
      name: "Bystander PETG",
      vendor: "V",
      type: "PETG",
      spools: [{ label: "bystander roll", totalWeight: 750 }],
    });
    const parentLean = await Filament.findById(parent._id).lean();
    const otherLean = await Filament.findById(other._id).lean();
    const historySpool = parentLean.spools[0];
    const amsSpool = parentLean.spools[1];
    const bystanderSpool = otherLean.spools[0];

    const job = await PrintHistory.create({
      jobLabel: "multi-material job",
      usage: [
        // Follows: parent's filamentId + a moved spoolId.
        { filamentId: parent._id, spoolId: historySpool._id, grams: 12 },
        // Untouched: a different filament's entry (spoolId NOT in the moved set).
        { filamentId: other._id, spoolId: bystanderSpool._id, grams: 5 },
        // Untouched: the parent without a tracked spool — spoolId null is
        // not in the moved set, so the job row keeps pointing at the parent.
        // Deliberate, and NOT symmetric with the AMS Any-spool slot below
        // (codex round 6, F2): history is a BACKWARD-looking record of what
        // was consumed under that name at the time, while an AMS slot is a
        // FORWARD-looking assignment that must follow where the inventory
        // now lives.
        { filamentId: parent._id, spoolId: null, grams: 3 },
      ],
      startedAt: new Date(),
    });
    const printer = await Printer.create({
      name: "AMS Printer",
      manufacturer: "Bambu Lab",
      printerModel: "X1C",
      amsSlots: [
        { slotName: "A1", filamentId: parent._id, spoolId: amsSpool._id },
        { slotName: "A2", filamentId: other._id, spoolId: bystanderSpool._id },
        // "Any spool" of the parent — filament-only assignment, follows the
        // promotion (codex round 6, F2).
        { slotName: "A3", filamentId: parent._id, spoolId: null },
        // "Any spool" of a DIFFERENT filament — untouched.
        { slotName: "A4", filamentId: other._id, spoolId: null },
      ],
    });

    const { variant } = await performParentPromotion(Filament, parentLean, {
      externalRefs,
    });

    const freshJob = await PrintHistory.findById(job._id).lean();
    expect(String(freshJob.usage[0].filamentId)).toBe(String(variant._id));
    expect(String(freshJob.usage[0].spoolId)).toBe(String(historySpool._id));
    expect(String(freshJob.usage[1].filamentId)).toBe(String(other._id));
    expect(String(freshJob.usage[1].spoolId)).toBe(String(bystanderSpool._id));
    expect(String(freshJob.usage[2].filamentId)).toBe(String(parent._id));
    expect(freshJob.usage[2].spoolId).toBeNull();

    const freshPrinter = await Printer.findById(printer._id).lean();
    expect(String(freshPrinter.amsSlots[0].filamentId)).toBe(String(variant._id));
    expect(String(freshPrinter.amsSlots[0].spoolId)).toBe(String(amsSpool._id));
    expect(String(freshPrinter.amsSlots[1].filamentId)).toBe(String(other._id));
    // Round 6 F2: the parent's Any-spool slot now points at the promoted
    // variant ("any spool of the parent" is dead on an inventory-less
    // template); it stays an Any-spool assignment (spoolId null).
    expect(String(freshPrinter.amsSlots[2].filamentId)).toBe(String(variant._id));
    expect(freshPrinter.amsSlots[2].spoolId).toBeNull();
    // A different filament's Any-spool slot is untouched.
    expect(String(freshPrinter.amsSlots[3].filamentId)).toBe(String(other._id));
    expect(freshPrinter.amsSlots[3].spoolId).toBeNull();

    // And the (filamentId, spoolId) pairs the remap produced actually
    // resolve: the promoted variant holds those spool subdoc ids.
    const variantLean = await Filament.findById(variant._id).lean();
    const variantSpoolIds = variantLean.spools.map((s: { _id: unknown }) => String(s._id));
    expect(variantSpoolIds).toContain(String(historySpool._id));
    expect(variantSpoolIds).toContain(String(amsSpool._id));
  });

  it("an Any-spool AMS slot follows a color-only promotion with ZERO moved spools (codex round 6, F2)", async () => {
    // The moved set is empty, so before round 6 the whole remap was skipped
    // and the slot kept pointing at the (now inventory-less) template.
    const parent = await Filament.create({
      name: "Colorful Spool-less PLA",
      vendor: "V",
      type: "PLA",
      color: "#AA00AA",
    });
    const printer = await Printer.create({
      name: "Any-Slot Printer",
      manufacturer: "Prusa",
      printerModel: "XL",
      amsSlots: [{ slotName: "T1", filamentId: parent._id, spoolId: null }],
    });

    const { variant } = await performParentPromotion(
      Filament,
      await Filament.findById(parent._id).lean(),
      { externalRefs },
    );

    const freshPrinter = await Printer.findById(printer._id).lean();
    expect(String(freshPrinter.amsSlots[0].filamentId)).toBe(String(variant._id));
    expect(freshPrinter.amsSlots[0].spoolId).toBeNull();
  });

  it("spool-addressed routes still resolve after a promotion (assignment lookup + spool deep-link resolve)", async () => {
    const parent = await Filament.create({
      name: "Loaded PLA",
      vendor: "V",
      type: "PLA",
      color: "#654321",
      spools: [{ label: "loaded roll", totalWeight: 800 }],
    });
    const parentLean = await Filament.findById(parent._id).lean();
    const spoolId = String(parentLean.spools[0]._id);
    await Printer.create({
      name: "MMU Printer",
      manufacturer: "Prusa",
      printerModel: "MK4",
      amsSlots: [{ slotName: "T0", filamentId: parent._id, spoolId }],
    });

    const { variant } = await performParentPromotion(Filament, parentLean, {
      externalRefs,
    });

    // GET /api/spools/{spoolId}/assignment — the slot lookup keys on the
    // preserved spool subdoc id and now reports the variant as loaded.
    const { findSpoolSlot } = await import("@/lib/spoolSlots");
    const assignment = await findSpoolSlot(Printer, spoolId);
    expect(assignment).not.toBeNull();
    expect(assignment?.slotName).toBe("T0");
    expect(assignment?.filamentId).toBe(String(variant._id));

    // GET /api/spools/{spoolId} — the label deep-link resolver finds the
    // spool by subdoc id on the VARIANT (the parent's copy is cleared).
    const { GET: resolveSpool } = await import("@/app/api/spools/[spoolId]/route");
    const { NextRequest } = await import("next/server");
    const res = await resolveSpool(
      new NextRequest(`http://localhost/api/spools/${spoolId}`),
      { params: Promise.resolve({ spoolId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(String(body.filament._id)).toBe(String(variant._id));
    expect(String(body.spool._id)).toBe(spoolId);

    // Round 7 P2: a label PRINTED against the parent id self-heals from that
    // resolver answer — the healed href is the variant's page with ?spool=
    // preserved (full flow pinned in tests/spoolDeepLink.test.ts).
    const { healedSpoolDeepLinkHref } = await import("@/lib/spoolDeepLink");
    expect(
      healedSpoolDeepLinkHref(
        String(parent._id),
        String(body.filament._id),
        `?spool=${spoolId}`,
      ),
    ).toBe(`/filaments/${variant._id}?spool=${spoolId}`);
  });

  // ── round 8 F2 / round 10: interrupted promotions resume off the marker ─

  it("interrupted at the REMAP (spools case): the retry resumes the marker-paired partial copy — one copy, parent clean, marker gone", async () => {
    const parent = await Filament.create({
      name: "Interrupted PLA",
      vendor: "V",
      type: "PLA",
      color: "#246810",
      colorName: "Forest",
      totalWeight: 1100,
      spools: [
        { label: "roll A", totalWeight: 700 },
        { label: "roll B", totalWeight: 400 },
      ],
    });
    const parentLean = await Filament.findById(parent._id).lean();
    const spoolIds = parentLean.spools.map((s: { _id: unknown }) => String(s._id));
    const job = await PrintHistory.create({
      jobLabel: "ref job",
      startedAt: new Date(),
      usage: [{ filamentId: parent._id, spoolId: parentLean.spools[0]._id, grams: 10 }],
    });

    // External refs whose FIRST remap throws — the crash window between the
    // create and the clear.
    let threw = false;
    const flakyRefs = {
      printHistory: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMany: async (...args: any[]) => {
          if (!threw) {
            threw = true;
            throw new Error("interrupted after create");
          }
          return PrintHistory.updateMany(...args);
        },
      },
      printer: Printer,
    };

    await expect(
      performParentPromotion(Filament, parentLean, { externalRefs: flakyRefs }),
    ).rejects.toThrow("interrupted after create");

    // The interrupted state: the durable marker is stamped on the parent,
    // the partial copy exists (same spool subdoc ids) carrying the matching
    // token, the parent still carries, and the history ref still points at
    // the parent.
    const midParent = await Filament.findById(parent._id).lean();
    expect(midParent.spools).toHaveLength(2);
    expect(midParent.promotionInFlight?.token).toBeTruthy();
    const midCopies = await Filament.find({ parentId: parent._id, _deletedAt: null }).lean();
    expect(midCopies).toHaveLength(1);
    expect(midCopies[0].promotedByToken).toBe(midParent.promotionInFlight.token);

    // RETRY the same promotion off a fresh in-lock-style snapshot.
    const { variant, resumed } = await performParentPromotion(
      Filament,
      await Filament.findById(parent._id).lean(),
      { externalRefs: flakyRefs },
    );
    expect(resumed).toBe(true);

    // Exactly ONE copy — no " (2)" duplicate holding a second set of rolls.
    const copies = await Filament.find({ parentId: parent._id, _deletedAt: null }).lean();
    expect(copies).toHaveLength(1);
    expect(String(copies[0]._id)).toBe(String(variant._id));
    expect(copies[0].name).toBe("Interrupted PLA — Forest");
    expect(copies[0].spools.map((s: { _id: unknown }) => String(s._id))).toEqual(spoolIds);
    expect(copies[0].totalWeight).toBe(1100);

    // Parent ends clean — marker gone (cleared atomically with the fields)
    // — and the remap DID run on the retry.
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBeNull();
    expect(freshParent.colorName).toBeNull();
    expect(freshParent.spools).toEqual([]);
    expect(freshParent.totalWeight).toBeNull();
    expect(freshParent.promotionInFlight ?? null).toBeNull();
    const freshJob = await PrintHistory.findById(job._id).lean();
    expect(String(freshJob.usage[0].filamentId)).toBe(String(variant._id));
  });

  it("interrupted at the CLEAR (no-spools case): the retry resumes off the marker/token pair — no ' (2)' copy, marker gone", async () => {
    const parent = await Filament.create({
      name: "Colorful Interrupted PLA",
      vendor: "V",
      type: "PLA",
      color: "#AB34CD",
      colorName: "Orchid",
      lowStockThreshold: 150,
    });
    const parentLean = await Filament.findById(parent._id).lean();

    // A delegating model whose COMPLETING clear throws — the step-0 marker
    // write, the create, and the remap all succeeded. The two parent
    // updateOne writes are told apart by payload: only the completing clear
    // carries the `$inc __v`.
    let clearThrew = false;
    const flakyModel = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exists: (...args: any[]) => Filament.exists(...args),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findOne: (...args: any[]) => Filament.findOne(...args),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (...args: any[]) => Filament.create(...args),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateOne: async (...args: any[]) => {
        if (!clearThrew && args[1]?.$inc?.__v != null) {
          clearThrew = true;
          throw new Error("interrupted at clear");
        }
        return Filament.updateOne(...args);
      },
    };

    await expect(
      performParentPromotion(flakyModel, parentLean, { externalRefs }),
    ).rejects.toThrow("interrupted at clear");

    // Partial copy exists carrying the parent's marker token; the parent
    // still carries its color pair.
    const midParent = await Filament.findById(parent._id).lean();
    expect(midParent.color).toBe("#AB34CD");
    expect(midParent.promotionInFlight?.token).toBeTruthy();
    const midCopies = await Filament.find({ parentId: parent._id, _deletedAt: null }).lean();
    expect(midCopies).toHaveLength(1);
    expect(midCopies[0].promotedByToken).toBe(midParent.promotionInFlight.token);

    const { variant, resumed } = await performParentPromotion(
      Filament,
      await Filament.findById(parent._id).lean(),
      { externalRefs },
    );
    expect(resumed).toBe(true);

    const copies = await Filament.find({ parentId: parent._id, _deletedAt: null }).lean();
    expect(copies).toHaveLength(1);
    expect(String(copies[0]._id)).toBe(String(variant._id));
    expect(copies[0].name).toBe("Colorful Interrupted PLA — Orchid");
    expect(copies[0].color).toBe("#AB34CD");
    expect(copies[0].lowStockThreshold).toBe(150);

    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBeNull();
    expect(freshParent.colorName).toBeNull();
    expect(freshParent.lowStockThreshold).toBeNull();
    expect(freshParent.promotionInFlight ?? null).toBeNull();
  });

  it("resumePartialParentPromotion tolerates a marker-bearing parent snapshot without a spools array and null externalRefs (mock)", async () => {
    // Defensive-shape pin: a lean snapshot missing `spools` (Mongoose
    // always materializes it, but the helper takes loose docs) resumes with
    // an empty moved set; `externalRefs: null` (the unit-test escape hatch)
    // skips the remap and still completes.
    const calls: string[] = [];
    const mockModel = {
      findOne: async () => ({ _id: "copy-1", promotedByToken: "t-1" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateOne: async (_filter: any, update: any) => {
        expect(update.$set.promotionInFlight).toBeNull();
        expect(update.$inc.__v).toBe(1);
        calls.push("clear");
        return { acknowledged: true };
      },
    };
    const partial = await resumePartialParentPromotion(
      mockModel,
      {
        _id: "parent-1",
        name: "P",
        promotionInFlight: { token: "t-1", at: new Date() },
      },
      null,
    );
    expect(partial).toEqual({ _id: "copy-1", promotedByToken: "t-1" });
    expect(calls).toEqual(["clear"]);
  });

  it("a genuine SECOND promotion after a COMPLETED one (parent re-acquired state) still creates a fresh suffixed copy", async () => {
    const parent = await Filament.create({
      name: "Twice Promoted PLA",
      vendor: "V",
      type: "PLA",
      color: "#111111",
      colorName: "Coal",
      spools: [{ label: "first roll", totalWeight: 900 }],
    });
    const first = await performParentPromotion(
      Filament,
      await Filament.findById(parent._id).lean(),
      { externalRefs },
    );
    expect(first.resumed).toBe(false);
    expect(first.variant.name).toBe("Twice Promoted PLA — Coal");
    // Completion cleared the marker atomically with the moved fields.
    const afterFirst = await Filament.findById(parent._id).lean();
    expect(afterFirst.promotionInFlight ?? null).toBeNull();

    // The parent re-acquires carrying state (legacy/direct write — NEW spool
    // subdocs, so the ids don't overlap the completed promotion's copy).
    await Filament.updateOne(
      { _id: parent._id },
      {
        $set: {
          color: "#111111",
          colorName: "Coal",
          spools: [{ label: "re-acquired roll", totalWeight: 600 }],
        },
      },
    );

    const second = await performParentPromotion(
      Filament,
      await Filament.findById(parent._id).lean(),
      { externalRefs },
    );
    // Fresh, not resumed: the first promotion's marker is long gone, so
    // there is no proof to resume off — and the base name is taken.
    expect(second.resumed).toBe(false);
    expect(second.variant.name).toBe("Twice Promoted PLA — Coal (2)");
    expect(String(second.variant._id)).not.toBe(String(first.variant._id));

    // Both copies hold exactly their own inventory; each run minted its own
    // token; the parent is clean and unmarked.
    const copies = await Filament.find({ parentId: parent._id, _deletedAt: null }).lean();
    expect(copies).toHaveLength(2);
    const tokens = copies.map((c: { promotedByToken: string | null }) => c.promotedByToken);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).toBeTruthy();
    expect(tokens[0]).not.toBe(tokens[1]);
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.spools).toEqual([]);
    expect(freshParent.color).toBeNull();
    expect(freshParent.promotionInFlight ?? null).toBeNull();
  });
});
