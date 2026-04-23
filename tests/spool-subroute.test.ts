import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as postUsage } from "@/app/api/filaments/[id]/spools/[spoolId]/usage/route";
import { POST as postDryCycle } from "@/app/api/filaments/[id]/spools/[spoolId]/dry-cycles/route";
import { DELETE as deleteSpool } from "@/app/api/filaments/[id]/spools/[spoolId]/route";

/**
 * Tests for the two v1.11 spool-ledger sub-endpoints:
 *   POST /api/filaments/{id}/spools/{spoolId}/usage
 *   POST /api/filaments/{id}/spools/{spoolId}/dry-cycles
 *
 * Both were untested at the route layer before this file. The usage
 * endpoint also has a length-bounds guard added in the audit pass; we
 * lock that in here.
 */
describe("spool sub-routes", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  async function seedFilament() {
    return Filament.create({
      name: "Spool Host",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "Main", totalWeight: 1000 }],
    });
  }

  function postReq(url: string, body: unknown) {
    return new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("POST .../spools/{spoolId}/usage", () => {
    it("decrements totalWeight and appends a manual usageHistory entry", async () => {
      const f = await seedFilament();
      const sid = String(f.spools[0]._id);
      const res = await postUsage(
        postReq(
          `http://localhost/api/filaments/${f._id}/spools/${sid}/usage`,
          { grams: 40, jobLabel: "benchy" },
        ),
        { params: Promise.resolve({ id: String(f._id), spoolId: sid }) },
      );
      expect(res.status).toBe(201);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].totalWeight).toBe(960);
      expect(fresh.spools[0].usageHistory).toHaveLength(1);
      expect(fresh.spools[0].usageHistory[0]).toMatchObject({
        grams: 40,
        jobLabel: "benchy",
        source: "manual",
      });
    });

    it("clamps totalWeight at 0 when the request over-draws", async () => {
      const f = await seedFilament();
      const sid = String(f.spools[0]._id);
      await postUsage(
        postReq(
          `http://localhost/api/filaments/${f._id}/spools/${sid}/usage`,
          { grams: 5000, jobLabel: "ridiculous" },
        ),
        { params: Promise.resolve({ id: String(f._id), spoolId: sid }) },
      );
      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].totalWeight).toBe(0);
    });

    it("rejects non-positive grams", async () => {
      const f = await seedFilament();
      const sid = String(f.spools[0]._id);
      const res = await postUsage(
        postReq(
          `http://localhost/api/filaments/${f._id}/spools/${sid}/usage`,
          { grams: 0 },
        ),
        { params: Promise.resolve({ id: String(f._id), spoolId: sid }) },
      );
      expect(res.status).toBe(400);
    });

    it("rejects jobLabel over 200 chars (length bounds guard)", async () => {
      const f = await seedFilament();
      const sid = String(f.spools[0]._id);
      const res = await postUsage(
        postReq(
          `http://localhost/api/filaments/${f._id}/spools/${sid}/usage`,
          { grams: 10, jobLabel: "a".repeat(201) },
        ),
        { params: Promise.resolve({ id: String(f._id), spoolId: sid }) },
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 for a missing spoolId on an existing filament", async () => {
      const f = await seedFilament();
      const fakeSpool = new mongoose.Types.ObjectId().toString();
      const res = await postUsage(
        postReq(
          `http://localhost/api/filaments/${f._id}/spools/${fakeSpool}/usage`,
          { grams: 10 },
        ),
        { params: Promise.resolve({ id: String(f._id), spoolId: fakeSpool }) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST .../spools/{spoolId}/dry-cycles", () => {
    it("appends a dry cycle with default date when only temp/duration given", async () => {
      const f = await seedFilament();
      const sid = String(f.spools[0]._id);
      const before = Date.now();
      const res = await postDryCycle(
        postReq(
          `http://localhost/api/filaments/${f._id}/spools/${sid}/dry-cycles`,
          { tempC: 65, durationMin: 240, notes: "pre-print" },
        ),
        { params: Promise.resolve({ id: String(f._id), spoolId: sid }) },
      );
      expect(res.status).toBe(201);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].dryCycles).toHaveLength(1);
      expect(fresh.spools[0].dryCycles[0]).toMatchObject({
        tempC: 65,
        durationMin: 240,
        notes: "pre-print",
      });
      expect(new Date(fresh.spools[0].dryCycles[0].date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it("accepts a body with no fields (nulls + now)", async () => {
      const f = await seedFilament();
      const sid = String(f.spools[0]._id);
      const res = await postDryCycle(
        postReq(
          `http://localhost/api/filaments/${f._id}/spools/${sid}/dry-cycles`,
          {},
        ),
        { params: Promise.resolve({ id: String(f._id), spoolId: sid }) },
      );
      expect(res.status).toBe(201);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools[0].dryCycles[0]).toMatchObject({
        tempC: null,
        durationMin: null,
        notes: "",
      });
    });

    it("returns 404 when the spoolId doesn't match", async () => {
      const f = await seedFilament();
      const fakeSpool = new mongoose.Types.ObjectId().toString();
      const res = await postDryCycle(
        postReq(
          `http://localhost/api/filaments/${f._id}/spools/${fakeSpool}/dry-cycles`,
          { tempC: 50 },
        ),
        { params: Promise.resolve({ id: String(f._id), spoolId: fakeSpool }) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE .../spools/{spoolId}", () => {
    function delReq(url: string) {
      return new NextRequest(url, { method: "DELETE" });
    }

    it("removes the spool and returns the updated filament", async () => {
      const f = await seedFilament();
      const sid = String(f.spools[0]._id);
      const res = await deleteSpool(
        delReq(`http://localhost/api/filaments/${f._id}/spools/${sid}`),
        { params: Promise.resolve({ id: String(f._id), spoolId: sid }) },
      );
      expect(res.status).toBe(200);

      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(0);
    });

    it("returns 404 for a missing spoolId rather than silently succeeding", async () => {
      // Regression: a $pull with a non-matching _id used to be a silent
      // no-op on the filament doc — the client got a 200 and couldn't tell
      // whether the deletion actually happened.
      const f = await seedFilament();
      const originalSpoolId = String(f.spools[0]._id);
      const fakeSpool = new mongoose.Types.ObjectId().toString();
      const res = await deleteSpool(
        delReq(`http://localhost/api/filaments/${f._id}/spools/${fakeSpool}`),
        { params: Promise.resolve({ id: String(f._id), spoolId: fakeSpool }) },
      );
      expect(res.status).toBe(404);

      // Real spool must still be there.
      const fresh = await Filament.findById(f._id);
      expect(fresh.spools).toHaveLength(1);
      expect(String(fresh.spools[0]._id)).toBe(originalSpoolId);
    });

    it("returns 404 when the filament itself doesn't exist", async () => {
      const fakeFilament = new mongoose.Types.ObjectId().toString();
      const fakeSpool = new mongoose.Types.ObjectId().toString();
      const res = await deleteSpool(
        delReq(`http://localhost/api/filaments/${fakeFilament}/spools/${fakeSpool}`),
        { params: Promise.resolve({ id: fakeFilament, spoolId: fakeSpool }) },
      );
      expect(res.status).toBe(404);
    });
  });
});
