import { describe, it, expect, vi, afterEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import * as mongodb from "@/lib/mongodb";
import { GET as health } from "@/app/api/health/route";
import { GET as listFilaments } from "@/app/api/filaments/route";
import { GET as listNozzles } from "@/app/api/nozzles/route";
import { notConfiguredError } from "@/lib/dbErrorText";
import { DbUnavailableError } from "@/lib/mongoConnectionError";

/**
 * GH #1231: GET /api/health, and the db_unavailable 503 the list routes now
 * return when dbConnect can't reach the database.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const atlasOutage = () =>
  new DbUnavailableError({ kind: "ip-not-allowed", atlas: true }, "Most often the IP Access List.", {
    cause: new Error("TLSV1_ALERT_INTERNAL_ERROR mongodb+srv://u:secret@cluster0.abcde.mongodb.net"),
  });

describe("GET /api/health", () => {
  it("is 200 {ok: true} when a ping round-trips", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("is the db_unavailable 503 when dbConnect can't connect", async () => {
    vi.spyOn(mongodb, "default").mockRejectedValueOnce(atlasOutage());
    const res = await health();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: "db_unavailable", kind: "ip-not-allowed", atlas: true });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("names MONGODB_URI when nothing is configured", async () => {
    vi.spyOn(mongodb, "default").mockRejectedValueOnce(notConfiguredError());
    const body = await (await health()).json();
    expect(body.kind).toBe("not-configured");
    expect(body.hint).toMatch(/MONGODB_URI/);
  });

  it("a dbConnect failure that isn't a connect failure (a migration) is a 500, not 'unavailable'", async () => {
    vi.spyOn(mongodb, "default").mockRejectedValueOnce(new Error("migration lock held"));
    const res = await health();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBeUndefined();
    expect(body).toEqual({ error: "Database check failed", detail: "migration lock held" });
  });

  it("classifies a ping that fails on a live (stale) handle", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = mongoose.connection.db!;
    vi.spyOn(db, "command").mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:27017"), { code: "ECONNREFUSED" }),
    );
    const res = await health();
    expect(res.status).toBe(503);
    expect((await res.json()).kind).toBe("unreachable");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("treats a missing db handle as an unexplained outage", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(mongoose.connection, "db", "get").mockReturnValue(undefined as never);
    const res = await health();
    expect(res.status).toBe(503);
    expect((await res.json()).kind).toBe("unknown");
    expect(logSpy).toHaveBeenCalled();
  });
});

describe("list routes answer the db_unavailable 503", () => {
  it("GET /api/filaments (explicit dbConnect catch)", async () => {
    vi.spyOn(mongodb, "default").mockRejectedValueOnce(atlasOutage());
    const res = await listFilaments(new NextRequest("http://localhost/api/filaments"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "Database unavailable", code: "db_unavailable" });
  });

  it("GET /api/nozzles (bespoke catch)", async () => {
    vi.spyOn(mongodb, "default").mockRejectedValueOnce(atlasOutage());
    const res = await listNozzles(new NextRequest("http://localhost/api/nozzles"));
    expect(res.status).toBe(503);
    expect((await res.json()).kind).toBe("ip-not-allowed");
  });

  it("any other failure keeps the route's own 500", async () => {
    vi.spyOn(mongodb, "default").mockRejectedValueOnce(new Error("boom"));
    const res = await listNozzles(new NextRequest("http://localhost/api/nozzles"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to fetch nozzles", detail: "boom" });
  });
});
