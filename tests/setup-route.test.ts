import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/setup/route";

/**
 * Route tests for POST /api/setup — the connection-test handler that opens
 * an outbound MongoDB connection to a caller-supplied URI and pings it.
 *
 * Previously had no route-level coverage. Covers the CSRF guard (GH #252),
 * the scheme guard (GH #254, via `assertSafeMongoUri`), body validation, a
 * real successful ping against the in-memory server (`process.env.MONGODB_URI`
 * is set by tests/setup.ts), and the connection-failure branch with its
 * credential scrub.
 */
function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/setup", () => {
  it("rejects a cross-site browser request with 403 (CSRF guard)", async () => {
    const res = await POST(
      req({ mongodbUri: process.env.MONGODB_URI }, { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for an unparseable JSON body", async () => {
    const res = await POST(req("{ not json", {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid request body/i);
  });

  it("returns 400 when mongodbUri is missing", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/uri is required/i);
  });

  it("returns 400 when mongodbUri is not a string", async () => {
    const res = await POST(req({ mongodbUri: 1234 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/uri is required/i);
  });

  it("returns 400 for a non-mongodb scheme (assertSafeMongoUri rejects)", async () => {
    const res = await POST(req({ mongodbUri: "http://localhost:27017" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 and scrubs credentials when the connection fails", async () => {
    // Resolvable host (127.0.0.1) so it passes the scheme/host guard, but a
    // dead port so the ping fails — exercising the catch branch + the
    // `mongodb://***` credential scrub (route.ts:51).
    const res = await POST(
      req({ mongodbUri: "mongodb://user:secret@127.0.0.1:1/db" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.error).not.toContain("secret");
    // GH #1231: classified for the setup page's translated hint.
    expect(body).toMatchObject({ kind: "unreachable", atlas: false });
  }, 20000);

  // GH #1231: the driver rejects some strings in its constructor; that
  // used to escape the try as an unhandled 500 with the raw message.
  it("classifies a string the driver's constructor rejects as invalid-uri", async () => {
    const res = await POST(req({ mongodbUri: "mongodb://user:secret@127.0.0.1:1/db?tls=maybe" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.kind).toBe("invalid-uri");
    expect(body.error).not.toContain("secret");
  });

  it("returns success for a reachable mongodb URI (real ping)", async () => {
    const res = await POST(req({ mongodbUri: process.env.MONGODB_URI }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  }, 20000);
});
