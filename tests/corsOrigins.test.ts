import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  allowedOriginsFromEnv,
  CORS_ALLOW_HEADERS,
  decideCors,
  isAllowedOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
  type CorsRequestInfo,
} from "@/lib/corsOrigins";
import { proxy } from "@/proxy";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * GH #1243: `ALLOWED_ORIGINS` — CORS for /api/* in production. The pure
 * decision, then the proxy and the CSRF guard that consume it.
 */

describe("normalizeOrigin", () => {
  it("returns URL.origin form: lower-cased host, default port dropped", () => {
    expect(normalizeOrigin("HTTPS://Dash.Example.COM:443")).toBe("https://dash.example.com");
    expect(normalizeOrigin("http://10.0.0.5:8123")).toBe("http://10.0.0.5:8123");
    expect(normalizeOrigin("  http://[::1]:3000/  ")).toBe("http://[::1]:3000");
  });

  it("rejects anything that is not an http(s) origin", () => {
    for (const bad of [
      "",
      "   ",
      "*",
      "dash.example.com",
      "null",
      "ftp://dash.example.com",
      "https://dash.example.com/app",
      "https://dash.example.com/?",
      "https://dash.example.com#x",
      "https://user:pw@dash.example.com",
    ]) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });
});

describe("parseAllowedOrigins", () => {
  it("splits on commas, normalises, de-duplicates and reports rejects", () => {
    const parsed = parseAllowedOrigins(
      "https://a.example.com, https://A.example.com:443/,,*, b.example.com ,http://10.0.0.5:8123",
    );
    expect([...parsed.origins]).toEqual(["https://a.example.com", "http://10.0.0.5:8123"]);
    expect(parsed.rejected).toEqual(["*", "b.example.com"]);
  });

  it("is empty for unset or blank input", () => {
    expect(parseAllowedOrigins(undefined).origins.size).toBe(0);
    expect(parseAllowedOrigins(null).origins.size).toBe(0);
    expect(parseAllowedOrigins(" , ").origins.size).toBe(0);
  });
});

describe("allowedOriginsFromEnv", () => {
  afterEach(() => vi.restoreAllMocks());

  it("memoises per raw value and warns once per rejected entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = "https://memo.example.com,*";
    const first = allowedOriginsFromEnv(raw);
    expect(allowedOriginsFromEnv(raw)).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"*"');
    expect(allowedOriginsFromEnv(undefined).origins.size).toBe(0);
  });
});

describe("decideCors", () => {
  const allowed = parseAllowedOrigins("https://dash.example.com");
  const req = (over: Partial<CorsRequestInfo>): CorsRequestInfo => ({
    method: "GET",
    origin: null,
    requestMethod: null,
    requestPrivateNetwork: null,
    ...over,
  });

  it("does nothing at all when no origin is configured", () => {
    expect(
      decideCors(parseAllowedOrigins(""), req({ origin: "https://dash.example.com" })),
    ).toEqual({ preflight: false, headers: {} });
  });

  it("only adds Vary for a request from an origin not on the list", () => {
    expect(decideCors(allowed, req({ origin: "https://evil.example.com" }))).toEqual({
      preflight: false,
      headers: { Vary: "Origin" },
    });
    expect(
      decideCors(allowed, req({ method: "OPTIONS", origin: "https://evil.example.com", requestMethod: "DELETE" })),
    ).toEqual({ preflight: false, headers: { Vary: "Origin" } });
    expect(decideCors(allowed, req({ origin: null }))).toEqual({
      preflight: false,
      headers: { Vary: "Origin" },
    });
  });

  it("echoes an allowed origin on an actual request", () => {
    expect(decideCors(allowed, req({ origin: "https://DASH.example.com" }))).toEqual({
      preflight: false,
      headers: {
        "Access-Control-Allow-Origin": "https://dash.example.com",
        "Access-Control-Expose-Headers": "Content-Disposition",
        Vary: "Origin",
      },
    });
  });

  it("answers an allowed origin's preflight, never allowing credentials or the print token", () => {
    const d = decideCors(
      allowed,
      req({ method: "options", origin: "https://dash.example.com", requestMethod: "PUT" }),
    );
    expect(d.preflight).toBe(true);
    expect(d.headers["Access-Control-Allow-Origin"]).toBe("https://dash.example.com");
    expect(d.headers["Access-Control-Allow-Methods"]).toContain("PUT");
    expect(d.headers["Access-Control-Allow-Headers"]).toBe(CORS_ALLOW_HEADERS);
    expect(CORS_ALLOW_HEADERS.toLowerCase()).not.toContain("x-filamentdb-print-token");
    expect(d.headers).not.toHaveProperty("Access-Control-Allow-Credentials");
    expect(d.headers).not.toHaveProperty("Access-Control-Allow-Private-Network");
  });

  it("opts in to Private Network Access only when the preflight asks", () => {
    const d = decideCors(
      allowed,
      req({
        method: "OPTIONS",
        origin: "https://dash.example.com",
        requestMethod: "GET",
        requestPrivateNetwork: "TRUE",
      }),
    );
    expect(d.headers["Access-Control-Allow-Private-Network"]).toBe("true");
  });

  it("treats an OPTIONS without Access-Control-Request-Method as an actual request", () => {
    const d = decideCors(allowed, req({ method: "OPTIONS", origin: "https://dash.example.com" }));
    expect(d.preflight).toBe(false);
    expect(d.headers["Access-Control-Allow-Origin"]).toBe("https://dash.example.com");
  });

  it("isAllowedOrigin is false for the opaque null origin", () => {
    expect(isAllowedOrigin("null", allowed)).toBe(false);
  });
});

