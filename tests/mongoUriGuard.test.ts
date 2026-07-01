import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLookup, mockResolveSrv } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockResolveSrv: vi.fn(),
}));

// Stub DNS so host resolution + SRV lookups are deterministic in CI.
vi.mock("node:dns/promises", () => ({
  lookup: mockLookup,
  resolveSrv: mockResolveSrv,
}));

import { assertSafeMongoUri } from "@/lib/mongoUriGuard";

/**
 * GH #254 — SSRF guard for user-supplied MongoDB connection strings.
 * `import-atlas` / `setup` pass `uri` straight to `MongoClient`; without
 * this guard a request body can drive the server to probe internal hosts.
 */
describe("assertSafeMongoUri", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockResolveSrv.mockReset();
  });

  it("rejects a non-mongodb scheme", async () => {
    await expect(assertSafeMongoUri("http://evil.example/")).rejects.toThrow(/mongodb/i);
    await expect(assertSafeMongoUri("file:///etc/passwd")).rejects.toThrow(/mongodb/i);
    await expect(assertSafeMongoUri("not a uri")).rejects.toThrow(/mongodb/i);
  });

  it("rejects plain mongodb:// when requireSrv is set (import-atlas policy)", async () => {
    await expect(
      assertSafeMongoUri("mongodb://cluster.example.com/db", { requireSrv: true }),
    ).rejects.toThrow(/mongodb\+srv/i);
  });

  it("rejects a literal RFC1918 host without a DNS lookup", async () => {
    await expect(
      assertSafeMongoUri("mongodb://10.0.0.5:27017/db", { blockPrivateHosts: true }),
    ).rejects.toThrow(/private\/internal/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects mongodb://localhost when blocking private hosts", async () => {
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      assertSafeMongoUri("mongodb://localhost:27017/db", { blockPrivateHosts: true }),
    ).rejects.toThrow(/private\/internal/);
  });

  it("checks every host of a multi-host plain URI", async () => {
    mockLookup.mockImplementation((host: string) =>
      host === "bad.example.com"
        ? Promise.resolve([{ address: "192.168.1.1", family: 4 }])
        : Promise.resolve([{ address: "8.8.8.8", family: 4 }]),
    );
    await expect(
      assertSafeMongoUri(
        "mongodb://good.example.com:27017,bad.example.com:27017/db",
        { blockPrivateHosts: true },
      ),
    ).rejects.toThrow(/private\/internal/);
  });

  // ── mongodb+srv: the SRV *targets* are the real connection hosts ──

  it("rejects a mongodb+srv URI whose SRV target resolves to a private address", async () => {
    // GH #332: the seed host can be public while its SRV records point
    // at RFC1918 space — the guard must validate the SRV targets.
    mockResolveSrv.mockResolvedValue([
      { name: "shard0.internal.corp", port: 27017, priority: 0, weight: 0 },
    ]);
    mockLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    await expect(
      assertSafeMongoUri("mongodb+srv://seed.example.com/db", {
        requireSrv: true,
        blockPrivateHosts: true,
      }),
    ).rejects.toThrow(/private\/internal/);
    expect(mockResolveSrv).toHaveBeenCalledWith("_mongodb._tcp.seed.example.com");
  });

  it("rejects a mongodb+srv host with no SRV records", async () => {
    mockResolveSrv.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertSafeMongoUri("mongodb+srv://not-a-cluster.example.com/db", {
        requireSrv: true,
        blockPrivateHosts: true,
      }),
    ).rejects.toThrow(/SRV records/i);
  });

  it("accepts a mongodb+srv host whose SRV targets are all public (Atlas)", async () => {
    mockResolveSrv.mockResolvedValue([
      { name: "shard0.abcd.mongodb.net", port: 27017, priority: 0, weight: 0 },
      { name: "shard1.abcd.mongodb.net", port: 27017, priority: 0, weight: 0 },
    ]);
    mockLookup.mockResolvedValue([{ address: "13.37.13.37", family: 4 }]);
    await expect(
      assertSafeMongoUri(
        "mongodb+srv://user:p%40ss@cluster0.abcd.mongodb.net/filament-db?retryWrites=true",
        { requireSrv: true, blockPrivateHosts: true },
      ),
    ).resolves.toBeUndefined();
  });

  it("only validates the scheme when blockPrivateHosts is false (setup policy)", async () => {
    // setup legitimately targets the app's own DB — localhost / Docker
    // hosts must pass; only the scheme is enforced here.
    await expect(
      assertSafeMongoUri("mongodb://localhost:27017/db", { blockPrivateHosts: false }),
    ).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockResolveSrv).not.toHaveBeenCalled();
  });

  // ── extractHost: bracketed IPv6 host specs ──

  it("strips IPv6 brackets and port before checking a private literal", async () => {
    // `[::1]:27017` → host `::1` (loopback, private) — no DNS lookup for a literal.
    await expect(
      assertSafeMongoUri("mongodb://[::1]:27017/db", { blockPrivateHosts: true }),
    ).rejects.toThrow(/private\/internal/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("accepts a bracketed public IPv6 literal", async () => {
    await expect(
      assertSafeMongoUri("mongodb://[2606:4700:4700::1111]:27017/db", {
        blockPrivateHosts: true,
      }),
    ).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("tolerates a bracketed host missing its closing bracket", async () => {
    // extractHost's `end === -1` fallback: slice off the leading '[' only.
    // `[::1` → `::1` (a colon-bearing literal → treated as an IP, loopback).
    await expect(
      assertSafeMongoUri("mongodb://[::1/db", { blockPrivateHosts: true }),
    ).rejects.toThrow(/private\/internal/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  // ── host resolution + empty-host edge cases ──

  it("rejects a host that does not resolve", async () => {
    mockLookup.mockResolvedValue([]);
    await expect(
      assertSafeMongoUri("mongodb://ghost.example.com:27017/db", {
        blockPrivateHosts: true,
      }),
    ).rejects.toThrow(/does not resolve/i);
  });

  it("rejects a plain URI whose host spec has no host (bare port)", async () => {
    // authority `:27017` → extractHost → "" → the empty-host guard fires.
    await expect(
      assertSafeMongoUri("mongodb://:27017/db", { blockPrivateHosts: true }),
    ).rejects.toThrow(/empty host/i);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects a URI whose authority is only host separators", async () => {
    // `,,` → split/filter leaves zero host specs → the no-host guard fires.
    await expect(
      assertSafeMongoUri("mongodb://,,/db", { blockPrivateHosts: true }),
    ).rejects.toThrow(/no host/i);
  });

  it("rejects a mongodb+srv URI listing more than one host", async () => {
    await expect(
      assertSafeMongoUri("mongodb+srv://a.example.com,b.example.com/db", {
        requireSrv: true,
        blockPrivateHosts: true,
      }),
    ).rejects.toThrow(/exactly one host/i);
    expect(mockResolveSrv).not.toHaveBeenCalled();
  });

  it("rejects a mongodb+srv URI whose seed host is empty (bare port)", async () => {
    // Single host spec `:27017` → seedHost "" → the empty-host guard in the SRV path.
    await expect(
      assertSafeMongoUri("mongodb+srv://:27017/db", {
        requireSrv: true,
        blockPrivateHosts: true,
      }),
    ).rejects.toThrow(/empty host/i);
    expect(mockResolveSrv).not.toHaveBeenCalled();
  });
});
