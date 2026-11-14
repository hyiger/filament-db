import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as getStatus } from "@/app/api/security/route";
import { GET as getCa } from "@/app/api/security/ca/route";
import { POST as revealKey } from "@/app/api/security/key/reveal/route";
import { POST as rollKey } from "@/app/api/security/key/roll/route";
import { httpPortApiKey } from "@/lib/apiAuth";
import { secureGatewayRunning } from "@/lib/gatewayConfig";
import { API_KEY_FILE } from "@/lib/gatewayKey";
import { assertOwnHost } from "@/lib/gatewayRouteGuard";
import {
  ApiKeyNotRollableError,
  getSecureGatewayCaCert,
  getSecureGatewayStatus,
  isOwnHost,
  listenErrorMessage,
  maintainSecureGatewayTls,
  revealSecureGatewayKey,
  rollSecureGatewayKey,
  startSecureGateway,
  stopSecureGateway,
} from "@/lib/gatewayRuntime";
import * as runtime from "@/lib/gatewayRuntime";
import { createCertificateAuthority, createServerCertificate } from "@/lib/x509";

/**
 * The process-wide secure gateway (started from src/instrumentation.ts) and
 * the /api/security routes that report on it and manage its key.
 */

const ENV_KEY = "key-from-the-environment-0123456789abcdef";

let dir: string;
let log: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-rt-"));
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await stopSecureGateway();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A port nothing is listening on. Taken from below the range the OS hands out
 * for `listen(0)` (the other test files' databases use that), and probed, so
 * two parallel suites cannot be given the same one a moment apart.
 */
let nextCandidate = 21000 + (Number(process.env.VITEST_POOL_ID ?? 0) % 40) * 100;
async function freePort(): Promise<number> {
  for (;;) {
    const candidate = nextCandidate++;
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
}

async function env(over: Record<string, string | undefined> = {}) {
  return {
    FILAMENTDB_HTTPS_PORT: String(await freePort()),
    FILAMENTDB_HTTPS_HOST: "127.0.0.1",
    FILAMENTDB_SECURE_DIR: dir,
    PORT: "1",
    ...over,
  };
}

/** Status of a GET through the running gateway, trusting its generated CA. */
function httpsStatus(port: number, key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          host: "127.0.0.1",
          port,
          path: "/api/x",
          servername: "localhost",
          ca: getSecureGatewayCaCert() ?? undefined,
          rejectUnauthorized: getSecureGatewayCaCert() !== null,
          headers: { authorization: `Bearer ${key}` },
          agent: false,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      )
      .on("error", reject);
  });
}

const post = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: "POST", headers: { host: new URL(url).host, ...headers } });

