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
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    Filament = mongoose.models.Filament;
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
  });
});
