import { describe, it, expect } from "vitest";
import {
  DEFAULT_DATE_FORMAT,
  PRESET_PATTERNS,
  isValidPattern,
  normalizeDateFormat,
  resolveDatePattern,
  formatWithPattern,
} from "@/lib/dateFormatPref";

/**
 * GH #983 — pure date-format-preference core. Exact outputs here are stable
 * across ICU/Node versions because they come from the deterministic token
 * formatter (not locale-dependent `Intl` short forms). Every `formatWithPattern`
 * exact-output case passes `timeZone: "UTC"` so it doesn't depend on the CI
 * runner's timezone.
 */

describe("isValidPattern", () => {
  it("is false for an empty or token-free string", () => {
    expect(isValidPattern("")).toBe(false);
    expect(isValidPattern("hello world")).toBe(false); // lowercase, no tokens
    expect(isValidPattern("....")).toBe(false);
  });

  it("is true when any date token is present", () => {
    expect(isValidPattern("YYYY-MM-DD")).toBe(true);
    expect(isValidPattern("DD/MM/YYYY")).toBe(true);
    expect(isValidPattern("YY")).toBe(true);
    expect(isValidPattern("M")).toBe(true);
    expect(isValidPattern("D")).toBe(true);
    expect(isValidPattern("date: DD")).toBe(true);
  });
});

describe("normalizeDateFormat", () => {
  it("falls back to the system default for non-object input", () => {
    expect(normalizeDateFormat(null)).toEqual({ mode: "system" });
    expect(normalizeDateFormat(undefined)).toEqual({ mode: "system" });
    expect(normalizeDateFormat("iso")).toEqual({ mode: "system" });
    expect(normalizeDateFormat(42)).toEqual({ mode: "system" });
  });

  it("keeps a known mode and drops an unknown one", () => {
    expect(normalizeDateFormat({ mode: "iso" })).toEqual({ mode: "iso" });
    expect(normalizeDateFormat({ mode: "european" })).toEqual({ mode: "european" });
    expect(normalizeDateFormat({ mode: "bogus" })).toEqual({ mode: "system" });
    expect(normalizeDateFormat({ mode: 123 })).toEqual({ mode: "system" });
  });

  it("preserves a string pattern (even on a preset mode) and drops non-strings", () => {
    expect(normalizeDateFormat({ mode: "custom", pattern: "DD.MM" })).toEqual({
      mode: "custom",
      pattern: "DD.MM",
    });
    // Pattern kept across a preset so toggling back to custom doesn't lose it.
    expect(normalizeDateFormat({ mode: "iso", pattern: "DD.MM" })).toEqual({
      mode: "iso",
      pattern: "DD.MM",
    });
    // No mode but a pattern → system + pattern.
    expect(normalizeDateFormat({ pattern: "YYYY" })).toEqual({
      mode: "system",
      pattern: "YYYY",
    });
    // Non-string pattern dropped.
    expect(normalizeDateFormat({ mode: "us", pattern: 5 })).toEqual({ mode: "us" });
  });
});

describe("resolveDatePattern", () => {
  it("returns null for system (use the Intl path)", () => {
    expect(resolveDatePattern({ mode: "system" })).toBeNull();
    expect(resolveDatePattern(DEFAULT_DATE_FORMAT)).toBeNull();
  });

  it("returns the fixed pattern for each preset", () => {
    expect(resolveDatePattern({ mode: "iso" })).toBe(PRESET_PATTERNS.iso);
    expect(resolveDatePattern({ mode: "us" })).toBe(PRESET_PATTERNS.us);
    expect(resolveDatePattern({ mode: "european" })).toBe(PRESET_PATTERNS.european);
  });

  it("returns a valid custom pattern and null for an invalid/empty one", () => {
    expect(resolveDatePattern({ mode: "custom", pattern: "DD.MM.YYYY" })).toBe("DD.MM.YYYY");
    expect(resolveDatePattern({ mode: "custom", pattern: "" })).toBeNull();
    expect(resolveDatePattern({ mode: "custom", pattern: "no tokens" })).toBeNull();
    expect(resolveDatePattern({ mode: "custom" })).toBeNull();
  });
});

describe("formatWithPattern", () => {
  const D = new Date("2026-05-30T14:30:00Z");
  const JAN5 = new Date("2026-01-05T12:00:00Z");

  it("renders each preset deterministically", () => {
    expect(formatWithPattern(D, PRESET_PATTERNS.iso, "UTC")).toBe("2026-05-30");
    expect(formatWithPattern(D, PRESET_PATTERNS.us, "UTC")).toBe("05/30/2026");
    expect(formatWithPattern(D, PRESET_PATTERNS.european, "UTC")).toBe("30/05/2026");
  });

  it("zero-pads MM/DD and renders full YYYY", () => {
    expect(formatWithPattern(JAN5, "YYYY-MM-DD", "UTC")).toBe("2026-01-05");
  });

  it("supports 2-digit year and non-padded M/D", () => {
    expect(formatWithPattern(JAN5, "D-M-YY", "UTC")).toBe("5-1-26"); // the maintainer's example shape
    expect(formatWithPattern(D, "YY", "UTC")).toBe("26");
  });

  it("passes non-token characters through as literal separators", () => {
    expect(formatWithPattern(D, "YYYY (MM)", "UTC")).toBe("2026 (05)");
    expect(formatWithPattern(D, "YYYY.MM.DD", "UTC")).toBe("2026.05.30");
    // Unknown letters are literals, not tokens.
    expect(formatWithPattern(D, "YYYY Q", "UTC")).toBe("2026 Q");
  });

  it("handles adjacent/overlapping tokens with a single longest-first pass", () => {
    // YYYY must win over YY at the same position; a naive sequential replace
    // would corrupt this to "2026-2026...".
    expect(formatWithPattern(D, "YYYY-YY", "UTC")).toBe("2026-26");
    expect(formatWithPattern(D, "MMDD", "UTC")).toBe("0530");
  });

  it("threads timeZone: UTC so a UTC calendar day never shifts", () => {
    // 02:30 UTC is the previous local day west of UTC; timeZone: "UTC" must
    // keep the UTC calendar day (the analytics day-key / spool-date invariant).
    const utcMorning = new Date("2026-05-30T02:30:00Z");
    expect(formatWithPattern(utcMorning, "YYYY-MM-DD", "UTC")).toBe("2026-05-30");
    const utcLateNight = new Date("2026-05-30T23:30:00Z");
    expect(formatWithPattern(utcLateNight, "YYYY-MM-DD", "UTC")).toBe("2026-05-30");
  });
});
