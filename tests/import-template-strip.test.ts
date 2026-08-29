import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { upsertImportRows } from "@/lib/importFilaments";
import { POST as importCsv } from "@/app/api/filaments/import-csv/route";

/**
 * GH #605 — the TEMPLATE strip on the two remaining importer write paths that
 * could still $set per-variant fields onto an EXISTING template:
 *
 *  1. CSV/XLSX importer (`upsertImportRows`, existing-active-row updates):
 *     a name-matched row echoing the promoted-away color/colorName back
 *     re-materialized them on the template. Now stripped inside the
 *     per-filament mutex (the round-3 parent-gate lock only covers the
 *     create/resurrect branch) and reported as a per-row note on the
 *     result's `errors` channel — the row itself still updates (atlas
 *     posture). Explicit nulls still pass (an EMPTY Color Name cell is
 *     legitimate cleanup, same semantics as the PUT).
 *
 *  2. POST /api/openprinttag/import (bulk mode): `applyConditionalDefaults`
 *     backfills `color` when the existing row still carries the '#808080'
 *     sentinel — which a LEGACY (pre-#605) template can. Now stripped in the
 *     same lock+strip pattern; the non-strip backfills (density, drying, …)
 *     still apply, and create mode is untouched.
 *
 * The sibling slicer-sync paths are pinned in
 * tests/slicer-sync-template-strip.test.ts; the strip helper's null
 * pass-through in tests/templateStrip.test.ts.
 */

// ── OpenPrintTag upstream mock (bulk-import tests) ──────────────────────────

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

