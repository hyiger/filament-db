import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import { PUT as updateFilament } from "@/app/api/filaments/[id]/route";
import { MAX_SETTINGS_KEYS, MAX_SETTING_VALUE_LENGTH } from "@/lib/slicerSettings";

/**
 * GH #1072 — the generic filament POST/PUT routes skipped four validations
 * the specialized paths enforce:
 *
 *   1. Non-finite spool totalWeight persisted (JSON.parse("1e309") ===
 *      Infinity; the schema's min:0 is the only guard and Infinity satisfies
 *      it) and then blanked the /api/spools/by-location $sum.
 *   2. The GH #266 settings-bag caps were only reachable via
 *      mergeSlicerSettings (slicer sync routes) — the generic routes accepted
 *      an unbounded Mixed bag.
 *   3. The mass-assignment strips were exact-key only — dotted update paths
 *      (`spools.0.usageHistory`, `openprinttagSnapshot.color`) bypassed them.
 *   4. Junk-typed tagData string fields threw a 500 out of the
 *      create-from-tag branch (covered at the unit level in
 *      decodedTagToFilament.test.ts; the route-level 201 is pinned here).
 */
describe("GH #1072 — generic filament route validation", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    const locMod = await import("@/models/Location");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    if (!mongoose.models.Location) mongoose.model("Location", locMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function postReq(body: unknown) {
    return rawPostReq(JSON.stringify(body));
  }

  /** Raw-string variant so tests can send `1e309` — JSON.stringify would
   * serialize Infinity as null, hiding the exact wire shape under test. */
  function rawPostReq(json: string) {
    return new NextRequest("http://localhost/api/filaments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    });
  }

  function putReq(id: string, body: unknown) {
    return rawPutReq(id, JSON.stringify(body));
  }

  function rawPutReq(id: string, json: string) {
    return new NextRequest(`http://localhost/api/filaments/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: json,
    });
  }

  async function putRoute(id: string, body: unknown) {
    return updateFilament(putReq(id, body), { params: Promise.resolve({ id }) });
  }

  // ---------------------------------------------------------------- item 1

  it("POST rejects a non-finite top-level totalWeight (1e309 → Infinity)", async () => {
    const res = await createFilament(
      rawPostReq('{"name":"Inf-Top","vendor":"V","type":"PLA","totalWeight":1e309}'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/totalWeight must be a finite number or null/);
    expect(await Filament.countDocuments({ name: "Inf-Top" })).toBe(0);
  });

  it("POST rejects a non-numeric and a negative top-level totalWeight", async () => {
    const str = await createFilament(
      postReq({ name: "Str-Top", vendor: "V", type: "PLA", totalWeight: "500" }),
    );
    expect(str.status).toBe(400);
    const neg = await createFilament(
      postReq({ name: "Neg-Top", vendor: "V", type: "PLA", totalWeight: -5 }),
    );
    expect(neg.status).toBe(400);
    expect((await neg.json()).error).toMatch(/non-negative/);
  });

  it("POST rejects non-finite / non-numeric / negative embedded-spool totalWeight", async () => {
    const inf = await createFilament(
      rawPostReq(
        '{"name":"Inf-Spool","vendor":"V","type":"PLA","spools":[{"label":"a","totalWeight":1e309}]}',
      ),
    );
    expect(inf.status).toBe(400);
    expect((await inf.json()).error).toMatch(/spools\[0\]: totalWeight must be a finite number or null/);

    const str = await createFilament(
      postReq({ name: "Str-Spool", vendor: "V", type: "PLA", spools: [{ totalWeight: "abc" }] }),
    );
    expect(str.status).toBe(400);

    const neg = await createFilament(
      postReq({
        name: "Neg-Spool",
        vendor: "V",
        type: "PLA",
        spools: [{ totalWeight: 100 }, { totalWeight: -1 }],
      }),
    );
    expect(neg.status).toBe(400);
    expect((await neg.json()).error).toMatch(/spools\[1\]: totalWeight must be non-negative/);
  });

  it("POST still accepts a valid / null spool totalWeight (non-regression)", async () => {
    const res = await createFilament(
      postReq({
        name: "Valid-Spools",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "a", totalWeight: 1000 }, { label: "b", totalWeight: null }],
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.spools).toHaveLength(2);
    expect(created.spools[0].totalWeight).toBe(1000);
    expect(created.spools[1].totalWeight).toBeNull();
  });

  it("POST create-from-tag ignores a non-finite spoolRemainingGrams (no spool rather than a bad one)", async () => {
    // Same pinned posture as a negative value (create-from-tag-route.test.ts):
    // the filament is created, the spool is not. The auto-create finite check
    // is the backstop for anything that computes into totalWeight.
    const res = await createFilament(
      rawPostReq(
        '{"tagData":{"meta":{},"main":{},"brandName":"B","materialName":"Inf Roll","materialType":"PLA","emptySpoolWeight":200},"spoolRemainingGrams":1e309}',
      ),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.spools ?? []).toHaveLength(0);
  });

  // ---------------------------------------------------------------- item 2

  it("POST rejects an oversize settings value and an over-count settings bag", async () => {
    const oversize = await createFilament(
      postReq({
        name: "Big-Settings",
        vendor: "V",
        type: "PLA",
        settings: { blob: "x".repeat(MAX_SETTING_VALUE_LENGTH + 1) },
      }),
    );
    expect(oversize.status).toBe(400);
    expect((await oversize.json()).error).toMatch(/settings\.blob/);

    const bag: Record<string, number> = {};
    for (let i = 0; i < MAX_SETTINGS_KEYS + 1; i++) bag[`k_${i}`] = i;
    const overCount = await createFilament(
      postReq({ name: "Many-Settings", vendor: "V", type: "PLA", settings: bag }),
    );
    expect(overCount.status).toBe(400);
    expect((await overCount.json()).error).toMatch(new RegExp(`${MAX_SETTINGS_KEYS}-key`));
  });

  it("POST rejects a non-object settings bag", async () => {
    const res = await createFilament(
      postReq({ name: "String-Settings", vendor: "V", type: "PLA", settings: "junk" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/settings must be an object/);
  });

  it("POST still persists a normal settings bag (non-regression)", async () => {
    const res = await createFilament(
      postReq({
        name: "Ok-Settings",
        vendor: "V",
        type: "PLA",
        settings: { filament_notes: "smooth", custom: "1" },
      }),
    );
    expect(res.status).toBe(201);
    const doc = await Filament.findOne({ name: "Ok-Settings" }).lean();
    expect(doc.settings).toMatchObject({ filament_notes: "smooth", custom: "1" });
  });

  it("PUT rejects an oversize settings value — whole-object AND dotted forms", async () => {
    const doc = await Filament.create({ name: "Put-Settings", vendor: "V", type: "PLA" });
    const id = String(doc._id);

    const whole = await putRoute(id, {
      settings: { blob: "x".repeat(MAX_SETTING_VALUE_LENGTH + 1) },
    });
    expect(whole.status).toBe(400);
    expect((await whole.json()).error).toMatch(/settings\.blob/);

    const dotted = await putRoute(id, {
      "settings.blob": "x".repeat(MAX_SETTING_VALUE_LENGTH + 1),
    });
    expect(dotted.status).toBe(400);
    expect((await dotted.json()).error).toMatch(/settings\.blob/);

    const stored = await Filament.findById(id).lean();
    expect(stored.settings?.blob).toBeUndefined();
  });

  it("PUT bounds dotted settings writes against the STORED bag's key count", async () => {
    const bag: Record<string, number> = {};
    for (let i = 0; i < MAX_SETTINGS_KEYS; i++) bag[`k_${i}`] = i;
    const doc = await Filament.create({
      name: "Full-Bag",
      vendor: "V",
      type: "PLA",
      settings: bag,
    });
    const id = String(doc._id);

    // A NEW key on an at-cap bag → the merged count exceeds the cap → 400.
    const grow = await putRoute(id, { "settings.newkey": 1 });
    expect(grow.status).toBe(400);
    expect((await grow.json()).error).toMatch(new RegExp(`${MAX_SETTINGS_KEYS}-key`));

    // Overwriting an EXISTING key doesn't grow the bag → allowed.
    const overwrite = await putRoute(id, { "settings.k_0": 999 });
    expect(overwrite.status).toBe(200);
    const stored = await Filament.findById(id).lean();
    expect(stored.settings.k_0).toBe(999);
  });

  it("PUT still accepts an in-cap dotted settings write (non-regression)", async () => {
    const doc = await Filament.create({
      name: "Dotted-Ok",
      vendor: "V",
      type: "PLA",
      settings: { keep: "yes" },
    });
    const res = await putRoute(String(doc._id), { "settings.added": "fine" });
    expect(res.status).toBe(200);
    const stored = await Filament.findById(doc._id).lean();
    expect(stored.settings).toMatchObject({ keep: "yes", added: "fine" });
  });

  // ---------------------------------------------------------------- item 3

  it("PUT sweeps dotted spool paths — the GH #260 hard guarantee holds for `spools.0.*`", async () => {
    const createRes = await createFilament(
      postReq({ name: "Spool-Target", vendor: "V", type: "PLA", totalWeight: 800 }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const id = String(created._id);
    const originalInstanceId = created.spools[0].instanceId;
    expect(originalInstanceId).toBeTruthy();

    const res = await putRoute(id, {
      "spools.0.instanceId": "forged-id",
      "spools.0.usageHistory": [{ date: "2026-01-01", grams: 5, source: "manual" }],
      "spools.0.totalWeight": 1,
    });
    expect(res.status).toBe(200);

    const stored = await Filament.findById(id).lean();
    expect(stored.spools).toHaveLength(1);
    expect(stored.spools[0].instanceId).toBe(originalInstanceId);
    expect(stored.spools[0].totalWeight).toBe(800);
    expect(stored.spools[0].usageHistory ?? []).toHaveLength(0);
  });

  it("PUT sweeps dotted openprinttagSnapshot paths (server-owned OPT provenance)", async () => {
    const doc = await Filament.create({ name: "Snapshot-Target", vendor: "V", type: "PLA" });
    const res = await putRoute(String(doc._id), {
      "openprinttagSnapshot.color": "#123456",
      "openprinttagSnapshot.density": 1.24,
    });
    expect(res.status).toBe(200);
    const stored = await Filament.findById(doc._id).lean();
    // The schema defaults the snapshot to null — a forged dotted write must
    // not have materialized it.
    expect(stored.openprinttagSnapshot ?? null).toBeNull();
  });

  it("PUT still strips the exact server-owned keys (non-regression of the pre-#1072 strip)", async () => {
    const doc = await Filament.create({
      name: "Exact-Strip",
      vendor: "V",
      type: "PLA",
      spools: [{ label: "real", totalWeight: 500 }],
    });
    const res = await putRoute(String(doc._id), {
      name: "Exact-Strip",
      spools: [], // GH #260: never editable through the PUT
      _purged: true, // GH #222
      instanceId: "forged",
    });
    expect(res.status).toBe(200);
    const stored = await Filament.findById(doc._id).lean();
    expect(stored.spools).toHaveLength(1);
    expect(stored._purged ?? false).toBe(false);
    expect(stored.instanceId).not.toBe("forged");
  });

  it("POST sweeps dotted server-owned paths while keeping the exact `spools` allowlist path", async () => {
    const res = await createFilament(
      postReq({
        name: "Post-Dotted",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "legit", totalWeight: 750 }],
        "spools.0.usageHistory": [{ grams: 5 }],
        "openprinttagSnapshot.color": "#abcdef",
        "_purged.sub": true,
      }),
    );
    expect(res.status).toBe(201);
    const stored = await Filament.findOne({ name: "Post-Dotted" }).lean();
    expect(stored.spools).toHaveLength(1);
    expect(stored.spools[0].totalWeight).toBe(750);
    expect(stored.spools[0].usageHistory ?? []).toHaveLength(0);
    expect(stored.openprinttagSnapshot ?? null).toBeNull();
    expect(stored._purged ?? false).toBe(false);
  });

  // ---------------------------------------------------------------- item 4

  it("POST create-from-tag returns 201 (not 500) for junk-typed tagData fields", async () => {
    const res = await createFilament(
      postReq({
        tagData: {
          meta: {},
          main: {},
          brandName: 123,
          materialName: { nested: true },
          materialType: [1, 2],
          color: { r: 255 },
          colorName: true,
        },
        overrides: { name: "Junk Tag", vendor: "V", type: "PLA" },
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.name).toBe("Junk Tag");
    expect(created.color).toBe("#808080"); // junk color → gray fallback
  });
});
