import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decideApiAuth } from "@/lib/apiAuth";

/**
 * Next.js Proxy (formerly Middleware — renamed in Next 16, Node.js runtime).
 *
 * Enforces the optional API-key gate on `/api/*`. When `FILAMENTDB_API_KEY` is
 * unset (the default, and how the desktop/Electron app runs) this is a no-op.
 * When set, off-device callers must present `Authorization: Bearer <key>`;
 * the same-origin first-party web UI is unaffected. Logic + rationale live in
 * src/lib/apiAuth.ts (pure + unit-tested).
 */
export function proxy(request: NextRequest): NextResponse {
  const decision = decideApiAuth(process.env.FILAMENTDB_API_KEY, {
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
        headers: { "www-authenticate": 'Bearer realm="filament-db"' },
      },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
