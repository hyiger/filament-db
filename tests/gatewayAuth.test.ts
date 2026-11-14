import { describe, it, expect } from "vitest";
import {
  AttemptLimiter,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  bearerToken,
  clearedSessionCookie,
  isPageNavigation,
  mintSession,
  parseCookieHeader,
  safeNextPath,
  secretEquals,
  sessionCookie,
  verifySession,
  withoutSessionCookie,
} from "@/lib/gatewayAuth";

/** Authentication primitives of the secure gateway (src/lib/secureGateway.ts). */

const KEY = "fdb_test_key_0123456789abcdef";
const NOW = 1_800_000_000_000;

describe("secretEquals", () => {
  it("matches only the identical string", () => {
    expect(secretEquals(KEY, KEY)).toBe(true);
    expect(secretEquals(KEY + "x", KEY)).toBe(false);
    expect(secretEquals(KEY.slice(0, -1), KEY)).toBe(false);
    expect(secretEquals("", KEY)).toBe(false);
    expect(secretEquals(KEY.toUpperCase(), KEY)).toBe(false);
  });

  it("does not throw on different lengths or non-ASCII input", () => {
    expect(secretEquals("ü".repeat(500), KEY)).toBe(false);
    expect(secretEquals("schlüssel", "schlüssel")).toBe(true);
  });
});

describe("bearerToken", () => {
  it("extracts the token, whatever the scheme's case or spacing", () => {
    expect(bearerToken(`Bearer ${KEY}`)).toBe(KEY);
    expect(bearerToken(`bearer ${KEY}`)).toBe(KEY);
    expect(bearerToken(`BEARER    ${KEY}  `)).toBe(KEY);
  });

  it("is null without a bearer token", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer   ")).toBeNull();
    expect(bearerToken(`Basic ${KEY}`)).toBeNull();
    expect(bearerToken(KEY)).toBeNull();
    expect(bearerToken(`Bearer${KEY}`)).toBeNull();
  });
});

