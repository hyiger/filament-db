import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { countEntityDependents } from "@/lib/entityDependents";

/**
 * GH #1149. The counter must agree with the DELETE guards' refusal
 * predicates — including the two deliberate asymmetries: filament-side
 * references count TRASHED filaments (GH #629, restore resurrects the ref),
 * printer-side references count LIVE printers only (no trash loop).
 */
describe("countEntityDependents (GH #1149)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any, Printer: any, PrintHistory: any, Nozzle: any, BedType: any, Location: any;

  beforeEach(async () => {
    const mods = [
      ["Filament", await import("@/models/Filament")],
      ["Printer", await import("@/models/Printer")],
      ["PrintHistory", await import("@/models/PrintHistory")],
      ["Nozzle", await import("@/models/Nozzle")],
      ["BedType", await import("@/models/BedType")],
      ["Location", await import("@/models/Location")],
    ] as const;
    for (const [name, mod] of mods) {
      if (!mongoose.models[name]) mongoose.model(name, mod.default.schema);
    }
    ({ Filament, Printer, PrintHistory, Nozzle, BedType, Location } = mongoose.models);
  });

  it("locations: counts filaments with spools here, INCLUDING trashed ones", async () => {
    const loc = await Location.create({ name: "Shelf A" });
    await Filament.create({
      name: "Active Here", vendor: "V", type: "PLA",
      spools: [{ totalWeight: 1000, locationId: loc._id }],
    });
    await Filament.create({
      name: "Trashed Here", vendor: "V", type: "PLA",
      spools: [{ totalWeight: 1000, locationId: loc._id }],
      _deletedAt: new Date(),
    });
    // Purged tombstones are gone forever and never block.
    await Filament.create({
      name: "Purged Here", vendor: "V", type: "PLA",
      spools: [{ totalWeight: 1000, locationId: loc._id }],
      _deletedAt: new Date(), _purged: true,
    });
    const res = await countEntityDependents("locations", String(loc._id), "Shelf A");
    expect(res).toEqual({
      total: 2,
      breakdown: { filamentsWithSpoolsHere: 2 },
    });
  });

  it("nozzles: filament ticks/calibrations plus LIVE printers only", async () => {
    const nz = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    await Filament.create({
      name: "Ticked", vendor: "V", type: "PLA", compatibleNozzles: [nz._id],
    });
    await Printer.create({ name: "Live P", manufacturer: "M", printerModel: "X", installedNozzles: [nz._id] });
    await Printer.create({
      name: "Trashed P", manufacturer: "M", printerModel: "X",
      installedNozzles: [nz._id], _deletedAt: new Date(),
    });
    const res = await countEntityDependents("nozzles", String(nz._id), "0.4 Brass");
    expect(res.breakdown).toEqual({ filaments: 1, printers: 1 });
    expect(res.total).toBe(2);
  });

  it("printers: filament calibrations reference", async () => {
    const nz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
    const pr = await Printer.create({ name: "MK4", manufacturer: "Prusa", printerModel: "MK4" });
    await Filament.create({
      name: "Calibrated", vendor: "V", type: "PLA",
      calibrations: [{ nozzle: nz._id, printer: pr._id }],
    });
    const res = await countEntityDependents("printers", String(pr._id), "MK4");
    expect(res).toEqual({ total: 1, breakdown: { filamentCalibrations: 1 } });
  });

  it("bedtypes: calibrations by id, printers by id, bed temps by NAME", async () => {
    const nz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
    const bt = await BedType.create({ name: "Textured PEI", material: "PEI" });
    await Filament.create({
      name: "Cal", vendor: "V", type: "PLA",
      calibrations: [{ nozzle: nz._id, bedType: bt._id }],
    });
    await Printer.create({ name: "P", manufacturer: "M", printerModel: "X", installedBedTypes: [bt._id] });
    await Filament.create({
      name: "Temps", vendor: "V", type: "PLA",
      bedTypeTemps: [{ bedType: "Textured PEI", temperature: 60 }],
    });
    const res = await countEntityDependents("bedtypes", String(bt._id), "Textured PEI");
    expect(res.breakdown).toEqual({
      filamentCalibrations: 1,
      printers: 1,
      filamentBedTemps: 1,
    });
    expect(res.total).toBe(3);
  });

  it("filaments: live variants, own spools, print history, AMS dedications", async () => {
    const f = await Filament.create({
      name: "Parentish", vendor: "V", type: "PLA",
      spools: [{ totalWeight: 1000 }, { totalWeight: 500 }],
    });
    await Filament.create({
      name: "Live Variant", vendor: "V", type: "PLA", parentId: f._id,
    });
    await Filament.create({
      name: "Trashed Variant", vendor: "V", type: "PLA", parentId: f._id,
      _deletedAt: new Date(),
    });
    await PrintHistory.create({
      jobLabel: "benchy.3mf",
      usage: [{ filamentId: f._id, grams: 10 }],
    });
    await Printer.create({
      name: "AMS P", manufacturer: "M", printerModel: "X",
      amsSlots: [{ slotName: "A", filamentId: f._id, spoolId: null }],
    });
    const res = await countEntityDependents("filaments", String(f._id), "Parentish");
    expect(res.breakdown).toEqual({
      liveVariants: 1,
      ownSpools: 2,
      printHistoryJobs: 1,
      amsSlots: 1,
    });
    expect(res.total).toBe(5);
  });

  it("a dependent-less row counts zero everywhere", async () => {
    const loc = await Location.create({ name: "Empty Shelf" });
    const res = await countEntityDependents("locations", String(loc._id), "Empty Shelf");
    expect(res).toEqual({ total: 0, breakdown: { filamentsWithSpoolsHere: 0 } });
  });
});
