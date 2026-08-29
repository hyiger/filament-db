/**
 * Optional API-key gate for the REST API. When the `FILAMENTDB_API_KEY`
 * environment variable is set, EVERY `/api/*` request must present
 * `Authorization: Bearer <key>`; unset (the default) the gate is a no-op.
 *
 * Deliberately an all-or-nothing bearer gate with NO "same-origin browser is
 * trusted" exemption: `Sec-Fetch-Site` / `Origin` are only unforgeable *from a
 * browser* — the adversary here is a NON-browser client that can send any
 * header it likes, so trusting them would have bypassed the key completely.
 * Consequence: when the key is set, a browser using the web UI must also send
 * the key — the key is meant for headless / exposed deployments, NOT for the
 * desktop app serving its own renderer. See docs/mobile-app-plan.md §4.5.
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
