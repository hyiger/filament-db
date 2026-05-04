import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as compareFilaments } from "@/app/api/filaments/compare/route";

/**
 * Codex P2 on PR #190: the GH #182 fix (subtract empty-spool mass from
 * inventory totals) used the variant's own `spoolWeight` only. Variants
 * commonly store `spoolWeight: null` and inherit it from the parent (see
 * src/lib/resolveFilament.ts), so the original over-reporting bug stayed
 * in place for variant spools on the compare page's "On hand" row.
 *
 * The compare API now resolves the parent's spoolWeight inline when the
 * variant's is null. This test asserts that resolution works end-to-end:
 * the body for a variant carries the inherited spoolWeight so the page's
 * `f.spoolWeight ?? 0` math gives the right remaining grams.
 */
describe("/api/filaments/compare — inherited spoolWeight (Codex P2 PR #190)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    for (const name of ["Nozzle", "Printer", "BedType"] as const) {
      if (!mongoose.models[name]) {
        const mod = await import(`@/models/${name}`);
        mongoose.model(name, mod.default.schema);
      }
    }
    Filament = mongoose.models.Filament;
  });

  function req(ids: string[]) {
    return new NextRequest(`http://localhost/api/filaments/compare?ids=${ids.join(",")}`);
  }

  it("variant body carries the inherited spoolWeight from its parent", async () => {
    const parent = await Filament.create({
      name: "Inherit-Parent",
      vendor: "V",
      type: "PLA",
      spoolWeight: 250,
    });
    const variant = await Filament.create({
      name: "Inherit-Variant",
      vendor: "V",
      type: "PLA",
      color: "#0a0a0a",
      parentId: parent._id,
      // spoolWeight intentionally omitted — inherit.
      spools: [{ label: "v1", totalWeight: 1000 }],
    });

    const res = await compareFilaments(req([String(variant._id)]));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].spoolWeight).toBe(250);
  });

  it("explicit variant spoolWeight wins over the parent's value", async () => {
    const parent = await Filament.create({
      name: "Override-Parent",
      vendor: "V",
      type: "PLA",
      spoolWeight: 250,
    });
    const variant = await Filament.create({
      name: "Override-Variant",
      vendor: "V",
      type: "PLA",
      color: "#fff",
      parentId: parent._id,
      spoolWeight: 300,
    });

    const res = await compareFilaments(req([String(variant._id)]));
    const body = await res.json();
    expect(body[0].spoolWeight).toBe(300);
  });

  it("non-variant filament passes through unchanged", async () => {
    const standalone = await Filament.create({
      name: "Solo",
      vendor: "V",
      type: "PLA",
      spoolWeight: 200,
    });
    const res = await compareFilaments(req([String(standalone._id)]));
    const body = await res.json();
    expect(body[0].spoolWeight).toBe(200);
  });

  it("variant with no parent.spoolWeight either falls back to null (renderer treats as 0)", async () => {
    const parent = await Filament.create({ name: "PNP", vendor: "V", type: "PLA" });
    const variant = await Filament.create({
      name: "VNP",
      vendor: "V",
      type: "PLA",
      color: "#fff",
      parentId: parent._id,
    });
    const res = await compareFilaments(req([String(variant._id)]));
    const body = await res.json();
    // Neither set ⇒ null; the page treats null as 0 in the on-hand math.
    expect(body[0].spoolWeight).toBeNull();
  });
});
