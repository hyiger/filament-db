import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { parseAllowedOrigins } from "@/lib/corsOrigins";
import { AttemptLimiter, SESSION_COOKIE } from "@/lib/gatewayAuth";
import { ensureSelfSignedTls, type GatewayTls } from "@/lib/gatewayCerts";
import {
  CA_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  createSecureGateway,
  type SecureGateway,
  type SecureGatewayOptions,
} from "@/lib/secureGateway";

/**
 * The secure gateway end to end, over real sockets: a stub "app" upstream, the
 * gateway in front of it, and a TLS client that trusts the generated CA.
 */

const KEY = "fdb_gateway_test_key_0123456789";
const START = 1_800_000_000_000;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let dir: string;
let material: GatewayTls;
let upstream: http.Server;
let upstreamPort: number;
let seen: Seen[];
let upstreamClosed: number;
let gateway: SecureGateway;
let port: number;
let clock: number;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-gw-"));
  material = ensureSelfSignedTls({
    dir,
    names: ["localhost", "127.0.0.1"],
    label: "test",
    now: Date.now(),
  });
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const record: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(record);
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": connected\n\n");
        const timer = setInterval(() => res.write("data: tick\n\n"), 20);
        res.on("close", () => {
          clearInterval(timer);
          upstreamClosed++;
        });
        return;
      }
      if (req.url === "/hop") {
        res.writeHead(201, {
          "content-type": "text/plain",
          "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
          "keep-alive": "timeout=5",
          "x-app": "yes",
        });
        res.end("created");
        return;
      }
      if (req.url === "/reset") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(record));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(over: Partial<SecureGatewayOptions> = {}): Promise<void> {
  gateway = createSecureGateway({
    tls: material,
    caCert: material.caCert,
    apiKey: KEY,
    upstream: { host: "127.0.0.1", port: upstreamPort },
    now: () => clock,
    ...over,
  });
  port = await gateway.listen(0, "127.0.0.1");
}

beforeEach(async () => {
  seen = [];
  upstreamClosed = 0;
  clock = START;
  await start();
});

afterEach(async () => {
  vi.useRealTimers();
  await gateway.close();
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: () => Record<string, unknown>;
}

function call(
  options: { plain?: boolean; method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const common = {
      host: "127.0.0.1",
      port,
      method: options.method ?? "GET",
      path: options.path ?? "/",
      headers: options.headers,
      agent: false as const,
    };
    const onResponse = (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
      res.on("error", reject);
    };
    const req = options.plain
      ? http.request(common, onResponse)
      : https.request({ ...common, ca: material.caCert!, servername: "localhost" }, onResponse);
    req.on("error", reject);
    req.end(options.body);
  });
}

const bearer = (key = KEY) => ({ authorization: `Bearer ${key}` });
const form = { "content-type": "application/x-www-form-urlencoded" };

async function signIn(next = "/"): Promise<string> {
  const res = await call({
    method: "POST",
    path: LOGIN_PATH,
    headers: form,
    body: `key=${encodeURIComponent(KEY)}&next=${encodeURIComponent(next)}`,
  });
  expect(res.status).toBe(303);
  return String(res.headers["set-cookie"]?.[0]).split(";")[0];
}

