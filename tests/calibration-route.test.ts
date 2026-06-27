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
});
