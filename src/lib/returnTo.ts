/**
 * A caller-supplied "come back here when you're done" path (GH #1117 item h).
 *
 * The spool move-to dropdowns on the filament list and the inventory page now
 * offer "+ New location…". Without a return path that option is a one-way
 * trip: the user is deep in a list, opens a spool panel, goes to create the
 * location they actually need, and is dropped on `/locations` with their place
 * gone — which is a worse experience than the missing affordance was.
 *
 * The value arrives in a query string, so it is attacker-influenceable in the
 * ordinary sense (anyone can hand someone a link). It is therefore validated
 * as a SAME-ORIGIN, PATH-ONLY reference before anything navigates to it:
 *
 *   - must begin with a single `/` — `//evil.example` is protocol-relative and
 *     would leave the site, and `https://…` obviously would;
 *   - must not begin with `/\` — browsers historically normalized backslashes
 *     to slashes, making `/\evil.example` another protocol-relative form;
 *   - must contain no control characters, which can smuggle a scheme past a
 *     naive prefix check once the browser strips them.
 *
 * Anything that fails falls back to the caller's own default, so a malformed
 * or hostile value degrades to the pre-#1117 behaviour rather than an error.
 */

/** Characters a browser may strip or normalize before resolving a URL. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isSafeReturnPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (!value.startsWith("/")) return false;
  // Protocol-relative in both its spellings.
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  return true;
}

/** The validated return path, or `fallback` when there isn't a usable one. */
export function resolveReturnPath(value: unknown, fallback: string): string {
  return isSafeReturnPath(value) ? value : fallback;
}

/**
 * Build a link to a create form that comes back to `from` afterwards.
 *
 * `from` is encoded, so a return path carrying its own query string (the
 * inventory page's filters, say) survives the round trip intact.
 */
export function withReturnTo(href: string, from: string | null | undefined): string {
  if (!isSafeReturnPath(from)) return href;
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}from=${encodeURIComponent(from)}`;
}

/** Read the return path out of a location-like search string. */
export function readReturnPath(search: string, fallback: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return fallback;
  }
  return resolveReturnPath(params.get("from"), fallback);
}
