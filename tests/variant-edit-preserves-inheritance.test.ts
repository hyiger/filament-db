import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as getFilament, PUT as putFilament } from "@/app/api/filaments/[id]/route";

/**
 * GH #106 regression guard.
 *
 * Scenario: user creates a parent filament with real settings, clones it
 * as a color variant, then goes into the variant's edit page and clicks
 * Save without changing anything.
 *
 * Before the fix, the edit page fetched the variant via GET without
 * ?raw=true. The server ran resolveFilament(), the form prefilled with
 * the *parent's* values, and the subsequent PUT persisted those values
 * onto the variant — severing the live parent link. From that point on,
 * parent edits were invisible to the variant.
 *
 * After the fix, the edit page fetches with ?raw=true, the form sees
 * only the variant's own (empty) overrides, and the PUT writes the
 * variant back with inheritable fields as null/empty. A later GET (with
 * inheritance resolution) still shows the parent's values because the
 * variant is inheriting them — exactly what the user wants.
 */
describe("variant edit round-trip preserves inheritance", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    // Models that GET populates — without these registered the
    // populate() call throws "Schema hasn't been registered".
    for (const name of ["Nozzle", "Printer", "BedType"] as const) {
      if (!mongoose.models[name]) {
        const mod = await import(`@/models/${name}`);
        mongoose.model(name, mod.default.schema);
      }
    }
    Filament = mongoose.models.Filament;
  });

  async function seed() {
    const parent = await Filament.create({
      name: "Prusament PC Blend",
      vendor: "Prusament",
      type: "PC",
      color: "#333333",
      cost: 35,
      density: 1.22,
      temperatures: { nozzle: 275, bed: 110 },
      maxVolumetricSpeed: 8,
    });
    const variant = await Filament.create({
      name: "Prusament PC Blend — Galaxy Black",
      vendor: "Prusament",
      type: "PC",
      color: "#1a1a2e",
      parentId: parent._id,
      // All inheritable fields left blank — the form would submit them as
      // nulls after a fresh raw-mode fetch.
    });
    return { parent, variant };
  }

  it("GET without ?raw resolves inheritance (baseline)", async () => {
    const { variant } = await seed();
    const req = new NextRequest(`http://localhost/api/filaments/${variant._id}`);
    const res = await getFilament(req, { params: Promise.resolve({ id: String(variant._id) }) });
    const body = await res.json();
    expect(body.temperatures.nozzle).toBe(275);
    expect(body.cost).toBe(35);
    expect(body._inherited).toContain("cost");
  });

  it("GET with ?raw=true returns variant's own (empty) values plus _parent", async () => {
    const { parent, variant } = await seed();
    const req = new NextRequest(`http://localhost/api/filaments/${variant._id}?raw=true`);
    const res = await getFilament(req, { params: Promise.resolve({ id: String(variant._id) }) });
    const body = await res.json();
    expect(body.temperatures.nozzle).toBeNull();
    expect(body.cost).toBeNull();
    expect(body._parent).toBeDefined();
    expect(body._parent.name).toBe("Prusament PC Blend");
    expect(body._parent._id.toString()).toBe(String(parent._id));
  });

  it("PUT of the raw payload does NOT copy parent values onto the variant", async () => {
    const { variant } = await seed();

    // Simulate the edit flow: fetch raw, then PUT the body back unchanged.
    const rawReq = new NextRequest(`http://localhost/api/filaments/${variant._id}?raw=true`);
    const rawRes = await getFilament(rawReq, { params: Promise.resolve({ id: String(variant._id) }) });
    const rawBody = await rawRes.json();

    const putReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rawBody),
    });
    const putRes = await putFilament(putReq, { params: Promise.resolve({ id: String(variant._id) }) });
    expect(putRes.status).toBe(200);

    // Read the raw variant back and verify it still has null inheritable fields.
    const fresh = await Filament.findById(variant._id);
    expect(fresh.temperatures.nozzle).toBeNull();
    expect(fresh.cost).toBeNull();
    expect(fresh.density).toBeNull();
  });

  it("after PUT, a subsequent parent edit is still reflected in the variant (live link)", async () => {
    const { parent, variant } = await seed();

    // Simulate the edit round-trip on the variant.
    const rawReq = new NextRequest(`http://localhost/api/filaments/${variant._id}?raw=true`);
    const rawRes = await getFilament(rawReq, { params: Promise.resolve({ id: String(variant._id) }) });
    const rawBody = await rawRes.json();
    const putReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rawBody),
    });
    await putFilament(putReq, { params: Promise.resolve({ id: String(variant._id) }) });

    // Now update the parent's nozzle temperature.
    await Filament.findByIdAndUpdate(parent._id, {
      $set: { "temperatures.nozzle": 280 },
    });

    // The variant should see the new parent value via inheritance.
    const resolvedReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`);
    const resolvedRes = await getFilament(resolvedReq, { params: Promise.resolve({ id: String(variant._id) }) });
    const resolved = await resolvedRes.json();
    expect(resolved.temperatures.nozzle).toBe(280);
    expect(resolved._inherited).toContain("temperatures.nozzle");
  });

  it("explicit overrides on the variant are preserved across the round-trip", async () => {
    const { parent, variant } = await seed();

    // Variant sets its own cost override.
    await Filament.findByIdAndUpdate(variant._id, { $set: { cost: 40 } });

    const rawReq = new NextRequest(`http://localhost/api/filaments/${variant._id}?raw=true`);
    const rawRes = await getFilament(rawReq, { params: Promise.resolve({ id: String(variant._id) }) });
    const rawBody = await rawRes.json();
    expect(rawBody.cost).toBe(40);

    const putReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rawBody),
    });
    await putFilament(putReq, { params: Promise.resolve({ id: String(variant._id) }) });

    // Parent's cost shouldn't leak through the override.
    await Filament.findByIdAndUpdate(parent._id, { $set: { cost: 50 } });

    const resolvedReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`);
    const resolvedRes = await getFilament(resolvedReq, { params: Promise.resolve({ id: String(variant._id) }) });
    const resolved = await resolvedRes.json();
    expect(resolved.cost).toBe(40); // variant's own override wins
    expect(resolved._inherited).not.toContain("cost");
  });

  it("PUT strips server-only response fields (_parent, _variants, _inherited) from the body", async () => {
    const { variant } = await seed();

    // Client sends the whole response echo back, including the fields the
    // raw GET added for UI convenience.
    const putReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        _parent: { name: "injected" },
        _variants: [{ _id: "fake" }],
        _inherited: ["cost"],
        name: "Prusament PC Blend — Galaxy Black",
      }),
    });
    const putRes = await putFilament(putReq, { params: Promise.resolve({ id: String(variant._id) }) });
    expect(putRes.status).toBe(200);

    const fresh = await Filament.findById(variant._id);
    expect(fresh._parent).toBeUndefined();
    expect(fresh._variants).toBeUndefined();
    expect(fresh._inherited).toBeUndefined();
  });
});
