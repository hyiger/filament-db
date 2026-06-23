import { describe, it, expect } from "vitest";
import { formatMinutesAsHm } from "@/lib/formatDuration";

/**
 * GH #807 — drying time is stored in minutes; the OpenPrintTag browser must
 * render it as hours+minutes, not raw minutes with an "h" suffix.
 */
describe("formatMinutesAsHm", () => {
  it("formats whole hours with explicit 0 minutes", () => {
    expect(formatMinutesAsHm(480)).toBe("8h 0m");
    expect(formatMinutesAsHm(60)).toBe("1h 0m");
  });

  it("formats hours + minutes", () => {
    expect(formatMinutesAsHm(90)).toBe("1h 30m");
    expect(formatMinutesAsHm(135)).toBe("2h 15m");
  });

  it("drops the hours part under an hour", () => {
    expect(formatMinutesAsHm(45)).toBe("45m");
    expect(formatMinutesAsHm(0)).toBe("0m");
  });

  it("rounds and clamps stray values", () => {
    expect(formatMinutesAsHm(89.6)).toBe("1h 30m");
    expect(formatMinutesAsHm(-5)).toBe("0m");
  });

  it("returns null for null / non-finite (so the field can hide)", () => {
    expect(formatMinutesAsHm(null)).toBeNull();
    expect(formatMinutesAsHm(undefined)).toBeNull();
    expect(formatMinutesAsHm(Number.NaN)).toBeNull();
  });
});
