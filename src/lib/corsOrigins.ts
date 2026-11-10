/**
 * GH #1243: cross-origin (CORS) access to `/api/*` for a deployment that sets
 * `ALLOWED_ORIGINS`.
 *
 * `ALLOWED_DEV_ORIGINS` (next.config.ts) is a Next.js DEV-server setting: it
 * lets another hostname load the dev server's assets and HMR socket. It does
 * nothing in production and has never sent a CORS header, so a web app served
 * from another origin (a dashboard, a home-automation panel) could not read a
 * single API response, and every mutation it attempted was refused by the
 * CSRF guard (`assertSameOriginRequest`). `ALLOWED_ORIGINS` is the production
 * setting: a comma-separated list of full origins whose browser requests the
 * API answers with CORS headers and the CSRF guard accepts.
 *
 * What the list means: an allowed origin is trusted like the app's own UI.
 * Without `FILAMENTDB_API_KEY` a page served from it can read and change
 * everything the UI can, including the snapshot wipe and restore. With the key
 * set, that page must send `Authorization: Bearer <key>` like any other client.
 * Hence the deliberate restrictions:
 *
 *   - EXACT origins only (`https://dash.example.com`, `http://10.0.0.5:8123`).
 *     `*` is refused: with no key configured it would hand the unauthenticated
 *     API to every web page the user visits, which is the CSRF hole GH #252
 *     closed. A bare hostname is refused too, because it names no scheme or
 *     port and so no origin.
 *   - No `Access-Control-Allow-Credentials`. The API uses no cookies; the only
 *     credential is the bearer key, which a caller attaches explicitly.
 *   - A FIXED `Access-Control-Allow-Headers` (`Authorization, Content-Type`).
 *     In particular `x-filamentdb-print-token` is absent, so a cross-origin
 *     browser can never drive the physical label printer
 *     (`POST /api/labels/print`): its preflight fails before the request is
 *     sent.
 *
 * Unset or empty (the default) disables all of this: no header is added and
 * no request is treated differently from before.
 *
 * Pure apart from the one-time warning in `allowedOriginsFromEnv`; src/proxy.ts
 * and `assertSameOriginRequest` are the callers.
 */

export interface AllowedOrigins {
  /** Normalised origins (`URL.origin` form). */
  origins: ReadonlySet<string>;
  /** Entries that were not a usable origin, verbatim (trimmed). */
  rejected: string[];
}

/** Methods the API's route handlers implement. */
export const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
/** Request headers a cross-origin browser may send. Kept fixed, see above. */
export const CORS_ALLOW_HEADERS = "Authorization, Content-Type";
/** Response headers a cross-origin caller may read (export filenames). */
export const CORS_EXPOSE_HEADERS = "Content-Disposition";
/** How long a browser may cache a preflight answer, in seconds. */
export const CORS_MAX_AGE_SECONDS = "600";

/**
 * Normalise one origin to `URL.origin` form (lower-cased host, default port
 * dropped, IDN in punycode), or null when the value is not an http(s) origin.
 * Used both for the configured list and for a request's `Origin` header, so
 * the two compare equal whenever they name the same origin. A trailing `/` is
 * accepted; a path, query, fragment or userinfo is not (an origin has none).
 * The opaque `Origin: null` (sandboxed frames, `file:`) never matches.
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.includes("?") || v.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/") return null;
  return url.origin;
}

/** Parse the comma-separated `ALLOWED_ORIGINS` value. */
export function parseAllowedOrigins(raw: string | null | undefined): AllowedOrigins {
  const origins = new Set<string>();
  const rejected: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const origin = normalizeOrigin(entry);
    if (origin) origins.add(origin);
    else rejected.push(entry);
  }
  return { origins, rejected };
}

let cachedRaw: string | undefined;
let cachedParsed: AllowedOrigins = { origins: new Set(), rejected: [] };

/**
 * `parseAllowedOrigins` memoised on the raw value (the proxy runs on every
 * `/api` request), logging each unusable entry once per distinct value, so a
 * typo is visible in the server log rather than silently ignored.
 */
export function allowedOriginsFromEnv(raw: string | null | undefined): AllowedOrigins {
  const key = raw ?? "";
  if (key === cachedRaw) return cachedParsed;
  cachedRaw = key;
  cachedParsed = parseAllowedOrigins(key);
  for (const entry of cachedParsed.rejected) {
    console.warn(
      `[cors] Ignoring ALLOWED_ORIGINS entry ${JSON.stringify(entry)}: expected a full ` +
        `http(s) origin such as "https://dash.example.com" or "http://10.0.0.5:8123" ` +
        `("*" and bare hostnames are not accepted).`,
    );
  }
  return cachedParsed;
}

/** True when `origin` (a request's `Origin` header) is in the allowed list. */
export function isAllowedOrigin(
  origin: string | null | undefined,
  allowed: AllowedOrigins,
): boolean {
  if (allowed.origins.size === 0) return false;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowed.origins.has(normalized);
}

export interface CorsRequestInfo {
  method: string;
  origin: string | null;
  /** `Access-Control-Request-Method` — present only on a preflight. */
  requestMethod: string | null;
  /** `Access-Control-Request-Private-Network` (Chrome's Private Network Access). */
  requestPrivateNetwork: string | null;
}

export interface CorsDecision {
  /** Answer the request here with an empty 204; it is an allowed preflight. */
  preflight: boolean;
  /** Headers to add to whatever response this request gets. */
  headers: Record<string, string>;
}

/**
 * Decide the CORS headers for one `/api` request.
 *
 * - No allowed origins configured → no headers, never a preflight: the server
 *   behaves exactly as it did before `ALLOWED_ORIGINS` existed.
 * - Otherwise every response carries `Vary: Origin` (the body or headers
 *   differ by origin, so a shared cache must key on it).
 * - An allowed origin's preflight (`OPTIONS` + `Access-Control-Request-Method`)
 *   is answered directly. It must be: a preflight never carries the
 *   `Authorization` header, so it would otherwise hit the API-key gate's 401.
 * - An allowed origin's actual request gets `Access-Control-Allow-Origin`
 *   echoing its origin, which also applies to an error (a 401 from the key gate
 *   included), so the caller can read why it failed.
 * - A disallowed origin gets no `Access-Control-*` header; its preflight falls
 *   through to the normal route handling and the browser blocks the call.
 */
export function decideCors(allowed: AllowedOrigins, req: CorsRequestInfo): CorsDecision {
  if (allowed.origins.size === 0) return { preflight: false, headers: {} };
  const isPreflight =
    req.method.toUpperCase() === "OPTIONS" && req.requestMethod !== null;
  if (!isAllowedOrigin(req.origin, allowed)) {
    return { preflight: false, headers: { Vary: "Origin" } };
  }
  const origin = normalizeOrigin(req.origin) as string;
  if (isPreflight) {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Max-Age": CORS_MAX_AGE_SECONDS,
      Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    };
    // A public-origin page calling a server on a private address: Chrome asks
    // the server to opt in. The origin is on the user's list, so it has.
    if (req.requestPrivateNetwork?.toLowerCase() === "true") {
      headers["Access-Control-Allow-Private-Network"] = "true";
    }
    return { preflight: true, headers };
  }
  return {
    preflight: false,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS,
      Vary: "Origin",
    },
  };
}
