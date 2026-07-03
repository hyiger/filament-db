import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { MAX_SPOOL_HISTORY } from "@/lib/capUsageHistory";

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

  it("fallback rollback does not lose pre-existing history rows to the usageHistory cap trim (#954 / PR #961 Codex P2)", async () => {
    // Filament A already sits at exactly the cap with MANUAL logs — rows a print
    // job must never touch. A trim baked into the debit save would evict one to
    // make room for the job's own entry; if the job then fails and rolls back,
    // that pre-existing manual row is gone forever even though the job never
    // landed. The fix defers the trim until AFTER the job is durably written, so
    // a rolled-back fallback request can't orphan pre-existing rows.
    const manuals = Array.from({ length: MAX_SPOOL_HISTORY }, (_, i) => ({
      grams: 1,
      jobLabel: `m${i}`,
      date: new Date(),
      source: "manual" as const,
      jobId: null,
    }));
    const a = await Filament.create({
      name: "Cap Rollback A",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "a1", totalWeight: 1000, usageHistory: manuals }],
    });
    const b = await Filament.create({
      name: "Cap Rollback B",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "b1", totalWeight: 800 }],
    });

    // Force the sequential-fallback path (mock connection.transaction, per the
    // sibling rollback test).
    const txnSpy = vi
      .spyOn(mongoose.Connection.prototype, "transaction")
      .mockImplementationOnce(async () => {
        throw new Error("Transaction numbers are only allowed on a replica set");
      });

    // Make save() #2 throw so filament A's debit save (#1) has already committed
    // when the failure fires — exactly the partial-write the rollback must undo.
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

    try {
      await postPrintHistory(
        makeReq({
          jobLabel: "cap rollback job",
          usage: [
            { filamentId: String(a._id), grams: 50 },
            { filamentId: String(b._id), grams: 25 },
          ],
        }),
      );
    } catch {
      // The handler may rethrow; we only assert on the persisted state.
    } finally {
      txnSpy.mockRestore();
      proto.save = originalSave;
    }

    const aAfter = await Filament.findById(a._id).lean();
    const bAfter = await Filament.findById(b._id).lean();

    // Pre-debit weight restored, the job's own entry stripped by the rollback...
    expect(aAfter.spools[0].totalWeight).toBe(1000);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (aAfter.spools[0].usageHistory || []).some((e: any) => e.jobId != null),
    ).toBe(false);
    // ...and — the point of the fix — every pre-existing manual row survived: a
    // trim that got rolled back must not have evicted one. Under a non-deferred
    // trim this array would be MAX_SPOOL_HISTORY - 1.
    expect(aAfter.spools[0].usageHistory).toHaveLength(MAX_SPOOL_HISTORY);
    // Filament B never reached its save, so the DB never saw its debit.
    expect(bAfter.spools[0].totalWeight).toBe(800);
    expect((bAfter.spools[0].usageHistory || []).length).toBe(0);

    // No PrintHistory row persisted.
    expect(await PrintHistory.countDocuments()).toBe(0);
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

  it("GH #949 (Codex P1): a commit-time retry re-applies the debit exactly once (no drift, no double-debit)", async () => {
    // gh-13698's document-state reset only fires when the transaction callback
    // THROWS (an operation-time TransientTransactionError). A
    // TransientTransactionError raised by commitTransaction instead reruns the
    // callback with NO reset — so the earlier fix (mutate outside, save inside)
    // would re-save a doc whose modified paths were already cleared, writing an
    // empty delta and dropping the debit while PrintHistory still committed.
    //
    // The follow-up fix moves the debit inside the callback on freshly-reloaded
    // docs, so each attempt reads the transaction's rolled-back baseline and
    // applies the debit exactly once. We can't run a real replica set here, so
    // we SIMULATE a commit-retry: run the callback, undo its writes (the
    // abort/rollback), then run it again (the retry). A single 100g debit must
    // survive — the OLD approach would leave the weight at 1000 (debit lost).
    const f = await Filament.create({
      name: "Commit Retry PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "main", totalWeight: 1000 }],
    });

    const txnSpy = vi
      .spyOn(mongoose.Connection.prototype, "transaction")
      .mockImplementationOnce(
        async (fn: (session: mongoose.ClientSession) => Promise<unknown>) => {
          // A session-less run commits directly to the memory-server (no real
          // transaction/rollback here); undefined is fine as the fake session.
          const noSession = undefined as unknown as mongoose.ClientSession;
          // Attempt 1 — commits to the (session-less) memory-server.
          await fn(noSession);
          // Simulate the transaction ABORTING before a commit-time
          // TransientTransactionError retry: restore the pre-debit baseline and
          // drop the just-created PrintHistory row so the retry starts clean,
          // exactly as a real rollback would.
          await Filament.updateOne(
            { _id: f._id },
            { $set: { "spools.0.totalWeight": 1000, "spools.0.usageHistory": [] } },
          );
          await PrintHistory.deleteMany({});
          // Attempt 2 — the retry. Must re-read the restored baseline and
          // re-apply the debit rather than silently no-op'ing.
          await fn(noSession);
        },
      );

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "commit-retry job",
        usage: [{ filamentId: String(f._id), grams: 100 }],
      }),
    );
    txnSpy.mockRestore();

    expect(res.status).toBe(201);
    const after = await Filament.findById(f._id).lean();
    // Exactly one 100g debit survived — not lost (1000) and not doubled (800).
    expect(after.spools[0].totalWeight).toBe(900);
    const jobEntries = after.spools[0].usageHistory.filter(
      (e: { source: string }) => e.source === "job",
    );
    expect(jobEntries).toHaveLength(1);
    const phCount = await PrintHistory.countDocuments({
      jobLabel: "commit-retry job",
    });
    expect(phCount).toBe(1);
  });

  it("GH #949 (Codex P2): a filament soft-deleted between pass-1 and the transaction reload returns 404, not a 500", async () => {
    // The fix reloads filaments fresh inside the transaction. If one was
    // validated in pass 1 but soft-deleted before the reload, the reload's
    // `_deletedAt: null` filter excludes it — a null dereference in the debit
    // helper would 500 (and leak the internal error). It must surface the same
    // 404 pass 1 enforces. Simulate the race by soft-deleting inside the mocked
    // transaction (i.e. after pass 1 ran) and then invoking the callback.
    const f = await Filament.create({
      name: "Vanishing PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "main", totalWeight: 1000 }],
    });

    const txnSpy = vi
      .spyOn(mongoose.Connection.prototype, "transaction")
      .mockImplementationOnce(
        async (fn: (session: mongoose.ClientSession) => Promise<unknown>) => {
          await Filament.updateOne(
            { _id: f._id },
            { $set: { _deletedAt: new Date() } },
          );
          // The reload inside `fn` now excludes the filament → the helper throws
          // FilamentNotFoundError, which propagates out to the 404 mapping.
          return fn(undefined as unknown as mongoose.ClientSession);
        },
      );

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "vanish job",
        usage: [{ filamentId: String(f._id), grams: 50 }],
      }),
    );
    txnSpy.mockRestore();

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
    // Nothing committed for the vanished job.
    const phCount = await PrintHistory.countDocuments({ jobLabel: "vanish job" });
    expect(phCount).toBe(0);
  });

  it("GH #949 (Codex P2): an explicit spoolId deleted between pass-1 and the reload returns 400, not a silent no-debit", async () => {
    // A named spool validated in pass 1 can be removed before the transaction
    // reloads the filament. Without a re-check the debit helper falls through to
    // `spoolId: null` and records the job with NO debit (silently accepting it
    // without touching the requested inventory). It must instead re-assert pass
    // 1's 400 contract. Simulate by $pull-ing the named spool inside the mocked
    // transaction (after pass 1 ran), leaving a sibling spool behind.
    const f = await Filament.create({
      name: "Spool Vanish PLA",
      vendor: "T",
      type: "PLA",
      spools: [
        { label: "A", totalWeight: 1000 },
        { label: "B", totalWeight: 500 },
      ],
    });
    const spoolA = String(f.spools[0]._id);
    const spoolB = String(f.spools[1]._id);

    const txnSpy = vi
      .spyOn(mongoose.Connection.prototype, "transaction")
      .mockImplementationOnce(
        async (fn: (session: mongoose.ClientSession) => Promise<unknown>) => {
          await Filament.updateOne(
            { _id: f._id },
            { $pull: { spools: { _id: spoolA } } },
          );
          return fn(undefined as unknown as mongoose.ClientSession);
        },
      );

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "spool vanish job",
        usage: [{ filamentId: String(f._id), spoolId: spoolA, grams: 50 }],
      }),
    );
    txnSpy.mockRestore();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/spool not found/i);
    const phCount = await PrintHistory.countDocuments({ jobLabel: "spool vanish job" });
    expect(phCount).toBe(0);
    // The surviving sibling spool was never touched.
    const after = await Filament.findById(f._id).lean();
    const survivor = after.spools.find((s: { _id: unknown }) => String(s._id) === spoolB);
    expect(survivor.totalWeight).toBe(500);
  });
});