describe("sessions", () => {
  it("verifies a session it minted, until it expires", () => {
    const session = mintSession(KEY, NOW, 1000);
    expect(verifySession(KEY, session, NOW)).toBe(true);
    expect(verifySession(KEY, session, NOW + 999)).toBe(true);
    expect(verifySession(KEY, session, NOW + 1000)).toBe(false);
    expect(verifySession(KEY, session, NOW + 10_000)).toBe(false);
  });

  it("defaults to a 30-day lifetime", () => {
    const session = mintSession(KEY, NOW);
    expect(verifySession(KEY, session, NOW + SESSION_TTL_MS - 1)).toBe(true);
    expect(verifySession(KEY, session, NOW + SESSION_TTL_MS)).toBe(false);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("stops verifying once the key is rolled", () => {
    const session = mintSession(KEY, NOW);
    expect(verifySession("fdb_another_key_0123456789", session, NOW)).toBe(false);
  });

  it("mints a different value each time", () => {
    expect(mintSession(KEY, NOW)).not.toBe(mintSession(KEY, NOW));
  });

  it("rejects a tampered expiry, nonce or MAC", () => {
    const [version, expires, nonce, mac] = mintSession(KEY, NOW, 1000).split(".");
    const later = (parseInt(expires, 36) + 10 ** 9).toString(36);
    expect(verifySession(KEY, [version, later, nonce, mac].join("."), NOW)).toBe(false);
    expect(verifySession(KEY, [version, expires, nonce + "A", mac].join("."), NOW)).toBe(false);
    const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
    expect(verifySession(KEY, [version, expires, nonce, flipped].join("."), NOW)).toBe(false);
  });

  it("rejects anything that is not a session value", () => {
    const [, expires, nonce, mac] = mintSession(KEY, NOW).split(".");
    for (const value of [
      "",
      "v1",
      "a.b.c",
      "a.b.c.d.e",
      ["v2", expires, nonce, mac].join("."),
      ["v1", "NOT-BASE36", nonce, mac].join("."),
      ["v1", "", nonce, mac].join("."),
      ["v1", "z".repeat(12), nonce, mac].join("."),
      ["v1", expires, nonce, "short"].join("."),
      ["v1", expires, nonce, ""].join("."),
    ]) {
      expect(verifySession(KEY, value, NOW)).toBe(false);
    }
  });

  it("builds Secure, HttpOnly, host-only cookies", () => {
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    expect(sessionCookie("abc", 90_500)).toBe(
      `${SESSION_COOKIE}=abc; Path=/; Max-Age=90; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(sessionCookie("abc")).toContain(`Max-Age=${30 * 24 * 60 * 60};`);
    expect(clearedSessionCookie()).toBe(
      `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    // No Domain attribute: `__Host-` cookies must be host-only.
    expect(sessionCookie("abc")).not.toMatch(/domain/i);
  });
});

describe("parseCookieHeader", () => {
  it("reads name/value pairs", () => {
    expect({ ...parseCookieHeader(`a=1; ${SESSION_COOKIE}=v1.x.y.z; b = two=2 `) }).toEqual({
      a: "1",
      [SESSION_COOKIE]: "v1.x.y.z",
      b: "two=2",
    });
  });

  it("keeps the first of a repeated name and skips malformed parts", () => {
    expect({ ...parseCookieHeader("a=first; a=second; novalue; =orphan; ;") }).toEqual({ a: "first" });
  });

  it("is empty without a header, and has no inherited keys", () => {
    expect({ ...parseCookieHeader(undefined) }).toEqual({});
    expect(parseCookieHeader("x=1").constructor).toBeUndefined();
    expect(parseCookieHeader("__proto__=polluted")["toString"]).toBeUndefined();
  });
});

describe("withoutSessionCookie", () => {
  it("removes only the session cookie", () => {
    expect(withoutSessionCookie(`a=1; ${SESSION_COOKIE}=secret; b=2`)).toBe("a=1; b=2");
    expect(withoutSessionCookie("a=1")).toBe("a=1");
  });

  it("is null when nothing is left", () => {
    expect(withoutSessionCookie(`${SESSION_COOKIE}=secret`)).toBeNull();
    expect(withoutSessionCookie(` ; ${SESSION_COOKIE}=secret ; `)).toBeNull();
    expect(withoutSessionCookie(undefined)).toBeNull();
    expect(withoutSessionCookie("")).toBeNull();
  });

  it("does not remove a cookie that merely shares a prefix", () => {
    expect(withoutSessionCookie(`${SESSION_COOKIE}_other=1`)).toBe(`${SESSION_COOKIE}_other=1`);
  });
});

describe("safeNextPath", () => {
  const next = (raw: string | null | undefined) => safeNextPath(raw, "/__filamentdb");

  it("keeps a path on this origin, with its query and fragment", () => {
    expect(next("/")).toBe("/");
    expect(next("/inventory?location=abc#top")).toBe("/inventory?location=abc#top");
    expect(next("/filaments/65f0?spool=1")).toBe("/filaments/65f0?spool=1");
  });

  it("falls back to / for anything a browser could read as another site", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "inventory",
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/a\\b",
      "/a\nb",
      "/a\tb",
      "/a\u0000b",
      "/a\u007fb",
      "javascript:alert(1)",
      "/" + "a".repeat(2048),
    ]) {
      expect(next(raw)).toBe("/");
    }
  });

  it("never returns to the gateway's own pages", () => {
    expect(next("/__filamentdb")).toBe("/");
    expect(next("/__filamentdb/login")).toBe("/");
    expect(next("/__filamentdb/login?next=/x")).toBe("/");
    expect(next("/__filamentdb#x")).toBe("/");
    // A different path that only starts with the same characters is fine.
    expect(next("/__filamentdb-notes")).toBe("/__filamentdb-notes");
  });
});

