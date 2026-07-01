import { describe, it, expect } from "vitest";
import type { Model } from "mongoose";
import {
  findNozzleConflicts,
  NozzleConflictError,
  nextCloneName,
  type NozzleConflict,
} from "@/lib/nozzleConflicts";

/**
 * Unit coverage for `findNozzleConflicts` branch logic + the
 * `NozzleConflictError` class. `findNozzleConflicts` only ever calls
 * `Model.find(filter).select(...).lean()`, so we hand it lightweight fake
 * models that record the filter and return canned documents — no DB needed,
 * and it lets us drive each branch deterministically (a nozzle claimed by
 * multiple printers, a `$in`-matched printer that also carries unrelated
 * nozzles, a printer with no `installedNozzles`, an un-hydrated nozzle name).
 *
 * The DB-backed happy path (real Mongoose models) is covered separately in
 * tests/nozzle-printer-uniqueness.test.ts; here we pin the edge branches.
 */

type Doc = Record<string, unknown>;

/**
 * Build a fake Mongoose model whose `.find(filter).select(...).lean()` chain
 * resolves to `docs`. Records the last filter passed for assertions.
 */
function fakeModel(docs: Doc[]): {
  model: Model<unknown>;
  lastFilter: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const chain = {
    select() {
      return chain;
    },
    lean() {
      return Promise.resolve(docs);
    },
  };
  const model = {
    find(filter: Record<string, unknown>) {
      captured = filter;
      return chain;
    },
  } as unknown as Model<unknown>;
  return { model, lastFilter: () => captured };
}

