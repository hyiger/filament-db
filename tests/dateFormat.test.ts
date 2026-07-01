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

  /**
   * PR #936 (round-3 self-review P2): when the Intl formatter path
   * throws, the fallback used to be `d.toLocaleDateString()` with no
   * arguments — the browser's local timezone would silently shift a
   * UTC-flagged input to the previous calendar day (`2026-05-30T02:30Z`
   * → `5/29/2026` in America/Los_Angeles). The fix threads the
   * caller's `{ timeZone }` option through to
   * `d.toLocaleDateString(undefined, { timeZone })`. This test pins
   * that invariant by forcing the catch branch (invalid locale tag)
   * and asserting the UTC calendar day survives.
   *
   * Runs in a fixed timezone via `TZ=America/Los_Angeles` on `process.env`
   * inside the test — Node reads `TZ` on Date construction so the shift
   * is deterministic across CI hosts (which run in whichever TZ the
   * runner defaults to). A future revert to the no-arg fallback would
   * silently re-open the off-by-one bug the option was introduced to
   * close, and this test would trip on the regression.
   */
  it("preserves the { timeZone } option across the Intl-reject fallback", () => {
    const prevTz = process.env.TZ;
    try {
      // Only meaningful when Node picks up TZ before Date construction.
      // Vitest reads env at spawn; we build the Date AFTER setting so
      // any host-TZ that isn't PST doesn't leak into the assertion.
      process.env.TZ = "America/Los_Angeles";
      const utcInput = new Date("2026-05-30T02:30:00Z");
      // 02:30 UTC on 2026-05-30 = 19:30 PDT on 2026-05-29. The
      // un-timezoned fallback would render "5/29/2026"; the fixed
      // fallback (threading timeZone: "UTC") renders "5/30/2026".
      const outWithTz = formatDate(
        utcInput,
        "this-is-not-a-real-locale-tag",
        { timeZone: "UTC" },
      );
      // Assert the day-of-month is 30 (UTC calendar day), NOT 29.
      expect(outWithTz).toMatch(/30/);
      expect(outWithTz).not.toMatch(/29/);

      // Belt-and-suspenders: the try-path (valid locale) also honours
      // the timeZone option — that's the primary correctness contract.
      const outIntl = formatDate(utcInput, "en-US", { timeZone: "UTC" });
      expect(outIntl).toMatch(/30/);
      expect(outIntl).not.toMatch(/29/);
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
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

  it("falls back to the browser-locale time string for unknown locale tags", () => {
    // An invalid locale tag forces Intl.DateTimeFormat to throw, exercising
    // the catch branch (`d.toLocaleTimeString()`). The fallback must still
    // return a non-empty time string rather than "" or a throw.
    const out = formatTime(SAMPLE, "this-is-not-a-real-locale-tag");
    expect(out).not.toBe("");
    // A time-only string carries no date-style slash separator.
    expect(out).not.toMatch(/\//);
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

  it("returns an empty string for null / undefined / unparseable input", () => {
    expect(formatDateTime(null, "en-US")).toBe("");
    expect(formatDateTime(undefined, "en-US")).toBe("");
    expect(formatDateTime("not a date", "en-US")).toBe("");
  });

  it("falls back to the browser-locale datetime string for unknown locale tags", () => {
    // An invalid locale tag forces Intl.DateTimeFormat to throw, exercising
    // the catch branch (`d.toLocaleString()`). The fallback must still
    // return a non-empty datetime string rather than "" or a throw.
    const out = formatDateTime(SAMPLE, "this-is-not-a-real-locale-tag");
    expect(out).not.toBe("");
    // A full datetime string carries at least one digit cluster.
    expect(out).toMatch(/\d+/);
  });
});
