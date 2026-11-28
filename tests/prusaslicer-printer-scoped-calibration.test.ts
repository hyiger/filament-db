import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as bundlePrusa } from "@/app/api/filaments/prusaslicer/route";
import { GET as exportPrusa } from "@/app/api/filaments/[id]/prusaslicer/route";
import { GET as calibrationRead } from "@/app/api/filaments/[id]/calibration/route";

/**
 * A calibration row scoped to one printer must not produce a PrusaSlicer
 * preset, because a section's only scope is a nozzle-shape condition and the
 * same shape exists on other printers.
 *
 * The reported case, rebuilt with real documents: a filament calibrated on a
 * Core One INDX (printer-less row, 0.4 HF) and on a Bambu H2D (row scoped to
 * the H2D, 0.4 HF tungsten carbide). Both nozzles are 0.4 high-flow, so the
 * H2D's section was offered on the INDX at 270 °C with 0.2 mm retraction.
 */
describe("PrusaSlicer export skips printer-scoped calibration rows", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any, Nozzle: any, Printer: any;
  let filamentId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let indx: any, wc: any, indx025: any, h2d: any;

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

    indx = await Nozzle.create({ name: "INDX", diameter: 0.4, type: "Other", highFlow: true });
    wc = await Nozzle.create({
      name: "WC HF 0.4", diameter: 0.4, type: "Tungsten Carbide", highFlow: true, hardened: true,
    });
    indx025 = await Nozzle.create({ name: "INDX 0.25 STD", diameter: 0.25, type: "Other" });
    await Printer.create({
      name: "Prusa Core One INDX", manufacturer: "Prusa", printerModel: "Core One INDX",
      installedNozzles: [indx._id, indx025._id],
    });
    h2d = await Printer.create({
      name: "Bambu Labs H2D", manufacturer: "Bambu Labs", printerModel: "H2D",
      installedNozzles: [wc._id],
    });

    const f = await Filament.create({
      name: "Pro PCTG Natural",
      vendor: "3D-Fuel",
      type: "PCTG",
      color: "#EEEEEE",
      temperatures: { nozzle: 255, bed: 80 },
      compatibleNozzles: [indx._id, wc._id, indx025._id],
      calibrations: [
        { nozzle: indx._id, printer: null, retractLength: 0.8 },
        {
          nozzle: wc._id,
          printer: h2d._id,
          nozzleTemp: 270,
          retractLength: 0.2,
          retractLift: 0.6,
          fanMinSpeed: 0,
        },
        { nozzle: indx025._id, printer: null, retractLength: 0.5 },
      ],
    });
    filamentId = String(f._id);
  });

  const sectionNames = (ini: string) =>
    (ini.match(/^\[filament:[^\]]*\]/gm) ?? []).map((s) => s.slice(10, -1)).sort();

  const expectNoH2dPreset = (ini: string) => {
    expect(sectionNames(ini)).toEqual(["Pro PCTG Natural 0.25 Other", "Pro PCTG Natural 0.4 Other HF"]);
    expect(ini).not.toContain("Tungsten Carbide");
    expect(ini).not.toContain("temperature = 270");
    expect(ini).not.toContain("filament_retract_length = 0.2");
    expect(ini).toContain("compatible_printers_condition = nozzle_diameter[0]==0.4\n");
  };

  it("the bundle the fork loads omits the H2D's preset", async () => {
    const res = await bundlePrusa(new NextRequest("http://localhost/api/filaments/prusaslicer"));
    expect(res.status).toBe(200);
    expectNoH2dPreset(await res.text());
  });

  it("the single-filament download omits it too", async () => {
    const res = await exportPrusa(
      new NextRequest(`http://localhost/api/filaments/${filamentId}/prusaslicer`),
      { params: Promise.resolve({ id: filamentId }) },
    );
    expect(res.status).toBe(200);
    expectNoH2dPreset(await res.text());
  });

  it("a row scoped to a printer in the trash is still scoped", async () => {
    await Printer.updateOne({ _id: h2d._id }, { $set: { _deletedAt: new Date() } });
    const res = await bundlePrusa(new NextRequest("http://localhost/api/filaments/prusaslicer"));
    expectNoH2dPreset(await res.text());
  });

  it("the H2D's row stays reachable through the printer-scoped calibration read", async () => {
    const res = await calibrationRead(
      new NextRequest(
        `http://localhost/api/filaments/${filamentId}/calibration?nozzle_diameter=0.4&printer=${h2d._id}`,
      ),
      { params: Promise.resolve({ id: filamentId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.printer).toBe("Bambu Labs H2D");
    expect(body.calibration.retractLength).toBe(0.2);
  });
});
