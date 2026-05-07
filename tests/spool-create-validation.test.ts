import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createSpool } from "@/app/api/filaments/[id]/spools/route";

/**
 * GH #203 regression guard.
 *
 * `POST /api/filaments/{id}/spools` previously called `validateSpoolBody`
 * (which defaults missing fields to empty/null on POST) and pushed
 * `{ label, totalWeight }` regardless of whether the caller supplied
 * any meaningful data. So an empty `{}` body created a phantom spool
 * with all-null fields, polluting the inventory list.
 *
 * The fix requires at least one of the spool's meaningful fields to be
 * present in the body, and pushes every field the validator captured
 * (lotNumber / purchaseDate / openedDate / locationId / photoDataUrl /
 * retired) instead of dropping them.
 */
describe("POST /api/filaments/[id]/spools — body validation (GH #203)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  async function seed() {
    return Filament.create({
      name: "Spool Test PLA",
      vendor: "Test",
      type: "PLA",
    });
  }

  function postReq(filamentId: string, body: unknown) {
    return new NextRequest(`http://localhost/api/filaments/${filamentId}/spools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects an empty body with 400 (no phantom spool created)", async () => {
    const f = await seed();
    const res = await createSpool(postReq(String(f._id), {}), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least one of/i);
    // Verify nothing was actually persisted.
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(0);
  });

  it("accepts a body with only totalWeight", async () => {
    const f = await seed();
    const res = await createSpool(postReq(String(f._id), { totalWeight: 1000 }), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(1000);
  });

  it("accepts a body with only label", async () => {
    const f = await seed();
    const res = await createSpool(postReq(String(f._id), { label: "Drybox A" }), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[0].label).toBe("Drybox A");
  });

  it("accepts a body with only locationId", async () => {
    delete mongoose.models.Location;
    const Location = (await import("@/models/Location")).default;
    const loc = await Location.create({ name: "Drybox B", kind: "drybox" });
    const f = await seed();
    const res = await createSpool(postReq(String(f._id), { locationId: String(loc._id) }), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(String(fresh.spools[0].locationId)).toBe(String(loc._id));
  });

  it("persists every supplied field (no silent drop of lotNumber/dates)", async () => {
    const f = await seed();
    const res = await createSpool(
      postReq(String(f._id), {
        label: "Yellow",
        totalWeight: 950,
        lotNumber: "LOT-007",
        purchaseDate: "2025-01-15",
        openedDate: "2025-02-01",
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    const s = fresh.spools[0];
    expect(s.label).toBe("Yellow");
    expect(s.totalWeight).toBe(950);
    expect(s.lotNumber).toBe("LOT-007");
    expect(s.purchaseDate?.toISOString().slice(0, 10)).toBe("2025-01-15");
    expect(s.openedDate?.toISOString().slice(0, 10)).toBe("2025-02-01");
  });

  it("returns 400 for non-numeric totalWeight (existing validateSpoolBody guard)", async () => {
    const f = await seed();
    const res = await createSpool(
      postReq(String(f._id), { totalWeight: "abc" }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(400);
  });
});
