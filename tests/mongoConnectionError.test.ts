import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { createRequire } from "node:module";
import mongoose from "mongoose";
import {
  MongoClient,
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoParseError,
  MongoServerError,
  MongoServerSelectionError,
  type ServerDescription as ServerDescriptionT,
  type TopologyDescription as TopologyDescriptionT,
} from "mongodb";
import {
  classifyMongoConnectionError,
  DbUnavailableError,
  isAtlasUri,
  isDbUnavailableError,
  redactMongoUri,
} from "@/lib/mongoConnectionError";
import { strandedPlaceholderNotice, withStrandingNotice } from "@/lib/renameStaging";

// The driver's SDAM description classes are declared in its types but not
// exported at runtime, so load them from their own modules.
const requireCjs = createRequire(import.meta.url);
const { TopologyDescription } = requireCjs("mongodb/lib/sdam/topology_description") as {
  TopologyDescription: new (type: string, servers: Map<string, ServerDescriptionT>) => TopologyDescriptionT;
};
const { ServerDescription } = requireCjs("mongodb/lib/sdam/server_description") as {
  ServerDescription: new (
    address: string,
    hello?: Record<string, unknown>,
    options?: { error?: unknown },
  ) => ServerDescriptionT;
};
const MongooseServerSelectionError = mongoose.Error.MongooseServerSelectionError as unknown as new () => {
  assimilateError(err: Error): Error;
};

/**
 * GH #1231. Fixtures are built from the REAL driver classes so a driver
 * upgrade that reshapes the errors fails here, plus one test that provokes a
 * genuine TLS alert 80 over a socket. The BoringSSL message text from the
 * issue's screenshot is used only as a message; nothing may key on it (the
 * numeric prefix and the file:line vary by build).
 */

const ATLAS_HOSTS = [
  "cluster0-shard-00-00.abcde.mongodb.net:27017",
  "cluster0-shard-00-01.abcde.mongodb.net:27017",
  "cluster0-shard-00-02.abcde.mongodb.net:27017",
];

const BORINGSSL_ALERT_80 =
  "1090560:error:10000438:SSL routines:OPENSSL_internal:TLSV1_ALERT_INTERNAL_ERROR:..\\..\\third_party\\boringssl\\src\\ssl\\tls_record.cc:486:SSL alert number 80\n";

/** A Node-shaped system error: what `net`/`tls`/`dns` throw. */
function systemError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

function tlsAlert80(message = BORINGSSL_ALERT_80): Error {
  return systemError(message, {
    code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
    library: "SSL routines",
    reason: "TLSV1_ALERT_INTERNAL_ERROR",
  });
}

/** How the driver wraps a socket-level failure for one server. */
function networkError(cause: Error): MongoNetworkError {
  return new MongoNetworkError(cause.message, { cause });
}

/** A selection error over `hosts`, each server carrying `errorFor(host)`. */
function selectionError(hosts: string[], errorFor: (host: string) => Error | undefined): MongoServerSelectionError {
  const servers = new Map(
    hosts.map((host) => {
      const error = errorFor(host);
      return [host, new ServerDescription(host, undefined, error ? { error } : {})];
    }),
  );
  const topology = new TopologyDescription("ReplicaSetNoPrimary", servers);
  return new MongoServerSelectionError("Server selection timed out after 10000 ms", topology);
}

