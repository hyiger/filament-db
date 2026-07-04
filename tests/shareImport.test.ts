import { describe, it, expect } from "vitest";
import {
  partitionByParent,
  buildFilamentImportBody,
  buildPrinterImportBody,
  type ShareImportFilament,
  type ShareImportPrinter,
} from "@/lib/shareImport";

const fil = (over: Partial<ShareImportFilament>): ShareImportFilament => ({
  _id: "src1",
  name: "F",
  vendor: "V",
  type: "PLA",
  ...over,
});

describe("partitionByParent (GH #956)", () => {
  it("splits roots (no parentId) from variants (truthy parentId)", () => {
    const { roots, variants } = partitionByParent([
      fil({ _id: "a", parentId: undefined }),
      fil({ _id: "b", parentId: null }),
      fil({ _id: "c", parentId: "p1" }),
      fil({ _id: "d" }),
    ]);
    expect(roots.map((r) => r._id)).toEqual(["a", "b", "d"]);
    expect(variants.map((v) => v._id)).toEqual(["c"]);
  });
});

describe("buildFilamentImportBody (GH #956)", () => {
  const nozzleMap = new Map([["n_src", "n_local"]]);
  const printerMap = new Map([["p_src", "p_local"]]);
  const bedTypeMap = new Map([["b_src", "b_local"]]);

  it("strips _id and removes parentId for a root", () => {
    const body = buildFilamentImportBody(fil({ _id: "x" }), nozzleMap, printerMap, bedTypeMap, undefined);
    expect(body._id).toBeUndefined();
    expect("parentId" in body).toBe(false);
  });

  it("sets the remapped parentId for a variant", () => {
    const body = buildFilamentImportBody(fil({ parentId: "p_src" }), nozzleMap, printerMap, bedTypeMap, "p_local");
    expect(body.parentId).toBe("p_local");
  });

  it("remaps compatibleNozzles and drops unresolved ones", () => {
    const body = buildFilamentImportBody(
      fil({ compatibleNozzles: ["n_src", "unknown_src"] }),
      nozzleMap,
      printerMap,
      bedTypeMap,
      undefined,
    );
    expect(body.compatibleNozzles).toEqual(["n_local"]);
  });

  it("remaps calibration refs; keeps a mapped nozzle, nulls unresolved printer/bedType", () => {
    const body = buildFilamentImportBody(
      fil({ calibrations: [{ nozzle: "n_src", printer: "unknown", bedType: "b_src", extra: 1 }] }),
      nozzleMap,
      printerMap,
      bedTypeMap,
      undefined,
    );
    const cals = body.calibrations as Array<Record<string, unknown>>;
    expect(cals).toHaveLength(1);
    expect(cals[0]).toMatchObject({ nozzle: "n_local", printer: null, bedType: "b_local", extra: 1 });
  });

  it("drops a calibration whose nozzle can't be resolved (nozzle is required)", () => {
    const body = buildFilamentImportBody(
      fil({ calibrations: [{ nozzle: "unknown", printer: "p_src" }] }),
      nozzleMap,
      printerMap,
      bedTypeMap,
      undefined,
    );
    expect(body.calibrations).toEqual([]);
  });
});

describe("buildPrinterImportBody (GH #956)", () => {
  const nozzleMap = new Map([["n_src", "n_local"]]);
  const bedTypeMap = new Map([["b_src", "b_local"]]);
  const printer = (over: Partial<ShareImportPrinter>): ShareImportPrinter => ({
    _id: "pr1",
    name: "Core One",
    ...over,
  });

  it("strips _id and amsSlots", () => {
    const body = buildPrinterImportBody(
      printer({ amsSlots: [{ spoolId: "s1" }] }),
      nozzleMap,
      bedTypeMap,
    );
    expect(body._id).toBeUndefined();
    expect("amsSlots" in body).toBe(false);
  });

  it("remaps installedNozzles / installedBedTypes and drops unresolved entries", () => {
    const body = buildPrinterImportBody(
      printer({ installedNozzles: ["n_src", "gone"], installedBedTypes: ["b_src", "gone"] }),
      nozzleMap,
      bedTypeMap,
    );
    expect(body.installedNozzles).toEqual(["n_local"]);
    expect(body.installedBedTypes).toEqual(["b_local"]);
  });

  it("leaves absent installed arrays untouched (no key invented)", () => {
    const body = buildPrinterImportBody(printer({}), nozzleMap, bedTypeMap);
    expect("installedNozzles" in body).toBe(false);
    expect("installedBedTypes" in body).toBe(false);
  });
});
