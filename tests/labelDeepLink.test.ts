import { describe, it, expect } from "vitest";
import { buildFilamentDeepLink } from "../src/lib/labelDeepLink";

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
