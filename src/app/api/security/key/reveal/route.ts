import { NextRequest, NextResponse } from "next/server";
import {
  getSecureGatewayStatus,
  revealSecureGatewayKey,
} from "@/lib/gatewayRuntime";
import { assertOwnHost } from "@/lib/gatewayRouteGuard";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * POST /api/security/key/reveal
 *
 * The secure gateway's API key, for the Settings → Network card to show and
 * copy. A POST behind the same-origin guard, not a field of `GET
 * /api/security`: a secret should not ride a cacheable, loggable read that any
 * cross-site page could at least trigger.
 *
 * Whoever can call this already has full access: this machine through the open
 * HTTP port, or a client that presented the key to the gateway. The `Host`
 * check (`assertOwnHost`) refuses a DNS-rebinding page, which the same-origin
 * guard cannot tell from the app.
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;
  const foreign = assertOwnHost(request);
  if (foreign) return foreign;

  const key = revealSecureGatewayKey();
  if (key === null) {
    return NextResponse.json(
      { error: "The secure gateway is not running, so there is no API key.", code: "gateway_off" },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { key, ...getSecureGatewayStatus().key },
    { headers: { "Cache-Control": "no-store" } },
  );
}
