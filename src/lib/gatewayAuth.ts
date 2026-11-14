/**
 * Authentication primitives of the secure gateway (src/lib/secureGateway.ts).
 * Pure functions of their inputs, plus one small in-memory attempt limiter.
 *
 * Two credentials are accepted:
 * - `Authorization: Bearer <key>`, for API clients (mobile app, scripts).
 * - a session cookie, set after the key is entered on the sign-in page, so the
 *   web UI works in a browser. The cookie is a MAC over an expiry, keyed by a
 *   secret derived from the API key: nothing is stored server-side, and rolling
 *   the key invalidates every session at once.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ── Secrets ───────────────────────────────────────────────────────────────

/** Compare two secrets without leaking, through timing, where they differ or
 * how long the expected one is. */
export function secretEquals(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** The token of an `Authorization: Bearer <token>` header, or null when the
 * header is absent, uses another scheme, or carries no token. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer +(\S.*)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// ── Sessions ──────────────────────────────────────────────────────────────

/** `__Host-`: browsers accept it only as a Secure, host-only, Path=/ cookie. */
export const SESSION_COOKIE = "__Host-filamentdb_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_VERSION = "v1";

function sessionSecret(apiKey: string): Buffer {
  return createHmac("sha256", apiKey).update("filamentdb-gateway-session-v1").digest();
}

function sessionMac(apiKey: string, payload: string): Buffer {
  return createHmac("sha256", sessionSecret(apiKey)).update(payload).digest();
}

/** A session value valid until `now + ttlMs`. */
export function mintSession(
  apiKey: string,
  now: number,
  ttlMs: number = SESSION_TTL_MS,
): string {
  const expires = Math.floor(now + ttlMs).toString(36);
  const nonce = randomBytes(12).toString("base64url");
  const payload = `${SESSION_VERSION}.${expires}.${nonce}`;
  return `${payload}.${sessionMac(apiKey, payload).toString("base64url")}`;
}

/** True when `value` was minted with `apiKey` and has not expired. */
export function verifySession(apiKey: string, value: string, now: number): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return false;
  const [version, expires, nonce, mac] = parts;
  if (!/^[0-9a-z]{1,11}$/.test(expires)) return false;
  const presented = Buffer.from(mac, "base64url");
  const expected = sessionMac(apiKey, `${version}.${expires}.${nonce}`);
  if (presented.length !== expected.length) return false;
  if (!timingSafeEqual(presented, expected)) return false;
  return parseInt(expires, 36) > now;
}

/** The cookies of a `Cookie` header. A name sent twice keeps its first value. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in cookies) continue;
    cookies[name] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/** `Set-Cookie` value that stores a session. */
export function sessionCookie(value: string, ttlMs: number = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

/** `Set-Cookie` value that removes the session. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** A `Cookie` header without the session cookie (null when nothing is left),
 * so the credential is not passed on to the app. */
export function withoutSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.split("=")[0].trim() !== SESSION_COOKIE);
  return kept.length > 0 ? kept.join("; ") : null;
}

// ── Navigation ────────────────────────────────────────────────────────────

/**
 * Where to send the browser after sign-in. Only a path on this origin is
 * accepted; anything that a browser could read as another site (`//host`,
 * `/\host`, a scheme, control characters) falls back to `/`.
 */
export function safeNextPath(raw: string | null | undefined, reservedPrefix: string): string {
  if (!raw || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\x00-\x1f\x7f\\]/.test(raw)) return "/";
  const path = raw.split(/[?#]/)[0];
  if (path === reservedPrefix || path.startsWith(reservedPrefix + "/")) return "/";
  return raw;
}

export interface RequestShape {
  method: string;
  path: string;
  accept: string | undefined;
  secFetchMode: string | undefined;
}

/**
 * Whether an unauthenticated request is a browser opening a page (send it to
 * the sign-in page) or anything else (answer 401). API paths always get the
 * 401, whatever they claim to accept.
 */
export function isPageNavigation(req: RequestShape): boolean {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (req.path === "/api" || req.path.startsWith("/api/")) return false;
  if (req.secFetchMode) return req.secFetchMode === "navigate";
  return (req.accept ?? "").toLowerCase().includes("text/html");
}

// ── Attempt limiting ──────────────────────────────────────────────────────

/**
 * Counts wrong-key attempts per client address in a sliding window. Once a
 * client reaches `maxFailures`, further WRONG keys from it are refused with a
 * 429 until its oldest counted failure leaves the window.
 *
 * The right key is never refused. Several devices often share one address
 * (Docker's NAT, a router), and one of them retrying a stale key after a roll
 * must not lock the others, or the person signing in with the new key, out.
 * That makes this a brake on noise, not the defence against guessing: the
 * defence is the key's length (`MIN_API_KEY_LENGTH`).
 */
export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 60_000,
    private readonly maxClients = 10_000,
  ) {}

  private recent(client: string, now: number): number[] {
    const times = this.failures.get(client);
    if (!times) return [];
    const recent = times.filter((t) => now - t < this.windowMs);
    if (recent.length === 0) this.failures.delete(client);
    else this.failures.set(client, recent);
    return recent;
  }

  /** Seconds until `client` may try again; 0 when it is not blocked. */
  retryAfterSeconds(client: string, now: number): number {
    const recent = this.recent(client, now);
    if (recent.length < this.maxFailures) return 0;
    const oldestCounted = recent[recent.length - this.maxFailures];
    return Math.max(1, Math.ceil((oldestCounted + this.windowMs - now) / 1000));
  }

  recordFailure(client: string, now: number): void {
    const recent = this.recent(client, now);
    recent.push(now);
    // A burst from many addresses must not grow the map without bound: drop
    // the longest-idle client (Map iteration is insertion order).
    if (!this.failures.has(client) && this.failures.size >= this.maxClients) {
      const oldest = this.failures.keys().next().value as string;
      this.failures.delete(oldest);
    }
    this.failures.delete(client);
    this.failures.set(client, recent.slice(-this.maxFailures));
  }
}