describe("GH #605 — importer template strip (residual gaps)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  let optImport: typeof import("@/app/api/openprinttag/import/route").POST;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
    optImport = (await import("@/app/api/openprinttag/import/route")).POST;

    dbMock.mockReset();
    dbMock.mockResolvedValue({
      brands: [],
      materials: [UPSTREAM_MATERIAL],
      cachedAt: new Date(0).toISOString(),
      totalFFF: 1,
      totalSLA: 0,
    });
  });

  async function seedTemplate(name: string, extra: Record<string, unknown> = {}) {
    // `color: null` is the promoted-template shape (#605 promotion moves the
    // color onto the variant); the legacy tests override it via `extra`.
    const parent = await Filament.create({ name, vendor: "T", type: "PLA", color: null, ...extra });
    const variant = await Filament.create({
      name: `${name} — Red`,
      vendor: "T",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });
    return { parent, variant };
  }

  // ── 1. CSV/XLSX importer — upsertImportRows existing-row updates ──────────

  describe("CSV/XLSX importer (upsertImportRows)", () => {
    it("strips Color + Color Name on a template; the row still updates; per-row note", async () => {
      const { parent } = await seedTemplate("CSV Template PLA");

      const result = await upsertImportRows([
        {
          name: "CSV Template PLA",
          vendor: "T",
          type: "PLA",
          color: "#00FF00",
          colorName: "Green",
          cost: 9.99,
        },
      ]);

      expect(result.updated).toBe(1); // the strip must not fail the row
      expect(result.skipped).toBe(0);
      expect(result.skippedRows).toEqual([]);
      expect(result.errors).toHaveLength(1);
      // TEMPLATE_STRIP_FIELDS order: color before colorName.
      expect(result.errors![0]).toMatch(/^Row 2 "CSV Template PLA": skipped color, colorName/);
      expect(result.errors![0]).toMatch(/template/i);

      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color ?? null).toBeNull(); // template stays colorless
      expect(fresh.colorName ?? null).toBeNull();
      expect(fresh.cost).toBe(9.99); // the rest of the row still applied
    });

    it("keeps a LEGACY template's stored color/colorName pair unchanged", async () => {
      // A pre-#605 carrying parent: still holds a color/colorName pair.
      const { parent } = await seedTemplate("Legacy CSV PETG", {
        color: "#FF0000",
        colorName: "Red",
      });

      const result = await upsertImportRows([
        { name: "Legacy CSV PETG", vendor: "T", type: "PLA", color: "#00FF00", colorName: "Green" },
      ]);

      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(1);
      const fresh = await Filament.findById(parent._id).lean();
      // Stripped means "not applied": the legacy pair survives INTACT.
      expect(fresh.color).toBe("#FF0000");
      expect(fresh.colorName).toBe("Red");
    });

    it("an EMPTY Color Name cell (explicit null) still clears a legacy template's colorName", async () => {
      // rowToImport maps a present-but-empty cell to null; the strip's
      // explicit-null pass-through means clearing a legacy leftover is
      // legitimate cleanup (same semantics as the PUT).
      const { parent } = await seedTemplate("Legacy CSV ASA", {
        color: "#FF0000",
        colorName: "Red",
      });

      const result = await upsertImportRows([
        { name: "Legacy CSV ASA", vendor: "T", type: "PLA", colorName: null },
      ]);

      expect(result.updated).toBe(1);
      expect(result.errors).toBeUndefined(); // a null write isn't a strip
      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.colorName ?? null).toBeNull(); // the null passed through
      expect(fresh.color).toBe("#FF0000"); // color untouched (row didn't carry one)
    });

    it("still applies color/colorName to a NON-template (no errors channel)", async () => {
      const f = await Filament.create({
        name: "CSV Solo PLA",
        vendor: "T",
        type: "PLA",
        color: "#FF0000",
        colorName: "Red",
      });

      const result = await upsertImportRows([
        { name: "CSV Solo PLA", vendor: "T", type: "PLA", color: "#00FF00", colorName: "Green" },
      ]);

      expect(result.updated).toBe(1);
      expect(result.errors).toBeUndefined();
      const fresh = await Filament.findById(f._id).lean();
      expect(fresh.color).toBe("#00FF00");
      expect(fresh.colorName).toBe("Green");
    });

    it("a template's VARIANT still receives an imported colour (variants are never templates)", async () => {
      const { variant } = await seedTemplate("CSV Family PLA");

      const result = await upsertImportRows([
        { name: "CSV Family PLA — Red", vendor: "T", type: "PLA", color: "#0000FF" },
      ]);

      expect(result.updated).toBe(1);
      expect(result.errors).toBeUndefined();
      expect((await Filament.findById(variant._id).lean()).color).toBe("#0000FF");
    });

    it("route surface: /api/filaments/import-csv carries the notes and counts them in the message", async () => {
      await seedTemplate("Route Template PLA");

      const csv = 'Name,Vendor,Type,Color\n"Route Template PLA",T,PLA,#00FF00\n';
      const fd = new FormData();
      fd.append("file", new File([csv], "filaments.csv", { type: "text/csv" }));
      const res = await importCsv(
        new NextRequest("http://localhost/api/filaments/import-csv", { method: "POST", body: fd }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatch(/skipped color/);
      expect(body.message).toMatch(/1 note\(s\)\./);
    });
  });

  // ── 2. POST /api/openprinttag/import — conditional-defaults backfill ──────

  describe("OpenPrintTag bulk import (POST /api/openprinttag/import)", () => {
    function importReq(slugs: string[]) {
      return new NextRequest("http://localhost:3456/api/openprinttag/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slugs }),
      });
    }

    it("does NOT backfill color onto a legacy template still carrying the '#808080' sentinel; reports; other backfills still apply", async () => {
      // A pre-#605 template: promoted rows have color null, but a legacy
      // parent that predates the model still carries the schema-default
      // sentinel — exactly the state applyConditionalDefaults keys on.
      const parent = await Filament.create({
        name: "Prusament PLA Galaxy Black",
        vendor: "Prusament",
        type: "PLA",
        color: "#808080",
      });
      await Filament.create({
        name: "Prusament PLA Galaxy Black — Red",
        vendor: "Prusament",
        type: "PLA",
        color: "#FF0000",
        parentId: parent._id,
      });

      const res = await optImport(importReq(["prusament-pla-galaxy-black"]));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1); // the strip must not fail the row
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatch(/^PLA Galaxy Black: skipped color/);
      expect(body.errors[0]).toMatch(/template/i);

      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color).toBe("#808080"); // legacy sentinel untouched, not the OPT color
      expect(fresh.density).toBe(1.24); // non-strip backfills still applied
      expect(fresh.openprinttagSnapshot).toBeTruthy(); // linkage write untouched
    });

    it("still backfills color onto a NON-template carrying the sentinel (no note)", async () => {
      const f = await Filament.create({
        name: "Prusament PLA Galaxy Black",
        vendor: "Prusament",
        type: "PLA",
        // color omitted → schema default "#808080"
      });

      const res = await optImport(importReq(["prusament-pla-galaxy-black"]));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toBeUndefined();

      const fresh = await Filament.findById(f._id).lean();
      expect(fresh.color).toBe("#3d3e3d");
      expect(fresh.density).toBe(1.24);
    });

    it("a template's VARIANT still receives the backfill (variants are never templates)", async () => {
      const parent = await Filament.create({
        name: "OPT Family PLA",
        vendor: "Prusament",
        type: "PLA",
        color: null,
      });
      const variant = await Filament.create({
        name: "Prusament PLA Galaxy Black",
        vendor: "Prusament",
        type: "PLA",
        color: "#808080",
        parentId: parent._id,
      });

      const res = await optImport(importReq(["prusament-pla-galaxy-black"]));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toBeUndefined();
      expect((await Filament.findById(variant._id).lean()).color).toBe("#3d3e3d");
    });
  });
});
