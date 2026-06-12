import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { PUT as putSpool } from "@/app/api/filaments/[id]/spools/[spoolId]/route";

/**
 * Route-level tests for the `remainingWeight` input on the spool PUT (GH:
 * mobile-scanner Phase 0). A scanner client expresses "grams left on the
 * spool"; the server converts that to the absolute `totalWeight` by adding the
 * spool's tare (the filament's spoolWeight, inherited from the parent for a
 * variant), so the app does no weight math.
 */
describe("PUT /api/filaments/{id}/spools/{spoolId} — remainingWeight", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  function putReq(url: string, body: unknown) {
    return new NextRequest(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function call(filamentId: string, spoolId: string, body: unknown) {
    return putSpool(
      putReq(
        `http://localhost/api/filaments/${filamentId}/spools/${spoolId}`,
        body,
      ),
      { params: Promise.resolve({ id: filamentId, spoolId }) },
    );
  }

  it("converts remainingWeight to totalWeight using the filament's tare", async () => {
    const f = await Filament.create({
      name: "Tare Host",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      spools: [{ label: "A", totalWeight: 1000 }],
    });
    const sid = String(f.spools[0]._id);
    const res = await call(String(f._id), sid, { remainingWeight: 800 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spools[0].totalWeight).toBe(1000); // 800 remaining + 200 tare
  });

  it("inherits the parent's spoolWeight for a variant that has none", async () => {
    const parent = await Filament.create({
      name: "Parent",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 250,
    });
    const variant = await Filament.create({
      name: "Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      spools: [{ label: "V", totalWeight: 900 }],
    });
    const sid = String(variant.spools[0]._id);
    const res = await call(String(variant._id), sid, { remainingWeight: 750 });
    const body = await res.json();
    expect(body.spools[0].totalWeight).toBe(1000); // 750 + 250 (inherited)
  });

  it("falls back to a 0g tare when neither filament nor parent has spoolWeight", async () => {
    const f = await Filament.create({
      name: "No Tare",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "A", totalWeight: 500 }],
    });
    const sid = String(f.spools[0]._id);
    const res = await call(String(f._id), sid, { remainingWeight: 500 });
    const body = await res.json();
    expect(body.spools[0].totalWeight).toBe(500);
  });

  it("clears the weight when remainingWeight is null", async () => {
    const f = await Filament.create({
      name: "Clearable",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      spools: [{ label: "A", totalWeight: 1000 }],
    });
    const sid = String(f.spools[0]._id);
    const res = await call(String(f._id), sid, { remainingWeight: null });
    const body = await res.json();
    expect(body.spools[0].totalWeight).toBeNull();
  });

  it("rejects supplying both totalWeight and remainingWeight (400)", async () => {
    const f = await Filament.create({
      name: "Conflict",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "A", totalWeight: 1000 }],
    });
    const sid = String(f.spools[0]._id);
    const res = await call(String(f._id), sid, { totalWeight: 900, remainingWeight: 800 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/either totalWeight or remainingWeight/i);
  });

  it("rejects a negative remainingWeight (400)", async () => {
    const f = await Filament.create({
      name: "Negative",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "A", totalWeight: 1000 }],
    });
    const sid = String(f.spools[0]._id);
    const res = await call(String(f._id), sid, { remainingWeight: -5 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric remainingWeight (400)", async () => {
    const f = await Filament.create({
      name: "NaN",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "A", totalWeight: 1000 }],
    });
    const sid = String(f.spools[0]._id);
    const res = await call(String(f._id), sid, { remainingWeight: "lots" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a remainingWeight write to a missing filament", async () => {
    const missingId = new mongoose.Types.ObjectId().toString();
    const missingSpool = new mongoose.Types.ObjectId().toString();
    const res = await call(missingId, missingSpool, { remainingWeight: 500 });
    expect(res.status).toBe(404);
  });
});
