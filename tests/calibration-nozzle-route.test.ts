import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as slicerSync } from "@/app/api/filaments/[id]/route";
import { GET as getCalibration } from "@/app/api/filaments/[id]/calibration/route";

/**
 * N041 (live-library audit, 2026-10-21): two non-deleted 0.4 mm high-flow
 * nozzles, the Core One INDX's and a "WC HF 0.4" installed on a Bambu H2D,
 * both ticked on 65 filaments. A PrusaSlicer sync with
 * `nozzle_diameter=0.4&high_flow=1` matched both, and the sync-back took
 * `Nozzle.findOne()` with no sort, so the calibration landed on whichever the
 * collection returned first. These tests seed the H2D's nozzle FIRST, so the
 * old natural-order pick is always the wrong one.
 */
describe("N041: sync-back and /calibration resolve one nozzle, never by document order", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Nozzle: any;
  let Printer: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    // tests/setup.ts wipes mongoose.models between tests.
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
  });

  function post(id: string, query: string, config: Record<string, string>, name?: string) {
    return slicerSync(
      new NextRequest(`http://localhost/api/filaments/${encodeURIComponent(id)}${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(name ? { name } : {}), config }),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  function read(id: string, query: string) {
    return getCalibration(
      new NextRequest(`http://localhost/api/filaments/${encodeURIComponent(id)}/calibration${query}`, {
        method: "GET",
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  /** The user's library shape. The H2D's nozzle is created first on purpose. */
  async function seedLibrary(opts: { indxType?: string } = {}) {
    const wc = await Nozzle.create({ name: "WC HF 0.4", diameter: 0.4, type: "WC", highFlow: true });
    const indx = await Nozzle.create({
      name: "Core One INDX 0.4 HF",
      diameter: 0.4,
      type: opts.indxType ?? "Brass",
      highFlow: true,
    });
    const h2d = await Printer.create({
      name: "Bambu H2D", manufacturer: "Bambu Lab", printerModel: "H2D", installedNozzles: [wc._id],
    });
    const core = await Printer.create({
      name: "Core One INDX", manufacturer: "Prusa", printerModel: "Core One", installedNozzles: [indx._id],
    });
    return { wc, indx, h2d, core };
  }

  async function filamentTicking(nozzles: unknown[], extra: Record<string, unknown> = {}) {
    return Filament.create({
      name: "PETG Galaxy",
      vendor: "Prusament",
      type: "PETG",
      compatibleNozzles: nozzles,
      ...extra,
    });
  }

  async function rows(id: unknown) {
    return ((await Filament.findById(id).lean()).calibrations ?? []) as Array<{
      nozzle: unknown;
      printer: unknown;
      extrusionMultiplier?: number;
      pressureAdvance?: number;
      nozzleTemp?: number;
    }>;
  }

  describe("write: two same-spec compatible nozzles", () => {
    it("without a printer hint or an existing row, refuses and reports the tie", async () => {
      const { wc, indx } = await seedLibrary();
      const f = await filamentTicking([wc._id, indx._id]);

      const res = await post(String(f._id), "?nozzle_diameter=0.4&high_flow=1", {
        extrusion_multiplier: "0.97",
        pressure_advance_value: "0.035",
        filament_density: "1.27",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.calibration.status).toBe("ambiguous");
      expect(body.calibration.scope).toBe("compatible");
      expect(body.calibration.fields.sort()).toEqual(["extrusionMultiplier", "pressureAdvance"]);
      expect(body.calibration.candidates.map((c: { name: string }) => c.name).sort()).toEqual([
        "Core One INDX 0.4 HF",
        "WC HF 0.4",
      ]);
      expect(body.calibration.message).toMatch(/not written/);
      // Nothing per-nozzle was written; the rest of the sync still applied.
      expect(await rows(f._id)).toHaveLength(0);
      expect((await Filament.findById(f._id)).density).toBe(1.27);
    });

    it("with ?printer= by name, writes to the nozzle that printer has installed", async () => {
      const { wc, indx } = await seedLibrary();
      const f = await filamentTicking([wc._id, indx._id]);

      const res = await post(
        String(f._id),
        "?nozzle_diameter=0.4&high_flow=1&printer=Core%20One%20INDX",
        { extrusion_multiplier: "0.97" },
      );

      const body = await res.json();
      expect(body.calibration).toMatchObject({
        status: "written",
        resolvedBy: "printer",
        scope: "compatible",
        nozzle: { _id: String(indx._id), name: "Core One INDX 0.4 HF" },
        printer: { requested: "Core One INDX", name: "Core One INDX" },
      });
      const cals = await rows(f._id);
      expect(cals).toHaveLength(1);
      expect(String(cals[0].nozzle)).toBe(String(indx._id));
      expect(cals[0].printer ?? null).toBeNull(); // the sync still writes the printer-less row
      expect(cals[0].extrusionMultiplier).toBe(0.97);
    });

    it("with ?printer= by id, writes to the other printer's nozzle", async () => {
      const { wc, indx, h2d } = await seedLibrary();
      const f = await filamentTicking([wc._id, indx._id]);

      const res = await post(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${h2d._id}`, {
        extrusion_multiplier: "0.95",
      });

      expect((await res.json()).calibration).toMatchObject({ status: "written", resolvedBy: "printer" });
      const cals = await rows(f._id);
      expect(String(cals[0].nozzle)).toBe(String(wc._id));
    });

    it("without a hint, keeps updating the nozzle that already carries the row", async () => {
      const { wc, indx } = await seedLibrary();
      const f = await filamentTicking([wc._id, indx._id], {
        calibrations: [{ nozzle: indx._id, extrusionMultiplier: 0.99 }],
      });

      const res = await post(String(f._id), "?nozzle_diameter=0.4&high_flow=1", {
        extrusion_multiplier: "0.96",
      });

      expect((await res.json()).calibration).toMatchObject({
        status: "written",
        resolvedBy: "calibrated",
        nozzle: { _id: String(indx._id) },
      });
      const cals = await rows(f._id);
      expect(cals).toHaveLength(1);
      expect(String(cals[0].nozzle)).toBe(String(indx._id));
      expect(cals[0].extrusionMultiplier).toBe(0.96);
    });

    it("a printer hint outranks an existing row on the other nozzle", async () => {
      const { wc, indx, h2d } = await seedLibrary();
      const f = await filamentTicking([wc._id, indx._id], {
        calibrations: [{ nozzle: indx._id, extrusionMultiplier: 0.99 }],
      });

      await post(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${h2d._id}`, {
        extrusion_multiplier: "0.93",
      });

      const cals = await rows(f._id);
      expect(cals).toHaveLength(2);
      expect(cals.find((c) => String(c.nozzle) === String(indx._id))?.extrusionMultiplier).toBe(0.99);
      expect(cals.find((c) => String(c.nozzle) === String(wc._id))?.extrusionMultiplier).toBe(0.93);
    });

    it("an unknown printer refuses a tie instead of falling back to the existing row", async () => {
      const { wc, indx } = await seedLibrary();
      const f = await filamentTicking([wc._id, indx._id], {
        calibrations: [{ nozzle: indx._id, extrusionMultiplier: 0.99 }],
      });

      const res = await post(String(f._id), "?nozzle_diameter=0.4&high_flow=1&printer=H2C", {
        extrusion_multiplier: "0.93",
      });

      const body = await res.json();
      expect(body.calibration).toMatchObject({
        status: "printer_not_found",
        printer: { requested: "H2C", _id: null, name: null },
      });
      expect(body.calibration.message).toMatch(/H2C/);
      expect((await rows(f._id))[0].extrusionMultiplier).toBe(0.99); // untouched
    });
  });

  describe("write: the single-match case is unchanged", () => {
    it("one compatible nozzle at the diameter takes the write", async () => {
      const { indx } = await seedLibrary();
      const f = await filamentTicking([indx._id]);

      const res = await post(String(f._id), "?nozzle_diameter=0.4&high_flow=1", {
        extrusion_multiplier: "0.98",
      });

      expect(res.status).toBe(200);
      expect((await res.json()).calibration).toMatchObject({
        status: "written",
        resolvedBy: "only",
        scope: "compatible",
        nozzle: { _id: String(indx._id) },
      });
      expect(String((await rows(f._id))[0].nozzle)).toBe(String(indx._id));
    });

    it("still takes the write even when the named printer does not own it", async () => {
      const { indx, h2d } = await seedLibrary();
      const f = await filamentTicking([indx._id]);

      const res = await post(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${h2d._id}`, {
        extrusion_multiplier: "0.98",
      });

      expect((await res.json()).calibration).toMatchObject({ status: "written", resolvedBy: "only" });
      expect(String((await rows(f._id))[0].nozzle)).toBe(String(indx._id));
    });

    it("a sync without calibration keys carries no calibration report", async () => {
      const { indx } = await seedLibrary();
      const f = await filamentTicking([indx._id]);
      const res = await post(String(f._id), "?nozzle_diameter=0.4&high_flow=1", { filament_density: "1.3" });
      expect((await res.json()).calibration).toBeUndefined();
    });

    it("no matching nozzle anywhere reports no_match", async () => {
      const { indx } = await seedLibrary();
      const f = await filamentTicking([indx._id]);
      const res = await post(String(f._id), "?nozzle_diameter=0.6&high_flow=1", { extrusion_multiplier: "1" });
      expect((await res.json()).calibration).toMatchObject({ status: "no_match", fields: ["extrusionMultiplier"] });
      expect(await rows(f._id)).toHaveLength(0);
    });
  });

  describe("write: the #859 catalog fallback uses the same rules", () => {
    it("names the printer to break a catalog tie", async () => {
      const { indx } = await seedLibrary();
      const f = await filamentTicking([]); // no ticks: the common synced/imported shape

      const res = await post(String(f._id), "?nozzle_diameter=0.4&high_flow=1&printer=Core%20One%20INDX", {
        extrusion_multiplier: "1.01",
      });

      expect((await res.json()).calibration).toMatchObject({
        status: "written",
        resolvedBy: "printer",
        scope: "catalog",
      });
      expect(String((await rows(f._id))[0].nozzle)).toBe(String(indx._id));
    });

    it("still refuses a catalog tie it cannot break", async () => {
      await seedLibrary();
      const f = await filamentTicking([]);
      const res = await post(String(f._id), "?nozzle_diameter=0.4&high_flow=1", { extrusion_multiplier: "1.01" });
      const body = await res.json();
      expect(body.calibration).toMatchObject({ status: "ambiguous", scope: "catalog" });
      expect(body.calibration.message).toMatch(/tick the nozzle/);
      expect(await rows(f._id)).toHaveLength(0);
    });
  });

  describe("write: #872 per-nozzle presets", () => {
    const perNozzleConfig = (hint: string, temp: string) => ({
      filamentdb_nozzle: hint,
      extrusion_multiplier: "0.97",
      temperature: temp,
    });

    it("the hint's type alone separates the two nozzles", async () => {
      const { wc, indx } = await seedLibrary();
      const f = await filamentTicking([wc._id, indx._id], { temperatures: { nozzle: 240 } });

      const res = await post(String(f._id), "", perNozzleConfig("0.4 WC HF", "255"), "PETG Galaxy 0.4 WC HF");

      expect((await res.json()).calibration).toMatchObject({ status: "written", resolvedBy: "only" });
      const cals = await rows(f._id);
      expect(String(cals[0].nozzle)).toBe(String(wc._id));
      expect(cals[0].nozzleTemp).toBe(255);
      expect((await Filament.findById(f._id)).temperatures.nozzle).toBe(240);
    });

    it("a same-type tie writes neither the row nor the filament-wide temps", async () => {
      // Both nozzles "Brass 0.4 HF": the hint can't tell them apart.
      const { wc, indx } = await seedLibrary();
      await Nozzle.updateOne({ _id: wc._id }, { $set: { type: "Brass" } });
      const f = await filamentTicking([wc._id, indx._id], { temperatures: { nozzle: 240 } });

      const res = await post(String(f._id), "", perNozzleConfig("0.4 Brass HF", "255"), "PETG Galaxy 0.4 Brass HF");

      const body = await res.json();
      expect(body.calibration.status).toBe("ambiguous");
      expect(body.calibration.fields).toContain("nozzleTemp");
      expect(await rows(f._id)).toHaveLength(0);
      // Pre-N041 a miss fell back to the shared default; a tie must not, or
      // one nozzle's 255 °C would overwrite the filament-wide 240.
      expect((await Filament.findById(f._id)).temperatures.nozzle).toBe(240);
    });

    it("a same-type tie resolves with the printer hint", async () => {
      const { wc, indx, h2d } = await seedLibrary();
      await Nozzle.updateOne({ _id: wc._id }, { $set: { type: "Brass" } });
      const f = await filamentTicking([wc._id, indx._id], { temperatures: { nozzle: 240 } });

      const res = await post(
        String(f._id),
        `?printer=${h2d._id}`,
        perNozzleConfig("0.4 Brass HF", "255"),
        "PETG Galaxy 0.4 Brass HF",
      );

      expect((await res.json()).calibration).toMatchObject({ status: "written", resolvedBy: "printer" });
      const cals = await rows(f._id);
      expect(String(cals[0].nozzle)).toBe(String(wc._id));
      expect(cals[0].nozzleTemp).toBe(255);
    });

    it("no matching nozzle still falls back to the filament-wide temps", async () => {
      const { indx } = await seedLibrary();
      const f = await filamentTicking([indx._id], { temperatures: { nozzle: 240 } });

      const res = await post(String(f._id), "", perNozzleConfig("0.6 Brass", "260"), "PETG Galaxy 0.6 Brass");

      expect((await res.json()).calibration.status).toBe("no_match");
      expect((await Filament.findById(f._id)).temperatures.nozzle).toBe(260);
    });
  });

  describe("write: variant inheritance", () => {
    it("breaks the tie with the PARENT's rows when the variant inherits them", async () => {
      const { wc, indx } = await seedLibrary();
      const parent = await filamentTicking([wc._id, indx._id], {
        name: "PETG Template",
        calibrations: [{ nozzle: indx._id, extrusionMultiplier: 0.99 }],
      });
      const variant = await Filament.create({ name: "PETG Red", vendor: "Prusament", type: "PETG", parentId: parent._id });

      await post(String(variant._id), "?nozzle_diameter=0.4&high_flow=1", { extrusion_multiplier: "0.94" });

      expect(await rows(variant._id)).toHaveLength(0);
      const cals = await rows(parent._id);
      expect(cals).toHaveLength(1);
      expect(String(cals[0].nozzle)).toBe(String(indx._id));
      expect(cals[0].extrusionMultiplier).toBe(0.94);
    });
  });

  describe("read: /calibration answers from the nozzle the write would use", () => {
    async function seedBothRows() {
      const lib = await seedLibrary();
      // The H2D nozzle's row sits FIRST, so the old array-order read always
      // answered from it.
      const f = await filamentTicking([lib.wc._id, lib.indx._id], {
        calibrations: [
          { nozzle: lib.wc._id, pressureAdvance: 0.02 },
          { nozzle: lib.indx._id, pressureAdvance: 0.04 },
        ],
      });
      return { ...lib, f };
    }

    it("?printer= picks that printer's nozzle among printer-less rows", async () => {
      const { f, core } = await seedBothRows();
      const byCore = await read(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${core._id}`);
      expect((await byCore.json()).calibration.pressureAdvance).toBe(0.04);
      const byH2d = await read(String(f._id), "?nozzle_diameter=0.4&high_flow=1&printer=Bambu%20H2D");
      expect((await byH2d.json()).calibration.pressureAdvance).toBe(0.02);
    });

    it("a printer-scoped row on another nozzle does not outrank the resolved nozzle", async () => {
      const { wc, indx, core } = await seedLibrary();
      // An orphaned Core-scoped row on the H2D's nozzle (which the Core does
      // not carry) sits ahead of the Core nozzle's own default.
      const f = await filamentTicking([wc._id, indx._id], {
        calibrations: [
          { nozzle: wc._id, printer: core._id, pressureAdvance: 0.09 },
          { nozzle: indx._id, pressureAdvance: 0.04 },
        ],
      });
      const res = await read(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${core._id}`);
      expect((await res.json()).calibration.pressureAdvance).toBe(0.04);
    });

    it("an unresolved tie keeps the best-effort answer (the read stays soft)", async () => {
      const { f } = await seedBothRows();
      const res = await read(String(f._id), "?nozzle_diameter=0.4&high_flow=1");
      expect(res.status).toBe(200);
      expect((await res.json()).calibration.pressureAdvance).toBe(0.02);
    });

    it("reads back exactly what a printer-scoped sync wrote", async () => {
      const { wc, indx, h2d, core } = await seedLibrary();
      // Only the Core nozzle has a row so far; the old read would have
      // answered every printer from it.
      const f = await filamentTicking([wc._id, indx._id], {
        calibrations: [{ nozzle: indx._id, pressureAdvance: 0.04 }],
      });

      const before = await read(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${h2d._id}`);
      expect((await before.json()).calibration.pressureAdvance).toBe(0.04); // no H2D row yet: best effort

      await post(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${h2d._id}`, {
        pressure_advance_value: "0.025",
      });

      const h2dRead = await read(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${h2d._id}`);
      expect((await h2dRead.json()).calibration.pressureAdvance).toBe(0.025);
      const coreRead = await read(String(f._id), `?nozzle_diameter=0.4&high_flow=1&printer=${core._id}`);
      expect((await coreRead.json()).calibration.pressureAdvance).toBe(0.04);
    });

    it("without a printer, the read and the write both follow the existing row", async () => {
      const { wc, indx } = await seedLibrary();
      const stray = await Nozzle.create({ name: "Stray 0.4 HF", diameter: 0.4, type: "Brass", highFlow: true });
      // A row on a nozzle the filament no longer ticks sits first; the write
      // would land on the ticked INDX nozzle's row, so the read must too.
      const f = await filamentTicking([wc._id, indx._id], {
        calibrations: [
          { nozzle: stray._id, pressureAdvance: 0.07 },
          { nozzle: indx._id, pressureAdvance: 0.04 },
        ],
      });
      const res = await read(String(f._id), "?nozzle_diameter=0.4&high_flow=1");
      expect((await res.json()).calibration.pressureAdvance).toBe(0.04);
    });

    it("a variant reads through its parent's rows", async () => {
      const { wc, indx, core } = await seedLibrary();
      const parent = await filamentTicking([wc._id, indx._id], {
        name: "PETG Template",
        calibrations: [
          { nozzle: wc._id, pressureAdvance: 0.02 },
          { nozzle: indx._id, pressureAdvance: 0.04 },
        ],
      });
      const variant = await Filament.create({ name: "PETG Red", vendor: "Prusament", type: "PETG", parentId: parent._id });
      const res = await read(String(variant._id), `?nozzle_diameter=0.4&high_flow=1&printer=${core._id}`);
      expect((await res.json()).calibration.pressureAdvance).toBe(0.04);
    });
  });
});
