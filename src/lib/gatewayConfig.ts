/**
 * Environment configuration of the secure gateway: an HTTPS listener that
 * requires an API key and forwards to the plain HTTP server (see
 * src/lib/secureGateway.ts). Free of the gateway's own imports so src/proxy.ts
 * can ask "is the gateway running?" on every request.
 *
 * - `FILAMENTDB_HTTPS_PORT`  turns the gateway on. Unset: off.
 * - `FILAMENTDB_HTTPS_HOST`  interface it binds (default `0.0.0.0`).
 * - `FILAMENTDB_SECURE_DIR`  where the generated API key and certificates are
 *                            kept (default `~/.filament-db/secure`).
 * - `FILAMENTDB_API_KEY`     a fixed key. Unset: a random one is generated,
 *                            stored in the secure directory, and can be rolled.
 * - `FILAMENTDB_TLS_CERT` / `FILAMENTDB_TLS_KEY`
 *                            PEM files of your own certificate. Unset: a local
 *                            CA and server certificate are generated.
 * - `FILAMENTDB_TLS_HOSTS`   extra comma-separated DNS names / IPs for the
 *                            generated certificate (what clients type to reach
 *                            a container, which cannot see its host's address).
 */

import os from "node:os";
import path from "node:path";

export const DEFAULT_HTTPS_HOST = "0.0.0.0";
/** Used only when the process has no home directory. */
export const DEFAULT_SECURE_DIR_NAME = ".filamentdb-secure";

function homeDirectory(): string {
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

/**
 * Where the key and certificates go when `FILAMENTDB_SECURE_DIR` is unset: the
 * user's home, NOT the working directory. Next's standalone `server.js` changes
 * into its own folder (`.next/standalone`), which every build deletes, so a
 * directory there would lose the key and the CA on each update.
 */
function defaultSecureDir(cwd: string, home: string): string {
  return home
    ? path.join(home, ".filament-db", "secure")
    : path.join(cwd, DEFAULT_SECURE_DIR_NAME);
}
/** Next's standalone server default when `PORT` is unset. */
const DEFAULT_HTTP_PORT = 3000;

export interface GatewayConfig {
  /** HTTPS listener. */
  port: number;
  host: string;
  /** The plain HTTP server requests are forwarded to. */
  upstream: { host: string; port: number };
  secureDir: string;
  /** `FILAMENTDB_API_KEY`, or null to generate and store one. */
  envApiKey: string | null;
  /** Both set (own certificate) or both null (generated). */
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  extraHosts: string[];
}

export type GatewayEnvResult =
  | { state: "disabled" }
  | { state: "invalid"; error: string }
  | { state: "enabled"; config: GatewayConfig };

type Env = Record<string, string | undefined>;

/** A TCP port from an env value: digits only, 1-65535. */
function parsePort(raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * The address the plain HTTP server can be reached at from this process. It
 * binds `HOSTNAME` (Next's standalone convention); a wildcard bind is reached
 * over loopback.
 */
function upstreamHost(raw: string | undefined): string {
  const host = (raw ?? "").trim();
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }
  return host.replace(/^\[|\]$/g, "");
}

export function parseGatewayEnv(
  env: Env,
  cwd: string = process.cwd(),
  home: string = homeDirectory(),
): GatewayEnvResult {
  const rawPort = (env.FILAMENTDB_HTTPS_PORT ?? "").trim();
  if (!rawPort) return { state: "disabled" };

  const port = parsePort(rawPort);
  if (port === null) {
    return {
      state: "invalid",
      error: `FILAMENTDB_HTTPS_PORT must be a port number from 1 to 65535 (got "${rawPort}").`,
    };
  }
  const httpPort = parsePort(env.PORT) ?? DEFAULT_HTTP_PORT;
  if (port === httpPort) {
    return {
      state: "invalid",
      error: `FILAMENTDB_HTTPS_PORT (${port}) must differ from the HTTP port.`,
    };
  }

  const tlsCertFile = (env.FILAMENTDB_TLS_CERT ?? "").trim() || null;
  const tlsKeyFile = (env.FILAMENTDB_TLS_KEY ?? "").trim() || null;
  if ((tlsCertFile === null) !== (tlsKeyFile === null)) {
    return {
      state: "invalid",
      error: "Set both FILAMENTDB_TLS_CERT and FILAMENTDB_TLS_KEY, or neither.",
    };
  }

  const secureDir = (env.FILAMENTDB_SECURE_DIR ?? "").trim();
  return {
    state: "enabled",
    config: {
      port,
      host: (env.FILAMENTDB_HTTPS_HOST ?? "").trim() || DEFAULT_HTTPS_HOST,
      upstream: { host: upstreamHost(env.HOSTNAME), port: httpPort },
      secureDir: secureDir ? path.resolve(cwd, secureDir) : defaultSecureDir(cwd, home),
      // Trimmed: a stray newline from a secrets file would otherwise become
      // part of a key that no client could ever send.
      envApiKey: (env.FILAMENTDB_API_KEY ?? "").trim() || null,
      tlsCertFile,
      tlsKeyFile,
      extraHosts: (env.FILAMENTDB_TLS_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean),
    },
  };
}

/** The desktop app's gateway port when nothing else is asked for. */
export const DEFAULT_DESKTOP_HTTPS_PORT = 3457;

/**
 * The port the desktop app gives its gateway: `requested`
 * (`FILAMENTDB_HTTPS_PORT`) when that is a usable port, otherwise the default.
 * Either way it never equals the HTTP port: `parseGatewayEnv` refuses that
 * pair, and the app would then show sharing as on with nothing listening. So
 * an app started with `PORT=3457` gets the next port up.
 */
export function desktopHttpsPort(requested: string | undefined, httpPort: number): number {
  const asked = parsePort(requested);
  if (asked !== null && asked !== httpPort) return asked;
  return httpPort === DEFAULT_DESKTOP_HTTPS_PORT
    ? DEFAULT_DESKTOP_HTTPS_PORT + 1
    : DEFAULT_DESKTOP_HTTPS_PORT;
}

/** Where src/lib/gatewayRuntime.ts keeps the process's gateway on `globalThis`. */
export const GATEWAY_GLOBAL_KEY = "__filamentDbSecureGateway__";

/**
 * True while this process has a gateway LISTENING. Not "configured": a gateway
 * that was asked for but could not start (unreadable certificate, port in use,
 * mistyped port) must not count, or `FILAMENTDB_API_KEY` would stop gating the
 * HTTP port (src/lib/apiAuth.ts) while nothing else protects the instance.
 */
export function secureGatewayRunning(): boolean {
  const state = (globalThis as Record<string, unknown>)[GATEWAY_GLOBAL_KEY] as
    | { gateway?: unknown }
    | undefined;
  return state?.gateway != null;
}
