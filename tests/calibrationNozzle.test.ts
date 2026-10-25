import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  calibratedNozzleIds,
  nozzleCriteriaQuery,
  pickCalibrationNozzle,
  resolveCalibrationNozzle,
} from "@/lib/calibrationNozzle";
import type { PrinterScope } from "@/lib/slicerExportScope";

/**
 * N041: the one nozzle choice the PrusaSlicer sync-back write and the
 * /calibration read share. The route-level behaviour (what lands where, the
 * 200's `calibration` report, read/write agreement) is pinned in
 * tests/calibration-nozzle-route.test.ts; this file pins the rules.
 */
const NONE: PrinterScope = { kind: "none" };
const scoped = (printerId: string, nozzleIds: string[]): PrinterScope => ({
  kind: "scoped",
  printerId,
  printerName: "P",
  nozzleIds: new Set(nozzleIds),
});

describe("pickCalibrationNozzle", () => {
  it("answers none for no candidates", () => {
    expect(pickCalibrationNozzle([], { printer: NONE, calibrated: new Set() })).toEqual({ kind: "none" });
  });

  it("takes a lone candidate whatever the printer or rows say", () => {
    expect(
      pickCalibrationNozzle(["a", "a"], {
        printer: { kind: "not-found", raw: "Typo" },
        calibrated: new Set(),
      }),
    ).toEqual({ kind: "resolved", nozzleId: "a", by: "only" });
  });

  it("refuses a tie it has nothing to break, reporting it sorted", () => {
    expect(pickCalibrationNozzle(["b", "a"], { printer: NONE, calibrated: new Set() })).toEqual({
      kind: "ambiguous",
      candidateIds: ["a", "b"],
    });
  });

  it("is independent of candidate order", () => {
    const opts = { printer: NONE, calibrated: new Set(["b"]) };
    expect(pickCalibrationNozzle(["a", "b"], opts)).toEqual(pickCalibrationNozzle(["b", "a"], opts));
  });

  it("prefers the nozzle the named printer has installed", () => {
    expect(
      pickCalibrationNozzle(["a", "b"], { printer: scoped("p", ["b"]), calibrated: new Set(["a"]) }),
    ).toEqual({ kind: "resolved", nozzleId: "b", by: "printer" });
  });

  it("narrows to the printer's nozzles when it has several, then uses rows", () => {
    expect(
      pickCalibrationNozzle(["a", "b", "c"], {
        printer: scoped("p", ["b", "c"]),
        calibrated: new Set(["a", "c"]),
      }),
    ).toEqual({ kind: "resolved", nozzleId: "c", by: "calibrated" });
    expect(
      pickCalibrationNozzle(["a", "b", "c"], { printer: scoped("p", ["b", "c"]), calibrated: new Set(["a"]) }),
    ).toEqual({ kind: "ambiguous", candidateIds: ["b", "c"] });
  });

  it("ignores a printer that owns none of the candidates", () => {
    expect(
      pickCalibrationNozzle(["a", "b"], { printer: scoped("p", ["z"]), calibrated: new Set(["b"]) }),
    ).toEqual({ kind: "resolved", nozzleId: "b", by: "calibrated" });
  });

  it("prefers the one candidate already carrying a row", () => {
    expect(pickCalibrationNozzle(["a", "b"], { printer: NONE, calibrated: new Set(["b", "zz"]) })).toEqual({
      kind: "resolved",
      nozzleId: "b",
      by: "calibrated",
    });
  });

  it("does not fall back to rows when the asked-for printer does not exist", () => {
    expect(
      pickCalibrationNozzle(["a", "b"], {
        printer: { kind: "not-found", raw: "Typo" },
        calibrated: new Set(["a"]),
      }),
    ).toEqual({ kind: "printer-not-found", candidateIds: ["a", "b"] });
  });
});

describe("calibratedNozzleIds", () => {
  const n1 = new mongoose.Types.ObjectId();
  const n2 = new mongoose.Types.ObjectId();
  const n3 = new mongoose.Types.ObjectId();
  const p1 = new mongoose.Types.ObjectId();
  const p2 = new mongoose.Types.ObjectId();

  it("counts printer-less rows, and rows scoped to the named printer", () => {
    const rows = [
      { nozzle: n1, printer: null },
      { nozzle: { _id: n2 }, printer: { _id: p1 } }, // populated shape
      { nozzle: String(n3), printer: String(p2) }, // plain strings
      { nozzle: null, printer: null }, // dangling nozzle ref
    ];
    expect(calibratedNozzleIds(rows, null)).toEqual(new Set([String(n1)]));
    expect(calibratedNozzleIds(rows, String(p1))).toEqual(new Set([String(n1), String(n2)]));
  });

  it("tolerates a missing array", () => {
    expect(calibratedNozzleIds(undefined, null)).toEqual(new Set());
  });
});

