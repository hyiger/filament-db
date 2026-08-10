import { describe, it, expect } from "vitest";
import {
  isSafeReturnPath,
  resolveReturnPath,
  withReturnTo,
  readReturnPath,
} from "@/lib/returnTo";

/**
 * GH #1117 item h — the "+ New location…" detour carries a return path in the
 * query string, so it is attacker-influenceable in the ordinary sense (anyone
 * can hand someone a link). It must never navigate off-origin.
 */
describe("isSafeReturnPath", () => {
  it("accepts an ordinary same-origin path, query string included", () => {
    expect(isSafeReturnPath("/")).toBe(true);
    expect(isSafeReturnPath("/inventory")).toBe(true);
    expect(isSafeReturnPath("/inventory?groupBy=location&type=PLA")).toBe(true);
    expect(isSafeReturnPath("/filaments/507f1f77bcf86cd799439011#spool-1")).toBe(true);
  });

  it("rejects anything that could leave the origin", () => {
    expect(isSafeReturnPath("https://evil.example")).toBe(false);
    expect(isSafeReturnPath("//evil.example")).toBe(false); // protocol-relative
    expect(isSafeReturnPath("/\\evil.example")).toBe(false); // backslash form
    expect(isSafeReturnPath("javascript:alert(1)")).toBe(false);
    expect(isSafeReturnPath("inventory")).toBe(false); // not rooted
    // Leading whitespace is stripped by the URL parser, which would turn this
    // into a scheme — caught by the leading-slash test rather than the
    // control-character one, but caught.
    expect(isSafeReturnPath(" javascript:alert(1)")).toBe(false);
  });

  it("rejects control characters, which a browser may strip", () => {
    // Stripping can turn a rejected string into a scheme, so the control
    // check runs BEFORE the leading-slash test rather than after it.
    expect(isSafeReturnPath("\u0001/inventory")).toBe(false); // leading control
    expect(isSafeReturnPath("\u0009//evil.example")).toBe(false); // tab
    expect(isSafeReturnPath("/inven\u000atory")).toBe(false); // newline
    expect(isSafeReturnPath("/inventory\u007f")).toBe(false); // DEL
  });

  it("rejects non-strings and the empty string", () => {
    expect(isSafeReturnPath(undefined)).toBe(false);
    expect(isSafeReturnPath(null)).toBe(false);
    expect(isSafeReturnPath("")).toBe(false);
    expect(isSafeReturnPath(7)).toBe(false);
  });
});

describe("resolveReturnPath", () => {
  it("falls back rather than throwing", () => {
    expect(resolveReturnPath("//evil.example", "/locations")).toBe("/locations");
    expect(resolveReturnPath("/inventory", "/locations")).toBe("/inventory");
  });
});

describe("withReturnTo", () => {
  it("encodes the path so a nested query string survives", () => {
    expect(withReturnTo("/locations/new", "/inventory?groupBy=location")).toBe(
      "/locations/new?from=%2Finventory%3FgroupBy%3Dlocation",
    );
  });

  it("appends with & when the target already has a query", () => {
    expect(withReturnTo("/locations/new?x=1", "/")).toBe("/locations/new?x=1&from=%2F");
  });

  it("omits the param entirely for an unusable path", () => {
    expect(withReturnTo("/locations/new", "//evil.example")).toBe("/locations/new");
    expect(withReturnTo("/locations/new", null)).toBe("/locations/new");
  });
});

describe("readReturnPath", () => {
  it("round-trips what withReturnTo wrote", () => {
    const href = withReturnTo("/locations/new", "/inventory?groupBy=location");
    const search = href.slice(href.indexOf("?"));
    expect(readReturnPath(search, "/locations")).toBe("/inventory?groupBy=location");
  });

  it("falls back when the param is absent or unsafe", () => {
    expect(readReturnPath("", "/locations")).toBe("/locations");
    expect(readReturnPath("?from=https%3A%2F%2Fevil.example", "/locations")).toBe("/locations");
    expect(readReturnPath("?from=%2F%2Fevil.example", "/locations")).toBe("/locations");
  });
});
