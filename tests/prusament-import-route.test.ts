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
      // #732: the Prusament spool subdoc carries its own instanceId.
      expect(stored.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
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
      // #732: the existing-name $push fallback spool carries an instanceId.
      expect(rows[0].spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
    });
  });

  describe("add-spool action", () => {
    it("the pushed spool carries a per-spool instanceId (#732)", async () => {
      const existing = await Filament.create({
        name: "Existing Prusament",
        vendor: "Prusa Research",
        type: "PLA",
      });
      const res = await POST(
        postReq({
          spool: validSpool(),
          action: "add-spool",
          filamentId: String(existing._id),
        }),
      );
      expect(res.status).toBe(200);

      const stored = await Filament.findById(existing._id);
      expect(stored.spools).toHaveLength(1);
      expect(stored.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
    });
  });

  describe("template guard (GH #605, codex round 3 Finding B)", () => {
    /** A template: a parent with one live variant. Inventory belongs on
     *  the variants, so every spool-attach path must refuse it. */
    async function seedTemplate(name = "Prusament PLA Galaxy Black") {
      const parent = await Filament.create({
        name,
        vendor: "Prusa Research",
        type: "PLA",
        color: null,
      });
      await Filament.create({
        name: `${name} — Red`,
        vendor: "Prusa Research",
        type: "PLA",
        color: "#FF0000",
        parentId: parent._id,
      });
      return parent;
    }

    it("add-spool onto a template → 400 template_no_spools (same contract as the spools route)", async () => {
      const template = await seedTemplate("Template Target");
      const res = await POST(
        postReq({
          spool: validSpool(),
          action: "add-spool",
          filamentId: String(template._id),
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("template_no_spools");
      expect(body.message).toMatch(/template/i);

      const fresh = await Filament.findById(template._id);
      expect(fresh.spools).toHaveLength(0);
    });

    it("create-flow fallback against an existing TEMPLATE name → 400, template untouched", async () => {
      // The scraped material's derived name collides with a template — the
      // pre-#605 code $push-ed straight onto it by name.
      const template = await seedTemplate();
      const res = await POST(postReq({ spool: validSpool(), action: "create" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("template_no_spools");

      const fresh = await Filament.findById(template._id);
      expect(fresh.spools).toHaveLength(0);
      // And no duplicate active row was minted around the refusal.
      expect(
        await Filament.countDocuments({ name: "Prusament PLA Galaxy Black", _deletedAt: null }),
      ).toBe(1);
    });

    it("a standalone (non-template) still takes the spool through the guard", async () => {
      const standalone = await Filament.create({
        name: "Standalone Prusament",
        vendor: "Prusa Research",
        type: "PLA",
      });
      const res = await POST(
        postReq({
          spool: validSpool(),
          action: "add-spool",
          filamentId: String(standalone._id),
        }),
      );
      expect(res.status).toBe(200);
      const fresh = await Filament.findById(standalone._id);
      expect(fresh.spools).toHaveLength(1);
      expect(fresh.spools[0].lotNumber).toBe("1086170252");
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

    it("recovery against a TEMPLATE winner → 400 template_no_spools, no spool attached", async () => {
      // GH #605 (codex round 3, Finding B): even the E11000 recovery push
      // must not land inventory on a template.
      const FilamentModel = (await import("@/models/Filament")).default;
      const spy = vi
        .spyOn(FilamentModel, "create")
        .mockImplementationOnce((async () => {
          // Raw inserts bypass schema defaults — distinct instanceIds keep
          // the second insert clear of the partial-unique instanceId index
          // (both docs are active, and "missing" collides with "missing").
          const winner = await FilamentModel.collection.insertOne({
            name: "Prusament PLA Galaxy Black",
            vendor: "Prusa Research",
            type: "PLA",
            instanceId: "aaaaaaaa01",
            spools: [],
            _deletedAt: null,
          });
          await FilamentModel.collection.insertOne({
            name: "Prusament PLA Galaxy Black — Red",
            vendor: "Prusa Research",
            type: "PLA",
            instanceId: "aaaaaaaa02",
            parentId: winner.insertedId,
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
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("template_no_spools");

        const winner = await Filament.findOne({
          name: "Prusament PLA Galaxy Black",
          _deletedAt: null,
        });
        expect(winner.spools).toHaveLength(0);
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
