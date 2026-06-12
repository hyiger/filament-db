/**
 * SSRF guard for user-supplied MongoDB connection strings (GH #254).
 *
 * `POST /api/filaments/import-atlas` and `POST /api/setup` take a `uri`
 * straight from the request body and hand it to `new MongoClient(uri)`
 * + `connect()`. Without a guard, `mongodb://10.0.0.5:27017` turns the
 * server into an internal-network port scanner / service prober — and
 * because the app runs an unauthenticated HTTP server, any web page the
 * user visits can drive it cross-origin.
 *
 * Policy:
 *   - The scheme must be `mongodb://` or `mongodb+srv://`.
 *   - `import-atlas` (importing from a *remote* Atlas) additionally
 *     requires `mongodb+srv://` and rejects hosts that resolve to a
 *     private/internal address — it never legitimately targets a LAN
 *     host.
 *   - `setup` (configuring the app's OWN database) only gets the scheme
 *     check: a local/Docker deployment legitimately points at
 *     `mongodb://localhost` or a private Docker-network host, so
 *     IP-blocking there is wrong. Restricting *who* may call `setup`
 *     is the job of the destructive-route access guard (GH #252).
 */

import { lookup, resolveSrv } from "node:dns/promises";
import { isPrivateIp } from "@/lib/externalUrlGuard";

/** Message used whenever a host resolves into private/internal space. */
const PRIVATE_HOST_ERROR =
  "Connection string resolves to a private/internal address — only public database hosts are allowed.";

export interface MongoUriGuardOptions {
  /** Require the `mongodb+srv://` scheme (reject plain `mongodb://`). */
  requireSrv?: boolean;
  /** Resolve every host and reject private/internal addresses. */
  blockPrivateHosts?: boolean;
}

/** Strip `:port` and IPv6 brackets from a single `host[:port]` spec. */
function extractHost(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end !== -1 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const colon = trimmed.indexOf(":");
  return colon !== -1 ? trimmed.slice(0, colon) : trimmed;
}

async function resolveHostIps(host: string): Promise<string[]> {
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (isIpLiteral) return [host];
  const records = await lookup(host, { all: true }).catch(() => []);
  if (records.length === 0) {
    throw new Error(`Database host does not resolve: ${host}`);
  }
  return records.map((r) => r.address);
}

/**
 * Validate a user-supplied MongoDB connection string before it is passed
 * to a `MongoClient`. Throws an `Error` describing the rejection.
 *
 * #674 — best-effort by design. This resolves the host (or SRV targets) and
 * rejects private/metadata IPs at validation time, but `MongoClient.connect()`
 * performs its OWN independent DNS/SRV resolution at connect time, so a
 * resolver that returns a public IP here and a private one microseconds later
 * (DNS rebinding) is a residual TOCTOU. Pinning the validated IP into the URI
 * isn't viable — it breaks `mongodb+srv` SRV resolution and TLS hostname
 * verification (the cert is for the name, not the IP). The accepted primary
 * controls are therefore: this guard as defence-in-depth, the
 * `assertSameOriginRequest` CSRF guard on every caller (import-atlas / setup),
 * and the fact that supplying a connection string is an explicit user action.
 */
export async function assertSafeMongoUri(
  uri: string,
  opts: MongoUriGuardOptions = {},
): Promise<void> {
  const match = /^(mongodb(?:\+srv)?):\/\/(.+)$/i.exec(uri.trim());
  if (!match) {
    throw new Error(
      "Connection string must be a mongodb:// or mongodb+srv:// URI.",
    );
  }
  const isSrv = match[1].toLowerCase() === "mongodb+srv";
  if (opts.requireSrv && !isSrv) {
    throw new Error(
      "Only mongodb+srv:// connection strings are accepted here.",
    );
  }

  // authority = everything before the first '/' or '?'; drop userinfo
  // (everything up to and including the last '@').
  let authority = match[2].split(/[/?]/)[0];
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);

  const hostSpecs = authority
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hostSpecs.length === 0) {
    throw new Error("Connection string has no host.");
  }
  if (isSrv && hostSpecs.length > 1) {
    throw new Error(
      "A mongodb+srv:// connection string must have exactly one host.",
    );
  }

  if (!opts.blockPrivateHosts) return;

  if (isSrv) {
    // GH #332 (Codex P1): a `mongodb+srv://` connection does NOT connect
    // to the seed host — the driver does a DNS SRV lookup of
    // `_mongodb._tcp.<seed>` and connects to the hosts in those records.
    // A seed host with a public A record but SRV targets pointing at
    // RFC1918 space would otherwise pass the guard and still let
    // MongoClient open internal connections. Resolve and validate the
    // SRV TARGETS, not the seed host.
    const seedHost = extractHost(hostSpecs[0]);
    if (!seedHost) throw new Error("Connection string has an empty host.");
    const srvRecords = await resolveSrv(`_mongodb._tcp.${seedHost}`).catch(
      () => [] as { name: string }[],
    );
    if (srvRecords.length === 0) {
      throw new Error(
        `No SRV records found for ${seedHost} — not a reachable mongodb+srv host.`,
      );
    }
    for (const record of srvRecords) {
      const ips = await resolveHostIps(record.name);
      for (const ip of ips) {
        if (isPrivateIp(ip)) throw new Error(PRIVATE_HOST_ERROR);
      }
    }
    return;
  }

  // Plain mongodb:// — the listed hosts ARE the connection targets.
  for (const spec of hostSpecs) {
    const host = extractHost(spec);
    if (!host) throw new Error("Connection string has an empty host.");
    const ips = await resolveHostIps(host);
    for (const ip of ips) {
      if (isPrivateIp(ip)) throw new Error(PRIVATE_HOST_ERROR);
    }
  }
}
