import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/spools/[spoolId]/route";

/**
 * GET /api/spools/{spoolId} — single-spool resolution (mobile Phase 3
 * spool-level deep links). Resolves a spool subdocument id to its owning
 * filament (inheritance-resolved for variants) + the spool itself.
 */
describe("GET /api/spools/{spoolId}", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function call(spoolId: string) {
    return GET(new NextRequest(`http://localhost/api/spools/${spoolId}`), {
      params: Promise.resolve({ spoolId }),
    });
  }

  it("resolves a spool to its filament + the spool subdoc", async () => {
    const f = await Filament.create({
      name: "Deep Link PLA",
      vendor: "Acme",
      type: "PLA",
      spoolWeight: 200,
      spools: [
        { label: "A", totalWeight: 900 },
        { label: "B", totalWeight: 1200 },
      ],
    });
    const spoolId = String(f.spools[1]._id);

    const res = await call(spoolId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filament._id).toBe(String(f._id));
    expect(body.filament.name).toBe("Deep Link PLA");
    expect(body.spool._id).toBe(spoolId);
    expect(body.spool.label).toBe("B");
    expect(body.spool.totalWeight).toBe(1200);
  });

  it("resolves inherited fields when the spool's filament is a variant", async () => {
    const parent = await Filament.create({
      name: "Parent PLA",
      vendor: "Acme",
      type: "PLA",
      spoolWeight: 250,
      netFilamentWeight: 1000,
    });
    const variant = await Filament.create({
      name: "Variant Red",
      vendor: "Acme",
      type: "PLA",
      parentId: parent._id,
      // vendor/type/spoolWeight/netFilamentWeight left to inherit
      spools: [{ label: "", totalWeight: 1250 }],
    });
    const spoolId = String(variant.spools[0]._id);

    const res = await call(spoolId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filament._id).toBe(String(variant._id));
    // inherited from parent
    expect(body.filament.spoolWeight).toBe(250);
    expect(body.filament.netFilamentWeight).toBe(1000);
    expect(body.spool.totalWeight).toBe(1250);
  });

  it("400 for a malformed spool id", async () => {
    const res = await call("not-an-objectid");
    expect(res.status).toBe(400);
  });

  it("404 for a valid but absent spool id", async () => {
    const res = await call(String(new mongoose.Types.ObjectId()));
    expect(res.status).toBe(404);
  });

  it("404 when the owning filament is soft-deleted", async () => {
    const f = await Filament.create({
      name: "Trashed PLA",
      vendor: "Acme",
      type: "PLA",
      spools: [{ label: "", totalWeight: 500 }],
      _deletedAt: new Date(),
    });
    const spoolId = String(f.spools[0]._id);

    const res = await call(spoolId);
    expect(res.status).toBe(404);
  });
});
