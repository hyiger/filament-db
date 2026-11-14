import { NextRequest, NextResponse } from "next/server";
import {
  ApiKeyNotRollableError,
  rollSecureGatewayKey,
} from "@/lib/gatewayRuntime";
import { assertOwnHost } from "@/lib/gatewayRouteGuard";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * POST /api/security/key/roll
 *
 * Replace the secure gateway's API key with a new random one and return it.
 * Effective immediately, with no restart: the previous key stops working and
 * every browser session signed in with it ends, so each device has to be given
 * the new key.
 *
 * 409 `gateway_off` when no gateway is running; 409 `env_key` when the key is
 * fixed by `FILAMENTDB_API_KEY` (change it in the environment instead).
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;
  const foreign = assertOwnHost(request);
  if (foreign) return foreign;

  try {
    const key = rollSecureGatewayKey();
    return NextResponse.json({ key }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ApiKeyNotRollableError) {
      return NextResponse.json({ error: err.message, code: err.reason }, { status: 409 });
    }
    throw err;
  }
}
