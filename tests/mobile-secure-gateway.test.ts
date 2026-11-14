import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { ensureSelfSignedTls, type GatewayTls } from "@/lib/gatewayCerts";
import { createSecureGateway, type SecureGateway } from "@/lib/secureGateway";
import { checkConnection } from "../packages/mobile/src/lib/connectionCheck";

/**
 * The mobile app's connection check against the REAL secure gateway, over
 * real sockets. The app's diagnosis rests on what the gateway answers on its
 * HTTPS port to plain HTTP (the CA download, a redirect, a 400); reading that
 * from the gateway's source is how it was designed, and this is what keeps
 * the two from drifting apart.
 *
 * What stands in for the phone: a minimal `fetch` over node:http(s) that
 * either trusts the gateway's CA or does not, the way a phone does before and
 * after the CA is installed. It is NOT Expo's native fetch; the error text
 * differs, which is exactly why the check does not depend on it.
 */
const KEY = "fdb_mobile_gateway_test_key_0123456789abcdef";

let dir: string;
let material: GatewayTls;
let upstream: http.Server;
let upstreamPort: number;
let gateway: SecureGateway | undefined;
let seenAuthorization: (string | undefined)[];

/** A fetch for a device whose trust store holds `ca` (or nothing extra). */
function deviceFetch(ca: string | null) {
  return (url: string, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const secure = url.startsWith("https:");
      const req = (secure ? https : http).request(
        url,
        {
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string> | undefined,
          agent: false,
          ...(secure ? { ca: ca ?? undefined } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const body = Buffer.concat(chunks).toString();
            resolve({
              ok: status >= 200 && status < 300,
              status,
              text: async () => body,
            } as unknown as Response);
          });
        },
      );
      // Redirects are never followed here, which is what `redirect: "manual"` asks for.
      req.on("error", (e) => reject(new Error(`fetch failed: ${e.message}`)));
      req.end();
    });
}

async function startGateway(withCa: boolean): Promise<string> {
  gateway = createSecureGateway({
    tls: material,
    caCert: withCa ? material.caCert : null,
    apiKey: KEY,
    upstream: { host: "127.0.0.1", port: upstreamPort },
  });
  const port = await gateway.listen(0, "127.0.0.1");
  return `127.0.0.1:${port}`;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-mobile-gw-"));
  material = ensureSelfSignedTls({
    dir,
    names: ["localhost", "127.0.0.1"],
    label: "test",
    now: Date.now(),
  });
  // The "app" behind the gateway: answers the read the check makes.
  upstream = http.createServer((req, res) => {
    seenAuthorization.push(req.headers.authorization);
    if (req.url === "/api/locations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html>404</html>");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await gateway?.close();
  gateway = undefined;
});

describe("mobile connection check against the secure gateway", () => {
  it("connects once the device trusts the generated CA", async () => {
    seenAuthorization = [];
    const host = await startGateway(true);
    vi.stubGlobal("fetch", deviceFetch(material.caCert));
    expect(await checkConnection({ baseUrl: `https://${host}`, apiKey: KEY }, "android")).toEqual({
      ok: true,
    });
    // The gateway checked the key and did not pass it on to the app.
    expect(seenAuthorization).toEqual([undefined]);
  });

  it("names the certificate, and where to get the CA, before the device trusts it", async () => {
    seenAuthorization = [];
    const host = await startGateway(true);
    vi.stubGlobal("fetch", deviceFetch(null));
    const result = await checkConnection({ baseUrl: `https://${host}`, apiKey: KEY }, "android");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe("untrusted-certificate");
    expect(result.problem.caUrl).toBe(`http://${host}/__filamentdb/ca.crt`);
    expect(result.problem.steps.length).toBeGreaterThan(0);
    // Nothing reached the app: the handshake failed, and the CA download is the gateway's own.
    expect(seenAuthorization).toEqual([]);
  });

  it("the download it points at is the CA the gateway's certificate chains to", async () => {
    const host = await startGateway(true);
    const res = await deviceFetch(null)(`http://${host}/__filamentdb/ca.crt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(material.caCert);
  });

  it("recognises a gateway with a provided certificate the device does not accept", async () => {
    // No CA to download: the gateway redirects the plain request to https://.
    const host = await startGateway(false);
    vi.stubGlobal("fetch", deviceFetch(null));
    const result = await checkConnection({ baseUrl: `https://${host}`, apiKey: KEY }, "ios");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe("untrusted-certificate");
    expect(result.problem.caUrl).toBeNull();
    expect(result.problem.message).toMatch(/given its own certificate/);
  });

  it("refuses a wrong key, and says it is the key", async () => {
    const host = await startGateway(true);
    vi.stubGlobal("fetch", deviceFetch(material.caCert));
    const wrong = await checkConnection(
      { baseUrl: `https://${host}`, apiKey: `${KEY}x` },
      "android",
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.problem.kind).toBe("key-rejected");

    const none = await checkConnection({ baseUrl: `https://${host}`, apiKey: null }, "android");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.problem.kind).toBe("key-required");
  });

  it("offers https for an http address on the gateway's port, without the app seeing the key", async () => {
    seenAuthorization = [];
    const host = await startGateway(true);
    vi.stubGlobal("fetch", deviceFetch(material.caCert));
    const result = await checkConnection({ baseUrl: `http://${host}`, apiKey: null }, "android");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe("https-required");
    expect(result.problem.suggestedAddress).toBe(`https://${host}`);
    expect(seenAuthorization).toEqual([]);
  });

  it("offers http for an https address on a plain-HTTP port (a desktop older than the gateway)", async () => {
    // The upstream stub stands in for the older desktop's port 3456.
    vi.stubGlobal("fetch", deviceFetch(null));
    const result = await checkConnection(
      { baseUrl: `https://127.0.0.1:${upstreamPort}`, apiKey: null },
      "android",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe("not-https");
    expect(result.problem.suggestedAddress).toBe(`http://127.0.0.1:${upstreamPort}`);
  });
});
