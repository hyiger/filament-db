import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decideApiAuth, httpPortApiKey } from "@/lib/apiAuth";
import { allowedOriginsFromEnv, decideCors } from "@/lib/corsOrigins";

/**
 * Next.js Proxy (formerly Middleware — renamed in Next 16, Node.js runtime).
 *
 * Two jobs on `/api/*`, both no-ops by default:
 *
 * 1. CORS for the origins listed in `ALLOWED_ORIGINS` (GH #1243). An allowed
 *    origin's preflight is answered here, BEFORE the key gate (a preflight
 *    never carries `Authorization`), and every other response to it carries
 *    `Access-Control-Allow-Origin`. Logic + rationale in src/lib/corsOrigins.ts.
 *
 * 2. The optional API-key gate. When `FILAMENTDB_API_KEY` is unset (the
 *    default, and how the desktop/Electron app runs) this is a no-op. When set,
 *    the gate is ALL-OR-NOTHING: every `/api/*` request — including the
 *    first-party browser UI's same-origin fetches — must present
 *    `Authorization: Bearer <key>` or it gets a 401. There is deliberately no
 *    same-origin exemption (Origin/Sec-Fetch headers are forgeable by
 *    non-browser callers). The web UI does NOT attach the key, so setting it is
 *    for non-browser clients (the mobile companion, PrusaSlicer/OrcaSlicer,
 *    curl) and for a cross-origin browser app that sends the key itself; a
 *    browser-UI deployment should instead bind loopback (and use the desktop
 *    app) or sit behind an authenticating reverse proxy — see docs/setup.md
 *    "Securing a network-exposed instance". Logic + rationale live in
 *    src/lib/apiAuth.ts (pure + unit-tested).
 *
 *    While the secure gateway is running (`FILAMENTDB_HTTPS_PORT`) the key is
 *    checked there, on the HTTPS port, and this port is the open local one, so
 *    the gate here is off (`httpPortApiKey`). A gateway that failed to start
 *    leaves this gate on.
 */
export function proxy(request: NextRequest): NextResponse {
  const cors = decideCors(allowedOriginsFromEnv(process.env.ALLOWED_ORIGINS), {
    method: request.method,
    origin: request.headers.get("origin"),
    requestMethod: request.headers.get("access-control-request-method"),
    requestPrivateNetwork: request.headers.get("access-control-request-private-network"),
  });
  if (cors.preflight) {
    return new NextResponse(null, { status: 204, headers: cors.headers });
  }

  const decision = decideApiAuth(httpPortApiKey(process.env), {
    authorization: request.headers.get("authorization"),
  });

  if (decision === "unauthorized") {
    return NextResponse.json(
      {
        error:
          "Unauthorized — this Filament DB requires an API key. Send 'Authorization: Bearer <key>'.",
      },
      {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="filament-db"', ...cors.headers },
      },
    );
  }

  // Headers set on the pass-through response are merged into the route
  // handler's response by Next.
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(cors.headers)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
