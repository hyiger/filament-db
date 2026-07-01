import { describe, it, expect } from "vitest";
import { formatGrams } from "@/lib/formatWeight";

/**
 * GH #805 — display-only weight rounding. The helper rounds to at most N
 * decimals (default 2) and trims trailing zeros, never mutating stored values.
 */
describe("formatGrams", () => {
  it("rounds float noise to 2 decimals by default", () => {
    expect(formatGrams(210.40000000000003)).toBe("210.4");
    expect(formatGrams(1234.567891)).toBe("1234.57");
    expect(formatGrams(39.455)).toBe("39.46");
  });

  it("rounds exact .005 decimal ties up, not down (Codex P3)", () => {
    // The binary product (1.005 * 100 === 100.4999…) would round these DOWN
    // with a naive multiply; the decimal-shift path gets them right.
    expect(formatGrams(1.005)).toBe("1.01");
    expect(formatGrams(10.075)).toBe("10.08");
    expect(formatGrams(2.005)).toBe("2.01");
    expect(formatGrams(1.0049)).toBe("1"); // genuinely below the tie → stays down
  });

  it("trims trailing zeros (no 210.00 / 39.50)", () => {
    expect(formatGrams(210)).toBe("210");
    expect(formatGrams(210.0)).toBe("210");
    expect(formatGrams(39.5)).toBe("39.5");
    expect(formatGrams(39.5000001)).toBe("39.5");
  });

  it("honours a custom decimal count", () => {
    expect(formatGrams(1234.567891, 3)).toBe("1234.568");
    expect(formatGrams(1, 0)).toBe("1");
    expect(formatGrams(1.4, 0)).toBe("1");
  });

  it("is null-safe and rejects non-finite values", () => {
    expect(formatGrams(null)).toBe("");
    expect(formatGrams(undefined)).toBe("");
    expect(formatGrams(Number.NaN)).toBe("");
    expect(formatGrams(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("handles zero and negatives", () => {
    expect(formatGrams(0)).toBe("0");
    // Negatives are out of the normal weight domain (weights are >= 0); just
    // pin the Math.round half-toward-+Infinity behavior so it's documented.
    expect(formatGrams(-12.345)).toBe("-12.34");
    expect(formatGrams(-12.5, 0)).toBe("-12");
  });

  it("falls back to the raw value when it stringifies to exponential notation", () => {
    // A value big enough that String(value) is exponential (e.g. "1e+21")
    // breaks the decimal-shift parser: `${value}e${decimals}` becomes
    // "1e+21e2", which Number() parses as NaN. Line-27 guard returns the raw
    // stringified value rather than "NaN". Absurd for a gram weight, but pinned.
    expect(formatGrams(1e21)).toBe("1e+21");
    expect(formatGrams(1e21, 0)).toBe("1e+21");
    expect(formatGrams(Number.MAX_VALUE)).toBe(String(Number.MAX_VALUE));
    // Tiniest denormal — also exponential ("5e-324").
    expect(formatGrams(5e-324)).toBe("5e-324");
  });
});
