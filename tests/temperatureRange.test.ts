import { describe, it, expect } from "vitest";
import { isInvertedNozzleRange } from "@/lib/temperatureRange";

describe("isInvertedNozzleRange", () => {
  it("flags an inverted range (min > max) (#574)", () => {
    expect(isInvertedNozzleRange({ nozzleRangeMin: 300, nozzleRangeMax: 200 })).toBe(true);
  });

  it("accepts a normal range (min <= max)", () => {
    expect(isInvertedNozzleRange({ nozzleRangeMin: 200, nozzleRangeMax: 220 })).toBe(false);
  });

  it("accepts an equal range (min === max)", () => {
    expect(isInvertedNozzleRange({ nozzleRangeMin: 215, nozzleRangeMax: 215 })).toBe(false);
  });

  it("accepts a partial range (only one end set)", () => {
    expect(isInvertedNozzleRange({ nozzleRangeMin: 300, nozzleRangeMax: null })).toBe(false);
    expect(isInvertedNozzleRange({ nozzleRangeMin: null, nozzleRangeMax: 200 })).toBe(false);
    expect(isInvertedNozzleRange({ nozzleRangeMin: 300 })).toBe(false);
  });

  it("treats null/undefined/empty input as not inverted", () => {
    expect(isInvertedNozzleRange(null)).toBe(false);
    expect(isInvertedNozzleRange(undefined)).toBe(false);
    expect(isInvertedNozzleRange({})).toBe(false);
  });

  it("ignores non-finite values", () => {
    expect(isInvertedNozzleRange({ nozzleRangeMin: NaN, nozzleRangeMax: 200 })).toBe(false);
    expect(isInvertedNozzleRange({ nozzleRangeMin: 300, nozzleRangeMax: NaN })).toBe(false);
    expect(isInvertedNozzleRange({ nozzleRangeMin: Infinity, nozzleRangeMax: 200 })).toBe(false);
  });
});
