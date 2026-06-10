import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/prusament/import/route";

/**
 * Route-level tests for `POST /api/prusament/import` (GH #622). The
 * scraper lib is covered by tests/prusament.test.ts; this file covers the
 * import handler itself:
 *
 *   - validation of the previously-unchecked spool fields (priceUsd,
 *     nozzle/bed temp ranges, pageUrl) → 400 with a named reason instead
 *     of a ValidationError escaping as a bare 500
 *   - the create happy path (structured fields + spool subdoc land)
 *   - existing-active-name → add-spool fallback
 *   - resurrect-trashed phase (no duplicate active row, tombstone cleared)
 *   - `_purged` tombstones are NOT resurrected (one-way delete signal)
 *   - E11000 create-race recovery (loser resolves as add-spool)
 *
 * Schema re-registration in beforeEach is the same pattern as the other
 * route-level tests (tests/setup.ts wipes mongoose.models between tests).
 */
describe("POST /api/prusament/import", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
    await Filament.syncIndexes();
  });

  function validSpool(overrides: Record<string, unknown> = {}) {
    return {
      spoolId: "1086170252",
      productName: "Prusament PLA Galaxy Black",
      material: "PLA",
      colorName: "Galaxy Black",
      colorHex: "#1A1A2E",
      diameter: 1.75,
      diameterAvg: 1.749,
      diameterStdDev: 0.009,
      ovality: 0.02,
      netWeight: 970,
      spoolWeight: 201,
      totalWeight: 1171,
      lengthMeters: 325.9,
      nozzleTempMin: 205,
      nozzleTempMax: 225,
      bedTempMin: 40,
      bedTempMax: 60,
      manufactureDate: "2024-05-13 06:11",
      country: "CZ",
      goodsId: 1234,
      priceUsd: 29.99,
      priceEur: 27.99,
      photoUrl: "https://prusament.com/photo.jpg",
      pageUrl: "https://prusament.com/spool/1086170252",
      ...overrides,
    };
  }

  function postReq(body: unknown) {
    return new NextRequest("http://localhost/api/prusament/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("spool field validation (GH #622)", () => {
    it("rejects a negative priceUsd with 400", async () => {
      const res = await POST(postReq({ spool: validSpool({ priceUsd: -5 }), action: "create" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/priceUsd/);
      expect(await Filament.countDocuments({})).toBe(0);
    });

    it("accepts a null priceUsd (scraper sends number | null)", async () => {
      const res = await POST(postReq({ spool: validSpool({ priceUsd: null }), action: "create" }));
      expect(res.status).toBe(201);
      const stored = await Filament.findOne({ name: "Prusament PLA Galaxy Black" });
      expect(stored.cost).toBeNull();
    });

    it("rejects a non-http(s) pageUrl with 400", async () => {
      const res = await POST(
        postReq({ spool: validSpool({ pageUrl: "javascript:alert(1)" }), action: "create" }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/pageUrl/);
      expect(await Filament.countDocuments({})).toBe(0);
    });

    it("rejects an out-of-range nozzleTempMax with 400 (schema max is 600)", async () => {
      const res = await POST(
        postReq({ spool: validSpool({ nozzleTempMax: 9999 }), action: "create" }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/nozzleTempMax/);
    });

    it("rejects an out-of-range bedTempMax with 400 (schema max is 300)", async () => {
      const res = await POST(
        postReq({ spool: validSpool({ bedTempMax: 301 }), action: "create" }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/bedTempMax/);
    });

    it("rejects a non-numeric nozzleTempMin with 400", async () => {
      const res = await POST(
        postReq({ spool: validSpool({ nozzleTempMin: "hot" }), action: "create" }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/nozzleTempMin/);
    });
  });

  describe("create flow", () => {
    it("creates a filament with structured fields and the Prusament spool subdoc", async () => {
      const res = await POST(postReq({ spool: validSpool(), action: "create" }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.action).toBe("create");

      const stored = await Filament.findOne({ name: "Prusament PLA Galaxy Black" });
      expect(stored).toBeTruthy();
      expect(stored.vendor).toBe("Prusa Research");
      expect(stored.cost).toBe(29.99);
      expect(stored.temperatures.nozzle).toBe(225);
      expect(stored.temperatures.bed).toBe(60);
      expect(stored.tdsUrl).toBe("https://prusament.com/spool/1086170252");
      expect(stored.spools).toHaveLength(1);
      expect(stored.spools[0].lotNumber).toBe("1086170252");
      expect(stored.spools[0].totalWeight).toBe(1171);
    });

    it("falls back to add-spool when an active filament already owns the name", async () => {
      await Filament.create({
        name: "Prusament PLA Galaxy Black",
        vendor: "Prusa Research",
        type: "PLA",
      });

      const res = await POST(postReq({ spool: validSpool(), action: "create" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe("add-spool");
      expect(body.message).toMatch(/already exists/);

      const rows = await Filament.find({ name: "Prusament PLA Galaxy Black" });
      expect(rows).toHaveLength(1);
      expect(rows[0].spools).toHaveLength(1);
    });
  });

  describe("trashed-row resurrect phase (GH #622)", () => {
    it("resurrects a soft-deleted filament instead of creating a duplicate", async () => {
      const trashed = await Filament.create({
        name: "Prusament PLA Galaxy Black",
        vendor: "Prusa Research",
        type: "PLA",
      });
      await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });

      const res = await POST(postReq({ spool: validSpool(), action: "create" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe("add-spool");
      expect(body.message).toMatch(/Restored/);

      const rows = await Filament.find({ name: "Prusament PLA Galaxy Black" });
      expect(rows).toHaveLength(1);
      expect(rows[0]._deletedAt).toBeNull();
      expect(rows[0].spools).toHaveLength(1);
      expect(rows[0].spools[0].lotNumber).toBe("1086170252");
    });

    it("does NOT resurrect a _purged tombstone — creates a fresh active row", async () => {
      const purged = await Filament.create({
        name: "Prusament PLA Galaxy Black",
        vendor: "Prusa Research",
        type: "PLA",
      });
      await Filament.updateOne(
        { _id: purged._id },
        { $set: { _deletedAt: new Date(), _purged: true } },
      );

      const res = await POST(postReq({ spool: validSpool(), action: "create" }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.action).toBe("create");

      const tombstone = await Filament.findById(purged._id);
      expect(tombstone._purged).toBe(true);
      expect(tombstone._deletedAt).not.toBeNull();
      const active = await Filament.find({
        name: "Prusament PLA Galaxy Black",
        _deletedAt: null,
      });
      expect(active).toHaveLength(1);
    });
  });

  describe("E11000 create-race recovery (GH #622)", () => {
    it("resolves a duplicate-key create race as add-spool against the winner", async () => {
      // The route holds the same module-level model object this test
      // imports, so spying on `create` intercepts the route's call.
      const FilamentModel = (await import("@/models/Filament")).default;
      const spy = vi
        .spyOn(FilamentModel, "create")
        .mockImplementationOnce((async () => {
          // Simulate a concurrent import winning the race: the row
          // appears in the collection and our create throws E11000.
          await FilamentModel.collection.insertOne({
            name: "Prusament PLA Galaxy Black",
            vendor: "Prusa Research",
            type: "PLA",
            spools: [],
            _deletedAt: null,
          });
          const err = new Error(
            "E11000 duplicate key error collection: filaments index: name_1",
          ) as Error & { code?: number };
          err.code = 11000;
          throw err;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any);

      try {
        const res = await POST(postReq({ spool: validSpool(), action: "create" }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.action).toBe("add-spool");

        const rows = await Filament.find({ name: "Prusament PLA Galaxy Black" });
        expect(rows).toHaveLength(1);
        expect(rows[0].spools).toHaveLength(1);
        expect(rows[0].spools[0].lotNumber).toBe("1086170252");
      } finally {
        spy.mockRestore();
      }
    });

    it("maps an unrecoverable duplicate-key error to 409 (not a bare 500)", async () => {
      const FilamentModel = (await import("@/models/Filament")).default;
      const spy = vi
        .spyOn(FilamentModel, "create")
        .mockImplementationOnce((async () => {
          // E11000 but no active row to recover against (winner already
          // deleted) — the route must surface 409, not crash.
          const err = new Error(
            "E11000 duplicate key error collection: filaments index: name_1",
          ) as Error & { code?: number; keyValue?: Record<string, unknown> };
          err.code = 11000;
          err.keyValue = { name: "Prusament PLA Galaxy Black" };
          throw err;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any);

      try {
        const res = await POST(postReq({ spool: validSpool(), action: "create" }));
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error).toMatch(/already exists/);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
