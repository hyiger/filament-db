import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as getFilament, PUT as putFilament } from "@/app/api/filaments/[id]/route";
import { POST as createFilament } from "@/app/api/filaments/route";

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

  it("diameter inheritance survives a variant edit round-trip (parent has non-default diameter)", async () => {
    // Guard against a Codex-flagged regression: with raw=true the variant's
    // diameter arrives as null; if the form defaulted null → "1.75" in its
    // initial state and then submitted it as a number, any parent diameter
    // other than 1.75 (say a 2.85mm filament) would be silently overridden
    // on the variant on the very next save.
    const parent = await Filament.create({
      name: "Parent 2.85mm",
      vendor: "Test",
      type: "PLA",
      diameter: 2.85,
    });
    const variant = await Filament.create({
      name: "Variant of 2.85mm",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      // `diameter: null` mirrors what POST /api/filaments writes for a
      // variant when the client doesn't supply an explicit diameter
      // (Mongoose's schema default of 1.75 is bypassed there). Without
      // this, the schema default would kick in and the variant would be
      // created with diameter: 1.75 already overriding the parent — the
      // very regression this test guards against.
      diameter: null,
    });

    // Raw fetch returns diameter as null for the variant.
    const rawReq = new NextRequest(`http://localhost/api/filaments/${variant._id}?raw=true`);
    const rawRes = await getFilament(rawReq, { params: Promise.resolve({ id: String(variant._id) }) });
    const rawBody = await rawRes.json();
    expect(rawBody.diameter).toBeNull();

    // Save the raw payload back unchanged — must not coerce null → 1.75.
    const putReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rawBody),
    });
    await putFilament(putReq, { params: Promise.resolve({ id: String(variant._id) }) });

    const fresh = await Filament.findById(variant._id);
    expect(fresh.diameter).toBeNull();

    // Resolved view still inherits the parent's 2.85.
    const resolvedReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`);
    const resolvedRes = await getFilament(resolvedReq, { params: Promise.resolve({ id: String(variant._id) }) });
    const resolved = await resolvedRes.json();
    expect(resolved.diameter).toBe(2.85);
    expect(resolved._inherited).toContain("diameter");
  });

  it("POST /api/filaments does not apply the 1.75 diameter default to variants", async () => {
    // Covers the route-level half of the fix: creating a variant via the
    // real API endpoint without passing a diameter must not trigger the
    // Mongoose schema default. If it did, every newly-cloned variant would
    // immediately override the parent's diameter.
    const parent = await Filament.create({
      name: "Route Parent 2.85mm",
      vendor: "Test",
      type: "PLA",
      diameter: 2.85,
    });

    const req = new NextRequest("http://localhost/api/filaments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Route Variant (no diameter)",
        vendor: "Test",
        type: "PLA",
        color: "#ff0000",
        parentId: String(parent._id),
      }),
    });
    const res = await createFilament(req);
    expect(res.status).toBe(201);
    const created = await res.json();

    const fresh = await Filament.findById(created._id);
    expect(fresh.diameter).toBeNull();

    // Non-variants are unaffected: the schema default still fills in 1.75.
    const standaloneReq = new NextRequest("http://localhost/api/filaments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Standalone (no diameter)",
        vendor: "Test",
        type: "PLA",
      }),
    });
    const standaloneRes = await createFilament(standaloneReq);
    const standalone = await standaloneRes.json();
    const freshStandalone = await Filament.findById(standalone._id);
    expect(freshStandalone.diameter).toBe(1.75);
  });

  it("clearing start_filament_gcode on a variant restores inheritance from the parent (GH #113)", async () => {
    // Repro: parent has a real start G-code; variant was created (e.g. via
    // the pre-fix clone path) with the parent's value baked into its own
    // settings bag. The user clears the textarea and saves. Before the fix,
    // the form's submit conditional only stripped a simple inline `M572` —
    // an inherited multi-line gcode silently survived as an explicit override.
    const parent = await Filament.create({
      name: "Parent w/ start gcode",
      vendor: "Test",
      type: "PLA",
      settings: {
        start_filament_gcode: '"G92 E0\\nM104 S{first_layer_temperature}"',
        filament_density: "1.24",
      },
    });
    const variant = await Filament.create({
      name: "Variant w/ baked-in override",
      vendor: "Test",
      type: "PLA",
      color: "#ff0000",
      parentId: parent._id,
      settings: {
        start_filament_gcode: '"G92 E0\\nM104 S{first_layer_temperature}"',
      },
    });

    // The fixed form omits start_filament_gcode from the settings bag when
    // both the textarea and the Pressure Advance field are empty.
    const putReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: variant.name,
        vendor: variant.vendor,
        type: variant.type,
        color: variant.color,
        parentId: parent._id,
        settings: {}, // user cleared the only key the variant had
      }),
    });
    const putRes = await putFilament(putReq, { params: Promise.resolve({ id: String(variant._id) }) });
    expect(putRes.status).toBe(200);

    // Variant's own settings no longer carry start_filament_gcode.
    const fresh = await Filament.findById(variant._id).lean();
    expect(fresh?.settings?.start_filament_gcode).toBeUndefined();

    // Resolved view falls through to the parent's value.
    const resolvedReq = new NextRequest(`http://localhost/api/filaments/${variant._id}`);
    const resolvedRes = await getFilament(resolvedReq, { params: Promise.resolve({ id: String(variant._id) }) });
    const resolved = await resolvedRes.json();
    expect(resolved.settings.start_filament_gcode).toBe(
      '"G92 E0\\nM104 S{first_layer_temperature}"'
    );
  });

  it("a whitelist-only clone POST creates a variant that inherits everything else (GH #115)", async () => {
    // Repro: pre-fix, the new-filament page spread the entire resolved parent
    // doc into the form when cloning, so saving wrote every inheritable field
    // back as an explicit override (severing the parent link). The fixed page
    // only sends identification fields. This test pins down the API contract
    // the page now relies on: posting a minimal body must produce a variant
    // with null/empty inheritable fields that resolves through to the parent.
    const parent = await Filament.create({
      name: "Loaded Parent",
      vendor: "Test",
      type: "PLA",
      color: "#000000",
      cost: 30,
      density: 1.24,
      diameter: 1.75,
      temperatures: { nozzle: 215, bed: 60 },
      maxVolumetricSpeed: 12,
      settings: {
        start_filament_gcode: '"G92 E0"',
        filament_density: "1.24",
      },
    });

    const req = new NextRequest("http://localhost/api/filaments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentId: String(parent._id),
        name: "Loaded Parent (copy)",
        color: "#ff0000",
        colorName: "Red",
        vendor: "Test",
        type: "PLA",
      }),
    });
    const res = await createFilament(req);
    expect(res.status).toBe(201);
    const created = await res.json();

    // Variant's own row has only what the whitelist sent — everything
    // inheritable is left null/empty.
    const fresh = await Filament.findById(created._id).lean();
    expect(fresh?.cost).toBeNull();
    expect(fresh?.density).toBeNull();
    expect(fresh?.diameter).toBeNull();
    expect(fresh?.temperatures?.nozzle).toBeNull();
    expect(fresh?.maxVolumetricSpeed).toBeNull();
    expect(Object.keys(fresh?.settings ?? {})).toHaveLength(0);

    // Resolved GET threads the parent's values through.
    const resolvedReq = new NextRequest(`http://localhost/api/filaments/${created._id}`);
    const resolvedRes = await getFilament(resolvedReq, { params: Promise.resolve({ id: String(created._id) }) });
    const resolved = await resolvedRes.json();
    expect(resolved.cost).toBe(30);
    expect(resolved.density).toBe(1.24);
    expect(resolved.diameter).toBe(1.75);
    expect(resolved.temperatures.nozzle).toBe(215);
    expect(resolved.maxVolumetricSpeed).toBe(12);
    expect(resolved.settings.start_filament_gcode).toBe('"G92 E0"');
    expect(resolved._inherited).toEqual(
      expect.arrayContaining(["cost", "density", "diameter", "maxVolumetricSpeed", "settings"])
    );

    // And the link stays live: bumping the parent updates the resolved view.
    await Filament.findByIdAndUpdate(parent._id, { $set: { cost: 35 } });
    const reResolvedReq = new NextRequest(`http://localhost/api/filaments/${created._id}`);
    const reResolvedRes = await getFilament(reResolvedReq, { params: Promise.resolve({ id: String(created._id) }) });
    const reResolved = await reResolvedRes.json();
    expect(reResolved.cost).toBe(35);
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
