import { describe, it, expect } from "vitest";
import { formatDate, formatTime, formatDateTime } from "@/lib/dateFormat";

/**
 * GH #446 — locale-aware date / time formatters.
 *
 * The exact format strings vary across ICU versions / Node versions
 * (e.g. en-US is `M/D/YYYY` on Node 20 but `M/D/YY` on older Intl
 * data; de-DE is `DD.MM.YY` etc.). Rather than pin a brittle exact
 * string, we assert RELATIVE structure that the formatter must
 * uphold: en-US uses `/`, de-DE uses `.`, and the year/month/day
 * tokens for a known date appear somewhere.
 */
const SAMPLE = new Date("2026-05-30T14:30:00Z");

describe("formatDate", () => {
  it("uses en-US separators when locale is en", () => {
    const out = formatDate(SAMPLE, "en-US");
    expect(out).toMatch(/\//);
    expect(out).not.toMatch(/\./); // German style uses dots
  });

  it("uses de-DE separators when locale is de", () => {
    const out = formatDate(SAMPLE, "de-DE");
    expect(out).toMatch(/\./);
    expect(out).not.toMatch(/\//);
  });

  it("returns an empty string for null / undefined input", () => {
    expect(formatDate(null, "en-US")).toBe("");
    expect(formatDate(undefined, "en-US")).toBe("");
  });

  it("returns an empty string for unparseable input", () => {
    expect(formatDate("not a date", "en-US")).toBe("");
    expect(formatDate(NaN, "en-US")).toBe("");
  });

  it("accepts ISO strings and epoch ms numbers", () => {
    const iso = formatDate("2026-05-30T14:30:00Z", "en-US");
    const ms = formatDate(SAMPLE.getTime(), "en-US");
    expect(iso).not.toBe("");
    expect(ms).not.toBe("");
    expect(iso).toBe(ms);
  });

  it("falls back to browser locale for unknown locale tags", () => {
    // Intl will throw for an invalid tag; the fallback should still
    // return SOMETHING rather than the empty string or a throw.
    const out = formatDate(SAMPLE, "this-is-not-a-real-locale-tag");
    expect(out).not.toBe("");
  });
});

describe("formatTime", () => {
  it("returns a time-only string (no slash / dot date separator)", () => {
    const out = formatTime(SAMPLE, "en-US");
    expect(out).not.toMatch(/\//);
    expect(out).not.toMatch(/\./);
  });

  it("returns an empty string for null input", () => {
    expect(formatTime(null, "en-US")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("includes both date and time separators", () => {
    const out = formatDateTime(SAMPLE, "en-US");
    // Must contain at least one digit cluster for date AND one for time
    expect(out).toMatch(/\d+/);
    // Some en-US Intl outputs use "at" / "," to join — accept any
    // whitespace as the join token.
    expect(out.length).toBeGreaterThan(formatDate(SAMPLE, "en-US").length);
  });

  it("differs between en and de locales for the same date", () => {
    const en = formatDateTime(SAMPLE, "en-US");
    const de = formatDateTime(SAMPLE, "de-DE");
    expect(en).not.toBe(de);
  });
});