describe("isPageNavigation", () => {
  const shape = (over: Partial<Parameters<typeof isPageNavigation>[0]>) => ({
    method: "GET",
    path: "/inventory",
    accept: undefined,
    secFetchMode: undefined,
    ...over,
  });

  it("is true for a browser opening a page", () => {
    expect(isPageNavigation(shape({ secFetchMode: "navigate" }))).toBe(true);
    expect(isPageNavigation(shape({ accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(isPageNavigation(shape({ method: "head", accept: "TEXT/HTML" }))).toBe(true);
  });

  it("trusts Sec-Fetch-Mode over Accept when both are present", () => {
    expect(isPageNavigation(shape({ secFetchMode: "cors", accept: "text/html" }))).toBe(false);
    expect(isPageNavigation(shape({ secFetchMode: "navigate", accept: "*/*" }))).toBe(true);
  });

  it("is false for API paths, other methods, and non-HTML clients", () => {
    expect(isPageNavigation(shape({ path: "/api/filaments", secFetchMode: "navigate" }))).toBe(false);
    expect(isPageNavigation(shape({ path: "/api", accept: "text/html" }))).toBe(false);
    expect(isPageNavigation(shape({ method: "POST", accept: "text/html" }))).toBe(false);
    expect(isPageNavigation(shape({ accept: "application/json" }))).toBe(false);
    expect(isPageNavigation(shape({}))).toBe(false);
    // Not an API path, just a name that starts the same way.
    expect(isPageNavigation(shape({ path: "/apiary", accept: "text/html" }))).toBe(true);
  });
});

describe("AttemptLimiter", () => {
  it("blocks a client after the allowed failures, for the rest of the window", () => {
    const limiter = new AttemptLimiter(3, 60_000);
    expect(limiter.retryAfterSeconds("a", NOW)).toBe(0);
    limiter.recordFailure("a", NOW);
    limiter.recordFailure("a", NOW + 1000);
    expect(limiter.retryAfterSeconds("a", NOW + 2000)).toBe(0);
    limiter.recordFailure("a", NOW + 2000);
    // Blocked until the first failure is a minute old.
    expect(limiter.retryAfterSeconds("a", NOW + 2000)).toBe(58);
    expect(limiter.retryAfterSeconds("a", NOW + 59_999)).toBe(1);
    expect(limiter.retryAfterSeconds("a", NOW + 60_000)).toBe(0);
  });

  it("counts each client separately", () => {
    const limiter = new AttemptLimiter(1, 60_000);
    limiter.recordFailure("a", NOW);
    expect(limiter.retryAfterSeconds("a", NOW)).toBe(60);
    expect(limiter.retryAfterSeconds("b", NOW)).toBe(0);
  });

  it("keeps a persistent offender blocked while it keeps failing", () => {
    const limiter = new AttemptLimiter(2, 60_000);
    for (let i = 0; i < 10; i++) limiter.recordFailure("a", NOW + i * 30_000);
    // The two most recent failures are 30 s apart: still blocked.
    expect(limiter.retryAfterSeconds("a", NOW + 9 * 30_000)).toBe(30);
  });

  it("forgets a client once its failures have aged out", () => {
    const limiter = new AttemptLimiter(2, 1000);
    limiter.recordFailure("a", NOW);
    limiter.recordFailure("a", NOW);
    expect(limiter.retryAfterSeconds("a", NOW + 1000)).toBe(0);
    limiter.recordFailure("a", NOW + 1000);
    expect(limiter.retryAfterSeconds("a", NOW + 1000)).toBe(0);
  });

  it("bounds how many clients it remembers, dropping the longest idle", () => {
    const limiter = new AttemptLimiter(1, 60_000, 2);
    limiter.recordFailure("a", NOW);
    limiter.recordFailure("b", NOW + 1);
    limiter.recordFailure("a", NOW + 2); // a is now the most recent
    limiter.recordFailure("c", NOW + 3); // evicts b
    expect(limiter.retryAfterSeconds("a", NOW + 3)).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds("b", NOW + 3)).toBe(0);
    expect(limiter.retryAfterSeconds("c", NOW + 3)).toBeGreaterThan(0);
  });

  it("uses ten failures a minute by default", () => {
    const limiter = new AttemptLimiter();
    for (let i = 0; i < 9; i++) limiter.recordFailure("a", NOW);
    expect(limiter.retryAfterSeconds("a", NOW)).toBe(0);
    limiter.recordFailure("a", NOW);
    expect(limiter.retryAfterSeconds("a", NOW)).toBe(60);
  });
});