describe("startSecureGateway", () => {
  it("does nothing without FILAMENTDB_HTTPS_PORT", async () => {
    const status = await startSecureGateway({ FILAMENTDB_SECURE_DIR: dir });
    expect(status).toEqual({
      configured: false,
      running: false,
      error: null,
      port: null,
      urls: [],
      key: null,
      tls: null,
    });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(revealSecureGatewayKey()).toBeNull();
    expect(getSecureGatewayCaCert()).toBeNull();
  });

  it("reports an invalid configuration instead of starting", async () => {
    const status = await startSecureGateway({ FILAMENTDB_HTTPS_PORT: "https", FILAMENTDB_SECURE_DIR: dir });
    expect(status).toMatchObject({ configured: true, running: false, port: null, key: null });
    expect(status.error).toMatch(/FILAMENTDB_HTTPS_PORT must be a port number/);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Not started"));
  });

  it("starts with a generated key and certificate", async () => {
    const config = await env({ FILAMENTDB_TLS_HOSTS: "nas.lan,2001:db8::5" });
    const status = await startSecureGateway(config);
    const port = Number(config.FILAMENTDB_HTTPS_PORT);
    expect(status).toMatchObject({
      configured: true,
      running: true,
      error: null,
      port,
      key: { source: "file", rollable: true },
      tls: { mode: "self-signed" },
    });
    expect(status.tls?.caFingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(status.tls?.names).toEqual(expect.arrayContaining(["nas.lan", "localhost", "127.0.0.1"]));
    // Addresses for other devices: the extra hosts first, never loopback, IPv6 bracketed.
    expect(status.urls.slice(0, 2)).toEqual([`https://nas.lan:${port}`, `https://[2001:db8:0:0:0:0:0:5]:${port}`]);
    expect(status.urls.join(" ")).not.toMatch(/localhost|127\.0\.0\.1|\[0:0:0:0:0:0:0:1\]/);

    const key = revealSecureGatewayKey()!;
    expect(fs.readFileSync(path.join(dir, API_KEY_FILE), "utf8").trim()).toBe(key);
    // The app behind it is not running (PORT=1): authenticated → 502, not → 401.
    expect(await httpsStatus(port, key)).toBe(502);
    expect(await httpsStatus(port, "wrong")).toBe(401);
  });

  it("never writes the key to the log", async () => {
    await startSecureGateway(await env());
    const key = revealSecureGatewayKey()!;
    rollSecureGatewayKey();
    const logged = [...log.mock.calls, ...errorLog.mock.calls].flat().join("\n");
    expect(logged).toContain("Generated a new API key");
    expect(logged).not.toContain(key);
    expect(logged).not.toContain(revealSecureGatewayKey()!);
  });

  it("keeps the same key and CA across restarts", async () => {
    const config = await env();
    await startSecureGateway(config);
    const key = revealSecureGatewayKey();
    const ca = getSecureGatewayStatus().tls?.caFingerprint256;
    await stopSecureGateway();
    log.mockClear();

    await startSecureGateway(config);
    expect(revealSecureGatewayKey()).toBe(key);
    expect(getSecureGatewayStatus().tls?.caFingerprint256).toBe(ca);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Generated a new API key");
  });

  it("starts once: a second call returns the first outcome", async () => {
    const first = await startSecureGateway(await env());
    const second = await startSecureGateway(await env({ FILAMENTDB_API_KEY: "ignored-second-call" }));
    expect(second).toEqual(first);
    expect(getSecureGatewayStatus().key?.source).toBe("file");
  });

  it("uses a key from the environment, which cannot be rolled", async () => {
    const config = await env({ FILAMENTDB_API_KEY: "key-from-the-environment-0123456789abcdef" });
    const status = await startSecureGateway(config);
    expect(status.key).toEqual({ source: "env", rollable: false });
    expect(revealSecureGatewayKey()).toBe("key-from-the-environment-0123456789abcdef");
    expect(fs.existsSync(path.join(dir, API_KEY_FILE))).toBe(false);
    expect(await httpsStatus(Number(config.FILAMENTDB_HTTPS_PORT), "key-from-the-environment-0123456789abcdef")).toBe(502);
    expect(() => rollSecureGatewayKey()).toThrow(ApiKeyNotRollableError);
    expect(() => rollSecureGatewayKey()).toThrow(/FILAMENTDB_API_KEY/);
  });

  it("reports a port that is already taken, and stays off", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const taken = (blocker.address() as AddressInfo).port;
    try {
      const status = await startSecureGateway(await env({ FILAMENTDB_HTTPS_PORT: String(taken) }));
      expect(status).toMatchObject({ configured: true, running: false, urls: [] });
      expect(status.error).toBe(`Port ${taken} is already in use by another program.`);
      expect(revealSecureGatewayKey()).toBeNull();
      expect(() => rollSecureGatewayKey()).toThrow(/not running/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("refuses an environment key that is short enough to guess", async () => {
    // The gateway never locks a client out, so the key's length is the defence.
    const status = await startSecureGateway(await env({ FILAMENTDB_API_KEY: "hunter2-is-not-a-key" }));
    expect(status.running).toBe(false);
    expect(status.error).toMatch(/FILAMENTDB_API_KEY must be 32 to 512 printable characters/);
    expect(status.error).not.toContain("hunter2");
  });

  it("keeps FILAMENTDB_API_KEY gating the HTTP port when the gateway could not start", async () => {
    // An existing keyed deployment adds the gateway with a wrong certificate
    // path. No gateway comes up, so the HTTP port must stay keyed.
    const broken = await env({
      FILAMENTDB_API_KEY: ENV_KEY,
      FILAMENTDB_TLS_CERT: path.join(dir, "nope.pem"),
      FILAMENTDB_TLS_KEY: path.join(dir, "nope.key"),
    });
    expect((await startSecureGateway(broken)).running).toBe(false);
    expect(httpPortApiKey(broken)).toBe(ENV_KEY);
    expect(secureGatewayRunning()).toBe(false);

    await stopSecureGateway();
    const working = await env({ FILAMENTDB_API_KEY: ENV_KEY });
    expect((await startSecureGateway(working)).running).toBe(true);
    expect(secureGatewayRunning()).toBe(true);
    expect(httpPortApiKey(working)).toBeUndefined();

    await stopSecureGateway();
    expect(httpPortApiKey(working)).toBe(ENV_KEY);
  });

  it("reports an unusable own certificate", async () => {
    const status = await startSecureGateway(
      await env({ FILAMENTDB_TLS_CERT: path.join(dir, "nope.pem"), FILAMENTDB_TLS_KEY: path.join(dir, "nope.key") }),
    );
    expect(status.running).toBe(false);
    expect(status.error).toBe("Could not read the TLS certificate or key file (ENOENT).");
  });
});

describe("own certificate", () => {
  function writeOwnCertificate(names: string[]) {
    const now = Date.now();
    const ca = createCertificateAuthority({
      commonName: "Home CA",
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(now + 365 * 86_400_000),
    });
    const server = createServerCertificate({
      caCert: ca.cert,
      caKey: ca.key,
      commonName: names[0],
      names,
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(now + 90 * 86_400_000),
    });
    fs.writeFileSync(path.join(dir, "own.pem"), server.cert);
    fs.writeFileSync(path.join(dir, "own.key"), server.key);
  }
  const ownEnv = () =>
    env({ FILAMENTDB_TLS_CERT: path.join(dir, "own.pem"), FILAMENTDB_TLS_KEY: path.join(dir, "own.key") });

  it("serves it, generates no CA, and lists its names", async () => {
    writeOwnCertificate(["filament.example.net", "*.home.example.net", "localhost"]);
    const config = await ownEnv();
    const status = await startSecureGateway(config);
    expect(status.tls).toMatchObject({ mode: "custom", caFingerprint256: null });
    // A wildcard is not an address; loopback is not for other devices.
    expect(status.urls).toEqual([`https://filament.example.net:${config.FILAMENTDB_HTTPS_PORT}`]);
    expect(getSecureGatewayCaCert()).toBeNull();
    expect(fs.existsSync(path.join(dir, "ca.crt"))).toBe(false);
    // The key is still generated and stored.
    expect(getSecureGatewayStatus().key).toEqual({ source: "file", rollable: true });
  });

  it("picks up a renewed certificate file without a restart", async () => {
    writeOwnCertificate(["filament.example.net"]);
    await startSecureGateway(await ownEnv());
    const before = getSecureGatewayStatus().tls!.fingerprint256;

    maintainSecureGatewayTls();
    expect(getSecureGatewayStatus().tls!.fingerprint256).toBe(before);

    writeOwnCertificate(["filament.example.net", "second.example.net"]);
    maintainSecureGatewayTls();
    const after = getSecureGatewayStatus().tls!;
    expect(after.fingerprint256).not.toBe(before);
    expect(after.names).toContain("second.example.net");
  });

  it("keeps serving the current certificate when the files become unreadable", async () => {
    writeOwnCertificate(["filament.example.net"]);
    await startSecureGateway(await ownEnv());
    const before = getSecureGatewayStatus();
    fs.rmSync(path.join(dir, "own.pem"));
    maintainSecureGatewayTls();
    expect(getSecureGatewayStatus()).toEqual(before);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("Could not refresh the certificate"),
      expect.anything(),
    );
  });
});

describe("maintainSecureGatewayTls", () => {
  it("is a no-op when no gateway is running", () => {
    expect(() => maintainSecureGatewayTls()).not.toThrow();
  });

  it("leaves a still-good generated certificate alone", async () => {
    await startSecureGateway(await env());
    const before = getSecureGatewayStatus().tls;
    maintainSecureGatewayTls();
    expect(getSecureGatewayStatus().tls).toEqual(before);
  });
});

describe("rollSecureGatewayKey", () => {
  it("replaces the key immediately, on disk and in the running gateway", async () => {
    const config = await env();
    await startSecureGateway(config);
    const port = Number(config.FILAMENTDB_HTTPS_PORT);
    const old = revealSecureGatewayKey()!;

    const next = rollSecureGatewayKey();
    expect(next).not.toBe(old);
    expect(revealSecureGatewayKey()).toBe(next);
    expect(fs.readFileSync(path.join(dir, API_KEY_FILE), "utf8").trim()).toBe(next);
    expect(await httpsStatus(port, old)).toBe(401);
    expect(await httpsStatus(port, next)).toBe(502);
    expect(getSecureGatewayStatus().key).toEqual({ source: "file", rollable: true });
  });

  it("refuses when the gateway is off", () => {
    expect(() => rollSecureGatewayKey()).toThrow(
      expect.objectContaining({ name: "ApiKeyNotRollableError", reason: "gateway_off" }),
    );
  });
});

describe("isOwnHost", () => {
  it("accepts loopback names whether or not a gateway runs", () => {
    for (const host of ["localhost", "localhost:3456", "LOCALHOST:3456", "127.0.0.1:3456", "[::1]:3456", "[::1]"]) {
      expect(isOwnHost(host)).toBe(true);
    }
  });

  it("rejects everything else while no gateway runs", () => {
    for (const host of [null, undefined, "", "  ", "evil.example", "192.168.1.20:3456"]) {
      expect(isOwnHost(host)).toBe(false);
    }
  });

  it("accepts the names the gateway's certificate carries, and no others", async () => {
    await startSecureGateway(await env({ FILAMENTDB_TLS_HOSTS: "nas.lan,10.9.8.7,2001:db8::5" }));
    expect(isOwnHost("nas.lan:3457")).toBe(true);
    expect(isOwnHost("NAS.LAN")).toBe(true);
    expect(isOwnHost("10.9.8.7:3457")).toBe(true);
    expect(isOwnHost("[2001:db8::5]:3457")).toBe(true);
    // A rebinding page's own name, and an address the certificate does not carry.
    expect(isOwnHost("evil.example:3456")).toBe(false);
    expect(isOwnHost("10.9.8.8:3457")).toBe(false);
    expect(isOwnHost("nas.lan.evil.example")).toBe(false);
  });
});

describe("listenErrorMessage", () => {
  it("names the cause for the common failures", () => {
    expect(listenErrorMessage(Object.assign(new Error("x"), { code: "EADDRINUSE" }), 3457)).toBe(
      "Port 3457 is already in use by another program.",
    );
    expect(listenErrorMessage(Object.assign(new Error("x"), { code: "EACCES" }), 443)).toBe(
      "This process is not allowed to listen on port 443.",
    );
    expect(listenErrorMessage(new Error("something else"), 3457)).toBe("something else");
    expect(listenErrorMessage("a string", 3457)).toBe("a string");
    expect(listenErrorMessage(null, 3457)).toBe("null");
  });
});

describe("shutdown signals", () => {
  const count = () => process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");

  it("closes the gateway on SIGTERM so the port is free before the process exits", async () => {
    // A stream keeps Next's own shutdown waiting; without this the old process
    // would go on serving the LAN after sharing was turned off.
    // Take the runner's own handlers out of the way for the duration, and put
    // one stand-in back: Next's own handler, which is what keeps the process
    // alive after the signal.
    const before = process.listeners("SIGTERM");
    for (const listener of before) process.removeListener("SIGTERM", listener);
    const other = () => {};
    process.on("SIGTERM", other);
    try {
      const config = await env();
      await startSecureGateway(config);
      const port = Number(config.FILAMENTDB_HTTPS_PORT);
      process.emit("SIGTERM");
      await vi.waitFor(async () => {
        const probe = net.createServer();
        await new Promise<void>((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
        });
      });
    } finally {
      process.removeListener("SIGTERM", other);
      for (const listener of before) process.on("SIGTERM", listener);
    }
  });

  it("re-raises the signal when nothing else handles it, so the process still stops", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const before = process.listeners("SIGINT");
    for (const listener of before) process.removeListener("SIGINT", listener);
    try {
      await startSecureGateway(await env());
      process.emit("SIGINT");
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT"));
    } finally {
      for (const listener of before) process.on("SIGINT", listener);
    }
  });

  it("removes its listeners when the gateway stops, and adds none when it never started", async () => {
    const before = count();
    await startSecureGateway(await env());
    expect(count()).toBe(before + 2);
    await stopSecureGateway();
    expect(count()).toBe(before);

    await startSecureGateway({ FILAMENTDB_HTTPS_PORT: "nope", FILAMENTDB_SECURE_DIR: dir });
    expect(count()).toBe(before);
  });
});

describe("stopSecureGateway", () => {
  it("frees the port and forgets the state", async () => {
    const config = await env();
    await startSecureGateway(config);
    await stopSecureGateway();
    expect(getSecureGatewayStatus()).toMatchObject({ configured: false, running: false, key: null });
    // The port can be bound again.
    const again = net.createServer();
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject);
      again.listen(Number(config.FILAMENTDB_HTTPS_PORT), "127.0.0.1", resolve);
    });
    await new Promise((resolve) => again.close(resolve));
  });

  it("is safe when nothing was started", async () => {
    await expect(stopSecureGateway()).resolves.toBeUndefined();
  });
});

