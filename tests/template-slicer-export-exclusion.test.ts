import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as bundlePrusa } from "@/app/api/filaments/prusaslicer/route";
import { GET as bundleOrca } from "@/app/api/filaments/orcaslicer/route";
import { GET as onePrusa } from "@/app/api/filaments/[id]/prusaslicer/route";
import { GET as oneOrca } from "@/app/api/filaments/[id]/orcaslicer/route";
import { GET as oneBambu } from "@/app/api/filaments/[id]/bambustudio/route";

/**
 * A template is an abstract product line (GH #605): no colour, no inventory,
 * nothing you can put on a spool. The slicer's filament dropdown lists things
 * you load and print, so a template must never appear there as a selectable
 * user preset — picking one prints with the family's shared spec and no colour.
 *
 * The load-bearing subtlety these tests pin: templates are still FETCHED,
 * because variants resolve their inherited values through them. So excluding a
 * template from the bundle must not strip its variants' inherited values.
 */
describe("templates are excluded from slicer exports", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  let templateId: string;
  let variantId: string;
  let standaloneId: string;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const prtMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    Filament = mongoose.models.Filament;

    const template = await Filament.create({
      name: "Acme PETG",
      vendor: "Acme",
      type: "PETG",
      color: null,
      temperatures: { nozzle: 245, bed: 85 },
      density: 1.27,
    });
    templateId = String(template._id);

    const variant = await Filament.create({
      name: "Acme PETG Cobalt",
      vendor: "Acme",
      type: "PETG",
      color: "#0e21ae",
      parentId: template._id,
    });
    variantId = String(variant._id);

    const standalone = await Filament.create({
      name: "Acme ASA Black",
      vendor: "Acme",
      type: "ASA",
      color: "#000000",
      temperatures: { nozzle: 260, bed: 100 },
    });
    standaloneId = String(standalone._id);
  });

  const bundleReq = () => new NextRequest("http://localhost/api/filaments/prusaslicer");
  const oneReq = (id: string) =>
    new NextRequest(`http://localhost/api/filaments/${id}/export`);

  // ── bulk bundles ──────────────────────────────────────────────────

  it("omits the template from the PrusaSlicer bundle but keeps its variant", async () => {
    const ini = await (await bundlePrusa(bundleReq())).text();
    expect(ini).not.toContain("[filament:Acme PETG]");
    expect(ini).toContain("[filament:Acme PETG Cobalt]");
    expect(ini).toContain("[filament:Acme ASA Black]");
  });

  it("still resolves the variant's inherited values from the omitted template", async () => {
    // The whole risk of this change: dropping the template from the emitted
    // set must not drop it from the parent lookup the variant resolves through.
    const ini = await (await bundlePrusa(bundleReq())).text();
    const section = ini.slice(ini.indexOf("[filament:Acme PETG Cobalt]"));
    expect(section).toMatch(/^temperature = 245$/m);
    expect(section).toMatch(/^bed_temperature = 85$/m);
    expect(section).toMatch(/^filament_density = 1.27$/m);
  });

  it("omits the template from the OrcaSlicer bundle too", async () => {
    const res = await bundleOrca(new NextRequest("http://localhost/api/filaments/orcaslicer"));
    // Orca emits most values as single-element arrays, so flatten before
    // comparing — matching on the raw field would make the negative
    // assertion below pass vacuously.
    const names = (await res.json()).map((p: Record<string, unknown>) => {
      const v = p.filament_settings_id ?? p.name;
      return Array.isArray(v) ? String(v[0]) : String(v);
    });
    expect(names).toContain("Acme PETG Cobalt");
    expect(names).toContain("Acme ASA Black");
    expect(names).not.toContain("Acme PETG");
  });

  it("exports a childless root — being a root is not being a template", async () => {
    const ini = await (await bundlePrusa(bundleReq())).text();
    expect(ini).toContain("[filament:Acme ASA Black]");
  });

  it("exports a former template again once its only variant is trashed", async () => {
    await Filament.findByIdAndUpdate(variantId, { _deletedAt: new Date() });
    const ini = await (await bundlePrusa(bundleReq())).text();
    // No live colours left, so it is a standalone again and printable.
    expect(ini).toContain("[filament:Acme PETG]");
  });

  // ── single-filament exports ───────────────────────────────────────

  it.each([
    ["PrusaSlicer", onePrusa],
    ["OrcaSlicer", oneOrca],
    ["Bambu Studio", oneBambu],
  ])("refuses a single %s export of a template with 400", async (_label, handler) => {
    const res = await handler(oneReq(templateId), {
      params: Promise.resolve({ id: templateId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("template_not_exportable");
  });

  it.each([
    ["PrusaSlicer", onePrusa],
    ["OrcaSlicer", oneOrca],
    ["Bambu Studio", oneBambu],
  ])("still exports a variant via the single %s route", async (_label, handler) => {
    const res = await handler(oneReq(variantId), {
      params: Promise.resolve({ id: variantId }),
    });
    expect(res.status).toBe(200);
  });

  it("still exports a standalone via the single route", async () => {
    const res = await onePrusa(oneReq(standaloneId), {
      params: Promise.resolve({ id: standaloneId }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[filament:Acme ASA Black]");
  });
});