describe("classifyMongoConnectionError: the issue's case", () => {
  it("reads an Atlas TLS alert 80 as an IP Access List rejection", () => {
    const err = selectionError(ATLAS_HOSTS, () => networkError(tlsAlert80()));
    // The driver copies the TLS text into its own message — the raw string
    // the popover used to show.
    expect(err.message).toContain("SSL alert number 80");
    const c = classifyMongoConnectionError(err);
    expect(c.kind).toBe("ip-not-allowed");
    expect(c.atlas).toBe(true);
    expect(c.signal).toBe("ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR");
    // Whitespace collapsed (the real message ends in a newline).
    expect(c.detail).toContain("SSL alert number 80");
    expect(c.detail.endsWith("\n")).toBe(false);
  });

  it("matches the OpenSSL wording too — the code is the signal, not the text", () => {
    const err = selectionError(ATLAS_HOSTS, () =>
      networkError(tlsAlert80("C0A7B6F3:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error")),
    );
    expect(classifyMongoConnectionError(err).kind).toBe("ip-not-allowed");
  });

  it("calls the same alert a plain TLS failure when the target isn't Atlas", () => {
    const err = selectionError(["db.example.com:27017"], () => networkError(tlsAlert80()));
    const c = classifyMongoConnectionError(err);
    expect(c.kind).toBe("tls");
    expect(c.atlas).toBe(false);
  });

  it("doesn't give the public-IP advice for an Atlas private endpoint", () => {
    const err = selectionError(
      ["pl-0-us-east-1.abcde.mongodb.net:1024", "pl-0-us-east-1.abcde.mongodb.net:1025"],
      () => networkError(tlsAlert80()),
    );
    expect(classifyMongoConnectionError(err)).toMatchObject({ kind: "tls", atlas: false });
  });

  it("prefers the alert over a plainer failure on another server", () => {
    const err = selectionError(ATLAS_HOSTS, (host) =>
      host === ATLAS_HOSTS[0]
        ? networkError(systemError("read ECONNRESET", { code: "ECONNRESET", syscall: "read" }))
        : networkError(tlsAlert80()),
    );
    expect(classifyMongoConnectionError(err).kind).toBe("ip-not-allowed");
  });
});

describe("classifyMongoConnectionError: through Mongoose", () => {
  function assimilated(inner: MongoServerSelectionError): Error {
    const mg = new MongooseServerSelectionError();
    return mg.assimilateError(inner);
  }

  it("reads the per-server errors under Mongoose's whitelist rewrite", () => {
    const mg = assimilated(selectionError(ATLAS_HOSTS, () => networkError(tlsAlert80())));
    // Mongoose replaces the message for any all-unknown Atlas topology …
    expect(mg.message).toMatch(/isn't whitelisted/);
    expect(classifyMongoConnectionError(mg).kind).toBe("ip-not-allowed");
  });

  it("does NOT treat Mongoose's whitelist sentence as evidence: a DNS failure stays DNS", () => {
    const mg = assimilated(
      selectionError(ATLAS_HOSTS, () =>
        networkError(
          systemError("getaddrinfo ENOTFOUND cluster0-shard-00-00.abcde.mongodb.net", {
            code: "ENOTFOUND",
            syscall: "getaddrinfo",
          }),
        ),
      ),
    );
    expect(mg.message).toMatch(/isn't whitelisted/);
    expect(classifyMongoConnectionError(mg)).toMatchObject({ kind: "dns", atlas: true });
  });

  it("calls an Atlas topology with no server errors unreachable, not an IP rejection", () => {
    const mg = assimilated(selectionError(ATLAS_HOSTS, () => undefined));
    expect(mg.message).toMatch(/isn't whitelisted/);
    expect(classifyMongoConnectionError(mg)).toMatchObject({ kind: "unreachable", atlas: true });
  });
});

describe("classifyMongoConnectionError: other kinds", () => {
  it("credentials: code 18 and Atlas's 'bad auth'", () => {
    const code18 = new MongoServerError({ errmsg: "Authentication failed.", code: 18 });
    expect(classifyMongoConnectionError(code18).kind).toBe("auth-failed");
    const atlas8000 = new MongoServerError({ errmsg: "bad auth : authentication failed", code: 8000 });
    expect(classifyMongoConnectionError(atlas8000).kind).toBe("auth-failed");
  });

  it("permissions: code 13 and Atlas's 8000 'not allowed to do action'", () => {
    const code13 = new MongoServerError({ errmsg: "not authorized on db", code: 13 });
    expect(classifyMongoConnectionError(code13).kind).toBe("unauthorized");
    const atlas8000 = new MongoServerError({
      errmsg: "user is not allowed to do action [insert] on [db.filaments]",
      code: 8000,
    });
    expect(classifyMongoConnectionError(atlas8000).kind).toBe("unauthorized");
  });

  it("an 8000 that matches neither stays unknown", () => {
    const other = new MongoServerError({ errmsg: "space quota exceeded", code: 8000 });
    expect(classifyMongoConnectionError(other).kind).toBe("unknown");
  });

  it("SRV lookup failures are DNS whatever the resolver code, and name an Atlas host", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ETIMEOUT"]) {
      // The driver throws Node's plain Error for these, not a Mongo* class.
      const err = systemError(`querySrv ${code} _mongodb._tcp.cluster0.abcde.mongodb.net`, {
        code,
        syscall: "querySrv",
        hostname: "_mongodb._tcp.cluster0.abcde.mongodb.net",
      });
      expect(classifyMongoConnectionError(err)).toMatchObject({ kind: "dns", atlas: true });
    }
  });

  it("a non-Atlas SRV host is DNS but not Atlas", () => {
    const err = systemError("queryTxt ENODATA _mongodb._tcp.db.example.com", {
      code: "ENODATA",
      syscall: "queryTxt",
      hostname: "db.example.com",
    });
    expect(classifyMongoConnectionError(err)).toMatchObject({ kind: "dns", atlas: false });
  });

  it("certificate problems are TLS", () => {
    for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      const err = selectionError(["db.example.com:27017"], () => networkError(systemError("cert", { code })));
      expect(classifyMongoConnectionError(err).kind).toBe("tls");
    }
  });

  it("refused, reset and timed-out sockets are unreachable", () => {
    const refused = selectionError(["127.0.0.1:27017"], () =>
      networkError(systemError("connect ECONNREFUSED 127.0.0.1:27017", { code: "ECONNREFUSED", syscall: "connect" })),
    );
    expect(classifyMongoConnectionError(refused)).toMatchObject({ kind: "unreachable", atlas: false });
    const timeout = new MongoNetworkTimeoutError("connection 1 to db.example.com:27017 timed out");
    expect(classifyMongoConnectionError(timeout).kind).toBe("unreachable");
  });

  it("a bare selection timeout is unreachable, and its message is the detail", () => {
    const err = selectionError(["db.example.com:27017"], () => undefined);
    const c = classifyMongoConnectionError(err);
    expect(c.kind).toBe("unreachable");
    expect(c.detail).toBe("Server selection timed out after 10000 ms");
    expect(c.signal).toBe("MongoServerSelectionError");
  });

  it("a parse failure is an invalid URI", () => {
    const err = new MongoParseError("Invalid scheme, expected connection string to start with \"mongodb://\" or \"mongodb+srv://\"");
    const c = classifyMongoConnectionError(err);
    expect(c.kind).toBe("invalid-uri");
    // The redaction leaves the driver's own scheme wording readable.
    expect(c.detail).toContain('"mongodb://" or "mongodb+srv://"');
  });

  it("anything else is unknown", () => {
    expect(classifyMongoConnectionError(new Error("boom")).kind).toBe("unknown");
    expect(classifyMongoConnectionError("not an error").kind).toBe("unknown");
    expect(classifyMongoConnectionError(null)).toMatchObject({ kind: "unknown", detail: "", signal: null });
  });
});

