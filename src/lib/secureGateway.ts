/**
 * The secure gateway: an HTTPS listener that requires the API key and forwards
 * what it accepts to the app's plain HTTP server.
 *
 * Why a second listener and not a rule inside the app: Next exposes no socket
 * peer address, and every header that could say "this request is local" can be
 * set by the client (GH #767). So the app cannot give this machine open access
 * and the network keyed access on ONE port. Two ports can: the HTTP port stays
 * as it was (bound or published to loopback, no key), and other devices use
 * this one. Because the gateway runs inside the server process (started from
 * src/instrumentation.ts), the desktop app and a container get the same code.
 *
 * What a request needs here:
 * - `Authorization: Bearer <key>` (API clients), or
 * - a session cookie from the sign-in page (browsers; see gatewayAuth.ts).
 * A browser opening a page without either is sent to the sign-in page; anything
 * else gets a 401.
 *
 * The listening socket also answers plain HTTP, by looking at the first byte of
 * each connection, but only to redirect a mistyped `http://` URL to `https://`
 * and to hand out the local CA certificate. Nothing is ever forwarded to the
 * app over plain HTTP.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import {
  decideCors,
  parseAllowedOrigins,
  type AllowedOrigins,
} from "@/lib/corsOrigins";
import {
  AttemptLimiter,
  SESSION_COOKIE,
  bearerToken,
  clearedSessionCookie,
  isPageNavigation,
  mintSession,
  parseCookieHeader,
  safeNextPath,
  secretEquals,
  sessionCookie,
  verifySession,
  withoutSessionCookie,
} from "@/lib/gatewayAuth";
import { loginLocale, renderLoginPage, type LoginError } from "@/lib/gatewayLoginPage";

/** Paths under this prefix belong to the gateway and are never forwarded. */
export const GATEWAY_PREFIX = "/__filamentdb";
export const LOGIN_PATH = `${GATEWAY_PREFIX}/login`;
export const LOGOUT_PATH = `${GATEWAY_PREFIX}/logout`;
export const CA_PATH = `${GATEWAY_PREFIX}/ca.crt`;

/** A sign-in form holds one key and one path; anything larger is not ours. */
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
/**
 * How long a connection may take to deliver a complete request head: from
 * being accepted (TLS handshake included), and again from the end of each
 * response on a kept-alive connection. Node's own `headersTimeout` does not
 * run here, because its connection checking starts in `listen()` and neither
 * HTTP server below ever listens.
 */
const REQUEST_HEAD_TIMEOUT_MS = 20_000;
/** How long the sign-in form's small body may take to arrive. */
const LOGIN_BODY_TIMEOUT_MS = 15_000;
/** Open connections at once. A household's devices use a handful; the cap is
 * what keeps a client that opens sockets and says nothing from using up the
 * process's file descriptors (the app and its database share them). */
const MAX_CONNECTIONS = 1024;
/** First byte of a TLS record carrying a handshake (the ClientHello). */
const TLS_HANDSHAKE = 0x16;

/** Headers that describe one connection and must not cross a proxy (RFC 9110
 * §7.6.1). `transfer-encoding` is dropped only on the way back: Node re-frames
 * the response, while a request body keeps its framing header. */
const REQUEST_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "expect",
];
const RESPONSE_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Headers on every response the gateway writes itself. */
const OWN_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Not `no-referrer`: under it a browser sends `Origin: null` with the
  // sign-in form, which reads as a request from another site.
  "referrer-policy": "same-origin",
};
const LOGIN_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export interface SecureGatewayOptions {
  tls: { cert: string; key: string };
  /** PEM of the generated CA, offered for download; null with an own certificate. */
  caCert: string | null;
  apiKey: string;
  /** The plain HTTP server to forward to. */
  upstream: { host: string; port: number };
  /** Origins whose pages may call the API cross-origin (`ALLOWED_ORIGINS`). */
  allowedOrigins?: AllowedOrigins;
  now?: () => number;
  limiter?: AttemptLimiter;
  /** Overrides of the connection limits below; the defaults are the product's. */
  limits?: { requestHeadMs?: number; loginBodyMs?: number; maxConnections?: number };
}

export interface SecureGateway {
  /** Start listening. Resolves with the bound port. */
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
  /** Swap the key. Sessions minted with the old one stop verifying. */
  setApiKey(key: string): void;
  /** Swap the certificate for new connections. */
  setTls(tls: { cert: string; key: string }, caCert: string | null): void;
}

type Via = "bearer" | "session";
type AuthResult =
  | { ok: true; via: Via }
  /** `limitedFor` > 0: a wrong key from an address that is being refused. */
  | { ok: false; limitedFor: number };

