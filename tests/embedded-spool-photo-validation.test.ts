import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import { POST as importAtlas } from "@/app/api/filaments/import-atlas/route";

// GH #626: import-atlas validates the caller-supplied URI with
// assertSafeMongoUri({ requireSrv: true, blockPrivateHosts: true }), which
// would reject the in-memory mongod's plain mongodb://127.0.0.1 URI. The
// guard has its own dedicated suite (tests/mongoUriGuard.test.ts); here we
// bypass it so the route can talk to the memory server as if it were a
// remote Atlas instance.
vi.mock("@/lib/mongoUriGuard", () => ({
  assertSafeMongoUri: vi.fn(async () => {}),
}));

/**
 * GH #626 — spool `photoDataUrl` MIME/size validation was bypassed by the
 * two write paths that persist embedded spools without running
 * validateSpoolBody:
 *
 *   - POST /api/filaments (the #431 allowlist kept the field but didn't
 *     validate its content) → now rejects with 400.
 *   - POST /api/filaments/import-atlas (copies `spools` wholesale from an
 *     attacker-controllable remote DB) → now sanitizes invalid photos to
 *     null (same posture as the route's ref force-emptying — a legacy
 *     oversized photo in the user's own Atlas DB must not abort the
 *     whole import).
 *
 * The rules themselves (raster-only allow-list — SVG rejected because
 * inline <script> can execute in some rendering contexts — plus the 5MB
 * cap) live in validateSpoolPhotoDataUrl (src/lib/validateSpoolBody.ts),
 * shared with the dedicated spool routes.
 */
