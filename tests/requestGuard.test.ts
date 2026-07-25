import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { assertSameOriginRequest, assertSafeUpdateBody } from "@/lib/requestGuard";

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

/**
 * GH #1026 — assertSafeUpdateBody.
 *
 * GHSA-664h-wqgq-64gw: a `__proto__`-prefixed DOTTED key forwarded into
 * Mongoose update casting writes `$fullPath` onto `Object.prototype`
 * (enumerable, so it leaks into every `for...in` in the process). The
 * `$`-operator guard in the filament PUT does NOT cover it —
 * `"__proto__.x".startsWith("$")` is false — so this is a second, independent
 * injection class with its own guard.
 */
describe("assertSafeUpdateBody — prototype-path rejection (GH #1026)", () => {
  const REJECTED = [
    "__proto__",
    "__proto__.polluted",
    "__proto__.a.b",
    "constructor",
    "constructor.prototype",
    "constructor.prototype.polluted",
    "prototype",
    "a.__proto__",
    "a.__proto__.b",
    "temperatures.__proto__",
    "a.constructor.b",
    "a.prototype",
  ];

  for (const key of REJECTED) {
    it(`rejects a body key "${key}" with 400`, () => {
      const guard = assertSafeUpdateBody({ name: "PLA", [key]: "x" });
      expect(guard).not.toBeNull();
      expect(guard!.status).toBe(400);
    });
  }

  const ALLOWED = [
    "name",
    "temperatures.nozzle",
    "temperatures.bedFirstLayer",
    "spools.$.totalWeight",
    "settings",
    // Words that merely CONTAIN a banned token are legitimate field names —
    // the regex is anchored on segment boundaries, so these must pass.
    "prototypeNotes",
    "myconstructor",
    "a.prototypeNotes",
    "reconstructor",
  ];

  for (const key of ALLOWED) {
    it(`allows the legitimate field path "${key}"`, () => {
      expect(assertSafeUpdateBody({ [key]: 1 })).toBeNull();
    });
  }

  it("allows an ordinary filament edit body", () => {
    expect(
      assertSafeUpdateBody({
        name: "PLA Basic",
        vendor: "Prusa",
        type: "PLA",
        "temperatures.nozzle": 215,
        settings: { compatible_printers: "" },
      }),
    ).toBeNull();
  });

  it("ignores non-object bodies rather than changing an existing error contract", () => {
    expect(assertSafeUpdateBody(null)).toBeNull();
    expect(assertSafeUpdateBody(undefined)).toBeNull();
    expect(assertSafeUpdateBody("string")).toBeNull();
    expect(assertSafeUpdateBody(42)).toBeNull();
    expect(assertSafeUpdateBody([{ "__proto__.x": 1 }])).toBeNull();
  });

  it("does not treat an inherited key as an own key", () => {
    // A literal `{"__proto__": ...}` in JS source sets the PROTOTYPE, not an
    // own key — so Object.keys is empty and there is nothing to reject. The
    // dangerous shape is the DOTTED string key, covered above. This pins that
    // we inspect own enumerable keys (what findOneAndUpdate casts).
    const viaLiteral = { __proto__: { polluted: true } };
    expect(Object.keys(viaLiteral)).toHaveLength(0);
    expect(assertSafeUpdateBody(viaLiteral)).toBeNull();
  });

  it("rejects the exact payload that pollutes Object.prototype via JSON.parse", () => {
    // JSON.parse DOES create an own "__proto__" key (unlike an object literal),
    // which is precisely how a request body carries it.
    const body = JSON.parse('{"name":"ok","__proto__.polluted":"yes"}');
    expect(Object.keys(body)).toContain("__proto__.polluted");
    const guard = assertSafeUpdateBody(body);
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(400);
  });
});
