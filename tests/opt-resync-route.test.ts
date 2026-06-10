import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

/**
 * Route-level tests for the GH #607 re-sync endpoints
 * (`GET /api/filaments/{id}/openprinttag/check` +
 *  `POST /api/filaments/{id}/openprinttag/sync`).
 *
 * `fetchOpenPrintTagDatabase` is mocked so the test controls the "upstream"
 * material; `mapToFilamentPayload` is the real implementation (DB-free), so
 * the route's diff/sync runs against the genuine OPT→Filament mapping.
 *
 * Schema re-registration in beforeEach mirrors the other route-level tests
 * (tests/setup.ts wipes mongoose.models between tests).
 */

// One material the mocked DB returns. `parseMaterialYaml` output shape.
const UPSTREAM_MATERIAL = {
  slug: "prusament-pla-galaxy-black",
  uuid: "1aaca54a-431f-5601-adf5-85dd018f487f",
  brandSlug: "prusament",
  brandName: "Prusament",
  name: "PLA Galaxy Black",
  type: "PLA",
  abbreviation: "PLA",
  color: "#3d3e3d",
  secondaryColors: [] as string[],
  density: 1.24,
  nozzleTempMin: 205,
  nozzleTempMax: 225,
  bedTempMin: 40,
  bedTempMax: 60,
  chamberTemp: null,
  preheatTemp: 170,
  dryingTemp: null,
  dryingTime: null,
  hardnessShoreD: 81,
  transmissionDistance: 0.2,
  tags: [] as string[],
  photoUrl: null,
  productUrl: null,
  completenessScore: 8,
  completenessTier: "rich" as const,
};

const dbMock = vi.fn();

vi.mock("@/lib/openprinttagBrowser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openprinttagBrowser")>();
  return {
    ...actual,
    fetchOpenPrintTagDatabase: () => dbMock(),
  };
});

