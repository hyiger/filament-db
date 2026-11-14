/**
 * The running secure gateway of this server process: started once from
 * src/instrumentation.ts, read and steered by the `/api/security` routes.
 *
 * State lives on `globalThis` (like src/lib/scanBus.ts) because the
 * instrumentation hook and the route handlers are bundled separately and each
 * gets its own copy of this module; one process still has one gateway.
 */

import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";
import { allowedOriginsFromEnv } from "@/lib/corsOrigins";
import {
  desiredCertificateNames,
  ensureSelfSignedTls,
  loadCustomTls,
  type GatewayTls,
} from "@/lib/gatewayCerts";
import { GATEWAY_GLOBAL_KEY, parseGatewayEnv, type GatewayConfig } from "@/lib/gatewayConfig";
import {
  MIN_API_KEY_LENGTH,
  isUsableApiKey,
  loadOrCreateApiKey,
  rollStoredApiKey,
  type ApiKeySource,
  type ApiKeyState,
} from "@/lib/gatewayKey";
import type { NetworkAddress } from "@/lib/getLanIp";
import { isLoopbackHostname } from "@/lib/loopbackHost";
import { createSecureGateway, type SecureGateway } from "@/lib/secureGateway";

/** How often the certificate is re-checked: expiry, a changed LAN address, or
 * a renewed own-certificate file. */
export const TLS_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

export interface SecureGatewayStatus {
  /** `FILAMENTDB_HTTPS_PORT` is set. */
  configured: boolean;
  running: boolean;
  /** Why a configured gateway is not running. */
  error: string | null;
  port: number | null;
  /** `https://` addresses other devices can use, most specific first. */
  urls: string[];
  key: { source: ApiKeySource; rollable: boolean } | null;
  tls: {
    mode: GatewayTls["mode"];
    fingerprint256: string;
    caFingerprint256: string | null;
    notAfter: string;
    names: string[];
  } | null;
}

interface RuntimeState {
  configured: boolean;
  config: GatewayConfig | null;
  gateway: SecureGateway | null;
  port: number | null;
  key: ApiKeyState | null;
  tls: GatewayTls | null;
  error: string | null;
  timer: ReturnType<typeof setInterval> | null;
  starting: Promise<SecureGatewayStatus> | null;
  /** Removes the shutdown-signal listeners. */
  removeSignalHandlers: (() => void) | null;
}

const GLOBAL_KEY = GATEWAY_GLOBAL_KEY;
type GlobalWithGateway = typeof globalThis & { [GLOBAL_KEY]?: RuntimeState };

function getState(): RuntimeState {
  const g = globalThis as GlobalWithGateway;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      configured: false,
      config: null,
      gateway: null,
      port: null,
      key: null,
      tls: null,
      error: null,
      timer: null,
      starting: null,
      removeSignalHandlers: null,
    };
  }
  return g[GLOBAL_KEY];
}

function loadTls(config: GatewayConfig): GatewayTls {
  if (config.tlsCertFile && config.tlsKeyFile) {
    return loadCustomTls(config.tlsCertFile, config.tlsKeyFile);
  }
  const hostname = os.hostname();
  return ensureSelfSignedTls({
    dir: config.secureDir,
    names: desiredCertificateNames({
      hostname,
      interfaces: os.networkInterfaces() as Record<string, NetworkAddress[] | undefined>,
      extraHosts: config.extraHosts,
    }),
    label: hostname.replace(/\.local\.?$/i, ""),
    now: Date.now(),
  });
}

export function listenErrorMessage(err: unknown, port: number): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EADDRINUSE") return `Port ${port} is already in use by another program.`;
  if (code === "EACCES") return `This process is not allowed to listen on port ${port}.`;
  return err instanceof Error ? err.message : String(err);
}

/** Addresses another device can use, from the names the certificate carries. */
function gatewayUrls(names: readonly string[], port: number): string[] {
  return names
    .filter((name) => !name.includes("*") && !isLoopbackHostname(name))
    .map((name) => `https://${name.includes(":") ? `[${name.toLowerCase()}]` : name}:${port}`);
}