describe("embedded spool photoDataUrl validation (#626)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Location: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const SVG_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  ).toString("base64")}`;
  const OVERSIZED_PNG_DATA_URL = `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`;
  const VALID_PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    const locMod = await import("@/models/Location");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    if (!mongoose.models.Location) mongoose.model("Location", locMod.default.schema);
    Filament = mongoose.models.Filament;
    Location = mongoose.models.Location;
  });

  function postReq(url: string, body: unknown) {
    return new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── POST /api/filaments — reject with 400 ───────────────────────────

  describe("POST /api/filaments", () => {
    it("rejects an SVG data URL on an embedded spool with 400", async () => {
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "SVG Photo PLA",
          vendor: "T",
          type: "PLA",
          spools: [{ label: "S1", totalWeight: 1000, photoDataUrl: SVG_DATA_URL }],
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/spools\[0\]/);
      expect(body.error).toMatch(/JPEG\/PNG\/GIF\/WebP\/AVIF\/HEIC\/HEIF/);

      expect(await Filament.countDocuments({ name: "SVG Photo PLA" })).toBe(0);
    });

    it("rejects an oversized (>5MB) photo on an embedded spool with 400", async () => {
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "Oversized Photo PLA",
          vendor: "T",
          type: "PLA",
          spools: [
            { label: "S1", totalWeight: 1000 },
            { label: "S2", totalWeight: 1000, photoDataUrl: OVERSIZED_PNG_DATA_URL },
          ],
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      // The error names the offending spool, not just "a spool failed".
      expect(body.error).toMatch(/spools\[1\]/);
      expect(body.error).toMatch(/5MB/);
    });

    it("accepts a valid raster photo (and normalises empty string to null)", async () => {
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "Valid Photo PLA",
          vendor: "T",
          type: "PLA",
          spools: [
            { label: "S1", totalWeight: 1000, photoDataUrl: VALID_PNG_DATA_URL },
            { label: "S2", totalWeight: 500, photoDataUrl: "" },
          ],
        }),
      );
      expect(res.status).toBe(201);

      const fresh = await Filament.findOne({ name: "Valid Photo PLA" });
      expect(fresh.spools[0].photoDataUrl).toBe(VALID_PNG_DATA_URL);
      expect(fresh.spools[1].photoDataUrl).toBeNull();
    });

    // GH #953 finding 3: the dedicated spool routes 400 an ISO-shaped-but-
    // impossible date (GH #372); the embedded-spool create path used to pass
    // it through and let Mongoose silently normalise "2025-02-29" → Mar 1.
    it("rejects an impossible ISO date on an embedded spool with 400", async () => {
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "Bad Date PLA",
          vendor: "T",
          type: "PLA",
          spools: [{ label: "S1", totalWeight: 1000, purchaseDate: "2025-02-29" }],
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/spools\[0\]/);
      expect(body.error).toMatch(/purchaseDate/);
      expect(await Filament.countDocuments({ name: "Bad Date PLA" })).toBe(0);
    });

    it("rejects a non-ISO openedDate (locale string) on an embedded spool with 400", async () => {
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "Locale Date PLA",
          vendor: "T",
          type: "PLA",
          spools: [{ totalWeight: 1000, openedDate: "1/15/2025" }],
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/openedDate/);
      expect(await Filament.countDocuments({ name: "Locale Date PLA" })).toBe(0);
    });

    // GH #953 finding 2: a dangling locationId (references a deleted or
    // never-existent Location) must be refused — it otherwise produces a
    // phantom "no location" group in every location-grouped view.
    it("rejects an embedded spool locationId that references no active Location with 400", async () => {
      const ghostId = new mongoose.Types.ObjectId();
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "Dangling Loc PLA",
          vendor: "T",
          type: "PLA",
          spools: [{ totalWeight: 1000, locationId: String(ghostId) }],
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/location/i);
      expect(await Filament.countDocuments({ name: "Dangling Loc PLA" })).toBe(0);
    });

    it("rejects an embedded spool locationId that isn't an ObjectId with 400", async () => {
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "Garbage Loc PLA",
          vendor: "T",
          type: "PLA",
          spools: [{ totalWeight: 1000, locationId: "not-an-objectid" }],
        }),
      );
      expect(res.status).toBe(400);
      expect(await Filament.countDocuments({ name: "Garbage Loc PLA" })).toBe(0);
    });

    it("accepts an embedded spool locationId that references an active Location", async () => {
      const loc = await Location.create({ name: "Shelf 953" });
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "Good Loc PLA",
          vendor: "T",
          type: "PLA",
          spools: [{ totalWeight: 1000, locationId: String(loc._id) }],
        }),
      );
      expect(res.status).toBe(201);
      const fresh = await Filament.findOne({ name: "Good Loc PLA" });
      expect(String(fresh.spools[0].locationId)).toBe(String(loc._id));
    });

    // GH #953 finding 1: the schema `maxlength` backstops the embedded-create
    // path (Filament.create runs subdoc validation → ValidationError → 400).
    it("rejects an over-long embedded spool label with 400", async () => {
      const res = await createFilament(
        postReq("http://localhost/api/filaments", {
          name: "Long Label PLA",
          vendor: "T",
          type: "PLA",
          spools: [{ label: "x".repeat(5000), totalWeight: 1000 }],
        }),
      );
      expect(res.status).toBe(400);
      expect(await Filament.countDocuments({ name: "Long Label PLA" })).toBe(0);
    });
  });

  // ── POST /api/filaments/import-atlas — sanitize to null ─────────────

  describe("POST /api/filaments/import-atlas", () => {
    const REMOTE_DB = "atlas-remote-626";

    function remoteUri() {
      // setup.ts stores the memory server's URI in MONGODB_URI; repoint
      // the path at a separate db so it plays the part of the remote
      // Atlas instance.
      const parsed = new URL(
        (process.env.MONGODB_URI as string).replace("mongodb://", "http://"),
      );
      return `mongodb://${parsed.host}/${REMOTE_DB}`;
    }

    function remoteCollection() {
      return mongoose.connection.getClient().db(REMOTE_DB).collection("filaments");
    }

    afterEach(async () => {
      await remoteCollection().drop().catch(() => {});
    });

    it("sanitizes SVG and oversized spool photos from the remote document to null", async () => {
      const remoteId = new mongoose.Types.ObjectId();
      await remoteCollection().insertOne({
        _id: remoteId,
        name: "Remote Hostile PLA",
        vendor: "RemoteCo",
        type: "PLA",
        _deletedAt: null,
        spools: [
          { label: "SVG spool", totalWeight: 800, photoDataUrl: SVG_DATA_URL },
          { label: "Huge spool", totalWeight: 900, photoDataUrl: OVERSIZED_PNG_DATA_URL },
          { label: "Good spool", totalWeight: 1000, photoDataUrl: VALID_PNG_DATA_URL },
        ],
      });

      const res = await importAtlas(
        postReq("http://localhost/api/filaments/import-atlas", {
          uri: remoteUri(),
          filamentIds: [String(remoteId)],
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(1);

      const imported = await Filament.findOne({ name: "Remote Hostile PLA" });
      expect(imported).not.toBeNull();
      expect(imported.spools).toHaveLength(3);
      // Invalid photos are dropped, not persisted...
      expect(imported.spools[0].photoDataUrl).toBeNull();
      expect(imported.spools[1].photoDataUrl).toBeNull();
      // ...while a valid raster photo survives the import.
      expect(imported.spools[2].photoDataUrl).toBe(VALID_PNG_DATA_URL);
    });

    it("sanitizes invalid photos on the update path of an existing filament too", async () => {
      await Filament.create({ name: "Existing PLA", vendor: "Local", type: "PLA" });

      const remoteId = new mongoose.Types.ObjectId();
      await remoteCollection().insertOne({
        _id: remoteId,
        name: "Existing PLA",
        vendor: "RemoteCo",
        type: "PLA",
        _deletedAt: null,
        spools: [{ label: "SVG spool", totalWeight: 800, photoDataUrl: SVG_DATA_URL }],
      });

      const res = await importAtlas(
        postReq("http://localhost/api/filaments/import-atlas", {
          uri: remoteUri(),
          filamentIds: [String(remoteId)],
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);

      const fresh = await Filament.findOne({ name: "Existing PLA" });
      expect(fresh.spools).toHaveLength(1);
      expect(fresh.spools[0].photoDataUrl).toBeNull();
    });

    // GH #732: the spool instanceId is a persisted identity. A remote
    // (attacker-controllable) document must not be able to plant a spoofed or
    // duplicate spool id — it is regenerated locally, mirroring how the
    // top-level instanceId is excluded from the import allow-list.
    it("regenerates spool instanceId from the remote document (no identity spoofing)", async () => {
      const remoteId = new mongoose.Types.ObjectId();
      await remoteCollection().insertOne({
        _id: remoteId,
        name: "Remote Spoofed PLA",
        vendor: "RemoteCo",
        type: "PLA",
        _deletedAt: null,
        instanceId: "REMOTE-FIL", // top-level — dropped by the field allow-list
        spools: [
          { label: "Spoofed", totalWeight: 800, instanceId: "SPOOFED-ID" },
        ],
      });

      const res = await importAtlas(
        postReq("http://localhost/api/filaments/import-atlas", {
          uri: remoteUri(),
          filamentIds: [String(remoteId)],
        }),
      );
      expect(res.status).toBe(200);

      const imported = await Filament.findOne({ name: "Remote Spoofed PLA" });
      expect(imported.spools).toHaveLength(1);
      // The remote spool id was NOT persisted verbatim — a fresh local id.
      expect(imported.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
      expect(imported.spools[0].instanceId).not.toBe("SPOOFED-ID");
      // And the top-level filament instanceId isn't the remote's either.
      expect(imported.instanceId).not.toBe("REMOTE-FIL");
    });

    // GH #732: a routine re-import (update path) must NOT rotate the durable
    // local spool id — otherwise it would orphan any label/NFC/match that
    // stored the prior value. The local id is preserved by position; the
    // remote's id is still never trusted.
    it("preserves the local spool instanceId across a re-import (update path)", async () => {
      const remoteId = new mongoose.Types.ObjectId();
      await remoteCollection().insertOne({
        _id: remoteId,
        name: "Reimport PLA",
        vendor: "RemoteCo",
        type: "PLA",
        _deletedAt: null,
        spools: [{ label: "S1", totalWeight: 1000, instanceId: "REMOTE-ID-1" }],
      });

      // First import → create. The spool gets a fresh local id (not the remote's).
      await importAtlas(
        postReq("http://localhost/api/filaments/import-atlas", {
          uri: remoteUri(),
          filamentIds: [String(remoteId)],
        }),
      );
      let local = await Filament.findOne({ name: "Reimport PLA" });
      const firstId = local.spools[0].instanceId;
      expect(firstId).toMatch(/^[0-9a-f]{10}$/);
      expect(firstId).not.toBe("REMOTE-ID-1");

      // Re-import the SAME remote → update path. The local id must be preserved.
      await importAtlas(
        postReq("http://localhost/api/filaments/import-atlas", {
          uri: remoteUri(),
          filamentIds: [String(remoteId)],
        }),
      );
      local = await Filament.findOne({ name: "Reimport PLA" });
      expect(local.spools).toHaveLength(1);
      expect(local.spools[0].instanceId).toBe(firstId); // not rotated
      expect(local.spools[0].instanceId).not.toBe("REMOTE-ID-1");
    });
  });
});