function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string | string[]>,
): void {
  res.writeHead(status, {
    ...OWN_RESPONSE_HEADERS,
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  error: string,
  headers: Record<string, string | string[]> = {},
): void {
  send(res, status, JSON.stringify({ error }), {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
}

function redirect(
  res: ServerResponse,
  status: number,
  location: string,
  headers: Record<string, string | string[]> = {},
): void {
  send(res, status, "", { location, ...headers });
}

/**
 * The request body as text; null once it exceeds `limit` bytes; undefined when
 * it did not arrive within `timeoutMs` or the connection failed (the socket is
 * destroyed then, so there is nobody to answer).
 */
function readBody(
  req: IncomingMessage,
  limit: number,
  timeoutMs: number,
): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(() => {
      req.socket.destroy();
      finish(undefined);
    }, timeoutMs);
    const finish = (value: string | null | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish(null);
      else chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(undefined));
  });
}

/**
 * True when a browser says the request came from another site. A client that
 * sends neither header (not a browser) is not a cross-site request.
 * `Sec-Fetch-Site` decides when present: page script cannot set it, and it
 * stays truthful where `Origin` is withheld. `Origin` is the fallback.
 */
function isCrossSite(req: IncomingMessage): boolean {
  const site = firstHeader(req.headers["sec-fetch-site"]);
  if (site) return site !== "same-origin" && site !== "none";
  const origin = firstHeader(req.headers.origin);
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() !== (req.headers.host ?? "").toLowerCase();
  } catch {
    return true;
  }
}

