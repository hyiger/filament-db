import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as logUsage } from "@/app/api/filaments/[id]/spools/[spoolId]/usage/route";
import { POST as logDryCycle } from "@/app/api/filaments/[id]/spools/[spoolId]/dry-cycles/route";

/**
 * Code-review issues #302, #303, #304 — database index correctness and
 * embedded-array growth bounds.
 *
 * (#312 dead-connection check and #282 SharedCatalog size guard are
 * verified by inspection — both are small, self-evident guards whose
 * trigger conditions — a mid-test DB outage, a 12MB payload — are not
 * worth simulating in a unit test.)
 */
describe("DB index correctness + embedded-array bounds", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
    // Build the declared indexes against the in-memory server so the
    // partial-unique constraints are actually enforced in these tests.
    await Filament.syncIndexes();
  });

  // ── #302/#303: instanceId partial-unique index ─────────────────────

  describe("#302 — instanceId is partial-unique on non-deleted docs", () => {
    it("declares instanceId as a partial-unique index, not a plain one", () => {
      // #303: the schema must declare the partial index — otherwise
      // syncIndexes() can't migrate an upgraded DB off the plain one.
      const indexes = Filament.schema.indexes() as [
        Record<string, number>,
        Record<string, unknown>,
      ][];
      const instanceIdIndex = indexes.find((ix) => ix[0].instanceId === 1);
      expect(instanceIdIndex).toBeDefined();
      expect(instanceIdIndex![1].unique).toBe(true);
      expect(instanceIdIndex![1].partialFilterExpression).toEqual({
        _deletedAt: null,
      });
    });

    it("#732 — declares a multikey index on spools.instanceId for the spool-id match path", () => {
      const indexes = Filament.schema.indexes() as [
        Record<string, number>,
        Record<string, unknown>,
      ][];
      const spoolIdIndex = indexes.find((ix) => ix[0]["spools.instanceId"] === 1);
      expect(spoolIdIndex).toBeDefined();
      // Non-unique (spool ids aren't globally unique-enforced) and not scoped
      // to non-deleted, so it stays a plain multikey index.
      expect(spoolIdIndex![1].unique).toBeFalsy();
    });

    it("lets a new filament reuse the instanceId of a soft-deleted one", async () => {
      const a = await Filament.create({
        name: "Original",
        vendor: "V",
        type: "PLA",
        instanceId: "shared-instance-id",
      });
      a._deletedAt = new Date();
      await a.save();

      // A plain unique index would E11000 here against the tombstone.
      const b = await Filament.create({
        name: "Reincarnation",
        vendor: "V",
        type: "PLA",
        instanceId: "shared-instance-id",
      });
      expect(b._id).toBeDefined();
    });

    it("still rejects two ACTIVE filaments sharing an instanceId", async () => {
      await Filament.create({
        name: "First",
        vendor: "V",
        type: "PLA",
        instanceId: "live-instance-id",
      });
      await expect(
        Filament.create({
          name: "Second",
          vendor: "V",
          type: "PLA",
          instanceId: "live-instance-id",
        }),
      ).rejects.toThrow();
    });
  });

  // ── #304: embedded-array growth bounds ─────────────────────────────

  describe("#304 — usageHistory / dryCycles are capped", () => {
    function usageReq(grams: number) {
      return new NextRequest("http://localhost/api/.../usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grams }),
      });
    }
    function dryReq() {
      return new NextRequest("http://localhost/api/.../dry-cycles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tempC: 55, durationMin: 240 }),
      });
    }

    it("rolls off the oldest usageHistory entry once the 1000-entry cap is hit", async () => {
      // Pre-seed a spool already at the cap. The marker entry is the
      // oldest — it must be gone after one more POST.
      const seeded = Array.from({ length: 1000 }, (_, i) => ({
        grams: 1,
        jobLabel: i === 0 ? "OLDEST-MARKER" : `seed-${i}`,
        date: new Date(2020, 0, 1 + (i % 365)),
        source: "manual" as const,
        jobId: null,
      }));
      const f = await Filament.create({
        name: "Usage Cap",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "s1", totalWeight: 100000, usageHistory: seeded }],
      });
      const spoolId = String(f.spools[0]._id);

      const res = await logUsage(usageReq(5), {
        params: Promise.resolve({ id: String(f._id), spoolId }),
      });
      expect(res.status).toBe(201);

      const fresh = await Filament.findById(f._id).lean();
      const hist = fresh.spools[0].usageHistory;
      expect(hist).toHaveLength(1000); // capped, not 1001
      expect(hist.some((h: { jobLabel: string }) => h.jobLabel === "OLDEST-MARKER")).toBe(false);
      // The just-posted entry survives — it's the newest.
      expect(hist[hist.length - 1].grams).toBe(5);
    });

    it("rolls off the oldest dryCycles entry once the 1000-entry cap is hit", async () => {
      // GH #337 added `min: 0` / `max: 300` on dryCycles.tempC, so the
      // original `-999` sentinel no longer passes validation. Use a
      // distinctive in-range value instead — the cap-roll behaviour we're
      // checking doesn't care about the temperature value, only that the
      // *oldest* entry gets dropped after the cap is hit.
      const SENTINEL = 1; // anything unique vs. the others (50)
      const seeded = Array.from({ length: 1000 }, (_, i) => ({
        date: new Date(2020, 0, 1 + (i % 365)),
        tempC: i === 0 ? SENTINEL : 50, // sentinel temp on the oldest entry
        durationMin: 60,
        notes: "",
      }));
      const f = await Filament.create({
        name: "Dry Cap",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "s1", totalWeight: 1000, dryCycles: seeded }],
      });
      const spoolId = String(f.spools[0]._id);

      const res = await logDryCycle(dryReq(), {
        params: Promise.resolve({ id: String(f._id), spoolId }),
      });
      expect(res.status).toBe(201);

      const fresh = await Filament.findById(f._id).lean();
      const cycles = fresh.spools[0].dryCycles;
      expect(cycles).toHaveLength(1000); // $slice: -1000 kept it capped
      expect(cycles.some((c: { tempC: number }) => c.tempC === SENTINEL)).toBe(false);
    });
  });
});
