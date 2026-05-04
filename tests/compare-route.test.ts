import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as compareFilaments } from "@/app/api/filaments/compare/route";

/**
 * GH #184 regression guard.
 *
 * Pre-fix the Compare route ran a flat `Filament.find({_id: {$in: ids}})`
 * and returned the raw documents — so a variant that inherited fields
 * from its parent showed `—` for cost, density, temperatures, etc on
 * the Compare page even though the detail page, list, and exports all
 * resolved those values via `resolveFilament`.
 *
 * The fix batched-loads parent docs for any variant in the result and
 * merges via the same helper. Tests assert:
 *   - inherited fields are returned (not null)
 *   - explicit overrides on the variant still win
 *   - non-variants pass through unchanged
 *   - response order matches the requested ids
 */
describe("/api/filaments/compare — variant inheritance (GH #184)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    // Models populate() walks
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

  it("returns inherited values for a variant whose fields are blank", async () => {
    const parent = await Filament.create({
      name: "Parent PETG",
      vendor: "Vendor",
      type: "PETG",
      cost: 35,
      density: 1.27,
      diameter: 1.75,
      temperatures: { nozzle: 240, bed: 80 },
      dryingTemperature: 65,
      dryingTime: 240,
    });
    const variant = await Filament.create({
      name: "Parent PETG — Forest Green",
      vendor: "Vendor",
      type: "PETG",
      color: "#0a4a2a",
      parentId: parent._id,
      // No cost, density, diameter, temps, drying — all inherited.
    });

    const res = await compareFilaments(req([String(variant._id)]));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].cost).toBe(35);
    expect(body[0].density).toBe(1.27);
    expect(body[0].diameter).toBe(1.75);
    expect(body[0].temperatures.nozzle).toBe(240);
    expect(body[0].temperatures.bed).toBe(80);
    expect(body[0].dryingTemperature).toBe(65);
    expect(body[0].dryingTime).toBe(240);
  });

  it("explicit variant overrides win over the parent's value", async () => {
    const parent = await Filament.create({
      name: "Override Parent",
      vendor: "Vendor",
      type: "PLA",
      cost: 25,
    });
    const variant = await Filament.create({
      name: "Override Variant",
      vendor: "Vendor",
      type: "PLA",
      color: "#abcdef",
      parentId: parent._id,
      cost: 40,
    });

    const res = await compareFilaments(req([String(variant._id)]));
    const body = await res.json();
    expect(body[0].cost).toBe(40);
  });

  it("non-variant filaments pass through with no parent lookup", async () => {
    const standalone = await Filament.create({
      name: "Standalone",
      vendor: "Vendor",
      type: "PLA",
      cost: 19.99,
    });
    const res = await compareFilaments(req([String(standalone._id)]));
    const body = await res.json();
    expect(body[0].cost).toBe(19.99);
  });

  it("returns docs in the requested id order, even when DB returns them differently", async () => {
    const a = await Filament.create({ name: "A", vendor: "V", type: "PLA" });
    const b = await Filament.create({ name: "B", vendor: "V", type: "PLA" });
    const c = await Filament.create({ name: "C", vendor: "V", type: "PLA" });

    // Request in reverse insertion order.
    const ids = [String(c._id), String(a._id), String(b._id)];
    const res = await compareFilaments(req(ids));
    const body = await res.json();
    expect(body.map((f: { name: string }) => f.name)).toEqual(["C", "A", "B"]);
  });

  it("mixes variant + standalone in one call without losing either's data", async () => {
    const parent = await Filament.create({
      name: "Mixed Parent",
      vendor: "V",
      type: "PETG",
      cost: 30,
      density: 1.27,
    });
    const variant = await Filament.create({
      name: "Mixed Variant",
      vendor: "V",
      type: "PETG",
      color: "#fff",
      parentId: parent._id,
    });
    const solo = await Filament.create({
      name: "Mixed Solo",
      vendor: "V",
      type: "PLA",
      cost: 19,
      density: 1.24,
    });

    const ids = [String(variant._id), String(solo._id)];
    const res = await compareFilaments(req(ids));
    const body = await res.json();
    expect(body[0].cost).toBe(30);     // inherited
    expect(body[0].density).toBe(1.27); // inherited
    expect(body[1].cost).toBe(19);     // own value
    expect(body[1].density).toBe(1.24); // own value
  });
});