export function getSecureGatewayStatus(): SecureGatewayStatus {
  const state = getState();
  const running = state.gateway !== null;
  return {
    configured: state.configured,
    running,
    error: state.error,
    port: state.port,
    urls: running && state.tls && state.port ? gatewayUrls(state.tls.names, state.port) : [],
    key: state.key
      ? { source: state.key.source, rollable: state.key.source === "file" }
      : null,
    tls: state.tls
      ? {
          mode: state.tls.mode,
          fingerprint256: state.tls.fingerprint256,
          caFingerprint256: state.tls.caFingerprint256,
          notAfter: state.tls.notAfter,
          names: state.tls.names,
        }
      : null,
  };
}

/**
 * Re-check the certificate and swap it in when it changed. A failure keeps the
 * certificate in use: a running gateway is worth more than a refreshed one.
 */
export function maintainSecureGatewayTls(): void {
  const state = getState();
  if (!state.gateway || !state.config || !state.tls) return;
  try {
    const next = loadTls(state.config);
    if (next.fingerprint256 === state.tls.fingerprint256) return;
    state.gateway.setTls(next, next.caCert);
    state.tls = next;
    console.log(
      `[secure-gateway] Now serving a new certificate (SHA-256 ${next.fingerprint256}).`,
    );
  } catch (err) {
    console.error("[secure-gateway] Could not refresh the certificate:", err);
  }
}

/**
 * Close the gateway as soon as the process is told to stop.
 *
 * Next's own shutdown waits for open connections to finish, and a stream (a
 * slicer on `/api/scan/stream`) never does. Until that process finally exits it
 * would keep the HTTPS port: still serving the LAN after "Share on local
 * network" was turned off, and blocking the replacement server's gateway with
 * "port already in use". Closing here frees the port at once.
 *
 * The listeners are in ADDITION to whatever else handles the signal. Where
 * nothing else does, having one at all would cancel Node's default exit, so
 * the signal is re-raised once the gateway is closed.
 */
