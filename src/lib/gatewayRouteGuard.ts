import { NextResponse, type NextRequest } from "next/server";
import { isOwnHost } from "@/lib/gatewayRuntime";

/**
 * Guard for the routes that hand out or replace the secure gateway's API key:
 * refuse a request whose `Host` is not this server's own name (see
 * `isOwnHost`). Returns a 403 to short-circuit the handler, or null.
 */
export function assertOwnHost(request: NextRequest): NextResponse | null {
  if (isOwnHost(request.headers.get("host"))) return null;
  return NextResponse.json(
    {
      error:
        "The API key can only be managed from this computer's own address or through the HTTPS address.",
      code: "foreign_host",
    },
    { status: 403 },
  );
}
