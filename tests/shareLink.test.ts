import { describe, it, expect } from "vitest";
import { isShareLinkLocalOnly } from "@/lib/shareLink";

/**
 * GH #780 — the share page warns when a catalog link is only reachable on the
 * local machine (loopback origin). We deliberately don't rewrite the link to a
 * LAN IP (that would hand a publisher-hosted write link to LAN recipients —
 * Codex P2 on PR #784), so this is purely a loopback-origin check.
 */
describe("isShareLinkLocalOnly", () => {
  it("is true for loopback origins (desktop install)", () => {
    expect(isShareLinkLocalOnly("http://localhost:3456")).toBe(true);
    expect(isShareLinkLocalOnly("http://127.0.0.1:3456")).toBe(true);
    expect(isShareLinkLocalOnly("http://[::1]:3456")).toBe(true);
  });

  it("is false for a real LAN/public origin (web/Docker — never warned)", () => {
    expect(isShareLinkLocalOnly("http://192.168.1.50:3456")).toBe(false);
    expect(isShareLinkLocalOnly("https://filament.example.com")).toBe(false);
  });

  it("is false for an empty origin (SSR, no window)", () => {
    expect(isShareLinkLocalOnly("")).toBe(false);
  });
});