export function createSecureGateway(options: SecureGatewayOptions): SecureGateway {
  let apiKey = options.apiKey;
  let caCert = options.caCert;
  const now = options.now ?? Date.now;
  const limiter = options.limiter ?? new AttemptLimiter();
  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins("");
  const requestHeadMs = options.limits?.requestHeadMs ?? REQUEST_HEAD_TIMEOUT_MS;
  const loginBodyMs = options.limits?.loginBodyMs ?? LOGIN_BODY_TIMEOUT_MS;
  const sockets = new Set<Socket>();

  function clientOf(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  /**
   * Record a wrong key from `client`. Returns how many seconds further wrong
   * keys from it are refused (429), or 0 when this one is an ordinary 401.
   * The right key never comes here, so it is never refused: see AttemptLimiter.
   */
  function wrongKey(client: string): number {
    const limitedFor = limiter.retryAfterSeconds(client, now());
    if (limitedFor === 0) limiter.recordFailure(client, now());
    return limitedFor;
  }

  function authenticate(req: IncomingMessage): AuthResult {
    const token = bearerToken(firstHeader(req.headers.authorization));
    if (token !== null) {
      if (secretEquals(token, apiKey)) return { ok: true, via: "bearer" };
      return { ok: false, limitedFor: wrongKey(clientOf(req)) };
    }
    const session = parseCookieHeader(firstHeader(req.headers.cookie))[SESSION_COOKIE];
    if (session && verifySession(apiKey, session, now())) {
      return { ok: true, via: "session" };
    }
    return { ok: false, limitedFor: 0 };
  }

  function serveCa(req: IncomingMessage, res: ServerResponse): void {
    if (!caCert) {
      sendJson(res, 404, "This server uses its own certificate; there is no local CA to download.");
      return;
    }
    send(res, 200, req.method === "HEAD" ? "" : caCert, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": 'attachment; filename="filament-db-ca.crt"',
      "content-length": String(Buffer.byteLength(caCert)),
    });
  }

  function loginPage(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    next: string,
    error: LoginError,
    retryAfterSeconds = 0,
  ): void {
    const html = renderLoginPage({
      locale: loginLocale(firstHeader(req.headers["accept-language"])),
      action: LOGIN_PATH,
      next,
      error,
      retryAfterSeconds,
    });
    send(res, status, req.method === "HEAD" ? "" : html, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": LOGIN_PAGE_CSP,
      "content-length": String(Buffer.byteLength(html)),
      ...(retryAfterSeconds > 0 ? { "retry-after": String(retryAfterSeconds) } : {}),
    });
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET" || method === "HEAD") {
      const requested = new URL(req.url ?? "/", "https://gateway.invalid").searchParams.get("next");
      const next = safeNextPath(requested, GATEWAY_PREFIX);
      if (authenticate(req).ok) redirect(res, 303, next);
      else loginPage(req, res, 200, next, null);
      return;
    }
    if (method !== "POST") {
      sendJson(res, 405, "Method not allowed.", { allow: "GET, HEAD, POST" });
      return;
    }
    const type = (firstHeader(req.headers["content-type"]) ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") {
      sendJson(res, 415, "The sign-in form must be sent as application/x-www-form-urlencoded.");
      return;
    }
    // Another site's page must not be able to submit keys from this browser:
    // its wrong guesses would be counted against the user's own address.
    if (isCrossSite(req)) {
      sendJson(res, 403, "Cross-origin request was rejected.");
      return;
    }
    const body = await readBody(req, MAX_LOGIN_BODY_BYTES, loginBodyMs);
    if (body === undefined) return;
    if (body === null) {
      sendJson(res, 413, "The sign-in request is too large.", { connection: "close" });
      return;
    }
    const form = new URLSearchParams(body);
    const next = safeNextPath(form.get("next"), GATEWAY_PREFIX);
    if (secretEquals(form.get("key") ?? "", apiKey)) {
      redirect(res, 303, next, { "set-cookie": sessionCookie(mintSession(apiKey, now())) });
      return;
    }
    const limitedFor = wrongKey(clientOf(req));
    if (limitedFor > 0) loginPage(req, res, 429, next, "limited", limitedFor);
    else loginPage(req, res, 401, next, "invalid");
  }

  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") {
      sendJson(res, 405, "Method not allowed.", { allow: "POST" });
      return;
    }
    if (isCrossSite(req)) {
      sendJson(res, 403, "Cross-origin request was rejected.");
      return;
    }
    redirect(res, 303, LOGIN_PATH, { "set-cookie": clearedSessionCookie() });
  }

  function forward(req: IncomingMessage, res: ServerResponse, via: Via): void {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    for (const name of REQUEST_HOP_HEADERS) delete headers[name];
    // The credential stops here: the app has no use for it.
    if (via === "bearer") delete headers.authorization;
    const cookie = withoutSessionCookie(firstHeader(req.headers.cookie));
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    // `host` is forwarded untouched: the app's CSRF guard compares it with
    // `Origin` (src/lib/requestGuard.ts). The gateway is the edge, so any
    // forwarding headers the client sent are replaced, not extended.
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-for"] = clientOf(req);
    if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
    else delete headers["x-forwarded-host"];

    let finished = false;
    const upstream = http.request(
      {
        host: options.upstream.host,
        port: options.upstream.port,
        method: req.method,
        path: req.url,
        headers,
        // One connection per request: nothing pooled to tear down by mistake
        // when a client goes away mid-stream.
        agent: false,
      },
      (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers };
        for (const name of RESPONSE_HOP_HEADERS) delete responseHeaders[name];
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        // Server-sent events (/api/scan/stream) must reach the client as they
        // are produced, starting with the headers.
        res.flushHeaders();
        upstreamRes.on("end", () => {
          finished = true;
        });
        upstreamRes.on("error", () => res.destroy());
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      finished = true;
      if (res.headersSent) res.destroy();
      else sendJson(res, 502, "The Filament DB server did not answer. It may still be starting.");
    });
    // The client left (closed tab, cancelled stream): stop the app's work too.
    res.on("close", () => {
      if (!finished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  async function handleSecure(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const path = pathOf(url);
    const method = (req.method ?? "GET").toUpperCase();

    if (path === CA_PATH && (method === "GET" || method === "HEAD")) return serveCa(req, res);
    if (path === LOGIN_PATH) return handleLogin(req, res);
    if (path === LOGOUT_PATH) return handleLogout(req, res);
    if (path === GATEWAY_PREFIX || path.startsWith(`${GATEWAY_PREFIX}/`)) {
      return sendJson(res, 404, "Not found.");
    }

    // A preflight carries no credential by design; answer it for a listed
    // origin exactly as src/proxy.ts does, and attach the same headers to our
    // own refusals so a listed origin's page can read the status.
    const cors = decideCors(allowedOrigins, {
      method,
      origin: firstHeader(req.headers.origin) ?? null,
      requestMethod: firstHeader(req.headers["access-control-request-method"]) ?? null,
      requestPrivateNetwork:
        firstHeader(req.headers["access-control-request-private-network"]) ?? null,
    });
    if (cors.preflight) {
      res.writeHead(204, { ...OWN_RESPONSE_HEADERS, ...cors.headers });
      res.end();
      return;
    }

    const auth = authenticate(req);
    if (auth.ok) return forward(req, res, auth.via);

    if (auth.limitedFor > 0) {
      return sendJson(res, 429, "Too many attempts with a wrong API key. Try again later.", {
        "retry-after": String(auth.limitedFor),
        ...cors.headers,
      });
    }
    if (
      isPageNavigation({
        method,
        path,
        accept: firstHeader(req.headers.accept),
        secFetchMode: firstHeader(req.headers["sec-fetch-mode"]),
      })
    ) {
      return redirect(res, 302, `${LOGIN_PATH}?next=${encodeURIComponent(url)}`);
    }
    sendJson(
      res,
      401,
      "Unauthorized — this Filament DB address requires an API key. Send 'Authorization: Bearer <key>'.",
      { "www-authenticate": 'Bearer realm="filament-db"', ...cors.headers },
    );
  }

  /** Plain HTTP on the TLS port: a redirect, the CA certificate, or a refusal. */
  function handlePlain(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    const path = pathOf(url);
    const method = (req.method ?? "GET").toUpperCase();
    const readOnly = method === "GET" || method === "HEAD";
    const close = { connection: "close" };

    if (readOnly && path === CA_PATH && caCert) {
      // A certificate is public, and a phone needs it BEFORE it can trust the
      // HTTPS address. The fingerprint in Settings is the integrity check.
      res.setHeader("connection", "close");
      return serveCa(req, res);
    }
    const host = req.headers.host ?? "";
    const isApi = path === "/api" || path.startsWith("/api/");
    if (readOnly && !isApi && /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(host)) {
      return redirect(res, 308, `https://${host}${url}`, close);
    }
    sendJson(res, 400, "This port only accepts HTTPS. Use an https:// address.", close);
  }

  // ── Request-head deadlines ──────────────────────────────────────────────
  // Keyed by the peer's address and port, which a TLS socket reports the same
  // as the raw socket under it: the request handlers only ever see the former.
  const peerKey = (socket: { remoteAddress?: string; remotePort?: number }) =>
    `${socket.remoteAddress}|${socket.remotePort}`;
  const awaitingHead = new Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout> }>();

  /** Give `socket` the request-head time to deliver its next request head. */
  function expectRequestHead(key: string, socket: Socket): void {
    clearTimeout(awaitingHead.get(key)?.timer);
    const timer = setTimeout(() => socket.destroy(), requestHeadMs);
    awaitingHead.set(key, { socket, timer });
  }

  /** A request head arrived: stop the clock until its response has ended. */
  function requestHeadArrived(req: IncomingMessage, res: ServerResponse): void {
    const key = peerKey(req.socket);
    const entry = awaitingHead.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    res.on("close", () => {
      if (!entry.socket.destroyed && awaitingHead.get(key) === entry) {
        expectRequestHead(key, entry.socket);
      }
    });
  }

  const secureServer = https.createServer(
    { cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" },
    (req, res) => {
      requestHeadArrived(req, res);
      handleSecure(req, res).catch(() => {
        if (res.headersSent) res.destroy();
        else sendJson(res, 500, "The gateway could not handle the request.");
      });
    },
  );
  const plainServer = http.createServer((req, res) => {
    requestHeadArrived(req, res);
    handlePlain(req, res);
  });

  // One listening socket for both. Neither server listens itself; each
  // connection is handed to the one its first byte belongs to. The peeked
  // byte is pushed back, and TLSSocket replays a socket's buffered data.
  const front = net.createServer((socket) => {
    const key = peerKey(socket);
    sockets.add(socket);
    expectRequestHead(key, socket);
    socket.on("close", () => {
      sockets.delete(socket);
      const entry = awaitingHead.get(key);
      if (entry?.socket === socket) {
        clearTimeout(entry.timer);
        awaitingHead.delete(key);
      }
    });
    // A reset before either server owns the socket must not crash the process.
    socket.on("error", () => {});
    const onReadable = () => {
      const first = socket.read(1) as Buffer | null;
      if (first === null) return; // nothing yet, or the client hung up
      socket.removeListener("readable", onReadable);
      socket.unshift(first);
      (first[0] === TLS_HANDSHAKE ? secureServer : plainServer).emit("connection", socket);
    };
    socket.on("readable", onReadable);
  });

  front.maxConnections = options.limits?.maxConnections ?? MAX_CONNECTIONS;
  // A listener that fails while running (out of file descriptors on accept)
  // emits "error"; unheard, that would take the whole server process down.
  let rejectListen: ((err: Error) => void) | null = null;
  front.on("error", (err) => {
    if (rejectListen) rejectListen(err);
    else console.error("[secure-gateway] Listener error:", err.message);
  });

  return {
    listen(port, host) {
      return new Promise((resolve, reject) => {
        rejectListen = reject;
        front.listen(port, host, () => {
          rejectListen = null;
          resolve((front.address() as net.AddressInfo).port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        front.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
    setApiKey(key) {
      apiKey = key;
    },
    setTls(tls, nextCaCert) {
      secureServer.setSecureContext({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" });
      caCert = nextCaCert;
    },
  };
}