function closeOnShutdownSignals(gateway: SecureGateway): () => void {
  const signals = ["SIGTERM", "SIGINT"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => {
      void gateway.close().then(() => {
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    };
    process.once(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

async function start(env: Record<string, string | undefined>): Promise<SecureGatewayStatus> {
  const state = getState();
  const parsed = parseGatewayEnv(env);
  if (parsed.state === "disabled") return getSecureGatewayStatus();

  state.configured = true;
  if (parsed.state === "invalid") {
    state.error = parsed.error;
    console.error(`[secure-gateway] Not started: ${parsed.error}`);
    return getSecureGatewayStatus();
  }

  const config = parsed.config;
  state.config = config;
  state.port = config.port;
  try {
    if (config.envApiKey !== null && !isUsableApiKey(config.envApiKey)) {
      // The gateway faces the network and does not lock a client out for
      // guessing, so the key has to be unguessable on its own.
      throw new Error(
        `FILAMENTDB_API_KEY must be ${MIN_API_KEY_LENGTH} to 512 printable characters without spaces ` +
          "to be used with the secure gateway (for example: openssl rand -hex 32).",
      );
    }
    const key = loadOrCreateApiKey({ envKey: config.envApiKey, dir: config.secureDir });
    const tls = loadTls(config);
    const gateway = createSecureGateway({
      tls,
      caCert: tls.caCert,
      apiKey: key.key,
      upstream: config.upstream,
      allowedOrigins: allowedOriginsFromEnv(env.ALLOWED_ORIGINS),
    });
    try {
      state.port = await gateway.listen(config.port, config.host);
    } catch (err) {
      throw new Error(listenErrorMessage(err, config.port));
    }
    state.key = key;
    state.tls = tls;
    state.gateway = gateway;
    state.error = null;
    state.timer = setInterval(maintainSecureGatewayTls, TLS_MAINTENANCE_INTERVAL_MS);
    state.timer.unref();
    state.removeSignalHandlers = closeOnShutdownSignals(gateway);

    console.log(
      `[secure-gateway] HTTPS with API key on ${config.host}:${state.port} ` +
        `(${tls.mode === "custom" ? "your certificate" : "generated certificate"}, ` +
        `SHA-256 ${tls.fingerprint256}).`,
    );
    if (key.created) {
      console.log(
        `[secure-gateway] Generated a new API key and saved it to ${key.file}. ` +
          "Settings → Network shows it and can roll it.",
      );
    }
    console.log(
      "[secure-gateway] The plain HTTP port needs no key while the gateway is running. " +
        "Keep it bound or published to this machine only.",
    );
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    console.error(`[secure-gateway] Not started: ${state.error}`);
  }
  return getSecureGatewayStatus();
}

/**
 * Start the gateway when the environment asks for one. Never throws: a
 * gateway that cannot start is reported through the status, and the app itself
 * still comes up. Calling it again returns the first call's outcome.
 */
export function startSecureGateway(
  env: Record<string, string | undefined> = process.env,
): Promise<SecureGatewayStatus> {
  const state = getState();
  if (!state.starting) state.starting = start(env);
  return state.starting;
}

/** Stop the gateway and forget its state. */
export async function stopSecureGateway(): Promise<void> {
  const state = getState();
  if (state.starting) await state.starting;
  if (state.timer) clearInterval(state.timer);
  state.removeSignalHandlers?.();
  if (state.gateway) await state.gateway.close();
  delete (globalThis as GlobalWithGateway)[GLOBAL_KEY];
}

/** The API key in use, or null when no gateway is running. */
export function revealSecureGatewayKey(): string | null {
  const state = getState();
  return state.gateway && state.key ? state.key.key : null;
}

/** PEM of the generated CA, or null (gateway off, or an own certificate). */
export function getSecureGatewayCaCert(): string | null {
  const state = getState();
  return state.gateway && state.tls ? state.tls.caCert : null;
}

/**
 * Whether a request's `Host` names this server: loopback, or a name the
 * gateway's certificate is valid for.
 *
 * The routes that hand out or replace the API key check it. The same-origin
 * guard cannot stop DNS rebinding (a page on `evil.example` re-pointed at
 * 127.0.0.1 is same-origin with itself), but such a request still carries
 * `Host: evil.example`. It also keeps the key from being read over plain HTTP
 * through an address that was never meant to serve it.
 */
export function isOwnHost(hostHeader: string | null | undefined): boolean {
  const authority = (hostHeader ?? "").trim().toLowerCase();
  if (!authority) return false;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(authority);
  const hostname = bracketed ? bracketed[1] : authority.replace(/:\d+$/, "");
  if (isLoopbackHostname(hostname)) return true;
  const state = getState();
  if (!state.tls) return false;
  try {
    const cert = new X509Certificate(state.tls.cert);
    return isIP(hostname)
      ? cert.checkIP(hostname) !== undefined
      : cert.checkHost(hostname) !== undefined;
  } catch {
    return false;
  }
}

export type RollRefusal = "gateway_off" | "env_key";

export class ApiKeyNotRollableError extends Error {
  constructor(readonly reason: RollRefusal) {
    super(
      reason === "env_key"
        ? "The API key is set by FILAMENTDB_API_KEY. Change it there and restart."
        : "The secure gateway is not running, so there is no API key to roll.",
    );
    this.name = "ApiKeyNotRollableError";
  }
}

/**
 * Replace the API key with a new random one, effective immediately: the old
 * key and every browser session signed in with it stop working.
 */
export function rollSecureGatewayKey(): string {
  const state = getState();
  if (!state.gateway || !state.key || !state.config) {
    throw new ApiKeyNotRollableError("gateway_off");
  }
  if (state.key.source !== "file") throw new ApiKeyNotRollableError("env_key");
  const next = rollStoredApiKey(state.config.secureDir);
  state.gateway.setApiKey(next.key);
  state.key = next;
  console.log("[secure-gateway] The API key was rolled. The previous key no longer works.");
  return next.key;
}
