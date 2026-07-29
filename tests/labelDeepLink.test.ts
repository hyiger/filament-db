import { describe, it, expect } from "vitest";
import { buildFilamentDeepLink, buildLocationDeepLink } from "../src/lib/labelDeepLink";

describe("buildFilamentDeepLink (GH #595)", () => {
  it("builds the plain filament link with no spool", () => {
    expect(buildFilamentDeepLink("https://fdb.lan", "abc123")).toBe("https://fdb.lan/filaments/abc123");
  });

  it("appends ?spool=<id> when a spool is selected", () => {
    expect(buildFilamentDeepLink("https://fdb.lan", "abc123", "spool9")).toBe(
      "https://fdb.lan/filaments/abc123?spool=spool9",
    );
  });

  it("trims a trailing slash on the base so we never emit //filaments", () => {
    expect(buildFilamentDeepLink("https://fdb.lan/", "abc")).toBe("https://fdb.lan/filaments/abc");
    expect(buildFilamentDeepLink("https://fdb.lan///", "abc", "s1")).toBe("https://fdb.lan/filaments/abc?spool=s1");
  });

  it("treats null / empty / whitespace spool ids as 'no spool'", () => {
    expect(buildFilamentDeepLink("https://x", "f")).toBe("https://x/filaments/f");
    expect(buildFilamentDeepLink("https://x", "f", null)).toBe("https://x/filaments/f");
    expect(buildFilamentDeepLink("https://x", "f", "")).toBe("https://x/filaments/f");
    expect(buildFilamentDeepLink("https://x", "f", "   ")).toBe("https://x/filaments/f");
  });

  it("URL-encodes the ids", () => {
    expect(buildFilamentDeepLink("https://x", "a b", "s/1")).toBe("https://x/filaments/a%20b?spool=s%2F1");
  });
});

describe("buildLocationDeepLink (dry-box labels)", () => {
  it("targets /inventory?location= — the live answer to 'what is in this box'", () => {
    // Deliberately not a location page: none exists (only /locations/{id}/edit),
    // and /inventory already shows the box's contents from the by-location
    // aggregation. The page expands + scrolls to the group.
    expect(buildLocationDeepLink("https://fdb.lan", "abc123")).toBe(
      "https://fdb.lan/inventory?location=abc123",
    );
  });

  it("trims trailing slashes on the base", () => {
    expect(buildLocationDeepLink("https://fdb.lan/", "abc")).toBe(
      "https://fdb.lan/inventory?location=abc",
    );
    expect(buildLocationDeepLink("https://fdb.lan///", "abc")).toBe(
      "https://fdb.lan/inventory?location=abc",
    );
  });

  it("URL-encodes the id", () => {
    expect(buildLocationDeepLink("https://x", "a b/c")).toBe(
      "https://x/inventory?location=a%20b%2Fc",
    );
  });
});

describe("buildLocationDeepLink — ASCII canonicalization (PR #1043 round 6)", () => {
  it("punycodes an internationalized hostname instead of letting it be transliterated", () => {
    // The TSPL emitter ASCII-folds every payload (the firmware truncates
    // high bytes). Folding "münchen" to "munchen" would encode a QR that
    // scans fine and points at a domain the user does not own; punycode is
    // the SAME host in ASCII.
    expect(buildLocationDeepLink("https://münchen.example", "abc")).toBe(
      "https://xn--mnchen-3ya.example/inventory?location=abc",
    );
  });

  it("percent-encodes a non-ASCII base path", () => {
    expect(buildLocationDeepLink("https://fdb.lan/übersicht", "abc")).toBe(
      "https://fdb.lan/%C3%BCbersicht/inventory?location=abc",
    );
  });

  it("produces pure-ASCII output for these inputs, so the emitter's fold is a no-op", () => {
    for (const base of ["https://münchen.example", "https://fdb.lan/übersicht", "https://fdb.lan"]) {
      const url = buildLocationDeepLink(base, "abc");
      for (let i = 0; i < url.length; i++) expect(url.charCodeAt(i)).toBeLessThan(0x80);
    }
  });

  it("does not double-encode an already-encoded location id", () => {
    expect(buildLocationDeepLink("https://x.example", "a b/c")).toBe(
      "https://x.example/inventory?location=a%20b%2Fc",
    );
  });

  it("falls back to the raw construction when the base is not a parseable URL", () => {
    expect(buildLocationDeepLink("not a url", "abc")).toBe("not a url/inventory?location=abc");
  });
});
