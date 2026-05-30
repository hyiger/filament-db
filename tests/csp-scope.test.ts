import { describe, it, expect } from "vitest";
import { shouldApplyAppCsp } from "../electron/csp-scope";

/**
 * Pin the Electron CSP scope: the app-CSP rewrite MUST NOT touch
 * responses from external origins (the most important being a vendor
 * TDS document loaded inside the renderer's `<iframe>` — GH #250's
 * `frame-src https:` flow). Codex flagged this as a P1 on PR #462
 * twice; this test exists so any future tweak to the scope helper
 * fails CI before it can regress the TDS preview again.
 */
const APP_ORIGIN = "http://localhost:3456";

describe("shouldApplyAppCsp", () => {
  it("applies the app CSP to top-level app responses", () => {
    expect(shouldApplyAppCsp("http://localhost:3456/", APP_ORIGIN)).toBe(true);
    expect(
      shouldApplyAppCsp("http://localhost:3456/filaments/abc", APP_ORIGIN),
    ).toBe(true);
  });

  it("applies the app CSP to app API responses", () => {
    expect(
      shouldApplyAppCsp("http://localhost:3456/api/filaments", APP_ORIGIN),
    ).toBe(true);
  });

  it("does NOT apply the app CSP to vendor TDS documents (the critical case)", () => {
    // The exact failure mode Codex P1'd: a vendor TDS fetched into an
    // iframe must keep its OWN CSP — applying our `frame-ancestors
    // 'none'` would make Chromium refuse to embed it.
    expect(
      shouldApplyAppCsp("https://prusament.com/tds/PLA.pdf", APP_ORIGIN),
    ).toBe(false);
    expect(
      shouldApplyAppCsp("https://www.polymaker.com/tds/PETG.html", APP_ORIGIN),
    ).toBe(false);
  });

  it("does NOT apply the app CSP to image/font/data responses from other origins", () => {
    expect(
      shouldApplyAppCsp("https://cdn.example.com/image.png", APP_ORIGIN),
    ).toBe(false);
  });

  it("distinguishes by port (a different port is a different origin)", () => {
    // The embedded Next server pins to a specific port; CSP must not
    // leak to a different localhost service the user happens to run.
    expect(shouldApplyAppCsp("http://localhost:8080/", APP_ORIGIN)).toBe(false);
    expect(shouldApplyAppCsp("http://localhost:5173/", APP_ORIGIN)).toBe(false);
  });

  it("distinguishes by scheme (http vs https)", () => {
    expect(shouldApplyAppCsp("https://localhost:3456/", APP_ORIGIN)).toBe(false);
  });

  it("returns false for malformed URLs (safe default)", () => {
    expect(shouldApplyAppCsp("not-a-url", APP_ORIGIN)).toBe(false);
    expect(shouldApplyAppCsp("", APP_ORIGIN)).toBe(false);
  });

  it("respects custom app origins (PORT env override)", () => {
    const custom = "http://localhost:9999";
    expect(shouldApplyAppCsp("http://localhost:9999/api/x", custom)).toBe(true);
    expect(shouldApplyAppCsp("http://localhost:3456/", custom)).toBe(false);
  });
});
