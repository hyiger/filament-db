import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as prusaSync } from "@/app/api/filaments/[id]/route";
import { POST as orcaSync } from "@/app/api/filaments/[id]/orcaslicer/route";
import { POST as bambuSyncById } from "@/app/api/filaments/[id]/bambustudio/route";
import { POST as bambuBulk } from "@/app/api/filaments/bambustudio/route";
import { POST as prusaBulk } from "@/app/api/filaments/prusaslicer/route";
import { POST as iniImport } from "@/app/api/filaments/import/route";

/**
 * GH #605 (codex P2, slicer-sync sweep) — the TEMPLATE strip on slicer
 * sync-back writes.
 *
 * A filament with ≥1 live variant is a TEMPLATE and must not carry
 * per-variant color/inventory (`TEMPLATE_STRIP_FIELDS`,
 * src/lib/templateStrip.ts). The PUT has stripped those since round 4 — but
 * every slicer sync path (PrusaSlicer per-id/name POST, OrcaSlicer POST,
 * Bambu per-id + bulk, the INI bulk importers) echoes the preset's colour
 * key back on every sync, so a template target used to re-materialize
 * `color` through them. These tests pin, per path:
 *   - a template target keeps `color` null after a sync carrying a colour;
 *   - a template's stored LEGACY color/colorName pair survives unchanged
 *     (the strip means "not applied", and the derived GH #885 colorName
 *     clear is dropped along with the stripped color);
 *   - a non-template target still applies the colour normally;
 *   - the strip is REPORTED — `_strippedTemplateFields` on the per-id
 *     routes' envelopes (the PUT's key), a per-row note in the bulk
 *     importers' `errors` channel (atlas posture; the row still applies).
 *
 * No slicer format can express an explicit NULL colour (INI `nil` collapses
 * to the parser default, Orca/Bambu gate on string/non-null), so the
 * explicit-null pass-through half of the semantics is pinned at the helper
 * level in tests/templateStrip.test.ts (and for the PUT in
 * tests/template-guards-route.test.ts).
 */
