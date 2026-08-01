import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createSpool } from "@/app/api/filaments/[id]/spools/route";
import { PUT as putFilament } from "@/app/api/filaments/[id]/route";
import { POST as createFilament } from "@/app/api/filaments/route";

/**
 * GH #605 — parent/variant template model, Phase 1.
 *
 * A filament with ≥1 live variant is a TEMPLATE (template-ness is derived,
 * never a schema flag). Templates hold no inventory:
 *   - POST /spools on a template → 400 `template_no_spools` (standalones 201)
 *   - PUT weight-trio writes (totalWeight / spoolWeight / netFilamentWeight)
 *     on a template are STRIPPED (not rejected — the edit form echoes every
 *     field back), reported via `_strippedTemplateFields`; explicit nulls
 *     (clearing legacy values) still pass through.
 *
 * Also pins the Phase-1a API contract: POST and PUT accept `color: null`
 * (cleared color) — the schema has allowed it since GH #477; the form can
 * now produce it.
 */
describe("GH #605 — template guards + nullable color", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

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

  function jsonReq(url: string, body: unknown, method: string) {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function seedParentWithVariant() {
    const parent = await Filament.create({
      name: "Template PLA",
      vendor: "T",
      type: "PLA",
    });
    const variant = await Filament.create({
      name: "Template PLA — Red",
      vendor: "T",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
    });
    return { parent, variant };
  }

  // ── POST /api/filaments/[id]/spools — template guard ────────────────────

  it("rejects a new spool on a template with 400 template_no_spools (nothing persisted)", async () => {
    const { parent } = await seedParentWithVariant();

    const res = await createSpool(
      jsonReq(`http://localhost/api/filaments/${parent._id}/spools`, { totalWeight: 1000 }, "POST"),
      { params: Promise.resolve({ id: String(parent._id) }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("template_no_spools");
    expect(body.message).toMatch(/variants/i);

    const fresh = await Filament.findById(parent._id);
    expect(fresh.spools).toHaveLength(0);
  });

  it("still accepts a new spool on a standalone filament (201)", async () => {
    const f = await Filament.create({ name: "Standalone PLA", vendor: "T", type: "PLA" });

    const res = await createSpool(
      jsonReq(`http://localhost/api/filaments/${f._id}/spools`, { totalWeight: 1000 }, "POST"),
      { params: Promise.resolve({ id: String(f._id) }) },
    );

    expect(res.status).toBe(201);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(1000);
  });

  it("a filament whose only variant is soft-deleted is NOT a template — spool accepted", async () => {
    const { parent, variant } = await seedParentWithVariant();
    await Filament.updateOne({ _id: variant._id }, { _deletedAt: new Date() });

    const res = await createSpool(
      jsonReq(`http://localhost/api/filaments/${parent._id}/spools`, { totalWeight: 800 }, "POST"),
      { params: Promise.resolve({ id: String(parent._id) }) },
    );

    expect(res.status).toBe(201);
    const fresh = await Filament.findById(parent._id);
    expect(fresh.spools).toHaveLength(1);
  });

  it("accepts a spool on the VARIANT of a template (inventory lives on variants)", async () => {
    const { variant } = await seedParentWithVariant();

    const res = await createSpool(
      jsonReq(`http://localhost/api/filaments/${variant._id}/spools`, { totalWeight: 750 }, "POST"),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );

    expect(res.status).toBe(201);
    const fresh = await Filament.findById(variant._id);
    expect(fresh.spools).toHaveLength(1);
  });

  // ── PUT /api/filaments/[id] — weight-trio strip on templates ────────────

  it("strips non-null weight-trio writes on a template and reports _strippedTemplateFields", async () => {
    const { parent } = await seedParentWithVariant();

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${parent._id}`,
        {
          cost: 24.99,
          totalWeight: 1200,
          spoolWeight: 200,
          netFilamentWeight: 1000,
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(parent._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Non-weight fields still apply; the weight trio does not.
    expect(body.cost).toBe(24.99);
    expect(body._strippedTemplateFields).toEqual([
      "totalWeight",
      "spoolWeight",
      "netFilamentWeight",
    ]);

    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.totalWeight ?? null).toBeNull();
    expect(fresh.spoolWeight ?? null).toBeNull();
    expect(fresh.netFilamentWeight ?? null).toBeNull();
  });

  it("allows an explicit null through — clearing a legacy template's weight is cleanup", async () => {
    const parent = await Filament.create({
      name: "Legacy Template PLA",
      vendor: "T",
      type: "PLA",
      spoolWeight: 250,
    });
    await Filament.create({
      name: "Legacy Template PLA — Blue",
      vendor: "T",
      type: "PLA",
      color: "#0000FF",
      parentId: parent._id,
    });

    const res = await putFilament(
      jsonReq(`http://localhost/api/filaments/${parent._id}`, { spoolWeight: null }, "PUT"),
      { params: Promise.resolve({ id: String(parent._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._strippedTemplateFields).toBeUndefined();
    const fresh = await Filament.findById(parent._id).lean();
    expect(fresh.spoolWeight).toBeNull();
  });

  it("applies weight-trio writes normally on a standalone (no _strippedTemplateFields)", async () => {
    const f = await Filament.create({ name: "Weighted PLA", vendor: "T", type: "PLA" });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${f._id}`,
        { spoolWeight: 210, netFilamentWeight: 1000 },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._strippedTemplateFields).toBeUndefined();
    expect(body.spoolWeight).toBe(210);
    expect(body.netFilamentWeight).toBe(1000);
  });

  it("a client-echoed _strippedTemplateFields never persists as a document field", async () => {
    const f = await Filament.create({ name: "Echo PLA", vendor: "T", type: "PLA" });

    const res = await putFilament(
      jsonReq(
        `http://localhost/api/filaments/${f._id}`,
        { _strippedTemplateFields: ["totalWeight"], cost: 10 },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );

    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id).lean();
    expect(fresh._strippedTemplateFields).toBeUndefined();
  });

  // ── Phase 1a: the API accepts color: null (cleared color) ───────────────

  it("POST /api/filaments accepts color: null", async () => {
    const res = await createFilament(
      jsonReq(
        "http://localhost/api/filaments",
        { name: "Colorless PLA", vendor: "T", type: "PLA", color: null },
        "POST",
      ),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.color).toBeNull();
    const fresh = await Filament.findById(body._id).lean();
    expect(fresh.color).toBeNull();
  });

  it("PUT /api/filaments/[id] accepts color: null and does not resurrect a default", async () => {
    const f = await Filament.create({
      name: "Once Red PLA",
      vendor: "T",
      type: "PLA",
      color: "#FF0000",
    });

    const res = await putFilament(
      jsonReq(`http://localhost/api/filaments/${f._id}`, { color: null }, "PUT"),
      { params: Promise.resolve({ id: String(f._id) }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.color).toBeNull();
    const fresh = await Filament.findById(f._id).lean();
    // Stored null stays null — the schema default must not re-materialize.
    expect(fresh.color).toBeNull();
  });
});
