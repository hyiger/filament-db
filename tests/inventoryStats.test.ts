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

    it("computes grams even when netFilamentWeight is blank (#310)", () => {
      // netFilamentWeight is the denominator for the *percentage*, not
      // the gram math — grams is purely sum(max(0, total - spoolWeight)).
      // Pre-fix the guard required it and suppressed a computable figure.
      const f: InventoryFilament = {
        spoolWeight: 200,
        netFilamentWeight: null,
        totalWeight: null,
        spools: [{ totalWeight: 800 }],
      };
      expect(getRemainingGrams(f)).toBe(600);
    });

    it("falls back to a 0g tare when spoolWeight is missing but spools have weight (#954)", () => {
      // GH #954: aligns with the 0-tare posture in by-location / dashboard /
      // locations so the home-list low-stock badge can fire for a legacy
      // null-spoolWeight filament. Over-reports by the (unknown) empty-spool
      // mass — the accepted trade-off for cross-surface consistency.
      const f: InventoryFilament = {
        spoolWeight: null,
        netFilamentWeight: 800,
        totalWeight: null,
        spools: [{ totalWeight: 800 }, { totalWeight: 300, retired: true }],
      };
      // 0-tare: 800 gross from the active spool; retired spool still excluded.
      expect(getRemainingGrams(f)).toBe(800);
    });

    it("skips active spools with no weight but still totals the rest", () => {
      // An active spool with totalWeight == null must not count toward the
      // total, but it also must not suppress a sibling that does have weight.
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [{ totalWeight: null }, { totalWeight: 700 }],
      };
      expect(getRemainingGrams(f)).toBe(500);
    });

    it("returns null when the only active spool has no weight", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [{ totalWeight: null }],
      };
      expect(getRemainingGrams(f)).toBeNull();
    });

    it("falls back to legacy single-spool grams when spools is empty (#524.3)", () => {
      // spools absent → legacy path: max(0, totalWeight - spoolWeight).
      expect(
        getRemainingGrams({ ...baseTracked, totalWeight: 700, spools: [] }),
      ).toBe(500);
      // spools key entirely absent → same legacy path.
      expect(
        getRemainingGrams({ spoolWeight: 200, netFilamentWeight: 800, totalWeight: 700 }),
      ).toBe(500);
    });

    it("clamps legacy grams to 0 when totalWeight is below spoolWeight", () => {
      expect(
        getRemainingGrams({ ...baseTracked, totalWeight: 100, spools: [] }),
      ).toBe(0);
    });

    it("returns null in the legacy path when totalWeight or spoolWeight is missing", () => {
      expect(
        getRemainingGrams({ ...baseTracked, totalWeight: null, spools: [] }),
      ).toBeNull();
      expect(
        getRemainingGrams({ spoolWeight: null, netFilamentWeight: 800, totalWeight: 700, spools: [] }),
      ).toBeNull();
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

    it("skips active spools with no weight in the percentage", () => {
      // A weightless active spool must not add a validCount or inflate the
      // denominator; only the weighted active spool contributes.
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [{ totalWeight: null }, { totalWeight: 400 }],
      };
      // Only the 400g spool counts: (400-200)/800 = 25%
      expect(getRemainingPct(f)).toBe(25);
    });

    it("returns null when the only active spool has no weight", () => {
      const f: InventoryFilament = {
        ...baseTracked,
        totalWeight: null,
        spools: [{ totalWeight: null }],
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