describe("OpenPrintTag re-sync routes (GH #607)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  let checkGET: typeof import("@/app/api/filaments/[id]/openprinttag/check/route").GET;
  let syncPOST: typeof import("@/app/api/filaments/[id]/openprinttag/sync/route").POST;
  let importPOST: typeof import("@/app/api/openprinttag/import/route").POST;
  let detailGET: typeof import("@/app/api/filaments/[id]/route").GET;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
    // The detail GET route .populate()s these — register so it doesn't 500.
    // Static imports — `await import(`@/models/${name}`)` triggers a Vite
    // dynamic-import warning ("file extension must be included in the static
    // part"); a static lookup table keeps each import string fully literal
    // (same pattern as tests/compare-route.test.ts).
    const referenced = [
      ["Nozzle", await import("@/models/Nozzle")],
      ["Printer", await import("@/models/Printer")],
      ["BedType", await import("@/models/BedType")],
    ] as const;
    for (const [name, mod] of referenced) {
      if (!mongoose.models[name]) {
        mongoose.model(name, mod.default.schema);
      }
    }

    checkGET = (await import("@/app/api/filaments/[id]/openprinttag/check/route")).GET;
    syncPOST = (await import("@/app/api/filaments/[id]/openprinttag/sync/route")).POST;
    importPOST = (await import("@/app/api/openprinttag/import/route")).POST;
    detailGET = (await import("@/app/api/filaments/[id]/route")).GET;

    dbMock.mockReset();
    dbMock.mockResolvedValue({
      brands: [],
      materials: [UPSTREAM_MATERIAL],
      cachedAt: new Date(0).toISOString(),
      totalFFF: 1,
      totalSLA: 0,
    });
  });

  function params(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  function syncReq(id: string, fields: string[], headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:3456/api/filaments/${id}/openprinttag/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ fields }),
    });
  }

  // ── import writes the provenance snapshot (GH #607) ──────────────────

  it("import: stamps openprinttagSnapshot so provenance exists day one", async () => {
    const req = new NextRequest("http://localhost:3456/api/openprinttag/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slugs: ["prusament-pla-galaxy-black"] }),
    });
    const res = await importPOST(req);
    expect(res.status).toBe(200);

    const f = await Filament.findOne({ name: "Prusament PLA Galaxy Black" }).lean();
    expect(f).toBeTruthy();
    // GH #607 (Codex P2): provenance lives OUTSIDE the settings bag.
    expect(f.settings.openprinttag_snapshot).toBeUndefined();
    const snap = f.openprinttagSnapshot;
    expect(snap).toBeTruthy();
    expect(snap.density).toBe(1.24);
    expect(snap.temperatures_nozzle).toBe(225);
    expect(snap.color).toBe("#3d3e3d");
    // A check right after import (no edits) → up to date, empty changes.
    const checkRes = await checkGET({} as NextRequest, params(String(f._id)));
    expect((await checkRes.json()).changes).toEqual([]);
  });

  it("import: backfills the snapshot on the UPDATE path (pre-existing row)", async () => {
    // A row imported before #607 (slug present, no snapshot). Re-importing
    // must stamp the snapshot via the $set update path, not only on create.
    const pre = await Filament.create({
      name: "Prusament PLA Galaxy Black",
      vendor: "Prusament",
      type: "PLA",
      settings: { openprinttag_slug: "prusament-pla-galaxy-black", openprinttag_uuid: "x" },
    });
    expect(pre.openprinttagSnapshot).toBeFalsy();

    const req = new NextRequest("http://localhost:3456/api/openprinttag/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slugs: ["prusament-pla-galaxy-black"] }),
    });
    const res = await importPOST(req);
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(1);

    const f = await Filament.findById(pre._id).lean();
    expect(f.openprinttagSnapshot).toBeTruthy();
    expect(f.openprinttagSnapshot.temperatures_nozzle).toBe(225);
  });

  // ── detail _hasOwnOptLink (button gating, Codex P2 r4) ───────────────

  it("detail: _hasOwnOptLink true for the linked root, false for an inheriting variant", async () => {
    const parent = await Filament.create({
      name: "OPT Parent PLA",
      vendor: "Prusament",
      type: "PLA",
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const variant = await Filament.create({
      name: "OPT Parent PLA — Red",
      vendor: "Prusament",
      type: "PLA",
      parentId: parent._id,
      // No own slug — but resolveFilament will merge the parent's settings
      // into the resolved response, so the gate must use _hasOwnOptLink.
    });

    const reqUrl = (id: string) => new NextRequest(`http://localhost:3456/api/filaments/${id}`);

    const rootRes = await detailGET(reqUrl(String(parent._id)), params(String(parent._id)));
    const rootBody = await rootRes.json();
    expect(rootBody._hasOwnOptLink).toBe(true);

    const varRes = await detailGET(reqUrl(String(variant._id)), params(String(variant._id)));
    const varBody = await varRes.json();
    // The resolved settings DO carry the inherited slug …
    expect(varBody.settings.openprinttag_slug).toBe("prusament-pla-galaxy-black");
    // … but the variant has no OWN link, so the button must stay hidden.
    expect(varBody._hasOwnOptLink).toBe(false);
  });

  // ── check ────────────────────────────────────────────────────────────

  it("check: returns linked:false for a filament with no OPT slug", async () => {
    const f = await Filament.create({ name: "Plain PLA", vendor: "X", type: "PLA" });
    const res = await checkGET({} as NextRequest, params(String(f._id)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false });
  });

  it("check: returns found:false when the slug is gone upstream", async () => {
    const f = await Filament.create({
      name: "Ghost PLA",
      vendor: "Prusament",
      type: "PLA",
      settings: { openprinttag_slug: "removed-upstream" },
    });
    const res = await checkGET({} as NextRequest, params(String(f._id)));
    const body = await res.json();
    expect(body.linked).toBe(true);
    expect(body.found).toBe(false);
  });

  it("check: surfaces an upstream change as a conflict for an edited field", async () => {
    // Local nozzle 215, OPT offers 225, snapshot says OPT last wrote 220 →
    // the user diverged → conflict. density is null locally → adopt.
    const f = await Filament.create({
      name: "Edited PLA",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d",
      density: null,
      temperatures: { nozzle: 215, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
      openprinttagSnapshot: { temperatures_nozzle: 220 },
    });
    const res = await checkGET({} as NextRequest, params(String(f._id)));
    const body = await res.json();
    expect(body.linked).toBe(true);
    expect(body.found).toBe(true);
    expect(body.materialName).toBe("Prusament PLA Galaxy Black");

    const nozzle = body.changes.find((c: { field: string }) => c.field === "temperatures.nozzle");
    expect(nozzle.kind).toBe("conflict");
    expect(nozzle.current).toBe(215);
    expect(nozzle.incoming).toBe(225);

    const density = body.changes.find((c: { field: string }) => c.field === "density");
    expect(density.kind).toBe("adopt");
    expect(density.incoming).toBe(1.24);
  });

  it("check: empty changes when the row already matches OPT", async () => {
    const f = await Filament.create({
      name: "Matching PLA",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d",
      density: 1.24,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const res = await checkGET({} as NextRequest, params(String(f._id)));
    const body = await res.json();
    expect(body.changes).toEqual([]);
  });

  // ── sync ─────────────────────────────────────────────────────────────

  it("sync: applies only the selected fields and refreshes the snapshot", async () => {
    const f = await Filament.create({
      name: "Sync PLA",
      vendor: "Prusament",
      type: "PLA",
      color: "#808080",
      density: null,
      temperatures: { nozzle: 215, nozzleRangeMin: null, nozzleRangeMax: null, bed: null, standby: null },
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });

    // Adopt density + color but NOT the (edited) nozzle temp.
    const res = await syncPOST(syncReq(String(f._id), ["density", "color"]), params(String(f._id)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied.sort()).toEqual(["color", "density"]);

    const fresh = await Filament.findById(f._id).lean();
    expect(fresh.density).toBe(1.24);
    expect(fresh.color).toBe("#3d3e3d");
    // Nozzle was NOT selected → unchanged.
    expect(fresh.temperatures.nozzle).toBe(215);
    // Snapshot refreshed to the full OPT offer (so the declined nozzle stays
    // a conflict on the next check rather than vanishing).
    expect(fresh.openprinttagSnapshot.temperatures_nozzle).toBe(225);
    expect(fresh.openprinttagSnapshot.density).toBe(1.24);
  });

  it("sync: rejects an unknown field with 400", async () => {
    const f = await Filament.create({
      name: "Guard PLA",
      vendor: "Prusament",
      type: "PLA",
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const res = await syncPOST(syncReq(String(f._id), ["name", "density"]), params(String(f._id)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("name");
  });

  it("sync: refuses to clear a field OPT doesn't offer (sparse-data guard, Codex P2 r3)", async () => {
    // Upstream material has no density. A stale/crafted POST of
    // fields:["density"] must NOT wipe the user's local density — diffOptFields
    // never offered it, so the sync route rejects it.
    dbMock.mockResolvedValueOnce({
      brands: [],
      materials: [{ ...UPSTREAM_MATERIAL, density: null }],
      cachedAt: new Date(0).toISOString(),
      totalFFF: 1,
      totalSLA: 0,
    });
    const f = await Filament.create({
      name: "Sparse PLA",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d",
      density: 1.42, // user's value
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const res = await syncPOST(syncReq(String(f._id), ["density"]), params(String(f._id)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("density");
    const fresh = await Filament.findById(f._id).lean();
    expect(fresh.density).toBe(1.42); // untouched
  });

  it("sync: 400 when the filament is not OPT-linked", async () => {
    const f = await Filament.create({ name: "Unlinked", vendor: "X", type: "PLA" });
    const res = await syncPOST(syncReq(String(f._id), ["density"]), params(String(f._id)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not linked");
  });

  it("sync: 400 on a malformed body", async () => {
    const f = await Filament.create({
      name: "Bad Body",
      vendor: "Prusament",
      type: "PLA",
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const badReq = new NextRequest(`http://localhost:3456/api/filaments/${f._id}/openprinttag/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: "not-an-array" }),
    });
    const res = await syncPOST(badReq, params(String(f._id)));
    expect(res.status).toBe(400);
  });

  it("sync: 404s instead of mutating a row soft-deleted mid-request (#629)", async () => {
    // The final write must re-filter `_deletedAt: null` — a soft-delete
    // landing between the route's initial findOne and its findOneAndUpdate
    // used to quietly mutate the tombstoned row (the same race the Bambu
    // per-id sync closed). The mocked upstream fetch runs exactly in that
    // window, so performing the soft-delete inside it recreates the race
    // deterministically.
    const f = await Filament.create({
      name: "Race PLA",
      vendor: "Prusament",
      type: "PLA",
      color: "#808080",
      density: null,
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    dbMock.mockImplementationOnce(async () => {
      await Filament.updateOne({ _id: f._id }, { _deletedAt: new Date() });
      return {
        brands: [],
        materials: [UPSTREAM_MATERIAL],
        cachedAt: new Date(0).toISOString(),
        totalFFF: 1,
        totalSLA: 0,
      };
    });

    const res = await syncPOST(syncReq(String(f._id), ["density"]), params(String(f._id)));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/deleted/i);

    // The tombstoned row was NOT mutated — no density, no snapshot refresh.
    const fresh = await Filament.findById(f._id).lean();
    expect(fresh.density).toBeNull();
    expect(fresh.openprinttagSnapshot).toBeFalsy();
  });

  it("sync: rejects a cross-origin (CSRF) request before mutating", async () => {
    const f = await Filament.create({
      name: "CSRF PLA",
      vendor: "Prusament",
      type: "PLA",
      density: null,
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const res = await syncPOST(
      syncReq(String(f._id), ["density"], { "sec-fetch-site": "cross-site" }),
      params(String(f._id)),
    );
    expect(res.status).toBe(403);
    const fresh = await Filament.findById(f._id).lean();
    expect(fresh.density).toBeNull(); // untouched
  });
});