describe("GET /api/security", () => {
  it("reports an idle server", async () => {
    const res = await getStatus();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      configured: false,
      running: false,
      error: null,
      port: null,
      urls: [],
      key: null,
      tls: null,
      httpKeyRequired: false,
    });
  });

  it("reports the running gateway, without the key", async () => {
    await startSecureGateway(await env());
    const body = await (await getStatus()).json();
    expect(body).toMatchObject({ configured: true, running: true, key: { source: "file", rollable: true } });
    expect(JSON.stringify(body)).not.toContain(revealSecureGatewayKey()!);
  });

  it("flags a key on the HTTP port: no gateway, or one that is not running", async () => {
    vi.stubEnv("FILAMENTDB_API_KEY", ENV_KEY);
    expect((await (await getStatus()).json()).httpKeyRequired).toBe(true);
    // Configured is not enough: nothing is listening.
    vi.stubEnv("FILAMENTDB_HTTPS_PORT", "3443");
    expect((await (await getStatus()).json()).httpKeyRequired).toBe(true);
    await startSecureGateway(await env({ FILAMENTDB_API_KEY: ENV_KEY }));
    expect((await (await getStatus()).json()).httpKeyRequired).toBe(false);
  });

  it("catches up with a renewed certificate when the status is read", async () => {
    const maintain = vi.spyOn(runtime, "maintainSecureGatewayTls");
    await getStatus();
    expect(maintain).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/security/ca", () => {
  it("is 404 without a generated CA", async () => {
    expect((await getCa()).status).toBe(404);
  });

  it("downloads the CA certificate", async () => {
    await startSecureGateway(await env());
    const res = await getCa();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-x509-ca-cert");
    expect(res.headers.get("content-disposition")).toContain("filament-db-ca.crt");
    expect(await res.text()).toBe(getSecureGatewayCaCert());
  });
});