describe("classifyMongoConnectionError: the GH #1154 data-proof rule", () => {
  // The rename-staging wrapper quotes user-typed names in a code-less
  // message. Stored data must never be able to steer the classification.
  it.each(["SSL alert number 80", "ECONNREFUSED", "querySrv ENOTFOUND x.mongodb.net", "bad auth"])(
    "a stranding notice naming %j over an E11000 stays unknown",
    (name) => {
      const e11000 = new MongoServerError({ errmsg: `E11000 duplicate key error dup key: { name: "${name}" }`, code: 11000 });
      const wrapped = withStrandingNotice(
        e11000,
        strandedPlaceholderNotice({
          collection: "bedtypes",
          id: "64b000000000000000000001",
          originalName: name,
          placeholderName: name,
        }),
      );
      expect(wrapped.message).toContain(name);
      expect(classifyMongoConnectionError(wrapped).kind).toBe("unknown");
    },
  );

  it("a coded server error whose message echoes a trigger stays unknown", () => {
    const err = new MongoServerError({ errmsg: 'E11000 dup key: { name: "TLSV1_ALERT_INTERNAL_ERROR SSL alert number 80" }', code: 11000 });
    expect(classifyMongoConnectionError(err, { uri: "mongodb+srv://u:p@cluster0.abcde.mongodb.net/db" }).kind).toBe("unknown");
  });

  it("a selection timeout where the servers ANSWERED isn't 'unreachable' (no primary)", () => {
    const servers = new Map(
      ATLAS_HOSTS.slice(0, 2).map((host) => [
        host,
        new ServerDescription(host, { ok: 1, setName: "rs0", secondary: true, hosts: ATLAS_HOSTS }),
      ]),
    );
    const err = new MongoServerSelectionError(
      "Server selection timed out after 10000 ms",
      new TopologyDescription("ReplicaSetNoPrimary", servers),
    );
    // An election, not a firewall or an access list.
    expect(classifyMongoConnectionError(err)).toMatchObject({ kind: "unknown", atlas: true });
  });

  it("an uninitiated replica set (RSGhost) isn't 'unreachable' either", () => {
    const host = "127.0.0.1:27017";
    const servers = new Map([[host, new ServerDescription(host, { ok: 1, isreplicaset: true })]]);
    const err = new MongoServerSelectionError("timed out", new TopologyDescription("ReplicaSetNoPrimary", servers));
    expect(classifyMongoConnectionError(err).kind).toBe("unknown");
  });

  it("a server that answered with another code beats the bare wrapper class", () => {
    const err = selectionError(["db.example.com:27017"], () =>
      new MongoServerError({ errmsg: "handshake rejected", code: 211 }) as unknown as Error,
    );
    expect(classifyMongoConnectionError(err).kind).toBe("unknown");
  });
});

