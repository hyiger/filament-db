/**
 * GH #1231: the client-safe half of the database-connection error contract.
 *
 * The classifier itself (src/lib/mongoConnectionError.ts) runs on the server
 * and in the Electron main process. What crosses to the renderer is only a
 * `{kind, atlas}` pair, which the UI turns into translated text through
 * `dbErrorMessageKey`. Keeping this module free of any driver or Node import
 * lets every page and component use it.
 */

export const DB_ERROR_KINDS = [
  /** TLS alert 80 from a public Atlas cluster: the IP Access List rejection. */
  "ip-not-allowed",
  /** Wrong username or password (code 18, or AtlasError 8000 "bad auth"). */
  "auth-failed",
  /** Authenticated, but the user lacks a role for this database (code 13). */
  "unauthorized",
  /** The host name (or its SRV/TXT record) could not be resolved. */
  "dns",
  /** Any other TLS handshake or certificate failure. */
  "tls",
  /** Refused, reset, timed out, or no server answered in time. */
  "unreachable",
  /** The connection string itself could not be parsed. */
  "invalid-uri",
  /** No connection string is configured at all (server: MONGODB_URI unset). */
  "not-configured",
  /** A connection failure none of the driver-owned signals above explain. */
  "unknown",
] as const;

export type DbErrorKind = (typeof DB_ERROR_KINDS)[number];

export function isDbErrorKind(value: unknown): value is DbErrorKind {
  return typeof value === "string" && (DB_ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * Where a hint is read, which decides whose public IP address the Atlas
 * advice names. On the desktop it is this computer's (or its VPN's). On the
 * server it is the server host's outbound address: for Docker that is the
 * Docker host, often a different machine from the browser.
 */
export type DbErrorSurface = "desktop" | "server";

export interface DbErrorInfo {
  kind: DbErrorKind;
  /** The target is a public MongoDB Atlas cluster (hosts *.mongodb.net:27017). */
  atlas: boolean;
  /** Desktop hybrid sync only: which database the failing client was for. */
  side?: "local" | "remote";
}

/** A classified failure plus the raw driver text, for desktop surfaces that
 *  show it to the local user under "Technical details". Connection strings
 *  are already redacted out of `detail`. Never sent in an API response. */
export interface DbConnectionErrorInfo extends DbErrorInfo {
  detail: string;
}

/**
 * Every translation key `dbErrorMessageKey` can return, as literals. The
 * i18n coverage test only sees t() calls whose argument is a string
 * literal, so a test iterates this list against both locale files instead.
 */
export const DB_ERROR_MESSAGE_KEYS = [
  "db.error.ipNotAllowed.desktop",
  "db.error.ipNotAllowed.server",
  "db.error.unreachableAtlas.desktop",
  "db.error.unreachableAtlas.server",
  "db.error.unreachable",
  "db.error.local",
  "db.error.dns",
  "db.error.authFailed",
  "db.error.unauthorized",
  "db.error.tls",
  "db.error.invalidUri",
  "db.error.notConfigured.desktop",
  "db.error.notConfigured.server",
  "db.error.unknown.desktop",
  "db.error.unknown.server",
] as const;

export type DbErrorMessageKey = (typeof DB_ERROR_MESSAGE_KEYS)[number];

export function dbErrorMessageKey(info: DbErrorInfo, surface: DbErrorSurface): DbErrorMessageKey {
  // The embedded local mongod is never Atlas, and none of the Atlas or
  // credential advice applies to it.
  if (info.side === "local") return "db.error.local";
  switch (info.kind) {
    case "ip-not-allowed":
      // The classifier only produces this for an Atlas target; a non-Atlas
      // alert 80 is a plain TLS failure.
      return info.atlas
        ? surface === "desktop"
          ? "db.error.ipNotAllowed.desktop"
          : "db.error.ipNotAllowed.server"
        : "db.error.tls";
    case "unreachable":
      if (!info.atlas) return "db.error.unreachable";
      return surface === "desktop"
        ? "db.error.unreachableAtlas.desktop"
        : "db.error.unreachableAtlas.server";
    case "dns":
      return "db.error.dns";
    case "auth-failed":
      return "db.error.authFailed";
    case "unauthorized":
      return "db.error.unauthorized";
    case "tls":
      return "db.error.tls";
    case "invalid-uri":
      return "db.error.invalidUri";
    case "not-configured":
      return surface === "desktop" ? "db.error.notConfigured.desktop" : "db.error.notConfigured.server";
    case "unknown":
      return surface === "desktop" ? "db.error.unknown.desktop" : "db.error.unknown.server";
  }
}

/**
 * Read the `{code: "db_unavailable", kind, atlas}` shape a 503 from this API
 * carries (and that `/api/health` returns). Anything else, including a
 * kind this build doesn't know, reads as null so the caller falls back to
 * its generic message.
 */
export function dbErrorFromBody(body: unknown): DbErrorInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { code?: unknown; kind?: unknown; atlas?: unknown };
  if (b.code !== "db_unavailable" || !isDbErrorKind(b.kind)) return null;
  return { kind: b.kind, atlas: b.atlas === true };
}