describe("POST /api/security/key/reveal", () => {
  it("returns the key to this computer", async () => {
    await startSecureGateway(await env());
    const res = await revealKey(post("http://localhost:3456/api/security/key/reveal"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ key: revealSecureGatewayKey(), source: "file", rollable: true });
  });

  it("is 409 while the gateway is off", async () => {
    const res = await revealKey(post("http://localhost:3456/api/security/key/reveal"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("gateway_off");
  });

  it("refuses a cross-site browser request", async () => {
    await startSecureGateway(await env());
    const res = await revealKey(
      post("http://localhost:3456/api/security/key/reveal", { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(revealSecureGatewayKey()!);
  });

  it("refuses a DNS-rebinding page, which is same-origin with itself", async () => {
    await startSecureGateway(await env());
    const res = await revealKey(
      post("http://evil.example:3456/api/security/key/reveal", {
        origin: "http://evil.example:3456",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("foreign_host");
    expect(JSON.stringify(body)).not.toContain(revealSecureGatewayKey()!);
  });

  it("serves a request that came through the gateway's own address", async () => {
    await startSecureGateway(await env({ FILAMENTDB_TLS_HOSTS: "nas.lan" }));
    const res = await revealKey(
      post("https://nas.lan:3457/api/security/key/reveal", {
        origin: "https://nas.lan:3457",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/security/key/roll", () => {
  it("rolls the key and returns the new one", async () => {
    await startSecureGateway(await env());
    const old = revealSecureGatewayKey();
    const res = await rollKey(post("http://localhost:3456/api/security/key/roll"));
    expect(res.status).toBe(200);
    const { key } = await res.json();
    expect(key).not.toBe(old);
    expect(key).toBe(revealSecureGatewayKey());
  });

  it("is 409 while the gateway is off, and for an environment key", async () => {
    const off = await rollKey(post("http://localhost:3456/api/security/key/roll"));
    expect(off.status).toBe(409);
    expect((await off.json()).code).toBe("gateway_off");

    await stopSecureGateway();
    await startSecureGateway(await env({ FILAMENTDB_API_KEY: "key-from-the-environment-0123456789abcdef" }));
    const fixed = await rollKey(post("http://localhost:3456/api/security/key/roll"));
    expect(fixed.status).toBe(409);
    expect((await fixed.json()).code).toBe("env_key");
    expect(revealSecureGatewayKey()).toBe("key-from-the-environment-0123456789abcdef");
  });

  it("refuses cross-site and foreign-host requests, leaving the key alone", async () => {
    await startSecureGateway(await env());
    const key = revealSecureGatewayKey();
    const cross = await rollKey(
      post("http://localhost:3456/api/security/key/roll", { origin: "https://evil.example" }),
    );
    expect(cross.status).toBe(403);
    const rebind = await rollKey(post("http://evil.example:3456/api/security/key/roll"));
    expect(rebind.status).toBe(403);
    expect(revealSecureGatewayKey()).toBe(key);
  });

  it("lets an unexpected failure surface as an error, not a 409", async () => {
    await startSecureGateway(await env());
    vi.spyOn(runtime, "rollSecureGatewayKey").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(rollKey(post("http://localhost:3456/api/security/key/roll"))).rejects.toThrow("disk full");
  });
});

describe("assertOwnHost", () => {
  it("passes this server's own names and refuses others", () => {
    expect(assertOwnHost(post("http://localhost:3456/x"))).toBeNull();
    expect(assertOwnHost(post("http://evil.example/x"))?.status).toBe(403);
  });
});
