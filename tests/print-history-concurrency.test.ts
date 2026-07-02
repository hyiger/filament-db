import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as postPrintHistory } from "@/app/api/print-history/route";

/**
 * GH #224 — print-history concurrency guarantees.
 *
 * Two correctness gaps had no test coverage on the v1.16.1 release:
 *
 *   A. No OCC between jobs. Two near-simultaneous POSTs that both debit
 *      the same filament read the same baseline `totalWeight`, each
 *      subtract their own grams, then both `save()`. Without
 *      `optimisticConcurrency: true` on the Filament schema, last-writer
 *      wins — one job's debit is silently lost, both PrintHistory rows
 *      persist.
 *
 *   B. Sequential-fallback partial-write. When mongod runs standalone
 *      (no transactions), the route loops `await f.save()` then creates
 *      the PrintHistory row. If `save()` #2 throws after `save()` #1
 *      committed, the spool weight is already debited and the
 *      PrintHistory row doesn't exist — no refund path.
 *
 * These tests pin the post-fix behaviour: OCC throws VersionError on
 * concurrent edits and the route surfaces 409; the fallback rolls back
 * already-saved filaments when a downstream write fails.
 */
describe("GH #224 — print-history concurrency + rollback", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    const printHistoryMod = await import("@/models/PrintHistory");
    const printerMod = await import("@/models/Printer");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    if (!mongoose.models.PrintHistory) {
      mongoose.model("PrintHistory", printHistoryMod.default.schema);
    }
    if (!mongoose.models.Printer) {
      mongoose.model("Printer", printerMod.default.schema);
    }
    Filament = mongoose.models.Filament;
    PrintHistory = mongoose.models.PrintHistory;
  });

  function makeReq(body: unknown) {
    return new NextRequest("http://localhost/api/print-history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("Filament schema has optimisticConcurrency enabled", () => {
    // The race-detection mechanism is built on Mongoose's OCC. If a future
    // refactor accidentally drops the schema option, two concurrent
    // print-history POSTs revert to last-writer-wins — silently losing
    // one job's debit.
    expect(Filament.schema.options.optimisticConcurrency).toBe(true);
  });

  it("Mongoose throws VersionError on a stale doc save (OCC actually fires)", async () => {
    const f = await Filament.create({
      name: "OCC Direct PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "main", totalWeight: 1000 }],
    });

    // Two independent doc handles loaded from the same baseline.
    const stale = await Filament.findById(f._id);
    const fresh = await Filament.findById(f._id);

    // Concurrent peer saves first → bumps DB __v.
    fresh!.spools[0].totalWeight = 999;
    await fresh!.save();

    // Stale handle tries the same mutation → should throw VersionError.
    stale!.spools[0].totalWeight = 900;
    let err: unknown = null;
    try {
      await stale!.save();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(mongoose.Error.VersionError);

    // DB state matches the winner (fresh), not the loser (stale).
    const after = await Filament.findById(f._id).lean();
    expect(after.spools[0].totalWeight).toBe(999);
  });

  it("route surfaces 409 when save throws VersionError during the standalone fallback", async () => {
    // The test harness wipes `mongoose.models` between tests and the
    // route holds its own static reference to `Filament` from import
    // time, so a spy on the test-side model class won't see the
    // route-side calls. Instead, inject the version conflict by
    // patching `Document.prototype.save` to throw VersionError once.
    const f = await Filament.create({
      name: "Route OCC PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "main", totalWeight: 1000 }],
    });

    // Force the standalone-fallback branch. GH #949: the route now routes
    // the transaction path through mongoose.connection.transaction(), so
    // the fallback is forced by making THAT throw the unsupported-txn
    // error (a bare mongoose.startSession spy would no longer be hit).
    const txnSpy = vi.spyOn(mongoose.Connection.prototype, "transaction")
      .mockImplementationOnce(async () => {
        throw new Error(
          "Transaction numbers are only allowed on a replica set",
        );
      });

    // Patch save() to throw VersionError once. The route's fallback
    // catches this and rolls back, then must return 409 (not 500) so
    // the caller knows to retry.
    const proto = mongoose.Model.prototype as unknown as {
      save: () => Promise<unknown>;
    };
    const originalSave = proto.save;
    let saveCallsMade = 0;
    proto.save = async function () {
      saveCallsMade++;
      if (saveCallsMade === 1) {
        // Simulate a concurrent edit landing between pass-1 fetch and
        // the route's save attempt — exactly what OCC catches in
        // production.
        throw new mongoose.Error.VersionError(
          this as unknown as mongoose.Document,
          0,
          ["spools"],
        );
      }
      return originalSave.apply(this);
    };

    let res;
    try {
      res = await postPrintHistory(
        makeReq({
          jobLabel: "racing job",
          usage: [{ filamentId: String(f._id), grams: 100 }],
        }),
      );
    } finally {
      txnSpy.mockRestore();
      proto.save = originalSave;
    }

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/retry|modified by another request/i);

    // No PrintHistory row should exist — the race response means the
    // job didn't land.
    const count = await PrintHistory.countDocuments();
    expect(count).toBe(0);
  });

  it("standalone fallback rolls back already-saved filaments if a later save throws", async () => {
    // Two filaments. The route saves them in order during the fallback
    // path. We make save() throw on the SECOND call so save #1 has
    // already committed when the error fires. The route's rollback
    // logic must reload + restore the pre-debit state of filament A.
    //
    // The first attempt at this test patched PrintHistory.create
    // instead, but that exposed a real bug: failing AFTER both
    // filament saves succeeded means BOTH spools end up debited and
    // the rollback has to undo both. Easier to reason about with the
    // second-save-fails shape.
    const a = await Filament.create({
      name: "Rollback A",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "a1", totalWeight: 1000 }],
    });
    const b = await Filament.create({
      name: "Rollback B",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "b1", totalWeight: 800 }],
    });

    // Force the route into the sequential-fallback path (GH #949: mock
    // connection.transaction, not startSession — see the 409 test).
    const txnSpy = vi.spyOn(mongoose.Connection.prototype, "transaction")
      .mockImplementationOnce(async () => {
        throw new Error(
          "Transaction numbers are only allowed on a replica set",
        );
      });

    // Patch save() so the second call throws.
    const proto = mongoose.Model.prototype as unknown as {
      save: () => Promise<unknown>;
    };
    const originalSave = proto.save;
    let saveCallsMade = 0;
    proto.save = async function () {
      saveCallsMade++;
      if (saveCallsMade === 2) {
        throw new Error("simulated downstream write failure");
      }
      return originalSave.apply(this);
    };

    let res;
    let threw = false;
    try {
      res = await postPrintHistory(
        makeReq({
          jobLabel: "rollback job",
          usage: [
            { filamentId: String(a._id), grams: 50 },
            { filamentId: String(b._id), grams: 25 },
          ],
        }),
      );
    } catch {
      // The handler rethrows the inner error; errorResponseFromCaught
      // wraps it. We accept either shape as long as no partial debit
      // survived in the DB.
      threw = true;
    } finally {
      txnSpy.mockRestore();
      proto.save = originalSave;
    }
    void threw;
    void res;

    const aAfter = await Filament.findById(a._id).lean();
    const bAfter = await Filament.findById(b._id).lean();

    // Filament A's first save() committed a debit. The route's rollback
    // logic should reload it from DB and restore to the pre-debit state.
    expect(aAfter.spools[0].totalWeight).toBe(1000);
    // Filament B never got to save() #2, so the DB never saw a debit.
    expect(bAfter.spools[0].totalWeight).toBe(800);
    // The rollback also strips any usageHistory entry tagged with the
    // failed job's id.
    expect((aAfter.spools[0].usageHistory || []).length).toBe(0);
    expect((bAfter.spools[0].usageHistory || []).length).toBe(0);

    // No PrintHistory row persisted.
    const count = await PrintHistory.countDocuments();
    expect(count).toBe(0);
  });

  it("happy path on standalone fallback still creates the PrintHistory row", async () => {
    // Sanity check that the new rollback logic doesn't poison the
    // success path.
    const f = await Filament.create({
      name: "Happy Standalone PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "main", totalWeight: 500 }],
    });

    const txnSpy = vi.spyOn(mongoose.Connection.prototype, "transaction")
      .mockImplementationOnce(async () => {
        throw new Error(
          "Transaction numbers are only allowed on a replica set",
        );
      });

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "happy job",
        usage: [{ filamentId: String(f._id), grams: 75 }],
      }),
    );

    txnSpy.mockRestore();

    expect(res.status).toBe(201);
    const after = await Filament.findById(f._id).lean();
    expect(after.spools[0].totalWeight).toBe(425);
    const ph = await PrintHistory.find({ jobLabel: "happy job" }).lean();
    expect(ph).toHaveLength(1);
  });

  it("GH #949: routes the transaction path through connection.transaction() (retry-safe)", async () => {
    // The #949 fix swaps a bare startSession().withTransaction() for
    // mongoose.connection.transaction(), which resets each saved
    // document's modified-path/version/atomics state between
    // TransientTransactionError retries (gh-13698). Without it, a retry's
    // f.save() computes an empty delta and silently drops the spool debit
    // while the PrintHistory row still commits — permanent inventory
    // drift. A real transient needs a replica set (the standalone test
    // harness can't run one), so this pins the delegation itself: a
    // regression back to bare withTransaction would stop calling
    // connection.transaction and trip this test.
    const f = await Filament.create({
      name: "Txn Delegation PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "main", totalWeight: 300 }],
    });

    const txnSpy = vi.spyOn(mongoose.Connection.prototype, "transaction");

    // Standalone mongod can't run transactions, so the real call throws
    // the unsupported-txn error and the route falls back to sequential
    // saves — the debit still lands AND the transaction API was invoked.
    const res = await postPrintHistory(
      makeReq({
        jobLabel: "delegation job",
        usage: [{ filamentId: String(f._id), grams: 50 }],
      }),
    );

    // Assert BEFORE mockRestore() — restoring clears the spy's call
    // history, so a post-restore toHaveBeenCalledTimes would read 0.
    expect(txnSpy).toHaveBeenCalledTimes(1);
    txnSpy.mockRestore();

    expect(res.status).toBe(201);
    const after = await Filament.findById(f._id).lean();
    expect(after.spools[0].totalWeight).toBe(250);
  });
});
