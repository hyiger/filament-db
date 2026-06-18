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
  let linkPOST: typeof import("@/app/api/filaments/[id]/openprinttag/link/route").POST;
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
    linkPOST = (await import("@/app/api/filaments/[id]/openprinttag/link/route")).POST;
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

  function linkReq(id: string, slug: unknown, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:3456/api/filaments/${id}/openprinttag/link`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ slug }),
    });
  }

  function importReq(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest("http://localhost:3456/api/openprinttag/import", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
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

  it("check: respects values inherited from the parent (no spurious adopt) (GH #607)", async () => {
    // The parent carries the OPT-matching values; the variant leaves them
    // unset to inherit. Pre-fix the diff read the variant's raw (null) fields
    // and offered density/temps/etc. as spurious "adopt" gap-fills — the diff
    // must run against the RESOLVED (variant→parent) values instead.
    const parent = await Filament.create({
      name: "Galaxy Parent",
      vendor: "Prusament",
      type: "PLA",
      density: 1.24,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    });
    const variant = await Filament.create({
      name: "Galaxy Variant",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d", // color is variant-only (never inherited)
      parentId: parent._id,
      density: null, // inherits 1.24
      // temperatures / shoreHardnessD / transmissionDistance left unset → inherit
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const res = await checkGET({} as NextRequest, params(String(variant._id)));
    const body = await res.json();
    expect(body.linked).toBe(true);
    expect(body.found).toBe(true);
    // Everything matches via the parent → nothing to offer.
    expect(body.changes).toEqual([]);
  });

  it("check: still surfaces a genuine upstream change on an inherited field (GH #607)", async () => {
    // The fix must not over-suppress: when the inherited value differs from
    // what OPT now offers, the change is still surfaced (here density: the
    // variant inherits 1.20 but OPT offers 1.24).
    const parent = await Filament.create({
      name: "Stale Parent",
      vendor: "Prusament",
      type: "PLA",
      density: 1.2,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    });
    const variant = await Filament.create({
      name: "Stale Variant",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d",
      parentId: parent._id,
      density: null, // inherits the parent's stale 1.20
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const res = await checkGET({} as NextRequest, params(String(variant._id)));
    const body = await res.json();
    const density = body.changes.find((c: { field: string }) => c.field === "density");
    expect(density).toBeDefined();
    expect(density.current).toBe(1.2); // the RESOLVED (inherited) value, not null
    expect(density.incoming).toBe(1.24);
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

  it("check/sync: suppress an unapplyable inherited-array clear on a variant (GH #607)", async () => {
    // A variant inherits optTags from its parent and OPT clears them upstream.
    // The clear can't be applied to a variant — writing [] re-inherits the
    // parent's array — so offering it would report a no-op "success" and
    // re-surface on every check. Both routes must suppress it consistently:
    // check omits it, sync rejects it.
    const parent = await Filament.create({
      name: "Tag Parent",
      vendor: "Prusament",
      type: "PLA",
      optTags: [16],
    });
    const variant = await Filament.create({
      name: "Tag Variant",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d",
      parentId: parent._id,
      // optTags unset → inherits [16]
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    // check must NOT offer the optTags clear for the variant.
    const checkRes = await checkGET({} as NextRequest, params(String(variant._id)));
    const checkBody = await checkRes.json();
    expect(
      checkBody.changes.some((c: { field: string }) => c.field === "optTags"),
    ).toBe(false);
    // sync must reject it (consistent with check), not report a no-op success.
    const syncRes = await syncPOST(syncReq(String(variant._id), ["optTags"]), params(String(variant._id)));
    expect(syncRes.status).toBe(400);
    expect((await syncRes.json()).error).toContain("optTags");
  });

  it("check/sync: a ROOT filament's array clear is still offered and applyable (GH #607)", async () => {
    // The variant suppression must NOT over-reach: a root filament with its
    // own optTags that OPT clears can really be cleared, so it stays offered.
    const root = await Filament.create({
      name: "Root Tags PLA",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d",
      density: 1.24,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
      optTags: [16], // OPT offers [] → a real clear
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const checkRes = await checkGET({} as NextRequest, params(String(root._id)));
    const checkBody = await checkRes.json();
    expect(
      checkBody.changes.some((c: { field: string }) => c.field === "optTags"),
    ).toBe(true);
    const syncRes = await syncPOST(syncReq(String(root._id), ["optTags"]), params(String(root._id)));
    expect(syncRes.status).toBe(200);
    const fresh = await Filament.findById(root._id).lean();
    expect(fresh.optTags).toEqual([]); // actually cleared
  });

  it("check/sync: a variant-OWNED array clear over an EMPTY parent stays offered (GH #607)", async () => {
    // The suppression must distinguish inherited from variant-owned arrays:
    // here the parent has no optTags and the variant owns [99], so clearing
    // the variant's array DOES take ([] resolves to the empty parent) — the
    // clear must stay offered and apply (Codex P2 round 4).
    const parent = await Filament.create({
      name: "Empty Parent",
      vendor: "Prusament",
      type: "PLA",
      // no optTags → empty
    });
    const variant = await Filament.create({
      name: "Owned-Tags Variant",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d",
      parentId: parent._id,
      optTags: [99], // the variant's OWN override
      settings: { openprinttag_slug: "prusament-pla-galaxy-black" },
    });
    const checkRes = await checkGET({} as NextRequest, params(String(variant._id)));
    const checkBody = await checkRes.json();
    expect(
      checkBody.changes.some((c: { field: string }) => c.field === "optTags"),
    ).toBe(true);
    const syncRes = await syncPOST(syncReq(String(variant._id), ["optTags"]), params(String(variant._id)));
    expect(syncRes.status).toBe(200);
    const fresh = await Filament.findById(variant._id).lean();
    expect(fresh.optTags).toEqual([]); // own override cleared → inherits empty parent
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

  // ── link an existing filament to OPT (Issue #753, approach C) ─────────

  it("link: writes the slug/uuid + snapshot WITHOUT touching field values", async () => {
    const f = await Filament.create({
      name: "Unlinked PLA",
      vendor: "Generic",
      type: "PLA",
      color: "#112233", // a user value that must survive linking
      density: 1.5, // a user value that differs from OPT's 1.24
    });
    const res = await linkPOST(linkReq(String(f._id), "prusament-pla-galaxy-black"), params(String(f._id)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linked).toBe(true);
    expect(body.slug).toBe("prusament-pla-galaxy-black");

    const fresh = await Filament.findById(f._id).lean();
    // Linkage + provenance written …
    expect(fresh.settings.openprinttag_slug).toBe("prusament-pla-galaxy-black");
    expect(fresh.settings.openprinttag_uuid).toBeTruthy();
    expect(fresh.openprinttagSnapshot.density).toBe(1.24); // full OPT offer
    // … but no field VALUE was changed.
    expect(fresh.color).toBe("#112233");
    expect(fresh.density).toBe(1.5);
  });

  it("link: a subsequent check gap-fills nulls (adopt) and flags diverged values (conflict)", async () => {
    const f = await Filament.create({
      name: "ToLink PLA",
      vendor: "Generic",
      type: "PLA",
      color: "#3d3e3d", // equals OPT → not offered at all
      density: null, // gap-fill → adopt
      temperatures: { nozzle: 200 }, // differs from OPT's 225 → conflict
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    });
    await linkPOST(linkReq(String(f._id), "prusament-pla-galaxy-black"), params(String(f._id)));

    const checkRes = await checkGET({} as NextRequest, params(String(f._id)));
    const changes = (await checkRes.json()).changes as Array<{ field: string; kind: string }>;
    expect(changes.find((c) => c.field === "density")?.kind).toBe("adopt");
    expect(changes.find((c) => c.field === "temperatures.nozzle")?.kind).toBe("conflict");
    // A field equal to OPT isn't surfaced.
    expect(changes.some((c) => c.field === "color")).toBe(false);
  });

  it("link: a variant's inherited-equal field isn't offered; a diverged one is (variant-aware)", async () => {
    const parent = await Filament.create({
      name: "Link Parent PLA",
      vendor: "Prusament",
      type: "PLA",
      density: 1.24, // equals OPT
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    });
    const variant = await Filament.create({
      name: "Link Variant PLA",
      vendor: "Prusament",
      type: "PLA",
      color: "#3d3e3d",
      parentId: parent._id,
      density: null, // inherits 1.24 (equals OPT) → must NOT be offered
      temperatures: { nozzle: 210 }, // variant override differs from OPT 225 → offered
    });
    const res = await linkPOST(linkReq(String(variant._id), "prusament-pla-galaxy-black"), params(String(variant._id)));
    expect(res.status).toBe(200);

    const checkRes = await checkGET({} as NextRequest, params(String(variant._id)));
    const changes = (await checkRes.json()).changes as Array<{ field: string }>;
    // Inherited density already equals OPT → not offered (no overwrite of
    // inherited identical values — the issue's explicit requirement).
    expect(changes.some((c) => c.field === "density")).toBe(false);
    // The variant's own diverged nozzle temp IS surfaced.
    expect(changes.some((c) => c.field === "temperatures.nozzle")).toBe(true);
  });

  it("link: 404 when the slug is gone upstream", async () => {
    const f = await Filament.create({ name: "Gone Link", vendor: "X", type: "PLA" });
    const res = await linkPOST(linkReq(String(f._id), "no-such-slug"), params(String(f._id)));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.linked).toBe(false);
    expect(body.found).toBe(false);
    const fresh = await Filament.findById(f._id).lean();
    expect(fresh.settings?.openprinttag_slug).toBeUndefined(); // no dangling link
  });

  it("link: 400 on a missing/empty slug", async () => {
    const f = await Filament.create({ name: "Bad Link", vendor: "X", type: "PLA" });
    const res = await linkPOST(linkReq(String(f._id), ""), params(String(f._id)));
    expect(res.status).toBe(400);
  });

  it("link: 404 for an unknown filament", async () => {
    const ghost = new mongoose.Types.ObjectId().toString();
    const res = await linkPOST(linkReq(ghost, "prusament-pla-galaxy-black"), params(ghost));
    expect(res.status).toBe(404);
  });

  it("link: rejects a cross-origin (CSRF) request before mutating", async () => {
    const f = await Filament.create({ name: "CSRF Link", vendor: "X", type: "PLA" });
    const res = await linkPOST(
      linkReq(String(f._id), "prusament-pla-galaxy-black", { "sec-fetch-site": "cross-site" }),
      params(String(f._id)),
    );
    expect(res.status).toBe(403);
    const fresh = await Filament.findById(f._id).lean();
    expect(fresh.settings?.openprinttag_slug).toBeUndefined();
  });

  // ── import AS A VARIANT (Issue #753, approach A) ──────────────────────

  it("import-variant: prunes fields equal to the parent, keeps distinct color, links + resolves clean", async () => {
    const parent = await Filament.create({
      name: "Variant Import Parent",
      vendor: "Prusament",
      type: "PLA",
      density: 1.24, // equals OPT → pruned
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    });
    const importRes = await importPOST(
      importReq({ slugs: ["prusament-pla-galaxy-black"], parentId: String(parent._id) }),
    );
    expect(importRes.status).toBe(200);
    const body = await importRes.json();
    expect(body.created).toBe(1);
    expect(body.filament).toBeTruthy();

    const variant = await Filament.findById(body.filament._id).lean();
    expect(String(variant.parentId)).toBe(String(parent._id));
    // Distinct field kept: color is variant-only and the variant's own.
    expect(variant.color).toBe("#3d3e3d");
    // Pruned scalars dropped → null/undefined so they inherit.
    expect(variant.density ?? null).toBeNull();
    expect(variant.shoreHardnessD ?? null).toBeNull();
    expect(variant.transmissionDistance ?? null).toBeNull();
    // Pruned temps nulled.
    expect(variant.temperatures.nozzle ?? null).toBeNull();
    expect(variant.temperatures.bed ?? null).toBeNull();
    // diameter nulled to inherit (mapToFilamentPayload's 1.75 isn't real data).
    expect(variant.diameter ?? null).toBeNull();
    // Linked + provenance present (full offer, incl. the pruned fields).
    expect(variant.settings.openprinttag_slug).toBe("prusament-pla-galaxy-black");
    expect(variant.openprinttagSnapshot.density).toBe(1.24);
    expect(variant.openprinttagSnapshot.temperatures_nozzle).toBe(225);

    // A check right after import → everything matches via inheritance → no changes.
    const checkRes = await checkGET({} as NextRequest, params(String(variant._id)));
    expect((await checkRes.json()).changes).toEqual([]);
  });

  it("import-variant: keeps a field that DIFFERS from the parent (strict equality)", async () => {
    const parent = await Filament.create({
      name: "Differ Parent",
      vendor: "Prusament",
      type: "PLA",
      density: 1.5, // differs from OPT's 1.24 → variant keeps its own 1.24
      temperatures: { nozzle: 200 }, // differs from OPT 225 → variant keeps 225
    });
    const res = await importPOST(
      importReq({ slugs: ["prusament-pla-galaxy-black"], parentId: String(parent._id) }),
    );
    expect(res.status).toBe(200);
    const variant = await Filament.findById((await res.json()).filament._id).lean();
    expect(variant.density).toBe(1.24); // distinct → kept
    expect(variant.temperatures.nozzle).toBe(225); // distinct → kept
  });

  it("import-variant: refuses a name collision with 409 (never re-parents an existing row)", async () => {
    const parent = await Filament.create({ name: "Coll Parent", vendor: "Prusament", type: "PLA" });
    // A pre-existing filament with the same name the OPT material would produce.
    const existing = await Filament.create({
      name: "Prusament PLA Galaxy Black",
      vendor: "Prusament",
      type: "PLA",
    });
    const res = await importPOST(
      importReq({ slugs: ["prusament-pla-galaxy-black"], parentId: String(parent._id) }),
    );
    expect(res.status).toBe(409);
    // The existing row was NOT re-parented or mutated.
    const fresh = await Filament.findById(existing._id).lean();
    expect(fresh.parentId ?? null).toBeNull();
  });

  it("import-variant: 400 when the parent doesn't exist", async () => {
    const ghost = new mongoose.Types.ObjectId().toString();
    const res = await importPOST(importReq({ slugs: ["prusament-pla-galaxy-black"], parentId: ghost }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/parent/i);
  });

  it("import-variant: 400 on a malformed parentId (not an ObjectId)", async () => {
    const res = await importPOST(
      importReq({ slugs: ["prusament-pla-galaxy-black"], parentId: "not-an-id" }),
    );
    expect(res.status).toBe(400);
  });

  it("import-variant: 400 when the parent is itself a variant (no nested inheritance)", async () => {
    const root = await Filament.create({ name: "Root For Nest", vendor: "Prusament", type: "PLA" });
    const mid = await Filament.create({
      name: "Mid Variant",
      vendor: "Prusament",
      type: "PLA",
      parentId: root._id,
    });
    const res = await importPOST(
      importReq({ slugs: ["prusament-pla-galaxy-black"], parentId: String(mid._id) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nested|variant as parent/i);
  });

  it("import-variant: 400 when more than one slug is given with a parent", async () => {
    const parent = await Filament.create({ name: "Multi Parent", vendor: "Prusament", type: "PLA" });
    const res = await importPOST(
      importReq({ slugs: ["prusament-pla-galaxy-black", "another"], parentId: String(parent._id) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/one slug/i);
  });
});
