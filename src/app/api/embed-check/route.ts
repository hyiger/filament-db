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
 * blocked, http(s) only). Same residual-redirect caveat as tdsExtractor.
 *
 * Network failures (timeout, DNS, 4xx/5xx) collapse to `embeddable: false`
 * with an explanatory `reason` rather than a 5xx — the frontend should fall
 * back to the same "open in new tab" affordance either way, so a single
 * failure mode keeps the UI simple.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return errorResponse("Missing required query parameter: url", 400);
  }

  try {
    await assertExternalUrl(url);
  } catch (err) {
    return NextResponse.json({ embeddable: false, reason: getErrorMessage(err) });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    // Use GET, not HEAD: many servers (Shopify, Cloudflare-fronted sites)
    // reply to HEAD with stripped headers or 405. We only read headers and
    // discard the body, but we set a User-Agent so picky CDNs don't gate
    // us out.
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FilamentDB/1.0)",
        Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
      },
      redirect: "follow",
    });
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
