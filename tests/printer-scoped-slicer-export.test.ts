import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as bundlePrusa } from "@/app/api/filaments/prusaslicer/route";
import { GET as bundleOrca } from "@/app/api/filaments/orcaslicer/route";
import { GET as legacyExport } from "@/app/api/filaments/export/route";

/**
 * The reported bug: abrasive filaments — assigned only hardened nozzles —
 * appeared as selectable presets while the active printer carried the soft,
 * nitrocarburized INDX nozzle that fibre fill would destroy.
 *
 * The fix narrows the RESPONSE on request rather than emitting a
 * `compatible_printers_condition`, because PrusaSlicer has no variable for
 * nozzle hardness and deriving conditions from nozzle ticks is what GH #1021
 * removed for silently hiding presets.
 *
 * These tests pin both directions: the abrasive filament must disappear for
 * the soft-nozzle printer, and NOTHING may disappear when no printer is named.
 */
describe("printer-scoped slicer export", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any, Nozzle: any, Printer: any;
  let indxPrinterId: string, h2dPrinterId: string;

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
    Nozzle = mongoose.models.Nozzle;
    Printer = mongoose.models.Printer;

    // Two 0.4 high-flow nozzles differing ONLY in hardness — the case no
    // slicer condition can express, which is why this is server-side.
    const indx = await Nozzle.create({
      name: "INDX", diameter: 0.4, type: "Other", highFlow: true, hardened: false,
    });
    const wc = await Nozzle.create({
      name: "WC HF 0.4", diameter: 0.4, type: "Tungsten Carbide", highFlow: true, hardened: true,
    });

    const indxPrinter = await Printer.create({
      name: "Prusa Core One INDX", manufacturer: "Prusa", printerModel: "Core One INDX",
      installedNozzles: [indx._id],
    });
    const h2d = await Printer.create({
      name: "Bambu Labs H2D", manufacturer: "Bambu Labs", printerModel: "H2D",
      installedNozzles: [wc._id],
    });
    indxPrinterId = String(indxPrinter._id);
    h2dPrinterId = String(h2d._id);

    await Filament.create({
      name: "Abrasive PA6-CF", vendor: "Acme", type: "PA-CF", color: "#000000",
      compatibleNozzles: [wc._id], // hardened only
    });
    await Filament.create({
      name: "Ordinary PLA", vendor: "Acme", type: "PLA", color: "#ff0000",
      compatibleNozzles: [wc._id, indx._id],
    });
    await Filament.create({
      name: "Unassigned PETG", vendor: "Acme", type: "PETG", color: "#00ff00",
      // no compatibleNozzles at all — must still be offered (fail open)
    });
  });

  const ini = async (qs = "") =>
    (await bundlePrusa(new NextRequest(`http://localhost/api/filaments/prusaslicer${qs}`))).text();

  it("withholds the abrasive filament from the soft-nozzle printer", async () => {
    const out = await ini(`?printer=${indxPrinterId}`);
    expect(out).not.toContain("[filament:Abrasive PA6-CF]");
    expect(out).toContain("[filament:Ordinary PLA]");
  });

  it("offers the abrasive filament for the hardened-nozzle printer", async () => {
    const out = await ini(`?printer=${h2dPrinterId}`);
    expect(out).toContain("[filament:Abrasive PA6-CF]");
    expect(out).toContain("[filament:Ordinary PLA]");
  });

  it("offers a filament with no nozzles assigned to either printer — fails open", async () => {
    expect(await ini(`?printer=${indxPrinterId}`)).toContain("[filament:Unassigned PETG]");
    expect(await ini(`?printer=${h2dPrinterId}`)).toContain("[filament:Unassigned PETG]");
  });

  it("changes nothing when no printer is named", async () => {
    // The opt-in guarantee. If this ever fails, the change has become #1021
    // relocated to the server.
    const out = await ini();
    expect(out).toContain("[filament:Abrasive PA6-CF]");
    expect(out).toContain("[filament:Ordinary PLA]");
    expect(out).toContain("[filament:Unassigned PETG]");
  });

  it("accepts a printer name as well as an id", async () => {
    const out = await ini(`?printer=${encodeURIComponent("Prusa Core One INDX")}`);
    expect(out).not.toContain("[filament:Abrasive PA6-CF]");
  });

  it("400s on an unknown printer instead of returning an empty bundle", async () => {
    const res = await bundlePrusa(
      new NextRequest("http://localhost/api/filaments/prusaslicer?printer=Nope"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("printer_not_found");
  });

  it("scopes the OrcaSlicer bundle the same way", async () => {
    const res = await bundleOrca(
      new NextRequest(`http://localhost/api/filaments/orcaslicer?printer=${indxPrinterId}`),
    );
    const names = (await res.json()).map((p: Record<string, unknown>) => {
      const v = p.filament_settings_id ?? p.name;
      return Array.isArray(v) ? String(v[0]) : String(v);
    });
    expect(names).not.toContain("Abrasive PA6-CF");
    expect(names).toContain("Ordinary PLA");
  });

  it("scopes the legacy /export alias too — the endpoint the UI actually calls", async () => {
    // This alias was a hand-copied duplicate and missed the template filter
    // entirely; it now delegates, so it can never drift again.
    const res = await legacyExport(
      new NextRequest(`http://localhost/api/filaments/export?printer=${indxPrinterId}`),
    );
    const out = await res.text();
    expect(res.headers.get("Content-Disposition")).toContain("filament_profiles.ini");
    expect(out).not.toContain("[filament:Abrasive PA6-CF]");
    expect(out).toContain("[filament:Ordinary PLA]");
  });

  it("propagates the 400 through the legacy alias rather than masking it", async () => {
    const res = await legacyExport(
      new NextRequest("http://localhost/api/filaments/export?printer=Nope"),
    );
    expect(res.status).toBe(400);
  });
});
