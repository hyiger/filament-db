import { describe, it, expect } from "vitest";
import {
  getSpoolCount,
  getRemainingGrams,
  getRemainingPct,
  type InventoryFilament,
} from "@/lib/inventoryStats";

/**
 * Pre-fix bug: getRemainingGrams skipped retired spools but
 * getRemainingPct and getSpoolCount didn't, so the list rendered
 * inflated remaining% and an extra spool chip for any filament with a
 * retired roll. The three helpers now agree.
 */
describe("inventoryStats", () => {
  const baseTracked: Pick<InventoryFilament, "spoolWeight" | "netFilamentWeight"> = {
    spoolWeight: 200,
    netFilamentWeight: 800,
  };

  describe("getSpoolCount", () => {
    it("counts only non-retired spools", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [
          { totalWeight: 800 },
          { totalWeight: 800, retired: true },
          { totalWeight: 600 },
        ],
      };
      expect(getSpoolCount(f)).toBe(2);
    });

    it("returns 0 when every spool is retired", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [
          { totalWeight: 800, retired: true },
          { totalWeight: 600, retired: true },
        ],
      };
      expect(getSpoolCount(f)).toBe(0);
    });

    it("falls back to legacy single-spool shape when spools is empty", () => {
      expect(getSpoolCount({ ...baseTracked, totalWeight: 600, spools: [] })).toBe(1);
      expect(getSpoolCount({ ...baseTracked, totalWeight: null, spools: [] })).toBe(0);
    });
  });

  describe("getRemainingGrams", () => {
    it("excludes retired spools from the gram total", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [
          { totalWeight: 800 }, // 600g remaining
          { totalWeight: 800, retired: true }, // would add 600g if not retired
        ],
      };
      expect(getRemainingGrams(f)).toBe(600);
    });

    it("returns null when only retired spools have weight info", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [{ totalWeight: 800, retired: true }],
      };
      expect(getRemainingGrams(f)).toBeNull();
    });
  });

  describe("getRemainingPct", () => {
    it("excludes retired spools from the percentage calculation", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [
          { totalWeight: 400 }, // 200g remaining of 800g net = 25%
          { totalWeight: 1000, retired: true }, // would skew to ~62% if counted
        ],
      };
      // Only the active spool contributes: 200/800 = 25%
      expect(getRemainingPct(f)).toBe(25);
    });

    it("returns null when only retired spools remain", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [
          { totalWeight: 1000, retired: true },
          { totalWeight: 600, retired: true },
        ],
      };
      expect(getRemainingPct(f)).toBeNull();
    });

    it("matches getRemainingGrams for an all-active set", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [{ totalWeight: 600 }, { totalWeight: 1000 }],
      };
      // remaining = (600-200) + (1000-200) = 1200; net = 800*2 = 1600
      // 1200/1600 = 75%
      expect(getRemainingPct(f)).toBe(75);
      expect(getRemainingGrams(f)).toBe(1200);
    });

    it("falls back to legacy single-spool math when spools is empty", () => {
      expect(
        getRemainingPct({ ...baseTracked, totalWeight: 600, spools: [] }),
      ).toBe(50); // (600-200)/800 = 50%
      expect(
        getRemainingPct({ ...baseTracked, totalWeight: null, spools: [] }),
      ).toBeNull();
    });

    it("clamps to 0..100", () => {
      // Over-full spool (e.g. brand new + extra) should clamp to 100, not 110+
      const over: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [{ totalWeight: 1100 }], // would be (1100-200)/800 = 112.5%
      };
      expect(getRemainingPct(over)).toBe(100);

      // Under-empty (totalWeight < spoolWeight) should clamp to 0
      const under: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [{ totalWeight: 100 }], // would be -12.5%
      };
      expect(getRemainingPct(under)).toBe(0);
    });
  });
});
