import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GH #161 regression guard.
 *
 * The TDS route used to return HTTP 502 for every `result.success === false`
 * case from `extractFromTds`. SSRF/scheme rejections happen *before* any
 * upstream provider call — they're client-input rejections, not bad-gateway
 * conditions. Returning 502 made monitoring page on user input the route
 * correctly refused, and made the renderer show "server error" when the
 * correct UX is "URL not allowed".
 *
 * The fix inspects `result.error` against the same regex used by the
 * shared `errorResponseFromCaught` helper (`isClientInputErrorMessage`),
 * mapping known client-input strings to 400 and leaving genuine upstream
 * failures at 502.
 */
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

describe("POST /api/tds — SSRF / scheme rejections return 400, real upstream failures return 502", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function jsonReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/tds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 400 for a non-http(s) scheme (the SSRF guard rejects before upstream)", async () => {
    // Fail-fast fetch stub: if anything escapes the SSRF guard the test
    // explodes loudly. We expect zero network calls.
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("FETCH SHOULD NOT BE CALLED — guard should have blocked");
    }));
    const { POST } = await import("@/app/api/tds/route");
    const res = await POST(jsonReq({ url: "javascript:alert(1)", apiKey: "fake-key", provider: "gemini" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/scheme/i);
  });

  it("returns 400 for an RFC1918 private IP (SSRF guard)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("FETCH SHOULD NOT BE CALLED");
    }));
    const { POST } = await import("@/app/api/tds/route");
    const res = await POST(jsonReq({ url: "http://10.0.0.5/tds.pdf", apiKey: "fake-key", provider: "gemini" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/private|internal/i);
  });

  it("returns 400 for an unparseable URL", async () => {
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("FETCH SHOULD NOT BE CALLED");
    }));
    const { POST } = await import("@/app/api/tds/route");
    const res = await POST(jsonReq({ url: "not a url at all", apiKey: "fake-key", provider: "gemini" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid URL/i);
  });

  it("returns 502 for a real upstream failure (e.g. provider 5xx)", async () => {
    // Network call succeeds; provider returns a 500-ish error. This is a
    // genuine bad-gateway case and must stay at 502.
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve({
          status: 500,
          ok: false,
          text: () => Promise.resolve("internal server error"),
        } as unknown as Response);
      }
      // First fetch: TDS document content
      return Promise.resolve({
        status: 200,
        ok: true,
        url: "https://example.com/tds.pdf",
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
      } as unknown as Response);
    }));
    const { POST } = await import("@/app/api/tds/route");
    const res = await POST(jsonReq({ url: "https://example.com/tds.pdf", apiKey: "fake-key", provider: "gemini" }));
    expect(res.status).toBe(502);
  });
});
