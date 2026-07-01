import { describe, it, expect } from "vitest";
import { niceAxisScale } from "@/lib/chartScale";

describe("niceAxisScale", () => {
  it("returns a zero scale for non-positive / invalid input", () => {
    expect(niceAxisScale(0)).toEqual({ max: 0, ticks: [0] });
    expect(niceAxisScale(-5)).toEqual({ max: 0, ticks: [0] });
    expect(niceAxisScale(NaN)).toEqual({ max: 0, ticks: [0] });
    expect(niceAxisScale(Infinity)).toEqual({ max: 0, ticks: [0] });
  });

  it("rounds the reported issue's max (103) to a clean scale", () => {
    // raw step 103/4 ≈ 25.75 → nice step 50 → max 150
    const { max, ticks } = niceAxisScale(103);
    expect(max).toBe(150);
    expect(ticks).toEqual([0, 50, 100, 150]);
  });

  it("keeps the data max at or below the axis max", () => {
    for (const v of [1, 6, 23, 50, 59, 103, 247, 999, 1234]) {
      expect(niceAxisScale(v).max).toBeGreaterThanOrEqual(v);
    }
  });

  it("always starts ticks at 0 and ends at max", () => {
    for (const v of [6, 50, 103, 500]) {
      const { max, ticks } = niceAxisScale(v);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(max);
    }
  });

  it("produces evenly-spaced ascending ticks", () => {
    const { ticks } = niceAxisScale(103);
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 9);
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
  });

  it("handles small maxima with clean integer ticks", () => {
    expect(niceAxisScale(6)).toEqual({ max: 6, ticks: [0, 2, 4, 6] });
    // 7/4 = 1.75 → step 2 → max 8
    expect(niceAxisScale(7)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
  });

  it("scales up cleanly for large maxima", () => {
    // 1234/4 = 308.5 → nice step 500 → max 1500
    const { max, ticks } = niceAxisScale(1234);
    expect(max).toBe(1500);
    expect(ticks).toEqual([0, 500, 1000, 1500]);
  });

  it("handles a raw step that is an exact power of ten (frac === 1)", () => {
    // 40/4 = 10 → niceStep(10): frac === 1 → nice step 10 → max 40
    const { max, ticks } = niceAxisScale(40);
    expect(max).toBe(40);
    expect(ticks).toEqual([0, 10, 20, 30, 40]);
  });

  it("respects a custom target tick count", () => {
    const { max, ticks } = niceAxisScale(100, 5);
    // 100/5 = 20 → step 20 → max 100
    expect(max).toBe(100);
    expect(ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("avoids floating-point drift in tick values", () => {
    const { ticks } = niceAxisScale(1);
    // 1/4 = 0.25 → step 0.25 → ticks must be exact, not 0.30000000004 etc.
    expect(ticks).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});
