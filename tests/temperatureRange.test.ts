import { describe, it, expect } from "vitest";
import {
  isInvertedNozzleRange,
  effectiveNozzleRangeForUpdate,
  inheritNozzleRangeFromParent,
  isUpdateNozzleRangeInverted,
} from "@/lib/temperatureRange";

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

  it("coerces numeric strings before comparing (Codex P2 on #577)", () => {
    expect(isInvertedNozzleRange({ nozzleRangeMin: "300", nozzleRangeMax: "200" })).toBe(true);
    expect(isInvertedNozzleRange({ nozzleRangeMin: "200", nozzleRangeMax: "220" })).toBe(false);
    expect(isInvertedNozzleRange({ nozzleRangeMin: "300", nozzleRangeMax: 200 })).toBe(true);
    // Blank / non-numeric strings are treated as "no value", not 0.
    expect(isInvertedNozzleRange({ nozzleRangeMin: "", nozzleRangeMax: "200" })).toBe(false);
    expect(isInvertedNozzleRange({ nozzleRangeMin: "abc", nozzleRangeMax: "200" })).toBe(false);
  });
});

describe("effectiveNozzleRangeForUpdate (Codex P2 on #577)", () => {
  it("returns the body's full temperatures object (which replaces the subdoc)", () => {
    const body = { temperatures: { nozzleRangeMin: 300, nozzleRangeMax: 200 } };
    expect(effectiveNozzleRangeForUpdate(body, { nozzleRangeMin: 0, nozzleRangeMax: 999 })).toEqual({
      nozzleRangeMin: 300,
      nozzleRangeMax: 200,
    });
  });

  it("merges a dotted partial min with the stored max", () => {
    const body = { "temperatures.nozzleRangeMin": 300 };
    const eff = effectiveNozzleRangeForUpdate(body, { nozzleRangeMin: 180, nozzleRangeMax: 200 });
    expect(eff).toEqual({ nozzleRangeMin: 300, nozzleRangeMax: 200 });
    expect(isInvertedNozzleRange(eff)).toBe(true);
  });

  it("merges a dotted partial max with the stored min", () => {
    const body = { "temperatures.nozzleRangeMax": 100 };
    const eff = effectiveNozzleRangeForUpdate(body, { nozzleRangeMin: 250, nozzleRangeMax: 260 });
    expect(eff).toEqual({ nozzleRangeMin: 250, nozzleRangeMax: 100 });
    expect(isInvertedNozzleRange(eff)).toBe(true);
  });

  it("returns null when the body touches no nozzle-range endpoint", () => {
    expect(effectiveNozzleRangeForUpdate({ name: "x" }, { nozzleRangeMin: 1, nozzleRangeMax: 2 })).toBe(null);
    expect(effectiveNozzleRangeForUpdate({ "temperatures.bed": 60 }, {})).toBe(null);
  });

  it("reads a full temperatures object nested under $set (round 2)", () => {
    const body = { $set: { temperatures: { nozzleRangeMin: 300, nozzleRangeMax: 200 } } };
    expect(isInvertedNozzleRange(effectiveNozzleRangeForUpdate(body, null))).toBe(true);
  });

  it("merges a dotted $set endpoint with the stored other endpoint (round 2)", () => {
    const body = { $set: { "temperatures.nozzleRangeMin": 300 } };
    const eff = effectiveNozzleRangeForUpdate(body, { nozzleRangeMin: 180, nozzleRangeMax: 200 });
    expect(eff).toEqual({ nozzleRangeMin: 300, nozzleRangeMax: 200 });
    expect(isInvertedNozzleRange(eff)).toBe(true);
  });

  it("a valid $set dotted endpoint against the stored other endpoint is not inverted", () => {
    const body = { $set: { "temperatures.nozzleRangeMax": 260 } };
    const eff = effectiveNozzleRangeForUpdate(body, { nozzleRangeMin: 200, nozzleRangeMax: 220 });
    expect(eff).toEqual({ nozzleRangeMin: 200, nozzleRangeMax: 260 });
    expect(isInvertedNozzleRange(eff)).toBe(false);
  });
});

describe("inheritNozzleRangeFromParent (Codex P2 r3 on #577)", () => {
  it("inherits the parent's max when the variant sets only min — and flags inversion", () => {
    const eff = inheritNozzleRangeFromParent(
      { nozzleRangeMin: 300, nozzleRangeMax: null },
      { nozzleRangeMin: 180, nozzleRangeMax: 200 },
    );
    expect(eff).toEqual({ nozzleRangeMin: 300, nozzleRangeMax: 200 });
    expect(isInvertedNozzleRange(eff)).toBe(true);
  });

  it("the variant's own endpoint wins over the parent's", () => {
    const eff = inheritNozzleRangeFromParent(
      { nozzleRangeMin: 240, nozzleRangeMax: 260 },
      { nozzleRangeMin: 300, nozzleRangeMax: 100 },
    );
    expect(eff).toEqual({ nozzleRangeMin: 240, nozzleRangeMax: 260 });
    expect(isInvertedNozzleRange(eff)).toBe(false);
  });

  it("a standalone (no parent) keeps its own range", () => {
    expect(inheritNozzleRangeFromParent({ nozzleRangeMin: 200, nozzleRangeMax: 220 }, null)).toEqual({
      nozzleRangeMin: 200,
      nozzleRangeMax: 220,
    });
  });

  it("returns null when neither own nor parent carries a range", () => {
    expect(inheritNozzleRangeFromParent(null, null)).toBe(null);
  });
});

describe("isUpdateNozzleRangeInverted (#892 — shared slicer-sync guard)", () => {
  it("flags a full temperatures replace whose own range is inverted", () => {
    const update = { temperatures: { nozzleRangeMin: 300, nozzleRangeMax: 200 } };
    expect(isUpdateNozzleRangeInverted(update, undefined, null)).toBe(true);
  });

  it("passes a valid own range", () => {
    const update = { temperatures: { nozzleRangeMin: 200, nozzleRangeMax: 260 } };
    expect(isUpdateNozzleRangeInverted(update, undefined, null)).toBe(false);
  });

  it("returns false when the update touches neither endpoint (unrelated sync)", () => {
    const update = { temperatures: { nozzle: 210 } };
    expect(isUpdateNozzleRangeInverted(update, { nozzleRangeMin: 300, nozzleRangeMax: 100 }, null)).toBe(false);
  });

  it("flags an inversion that only emerges after inheriting the parent's endpoint", () => {
    // Variant sets only min=300; inherits parent max=200 → effective 300>200.
    const update = { temperatures: { nozzleRangeMin: 300 } };
    expect(isUpdateNozzleRangeInverted(update, undefined, { nozzleRangeMax: 200 })).toBe(true);
  });
});
