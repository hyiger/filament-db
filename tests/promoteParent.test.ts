import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  parentPromotionState,
  promotionVariantBaseName,
  resolvePromotionVariantName,
  performParentPromotion,
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

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  // ── parentPromotionState ────────────────────────────────────────────────

  it("parentPromotionState: color-only, spools-only, both, neither", () => {
    expect(parentPromotionState({ color: "#808080", spools: [] })).toEqual({
      needed: true,
      parentColor: "#808080",
      spoolCount: 0,
    });
    expect(parentPromotionState({ color: null, spools: [{}, {}] })).toEqual({
      needed: true,
      parentColor: null,
      spoolCount: 2,
    });
    expect(parentPromotionState({ color: "#FF0000", spools: [{}] })).toEqual({
      needed: true,
      parentColor: "#FF0000",
      spoolCount: 1,
    });
    expect(parentPromotionState({ color: null, spools: [] })).toEqual({
      needed: false,
      parentColor: null,
      spoolCount: 0,
    });
  });

  it("parentPromotionState: empty-string color and missing spools count as nothing", () => {
    expect(parentPromotionState({ color: "" })).toEqual({
      needed: false,
      parentColor: null,
      spoolCount: 0,
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

  it("moves color/colorName/spools/weights to the new variant and clears the parent", async () => {
    const parent = await Filament.create({
      name: "Legacy PLA",
      vendor: "V",
      type: "PLA",
      color: "#123456",
      colorName: "Deep Blue",
      diameter: 2.85,
      syncId: "parent-sync-1",
      totalWeight: 1250,
      spoolWeight: 250,
      netFilamentWeight: 1000,
      spools: [
        { label: "A", totalWeight: 900 },
        { label: "B", totalWeight: 400, retired: true },
      ],
    });
    const parentLean = await Filament.findById(parent._id).lean();

    const variant = await performParentPromotion(Filament, parentLean);

    // The variant carries the moved state and is named by the colorName rule.
    expect(variant.name).toBe("Legacy PLA — Deep Blue");
    expect(String(variant.parentId)).toBe(String(parent._id));
    expect(variant.color).toBe("#123456");
    expect(variant.colorName).toBe("Deep Blue");
    expect(variant.totalWeight).toBe(1250);
    expect(variant.spoolWeight).toBe(250);
    expect(variant.netFilamentWeight).toBe(1000);
    // Diameter pinned null → inherits the parent's 2.85 (GH #106 rule).
    expect(variant.diameter).toBeNull();

    // Spools moved: same data + preserved instanceId, FRESH subdoc _ids.
    expect(variant.spools).toHaveLength(2);
    expect(variant.spools.map((s: { label: string }) => s.label)).toEqual(["A", "B"]);
    expect(variant.spools[1].retired).toBe(true);
    const parentSpoolIds = parentLean.spools.map((s: { _id: unknown }) => String(s._id));
    for (const [i, s] of variant.spools.entries()) {
      expect(parentSpoolIds).not.toContain(String(s._id));
      expect(s.instanceId).toBe(parentLean.spools[i].instanceId);
    }

    // Server-owned identity never crosses documents: the variant gets its
    // own instanceId (pre-save hook) and does NOT inherit the parent's
    // syncId — the cleared parent and the new variant sync separately.
    expect(variant.instanceId).toBeTruthy();
    expect(variant.instanceId).not.toBe(parentLean.instanceId);
    expect(variant.syncId ?? null).toBeNull();

    // Parent cleared: colorless, inventory-free.
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.color).toBeNull();
    expect(fresh.colorName).toBeNull();
    expect(fresh.spools).toEqual([]);
    expect(fresh.totalWeight).toBeNull();
    expect(fresh.spoolWeight).toBeNull();
    expect(fresh.netFilamentWeight).toBeNull();
    // The parent's own untouched fields survive.
    expect(fresh.diameter).toBe(2.85);
    expect(fresh.name).toBe("Legacy PLA");
  });

  it("falls back to — Original (with collision suffix) when the parent has no colorName", async () => {
    await Filament.create({ name: "Plain PLA — Original", vendor: "V", type: "PLA" });
    const parent = await Filament.create({
      name: "Plain PLA",
      vendor: "V",
      type: "PLA",
      color: "#808080",
    });

    const variant = await performParentPromotion(
      Filament,
      await Filament.findById(parent._id).lean(),
    );
    expect(variant.name).toBe("Plain PLA — Original (2)");
  });

  // ── ordering contract (mock model) ──────────────────────────────────────

  it("copies FIRST, clears LAST", async () => {
    const calls: string[] = [];
    const mockModel = {
      exists: async () => null,
      create: async (body: Record<string, unknown>) => {
        calls.push("create");
        return { ...body, _id: "variant-1" };
      },
      updateOne: async () => {
        calls.push("clear");
        return { acknowledged: true };
      },
    };
    // color deliberately null (spools-only promotion) — the copy still runs
    // and the ?? fallbacks stay exercised.
    await performParentPromotion(mockModel, {
      _id: "parent-1",
      name: "P",
      vendor: "V",
      type: "PLA",
      color: null,
      spools: [],
    });
    expect(calls).toEqual(["create", "clear"]);
  });

  it("a failed copy never clears the parent (no transactions — crash-safe order)", async () => {
    const calls: string[] = [];
    const mockModel = {
      exists: async () => null,
      create: async () => {
        throw new Error("boom");
      },
      updateOne: async () => {
        calls.push("clear");
        return { acknowledged: true };
      },
    };
    await expect(
      performParentPromotion(mockModel, {
        _id: "parent-1",
        name: "P",
        vendor: "V",
        type: "PLA",
        color: "#123456",
      }),
    ).rejects.toThrow("boom");
    expect(calls).toEqual([]);
  });
});
