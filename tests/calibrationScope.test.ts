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
  nozzlesLoaded: true,
  printersLoaded: true,
  bedTypesLoaded: true,
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
      isCalibrationRowReachable(
        calibrationKey(P1, N1, null),
        ctx({ nozzleOwnership: new Map(), nozzlesLoaded: false }),
      ),
    ).toBe(true);
  });

  it("fails OPEN for a printer-scoped row while /api/printers is still loading", () => {
    // Codex P2 on PR #1130: the three catalogs load independently, so nozzles
    // routinely resolves first. Judging a printer-scoped row against an empty
    // printer list would put valid data in the orphan list WITH an active
    // Remove button — one click from real loss.
    expect(
      isCalibrationRowReachable(
        calibrationKey(P1, N1, null),
        ctx({ relevantPrinterIds: [], printersLoaded: false }),
      ),
    ).toBe(true);
  });

  it("fails OPEN for a bed-scoped row while /api/bed-types is still loading", () => {
    expect(
      isCalibrationRowReachable(
        calibrationKey(null, N1, B1),
        ctx({ bedTypeIds: [], bedTypesLoaded: false }),
      ),
    ).toBe(true);
  });

  it("still orphans a printer-scoped row once the LOADED printer list is empty", () => {
    // Zero printers is a legitimate state — the row really is unreachable
    // then. This is why the flags are explicit rather than inferred from the
    // array being empty.
    expect(
      isCalibrationRowReachable(
        calibrationKey(P1, N1, null),
        ctx({ relevantPrinterIds: [], printersLoaded: true }),
      ),
    ).toBe(false);
  });

  it("treats a FAILED catalog like a pending one", () => {
    // Codex P2 (round 2) on PR #1130: the form's `finally` clears each loading
    // flag on failure too, so "settled" is not "loaded". The caller derives
    // these flags from success, and this pins the semantics the lib relies on:
    // a false flag must fail open regardless of WHY it is false.
    expect(
      isCalibrationRowReachable(
        calibrationKey(P1, N1, null),
        ctx({ relevantPrinterIds: [], printersLoaded: false }),
      ),
    ).toBe(true);
    expect(
      isCalibrationRowReachable(
        calibrationKey(null, N1, null),
        ctx({ nozzleOwnership: new Map(), nozzlesLoaded: false }),
      ),
    ).toBe(true);
  });

  it("a failed nozzle catalog does not short-circuit the bed or printer checks", () => {
    // Codex P2 (round 4) on PR #1130: with /api/nozzles down but the other two
    // catalogs healthy, a row scoped to a deleted bed type (or a printer with
    // no tab) is still demonstrably unrenderable — it must stay in the orphan
    // list rather than vanish for the session.
    expect(
      isCalibrationRowReachable(
        calibrationKey(null, N1, "deletedBed"),
        ctx({ nozzlesLoaded: false, nozzleOwnership: new Map() }),
      ),
    ).toBe(false);
    // NOT the printer clause, though: the caller derives relevantPrinterIds
    // from the nozzle catalog, so with nozzles down an empty list says nothing
    // about the printers (Codex P2 round 5).
    expect(
      isCalibrationRowReachable(
        calibrationKey(P1, N1, null),
        ctx({ nozzlesLoaded: false, nozzleOwnership: new Map(), relevantPrinterIds: [] }),
      ),
    ).toBe(true);
  });

  it("an unknown bed catalog does not short-circuit the printer checks", () => {
    // Codex P2 (round 3) on PR #1130: a blanket `return true` for an unloaded
    // bed catalog hid rows whose PRINTER scope is independently known to be
    // unreachable — invisible AND without the Remove action, for as long as
    // /api/bed-types stayed broken.
    expect(
      isCalibrationRowReachable(
        calibrationKey(P1, N1, B1),
        ctx({ bedTypesLoaded: false, relevantPrinterIds: [] }),
      ),
    ).toBe(false);
    // ...while a bed-scoped row with an otherwise-fine printer still fails open.
    expect(
      isCalibrationRowReachable(
        calibrationKey(P1, N1, "unknownBed"),
        ctx({ bedTypesLoaded: false }),
      ),
    ).toBe(true);
  });

  it("a still-loading printer catalog does not rescue a row failing another clause", () => {
    // The fail-open is per-clause: an unticked nozzle is still unreachable.
    expect(
      isCalibrationRowReachable(
        calibrationKey(P1, "untickedNozzle", null),
        ctx({ printersLoaded: false }),
      ),
    ).toBe(false);
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
