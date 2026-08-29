import { NextRequest, NextResponse } from "next/server";
import { assertExternalUrl, ssrfDispatcher } from "@/lib/externalUrlGuard";
import { errorResponse, getErrorMessage } from "@/lib/apiErrorHandler";

/**
 * GET /api/embed-check?url=<https-url>
 *
 * Probes a remote URL's response headers to decide whether it can render
 * inside an <iframe> (X-Frame-Options / CSP frame-ancestors), so the detail
 * page can show a graceful fallback instead of a blank embed.
 *
 * Response: { embeddable: boolean, reason?: string, contentType?: string | null }
 *
 * SSRF: URL goes through assertExternalUrl (loopback / RFC1918 / metadata
 * IPs blocked, http(s) only). Redirects are followed *manually* with the
 * guard re-applied on every hop, so a public host that 30x-redirects to a
 * private IP is rejected — `redirect: "follow"` left that gap open.
 *
 * Network failures collapse to `embeddable: false` with a `reason` rather
 * than a 5xx — the frontend falls back to "open in new tab" either way.
 */

/** Cap redirect chains. Real-world TDS hosts rarely chain more than 2-3. */
const MAX_REDIRECTS = 5;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return errorResponse("Missing required query parameter: url", 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    let currentUrl = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Re-validate every hop so a hostile public host can't bounce us into
      // private space via 30x; the outer catch turns a throw into
      // embeddable: false.
      await assertExternalUrl(currentUrl);

      // GET, not HEAD: many servers reply to HEAD with stripped headers or
      // 405. Only headers are read; the body is discarded.
      const hopRes = await fetch(currentUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FilamentDB/1.0)",
          Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
        },
        redirect: "manual",
        // GH #256: the dispatcher re-validates at connect time, so a DNS
        // rebind after assertExternalUrl's resolution can't land the socket
        // on a private address.
        dispatcher: ssrfDispatcher,
      } as RequestInit & { dispatcher?: typeof ssrfDispatcher });

      // Treat 3xx (except 304) as a redirect we follow ourselves.
      const isRedirect = hopRes.status >= 300 && hopRes.status < 400 && hopRes.status !== 304;
      if (!isRedirect) {
        res = hopRes;
        break;
      }
      const loc = hopRes.headers.get("location");
      hopRes.body?.cancel().catch(() => {});
      if (!loc) {
        // 3xx with no Location header — treat as terminal failure.
        return NextResponse.json({
          embeddable: false,
          reason: `HTTP ${hopRes.status} with no Location header`,
        });
      }
      if (hop === MAX_REDIRECTS) {
        return NextResponse.json({
          embeddable: false,
          reason: `Too many redirects (>${MAX_REDIRECTS})`,
        });
      }
      // Resolve relative redirects against the URL we just fetched.
      currentUrl = new URL(loc, currentUrl).toString();
    }

    if (!res) {
      // Defensive: shouldn't happen because the loop either breaks on a non-
      // redirect or returns early on too-many-redirects.
      return NextResponse.json({ embeddable: false, reason: "No final response" });
    }

    // Discard body — we only care about headers.
    res.body?.cancel().catch(() => {});

    if (!res.ok) {
      return NextResponse.json({
        embeddable: false,
        reason: `HTTP ${res.status} ${res.statusText}`,
        contentType: res.headers.get("content-type") || null,
      });
    }

    const xfo = (res.headers.get("x-frame-options") || "").toLowerCase();
    const csp = (res.headers.get("content-security-policy") || "").toLowerCase();

    const blockedByXfo =
      xfo.includes("deny") || xfo.includes("sameorigin");

    // We can't know the rendering origin from here, so any frame-ancestors
    // directive other than '*' is treated as "blocked" — a false positive
    // still gets the same "open in new tab" fallback.
    const faMatch = csp.match(/frame-ancestors\s+([^;]+)/);
    const blockedByCsp = faMatch
      ? !faMatch[1].trim().split(/\s+/).includes("*")
      : false;

    return NextResponse.json({
      embeddable: !blockedByXfo && !blockedByCsp,
      contentType: res.headers.get("content-type") || null,
      ...(blockedByXfo ? { reason: `X-Frame-Options: ${xfo}` } : {}),
      ...(blockedByCsp ? { reason: `CSP frame-ancestors: ${faMatch?.[1].trim()}` } : {}),
    });
  } catch (err) {
    return NextResponse.json({
      embeddable: false,
      reason: getErrorMessage(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}