describe("GH #605 — slicer sync template strip", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function jsonReq(url: string, body: unknown) {
    return new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function seedTemplate(name = "Template PLA", extra: Record<string, unknown> = {}) {
    // `color: null` is the promoted-template shape (#605 promotion moves the
    // color onto the variant); the schema would otherwise default "#808080".
    // The legacy-carrying-parent tests override it via `extra`.
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

  // ── POST /api/filaments/[id] — PrusaSlicer sync-back ──────────────────────

  describe("PrusaSlicer sync (POST /api/filaments/[id])", () => {
    it("name-addressed: strips filament_colour on a template, applies the rest, reports", async () => {
      const { parent } = await seedTemplate();

      const res = await prusaSync(
        jsonReq(`http://localhost/api/filaments/Template%20PLA`, {
          name: "Template PLA",
          config: { filament_colour: "#00FF00", filament_cost: "9.99" },
        }),
        { params: Promise.resolve({ id: "Template PLA" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body._strippedTemplateFields).toEqual(["color"]);

      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color ?? null).toBeNull(); // template stays colorless
      expect(fresh.cost).toBe(9.99); // the rest of the preset still applied
    });

    it("id-addressed (authoritative ObjectId URL): same strip + report", async () => {
      const { parent } = await seedTemplate("Template ASA");

      const res = await prusaSync(
        jsonReq(`http://localhost/api/filaments/${parent._id}`, {
          name: "Template ASA",
          config: { filament_colour: "#00FF00" },
        }),
        { params: Promise.resolve({ id: String(parent._id) }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.matchedBy).toBe("id");
      expect(body._strippedTemplateFields).toEqual(["color"]);
      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color ?? null).toBeNull();
    });

    it("keeps a LEGACY template's stored color AND colorName unchanged (derived colorName clear dropped)", async () => {
      // A pre-#605 carrying parent: still holds a color/colorName pair.
      const { parent } = await seedTemplate("Legacy PETG", {
        color: "#FF0000",
        colorName: "Red",
      });

      const res = await prusaSync(
        jsonReq(`http://localhost/api/filaments/Legacy%20PETG`, {
          name: "Legacy PETG",
          config: { filament_colour: "#00FF00" },
        }),
        { params: Promise.resolve({ id: "Legacy PETG" }) },
      );

      expect(res.status).toBe(200);
      expect((await res.json())._strippedTemplateFields).toEqual(["color"]);
      const fresh = await Filament.findById(parent._id).lean();
      // Stripped means "not applied": the legacy pair survives INTACT — the
      // GH #885 colorName-null is derived from the color write, so it goes
      // with it (otherwise the template would keep the color but lose its name).
      expect(fresh.color).toBe("#FF0000");
      expect(fresh.colorName).toBe("Red");
    });

    it("still applies the colour (and the GH #885 name clear) to a NON-template", async () => {
      const f = await Filament.create({
        name: "Standalone PLA",
        vendor: "T",
        type: "PLA",
        color: "#FF0000",
        colorName: "Red",
      });

      const res = await prusaSync(
        jsonReq(`http://localhost/api/filaments/Standalone%20PLA`, {
          name: "Standalone PLA",
          config: { filament_colour: "#00FF00" },
        }),
        { params: Promise.resolve({ id: "Standalone PLA" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body._strippedTemplateFields).toBeUndefined();
      const fresh = await Filament.findById(f._id).lean();
      expect(fresh.color).toBe("#00FF00");
      expect(fresh.colorName ?? null).toBeNull(); // hex changed → stale name cleared
    });

    it("a template's VARIANT still receives a synced colour (variants are never templates)", async () => {
      const { variant } = await seedTemplate("Family PLA");

      const res = await prusaSync(
        jsonReq(`http://localhost/api/filaments/${variant._id}`, {
          name: variant.name,
          config: { filament_colour: "#0000FF" },
        }),
        { params: Promise.resolve({ id: String(variant._id) }) },
      );

      expect(res.status).toBe(200);
      expect((await res.json())._strippedTemplateFields).toBeUndefined();
      const fresh = await Filament.findById(variant._id).lean();
      expect(fresh.color).toBe("#0000FF");
    });
  });

  // ── POST /api/filaments/[id]/orcaslicer ───────────────────────────────────

  describe("OrcaSlicer sync (POST /api/filaments/[id]/orcaslicer)", () => {
    it("strips color on a template, applies the rest, reports (and `updated` excludes it)", async () => {
      const { parent } = await seedTemplate("Orca Template");

      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${parent._id}/orcaslicer`, {
          color: "#00FF00",
          cost: 5,
        }),
        { params: Promise.resolve({ id: String(parent._id) }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body._strippedTemplateFields).toEqual(["color"]);
      expect(body.updated).not.toContain("color");
      expect(body.updated).toContain("cost");

      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color ?? null).toBeNull();
      expect(fresh.cost).toBe(5);
    });

    it("still applies color to a NON-template", async () => {
      const f = await Filament.create({ name: "Orca Solo", vendor: "T", type: "PLA" });

      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, { color: "#00FF00" }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body._strippedTemplateFields).toBeUndefined();
      expect(body.updated).toContain("color");
      expect((await Filament.findById(f._id).lean()).color).toBe("#00FF00");
    });
  });

  // ── Bambu Studio — per-id sync + bulk import ──────────────────────────────

  function bambuProfile(name: string, overrides: Record<string, unknown> = {}) {
    return {
      type: "filament",
      from: "User",
      filament_settings_id: [name],
      filament_type: ["PLA"],
      filament_vendor: ["T"],
      filament_colour: ["#00FF00"],
      ...overrides,
    };
  }

  describe("Bambu Studio per-id sync (POST /api/filaments/[id]/bambustudio)", () => {
    it("strips color on a template and reports; the rest still applies", async () => {
      const { parent } = await seedTemplate("Bambu Template");

      const res = await bambuSyncById(
        jsonReq(
          `http://localhost/api/filaments/${parent._id}/bambustudio`,
          bambuProfile("Renamed In Slicer", { filament_cost: ["19.5"] }),
        ),
        { params: Promise.resolve({ id: String(parent._id) }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
      expect(body._strippedTemplateFields).toEqual(["color"]);

      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color ?? null).toBeNull();
      expect(fresh.cost).toBe(19.5);
    });

    it("still applies color to a NON-template", async () => {
      const f = await Filament.create({ name: "Bambu Solo", vendor: "T", type: "PLA" });

      const res = await bambuSyncById(
        jsonReq(
          `http://localhost/api/filaments/${f._id}/bambustudio`,
          bambuProfile("Bambu Solo"),
        ),
        { params: Promise.resolve({ id: String(f._id) }) },
      );

      expect(res.status).toBe(200);
      expect((await res.json())._strippedTemplateFields).toBeUndefined();
      expect((await Filament.findById(f._id).lean()).color).toBe("#00FF00");
    });
  });

  describe("Bambu Studio bulk import (POST /api/filaments/bambustudio)", () => {
    it("strips color when the name-matched target is a template and reports on the envelope", async () => {
      const { parent } = await seedTemplate("Bulk Bambu Template");

      const res = await bambuBulk(
        jsonReq(
          "http://localhost/api/filaments/bambustudio",
          bambuProfile("Bulk Bambu Template", { filament_cost: ["7.25"] }),
        ),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true); // the strip must not fail the row
      expect(body._strippedTemplateFields).toEqual(["color"]);

      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color ?? null).toBeNull();
      expect(fresh.cost).toBe(7.25);
    });

    it("still applies color on a NON-template update (no report key)", async () => {
      const f = await Filament.create({ name: "Bulk Bambu Solo", vendor: "T", type: "PLA" });

      const res = await bambuBulk(
        jsonReq("http://localhost/api/filaments/bambustudio", bambuProfile("Bulk Bambu Solo")),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body._strippedTemplateFields).toBeUndefined();
      expect((await Filament.findById(f._id).lean()).color).toBe("#00FF00");
    });
  });

  // ── INI bulk importers (shared upsertIniFilament) ─────────────────────────

  function iniReq(ini: string) {
    return new NextRequest("http://localhost/api/filaments/prusaslicer", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: ini,
    });
  }

  describe("INI bulk import (POST /api/filaments/prusaslicer + /api/filaments/import)", () => {
    it("strips filament_colour on a name-matched template; row still updates; per-row note", async () => {
      const { parent } = await seedTemplate("Ini Template PLA");

      const res = await prusaBulk(
        iniReq(
          `[filament:Ini Template PLA]\nfilament_colour = #00FF00\nfilament_cost = 9.99\n`,
        ),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1); // the strip must not fail the row
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatch(/^Ini Template PLA: skipped color/);
      expect(body.errors[0]).toMatch(/template/i);

      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color ?? null).toBeNull();
      expect(fresh.cost).toBe(9.99); // the rest of the section still applied
    });

    it("still applies filament_colour to a NON-template (no note)", async () => {
      const f = await Filament.create({ name: "Ini Solo PLA", vendor: "T", type: "PLA" });

      const res = await prusaBulk(
        iniReq(`[filament:Ini Solo PLA]\nfilament_colour = #00FF00\n`),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect((await Filament.findById(f._id).lean()).color).toBe("#00FF00");
    });

    it("the multipart UI importer reports the same per-row note (shared applier)", async () => {
      const { parent } = await seedTemplate("Upload Template PLA");

      const fd = new FormData();
      fd.append(
        "file",
        new File(
          [`[filament:Upload Template PLA]\nfilament_colour = #00FF00\n`],
          "bundle.ini",
          { type: "text/plain" },
        ),
      );
      const res = await iniImport(
        new NextRequest("http://localhost/api/filaments/import", { method: "POST", body: fd }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatch(/^Upload Template PLA: skipped color/);

      const fresh = await Filament.findById(parent._id).lean();
      expect(fresh.color ?? null).toBeNull();
    });
  });
});

/**
 * GH #1116 (Codex P1, round 28) — a name-addressed sync must reach the row the
 * slicer actually named.
 *
 * `name` carries `trim: true`, and a Mongoose String setter casts QUERY values.
 * So with both "X" and "X " active — the state an unresolved trim migration
 * leaves — a preset addressed as "X " casts to "X" and selects the CANONICAL
 * row. The sync then writes the preset's settings onto a DIFFERENT filament.
 *
 * Before the setter this query matched "X " exactly, so the redirection is
 * introduced by the schema change; removing create-on-404 does not help,
 * because nothing is created — the wrong record is simply overwritten.
 */
describe("GH #1116 — a name-addressed sync resolves the EXACT stored spelling", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
    await Filament.collection.deleteMany({});
  });

  /** Both spellings active — what a skipped/blocked trim pass leaves behind.
   *  Written with the raw driver, because the setter would trim the second. */
  async function seedBothSpellings() {
    const canonical = await Filament.collection.insertOne({
      name: "Ambiguous PLA", vendor: "V", type: "PLA", cost: 1,
      // Raw driver bypasses the schema default, and `instanceId` carries a
      // UNIQUE index — two seeds would both be null and collide on it.
      instanceId: "ws0000000c",
      _deletedAt: null, spools: [], settings: {},
    });
    const raw = await Filament.collection.insertOne({
      name: "Ambiguous PLA ", vendor: "V", type: "PLA", cost: 2,
      // Raw driver bypasses the schema default, and `instanceId` carries a
      // UNIQUE index — two seeds would both be null and collide on it.
      instanceId: "ws0000000d",
      _deletedAt: null, spools: [], settings: {},
    });
    return { canonicalId: canonical.insertedId, rawId: raw.insertedId };
  }

  it("PrusaSlicer sync writes to the untrimmed row it addressed, not the canonical one", async () => {
    const { canonicalId, rawId } = await seedBothSpellings();

    const res = await prusaSync(
      new NextRequest("http://localhost/api/filaments/Ambiguous%20PLA%20", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Ambiguous PLA ",
          config: { filament_cost: "42" },
        }),
      }),
      { params: Promise.resolve({ id: "Ambiguous PLA " }) },
    );
    expect(res.status).toBe(200);

    const raw = await Filament.collection.findOne({ _id: rawId });
    const canonical = await Filament.collection.findOne({ _id: canonicalId });
    expect(raw!.cost).toBe(42);
    // The bystander is untouched — that is the whole point.
    expect(canonical!.cost).toBe(1);
  });

  it("still resolves normally once the migration has normalized the row", async () => {
    // Only the canonical row exists now. An old preset still addressed as
    // "X " must fall through to the cast query and find it.
    await Filament.collection.insertOne({
      name: "Settled PLA", vendor: "V", type: "PLA", cost: 1,
      // Raw driver bypasses the schema default, and `instanceId` carries a
      // UNIQUE index — two seeds would both be null and collide on it.
      instanceId: "ws0000000e",
      _deletedAt: null, spools: [], settings: {},
    });

    const res = await prusaSync(
      new NextRequest("http://localhost/api/filaments/Settled%20PLA%20", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Settled PLA ", config: { filament_cost: "7" } }),
      }),
      { params: Promise.resolve({ id: "Settled PLA " }) },
    );
    expect(res.status).toBe(200);
    expect((await Filament.collection.findOne({ name: "Settled PLA" }))!.cost).toBe(7);
  });

  it("OrcaSlicer sync has the same resolution", async () => {
    const { canonicalId, rawId } = await seedBothSpellings();

    const res = await orcaSync(
      new NextRequest("http://localhost/api/filaments/Ambiguous%20PLA%20/orcaslicer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cost: 42 }),
      }),
      { params: Promise.resolve({ id: "Ambiguous PLA " }) },
    );
    expect(res.status).toBe(200);

    expect((await Filament.collection.findOne({ _id: rawId }))!.cost).toBe(42);
    expect((await Filament.collection.findOne({ _id: canonicalId }))!.cost).toBe(1);
  });

  it("the per-nozzle BASE fallback resolves the raw slice, not the trimmed one", async () => {
    // A per-nozzle preset generated for an unresolved "X " is named
    // "X  0.4 Brass" (two spaces). Slicing the hint leaves "X ", and both
    // `.trim()` and the setter's cast land on the canonical "X".
    const { canonicalId, rawId } = await seedBothSpellings();

    const res = await prusaSync(
      new NextRequest("http://localhost/api/filaments/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Ambiguous PLA  0.4 Brass",
          config: { filamentdb_nozzle: "0.4 Brass", filament_cost: "42" },
        }),
      }),
      { params: Promise.resolve({ id: "Ambiguous PLA  0.4 Brass" }) },
    );
    expect(res.status).toBe(200);

    expect((await Filament.collection.findOne({ _id: rawId }))!.cost).toBe(42);
    expect((await Filament.collection.findOne({ _id: canonicalId }))!.cost).toBe(1);
  });
});