describe("API clients (bearer key)", () => {
  it("forwards a request that presents the key", async () => {
    const res = await call({ path: "/api/filaments?type=PLA", headers: bearer() });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ method: "GET", url: "/api/filaments?type=PLA" });
  });

  it("refuses a request with no credential", async () => {
    const res = await call({ path: "/api/filaments" });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Bearer realm="filament-db"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().error).toMatch(/requires an API key/);
    expect(seen).toHaveLength(0);
  });

  it("refuses a wrong key and another scheme", async () => {
    expect((await call({ path: "/api/x", headers: bearer(KEY + "x") })).status).toBe(401);
    expect((await call({ path: "/api/x", headers: bearer(KEY.slice(1)) })).status).toBe(401);
    expect((await call({ path: "/api/x", headers: { authorization: `Basic ${KEY}` } })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("does not pass the key on to the app, and marks the request as HTTPS", async () => {
    const res = await call({
      method: "POST",
      path: "/api/filaments",
      headers: {
        ...bearer(),
        host: "studio.local:3457",
        origin: "https://studio.local:3457",
        "content-type": "application/json",
        "x-forwarded-for": "1.2.3.4",
        "x-forwarded-proto": "http",
        "x-forwarded-host": "evil.example",
        "x-filamentdb-print-token": "tok",
        te: "trailers",
        "proxy-authorization": "Basic abc",
      },
      body: '{"name":"PLA"}',
    });
    const headers = res.json().headers as IncomingHttpHeaders;
    expect(res.json().body).toBe('{"name":"PLA"}');
    expect(headers.authorization).toBeUndefined();
    // Host and Origin reach the app untouched: its CSRF guard compares them.
    expect(headers.host).toBe("studio.local:3457");
    expect(headers.origin).toBe("https://studio.local:3457");
    // The gateway is the edge: forwarding headers a client sent are replaced.
    expect(headers["x-forwarded-proto"]).toBe("https");
    expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(headers["x-forwarded-host"]).toBe("studio.local:3457");
    expect(headers["x-filamentdb-print-token"]).toBe("tok");
    expect(headers.te).toBeUndefined();
    expect(headers["proxy-authorization"]).toBeUndefined();
  });

  it("forwards a request that names no host (HTTP/1.0) without inventing a forwarded host", async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({ host: "127.0.0.1", port, ca: material.caCert!, servername: "localhost" }, () => {
        socket.write(`GET /api/no-host HTTP/1.0\r\nAuthorization: Bearer ${KEY}\r\nX-Forwarded-Host: evil.example\r\n\r\n`);
      });
      socket.on("data", () => {});
      socket.on("close", () => resolve());
      socket.on("error", reject);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/no-host");
    expect(seen[0].headers["x-forwarded-host"]).toBeUndefined();
    expect(seen[0].headers["x-forwarded-proto"]).toBe("https");
  });

  it("forwards a streamed (chunked) request body", async () => {
    const res = await new Promise<Reply>((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port, method: "PUT", path: "/api/big", headers: bearer(), ca: material.caCert!, servername: "localhost", agent: false },
        (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body, json: () => JSON.parse(body) }));
        },
      );
      req.on("error", reject);
      req.write("a".repeat(70_000));
      req.end("b".repeat(70_000));
    });
    expect(res.status).toBe(200);
    expect(String(res.json().body)).toHaveLength(140_000);
    expect((res.json().headers as IncomingHttpHeaders)["transfer-encoding"]).toBe("chunked");
  });

  it("passes the app's status and headers back, minus connection-level ones", async () => {
    const res = await call({ path: "/hop", headers: bearer() });
    expect(res.status).toBe(201);
    expect(res.body).toBe("created");
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers["x-app"]).toBe("yes");
    expect(res.headers["keep-alive"]).toBeUndefined();
  });

  it("answers 502 when the app is not reachable", async () => {
    await gateway.close();
    await start({ upstream: { host: "127.0.0.1", port: 1 } });
    const res = await call({ path: "/api/x", headers: bearer() });
    expect(res.status).toBe(502);
    expect(res.json().error).toMatch(/did not answer/);
  });

  it("drops the client when the app dies mid-response", async () => {
    await expect(call({ path: "/reset", headers: bearer() })).rejects.toThrow();
  });
});

