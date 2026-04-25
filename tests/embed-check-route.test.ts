import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dns.lookup at the module level so the SSRF guard treats public-looking
// hostnames as actually resolvable without hitting real DNS during tests.
// Reject paths use literal IPs or non-http schemes that short-circuit before
// reaching the lookup.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

describe("/api/embed-check", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  async function callRoute(url: string | null) {
    const { GET } = await import("@/app/api/embed-check/route");
    const target = url == null
      ? "http://localhost/api/embed-check"
      : `http://localhost/api/embed-check?url=${encodeURIComponent(url)}`;
    const res = await GET(new NextRequest(target));
    return { status: res.status, body: await res.json() };
  }

  it("returns 400 when url query param is missing", async () => {
    const { status, body } = await callRoute(null);
    expect(status).toBe(400);
    expect(body.error).toMatch(/url/i);
  });

  it("returns embeddable=false when the SSRF guard rejects loopback URLs", async () => {
    const { status, body } = await callRoute("http://127.0.0.1/foo");
    expect(status).toBe(200);
    expect(body.embeddable).toBe(false);
    expect(body.reason).toMatch(/private|internal/i);
  });

  it("returns embeddable=false when the URL scheme isn't http(s)", async () => {
    const { status, body } = await callRoute("file:///etc/passwd");
    expect(status).toBe(200);
    expect(body.embeddable).toBe(false);
    expect(body.reason).toMatch(/scheme/i);
  });

  it("flags X-Frame-Options: DENY as not embeddable (Siraya / Shopify pattern)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "x-frame-options": "DENY", "content-type": "text/html" }),
      body: { cancel: () => Promise.resolve() },
    }));
    const { body } = await callRoute("https://siraya.example.com/tds");
    expect(body.embeddable).toBe(false);
    expect(body.reason).toMatch(/x-frame-options/i);
  });

  it("flags X-Frame-Options: SAMEORIGIN as not embeddable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Headers({ "x-frame-options": "SAMEORIGIN" }),
      body: { cancel: () => Promise.resolve() },
    }));
    const { body } = await callRoute("https://example.com/tds");
    expect(body.embeddable).toBe(false);
  });

  it("flags CSP frame-ancestors 'none' as not embeddable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Headers({
        "content-security-policy":
          "block-all-mixed-content; frame-ancestors 'none'; upgrade-insecure-requests;",
      }),
      body: { cancel: () => Promise.resolve() },
    }));
    const { body } = await callRoute("https://example.com/tds");
    expect(body.embeddable).toBe(false);
    expect(body.reason).toMatch(/frame-ancestors/i);
  });

  it("returns embeddable=true when neither X-Frame-Options nor CSP block framing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Headers({ "content-type": "application/pdf" }),
      body: { cancel: () => Promise.resolve() },
    }));
    const { body } = await callRoute("https://cdn.example.com/tds.pdf");
    expect(body.embeddable).toBe(true);
    expect(body.contentType).toBe("application/pdf");
    expect(body.reason).toBeUndefined();
  });

  it("treats CSP frame-ancestors '*' as embeddable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Headers({ "content-security-policy": "frame-ancestors *" }),
      body: { cancel: () => Promise.resolve() },
    }));
    const { body } = await callRoute("https://example.com/tds");
    expect(body.embeddable).toBe(true);
  });

  it("returns embeddable=false with HTTP status reason on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 404, statusText: "Not Found",
      headers: new Headers(),
      body: { cancel: () => Promise.resolve() },
    }));
    const { body } = await callRoute("https://example.com/missing");
    expect(body.embeddable).toBe(false);
    expect(body.reason).toMatch(/404/);
  });

  it("returns embeddable=false on network failure (treats like blocked, not 5xx)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { status, body } = await callRoute("https://example.com/tds");
    expect(status).toBe(200); // intentional: frontend handles uniformly
    expect(body.embeddable).toBe(false);
    expect(body.reason).toMatch(/ECONNREFUSED/);
  });
});
