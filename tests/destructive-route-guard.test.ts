import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { DELETE as snapshotDelete } from "@/app/api/snapshot/delete/route";
import { POST as filamentsPost } from "@/app/api/filaments/route";
import { POST as nozzlesPost } from "@/app/api/nozzles/route";
import { POST as locationsPost } from "@/app/api/locations/route";
import { POST as sharePost } from "@/app/api/share/route";
import { POST as scanPublishPost } from "@/app/api/scan/publish/route";
import { POST as spoolsImportPost } from "@/app/api/spools/import/route";
import { POST as printHistoryPost } from "@/app/api/print-history/route";

/**
 * GH #252 — trusted-origin guard for destructive admin routes.
 * A cross-origin (CSRF) request must be rejected before any data is
 * touched; same-origin and non-browser requests must still pass.
 */
describe("assertSameOriginRequest", () => {
  function reqWith(headers: Record<string, string>) {
    return new NextRequest("http://localhost:3456/api/snapshot", { headers });
  }

  it("rejects a cross-site browser request", () => {
    expect(assertSameOriginRequest(reqWith({ "sec-fetch-site": "cross-site" }))).not.toBeNull();
  });

  it("rejects a same-site (but not same-origin) browser request", () => {
    expect(assertSameOriginRequest(reqWith({ "sec-fetch-site": "same-site" }))).not.toBeNull();
  });

  it("allows a same-origin browser request", () => {
    expect(assertSameOriginRequest(reqWith({ "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("allows a user-initiated navigation (Sec-Fetch-Site: none)", () => {
    expect(assertSameOriginRequest(reqWith({ "sec-fetch-site": "none" }))).toBeNull();
  });

  it("allows a non-browser client (no fetch-metadata / Origin headers)", () => {
    expect(assertSameOriginRequest(reqWith({}))).toBeNull();
  });

  it("rejects a mismatched Origin header", () => {
    expect(
      assertSameOriginRequest(reqWith({ origin: "http://evil.example", host: "localhost:3456" })),
    ).not.toBeNull();
  });

  it("allows an Origin header that matches the Host", () => {
    expect(
      assertSameOriginRequest(reqWith({ origin: "http://localhost:3456", host: "localhost:3456" })),
    ).toBeNull();
  });

  it("allows an Origin/Host pair differing only by an explicit default port", () => {
    // Codex review: matching raw host[:port] strings false-rejected a
    // legitimate request when one side spelled out the default port.
    expect(
      assertSameOriginRequest(reqWith({ origin: "https://app.example", host: "app.example:443" })),
    ).toBeNull();
    expect(
      assertSameOriginRequest(reqWith({ origin: "https://app.example:443", host: "app.example" })),
    ).toBeNull();
  });

  it("rejects a same-host different-port Origin (CSRF gap with no Sec-Fetch-Site)", () => {
    // Codex review: a hostname-only check would let a page on
    // localhost:8080 POST to the API on localhost:3456 — a real
    // cross-origin request. The port must be part of the comparison.
    expect(
      assertSameOriginRequest(reqWith({ origin: "http://localhost:8080", host: "localhost:3456" })),
    ).not.toBeNull();
  });
});

describe("destructive route — snapshot/delete CSRF guard", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  it("rejects a cross-origin wipe with 403 and leaves the data intact", async () => {
    await Filament.create({ name: "Keep Me", vendor: "T", type: "PLA" });

    const res = await snapshotDelete(
      new NextRequest("http://localhost:3456/api/snapshot/delete", {
        method: "DELETE",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(res.status).toBe(403);

    // The wipe never ran.
    expect(await Filament.countDocuments({})).toBe(1);
  });

  it("allows a same-origin wipe", async () => {
    await Filament.create({ name: "Wipe Me", vendor: "T", type: "PLA" });

    const res = await snapshotDelete(
      new NextRequest("http://localhost:3456/api/snapshot/delete", {
        method: "DELETE",
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await Filament.countDocuments({})).toBe(0);
  });
});

/**
 * GH #360 — the trusted-origin guard is now mandatory on every
 * mutating API route, not just the destructive admin handlers covered
 * above. These cases pin a representative sample (CRUD/import/share/
 * scan/print-history) so a future contributor can't quietly drop the
 * guard from a new route.
 */
describe("mutating routes — cross-origin CSRF rejection", () => {
  function csrfReq(url: string) {
    return new NextRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ ignored: true }),
    });
  }

  function mismatchedOriginReq(url: string) {
    return new NextRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example",
        host: "localhost:3456",
      },
      body: JSON.stringify({ ignored: true }),
    });
  }

  it("filaments POST rejects cross-site", async () => {
    const res = await filamentsPost(csrfReq("http://localhost:3456/api/filaments"));
    expect(res.status).toBe(403);
  });

  it("nozzles POST rejects cross-site", async () => {
    const res = await nozzlesPost(csrfReq("http://localhost:3456/api/nozzles"));
    expect(res.status).toBe(403);
  });

  it("locations POST rejects cross-site", async () => {
    const res = await locationsPost(csrfReq("http://localhost:3456/api/locations"));
    expect(res.status).toBe(403);
  });

  it("share POST rejects cross-site", async () => {
    const res = await sharePost(csrfReq("http://localhost:3456/api/share"));
    expect(res.status).toBe(403);
  });

  it("scan/publish POST rejects cross-site", async () => {
    const res = await scanPublishPost(csrfReq("http://localhost:3456/api/scan/publish"));
    expect(res.status).toBe(403);
  });

  it("spools/import POST rejects cross-site", async () => {
    const res = await spoolsImportPost(csrfReq("http://localhost:3456/api/spools/import"));
    expect(res.status).toBe(403);
  });

  it("print-history POST rejects cross-site", async () => {
    const res = await printHistoryPost(csrfReq("http://localhost:3456/api/print-history"));
    expect(res.status).toBe(403);
  });

  it("filaments POST rejects mismatched Origin header", async () => {
    const res = await filamentsPost(mismatchedOriginReq("http://localhost:3456/api/filaments"));
    expect(res.status).toBe(403);
  });

  it("share POST rejects mismatched Origin header", async () => {
    const res = await sharePost(mismatchedOriginReq("http://localhost:3456/api/share"));
    expect(res.status).toBe(403);
  });
});