describe("wrong-key limiting", () => {
  it("refuses further wrong keys after too many, but never the right key", async () => {
    await gateway.close();
    await start({ limiter: new AttemptLimiter(3, 60_000) });
    for (let i = 0; i < 3; i++) {
      expect((await call({ path: "/api/x", headers: bearer("wrong") })).status).toBe(401);
    }
    const refused = await call({ path: "/api/x", headers: bearer("wrong") });
    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toBe("60");
    expect(seen).toHaveLength(0);

    // Devices behind one address share this counter (Docker's NAT, a router).
    // A phone retrying a stale key must not lock out the one that has the key.
    expect((await call({ path: "/api/x", headers: bearer() })).status).toBe(200);
    expect((await call({ path: "/api/x", headers: bearer("wrong") })).status).toBe(429);

    clock += 60_000;
    expect((await call({ path: "/api/x", headers: bearer("wrong") })).status).toBe(401);
  });

  it("limits the sign-in form with the same counter, and still accepts the right key", async () => {
    await gateway.close();
    await start({ limiter: new AttemptLimiter(2, 60_000) });
    const attempt = (key: string) =>
      call({ method: "POST", path: LOGIN_PATH, headers: form, body: `key=${key}` });
    expect((await attempt("nope")).status).toBe(401);
    expect((await call({ path: "/api/x", headers: bearer("nope") })).status).toBe(401);
    const limited = await attempt("nope");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.body).toContain("Too many attempts");
    expect(limited.headers["set-cookie"]).toBeUndefined();

    const signedIn = await attempt(KEY);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers["set-cookie"]).toBeDefined();
  });

  it("does not count requests that present no key", async () => {
    await gateway.close();
    await start({ limiter: new AttemptLimiter(1, 60_000) });
    for (let i = 0; i < 5; i++) await call({ path: "/api/x" });
    // An expired or foreign session cookie is not a guess at the key.
    for (let i = 0; i < 5; i++) await call({ path: "/api/x", headers: { cookie: `${SESSION_COOKIE}=v1.x.y.z` } });
    expect((await call({ path: "/api/x", headers: bearer("wrong") })).status).toBe(401);
    expect((await call({ path: "/api/x", headers: bearer("wrong") })).status).toBe(429);
  });

  it("does not let another site spend the user's attempts through their browser", async () => {
    await gateway.close();
    await start({ limiter: new AttemptLimiter(1, 60_000) });
    const crossSite = (headers: Record<string, string>) =>
      call({ method: "POST", path: LOGIN_PATH, headers: { ...form, ...headers }, body: "key=guess" });
    expect((await crossSite({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await crossSite({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await crossSite({ host: "studio.local:3457", origin: "https://evil.example" })).status).toBe(403);
    // Not even the right key signs in from another site.
    const forged = await call({
      method: "POST",
      path: LOGIN_PATH,
      headers: { ...form, "sec-fetch-site": "cross-site" },
      body: `key=${KEY}`,
    });
    expect(forged.status).toBe(403);
    expect(forged.headers["set-cookie"]).toBeUndefined();
    // Nothing was counted: the first real wrong key is still an ordinary 401.
    expect((await call({ method: "POST", path: LOGIN_PATH, headers: form, body: "key=wrong" })).status).toBe(401);
  });
});

describe("browsers (sign-in page and session)", () => {
  it("sends a page navigation without a session to the sign-in page", async () => {
    const res = await call({ path: "/inventory?location=abc", headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${LOGIN_PATH}?next=%2Finventory%3Flocation%3Dabc`);
  });

  it("serves the sign-in page with a locked-down policy", async () => {
    const res = await call({ path: `${LOGIN_PATH}?next=%2Finventory`, headers: { "accept-language": "de" } });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.body).toContain('name="next" value="/inventory"');
    expect(res.body).toContain("Bei Filament DB anmelden");
    const head = await call({ method: "HEAD", path: LOGIN_PATH });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("signs in with the key and returns to the requested page", async () => {
    const res = await call({
      method: "POST",
      path: LOGIN_PATH,
      headers: form,
      body: `key=${KEY}&next=%2Finventory%3Flocation%3Dabc`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/inventory?location=abc");
    const cookie = String(res.headers["set-cookie"]?.[0]);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.[^;]+; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$`));
  });

  it("accepts the form from its own page, however the browser reports the origin", async () => {
    const post = (headers: Record<string, string>) =>
      call({ method: "POST", path: LOGIN_PATH, headers: { ...form, ...headers }, body: `key=${KEY}` });
    const sameOrigin = { host: "studio.local:3457", origin: "https://studio.local:3457" };
    expect((await post({ ...sameOrigin, "sec-fetch-site": "same-origin" })).status).toBe(303);
    expect((await post(sameOrigin)).status).toBe(303);
    // A browser withholding the origin still says the request is same-origin.
    expect((await post({ origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(303);
    // The page must not ask browsers to withhold it in the first place.
    expect((await call({ path: LOGIN_PATH })).headers["referrer-policy"]).toBe("same-origin");
  });

  it("re-shows the form for a wrong key, without a cookie", async () => {
    const res = await call({ method: "POST", path: LOGIN_PATH, headers: form, body: "key=wrong&next=%2Finventory" });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body).toContain("That key is not correct.");
    expect(res.body).toContain('name="next" value="/inventory"');
    const empty = await call({ method: "POST", path: LOGIN_PATH, headers: form, body: "" });
    expect(empty.status).toBe(401);
  });

  it("never redirects to another site after sign-in", async () => {
    for (const next of ["//evil.example/", "https://evil.example/", "/\\evil.example", LOGIN_PATH]) {
      const res = await call({
        method: "POST",
        path: LOGIN_PATH,
        headers: form,
        body: `key=${KEY}&next=${encodeURIComponent(next)}`,
      });
      expect(res.headers.location).toBe("/");
    }
  });

  it("forwards requests carrying the session, without the session cookie", async () => {
    const cookie = await signIn();
    const res = await call({
      path: "/api/filaments",
      headers: { cookie: `theme=dark; ${cookie}`, authorization: "Basic keep-me" },
    });
    expect(res.status).toBe(200);
    const headers = res.json().headers as IncomingHttpHeaders;
    expect(headers.cookie).toBe("theme=dark");
    // Not the gateway's credential, so not the gateway's to remove.
    expect(headers.authorization).toBe("Basic keep-me");

    const only = await call({ path: "/api/filaments", headers: { cookie } });
    expect((only.json().headers as IncomingHttpHeaders).cookie).toBeUndefined();
  });

  it("skips the sign-in page for a browser that is already signed in", async () => {
    const cookie = await signIn();
    const res = await call({ path: `${LOGIN_PATH}?next=%2Fdashboard`, headers: { cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/dashboard");
  });

  it("ends a session when it expires", async () => {
    const cookie = await signIn();
    clock += 30 * 24 * 60 * 60 * 1000 - 1;
    expect((await call({ path: "/api/x", headers: { cookie } })).status).toBe(200);
    clock += 1;
    expect((await call({ path: "/api/x", headers: { cookie } })).status).toBe(401);
  });

  it("rejects a sign-in that is not a form post", async () => {
    const json = await call({
      method: "POST",
      path: LOGIN_PATH,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: KEY }),
    });
    expect(json.status).toBe(415);
    expect((await call({ method: "POST", path: LOGIN_PATH, body: `key=${KEY}` })).status).toBe(415);
    const put = await call({ method: "PUT", path: LOGIN_PATH, headers: form, body: `key=${KEY}` });
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe("GET, HEAD, POST");
  });

  it("rejects an oversized sign-in body", async () => {
    const res = await call({
      method: "POST",
      path: LOGIN_PATH,
      headers: form,
      body: `key=${KEY}&next=${"a".repeat(9000)}`,
    });
    expect(res.status).toBe(413);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("signs out, clearing the cookie", async () => {
    const res = await call({
      method: "POST",
      path: LOGOUT_PATH,
      headers: { host: "studio.local:3457", origin: "https://studio.local:3457", "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(LOGIN_PATH);
    expect(String(res.headers["set-cookie"]?.[0])).toContain(`${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    // A non-browser client sends neither header.
    expect((await call({ method: "POST", path: LOGOUT_PATH })).status).toBe(303);
  });

  it("refuses a sign-out that another site triggered, and one that is not a POST", async () => {
    const cross = (headers: Record<string, string>) => call({ method: "POST", path: LOGOUT_PATH, headers });
    expect((await cross({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await cross({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await cross({ host: "studio.local:3457", origin: "https://evil.example" })).status).toBe(403);
    expect((await cross({ origin: "not a url" })).status).toBe(403);
    const get = await call({ path: LOGOUT_PATH });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
  });
});

describe("rolling the key", () => {
  it("ends the old key and every session signed in with it", async () => {
    const cookie = await signIn();
    gateway.setApiKey("fdb_rolled_key_0123456789abcdef");
    expect((await call({ path: "/api/x", headers: bearer() })).status).toBe(401);
    expect((await call({ path: "/api/x", headers: { cookie } })).status).toBe(401);
    expect((await call({ path: "/api/x", headers: bearer("fdb_rolled_key_0123456789abcdef") })).status).toBe(200);
  });
});

describe("the gateway's own paths", () => {
  it("never forwards anything under its prefix", async () => {
    for (const p of ["/__filamentdb", "/__filamentdb/", "/__filamentdb/other", "/__filamentdb/login/x"]) {
      const res = await call({ path: p, headers: bearer() });
      expect(res.status).toBe(404);
    }
    expect(seen).toHaveLength(0);
    // A different path that only starts with the same characters is the app's.
    expect((await call({ path: "/__filamentdb-notes", headers: bearer() })).status).toBe(200);
  });

  it("offers the CA certificate without a credential", async () => {
    const res = await call({ path: CA_PATH });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-x509-ca-cert");
    expect(res.headers["content-disposition"]).toContain("filament-db-ca.crt");
    expect(new X509Certificate(res.body).fingerprint256).toBe(material.caFingerprint256);
    const head = await call({ method: "HEAD", path: CA_PATH });
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(material.caCert!)));
    expect(head.body).toBe("");
    // POST is not a download; it falls into the reserved prefix.
    expect((await call({ method: "POST", path: CA_PATH })).status).toBe(404);
  });

  it("has no CA to offer with an own certificate", async () => {
    await gateway.close();
    await start({ caCert: null });
    const res = await call({ path: CA_PATH });
    expect(res.status).toBe(404);
    expect(res.json().error).toMatch(/own certificate/);
  });
});

describe("cross-origin pages (ALLOWED_ORIGINS)", () => {
  const allowedOrigins = parseAllowedOrigins("https://dash.example.com");

  beforeEach(async () => {
    await gateway.close();
    await start({ allowedOrigins });
  });

  it("answers a listed origin's preflight without a credential", async () => {
    const res = await call({
      method: "OPTIONS",
      path: "/api/filaments",
      headers: { origin: "https://dash.example.com", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://dash.example.com");
    expect(res.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type");
    expect(seen).toHaveLength(0);
  });

  it("lets a listed origin's page read the 401", async () => {
    const res = await call({ path: "/api/filaments", headers: { origin: "https://dash.example.com" } });
    expect(res.status).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe("https://dash.example.com");
  });

  it("gives an unlisted origin's preflight nothing", async () => {
    const res = await call({
      method: "OPTIONS",
      path: "/api/filaments",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("streaming", () => {
  it("delivers server-sent events as they are produced and stops the app when the client leaves", async () => {
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port, path: "/stream", headers: bearer(), ca: material.caCert!, servername: "localhost", agent: false },
        (res) => {
          expect(res.headers["content-type"]).toBe("text/event-stream");
          res.on("data", (c: Buffer) => {
            chunks.push(c.toString());
            if (chunks.length === 3) {
              req.destroy();
              resolve();
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(chunks[0]).toBe(": connected\n\n");
    await vi.waitFor(() => expect(upstreamClosed).toBe(1));
  });

  it("close() ends open streams instead of waiting for them", async () => {
    const ended = new Promise<void>((resolve) => {
      const req = https.request(
        { host: "127.0.0.1", port, path: "/stream", headers: bearer(), ca: material.caCert!, servername: "localhost", agent: false },
        (res) => {
          res.once("data", () => void gateway.close());
          res.on("close", () => resolve());
          res.on("error", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.end();
    });
    await ended;
    await vi.waitFor(() => expect(upstreamClosed).toBe(1));
  });
});

describe("plain HTTP on the HTTPS port", () => {
  it("redirects a page request to https on the same host", async () => {
    const res = await call({ plain: true, path: "/inventory?x=1", headers: { host: "studio.local:3457" } });
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe("https://studio.local:3457/inventory?x=1");
    expect(res.headers.connection).toBe("close");
    const v6 = await call({ plain: true, path: "/", headers: { host: "[fe80::1]:3457" } });
    expect(v6.headers.location).toBe("https://[fe80::1]:3457/");
  });

  it("refuses API calls and writes instead of redirecting them, and never forwards", async () => {
    const api = await call({ plain: true, path: "/api/filaments", headers: bearer() });
    expect(api.status).toBe(400);
    expect(api.json().error).toMatch(/only accepts HTTPS/);
    expect((await call({ plain: true, path: "/api" })).status).toBe(400);
    expect((await call({ plain: true, method: "POST", path: "/inventory", body: "x" })).status).toBe(400);
    expect((await call({ plain: true, method: "POST", path: LOGIN_PATH, headers: form, body: `key=${KEY}` })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("does not redirect to a Host it cannot trust as a host name", async () => {
    for (const host of ["evil.example/path", "a b", "user@evil.example"]) {
      const res = await call({ plain: true, path: "/", headers: { host } });
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
    // No Host at all (HTTP/1.0): written by hand, since Node's client adds one.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write("GET / HTTP/1.0\r\n\r\n"));
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    expect(raw).not.toMatch(/location:/i);
  });

  it("hands out the CA certificate, so a device can trust the HTTPS address first", async () => {
    const res = await call({ plain: true, path: CA_PATH });
    expect(res.status).toBe(200);
    expect(res.headers.connection).toBe("close");
    expect(new X509Certificate(res.body).fingerprint256).toBe(material.caFingerprint256);
  });

  it("redirects the CA path too when there is no CA", async () => {
    await gateway.close();
    await start({ caCert: null });
    const res = await call({ plain: true, path: CA_PATH, headers: { host: "studio.local:3457" } });
    expect(res.status).toBe(308);
  });
});

describe("connections", () => {
  it("drops a connection that closes without sending anything", async () => {
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.end());
      socket.on("close", () => resolve());
    });
    expect((await call({ path: "/api/x", headers: bearer() })).status).toBe(200);
  });

  describe("a client that connects and does not finish a request", () => {
    const closesWithin = (socket: net.Socket, ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        socket.on("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.on("error", () => {});
      });

    beforeEach(async () => {
      await gateway.close();
      await start({ limits: { requestHeadMs: 150, loginBodyMs: 150 } });
    });

    it("is dropped when it says nothing", async () => {
      const socket = net.connect(port, "127.0.0.1");
      expect(await closesWithin(socket, 2000)).toBe(true);
    });

    it("is dropped when it sends only part of a request head", async () => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\n"));
      expect(await closesWithin(socket, 2000)).toBe(true);
    });

    it("is dropped when it completes the TLS handshake and then says nothing", async () => {
      const socket = tls.connect({ host: "127.0.0.1", port, ca: material.caCert!, servername: "localhost" });
      await new Promise<void>((resolve) => socket.on("secureConnect", () => resolve()));
      expect(await closesWithin(socket, 2000)).toBe(true);
    });

    it("is dropped when it stalls inside the TLS handshake", async () => {
      // A TLS record header announcing a handshake that never arrives.
      const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00])));
      expect(await closesWithin(socket, 2000)).toBe(true);
    });

    it("is dropped when it never sends the sign-in body it announced", async () => {
      const socket = tls.connect({ host: "127.0.0.1", port, ca: material.caCert!, servername: "localhost" }, () => {
        socket.write(
          `POST ${LOGIN_PATH} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 50\r\n\r\nkey=`,
        );
      });
      expect(await closesWithin(socket, 2000)).toBe(true);
    });

    it("leaves a request alone once its head has arrived, however long it runs", async () => {
      const chunks: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          { host: "127.0.0.1", port, path: "/stream", headers: bearer(), ca: material.caCert!, servername: "localhost", agent: false },
          (res) => {
            const started = Date.now();
            res.on("data", (c: Buffer) => {
              chunks.push(c.toString());
              // Three times the head deadline, and the stream is still flowing.
              if (Date.now() - started > 450) {
                req.destroy();
                resolve();
              }
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(chunks.length).toBeGreaterThan(5);
    });

    it("gives a kept-alive connection a fresh deadline for each request", async () => {
      const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
      const get = () =>
        new Promise<number>((resolve, reject) => {
          https
            .get({ host: "127.0.0.1", port, path: "/api/x", headers: bearer(), ca: material.caCert!, servername: "localhost", agent }, (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            })
            .on("error", reject);
        });
      try {
        expect(await get()).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await get()).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await get()).toBe(200);
      } finally {
        agent.destroy();
      }
    });
  });

  it("refuses connections beyond its limit instead of holding them", async () => {
    await gateway.close();
    await start({ limits: { maxConnections: 2 } });
    const open = (): Promise<net.Socket> =>
      new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
        socket.on("error", () => {});
      });
    const first = await open();
    const second = await open();
    const third = await open();
    const thirdClosed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      third.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(thirdClosed).toBe(true);
    expect(first.destroyed).toBe(false);
    expect(second.destroyed).toBe(false);
    first.destroy();
    second.destroy();
  });

  it("survives a listener error while running", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // Reach the net.Server through the port it holds: an "error" event on it
    // (EMFILE on accept) must be logged, not thrown.
    const server = (process as unknown as { _getActiveHandles(): unknown[] })
      ._getActiveHandles()
      .find((h): h is net.Server => h instanceof net.Server && (h.address() as AddressInfo | null)?.port === port);
    expect(server).toBeDefined();
    server!.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" }));
    expect(logged).toHaveBeenCalledWith("[secure-gateway] Listener error:", "accept EMFILE");
    expect((await call({ path: "/api/x", headers: bearer() })).status).toBe(200);
    logged.mockRestore();
  });

  it("serves a new certificate to new connections after setTls", async () => {
    const peer = () =>
      new Promise<string>((resolve, reject) => {
        const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
          const fingerprint = socket.getPeerCertificate().fingerprint256;
          socket.destroy();
          resolve(fingerprint);
        });
        socket.on("error", reject);
      });
    expect(await peer()).toBe(material.fingerprint256);

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-gw2-"));
    try {
      const other = ensureSelfSignedTls({ dir: otherDir, names: ["localhost"], label: "other", now: Date.now() });
      gateway.setTls(other, other.caCert);
      expect(await peer()).toBe(other.fingerprint256);
      // The CA download follows the certificate.
      const res = await call({ plain: true, path: CA_PATH });
      expect(new X509Certificate(res.body).fingerprint256).toBe(other.caFingerprint256);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("refuses TLS older than 1.2", async () => {
    await expect(
      new Promise((resolve, reject) => {
        const socket = tls.connect(
          { host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1", maxVersion: "TLSv1.1" },
          () => resolve(socket.getProtocol()),
        );
        socket.on("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("answers 500 when handling a request fails unexpectedly", async () => {
    await gateway.close();
    const broken = {
      retryAfterSeconds() {
        throw new Error("boom");
      },
      recordFailure() {},
    } as unknown as AttemptLimiter;
    await start({ limiter: broken });
    const res = await call({ path: "/api/x", headers: bearer("wrong") });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("boom");
  });

  it("rejects listen() when the port is taken", async () => {
    const second = createSecureGateway({
      tls: material,
      caCert: material.caCert,
      apiKey: KEY,
      upstream: { host: "127.0.0.1", port: upstreamPort },
    });
    await expect(second.listen(port, "127.0.0.1")).rejects.toMatchObject({ code: "EADDRINUSE" });
    await second.close();
  });
});
