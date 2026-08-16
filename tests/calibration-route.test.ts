import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as getCalibration } from "@/app/api/filaments/[id]/calibration/route";

/**
 * GET /api/filaments/{id}/calibration — the dynamic per-nozzle read path the
 * PrusaSlicer / OrcaSlicer forks call when the active printer (nozzle) changes.
 *
 * #872: a multi-nozzle filament exports one FLAT preset per nozzle. Pressure
 * advance is printer-scoped in PrusaSlicer, so it is NOT baked into the flat
 * preset — it stays dynamic via this endpoint. That makes type disambiguation
 * here essential: two same-diameter nozzles of different type (0.4 Brass vs
 * 0.4 Diamondback) with distinct PA must resolve to the right calibration, the
 * same way the sync-back route disambiguates via the filamentdb_nozzle hint.
 */
describe("GET /api/filaments/[id]/calibration", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Nozzle: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    // tests/setup.ts wipes mongoose.models between tests; the route populates
    // calibrations.{nozzle,printer,bedType}, so re-register the models here.
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
  });

  function getReq(url: string) {
    return new NextRequest(url, { method: "GET" });
  }

  it("returns the calibration for a plain diameter match", async () => {
    const noz = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      calibrations: [{ nozzle: noz._id, pressureAdvance: 0.04, extrusionMultiplier: 0.98 }],
    });
    const res = await getCalibration(
      getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4`),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.calibration.pressureAdvance).toBe(0.04);
    expect(json.calibration.extrusionMultiplier).toBe(0.98);
  });

  describe("GH #1047 Phase 0 — printer scoping", () => {
    async function seedTwoPrinters() {
      const Printer = mongoose.models.Printer;
      const noz = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
      const xl = await Printer.create({ name: "XL", manufacturer: "Prusa", printerModel: "XL" });
      const core = await Printer.create({
        name: "CoreOne", manufacturer: "Prusa", printerModel: "CoreOne",
      });
      const f = await Filament.create({
        name: "PETG", vendor: "X", type: "PETG",
        calibrations: [
          // Printer-scoped entries first, so "whatever sorts first" would
          // pick the XL one and never the shareable default.
          { nozzle: noz._id, printer: xl._id, pressureAdvance: 0.05 },
          { nozzle: noz._id, printer: core._id, pressureAdvance: 0.09 },
          { nozzle: noz._id, pressureAdvance: 0.02 }, // shareable default
        ],
      });
      return { f, xl, core };
    }

    it("selects the calibration for the named printer", async () => {
      const { f } = await seedTwoPrinters();
      const res = await getCalibration(
        getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&printer=CoreOne`),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect((await res.json()).calibration.pressureAdvance).toBe(0.09);
    });

    it("accepts an ObjectId as well as a name (the bed_type convention)", async () => {
      const { f, xl } = await seedTwoPrinters();
      const res = await getCalibration(
        getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&printer=${xl._id}`),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect((await res.json()).calibration.pressureAdvance).toBe(0.05);
    });

    it("matches an ObjectId case-insensitively and ignores stray whitespace", async () => {
      const { f, xl } = await seedTwoPrinters();
      const upper = String(xl._id).toUpperCase();
      const res = await getCalibration(
        getReq(
          `http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&printer=${encodeURIComponent(` ${upper} `)}`,
        ),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      // Pre-fix this silently returned the printer-less default (0.02).
      expect((await res.json()).calibration.pressureAdvance).toBe(0.05);
    });

    it("falls back to the shareable default for an UNKNOWN printer — never a 404", async () => {
      const { f } = await seedTwoPrinters();
      const res = await getCalibration(
        getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&printer=NoSuchPrinter`),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).calibration.pressureAdvance).toBe(0.02);
    });

    it("with NO printer param prefers the shareable default (deterministic)", async () => {
      // Behavior change, deliberate: the old code took whatever sorted first
      // — here an XL-specific entry — for a caller that never named a
      // printer. The printer-null default is what the bundle exporter
      // already prefers when baking a preset.
      const { f } = await seedTwoPrinters();
      const res = await getCalibration(
        getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4`),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect((await res.json()).calibration.pressureAdvance).toBe(0.02);
    });

    it("keeps the bedless default reachable after printer narrowing (Codex P2)", async () => {
      // (P, Textured) + (null, null): asking for P with bed_type=Smooth must
      // fall back to the BEDLESS generic, per the documented bed-type rule —
      // a filter-based narrowing hid it and returned the Textured entry.
      const Printer = mongoose.models.Printer;
      const BedType = mongoose.models.BedType;
      const noz = await Nozzle.create({ name: "0.4 B", diameter: 0.4, type: "Brass" });
      const p1 = await Printer.create({ name: "P1", manufacturer: "M", printerModel: "X" });
      const textured = await BedType.create({ name: "Textured", material: "PEI" });
      const f = await Filament.create({
        name: "PC", vendor: "X", type: "PC",
        calibrations: [
          { nozzle: noz._id, printer: p1._id, bedType: textured._id, pressureAdvance: 0.11 },
          { nozzle: noz._id, pressureAdvance: 0.01 }, // generic + bedless
        ],
      });
      const res = await getCalibration(
        getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&printer=P1&bed_type=Smooth`),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect((await res.json()).calibration.pressureAdvance).toBe(0.01);
    });

    it("prefers the EXACT printer name over a case-folded twin (Codex P2)", async () => {
      // The Printer name index is case-sensitive, so XL and xl can coexist.
      const Printer = mongoose.models.Printer;
      const noz = await Nozzle.create({ name: "0.4 C", diameter: 0.4, type: "Brass" });
      const lower = await Printer.create({ name: "xl", manufacturer: "M", printerModel: "X" });
      const upper = await Printer.create({ name: "XL", manufacturer: "M", printerModel: "X" });
      const f = await Filament.create({
        name: "TPU", vendor: "X", type: "TPU",
        calibrations: [
          { nozzle: noz._id, printer: lower._id, pressureAdvance: 0.21 }, // sorts first
          { nozzle: noz._id, printer: upper._id, pressureAdvance: 0.22 },
        ],
      });
      const res = await getCalibration(
        getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&printer=XL`),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      // Array order would have handed back the lowercase machine's 0.21.
      expect((await res.json()).calibration.pressureAdvance).toBe(0.22);
    });

    it("still answers when only printer-scoped entries exist", async () => {
      const Printer = mongoose.models.Printer;
      const noz = await Nozzle.create({ name: "0.6 Brass", diameter: 0.6, type: "Brass" });
      const xl = await Printer.create({ name: "XL2", manufacturer: "Prusa", printerModel: "XL" });
      const f = await Filament.create({
        name: "ASA", vendor: "X", type: "ASA",
        calibrations: [{ nozzle: noz._id, printer: xl._id, pressureAdvance: 0.06 }],
      });
      const res = await getCalibration(
        getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.6`),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).calibration.pressureAdvance).toBe(0.06);
    });
  });

  it("#872 — nozzle_type disambiguates same-diameter nozzles with distinct PA", async () => {
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const diamond = await Nozzle.create({ name: "0.4 Diamondback", diameter: 0.4, type: "Diamondback" });
    const f = await Filament.create({
      name: "PA12-CF",
      vendor: "X",
      type: "PA12-CF",
      calibrations: [
        { nozzle: brass._id, pressureAdvance: 0.03 },
        { nozzle: diamond._id, pressureAdvance: 0.07 },
      ],
    });
    // Without nozzle_type, the read path returns the FIRST 0.4 entry (Brass) —
    // ambiguous, the exact bug this fix closes.
    const ambiguous = await getCalibration(
      getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4`),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect((await ambiguous.json()).calibration.pressureAdvance).toBe(0.03);

    // WITH nozzle_type=Diamondback it resolves the Diamondback entry's PA.
    const diamondRes = await getCalibration(
      getReq(
        `http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&nozzle_type=Diamondback`,
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(diamondRes.status).toBe(200);
    const dj = await diamondRes.json();
    expect(dj.calibration.pressureAdvance).toBe(0.07);
    expect(dj.nozzle.name).toBe("0.4 Diamondback");

    // And nozzle_type=Brass resolves the Brass entry.
    const brassRes = await getCalibration(
      getReq(
        `http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&nozzle_type=Brass`,
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect((await brassRes.json()).calibration.pressureAdvance).toBe(0.03);
  });

  it("#872 — nozzle_type compare is case-insensitive", async () => {
    const diamond = await Nozzle.create({ name: "0.4 Diamondback", diameter: 0.4, type: "Diamondback" });
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      calibrations: [
        { nozzle: brass._id, pressureAdvance: 0.02 },
        { nozzle: diamond._id, pressureAdvance: 0.09 },
      ],
    });
    const res = await getCalibration(
      getReq(
        `http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&nozzle_type=diamondback`,
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect((await res.json()).calibration.pressureAdvance).toBe(0.09);
  });

  it("#872 — an unmatched nozzle_type falls back to diameter matches (no 404 regression)", async () => {
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      calibrations: [{ nozzle: brass._id, pressureAdvance: 0.05 }],
    });
    const res = await getCalibration(
      getReq(
        `http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&nozzle_type=Carbide`,
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200); // soft filter — still serves the diameter match
    expect((await res.json()).calibration.pressureAdvance).toBe(0.05);
  });

  it("high_flow disambiguates standard vs high-flow at the same diameter", async () => {
    const std = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass", highFlow: false });
    const hf = await Nozzle.create({ name: "0.4 Brass HF", diameter: 0.4, type: "Brass", highFlow: true });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      calibrations: [
        { nozzle: std._id, pressureAdvance: 0.04 },
        { nozzle: hf._id, pressureAdvance: 0.06 },
      ],
    });
    const res = await getCalibration(
      getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.4&high_flow=1`),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect((await res.json()).calibration.pressureAdvance).toBe(0.06);
  });

  it("404s with an available[] list (incl. type) when no diameter matches", async () => {
    const noz = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      calibrations: [{ nozzle: noz._id, pressureAdvance: 0.04 }],
    });
    const res = await getCalibration(
      getReq(`http://localhost/api/filaments/${f._id}/calibration?nozzle_diameter=0.8`),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.available).toEqual([{ diameter: 0.4, name: "0.4 Brass", type: "Brass", highFlow: false }]);
  });

  it("GH #950: a 24-hex id param resolves by _id FIRST, not a name that looks like an id", async () => {
    // The slicer calls this endpoint by the same {id} the id-first sync/export
    // routes use — so it must resolve id-first too, or the slicer reads the
    // WRONG filament's per-nozzle calibration (silently mis-calibrating).
    const noz = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const real = await Filament.create({
      name: "Real Cal PLA",
      vendor: "X",
      type: "PLA",
      calibrations: [{ nozzle: noz._id, pressureAdvance: 0.042, extrusionMultiplier: 0.97 }],
    });
    // A DIFFERENT filament NAMED with the real one's 24-hex _id, with its OWN
    // (distinct) calibration — the decoy the name-first lookup would have hit.
    await Filament.create({
      name: String(real._id),
      vendor: "X",
      type: "ABS",
      calibrations: [{ nozzle: noz._id, pressureAdvance: 0.099, extrusionMultiplier: 1.5 }],
    });
    const res = await getCalibration(
      getReq(`http://localhost/api/filaments/${real._id}/calibration?nozzle_diameter=0.4`),
      { params: Promise.resolve({ id: String(real._id) }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // The _id lookup wins: we read the real filament's PA, not the decoy's 0.099.
    expect(json.calibration.pressureAdvance).toBe(0.042);
    expect(json.calibration.extrusionMultiplier).toBe(0.97);
  });
});
