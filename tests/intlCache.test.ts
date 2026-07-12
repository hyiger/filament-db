import { describe, it, expect } from "vitest";
import { getDateTimeFormat, getNumberFormat } from "@/lib/intlCache";

/**
 * GH #1005 F3: the Intl formatter cache returns one shared instance per
 * (locale, options) key so hot render paths (the home list / inventory rows)
 * don't reconstruct a formatter per cell.
 */
describe("intlCache", () => {
  describe("getDateTimeFormat", () => {
    it("returns the SAME instance for an identical (locale, options) key", () => {
      const a = getDateTimeFormat("en-US", { dateStyle: "short" });
      const b = getDateTimeFormat("en-US", { dateStyle: "short" });
      expect(a).toBe(b);
    });

    it("returns DIFFERENT instances for different locales or options", () => {
      const a = getDateTimeFormat("en-US", { dateStyle: "short" });
      const b = getDateTimeFormat("de-DE", { dateStyle: "short" });
      const c = getDateTimeFormat("en-US", { timeStyle: "short" });
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
    });

    it("still formats correctly through the cache (identical to a fresh formatter)", () => {
      const d = new Date("2026-05-30T00:00:00Z");
      const opts = { dateStyle: "short", timeZone: "UTC" } as const;
      const out = getDateTimeFormat("en-US", opts).format(d);
      expect(out).toBe(new Intl.DateTimeFormat("en-US", opts).format(d));
    });

    it("treats an omitted options bag as its own key", () => {
      const a = getDateTimeFormat("en-US");
      const b = getDateTimeFormat("en-US");
      expect(a).toBe(b);
    });
  });

  describe("getNumberFormat", () => {
    it("returns the SAME instance for an identical (locale, options) key", () => {
      const a = getNumberFormat("en-US", { maximumFractionDigits: 2 });
      const b = getNumberFormat("en-US", { maximumFractionDigits: 2 });
      expect(a).toBe(b);
    });

    it("returns DIFFERENT instances for different options", () => {
      const a = getNumberFormat("en-US", { maximumFractionDigits: 2 });
      const b = getNumberFormat("en-US", { maximumFractionDigits: 3 });
      expect(a).not.toBe(b);
    });

    it("still formats correctly through the cache", () => {
      expect(getNumberFormat("en-US", { minimumFractionDigits: 2 }).format(5)).toBe("5.00");
    });

    it("handles an undefined locale (Intl default locale)", () => {
      const a = getNumberFormat(undefined, { maximumFractionDigits: 0 });
      const b = getNumberFormat(undefined, { maximumFractionDigits: 0 });
      expect(a).toBe(b);
      expect(typeof a.format(1234)).toBe("string");
    });
  });

  it("clears each cache once it exceeds MAX_ENTRIES so it can't grow unbounded", () => {
    // Distinct BCP-47 private-use subtags produce >500 distinct keys, tripping
    // the size guard's clear() branch. The functions must keep returning valid
    // formatters across the wipe.
    let lastNum: Intl.NumberFormat | null = null;
    let lastDate: Intl.DateTimeFormat | null = null;
    for (let i = 0; i < 520; i++) {
      lastNum = getNumberFormat(`en-US-x-t${i}`, { maximumFractionDigits: 2 });
      lastDate = getDateTimeFormat(`en-US-x-t${i}`, { dateStyle: "short" });
    }
    expect(lastNum!.format(1)).toBeTypeOf("string");
    expect(lastDate!.format(new Date("2026-01-01T00:00:00Z"))).toBeTypeOf("string");
    // After a wipe, a fresh lookup for a brand-new key still works and caches.
    const x = getNumberFormat("fr-FR", { maximumFractionDigits: 1 });
    const y = getNumberFormat("fr-FR", { maximumFractionDigits: 1 });
    expect(x).toBe(y);
  });
});
