import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  createVariantGated,
  gateFirstVariantAdoption,
  promotionRequired409Body,
} from "@/lib/createVariantGated";
import { lockedKeyCount, runExclusive, filamentLockKey } from "@/lib/filamentMutex";

/**
 * GH #605 (codex round 3, Finding A) — the shared, race-hardened variant
 * creation gate (src/lib/createVariantGated.ts), factored out of
 * POST /api/filaments so the OpenPrintTag variant import enforces identical
 * semantics. Route-level behavior is pinned by
 * tests/template-promotion-route.test.ts (filament create) and
 * tests/opt-resync-route.test.ts (OPT variant import); this file covers the
 * lib's own contract against the real Filament model (mongodb-memory-server
 * via tests/setup.ts).
 */
describe("createVariantGated (GH #605, codex round 3)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  async function seedCarryingParent(extra: Record<string, unknown> = {}) {
    return Filament.create({
      name: "Gated Parent",
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
      name: "Gated Parent — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: String(parentId),
      ...extra,
    };
  }

  // ── promotion_required ────────────────────────────────────────────────

  it("first variant of a carrying parent without the flag → promotion_required, nothing written", async () => {
    const parent = await seedCarryingParent();
    const result = await createVariantGated(Filament, parent._id, variantBody(parent._id), false);
    expect(result).toEqual({
      outcome: "promotion_required",
      parentName: "Gated Parent",
      parentColor: "#336699",
      spoolCount: 2,
      variantName: "Gated Parent — Original",
    });
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
  });

  it("the reported variantName respects the parent's colorName and never squats on the requested name", async () => {
    const parent = await seedCarryingParent({ colorName: "Steel Blue" });
    const result = await createVariantGated(
      Filament,
      parent._id,
      variantBody(parent._id, { name: "Gated Parent — Steel Blue" }),
      false,
    );
    expect(result.outcome).toBe("promotion_required");
    if (result.outcome === "promotion_required") {
      expect(result.variantName).toBe("Gated Parent — Steel Blue (2)");
    }
  });

  it("a nameless body still gates (alsoTaken is simply absent)", async () => {
    const parent = await seedCarryingParent();
    // No `name` on the body: the gate must not crash building the
    // alsoTaken set; the eventual create would fail validation, but the
    // unconfirmed request never gets that far.
    const result = await createVariantGated(
      Filament,
      parent._id,
      { vendor: "V", type: "PLA", parentId: String(parent._id) },
      false,
    );
    expect(result.outcome).toBe("promotion_required");
    if (result.outcome === "promotion_required") {
      expect(result.variantName).toBe("Gated Parent — Original");
    }
  });

  // ── confirmed promotion ───────────────────────────────────────────────

  it("promoteParent: true → promoted copy first, parent cleared, variant created", async () => {
    const parent = await seedCarryingParent();
    const result = await createVariantGated(Filament, parent._id, variantBody(parent._id), true);
    expect(result.outcome).toBe("created");

    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color ?? null).toBeNull();
    expect(freshParent.spools).toHaveLength(0);

    const promoted = await Filament.findOne({ name: "Gated Parent — Original" }).lean();
    expect(promoted).toBeTruthy();
    expect(String(promoted.parentId)).toBe(String(parent._id));
    expect(promoted.color).toBe("#336699");
    expect(promoted.spools).toHaveLength(2);

    if (result.outcome === "created") {
      expect(String(result.filament.parentId)).toBe(String(parent._id));
      expect(result.filament.name).toBe("Gated Parent — Red");
    }
  });

  it("confirmed but duplicate-named request → name_taken BEFORE any mutation", async () => {
    const parent = await seedCarryingParent();
    await Filament.create({ name: "Gated Parent — Red", vendor: "W", type: "PLA" });
    const result = await createVariantGated(Filament, parent._id, variantBody(parent._id), true);
    expect(result).toEqual({ outcome: "name_taken", name: "Gated Parent — Red" });
    // The parent was NOT promoted.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
    expect(await Filament.exists({ name: "Gated Parent — Original" })).toBeNull();
  });

  it("confirmed but schema-invalid request → the dry-run rejects with the parent untouched", async () => {
    const parent = await seedCarryingParent();
    await expect(
      createVariantGated(
        Filament,
        parent._id,
        variantBody(parent._id, { color: "not-a-hex" }),
        true,
      ),
    ).rejects.toThrow();
    // No promotion happened — the validation ran BEFORE the side effect.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
    expect(await Filament.exists({ name: "Gated Parent — Original" })).toBeNull();
  });

  // ── no gate needed ────────────────────────────────────────────────────

  it("a non-carrying parent creates straight through, flag or no flag", async () => {
    const parent = await Filament.create({
      name: "Clean Parent",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    const result = await createVariantGated(
      Filament,
      parent._id,
      { name: "Clean Parent — Red", vendor: "V", type: "PLA", parentId: String(parent._id) },
      false,
    );
    expect(result.outcome).toBe("created");
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(1);
  });

  it("the SECOND variant of a (legacy, still-carrying) template skips the gate", async () => {
    const parent = await seedCarryingParent();
    await Filament.create({
      name: "Gated Parent — Existing",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
    });
    const result = await createVariantGated(Filament, parent._id, variantBody(parent._id), false);
    expect(result.outcome).toBe("created");
    // Enforce-forward: the legacy carrying state stays put — no silent move.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
  });

  it("parent vanished before the lock → parent_not_found", async () => {
    const parent = await seedCarryingParent();
    await Filament.updateOne({ _id: parent._id }, { $set: { _deletedAt: new Date() } });
    const result = await createVariantGated(Filament, parent._id, variantBody(parent._id), false);
    expect(result).toEqual({ outcome: "parent_not_found" });
  });

  // ── serialization ─────────────────────────────────────────────────────

  it("runs inside the parent's keyed mutex (a held lock delays the gate) and drains it", async () => {
    const parent = await seedCarryingParent();
    const key = filamentLockKey(parent._id);

    let release!: () => void;
    const holdUntil = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const holder = runExclusive(key, async () => {
      order.push("holder");
      await holdUntil;
    });

    const gated = createVariantGated(Filament, parent._id, variantBody(parent._id), false).then(
      (r) => {
        order.push("gate");
        return r;
      },
    );

    // Give the gate a chance to (incorrectly) run ahead.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["holder"]);

    release();
    const result = await gated;
    await holder;
    expect(result.outcome).toBe("promotion_required");
    expect(order).toEqual(["holder", "gate"]);
    expect(lockedKeyCount()).toBe(0);
  });

  it("decides off the in-lock re-fetch, not the caller's stale snapshot", async () => {
    // The caller (route) validated the parent while it was still clean; a
    // spool lands before the gate runs. The gate must see the spool and
    // demand the promotion.
    const parent = await Filament.create({
      name: "Fresh Snapshot Parent",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    await Filament.updateOne(
      { _id: parent._id },
      { $push: { spools: { label: "late roll", totalWeight: 500 } } },
    );
    const result = await createVariantGated(
      Filament,
      parent._id,
      { name: "Fresh Snapshot — Red", vendor: "V", type: "PLA", parentId: String(parent._id) },
      false,
    );
    expect(result.outcome).toBe("promotion_required");
    if (result.outcome === "promotion_required") {
      expect(result.spoolCount).toBe(1);
    }
  });

  // ── promotionRequired409Body ──────────────────────────────────────────

  it("promotionRequired409Body: the exact payload shape both routes return", () => {
    const body = promotionRequired409Body({
      parentName: "P",
      parentColor: "#112233",
      spoolCount: 3,
      variantName: "P — Original",
    });
    expect(body).toEqual({
      error: "parent_promotion_required",
      message:
        'Creating the first variant makes "P" a template: its color and 3 spool(s) ' +
        'move to a new variant named "P — Original". Repeat the request with ' +
        "promoteParent: true to confirm.",
      parentName: "P",
      parentColor: "#112233",
      spoolCount: 3,
      variantName: "P — Original",
    });
  });

  // ── gateFirstVariantAdoption (codex round 4, F2/F6) ───────────────────

  it("adoption: carrying variant-less parent without the flag → promotion_required, onReady never runs", async () => {
    const parent = await seedCarryingParent();
    let readyRan = false;
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: false,
      adoptedName: "Adopted Standalone",
      onReady: async () => {
        readyRan = true;
      },
    });
    expect(result).toEqual({
      outcome: "promotion_required",
      parentName: "Gated Parent",
      parentColor: "#336699",
      spoolCount: 2,
      variantName: "Gated Parent — Original",
    });
    expect(readyRan).toBe(false);
    // Nothing written.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
  });

  it("adoption: promoteParent: true → parent promoted, then onReady runs while the parent's lock is still held", async () => {
    const parent = await seedCarryingParent();
    let lockedDuringReady = -1;
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: true,
      adoptedName: "Adopted Standalone",
      onReady: async () => {
        // In-lock execution: the parent's key still holds its chain entry.
        lockedDuringReady = lockedKeyCount();
      },
    });
    expect(result).toEqual({ outcome: "ready", clearOrphanedThreshold: false });
    expect(lockedDuringReady).toBe(1);
    expect(lockedKeyCount()).toBe(0); // drained after settlement

    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color ?? null).toBeNull();
    expect(fresh.spools).toHaveLength(0);
    const promoted = await Filament.findOne({ name: "Gated Parent — Original" }).lean();
    expect(promoted).toBeTruthy();
    expect(promoted.color).toBe("#336699");
    expect(promoted.spools).toHaveLength(2);
  });

  it("adoption: the promotion copy never squats on the adopted document's name", async () => {
    const parent = await seedCarryingParent({ colorName: "Original" });
    // The reviving/re-parented doc is ALREADY named exactly what the copy
    // would take ("Gated Parent — Original") — e.g. a trashed promotion
    // copy being restored. adoptedName reserves it.
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: true,
      adoptedName: "Gated Parent — Original",
    });
    expect(result).toEqual({ outcome: "ready", clearOrphanedThreshold: false });
    const promoted = await Filament.findOne({ name: "Gated Parent — Original (2)" }).lean();
    expect(promoted).toBeTruthy();
    expect(promoted.color).toBe("#336699");
  });

  it("adoption: a non-carrying parent is ready straight through (onReady runs, no promotion copy)", async () => {
    const parent = await Filament.create({
      name: "Clean Adoption Parent",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    let readyRan = false;
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: false,
      onReady: async () => {
        readyRan = true;
      },
    });
    expect(result).toEqual({ outcome: "ready", clearOrphanedThreshold: false });
    expect(readyRan).toBe(true);
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
  });

  it("adoption: a carrying parent that ALREADY has a live variant skips the gate (enforce-forward)", async () => {
    const parent = await seedCarryingParent();
    await Filament.create({
      name: "Gated Parent — Existing",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
    });
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: false,
    });
    expect(result).toEqual({ outcome: "ready", clearOrphanedThreshold: false });
    // The legacy carrying state stays put — no silent move.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
  });

  it("adoption: parent vanished before the lock → parent_not_found (onReady never runs)", async () => {
    const parent = await seedCarryingParent();
    await Filament.updateOne({ _id: parent._id }, { $set: { _deletedAt: new Date() } });
    let readyRan = false;
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: true,
      onReady: async () => {
        readyRan = true;
      },
    });
    expect(result).toEqual({ outcome: "parent_not_found" });
    expect(readyRan).toBe(false);
  });

  it("adoption: checkHasVariants is injectable (a stub reporting a variant suppresses the gate)", async () => {
    const parent = await seedCarryingParent();
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: false,
      checkHasVariants: async () => true,
    });
    expect(result).toEqual({ outcome: "ready", clearOrphanedThreshold: false });
  });

  it("adoption: serializes on the parent's keyed mutex like the creation gate", async () => {
    const parent = await seedCarryingParent();
    const key = filamentLockKey(parent._id);

    let release!: () => void;
    const holdUntil = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const holder = runExclusive(key, async () => {
      order.push("holder");
      await holdUntil;
    });

    const gated = gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: false,
    }).then((r) => {
      order.push("gate");
      return r;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["holder"]);

    release();
    const result = await gated;
    await holder;
    expect(result.outcome).toBe("promotion_required");
    expect(order).toEqual(["holder", "gate"]);
    expect(lockedKeyCount()).toBe(0);
  });

  // ── round 7 P2: orphaned lowStockThreshold on ungated first variants ────

  async function seedThresholdOnlyParent(name = "Threshold Parent") {
    return Filament.create({
      name,
      vendor: "V",
      type: "PLA",
      color: null,
      lowStockThreshold: 200,
    });
  }

  it("threshold-only parent: ungated first-variant CREATE clears the parent's dead threshold (variant gets none)", async () => {
    const parent = await seedThresholdOnlyParent();
    const result = await createVariantGated(
      Filament,
      parent._id,
      { name: "Threshold Parent — Red", vendor: "V", type: "PLA", parentId: String(parent._id) },
      false, // no confirmation needed — nothing gates
    );
    expect(result.outcome).toBe("created");
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBeNull();
    // The threshold is NOT moved to the variant — it's a new filament, not
    // a copy — and no promotion sibling was spawned.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = (result as any).filament;
    expect(created.lowStockThreshold ?? null).toBeNull();
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(1);
  });

  it("threshold-only parent: a FAILED create leaves the threshold intact (parent state change last)", async () => {
    const parent = await seedThresholdOnlyParent("Doomed Threshold Parent");
    // A schema-invalid body: create() itself rejects, so the error surfaces
    // BEFORE the clear step — the parent must keep its threshold.
    await expect(
      createVariantGated(
        Filament,
        parent._id,
        {
          name: "Doomed Threshold Parent — Bad",
          vendor: "V",
          type: "PLA",
          color: "not-a-hex",
          parentId: String(parent._id),
        },
        false,
      ),
    ).rejects.toMatchObject({ name: "ValidationError" });
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBe(200);
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
  });

  it("SECOND-variant creation never touches a template's leftover threshold", async () => {
    const parent = await seedThresholdOnlyParent("Legacy Threshold Template");
    await Filament.create({
      name: "Legacy Threshold Template — Existing",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
    });
    const result = await createVariantGated(
      Filament,
      parent._id,
      {
        name: "Legacy Threshold Template — Second",
        vendor: "V",
        type: "PLA",
        parentId: String(parent._id),
      },
      false,
    );
    expect(result.outcome).toBe("created");
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBe(200);
  });

  it("a SPEC-only parent (tare/net) is untouched by an ungated first variant", async () => {
    const parent = await Filament.create({
      name: "Spec Only Parent",
      vendor: "V",
      type: "PLA",
      color: null,
      spoolWeight: 250,
      netFilamentWeight: 1000,
    });
    const result = await createVariantGated(
      Filament,
      parent._id,
      { name: "Spec Only Parent — Red", vendor: "V", type: "PLA", parentId: String(parent._id) },
      false,
    );
    expect(result.outcome).toBe("created");
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.spoolWeight).toBe(250);
    expect(fresh.netFilamentWeight).toBe(1000);
    expect(fresh.lowStockThreshold ?? null).toBeNull();
  });

  it("a CARRYING promotion still MOVES the threshold with the inventory — never orphan-cleared", async () => {
    const parent = await seedCarryingParent({ lowStockThreshold: 300 });
    const result = await createVariantGated(
      Filament,
      parent._id,
      variantBody(parent._id),
      true,
    );
    expect(result.outcome).toBe("created");
    const promoted = await Filament.findOne({ name: "Gated Parent — Original" }).lean();
    expect(promoted.lowStockThreshold).toBe(300);
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBeNull();
  });

  it("adoption with onReady (restore shape): the gate clears the threshold in-lock AFTER the adoption write", async () => {
    const parent = await seedThresholdOnlyParent("Adopting Threshold Parent");
    // A trashed variant about to be revived — the onReady write.
    const trashed = await Filament.create({
      name: "Adopting Threshold Parent — Revived",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
    });
    await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });
    let thresholdWhenReadyRan: number | null | undefined;
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: false,
      adoptedName: trashed.name,
      onReady: async () => {
        // Ordering pin: at write time the threshold is still there — the
        // clear is strictly AFTER the variant exists.
        const mid = await Filament.findById(parent._id).lean();
        thresholdWhenReadyRan = mid.lowStockThreshold;
        await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: null } });
      },
    });
    expect(result).toEqual({ outcome: "ready", clearOrphanedThreshold: false });
    expect(thresholdWhenReadyRan).toBe(200);
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBeNull();
  });

  it("adoption without onReady (PUT shape): the gate reports clearOrphanedThreshold and does NOT clear itself", async () => {
    const parent = await seedThresholdOnlyParent("Deferred Threshold Parent");
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: false,
    });
    expect(result).toEqual({ outcome: "ready", clearOrphanedThreshold: true });
    // The caller owns the write AND the clear — nothing mutated yet.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBe(200);
  });

  it("adoption under a threshold-carrying template that already HAS a variant: no clear flag, threshold untouched", async () => {
    const parent = await seedThresholdOnlyParent("Populated Threshold Template");
    await Filament.create({
      name: "Populated Threshold Template — Live",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
    });
    const result = await gateFirstVariantAdoption(Filament, parent._id, {
      promoteParent: false,
    });
    expect(result).toEqual({ outcome: "ready", clearOrphanedThreshold: false });
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.lowStockThreshold).toBe(200);
  });
});
