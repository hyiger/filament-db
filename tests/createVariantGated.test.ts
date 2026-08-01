import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  createVariantGated,
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
});
