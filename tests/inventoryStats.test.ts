import { describe, it, expect } from "vitest";
import {
  getSpoolCount,
  getRemainingDisplay,
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

    it("computes legacy no-spools grams when netFilamentWeight is blank (#310/#1048)", () => {
      // The reported #1048 record: a pre-migration filament with no
      // spools[] and no net weight. The grams need no denominator —
      // 1035 - 184 = 851 shows on the detail page and must not be
      // suppressed. (The #310 case above pins the same rule for the
      // spools-array shape; this is its legacy-shape twin.)
      expect(
        getRemainingGrams({
          totalWeight: 1035,
          spoolWeight: 184,
          netFilamentWeight: null,
        }),
      ).toBe(851);
    });

    it("returns null in the legacy path only when totalWeight is missing", () => {
      expect(
        getRemainingGrams({ ...baseTracked, totalWeight: null, spools: [] }),
      ).toBeNull();
    });

    it("falls back to a 0g tare in the legacy path, like the spools branch (#1118)", () => {
      // This previously returned null. GH #954 gave the spools branch a 0-tare
      // fallback to match by-location / dashboard / locations, and never
      // revisited its sibling — so the dashboard raised a low-stock alert with
      // a gram figure the home list refused to render at all.
      expect(
        getRemainingGrams({ spoolWeight: null, netFilamentWeight: 800, totalWeight: 700, spools: [] }),
      ).toBe(700);
    });

    it("legacy and spools branches agree for equivalent inputs (#1118)", () => {
      // The whole point of the alignment: one roll expressed either way must
      // produce the same number.
      const legacy = { spoolWeight: null, netFilamentWeight: 800, totalWeight: 700, spools: [] };
      const asSpool = {
        spoolWeight: null,
        netFilamentWeight: 800,
        totalWeight: null,
        spools: [{ totalWeight: 700 }],
      };
      expect(getRemainingGrams(legacy)).toBe(getRemainingGrams(asSpool));
    });

    it("a tare-less legacy roll reaches the grams tier flagged as missing both (#1118)", () => {
      expect(
        getRemainingDisplay({
          spoolWeight: null,
          netFilamentWeight: null,
          totalWeight: 700,
          spools: [],
        }),
      ).toEqual({ kind: "grams", grams: 700, missing: "both" });
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

    it("is null without a net weight but recovers once it's set (#1048)", () => {
      // The reported record: grams are computable (851, above) but the
      // percentage has no denominator — null, NOT 0 or NaN.
      const reported: InventoryFilament = {
        totalWeight: 1035,
        spoolWeight: 184,
        netFilamentWeight: null,
      };
      expect(getRemainingPct(reported)).toBeNull();
      // Setting the net weight is the documented remedy (the grams-only
      // tooltip says so): 851/1000 = 85.1 → 85.
      expect(getRemainingPct({ ...reported, netFilamentWeight: 1000 })).toBe(85);
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

  describe("getRemainingDisplay (#1048)", () => {
    // The home list's remaining cell can't be render-tested (client
    // component, node-only vitest env), so the three-tier decision it
    // delegates to is pinned here instead.

    it("picks the bar tier whenever a percentage is computable", () => {
      expect(
        getRemainingDisplay({ ...baseTracked, totalWeight: 600, spools: [] }),
      ).toEqual({ kind: "bar", pct: 50 });
    });

    it("falls back to grams-only when only the gram math has inputs", () => {
      // The reported #1048 shape: legacy record, no netFilamentWeight.
      // Pre-fix the list rendered the em-dash tier here while the
      // detail page showed 851 g. The legacy gram math itself requires
      // spoolWeight, so in the legacy shape the missing input can only
      // ever be the net weight.
      expect(
        getRemainingDisplay({
          totalWeight: 1035,
          spoolWeight: 184,
          netFilamentWeight: null,
        }),
      ).toEqual({ kind: "grams", grams: 851, missing: "net" });
    });

    it("reports the tare as missing for weighted spools with net set but no spoolWeight", () => {
      // getRemainingGrams tolerates a null spoolWeight in
      // the spools-array branch (0-tare fallback, #954) but getRemainingPct
      // needs BOTH weights — so the pre-fix tooltip told the user to set
      // the net weight, which was already set and couldn't fix the bar.
      expect(
        getRemainingDisplay({
          spoolWeight: null,
          netFilamentWeight: 800,
          totalWeight: null,
          spools: [{ totalWeight: 800 }],
        }),
      ).toEqual({ kind: "grams", grams: 800, missing: "tare" });
    });

    it("reports the net as missing for weighted spools with a tare but no net weight", () => {
      // Spools-array twin of the legacy #1048 shape (#310): tare present,
      // denominator absent.
      expect(
        getRemainingDisplay({
          spoolWeight: 200,
          netFilamentWeight: null,
          totalWeight: null,
          spools: [{ totalWeight: 800 }],
        }),
      ).toEqual({ kind: "grams", grams: 600, missing: "net" });
    });

    it("reports both as missing when neither weight is set but spools are weighted", () => {
      // 0-tare fallback still yields grams; the percentage lacks both the
      // tare and the denominator.
      expect(
        getRemainingDisplay({
          spoolWeight: null,
          netFilamentWeight: null,
          totalWeight: null,
          spools: [{ totalWeight: 800 }],
        }),
      ).toEqual({ kind: "grams", grams: 800, missing: "both" });
    });

    it("treats a non-positive net weight as missing (matches getRemainingPct's > 0 guard)", () => {
      // netFilamentWeight: 0 is set-but-unusable — getRemainingPct's guard
      // is `netFilamentWeight > 0`, so the missing-input report must agree
      // with the pct branch logic, not just null-check the field.
      expect(
        getRemainingDisplay({
          spoolWeight: 200,
          netFilamentWeight: 0,
          totalWeight: null,
          spools: [{ totalWeight: 800 }],
        }),
      ).toEqual({ kind: "grams", grams: 600, missing: "net" });
    });

    it("renders the em-dash tier when neither figure is computable", () => {
      expect(
        getRemainingDisplay({
          totalWeight: null,
          spoolWeight: null,
          netFilamentWeight: null,
          spools: [],
        }),
      ).toEqual({ kind: "none" });
    });

    it("agrees with the tooltip's remedy: setting net weight upgrades grams to bar", () => {
      const reported: InventoryFilament = {
        totalWeight: 1035,
        spoolWeight: 184,
        netFilamentWeight: null,
      };
      expect(getRemainingDisplay(reported).kind).toBe("grams");
      expect(getRemainingDisplay({ ...reported, netFilamentWeight: 1000 })).toEqual({
        kind: "bar",
        pct: 85,
      });
    });

    it("agrees with the tare tooltip's remedy: setting spoolWeight upgrades grams to bar", () => {
      // The tare-missing tooltip names spoolWeight — verify that setting it
      // (net already present) is in fact what flips the tier.
      const codexShape: InventoryFilament = {
        spoolWeight: null,
        netFilamentWeight: 800,
        totalWeight: null,
        spools: [{ totalWeight: 1000 }],
      };
      expect(getRemainingDisplay(codexShape)).toEqual({
        kind: "grams",
        grams: 1000,
        missing: "tare",
      });
      expect(getRemainingDisplay({ ...codexShape, spoolWeight: 200 })).toEqual({
        kind: "bar",
        pct: 100, // (1000-200)/800
      });
    });
  });
});
