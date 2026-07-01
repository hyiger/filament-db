import { describe, it, expect } from "vitest";
import { snapToStep } from "@/lib/snapToStep";

describe("snapToStep", () => {
  it("snaps a CBOR half-float density to the 0.01 step (#570)", () => {
    // 1.24 programmed on a tag decodes to this half-float artifact.
    expect(snapToStep(1.2392578125, 0.01)).toBe(1.24);
  });

  it("snaps a 2.85 mm diameter half-float artifact to the 0.01 step", () => {
    expect(snapToStep(2.849609375, 0.01)).toBe(2.85);
  });

  it("leaves an already on-step value unchanged", () => {
    expect(snapToStep(1.75, 0.01)).toBe(1.75);
    expect(snapToStep(1.24, 0.01)).toBe(1.24);
    expect(snapToStep(0, 0.01)).toBe(0);
  });

  it("rounds to the nearest step", () => {
    expect(snapToStep(1.236, 0.01)).toBe(1.24);
    expect(snapToStep(1.232, 0.01)).toBe(1.23);
  });

  it("trims binary floating-point dust", () => {
    // 285 * 0.01 === 2.8500000000000005 before the toFixed pass.
    expect(snapToStep(2.849609375, 0.01)).toBe(2.85);
    expect(Number.isInteger(snapToStep(2.85, 0.01) * 100)).toBe(true);
  });

  it("supports integer steps", () => {
    expect(snapToStep(214.7, 1)).toBe(215);
    expect(snapToStep(215, 1)).toBe(215);
  });

  it("supports finer steps", () => {
    expect(snapToStep(1.23456, 0.001)).toBe(1.235);
  });

  it("handles a step in exponential notation (0.0000001 → '1e-7')", () => {
    // (1e-7).toString() === "1e-7", so decimalPlaces takes the e- branch and
    // resolves to 7 decimals — the snapped value keeps that full precision
    // rather than collapsing to 0 decimals (which would round to 1).
    expect(snapToStep(1.23456789, 1e-7)).toBe(1.2345679);
    expect(snapToStep(0.00000019, 1e-7)).toBe(2e-7);
  });

  it("handles a non-unit exponential-notation step (5e-7)", () => {
    // "5e-7" also hits the e- branch → 7 decimals, snapping to the 5e-7 grid.
    expect(snapToStep(1.2345678, 5e-7)).toBe(1.234568);
  });

  it("returns the value unchanged for a non-positive or non-finite step", () => {
    expect(snapToStep(1.5, 0)).toBe(1.5);
    expect(snapToStep(1.5, -0.01)).toBe(1.5);
    expect(snapToStep(1.5, NaN)).toBe(1.5);
  });

  it("returns non-finite values unchanged", () => {
    expect(snapToStep(NaN, 0.01)).toBeNaN();
    expect(snapToStep(Infinity, 0.01)).toBe(Infinity);
  });
});