describe("classifyMongoConnectionError: shape robustness", () => {
  it("survives a cause cycle", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(classifyMongoConnectionError(a).kind).toBe("unknown");
  });

  it("stops at the depth bound", () => {
    let err: Error = tlsAlert80();
    for (let i = 0; i < 20; i++) err = new Error(`wrap ${i}`, { cause: err });
    expect(classifyMongoConnectionError(err).kind).toBe("unknown");
  });

  it("reads servers held as a plain object or an array", () => {
    const asObject = { message: "x", reason: { servers: { a: { address: ATLAS_HOSTS[0], error: tlsAlert80() } } } };
    expect(classifyMongoConnectionError(asObject).kind).toBe("ip-not-allowed");
    const asArray = { message: "x", reason: { servers: [{ address: ATLAS_HOSTS[0], error: tlsAlert80() }, "junk"] } };
    expect(classifyMongoConnectionError(asArray).kind).toBe("ip-not-allowed");
  });

  it("ignores a servers field that is neither a map nor a list", () => {
    expect(classifyMongoConnectionError({ message: "x", reason: { servers: 3 } }).kind).toBe("unknown");
  });

  it("falls back to the URI when there are no server addresses", () => {
    const refused = systemError("connect ECONNREFUSED", { code: "ECONNREFUSED" });
    expect(
      classifyMongoConnectionError(refused, { uri: "mongodb+srv://u:p@cluster0.abcde.mongodb.net/db" }).atlas,
    ).toBe(true);
    expect(classifyMongoConnectionError(refused).atlas).toBe(false);
  });

  it("caps a very long detail", () => {
    const c = classifyMongoConnectionError(new Error("x".repeat(1000)));
    expect(c.detail.length).toBe(400);
    expect(c.detail.endsWith("…")).toBe(true);
  });

  it("redacts a connection string out of the detail", () => {
    const c = classifyMongoConnectionError(new Error("failed for mongodb+srv://user:hunter2@cluster0.abcde.mongodb.net/db today"));
    expect(c.detail).toBe("failed for mongodb://*** today");
  });

  it("uses the outermost message when the deciding node has none", () => {
    const err = { message: "outer failure", cause: { code: "ECONNREFUSED" } };
    expect(classifyMongoConnectionError(err)).toMatchObject({ kind: "unreachable", detail: "outer failure", signal: "ECONNREFUSED" });
  });
});

describe("a real TLS alert 80 over a socket", () => {
  let server: net.Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it("is classified from the genuine driver error, not a reconstruction", async () => {
    // Answer the ClientHello with a TLS alert record: fatal (2), internal_error (80).
    server = net.createServer((socket) => {
      socket.once("data", () => socket.end(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x50])));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const client = new MongoClient(`mongodb://127.0.0.1:${port}/db?tls=true`, {
      serverSelectionTimeoutMS: 1500,
      connectTimeoutMS: 1500,
    });
    let caught: unknown;
    try {
      await client.connect();
    } catch (err) {
      caught = err;
    } finally {
      await client.close().catch(() => {});
    }
    const c = classifyMongoConnectionError(caught);
    expect(c.signal).toBe("ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR");
    // 127.0.0.1 is no Atlas cluster.
    expect(c).toMatchObject({ kind: "tls", atlas: false });

    // The same genuine server error under an Atlas topology is the
    // access-list rejection.
    const real = (caught as MongoServerSelectionError).reason!.servers.values().next().value!.error!;
    const asAtlas = selectionError(ATLAS_HOSTS, () => real);
    expect(classifyMongoConnectionError(asAtlas).kind).toBe("ip-not-allowed");
  }, 15000);
});