describe("proxy + CSRF guard with ALLOWED_ORIGINS", () => {
  const saved = {
    origins: process.env.ALLOWED_ORIGINS,
    key: process.env.FILAMENTDB_API_KEY,
  };
  afterEach(() => {
    if (saved.origins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved.origins;
    if (saved.key === undefined) delete process.env.FILAMENTDB_API_KEY;
    else process.env.FILAMENTDB_API_KEY = saved.key;
  });

  const url = "http://filamentdb.lan:3456/api/filaments";

  it("leaves responses untouched when ALLOWED_ORIGINS is unset", () => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.FILAMENTDB_API_KEY;
    const res = proxy(new NextRequest(url, { headers: { origin: "https://dash.example.com" } }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("answers an allowed preflight with 204 before the key gate", () => {
    process.env.ALLOWED_ORIGINS = "https://dash.example.com";
    process.env.FILAMENTDB_API_KEY = "k";
    const res = proxy(
      new NextRequest(url, {
        method: "OPTIONS",
        headers: {
          origin: "https://dash.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://dash.example.com");
    expect(res.headers.get("access-control-allow-headers")).toBe(CORS_ALLOW_HEADERS);
  });

  it("puts CORS headers on the key gate's 401 so the caller can read it", () => {
    process.env.ALLOWED_ORIGINS = "https://dash.example.com";
    process.env.FILAMENTDB_API_KEY = "k";
    const res = proxy(new NextRequest(url, { headers: { origin: "https://dash.example.com" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://dash.example.com");
  });

  it("adds CORS headers to a passed-through request", () => {
    process.env.ALLOWED_ORIGINS = "https://dash.example.com";
    process.env.FILAMENTDB_API_KEY = "k";
    const res = proxy(
      new NextRequest(url, {
        headers: { origin: "https://dash.example.com", authorization: "Bearer k" },
      }),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://dash.example.com");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("does not answer a disallowed origin's preflight", () => {
    process.env.ALLOWED_ORIGINS = "https://dash.example.com";
    delete process.env.FILAMENTDB_API_KEY;
    const res = proxy(
      new NextRequest(url, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com", "access-control-request-method": "DELETE" },
      }),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("lets an allowed cross-site Origin past assertSameOriginRequest, and only that one", () => {
    process.env.ALLOWED_ORIGINS = "https://dash.example.com";
    const mutation = (origin: string) =>
      new NextRequest(url, {
        method: "POST",
        headers: { origin, "sec-fetch-site": "cross-site", host: "filamentdb.lan:3456" },
      });
    expect(assertSameOriginRequest(mutation("https://dash.example.com"))).toBeNull();
    expect(assertSameOriginRequest(mutation("https://evil.example.com"))?.status).toBe(403);

    delete process.env.ALLOWED_ORIGINS;
    expect(assertSameOriginRequest(mutation("https://dash.example.com"))?.status).toBe(403);
  });
});
