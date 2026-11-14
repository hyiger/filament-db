import { NextResponse } from "next/server";
import { getSecureGatewayCaCert } from "@/lib/gatewayRuntime";

export const dynamic = "force-dynamic";

/**
 * GET /api/security/ca
 *
 * The certificate of the local CA that signs the secure gateway's generated
 * server certificate, as a download. Installing it on a phone or another
 * computer is what makes that device trust the gateway's `https://` address.
 * A certificate is public; its private key never leaves the secure directory.
 * 404 when the gateway is off or uses the operator's own certificate.
 */
export async function GET() {
  const ca = getSecureGatewayCaCert();
  if (!ca) {
    return NextResponse.json(
      { error: "There is no local CA certificate to download." },
      { status: 404 },
    );
  }
  return new NextResponse(ca, {
    headers: {
      "Content-Type": "application/x-x509-ca-cert",
      "Content-Disposition": 'attachment; filename="filament-db-ca.crt"',
      "Cache-Control": "no-store",
    },
  });
}
