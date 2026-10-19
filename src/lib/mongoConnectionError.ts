/**
 * GH #1231: classify a MongoDB connection failure so the user is told WHY
 * the database can't be reached, not shown the driver's raw text.
 *
 * The motivating report: an Atlas cluster whose IP Access List didn't
 * include the user's address. Atlas's shared-tier proxy answers that TLS
 * handshake with alert 80, and the driver copies the TLS library's message
 * into its own `MongoServerSelectionError.message`, so the desktop sync
 * popover showed `…TLSV1_ALERT_INTERNAL_ERROR…SSL alert number 80` and
 * nothing else.
 *
 * ## Only signals the driver and Node produce (the GH #1154 rule)
 *
 * The decision reads error `code`s, Node's `syscall`, driver class `name`s
 * and the server addresses on the topology. It never pattern-matches a
 * free-text message, with one exception: AtlasError 8000, whose message
 * Atlas's proxy writes itself (the same allowance `wrapSyncErrorMessage`
 * makes). Messages can carry stored data: an E11000 echoes the offending
 * value, and the rename-staging wrapper (`withStrandingNotice`) quotes
 * entity names the user typed. A message regex would let a bed type named
 * "SSL alert number 80" steer the hint. The `ERR_SSL_*` code is also the
 * only TLS signal that is the same under OpenSSL (Node, Docker) and
 * BoringSSL (Electron); the message wording and casing differ between them.
 *
 * ## The per-server errors decide, not the wrapper
 *
 * `MongoServerSelectionError` keeps each server's last error on
 * `reason.servers`. Mongoose's `MongooseServerSelectionError` rewrites the
 * message to an "IP isn't whitelisted" sentence for ANY Atlas topology whose
 * servers are all unknown, which includes DNS typos and plain timeouts, so
 * that sentence is not evidence of anything. Its `reason` (also set as its
 * `cause`) still carries the real per-server errors, and this module reads
 * those.
 *
 * Pure and driver-free: it duck-types the error shapes, so the Next server
 * and the Electron main process share one implementation.
 */
import { isDbErrorKind, type DbConnectionErrorInfo, type DbErrorKind } from "./dbErrorKinds";

/** A connection string inside free text: everything up to the next
 *  whitespace. Whitespace is the only safe stop: the driver accepts `"`,
 *  `<` and `>` unescaped in a password, and echoes the whole URI in some of
 *  its messages, so stopping at any of them would leave the rest visible. */
const MONGO_URI_RE = /mongodb(?:\+srv)?:\/\/\S*/gi;

/** Replace every connection string in `text` with `mongodb://***`. A quote
 *  or bracket at the very end belongs to the surrounding text (drivers echo
 *  a URI in quotes) and is kept, which also leaves the driver's own
 *  `expected … to start with "mongodb://"` wording readable. */
