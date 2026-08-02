import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

/**
 * GH #1027 — opt-in `?shape=spool` on the five spool-mutation routes.
 *
 * Pins, per route:
 *   - `?shape=spool` returns ONLY the affected spool (`{ spool }`; DELETE
 *     returns `{ deleted, spoolId }`) — sibling spools' photoDataUrl blobs
 *     and usageHistory ledgers must NOT ride the response;
 *   - the DEFAULT (no param) response is the unchanged full filament doc —
 *     the contract shipped mobile builds parse;
 *   - an unrecognized shape value is a 400, not a silent fat fallback.
 */
describe("spool mutation routes — ?shape=spool (GH #1027)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // A distinctive marker so "the sibling's blob leaked into the response"
  // is a plain substring check on the serialized body.
  const SIBLING_PHOTO = "data:image/png;base64,SIBLINGBLOBMARKER";

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const locMod = await import("@/models/Location");
    const prtMod = await import("@/models/Printer");
    // Location + Printer are registered for the routes' side-effect paths
    // (location guard, AMS slot clears) — no direct handle needed here.
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Location) mongoose.model("Location", locMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  /** Filament with a target spool and a blob-carrying sibling spool. */
  async function createFixture() {
    const filament = await Filament.create({
      name: "Shape PLA",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spools: [
        { label: "target", totalWeight: 1000 },
        {
          label: "sibling",
          totalWeight: 900,
          photoDataUrl: SIBLING_PHOTO,
          usageHistory: [
            { grams: 5, jobLabel: "sibling job", date: new Date(), source: "manual", jobId: null },
          ],
        },
      ],
    });
    return {
      filament,
      id: String(filament._id),
      spoolId: String(filament.spools[0]._id),
    };
  }

  function jsonReq(url: string, method: string, body?: unknown) {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  describe("PUT /api/filaments/{id}/spools/{spoolId}", () => {
    it("?shape=spool returns only the affected spool — no sibling blobs", async () => {
      const { id, spoolId } = await createFixture();
      const { PUT } = await import("@/app/api/filaments/[id]/spools/[spoolId]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${id}/spools/${spoolId}?shape=spool`, "PUT", {
          totalWeight: 750,
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.spool).toBeDefined();
      expect(body.spools).toBeUndefined();
      expect(body.spool._id).toBe(spoolId);
      expect(body.spool.totalWeight).toBe(750);
      expect(JSON.stringify(body)).not.toContain(SIBLING_PHOTO);
      expect(JSON.stringify(body)).not.toContain("sibling job");
    });

    it("default shape still returns the full filament doc (byte-compat canary)", async () => {
      const { id, spoolId } = await createFixture();
      const { PUT } = await import("@/app/api/filaments/[id]/spools/[spoolId]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${id}/spools/${spoolId}`, "PUT", {
          totalWeight: 750,
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.spool).toBeUndefined();
      expect(body.spools).toHaveLength(2);
      expect(body.name).toBe("Shape PLA");
      // The fat default deliberately still carries the sibling's blob.
      expect(JSON.stringify(body)).toContain(SIBLING_PHOTO);
    });

    it("?shape=spool works with an UPPERCASED spoolId — the write commits case-insensitively, so the response must too", async () => {
      // GH #1027 adversarial-review regression: the ObjectId cast on the
      // "spools._id" filter accepts uppercase hex and COMMITS the $set; a
      // case-sensitive response lookup then 404'd a committed write.
      const { id, spoolId } = await createFixture();
      const upper = spoolId.toUpperCase();
      const { PUT } = await import("@/app/api/filaments/[id]/spools/[spoolId]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${id}/spools/${upper}?shape=spool`, "PUT", {
          totalWeight: 640,
        }),
        { params: Promise.resolve({ id, spoolId: upper }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.spool.totalWeight).toBe(640);
      expect(body.spool._id).toBe(spoolId); // canonical lowercase from the doc
    });

    it("?shape=spool carries the tare-converted GROSS weight on a remainingWeight write (the mobile payload)", async () => {
      // Mobile's saveWeight sends {remainingWeight} with ?shape=spool and
      // re-renders from the returned spool, subtracting the tare itself —
      // so the response's totalWeight must be gross (remaining + tare).
      const filament = await Filament.create({
        name: "Tare PLA",
        vendor: "QA",
        type: "PLA",
        diameter: 1.75,
        spoolWeight: 200,
        spools: [{ label: "roll", totalWeight: 1000 }],
      });
      const id = String(filament._id);
      const spoolId = String(filament.spools[0]._id);
      const { PUT } = await import("@/app/api/filaments/[id]/spools/[spoolId]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${id}/spools/${spoolId}?shape=spool`, "PUT", {
          remainingWeight: 500,
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.spool.totalWeight).toBe(700); // 500 remaining + 200 tare
      expect(body.spools).toBeUndefined();
    });

    it("?shape=spool carries the freshly-minted instanceId on a regenerate write (the SpoolCard ID editor)", async () => {
      const { id, spoolId, filament } = await createFixture();
      const before = filament.spools[0].instanceId;
      const { PUT } = await import("@/app/api/filaments/[id]/spools/[spoolId]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${id}/spools/${spoolId}?shape=spool`, "PUT", {
          regenerate: true,
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.spool.instanceId).toMatch(/^[0-9a-f]{10}$/);
      expect(body.spool.instanceId).not.toBe(before);
    });

    it("unrecognized shape value → 400, before any write", async () => {
      const { id, spoolId } = await createFixture();
      const { PUT } = await import("@/app/api/filaments/[id]/spools/[spoolId]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${id}/spools/${spoolId}?shape=spol`, "PUT", {
          totalWeight: 750,
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(400);
      const doc = await Filament.findById(id).lean();
      expect(doc.spools[0].totalWeight).toBe(1000); // untouched
    });
  });

  describe("DELETE /api/filaments/{id}/spools/{spoolId}", () => {
    it("?shape=spool returns a deleted-marker and actually deletes", async () => {
      const { id, spoolId } = await createFixture();
      const { DELETE } = await import("@/app/api/filaments/[id]/spools/[spoolId]/route");
      const res = await DELETE(
        new NextRequest(`http://localhost/api/filaments/${id}/spools/${spoolId}?shape=spool`, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ deleted: true, spoolId });
      expect(JSON.stringify(body)).not.toContain(SIBLING_PHOTO);
      const doc = await Filament.findById(id).lean();
      expect(doc.spools).toHaveLength(1);
      expect(doc.spools[0].label).toBe("sibling");
    });

    it("unrecognized shape value → 400 and the spool survives", async () => {
      const { id, spoolId } = await createFixture();
      const { DELETE } = await import("@/app/api/filaments/[id]/spools/[spoolId]/route");
      const res = await DELETE(
        new NextRequest(`http://localhost/api/filaments/${id}/spools/${spoolId}?shape=nope`, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(400);
      const doc = await Filament.findById(id).lean();
      expect(doc.spools).toHaveLength(2);
    });
  });

  describe("POST /api/filaments/{id}/spools", () => {
    it("?shape=spool returns the created spool with server-minted _id + instanceId", async () => {
      const { id } = await createFixture();
      const { POST } = await import("@/app/api/filaments/[id]/spools/route");
      const res = await POST(
        jsonReq(`http://localhost/api/filaments/${id}/spools?shape=spool`, "POST", {
          label: "fresh",
          totalWeight: 1234,
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.spools).toBeUndefined();
      expect(body.spool.label).toBe("fresh");
      expect(body.spool.totalWeight).toBe(1234);
      expect(body.spool._id).toMatch(/^[0-9a-f]{24}$/);
      expect(body.spool.instanceId).toMatch(/^[0-9a-f]{10}$/);
      expect(JSON.stringify(body)).not.toContain(SIBLING_PHOTO);
      const doc = await Filament.findById(id).lean();
      expect(doc.spools).toHaveLength(3);
    });

    it("template guard still 400s with the shared body when shape=spool is requested", async () => {
      const parent = await Filament.create({
        name: "Template",
        vendor: "QA",
        type: "PLA",
        diameter: 1.75,
      });
      await Filament.create({
        name: "Template Red",
        vendor: "QA",
        type: "PLA",
        diameter: 1.75,
        parentId: parent._id,
      });
      const { POST } = await import("@/app/api/filaments/[id]/spools/route");
      const res = await POST(
        jsonReq(`http://localhost/api/filaments/${parent._id}/spools?shape=spool`, "POST", {
          label: "nope",
          totalWeight: 100,
        }),
        { params: Promise.resolve({ id: String(parent._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("template_no_spools");
    });

    it("unrecognized shape value → 400 and nothing is created", async () => {
      const { id } = await createFixture();
      const { POST } = await import("@/app/api/filaments/[id]/spools/route");
      const res = await POST(
        jsonReq(`http://localhost/api/filaments/${id}/spools?shape=filament`, "POST", {
          label: "fresh",
          totalWeight: 1234,
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(400);
      const doc = await Filament.findById(id).lean();
      expect(doc.spools).toHaveLength(2);
    });
  });

  describe("POST …/usage", () => {
    it("?shape=spool returns the affected spool with the decremented GROSS weight + its own ledger", async () => {
      const { id, spoolId } = await createFixture();
      const { POST } = await import(
        "@/app/api/filaments/[id]/spools/[spoolId]/usage/route"
      );
      const res = await POST(
        jsonReq(
          `http://localhost/api/filaments/${id}/spools/${spoolId}/usage?shape=spool`,
          "POST",
          { grams: 120, jobLabel: "benchy" },
        ),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.spools).toBeUndefined();
      expect(body.spool._id).toBe(spoolId);
      // Gross post-decrement value — the mobile weight refresh subtracts the
      // tare itself, so this must NOT be a remaining-net number.
      expect(body.spool.totalWeight).toBe(880);
      expect(body.spool.usageHistory).toHaveLength(1);
      expect(body.spool.usageHistory[0].grams).toBe(120);
      expect(JSON.stringify(body)).not.toContain(SIBLING_PHOTO);
      expect(JSON.stringify(body)).not.toContain("sibling job");
    });

    it("unrecognized shape value → 400 and no debit happens", async () => {
      const { id, spoolId } = await createFixture();
      const { POST } = await import(
        "@/app/api/filaments/[id]/spools/[spoolId]/usage/route"
      );
      const res = await POST(
        jsonReq(
          `http://localhost/api/filaments/${id}/spools/${spoolId}/usage?shape=x`,
          "POST",
          { grams: 120 },
        ),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(400);
      const doc = await Filament.findById(id).lean();
      expect(doc.spools[0].totalWeight).toBe(1000);
      expect(doc.spools[0].usageHistory ?? []).toHaveLength(0);
    });
  });

  describe("POST …/dry-cycles", () => {
    it("?shape=spool returns the affected spool with the appended cycle", async () => {
      const { id, spoolId } = await createFixture();
      const { POST } = await import(
        "@/app/api/filaments/[id]/spools/[spoolId]/dry-cycles/route"
      );
      const res = await POST(
        jsonReq(
          `http://localhost/api/filaments/${id}/spools/${spoolId}/dry-cycles?shape=spool`,
          "POST",
          { tempC: 55, durationMin: 240 },
        ),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.spools).toBeUndefined();
      expect(body.spool._id).toBe(spoolId);
      expect(body.spool.dryCycles).toHaveLength(1);
      expect(body.spool.dryCycles[0].tempC).toBe(55);
      expect(JSON.stringify(body)).not.toContain(SIBLING_PHOTO);
    });

    it("unrecognized shape value → 400 and no cycle is logged", async () => {
      const { id, spoolId } = await createFixture();
      const { POST } = await import(
        "@/app/api/filaments/[id]/spools/[spoolId]/dry-cycles/route"
      );
      const res = await POST(
        jsonReq(
          `http://localhost/api/filaments/${id}/spools/${spoolId}/dry-cycles?shape=`,
          "POST",
          { tempC: 55 },
        ),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(res.status).toBe(400);
      const doc = await Filament.findById(id).lean();
      expect(doc.spools[0].dryCycles ?? []).toHaveLength(0);
    });
  });

  describe("default-shape parity for the other four routes", () => {
    it("POST /spools, usage, dry-cycles, DELETE still return the full doc without the param", async () => {
      const { id, spoolId } = await createFixture();
      const { POST: createSpool } = await import("@/app/api/filaments/[id]/spools/route");
      const { POST: postUsage } = await import(
        "@/app/api/filaments/[id]/spools/[spoolId]/usage/route"
      );
      const { POST: postDry } = await import(
        "@/app/api/filaments/[id]/spools/[spoolId]/dry-cycles/route"
      );
      const { DELETE: deleteSpool } = await import(
        "@/app/api/filaments/[id]/spools/[spoolId]/route"
      );

      const createRes = await createSpool(
        jsonReq(`http://localhost/api/filaments/${id}/spools`, "POST", { label: "x", totalWeight: 1 }),
        { params: Promise.resolve({ id }) },
      );
      expect(createRes.status).toBe(201);
      expect((await createRes.json()).spools).toHaveLength(3);

      const usageRes = await postUsage(
        jsonReq(`http://localhost/api/filaments/${id}/spools/${spoolId}/usage`, "POST", { grams: 1 }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(usageRes.status).toBe(201);
      expect((await usageRes.json()).spools).toHaveLength(3);

      const dryRes = await postDry(
        jsonReq(`http://localhost/api/filaments/${id}/spools/${spoolId}/dry-cycles`, "POST", {
          tempC: 50,
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(dryRes.status).toBe(201);
      expect((await dryRes.json()).spools).toHaveLength(3);

      const delRes = await deleteSpool(
        new NextRequest(`http://localhost/api/filaments/${id}/spools/${spoolId}`, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ id, spoolId }) },
      );
      expect(delRes.status).toBe(200);
      const delBody = await delRes.json();
      expect(delBody.spools).toHaveLength(2);
      expect(delBody.deleted).toBeUndefined();
    });
  });
});
