import { describe, it, expect } from "vitest";
import {
  CAL_ANY_BED,
  CAL_DEFAULT_PRINTER,
  calibrationKey,
  parseCalibrationKey,
  hasCalibrationData,
  isCalibrationRowReachable,
  partitionCalibrationKeys,
  keepCalibrationEntries,
  type CalibrationGridContext,
} from "@/lib/calibrationScope";

const N1 = "6a00000000000000000000n1";
const N2 = "6a00000000000000000000n2";
const P1 = "6a00000000000000000000p1";
const B1 = "6a00000000000000000000b1";

const ctx = (over: Partial<CalibrationGridContext> = {}): CalibrationGridContext => ({
  compatibleNozzleIds: [N1],
  nozzleOwnership: new Map([[N1, [P1]]]),
  relevantPrinterIds: [P1],
  bedTypeIds: [B1],
  ...over,
});

describe("calibrationKey / parseCalibrationKey", () => {
  it("reproduces the form's historical encoding byte-for-byte", () => {
    // The keys identify rows already sitting in component state, so a change
    // here silently orphans every loaded calibration.
    expect(calibrationKey(null, N1, null)).toBe(`${CAL_DEFAULT_PRINTER}:${N1}:${CAL_ANY_BED}`);
    expect(calibrationKey(P1, N1, B1)).toBe(`${P1}:${N1}:${B1}`);
  });

  it("treats empty strings like null, as the template literal did", () => {
    expect(calibrationKey("", N1, "")).toBe(`${CAL_DEFAULT_PRINTER}:${N1}:${CAL_ANY_BED}`);
  });

  it("round-trips through parse", () => {
    for (const scope of [
      { printerId: null, nozzleId: N1, bedTypeId: null },
      { printerId: P1, nozzleId: N1, bedTypeId: null },
      { printerId: null, nozzleId: N1, bedTypeId: B1 },
      { printerId: P1, nozzleId: N2, bedTypeId: B1 },
    ]) {
      const key = calibrationKey(scope.printerId, scope.nozzleId, scope.bedTypeId);
      expect(parseCalibrationKey(key)).toEqual(scope);
    }
  });

  it("maps both sentinels back to null", () => {
    expect(parseCalibrationKey(`default:${N1}:any`)).toEqual({
      printerId: null,
      nozzleId: N1,
      bedTypeId: null,
    });
  });

  it("tolerates a two-segment legacy key", () => {
    // Older keys predate the bed dimension; a missing third segment must read
    // as "any bed", not as the string "undefined".
    expect(parseCalibrationKey(`default:${N1}`).bedTypeId).toBeNull();
  });
});

describe("hasCalibrationData", () => {
  it("is false only when every field is blank", () => {
    expect(hasCalibrationData({ a: "", b: "" })).toBe(false);
    expect(hasCalibrationData({ a: "", b: "0" })).toBe(true);
    expect(hasCalibrationData({})).toBe(false);
  });

  it("treats an explicit zero as data", () => {
    // "0" is a legitimate pressure-advance value; dropping it would delete the
    // row the user just set.
    expect(hasCalibrationData({ pressureAdvance: "0" })).toBe(true);
  });
});

describe("isCalibrationRowReachable", () => {
  it("reaches a default-scope row whose nozzle is ticked", () => {
    expect(isCalibrationRowReachable(calibrationKey(null, N1, null), ctx())).toBe(true);
  });

  it("does NOT reach a row whose nozzle isn't ticked — the #1101 case", () => {
    // The slicer sync-back writes exactly this: a calibration on a nozzle the
    // filament never had ticked. It used to be deleted on the next save.
    expect(
      isCalibrationRowReachable(calibrationKey(null, N2, null), ctx({ nozzleOwnership: new Map([[N1, [P1]], [N2, [P1]]]) })),
    ).toBe(false);
  });

  it("does NOT reach a row whose nozzle is gone from a loaded catalog", () => {
    // This is the case that would reintroduce #358's undeletable orphan if the
    // save kept everything but the grid still couldn't render it.
    expect(
      isCalibrationRowReachable(calibrationKey(null, N2, null), ctx({ compatibleNozzleIds: [N1, N2] })),
    ).toBe(false);
  });

  it("fails OPEN while the nozzle catalog is still loading", () => {
    // PR #358 round 2: /api/nozzles is async. Treating an unloaded catalog as
    // "unreachable" would dump every valid per-printer row into the orphan
    // list and invite the user to delete it.
    expect(
      isCalibrationRowReachable(calibrationKey(P1, N1, null), ctx({ nozzleOwnership: new Map() })),
    ).toBe(true);
  });

  it("does not reach a printer-scoped row whose printer has no tab", () => {
    expect(
      isCalibrationRowReachable(calibrationKey(P1, N1, null), ctx({ relevantPrinterIds: [] })),
    ).toBe(false);
  });

  it("does not reach a printer-scoped row whose printer no longer owns the nozzle", () => {
    // The exact state PR #358 was written for — now surfaced instead of deleted.
    expect(
      isCalibrationRowReachable(
        calibrationKey(P1, N1, null),
        ctx({ nozzleOwnership: new Map([[N1, []]]) }),
      ),
    ).toBe(false);
  });

  it("does not reach a row scoped to a bed type with no tab", () => {
    expect(
      isCalibrationRowReachable(calibrationKey(null, N1, "gone"), ctx()),
    ).toBe(false);
  });

  it("reaches a fully-scoped row when every part has a tab", () => {
    expect(isCalibrationRowReachable(calibrationKey(P1, N1, B1), ctx())).toBe(true);
  });
});

describe("partitionCalibrationKeys", () => {
  it("splits reachable from orphaned, preserving order", () => {
    const reachable = calibrationKey(null, N1, null);
    const orphan = calibrationKey(null, N2, null);
    const res = partitionCalibrationKeys([reachable, orphan], ctx());
    expect(res.reachableKeys).toEqual([reachable]);
    expect(res.orphanKeys).toEqual([orphan]);
  });

  it("returns empty lists for no keys", () => {
    expect(partitionCalibrationKeys([], ctx())).toEqual({ reachableKeys: [], orphanKeys: [] });
  });
});

describe("keepCalibrationEntries", () => {
  it("keeps a row the grid never rendered — the #1101 fix", () => {
    // An empty compatibleNozzles used to drop EVERY row here, because
    // [].includes(x) is always false. Scope is no longer consulted at all.
    const entries: [string, Record<string, string>][] = [
      [calibrationKey(null, N2, null), { extrusionMultiplier: "0.98" }],
    ];
    expect(keepCalibrationEntries(entries)).toHaveLength(1);
  });

  it("still drops a row the user blanked", () => {
    const entries: [string, Record<string, string>][] = [
      [calibrationKey(null, N1, null), { extrusionMultiplier: "", pressureAdvance: "" }],
    ];
    expect(keepCalibrationEntries(entries)).toHaveLength(0);
  });

  it("keeps a printer-scoped row whose printer lost the nozzle", () => {
    // PR #358 deleted these on save. They are now kept and surfaced.
    const entries: [string, Record<string, string>][] = [
      [calibrationKey(P1, N1, B1), { pressureAdvance: "0.04" }],
    ];
    expect(keepCalibrationEntries(entries)).toHaveLength(1);
  });
});
