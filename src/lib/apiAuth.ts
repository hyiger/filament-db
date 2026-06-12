/**
 * Optional API-key gate for the REST API (GH: mobile-scanner Phase 0).
 *
 * Filament DB ships UNAUTHENTICATED — it's designed for single-user localhost
 * or a trusted LAN, and the README says so. The mobile scanner app talks to it
 * over the network, which widens the trust boundary: anyone who can reach the
 * host can otherwise drive every endpoint.
 *
 * When the `FILAMENTDB_API_KEY` environment variable is set, this gate requires
 * EVERY `/api/*` request to present `Authorization: Bearer <key>`. When it is
 * unset (the default, and how the desktop/Electron app runs) the gate is a
 * no-op and behavior is unchanged.
 *
 * It is deliberately an all-or-nothing bearer gate with NO "same-origin browser
 * is trusted" exemption. An earlier draft tried to let the first-party web UI
 * through keyless by trusting `Sec-Fetch-Site` / `Origin`, but those headers
 * are only unforgeable *from a browser* — the Fetch spec forbids page JS from
 * setting them, the server cannot. The adversary here is a NON-browser client
 * (curl, the mobile app, an attacker's script) that can send any header it
 * likes, so `Sec-Fetch-Site: none` or a spoofed `Origin: <host>` would have
 * bypassed the key completely. Bearer-only is the only header-based scheme that
 * actually authenticates an off-device caller.
 *
 * Consequence: when the key is set, a browser using the web UI must also send
 * the key, so the key is meant for headless / exposed deployments that the
 * mobile app (or curl / slicer integrations) talk to — NOT for the desktop app
 * serving its own renderer. Giving the browser web UI a keyless session would
 * need a real login/cookie flow, which is out of scope here. See
 * docs/mobile-app-plan.md §4.5.
 *
 * The decision is a pure function of the Authorization header so it can be
 * unit-tested without a server; src/proxy.ts is a thin wrapper.
 */

export interface ApiAuthHeaders {
  authorization: string | null;
}

export type ApiAuthDecision = "allow" | "unauthorized";

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time string comparison — avoids leaking how many leading characters
 * of the key matched via response timing. Returns false fast on a length
 * mismatch (key length is not meaningfully sensitive).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Decide whether a request to `/api/*` may proceed.
 *
 * - No key configured → always allow (auth disabled; default behavior).
 * - Otherwise → allow only with a valid `Authorization: Bearer <key>`.
 */
export function decideApiAuth(
  apiKey: string | undefined | null,
  h: ApiAuthHeaders,
): ApiAuthDecision {
  if (!apiKey) return "allow";
  const header = h.authorization || "";
  const presented = header.startsWith(BEARER_PREFIX)
    ? header.slice(BEARER_PREFIX.length)
    : "";
  if (presented && constantTimeEqual(presented, apiKey)) return "allow";
  return "unauthorized";
}
