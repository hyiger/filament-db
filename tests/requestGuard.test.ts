import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * Coverage-focused companion to tests/destructive-route-guard.test.ts.
 * That file pins the common Sec-Fetch-Site / Origin-vs-Host cases; this
 * one drills into the uncovered branches: the bracketed-IPv6 authority
 * parser (splitAuthority), the missing-Host-header path when an Origin is
 * present, and the malformed-Origin `new URL(...)` catch.
 */
describe("assertSameOriginRequest — IPv6 authority + edge branches", () => {
  function reqWith(headers: Record<string, string>) {
    return new NextRequest("http://localhost:3456/api/snapshot", { headers });
  }

  // --- Bracketed-IPv6 Host header: splitAuthority `[...]` branch (lines 8-12) ---

  it("allows a bracketed IPv6 Origin/Host with matching port ([ipv6]:port branch)", () => {
    // Origin hostname is bracket-stripped + lowercased; Host is parsed by
    // splitAuthority's `[` branch, taking the port after `]:` (line 11 true).
    expect(
      assertSameOriginRequest(
        reqWith({ origin: "http://[::1]:3456", host: "[::1]:3456" }),
      ),
    ).toBeNull();
  });

  it("lower-cases the bracketed IPv6 hostname so case-differing hex compares equal (line 10)", () => {
    // Host uses uppercase hex, Origin lowercase — splitAuthority must
    // lower-case the slice between the brackets for these to match. Using
    // a canonical literal the WHATWG URL parser leaves byte-identical so
    // the only difference between the two sides is letter case.
    expect(
      assertSameOriginRequest(
        reqWith({ origin: "http://[::abc]:3456", host: "[::ABC]:3456" }),
      ),
    ).toBeNull();
  });

  it("allows a bracketed IPv6 Host with no explicit port, matching the scheme default (line 11 false → default port)", () => {
    // `[::1]` with no `:port` → splitAuthority returns port "", which the
    // guard normalises to the Origin scheme's default (80 for http).
    expect(
      assertSameOriginRequest(
        reqWith({ origin: "http://[::1]", host: "[::1]" }),
      ),
    ).toBeNull();
  });

  it("allows a bracketed IPv6 Host with an explicit default port vs an omitted one", () => {
    // Origin omits :443 (default for https), Host spells it out — port
    // normalisation makes them equal even through the `[...]` parse path.
    expect(
      assertSameOriginRequest(
        reqWith({ origin: "https://[::1]", host: "[::1]:443" }),
      ),
    ).toBeNull();
  });

  it("rejects a bracketed IPv6 Host whose explicit port differs from the Origin's", () => {
    expect(
      assertSameOriginRequest(
        reqWith({ origin: "http://[::1]:3456", host: "[::1]:9999" }),
      ),
    ).not.toBeNull();
  });

  it("rejects a bracketed IPv6 Host whose address differs from the Origin's", () => {
    expect(
      assertSameOriginRequest(
        reqWith({ origin: "http://[::1]:3456", host: "[::2]:3456" }),
      ),
    ).not.toBeNull();
  });

  it("handles a malformed bracketed Host with no closing bracket without matching a real Origin (end === -1 branch, lines 9-11)", () => {
    // `[::1` has no `]` → splitAuthority's `end === -1` fallbacks fire:
    // hostname = "::1" (slice(1)), port = "". A real Origin can't equal
    // this malformed authority, so the guard rejects.
    expect(
      assertSameOriginRequest(
        reqWith({ origin: "http://[::1]:3456", host: "[::1" }),
      ),
    ).not.toBeNull();
  });

  // --- Origin present but Host header absent: line 63 branch true → 63/64 ---

  it("rejects when an Origin header is present but the Host header is missing (line 63 true)", () => {
    const guard = assertSameOriginRequest(reqWith({ origin: "http://localhost:3456" }));
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(403);
  });

  // --- Malformed Origin URL: new URL(...) throws → catch (lines 72/73) ---

  it("rejects a malformed Origin header that fails URL parsing (catch branch, lines 72-73)", () => {
    const guard = assertSameOriginRequest(
      reqWith({ origin: "http://[not a valid uri", host: "localhost:3456" }),
    );
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(403);
  });

  it("rejects a non-URL Origin string outright (catch branch)", () => {
    const guard = assertSameOriginRequest(
      reqWith({ origin: "notaurl", host: "localhost:3456" }),
    );
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(403);
  });
});
