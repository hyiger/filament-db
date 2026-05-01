import { NextRequest, NextResponse } from "next/server";
import { assertExternalUrl } from "@/lib/externalUrlGuard";
import { errorResponse, getErrorMessage } from "@/lib/apiErrorHandler";

/**
 * GET /api/embed-check?url=<https-url>
 *
 * Probes a remote URL's response headers to decide whether it can be rendered
 * inside an <iframe>. Used by the filament detail page so we can show a
 * graceful fallback instead of a blank embed when the source site sets
 * `X-Frame-Options: DENY|SAMEORIGIN` or `Content-Security-Policy:
 * frame-ancestors` directives that would block embedding.
 *
 * Response shape:
 *   { embeddable: boolean, reason?: string, contentType?: string | null }
 *
 * SSRF: URL goes through assertExternalUrl (loopback / RFC1918 / metadata IPs
 * blocked, http(s) only). Redirects are followed *manually* with the same
 * guard re-applied on every hop, so a public host that 30x-redirects to a
 * private IP is rejected — closes the redirect-based SSRF gap that the
 * earlier `redirect: "follow"` implementation left open.
 *
 * Network failures (timeout, DNS, 4xx/5xx) collapse to `embeddable: false`
 * with an explanatory `reason` rather than a 5xx — the frontend should fall
 * back to the same "open in new tab" affordance either way, so a single
 * failure mode keeps the UI simple.
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
      // private space via 30x. assertExternalUrl throws on disallowed
      // schemes / loopback / RFC1918 / metadata IPs; the outer catch turns
      // that into embeddable: false.
      await assertExternalUrl(currentUrl);

      // Use GET, not HEAD: many servers (Shopify, Cloudflare-fronted sites)
      // reply to HEAD with stripped headers or 405. We only read headers
      // and discard the body, but a UA helps with picky CDNs.
      const hopRes = await fetch(currentUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FilamentDB/1.0)",
          Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
        },
        redirect: "manual",
      });

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

    // CSP frame-ancestors blocks framing when set to anything but '*' or a
    // host list that includes us. We can't know the rendering origin from
    // here, so any directive other than '*' is treated as "blocked" — false
    // positives for permissive CSPs that happen to whitelist our origin are
    // acceptable: the user still gets the "open in new tab" fallback, which
    // is the same affordance.
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
