import { describe, it, expect, vi, afterEach } from "vitest";
import { describeLoadFailure } from "@/lib/loadFailure";

/**
 * GH #1231: how a page learns why its data request failed. A 503 body
 * answers directly; anything else asks /api/health.
 */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DB_DOWN = { error: "Database unavailable", code: "db_unavailable", kind: "ip-not-allowed", atlas: true };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeLoadFailure", () => {
  it("uses the failed response's own db_unavailable body without probing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const failure = await describeLoadFailure(json(503, DB_DOWN));
    expect(failure).toEqual({ db: { kind: "ip-not-allowed", atlas: true } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks /api/health when the response is a generic 500", async () => {
    const fetchSpy = vi.fn(async () => json(503, { ...DB_DOWN, kind: "dns", atlas: false }));
    vi.stubGlobal("fetch", fetchSpy);
    const signal = new AbortController().signal;
    const failure = await describeLoadFailure(json(500, { error: "Failed to fetch nozzles" }), signal);
    expect(failure).toEqual({ db: { kind: "dns", atlas: false } });
    expect(fetchSpy).toHaveBeenCalledWith("/api/health", { signal, cache: "no-store" });
  });

  it("asks /api/health when the request threw (no response at all)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(503, DB_DOWN)));
    expect(await describeLoadFailure(null)).toEqual({ db: { kind: "ip-not-allowed", atlas: true } });
  });

  it("has nothing to add when the database is fine", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { ok: true })));
    expect(await describeLoadFailure(json(500, {}))).toEqual({ db: null });
  });

  it("has nothing to add when health answers with something that isn't ours", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await describeLoadFailure(new Response("not json", { status: 500 }))).toEqual({ db: null });
  });

  it("has nothing to add when the server itself is unreachable (or the load was aborted)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await describeLoadFailure(null)).toEqual({ db: null });
  });
});
