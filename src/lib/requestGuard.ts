import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiErrorHandler";

/** Split a `host`, `host:port`, `[ipv6]` or `[ipv6]:port` value into a
 * lower-cased hostname and its (possibly empty) port. */
function splitAuthority(value: string): { hostname: string; port: string } {
  const v = value.trim();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    const hostname = (end !== -1 ? v.slice(1, end) : v.slice(1)).toLowerCase();
    const port = end !== -1 && v[end + 1] === ":" ? v.slice(end + 2) : "";
    return { hostname, port };
  }
  const colon = v.indexOf(":");
  return colon !== -1
    ? { hostname: v.slice(0, colon).toLowerCase(), port: v.slice(colon + 1) }
    : { hostname: v.toLowerCase(), port: "" };
}

/**
 * GH #252: trusted-origin guard for destructive / admin API routes —
 * snapshot export·restore·wipe, the MongoDB connection test, and the
 * Atlas import.
 *
 * The app serves an UNAUTHENTICATED HTTP server (the Electron renderer
 * and a web/Docker deployment both talk to it same-origin). Without a
 * guard, any web page the user visits can drive these routes
 * cross-origin (CSRF): wipe the database, exfiltrate a snapshot, or
 * make the server open MongoDB connections to probe the LAN.
 *
 * The guard rejects requests that carry cross-origin browser
 * provenance:
 *   - `Sec-Fetch-Site` present and not `same-origin` / `none` — every
 *     modern browser tags each request; a CSRF request reads
 *     `cross-site` or `same-site`.
 *   - an `Origin` header whose host does not match the request `Host`.
 *
 * A non-browser client (curl, a slicer integration script) sends
 * neither header and cannot be a CSRF vector, so it passes — this is a
 * CSRF / trusted-origin guard, not an authentication layer. Protecting
 * an instance that is reachable from an untrusted network is a
 * deployment concern the README already calls out.
 *
 * Returns a 403 `NextResponse` to short-circuit the handler, or `null`
 * when the request may proceed.
 */
export function assertSameOriginRequest(request: NextRequest): NextResponse | null {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none"
  ) {
    return errorResponse(
      "Cross-origin request to a protected route was rejected.",
      403,
    );
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const hostHeader = request.headers.get("host");
    if (!hostHeader) {
      return errorResponse(
        "Cross-origin request to a protected route was rejected.",
        403,
      );
    }
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return errorResponse(
        "Cross-origin request to a protected route was rejected.",
        403,
      );
    }
    // Compare the full authority — hostname AND port. A hostname-only
    // check is too lenient: when `Sec-Fetch-Site` is absent (older
    // browsers, embedded webviews, intermediaries that strip Fetch
    // Metadata) a cross-origin request from the SAME host but a
    // different port would otherwise slip through (Codex review).
    // Ports are normalised against the Origin's scheme default, so an
    // explicit `:443`/`:80` on one side and an omitted default on the
    // other still compare equal — no false-reject on the PORT behind a
    // proxy. GH #899/#924: this normalisation only covers the port. The HOST
    // is compared against the raw `Host` header and `X-Forwarded-Host` is NOT
    // consulted. This check runs even when `Sec-Fetch-Site` was accepted above
    // (the function doesn't early-return), and browsers DO send `Origin` on
    // same-origin mutating requests (POST/PUT/PATCH/DELETE) — so a reverse
    // proxy that rewrites Host to the upstream address (e.g. nginx's bare
    // `proxy_pass`) makes EVERY browser mutation through it look cross-origin
    // and 403, not just non-Fetch-Metadata clients. The proxy MUST preserve
    // the original Host authority INCLUDING port (`proxy_set_header Host
    // $http_host`; Caddy does by default) — documented in docs/setup.md.
    // Forwarded headers are deliberately not trusted here: spoofable by a
    // direct (non-proxied) client, and the only safe deployment already
    // requires the app to be loopback-bound with the proxy as the sole ingress.
    const defaultPort = originUrl.protocol === "https:" ? "443" : "80";
    const originHostname = originUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const originPort = originUrl.port || defaultPort;
    const hostParts = splitAuthority(hostHeader);
    const hostPort = hostParts.port || defaultPort;
    if (originHostname !== hostParts.hostname || originPort !== hostPort) {
      return errorResponse(
        "Cross-origin request to a protected route was rejected.",
        403,
      );
    }
  }

  return null;
}
