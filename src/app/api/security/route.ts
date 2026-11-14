import { NextResponse } from "next/server";
import { getSecureGatewayStatus, maintainSecureGatewayTls } from "@/lib/gatewayRuntime";

// Live process state: never prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * GET /api/security
 *
 * How this server is protected right now: whether the secure gateway (HTTPS +
 * API key) is running, the addresses other devices can use, where the key
 * comes from, and the certificate in use. Backs the Settings → Network card.
 * Never returns the key itself (see `POST /api/security/key/reveal`).
 *
 * `httpKeyRequired` reports that `FILAMENTDB_API_KEY` gates this HTTP port for
 * every client: the older arrangement with no gateway, and also a gateway that
 * was asked for but is not running.
 */
export async function GET() {
  // Catch up with a changed network address now rather than at the next
  // timer tick, so the addresses listed are the ones that work.
  maintainSecureGatewayTls();
  const status = getSecureGatewayStatus();
  return NextResponse.json(
    {
      ...status,
      httpKeyRequired: Boolean(process.env.FILAMENTDB_API_KEY) && !status.running,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