describe("nozzleCriteriaQuery", () => {
  it("filters only on what was given", () => {
    expect(nozzleCriteriaQuery({ diameter: 0.4 })).toEqual({ diameter: 0.4, _deletedAt: null });
  });

  it("maps every high-flow form and escapes the type", () => {
    expect(nozzleCriteriaQuery({ diameter: 0.4, highFlow: true }).highFlow).toBe(true);
    expect(nozzleCriteriaQuery({ diameter: 0.4, highFlow: false }).highFlow).toBe(false);
    expect(nozzleCriteriaQuery({ diameter: 0.4, highFlow: "not-high-flow" }).highFlow).toEqual({ $ne: true });
    expect(nozzleCriteriaQuery({ diameter: 0.4, type: "W.C" }).type).toEqual({
      $regex: "^W\\.C$",
      $options: "i",
    });
  });
});

describe("resolveCalibrationNozzle", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Nozzle: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const nozMod = await import("@/models/Nozzle");
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    Nozzle = mongoose.models.Nozzle;
  });

  async function seed() {
    const indx = await Nozzle.create({ name: "INDX 0.4 HF", diameter: 0.4, type: "Brass", highFlow: true });
    const wc = await Nozzle.create({ name: "WC HF 0.4", diameter: 0.4, type: "WC", highFlow: true });
    const std = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    await Nozzle.create({ name: "Gone 0.4 HF", diameter: 0.4, type: "Brass", highFlow: true, _deletedAt: new Date() });
    return { indx: String(indx._id), wc: String(wc._id), std: String(std._id) };
  }

  it("resolves inside the compatible tier and reports the candidates", async () => {
    const { indx, wc } = await seed();
    const res = await resolveCalibrationNozzle(Nozzle, {
      criteria: { diameter: 0.4, highFlow: true },
      compatibleNozzleIds: [indx, wc],
      calibrations: [{ nozzle: indx, printer: null }],
      printer: NONE,
    });
    expect(res).toMatchObject({ kind: "resolved", nozzleId: indx, by: "calibrated", scope: "compatible" });
    expect(res.kind === "resolved" && res.candidates.map((c) => c.name).sort()).toEqual(["INDX 0.4 HF", "WC HF 0.4"]);
  });

  it("reports a tie with only the tied nozzles", async () => {
    const { indx, wc, std } = await seed();
    const res = await resolveCalibrationNozzle(Nozzle, {
      criteria: { diameter: 0.4 },
      compatibleNozzleIds: [indx, wc, std],
      calibrations: [],
      printer: scoped("p", [indx, wc]),
    });
    expect(res.kind).toBe("ambiguous");
    expect(res.kind !== "none" && res.candidates.map((c) => c._id).sort()).toEqual([indx, wc].sort());
  });

  it("falls through to the catalog only when no compatible nozzle matches", async () => {
    const { indx, std } = await seed();
    const res = await resolveCalibrationNozzle(Nozzle, {
      criteria: { diameter: 0.4, highFlow: true },
      compatibleNozzleIds: [std],
      calibrations: null,
      printer: { kind: "not-found", raw: "Typo" },
    });
    expect(res).toMatchObject({ kind: "printer-not-found", scope: "catalog" });
    const byType = await resolveCalibrationNozzle(Nozzle, {
      criteria: { diameter: 0.4, highFlow: true, type: "brass" },
      compatibleNozzleIds: [],
      calibrations: null,
      printer: NONE,
    });
    expect(byType).toMatchObject({ kind: "resolved", nozzleId: indx, by: "only", scope: "catalog" });
  });

  it("answers none when nothing matches anywhere", async () => {
    await seed();
    const res = await resolveCalibrationNozzle(Nozzle, {
      criteria: { diameter: 0.6 },
      compatibleNozzleIds: [],
      calibrations: [],
      printer: NONE,
    });
    expect(res).toEqual({ kind: "none" });
  });

  it("loads lazily supplied rows once, and only to break a tie", async () => {
    const { indx, wc } = await seed();
    let loads = 0;
    const loader = async () => {
      loads++;
      return [{ nozzle: wc, printer: null }];
    };
    const lone = await resolveCalibrationNozzle(Nozzle, {
      criteria: { diameter: 0.4, highFlow: true },
      compatibleNozzleIds: [indx],
      calibrations: loader,
      printer: NONE,
    });
    expect(lone).toMatchObject({ kind: "resolved", nozzleId: indx, by: "only" });
    expect(loads).toBe(0);
    const tie = await resolveCalibrationNozzle(Nozzle, {
      criteria: { diameter: 0.4, highFlow: true },
      compatibleNozzleIds: [indx, wc],
      calibrations: loader,
      printer: NONE,
    });
    expect(tie).toMatchObject({ kind: "resolved", nozzleId: wc, by: "calibrated" });
    expect(loads).toBe(1);
  });
});