export function redactMongoUri(text: string): string {
  return text.replace(MONGO_URI_RE, (match) => {
    const rest = match.slice(match.indexOf("//") + 2);
    const trailing = /["'>)\]]$/.test(rest) ? rest.slice(-1) : "";
    const body = trailing ? rest.slice(0, -1) : rest;
    return body ? `mongodb://***${trailing}` : match;
  });
}

/** Raw-detail cap. A selection error can list every host's message. */
const MAX_DETAIL_LENGTH = 400;

function cleanDetail(message: unknown): string {
  if (typeof message !== "string") return "";
  const flat = redactMongoUri(message).replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_LENGTH ? `${flat.slice(0, MAX_DETAIL_LENGTH - 1)}…` : flat;
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null;
}

/** Server descriptions on a topology (a `Map` in the driver). */
function serverDescriptions(holder: unknown): Obj[] {
  if (!isObject(holder)) return [];
  const servers = holder.servers;
  const list =
    servers instanceof Map
      ? Array.from(servers.values())
      : Array.isArray(servers)
        ? servers
        : isObject(servers)
          ? Object.values(servers)
          : [];
  return list.filter(isObject);
}

/** A TopologyDescription isn't an error itself; Mongoose sets one as `cause`. */
function isTopologyDescription(value: Obj): boolean {
  return "servers" in value && typeof value.message !== "string";
}

/**
 * Atlas cluster host names end in `.mongodb.net`. A private endpoint's
 * first label carries `-pl-N` and its servers listen on ports above 1024;
 * those connections don't come from a public IP, so the access-list advice
 * would be wrong for them.
 */
function isAtlasHostName(host: string): boolean {
  return /\.mongodb\.net\.?$/i.test(host) && !/^[^.]*-pl-\d+\./i.test(host);
}

/** `host:port` of a public Atlas server. Mongoose's own Atlas check also
 *  insists on port 27017, for the private-endpoint reason above. */
function isAtlasAddress(address: string): boolean {
  const colon = address.lastIndexOf(":");
  const host = colon >= 0 ? address.slice(0, colon) : address;
  const port = colon >= 0 ? address.slice(colon + 1) : "27017";
  return port === "27017" && isAtlasHostName(host);
}

/** True when a connection string points at a public Atlas cluster. Parsed
 *  by hand so this module needs no URI library; the userinfo is cut at the
 *  LAST `@`, which also copes with an unescaped `@` in a password. */
export function isAtlasUri(uri: string): boolean {
  const match = /^\s*mongodb(\+srv)?:\/\/([^/?#]*)/i.exec(uri);
  if (!match) return false;
  const authority = match[2];
  const hosts = authority
    .slice(authority.lastIndexOf("@") + 1)
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hosts.length === 0) return false;
  // mongodb+srv:// names one host and no port; DNS supplies the servers.
  if (match[1]) return hosts.length === 1 && isAtlasHostName(hosts[0]);
  return hosts.every((h) => isAtlasAddress(h.includes(":") ? h : `${h}:27017`));
}

/** What one error node says about the failure. */
type Signal =
  | "auth-failed"
  | "unauthorized"
  | "alert-80"
  | "dns"
  | "tls"
  | "invalid-uri"
  | "unreachable"
  /** A server answered with some other numeric code: it was reachable, and
   *  whatever failed isn't a connection problem this module can name. */
  | "server-code"
  /** Only the driver's selection/network wrapper class, with no detail. */
  | "unreachable-weak";

/** Strongest first. A credential verdict comes from the server itself, so
 *  it beats everything; the bare wrapper class is the weakest evidence. */
const SIGNAL_PRIORITY: readonly Signal[] = [
  "auth-failed",
  "unauthorized",
  "alert-80",
  "dns",
  "tls",
  "invalid-uri",
  "unreachable",
  "server-code",
  "unreachable-weak",
];

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const CERT_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EPIPE",
  // A blocked outbound connect: a firewall, or macOS's Local Network
  // permission for a LAN host.
  "EACCES",
]);

const WEAK_NAMES = new Set([
  "MongoServerSelectionError",
  "MongooseServerSelectionError",
  "MongoNetworkError",
]);

function signalOf(node: Obj): Signal | null {
  const code = node.code;
  if (typeof code === "number") {
    if (code === 18) return "auth-failed";
    if (code === 13) return "unauthorized";
    if (code === 8000) {
      // Atlas's proxy writes these messages; they never echo stored values.
      const message = typeof node.message === "string" ? node.message : "";
      if (/bad auth|authentication failed/i.test(message)) return "auth-failed";
      if (/not allowed to do action/i.test(message)) return "unauthorized";
    }
    return "server-code";
  }
  if (typeof code === "string") {
    if (code === "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR") return "alert-80";
    // SRV and TXT lookups fail with any of several resolver codes
    // (ENOTFOUND, ECONNREFUSED, ETIMEOUT, ESERVFAIL…): the syscall is what
    // marks them as DNS. Atlas documents `querySrv ECONNREFUSED` as a
    // resolver problem, not a refused database connection.
    if (node.syscall === "querySrv" || node.syscall === "queryTxt") return "dns";
    if (DNS_CODES.has(code)) return "dns";
    if (CERT_CODES.has(code) || /^(ERR_SSL_|ERR_TLS_|CERT_)/.test(code)) return "tls";
    if (NETWORK_CODES.has(code)) return "unreachable";
  }
  const name = typeof node.name === "string" ? node.name : "";
  if (name === "MongoParseError") return "invalid-uri";
  if (name === "MongoNetworkTimeoutError") return "unreachable";
  if (WEAK_NAMES.has(name)) return "unreachable-weak";
  return null;
}

const MAX_NODES = 64;
const MAX_DEPTH = 8;

interface Walk {
  /** Error nodes in breadth-first order, outermost first. */
  nodes: Obj[];
  /** Every server address on any topology the walk passed. */
  addresses: string[];
  /** True when some server on those topologies ANSWERED (its description
   *  has a known type: a secondary, an arbiter, an uninitiated replica-set
   *  member). Selection then failed for another reason, such as no primary
   *  during an election, so the server is not unreachable. */
  someServerAnswered: boolean;
}

/** Breadth-first over the error, its `cause` chain, and each topology's
 *  per-server errors. Bounded and cycle-safe. */