describe("isAtlasUri", () => {
  it.each([
    ["mongodb+srv://u:p@cluster0.abcde.mongodb.net/db", true],
    ["mongodb+srv://cluster0.abcde.mongodb.net", true],
    ["mongodb+srv://u:p@ss@cluster0.abcde.mongodb.net/db", true],
    ["  MONGODB+SRV://cluster0.abcde.mongodb.net/?retryWrites=true", true],
    ["mongodb+srv://cluster0-pl-0.abcde.mongodb.net/db", false],
    ["mongodb://a.abcde.mongodb.net:27017,b.abcde.mongodb.net/db", true],
    ["mongodb://a.abcde.mongodb.net:1024/db", false],
    ["mongodb://a.abcde.mongodb.net,db.example.com/db", false],
    ["mongodb://127.0.0.1:27017/db", false],
    ["mongodb://[::1]:27017/db", false],
    ["mongodb://", false],
    ["mongodb+srv://a.mongodb.net,b.mongodb.net/db", false],
    ["http://cluster0.mongodb.net", false],
    ["", false],
  ])("%j → %s", (uri, expected) => {
    expect(isAtlasUri(uri)).toBe(expected);
  });
});

describe("redactMongoUri", () => {
  it("replaces every connection string, any case, keeping the text around it", () => {
    expect(redactMongoUri("a mongodb://u:p@h/db b MONGODB+SRV://x:y@z c")).toBe("a mongodb://*** b mongodb://*** c");
  });

  it("keeps a single quote inside the password redacted", () => {
    expect(redactMongoUri("mongodb://u:pa'ss@h/db")).toBe("mongodb://***");
  });

  it("keeps the quote a driver message wraps the URI in", () => {
    expect(redactMongoUri('uri "mongodb://u:p@h/db" end')).toBe('uri "mongodb://***" end');
  });

  it.each([
    ['Protocol and host list are required in "mongodb://admin:hun"ter2@/filament-db"'],
    ['Protocol and host list are required in "mongodb://alice:hun<ter2@/db"'],
    ['Invalid connection string "mongodb://al>ice:hunter2@db.example.com/db"'],
  ])("redacts a password with an unescaped \" < or > in an echoed URI: %s", (text) => {
    const out = redactMongoUri(text);
    expect(out).not.toMatch(/ter2|hunter2|alice|admin/);
    expect(out.endsWith('"mongodb://***"')).toBe(true);
  });

  it("leaves a bare scheme with nothing after it alone", () => {
    expect(redactMongoUri('expected to start with "mongodb://" or "mongodb+srv://"')).toBe(
      'expected to start with "mongodb://" or "mongodb+srv://"',
    );
    expect(redactMongoUri("scheme mongodb:// then text")).toBe("scheme mongodb:// then text");
  });
});

describe("DbUnavailableError", () => {
  it("carries the kind, the Atlas flag and the cause", () => {
    const cause = new Error("raw");
    const err = new DbUnavailableError({ kind: "dns", atlas: true }, "hint", { cause });
    expect(err).toMatchObject({ name: "DbUnavailableError", kind: "dns", atlas: true, message: "hint", cause });
    expect(isDbUnavailableError(err)).toBe(true);
  });

  it("is recognised by name and a valid kind, not by instanceof", () => {
    const lookalike = Object.assign(new Error("x"), { name: "DbUnavailableError", kind: "tls" });
    expect(isDbUnavailableError(lookalike)).toBe(true);
    const badKind = Object.assign(new Error("x"), { name: "DbUnavailableError", kind: "nope" });
    expect(isDbUnavailableError(badKind)).toBe(false);
    expect(isDbUnavailableError(new Error("x"))).toBe(false);
    expect(isDbUnavailableError({ name: "DbUnavailableError", kind: "tls" })).toBe(false);
  });
});
