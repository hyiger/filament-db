import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { PUT as putFilament } from "@/app/api/filaments/[id]/route";

/**
 * GH #160 regression guard.
 *
 * Mongoose validators (e.g. tdsUrl scheme guard) and pre-update hooks throw
 * plain Errors that the route's catch-all used to swallow as 500 with the
 * detail message tucked under `detail`. That made monitoring noisy (the
 * server is fine — the user's input was bad) and made it impossible for
 * the form renderer to distinguish "your URL is invalid" from "the server
 * is down". The fix routes those errors through `errorResponseFromCaught`,
 * which returns 400 with the validator message in `error`.
 */
describe("PUT /api/filaments/[id] — client-input rejections return 400", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("returns 400 when tdsUrl uses a non-http(s) scheme", async () => {
    const filament = await Filament.create({
      name: "Test PLA",
      vendor: "Generic",
      type: "PLA",
    });

    const req = new NextRequest(`http://localhost/api/filaments/${filament._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tdsUrl: "javascript:alert(1)" }),
    });
    const res = await putFilament(req, { params: Promise.resolve({ id: String(filament._id) }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be a valid http\(s\) URL/i);
    // The 5xx fallback shape (`{error, detail}`) must NOT be used here;
    // monitoring branches on shape and a 400 should look different from a 500.
    expect(body.detail).toBeUndefined();
  });

  it("returns 400 for Mongoose schema validator failures", async () => {
    const filament = await Filament.create({
      name: "Test PLA",
      vendor: "Generic",
      type: "PLA",
    });

    // diameter is a number; a non-numeric string fails Mongoose's CastError
    // path. We want any client-input validation failure to be 4xx, not 5xx.
    const req = new NextRequest(`http://localhost/api/filaments/${filament._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tdsUrl: "ftp://example.com/file.pdf" }),
    });
    const res = await putFilament(req, { params: Promise.resolve({ id: String(filament._id) }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be a valid http\(s\) URL/i);
  });

  it("still returns 200 for a valid tdsUrl update", async () => {
    const filament = await Filament.create({
      name: "Test PLA",
      vendor: "Generic",
      type: "PLA",
    });

    const req = new NextRequest(`http://localhost/api/filaments/${filament._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tdsUrl: "https://example.com/tds.pdf" }),
    });
    const res = await putFilament(req, { params: Promise.resolve({ id: String(filament._id) }) });

    expect(res.status).toBe(200);
  });
});