function walk(err: unknown): Walk {
  const nodes: Obj[] = [];
  const addresses: string[] = [];
  let someServerAnswered = false;
  const seen = new Set<Obj>();
  const queue: Array<[unknown, number]> = [[err, 0]];
  while (queue.length > 0 && nodes.length < MAX_NODES) {
    const [current, depth] = queue.shift()!;
    if (!isObject(current) || seen.has(current)) continue;
    seen.add(current);
    if (!isTopologyDescription(current)) nodes.push(current);
    if (depth >= MAX_DEPTH) continue;
    for (const holder of [current.reason, current]) {
      for (const server of serverDescriptions(holder)) {
        if (typeof server.address === "string") addresses.push(server.address);
        if (typeof server.type === "string" && server.type !== "Unknown") someServerAnswered = true;
        if (server.error != null) queue.push([server.error, depth + 1]);
      }
    }
    if (current.cause !== undefined) queue.push([current.cause, depth + 1]);
  }
  return { nodes, addresses, someServerAnswered };
}

function atlasTarget(found: Walk, uri: string | undefined): boolean {
  // The resolved server addresses are the most direct evidence: after an
  // SRV lookup they include the ports, which tells a public cluster from a
  // private endpoint.
  if (found.addresses.length > 0) return found.addresses.every(isAtlasAddress);
  if (uri) return isAtlasUri(uri);
  // A failed SRV lookup leaves no servers, but Node names the record it
  // asked for (`_mongodb._tcp.<cluster host>`).
  return found.nodes.some(
    (n) =>
      (n.syscall === "querySrv" || n.syscall === "queryTxt") &&
      typeof n.hostname === "string" &&
      isAtlasHostName(n.hostname.replace(/^_mongodb\._tcp\./i, "")),
  );
}

export interface MongoConnectionClassification extends DbConnectionErrorInfo {
  /** The deciding error's `code` (or class name), for logs. */
  signal: string | null;
}

/**
 * Classify why a MongoDB connection attempt failed. `uri` is the connection
 * string that was used; it only helps decide whether the target is Atlas
 * when the error carries no server addresses.
 */
export function classifyMongoConnectionError(
  err: unknown,
  options: { uri?: string } = {},
): MongoConnectionClassification {
  const found = walk(err);
  let best: { signal: Signal; node: Obj } | null = null;
  for (const node of found.nodes) {
    const signal = signalOf(node);
    if (signal === null) continue;
    if (best === null || SIGNAL_PRIORITY.indexOf(signal) < SIGNAL_PRIORITY.indexOf(best.signal)) {
      best = { signal, node };
    }
  }

  const atlas = atlasTarget(found, options.uri);
  const top = found.nodes[0];
  const signal = best?.signal;
  let kind: DbErrorKind;
  switch (signal) {
    case "alert-80":
      kind = atlas ? "ip-not-allowed" : "tls";
      break;
    case "unreachable-weak":
      // Only the wrapper class says anything. If a server answered, it is
      // reachable and the cause lies elsewhere (no primary, an uninitiated
      // replica set); "check it's running and the firewall" would be wrong.
      kind = found.someServerAnswered ? "unknown" : "unreachable";
      break;
    case "server-code":
    case undefined:
      kind = "unknown";
      break;
    default:
      kind = signal;
  }

  // The deciding node's own text is the most useful detail (the TLS or DNS
  // message rather than a wrapper's). A weak or missing signal has no
  // better node than the outermost error.
  const decisive = best && best.signal !== "unreachable-weak" ? best.node : top;
  const code = decisive?.code;
  return {
    kind,
    atlas,
    detail: cleanDetail(decisive?.message) || cleanDetail(top?.message),
    signal:
      typeof code === "string" || typeof code === "number"
        ? String(code)
        : typeof decisive?.name === "string"
          ? decisive.name
          : null,
  };
}

/**
 * Thrown by `dbConnect` in place of the driver's error. Its `message` is a
 * plain-English hint that is safe to return from any API route; the raw
 * driver error rides `cause` for server-side logging only.
 */
export class DbUnavailableError extends Error {
  readonly kind: DbErrorKind;
  readonly atlas: boolean;

  constructor(info: { kind: DbErrorKind; atlas: boolean }, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DbUnavailableError";
    this.kind = info.kind;
    this.atlas = info.atlas;
  }
}

/** Matched by name, not `instanceof`, so a duplicated module copy (route
 *  bundles, test isolation) still recognises it. */
export function isDbUnavailableError(err: unknown): err is DbUnavailableError {
  return (
    err instanceof Error &&
    err.name === "DbUnavailableError" &&
    isDbErrorKind((err as { kind?: unknown }).kind)
  );
}
