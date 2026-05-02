import { describe, it, expect } from "vitest";
import { isHttpUrl, safeHttpUrl } from "@/lib/safeRenderUrl";

describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("https://example.com/path?q=1")).toBe(true);
  });

  it("rejects javascript:, data:, file:, and other schemes", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("ftp://example.com/x")).toBe(false);
    expect(isHttpUrl("ms-msdt:foo")).toBe(false);
  });

  it("rejects malformed and empty inputs", () => {
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("//example.com")).toBe(false); // protocol-relative — no scheme
  });
});

describe("safeHttpUrl", () => {
  it("returns the URL when safe", () => {
    expect(safeHttpUrl("https://example.com")).toBe("https://example.com");
  });

  it("returns null for unsafe URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});
