import { describe, it, expect, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

/**
 * GH #1195 — POST /api/labels/print.
 *
 * This route drives physically-attached hardware and its ONLY perimeter is
 * `assertLocalPrintToken` (assertSameOriginRequest gates nothing for a
 * curl-shaped caller, by design). `src/app/api/**` is outside the coverage
 * gate, so without this file a refactor that reorders the guard past the body
 * read — or drops it — ships green. That is the regression this pins.
 *
 * Every success-path case uses `dryRun: true`. Nothing here may reach a
 * printer.
 */
const TOKEN = "f".repeat(64);
const ENV = "FILAMENTDB_LOCAL_PRINT_TOKEN";

/** `null` means "send no token header" — distinct from "use the default". */
function req(body: unknown, token: string | null): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("x-filamentdb-print-token", token);
  return new NextRequest("http://localhost:3456/api/labels/print", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/labels/print", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Location: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let saved: string | undefined;
  let instanceId: string;
  let locationId: string;

  beforeEach(async () => {
    saved = process.env[ENV];
    process.env[ENV] = TOKEN;

    const filMod = await import("@/models/Filament");
    const locMod = await import("@/models/Location");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Location) mongoose.model("Location", locMod.default.schema);
    Filament = mongoose.models.Filament;
    Location = mongoose.models.Location;

    const loc = await Location.create({ name: "Drybox 01", kind: "drybox" });
    locationId = String(loc._id);

    instanceId = "aabbccdd11";
    const fil = await Filament.create({
      name: "Prusament PLA Galaxy Black",
      vendor: "Prusament",
      type: "PLA",
      spools: [{ totalWeight: 1000, instanceId }],
    });
    // Sanity: the spool must carry the id the route resolves on.
    expect(String(fil.spools[0].instanceId)).toBe(instanceId);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  // NOTE: `token` defaults to a VALID token; pass null to omit the header.
  // An explicit `undefined` would trigger the default — which is exactly the
  // trap that made the first version of the guard-ordering test pass a token
  // it meant to withhold.
  async function post(body: unknown, token: string | null = TOKEN) {
    const { POST } = await import("@/app/api/labels/print/route");
    return POST(req(body, token));
  }

  describe("the guard runs before anything else", () => {
    it("403s a missing token without touching the body", async () => {
      // Body is deliberately unparseable: a 403 proves the guard ran first.
      const res = await post("{not json", null);
      expect(res.status).toBe(403);
    });

    it("403s a wrong token", async () => {
      const res = await post({ instanceId, dryRun: true }, "wrong");
      expect(res.status).toBe(403);
    });

    it("404s when no token is configured on this deployment", async () => {
      delete process.env[ENV];
      const res = await post({ instanceId, dryRun: true });
      expect(res.status).toBe(404);
    });
  });

  describe("body validation", () => {
    it("400s a literal null body rather than throwing a framework 500", async () => {
      // request.json() returns null for `null` WITHOUT throwing.
      const res = await post("null");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/JSON object/i);
    });

    it("400s a non-object body", async () => {
      for (const b of ['"hi"', "7", "[]"]) {
        expect((await post(b)).status).toBe(400);
      }
    });

    it("400s unparseable JSON", async () => {
      expect((await post("{oops")).status).toBe(400);
    });

    it("400s when both subjects are given", async () => {
      const res = await post({ instanceId, locationId, dryRun: true });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/exactly one/i);
    });

    it("400s when neither subject is given", async () => {
      expect((await post({ dryRun: true })).status).toBe(400);
    });

    it("400s when printer is omitted on a real (non-dry) print", async () => {
      const res = await post({ instanceId });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/printer is required/i);
    });

    it("400s a non-boolean dryRun instead of silently printing", async () => {
      // The string "true" would fall through to `=== true` as false and
      // trigger a REAL print. Printing is irreversible, so a malformed value
      // must be refused rather than reinterpreted.
      const res = await post({ instanceId, printer: "FilamentDB_Label", dryRun: "true" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/dryRun must be a boolean/i);
    });

    it("still accepts an omitted dryRun as a real print request", async () => {
      // The strict check must not reject the common case of leaving it out.
      const res = await post({ instanceId });
      // 400 for the MISSING PRINTER, not for dryRun.
      expect((await res.json()).error).toMatch(/printer is required/i);
      expect(res.status).toBe(400);
    });

    it("400s an over-long instanceId rather than handing it to a regex builder", async () => {
      // matchFilament documents that callers must length-bound its inputs; it
      // builds case-insensitive Mongo regexes from them (GH #513).
      const res = await post({ instanceId: "a".repeat(129), dryRun: true });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/128 characters/i);
    });

    it("400s a malformed locationId instead of 500ing on a CastError", async () => {
      const res = await post({ locationId: "not-an-object-id", dryRun: true });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not a valid id/i);
    });

    it("400s an unknown preset and names the valid ones", async () => {
      const res = await post({ instanceId, preset: "nope", dryRun: true });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/vendorOverType/);
    });
  });

  describe("print-target and capability refusals are 4xx/501, not 500", () => {
    it("400s a legacy serial printer setting", async () => {
      const res = await post({ instanceId, printer: "/dev/tty.Brother" });
      expect(res.status).toBe(400);
    });

    it("400s a non-usb URL scheme (GH #623)", async () => {
      const res = await post({ instanceId, printer: "ipp://printer.local/x" });
      expect(res.status).toBe(400);
    });

    it("501s vertical orientation — a capability gap, not a server fault", async () => {
      const res = await post({
        instanceId,
        dryRun: true,
        format: { orientation: "vertical" },
      });
      expect(res.status).toBe(501);
    });
  });

  describe("no caller input escapes as a 5xx (GH #1195 class invariant)", () => {
    // Three review rounds each found another input that surfaced as a 500 or,
    // worse, was silently reinterpreted into a REAL print. Fixing them one at a
    // time kept missing siblings, so this enumerates the whole PrintBody
    // surface and asserts the invariant directly: a malformed value is always
    // a 4xx (or 501 for an unimplemented capability) and never a 5xx, and
    // never a successful print.
    const MALFORMED: Array<[string, Record<string, unknown>]> = [
      ["instanceId wrong type", { instanceId: 42 }],
      ["instanceId over the 128-char bound", { instanceId: "a".repeat(129) }],
      ["locationId not an ObjectId", { locationId: "nope" }],
      ["locationId wrong type", { locationId: 42 }],
      ["printer wrong type", { instanceId: "PLACEHOLDER", printer: 42 }],
      ["printer legacy serial", { instanceId: "PLACEHOLDER", printer: "/dev/tty.X" }],
      ["printer bad scheme", { instanceId: "PLACEHOLDER", printer: "ipp://x/y" }],
      ["preset unknown", { instanceId: "PLACEHOLDER", preset: "nope" }],
      ["preset inherited from Object.prototype", { instanceId: "PLACEHOLDER", preset: "constructor" }],
      ["preset toString", { instanceId: "PLACEHOLDER", preset: "toString" }],
      ["qrMode wrong case", { instanceId: "PLACEHOLDER", qrMode: "URL" }],
      ["qrMode unknown", { instanceId: "PLACEHOLDER", qrMode: "nope" }],
      ["qrMode wrong type", { instanceId: "PLACEHOLDER", qrMode: 1 }],
      ["dryRun string", { instanceId: "PLACEHOLDER", printer: "FilamentDB_Label", dryRun: "true" }],
      ["dryRun number", { instanceId: "PLACEHOLDER", printer: "FilamentDB_Label", dryRun: 1 }],
      ["baseUrl not http(s)", { locationId: "PLACEHOLDER_LOC", baseUrl: "ftp://x/" }],
      ["baseUrl unparseable", { locationId: "PLACEHOLDER_LOC", baseUrl: "::::" }],
      ["format vertical orientation", { instanceId: "PLACEHOLDER", format: { orientation: "vertical" } }],
      ["format empties every line", {
        instanceId: "PLACEHOLDER",
        format: { lines: ["colorName"], qr: { enabled: false, placement: "left" } },
      }],
      ["format wrong type", { instanceId: "PLACEHOLDER", format: "nope" }],
      ["both subjects", { instanceId: "PLACEHOLDER", locationId: "PLACEHOLDER_LOC" }],
      ["neither subject", {}],
    ];

    it.each(MALFORMED)("%s → 4xx/501, never 5xx and never a print", async (_label, patch) => {
      const body: Record<string, unknown> = { dryRun: true, ...patch };
      // Substitute the real ids the table refers to symbolically.
      if (body.instanceId === "PLACEHOLDER") body.instanceId = instanceId;
      if (body.locationId === "PLACEHOLDER_LOC") body.locationId = locationId;
      const res = await post(body);
      // 501 is legitimate for a well-formed request naming a capability the
      // server renderer does not implement; everything else must be 4xx.
      expect(res.status === 501 || res.status < 500).toBe(true);
      // A malformed request must not have produced a label either.
      if (res.status === 200) {
        throw new Error(`malformed input was accepted: ${JSON.stringify(body)}`);
      }
    });
  });

  describe("subject resolution", () => {
    it("404s an instanceId that matches nothing", async () => {
      const res = await post({ instanceId: "0000000000", dryRun: true });
      expect(res.status).toBe(404);
    });

    it("404s a locationId that matches nothing", async () => {
      const res = await post({
        locationId: new mongoose.Types.ObjectId().toString(),
        dryRun: true,
      });
      expect(res.status).toBe(404);
    });

    it("renders vendor over type for a spool, and prints nothing on a dry run", async () => {
      const res = await post({ instanceId, preset: "vendorOverType", dryRun: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.dryRun).toBe(true);
      expect(body.printer).toBeNull();
      expect(body.lines).toEqual(["Prusament", "PLA"]);
      // Default QR mode encodes the bare instanceId, which
      // /api/filaments/match resolves — no reachable host required.
      expect(body.qrPayload).toBe(instanceId);
      expect(body.rasterLines).toBeGreaterThan(0);
    });

    it("forces the name-only layout for a location, which has no vendor or type", async () => {
      const res = await post({
        locationId,
        preset: "vendorOverType",
        baseUrl: "http://macbookpro.local:3456",
        dryRun: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.lines).toEqual(["Drybox 01"]);
      expect(body.qrPayload).toContain(`/inventory?location=${locationId}`);
    });

    it("400s a format that cannot fit the tape, rather than 500ing", async () => {
      // Enough fields x wrapped lines drives fitFontPx to its floor and the
      // composed block past the 128-dot print head. That is the caller asking
      // for more than 24mm holds -- a bad request, not a server fault, and a
      // 500 would tell an automated caller to retry it forever.
      const wordy = "alpha bravo charlie delta echo foxtrot golf hotel india";
      const iid = "beefbeef01";
      await Filament.create({
        name: wordy,
        vendor: wordy,
        type: wordy,
        colorName: wordy,
        spools: [{ totalWeight: 1000, instanceId: iid }],
      });
      const res = await post({
        instanceId: iid,
        dryRun: true,
        format: {
          lines: ["name", "vendor", "type", "vendorType", "colorName"],
          maxLinesPerField: 3,
          font: { family: "sans", size: "l" },
        },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/does not fit|could not be rendered/i);
    });

    it("reduces baseUrl to its origin, so a long path cannot inflate the QR", async () => {
      // The renderer refuses a QR past the tape's dot budget. This pins that a
      // caller cannot reach that refusal through baseUrl: only the origin is
      // used, so the payload length stays bounded by the deep-link shape.
      const res = await post({
        locationId,
        baseUrl: `http://example.com/${"x".repeat(1200)}`,
        dryRun: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.qrPayload).toBe(`http://example.com/inventory?location=${locationId}`);
      expect(body.qrPayload).not.toContain("xxxx");
    });

    it("warns when the QR would point at a loopback host", async () => {
      const res = await post({
        locationId,
        baseUrl: "http://localhost:3456",
        dryRun: true,
      });
      const body = await res.json();
      expect(body.warning).toMatch(/loopback/i);
    });
  });
});