describe("findNozzleConflicts", () => {
  it("returns [] immediately for an empty incoming id list (line 71 — no query)", async () => {
    const printer = fakeModel([{ _id: "p1", name: "A", installedNozzles: ["n1"] }]);
    const nozzle = fakeModel([]);
    const out = await findNozzleConflicts(printer.model, nozzle.model, [], null);
    expect(out).toEqual([]);
    // Short-circuits before any query runs.
    expect(printer.lastFilter()).toBeUndefined();
  });

  it("returns [] when incomingIds is null/undefined (line 71 — falsy guard)", async () => {
    const printer = fakeModel([]);
    const nozzle = fakeModel([]);
    const out = await findNozzleConflicts(
      printer.model,
      nozzle.model,
      // exercise the `!incomingIds` half of the guard
      null as unknown as string[],
      null,
    );
    expect(out).toEqual([]);
    expect(printer.lastFilter()).toBeUndefined();
  });

  it("returns [] when no other printer matches the $in filter", async () => {
    const printer = fakeModel([]); // find resolves to no printers
    const nozzle = fakeModel([]);
    const out = await findNozzleConflicts(printer.model, nozzle.model, ["n1"], null);
    expect(out).toEqual([]);
  });

  it("omits _id $ne when excludePrinterId is null, adds it when provided", async () => {
    const printerNoExclude = fakeModel([]);
    await findNozzleConflicts(printerNoExclude.model, fakeModel([]).model, ["n1"], null);
    expect(printerNoExclude.lastFilter()).toMatchObject({
      _deletedAt: null,
      installedNozzles: { $in: ["n1"] },
    });
    expect(printerNoExclude.lastFilter()!._id).toBeUndefined();

    const printerExclude = fakeModel([]);
    await findNozzleConflicts(printerExclude.model, fakeModel([]).model, ["n1"], "me");
    expect(printerExclude.lastFilter()!._id).toEqual({ $ne: "me" });
  });

  it("finds a conflict and hydrates the nozzle name", async () => {
    const printer = fakeModel([
      { _id: "pOwner", name: "Owner Printer", installedNozzles: ["n1"] },
    ]);
    const nozzle = fakeModel([{ _id: "n1", name: "0.4mm Brass" }]);
    const out = await findNozzleConflicts(printer.model, nozzle.model, ["n1"], null);
    expect(out).toEqual<NozzleConflict[]>([
      {
        nozzleId: "n1",
        nozzleName: "0.4mm Brass",
        otherPrinterId: "pOwner",
        otherPrinterName: "Owner Printer",
      },
    ]);
  });

  it("ignores a matched printer's UNRELATED installedNozzles (line 95 — includes() false)", async () => {
    // The $in filter matches this printer because it holds n1, but it ALSO
    // carries n2 which isn't in incomingIds — n2 must not become a conflict.
    const printer = fakeModel([
      { _id: "p1", name: "Owner", installedNozzles: ["n2", "n1"] },
    ]);
    const nozzle = fakeModel([{ _id: "n1", name: "The Nozzle" }]);
    const out = await findNozzleConflicts(printer.model, nozzle.model, ["n1"], null);
    expect(out).toHaveLength(1);
    expect(out[0].nozzleId).toBe("n1");
  });

  it("surfaces only the FIRST printer when a nozzle is claimed by multiple (line 95 — !has() false)", async () => {
    // Bad data: n1 appears in two printers. The first-seen wins; the second
    // hits the `!claimedBy.has(key)` guard and is skipped.
    const printer = fakeModel([
      { _id: "pFirst", name: "First", installedNozzles: ["n1"] },
      { _id: "pSecond", name: "Second", installedNozzles: ["n1"] },
    ]);
    const nozzle = fakeModel([{ _id: "n1", name: "Shared" }]);
    const out = await findNozzleConflicts(printer.model, nozzle.model, ["n1"], null);
    expect(out).toHaveLength(1);
    expect(out[0].otherPrinterId).toBe("pFirst");
    expect(out[0].otherPrinterName).toBe("First");
  });

  it("tolerates a matched printer with a missing installedNozzles array (line 93 — || [])", async () => {
    // A legacy printer doc that came back without installedNozzles must not
    // throw; it simply contributes no claims. With another printer holding
    // the real conflict, the result still resolves.
    const printer = fakeModel([
      { _id: "pLegacy", name: "Legacy" }, // no installedNozzles field
      { _id: "pReal", name: "Real", installedNozzles: ["n1"] },
    ]);
    const nozzle = fakeModel([{ _id: "n1", name: "Nozzle" }]);
    const out = await findNozzleConflicts(printer.model, nozzle.model, ["n1"], null);
    expect(out).toHaveLength(1);
    expect(out[0].otherPrinterId).toBe("pReal");
  });

  it("returns [] when matched printers carry none of the incoming nozzles (line 100 — claimedBy empty)", async () => {
    // A printer surfaced by the $in query but whose visible installedNozzles
    // don't include any incoming id (e.g. lean projection race / stale data).
    const printer = fakeModel([
      { _id: "p1", name: "Owner", installedNozzles: ["someOther"] },
    ]);
    const nozzle = fakeModel([]);
    const out = await findNozzleConflicts(printer.model, nozzle.model, ["n1"], null);
    expect(out).toEqual([]);
  });

  it("falls back to null nozzleName when the nozzle doc isn't hydrated (line 114 — ?? null)", async () => {
    // Conflict exists, but the nozzle name lookup returns nothing (the nozzle
    // row was deleted, or the projection missed it).
    const printer = fakeModel([
      { _id: "pOwner", name: "Owner", installedNozzles: ["nGone"] },
    ]);
    const nozzle = fakeModel([]); // no nozzle docs → no name in the map
    const out = await findNozzleConflicts(printer.model, nozzle.model, ["nGone"], null);
    expect(out).toHaveLength(1);
    expect(out[0].nozzleName).toBeNull();
    expect(out[0].nozzleId).toBe("nGone");
  });

  it("stringifies ObjectId-like incoming ids for comparison", async () => {
    // Incoming id is an object with a toString(); the internal String(x)
    // normalization must match the printer's string ref.
    const oid = { toString: () => "abc123" };
    const printer = fakeModel([
      { _id: "pOwner", name: "Owner", installedNozzles: ["abc123"] },
    ]);
    const nozzle = fakeModel([{ _id: "abc123", name: "Obj Nozzle" }]);
    const out = await findNozzleConflicts(
      printer.model,
      nozzle.model,
      [oid as unknown as string],
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0].nozzleId).toBe("abc123");
    expect(out[0].nozzleName).toBe("Obj Nozzle");
  });
});

describe("NozzleConflictError (lines 129-131)", () => {
  it("carries the conflicts payload, a fixed message, and the class name", () => {
    const conflicts: NozzleConflict[] = [
      {
        nozzleId: "n1",
        nozzleName: "0.4mm",
        otherPrinterId: "pA",
        otherPrinterName: "Printer A",
      },
    ];
    const err = new NozzleConflictError(conflicts);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NozzleConflictError);
    expect(err.name).toBe("NozzleConflictError");
    expect(err.message).toMatch(/already installed in another printer/i);
    expect(err.conflicts).toBe(conflicts);
  });

  it("accepts an empty conflicts array", () => {
    const err = new NozzleConflictError([]);
    expect(err.conflicts).toEqual([]);
    expect(err.name).toBe("NozzleConflictError");
  });
});

describe("nextCloneName — lower-numbered clone does not lower the counter (line 172)", () => {
  it("keeps the max when a smaller-numbered clone follows a larger one", () => {
    // "#2" comes AFTER "#5" in the list; the `n > maxN` guard's false branch
    // must not regress maxN from 5 back to 2.
    expect(nextCloneName("E3D", ["E3D", "E3D #5", "E3D #2"])).toBe("E3D #6");
  });

  it("a clone numbered below the implicit #1 original never lowers maxN", () => {
    // "#0" and "#1" are <= the seeded maxN (1); result stays #2.
    expect(nextCloneName("E3D", ["E3D", "E3D #0", "E3D #1"])).toBe("E3D #2");
  });
});
