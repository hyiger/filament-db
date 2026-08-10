import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { DELETE as deletePrintHistory, PUT as putPrintHistory } from "@/app/api/print-history/[id]/route";
import { GET as getAnalytics } from "@/app/api/analytics/route";
import { MAX_SPOOL_HISTORY, MAX_USAGE_GRAMS } from "@/lib/capUsageHistory";
import { lockedKeyCount, runExclusive, filamentLockKey } from "@/lib/filamentMutex";

/**
 * Covers two behaviours added in the v1.11 review round:
 *
 *  1. POST /api/print-history is atomic: a missing filament on a later
 *     usage entry aborts with 404 without persisting changes to earlier
 *     filaments in the same request.
 *  2. Spool usageHistory entries created through /api/print-history are
 *     tagged `source: "job"` so the analytics fallback doesn't
 *     double-count them against the PrintHistory pass.
 */
describe("print-history POST", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;

  beforeEach(async () => {
    // The shared afterEach in tests/setup.ts wipes mongoose.models between
    // tests; ESM module caching means a dynamic `import(...)` won't
    // re-execute the model file, so the mongoose registry stays empty and
    // .populate() calls inside the routes fail with "Schema hasn't been
    // registered". Manually re-attach every model this file uses by pulling
    // the schema off the cached class and calling mongoose.model directly.
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

  it("tags spool usageHistory entries with source='job'", async () => {
    const f = await Filament.create({
      name: "Job Tag PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1200 }],
    });

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "benchy.gcode",
        source: "manual",
        usage: [{ filamentId: String(f._id), grams: 25 }],
      }),
    );
    expect(res.status).toBe(201);

    const updated = await Filament.findById(f._id);
    expect(updated.spools[0].usageHistory).toHaveLength(1);
    expect(updated.spools[0].usageHistory[0].source).toBe("job");
    // Weight should be decremented from 1200 to 1175.
    expect(updated.spools[0].totalWeight).toBe(1175);
  });

  it("#905: debits a spool even when the filament carries a legacy out-of-range field", async () => {
    const f = await Filament.create({
      name: "Legacy Field PLA",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "", totalWeight: 1000 }],
    });
    // Inject a value that predates the numeric validators (bypasses Mongoose),
    // e.g. a temperature stored before the max-600 validator existed.
    await Filament.collection.updateOne(
      { _id: f._id },
      { $set: { "temperatures.nozzle": 999 } },
    );

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "legacy.gcode",
        source: "manual",
        usage: [{ filamentId: String(f._id), grams: 50 }],
      }),
    );
    // Pre-fix: full-document save() validation threw on the legacy 999 and the
    // debit failed (5xx). Now the debit validates only modified paths.
    expect(res.status).toBe(201);
    const updated = await Filament.findById(f._id);
    expect(updated.spools[0].totalWeight).toBe(950);
    expect(updated.spools[0].usageHistory).toHaveLength(1);
  });

  it("aborts with 404 on missing filament without mutating earlier filaments", async () => {
    const a = await Filament.create({
      name: "Atomic A",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "test-atomic",
        source: "manual",
        usage: [
          { filamentId: String(a._id), grams: 50 },
          // Deliberately invalid: a valid ObjectId that doesn't match any doc.
          { filamentId: new mongoose.Types.ObjectId().toString(), grams: 10 },
        ],
      }),
    );
    expect(res.status).toBe(404);

    // Filament A must be untouched — no weight change, no usageHistory entry.
    const afterA = await Filament.findById(a._id);
    expect(afterA.spools[0].totalWeight).toBe(1000);
    expect(afterA.spools[0].usageHistory).toHaveLength(0);

    // No PrintHistory row was created either.
    const historyCount = await PrintHistory.countDocuments({});
    expect(historyCount).toBe(0);
  });

  it("rejects an invalid spoolId before mutating anything", async () => {
    // Regression: previously a caller could supply a spoolId that didn't
    // exist on the referenced filament and the handler would silently fall
    // through to "first spool" — debiting the wrong inventory and
    // persisting the caller's invalid id to PrintHistory.
    const f = await Filament.create({
      name: "Spool Guard",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [
        { label: "A", totalWeight: 1000 },
        { label: "B", totalWeight: 800 },
      ],
    });

    const bogusSpool = new mongoose.Types.ObjectId().toString();
    const res = await postPrintHistory(
      makeReq({
        jobLabel: "test-spool-guard",
        source: "manual",
        usage: [
          { filamentId: String(f._id), spoolId: bogusSpool, grams: 50 },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/[Ss]pool/);

    // Filament is untouched — neither spool got charged.
    const after = await Filament.findById(f._id);
    expect(after.spools[0].totalWeight).toBe(1000);
    expect(after.spools[1].totalWeight).toBe(800);
    expect(after.spools[0].usageHistory).toHaveLength(0);
    expect(after.spools[1].usageHistory).toHaveLength(0);

    // No PrintHistory row created.
    const historyCount = await PrintHistory.countDocuments({});
    expect(historyCount).toBe(0);
  });

  it("applies updates across multiple filaments when all are valid", async () => {
    const a = await Filament.create({
      name: "Multi A",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });
    const b = await Filament.create({
      name: "Multi B",
      vendor: "Test",
      type: "PETG",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "dual-spool",
        source: "prusaslicer",
        usage: [
          { filamentId: String(a._id), grams: 80 },
          { filamentId: String(b._id), grams: 40 },
        ],
      }),
    );
    expect(res.status).toBe(201);

    const afterA = await Filament.findById(a._id);
    const afterB = await Filament.findById(b._id);
    expect(afterA.spools[0].totalWeight).toBe(920);
    expect(afterB.spools[0].totalWeight).toBe(960);

    // Both spool entries should be tagged "job" regardless of the posted
    // `source` — the PrintHistory record holds the job's provenance.
    expect(afterA.spools[0].usageHistory[0].source).toBe("job");
    expect(afterB.spools[0].usageHistory[0].source).toBe("job");
  });

  it("stamps each spool usageHistory entry with the new PrintHistory _id as jobId", async () => {
    // Regression for the v1.12.x audit P0: the DELETE/undo path used to
    // match by (grams, date) alone, which silently removed the wrong
    // entry when a manual usage log shared both. The fix wires a jobId
    // pointing back at the PrintHistory _id; this test locks down that
    // POST writes it.
    const f = await Filament.create({
      name: "JobId Stamping",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });
    const res = await postPrintHistory(
      makeReq({
        jobLabel: "stamped",
        source: "manual",
        usage: [{ filamentId: String(f._id), grams: 50 }],
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();

    const fresh = await Filament.findById(f._id);
    const entry = fresh.spools[0].usageHistory[0];
    expect(entry.jobId).toBeDefined();
    expect(String(entry.jobId)).toBe(String(created._id));
  });
  // ── GH #1030: grams magnitude bound at the print-history boundary ────

  it("#1030 — rejects a usage entry past MAX_USAGE_GRAMS and persists nothing", async () => {
    const f = await Filament.create({
      name: "Grams Bound PLA",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "Main", totalWeight: 1000 }],
    });

    const res = await postPrintHistory(
      makeReq({
        jobLabel: "overflow",
        startedAt: new Date().toISOString(),
        usage: [{ filamentId: String(f._id), grams: 1e308 }],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no greater than/i);

    // Atomic: no PrintHistory row, no spool debit, no ledger entry.
    expect(await PrintHistory.countDocuments({})).toBe(0);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[0].totalWeight).toBe(1000);
    expect(fresh.spools[0].usageHistory ?? []).toHaveLength(0);
  });

  it("#1030 — accepts exactly the cap and still accepts an ordinary job", async () => {
    const f = await Filament.create({
      name: "Grams Bound OK PLA",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "Main", totalWeight: 1000 }],
    });

    const atCap = await postPrintHistory(
      makeReq({
        jobLabel: "at-cap",
        startedAt: new Date().toISOString(),
        usage: [{ filamentId: String(f._id), grams: MAX_USAGE_GRAMS }],
      }),
    );
    expect(atCap.status).toBe(201);

    const ordinary = await postPrintHistory(
      makeReq({
        jobLabel: "normal",
        startedAt: new Date().toISOString(),
        usage: [{ filamentId: String(f._id), grams: 25 }],
      }),
    );
    expect(ordinary.status).toBe(201);
  });
});

describe("print-history DELETE (undo)", () => {
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

  async function postJob(filament: { _id: mongoose.Types.ObjectId }, jobLabel: string, grams: number, startedAt?: Date) {
    const res = await postPrintHistory(
      new NextRequest("http://localhost/api/print-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobLabel,
          source: "manual",
          usage: [{ filamentId: String(filament._id), grams }],
          ...(startedAt ? { startedAt: startedAt.toISOString() } : {}),
        }),
      }),
    );
    expect(res.status).toBe(201);
    return res.json();
  }

  function delReq(id: string) {
    return new NextRequest(`http://localhost/api/print-history/${id}`, { method: "DELETE" });
  }

  function purgeReq(id: string) {
    return new NextRequest(
      `http://localhost/api/print-history/${id}?permanent=true`,
      { method: "DELETE" },
    );
  }

  it("refunds spool weight and removes the matching usageHistory entry", async () => {
    const f = await Filament.create({
      name: "Refund Basic",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });
    const job = await postJob(f, "benchy", 100);
    const after = await Filament.findById(f._id);
    expect(after.spools[0].totalWeight).toBe(900);

    const delRes = await deletePrintHistory(delReq(job._id), { params: Promise.resolve({ id: job._id }) });
    expect(delRes.status).toBe(200);

    const refunded = await Filament.findById(f._id);
    expect(refunded.spools[0].totalWeight).toBe(1000);
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  it("caps usageHistory without evicting an OLD live job entry, so its refund survives (#954)", async () => {
    const f = await Filament.create({
      name: "Cap Undo Aware",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });

    // Job A goes through the real POST path, so it owns a PrintHistory row and a
    // source:"job" usageHistory entry carrying a jobId.
    const jobA = await postJob(f, "old-job", 50);
    let doc = await Filament.findById(f._id);
    expect(doc.spools[0].totalWeight).toBe(950);
    expect(doc.spools[0].usageHistory).toHaveLength(1);

    // Make Job A the OLDEST entry by appending MAX-1 manual logs after it,
    // filling the array to exactly the cap (no trim yet).
    for (let i = 0; i < MAX_SPOOL_HISTORY - 1; i++) {
      doc.spools[0].usageHistory.push({
        grams: 1,
        jobLabel: `manual-${i}`,
        date: new Date(),
        source: "manual",
        jobId: null,
      });
    }
    await doc.save();
    doc = await Filament.findById(f._id);
    expect(doc.spools[0].usageHistory).toHaveLength(MAX_SPOOL_HISTORY);

    // Job B pushes one more entry → over the cap → trim fires. A naive
    // slice(-MAX) would evict index 0 (Job A, the oldest); the undo-aware trim
    // evicts the oldest MANUAL instead, preserving Job A.
    const jobB = await postJob(f, "new-job", 30);
    doc = await Filament.findById(f._id);
    expect(doc.spools[0].usageHistory).toHaveLength(MAX_SPOOL_HISTORY);
    expect(doc.spools[0].totalWeight).toBe(920);
    const jobAEntry = doc.spools[0].usageHistory.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => String(e.jobId) === String(jobA._id),
    );
    expect(jobAEntry).toBeTruthy();

    // The payoff: deleting Job A still finds its entry and refunds the 50g —
    // with a naive trim the entry would be gone and the refund silently skipped.
    const delRes = await deletePrintHistory(delReq(jobA._id), {
      params: Promise.resolve({ id: jobA._id }),
    });
    expect(delRes.status).toBe(200);
    const refundedDoc = await Filament.findById(f._id);
    expect(refundedDoc.spools[0].totalWeight).toBe(970); // 920 + 50 refunded
    expect(
      refundedDoc.spools[0].usageHistory.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => String(e.jobId) === String(jobA._id),
      ),
    ).toBe(false);
    expect(
      refundedDoc.spools[0].usageHistory.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => String(e.jobId) === String(jobB._id),
      ),
    ).toBe(true);
  });

  it("does not remove a manual usage log that shares (grams, date) with the job", async () => {
    // The v1.12.x audit P0 regression. Prior code matched by
    // (grams, startedAt) only; if the user had also logged a manual 50g
    // usage at the exact same minute, that entry would be wrongly
    // refunded along with the job. The jobId match avoids it.
    const sharedDate = new Date("2026-04-30T10:00:00Z");
    const f = await Filament.create({
      name: "Manual Survives Undo",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [
        {
          label: "",
          totalWeight: 1000,
          usageHistory: [
            // The "innocent bystander" — predates the job, no jobId.
            { grams: 50, jobLabel: "calibration", date: sharedDate, source: "manual", jobId: null },
          ],
        },
      ],
    });

    const job = await postJob(f, "ambiguous-job", 50, sharedDate);
    const afterPost = await Filament.findById(f._id);
    // Two entries now: one manual (no jobId) + one job-driven (with jobId).
    expect(afterPost.spools[0].usageHistory).toHaveLength(2);

    const delRes = await deletePrintHistory(delReq(job._id), { params: Promise.resolve({ id: job._id }) });
    expect(delRes.status).toBe(200);

    const refunded = await Filament.findById(f._id);
    // Exactly one survivor: the manual entry. Pre-fix this would be 0.
    expect(refunded.spools[0].usageHistory).toHaveLength(1);
    const survivor = refunded.spools[0].usageHistory[0];
    expect(survivor.source).toBe("manual");
    expect(survivor.jobId).toBeNull();
    expect(survivor.jobLabel).toBe("calibration");
  });

  it("falls back to (grams, date) match for legacy entries that pre-date jobId", async () => {
    // Legacy data path: a row written before the v1.12.x audit doesn't
    // have jobId. The fallback is restricted to source==="job"|"slicer"
    // so it can't accidentally clobber a manual entry.
    const startedAt = new Date("2026-04-30T11:30:00Z");
    const f = await Filament.create({
      name: "Legacy Refund",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [
        {
          label: "",
          totalWeight: 850,
          usageHistory: [
            // Legacy job entry — has source "job" but no jobId.
            { grams: 150, jobLabel: "old-job", date: startedAt, source: "job", jobId: null },
          ],
        },
      ],
    });
    // Simulate the orphaned PrintHistory record that would normally
    // accompany the legacy entry.
    const orphan = await PrintHistory.create({
      jobLabel: "old-job",
      usage: [{ filamentId: f._id, spoolId: f.spools[0]._id, grams: 150 }],
      startedAt,
      source: "manual",
    });

    const delRes = await deletePrintHistory(delReq(String(orphan._id)), {
      params: Promise.resolve({ id: String(orphan._id) }),
    });
    expect(delRes.status).toBe(200);

    const refunded = await Filament.findById(f._id);
    expect(refunded.spools[0].totalWeight).toBe(1000);
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  it("does not remove a manual entry even when fallback runs", async () => {
    // Even on the legacy fallback path, source-restricted matching
    // protects manual logs that happen to share (grams, date).
    const startedAt = new Date("2026-04-30T12:00:00Z");
    const f = await Filament.create({
      name: "Legacy Manual Safe",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [
        {
          label: "",
          totalWeight: 850,
          usageHistory: [
            { grams: 150, jobLabel: "manual-only", date: startedAt, source: "manual", jobId: null },
          ],
        },
      ],
    });
    const orphan = await PrintHistory.create({
      jobLabel: "ghost",
      usage: [{ filamentId: f._id, spoolId: f.spools[0]._id, grams: 150 }],
      startedAt,
      source: "manual",
    });

    await deletePrintHistory(delReq(String(orphan._id)), {
      params: Promise.resolve({ id: String(orphan._id) }),
    });
    const fresh = await Filament.findById(f._id);
    // Manual entry must still be there — the fallback restricted by source
    // protects it.
    expect(fresh.spools[0].usageHistory).toHaveLength(1);
    expect(fresh.spools[0].usageHistory[0].source).toBe("manual");
  });

  it("returns 404 for a missing PrintHistory id", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await deletePrintHistory(delReq(fakeId), { params: Promise.resolve({ id: fakeId }) });
    expect(res.status).toBe(404);
  });

  it("is idempotent — a repeat DELETE on a tombstoned entry returns 404 and doesn't double-refund", async () => {
    // Codex round-2 P1: switching to soft-delete left the door open for
    // a retry / double-click / client retry after timeout to re-run the
    // refund loop. Each repeat would add u.grams back to the spool,
    // inflating inventory. The handler now filters findOne on
    // _deletedAt: null so the second call short-circuits to 404.
    const f = await Filament.create({
      name: "Idempotent",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });
    const job = await postJob(f, "double-click", 100);

    const first = await deletePrintHistory(delReq(job._id), { params: Promise.resolve({ id: job._id }) });
    expect(first.status).toBe(200);
    const afterFirst = await Filament.findById(f._id);
    expect(afterFirst.spools[0].totalWeight).toBe(1000); // refunded once

    const second = await deletePrintHistory(delReq(job._id), { params: Promise.resolve({ id: job._id }) });
    expect(second.status).toBe(404);
    const afterSecond = await Filament.findById(f._id);
    // Critical: weight unchanged after the second call. Without the
    // _deletedAt filter this would be 1100 (refund applied twice).
    expect(afterSecond.spools[0].totalWeight).toBe(1000);
  });

  it("soft-deletes the PrintHistory row (sets _deletedAt) so peer sync can propagate", async () => {
    // Hard delete would let syncCollection resurrect the row from the
    // other DB on the next cycle (it treats missing rows as
    // pull-or-push, only respecting deletes via the _deletedAt
    // tombstone). Refund still happens; only the row stays.
    const f = await Filament.create({
      name: "Soft Delete Check",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });
    const job = await postJob(f, "soft", 100);

    const delRes = await deletePrintHistory(delReq(job._id), { params: Promise.resolve({ id: job._id }) });
    expect(delRes.status).toBe(200);

    const tombstone = await PrintHistory.findById(job._id);
    expect(tombstone).not.toBeNull();
    expect(tombstone._deletedAt).toBeInstanceOf(Date);
    // Refund still happened
    const refunded = await Filament.findById(f._id);
    expect(refunded.spools[0].totalWeight).toBe(1000);
  });

  // GH #524.5: ?permanent=true sets the _purged tombstone, but ONLY on a
  // row that's already soft-deleted (mirrors Filament's trash→purge gate).
  it("permanent delete sets _purged on a soft-deleted row; rejects an active row", async () => {
    const f = await Filament.create({
      name: "Purge Check",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });
    const job = await postJob(f, "purge-me", 100);

    // Permanent delete on an ACTIVE (not-yet-trashed) entry is refused —
    // can't skip the refund + soft-delete step.
    const earlyPurge = await deletePrintHistory(purgeReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(earlyPurge.status).toBe(404);

    // Soft-delete first (refund happens), then purge.
    const soft = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(soft.status).toBe(200);

    const purge = await deletePrintHistory(purgeReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(purge.status).toBe(200);
    const purged = await PrintHistory.findById(job._id);
    expect(purged._purged).toBe(true);
    expect(purged._deletedAt).toBeInstanceOf(Date); // _deletedAt untouched

    // Idempotent — a second purge is a 404 no-op.
    const again = await deletePrintHistory(purgeReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(again.status).toBe(404);
  });

  // GH #228 + Codex P1 review on PR #229: refund clamps at the spool's
  // GROSS full weight (spoolWeight + netFilamentWeight), not at
  // netFilamentWeight alone. spool.totalWeight is the on-scale gross
  // reading; clamping in net-only units would permanently under-refund
  // by the empty-spool tare for any filament with spoolWeight > 0.
  it("refund clamps at gross capacity (spoolWeight + netFilamentWeight), not net", async () => {
    const f = await Filament.create({
      name: "Gross Clamp",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200, // 200g empty-spool tare
      netFilamentWeight: 1000, // 1kg of filament when full
      // User manually corrected the gross weight down to 1000g after a
      // previous (off-ledger) usage, leaving 800g of filament on the spool.
      spools: [{ label: "", totalWeight: 1000 }],
    });
    // Log + undo a 150g job. Pre-Codex this would clamp at 1000g (net),
    // leaving 200g of legitimate weight locked out. Post-Codex it clamps
    // at 1200g gross, so the refund actually adds the 150g back.
    const job = await postJob(f, "to-undo", 150);
    const afterJob = await Filament.findById(f._id);
    expect(afterJob.spools[0].totalWeight).toBe(850); // 1000 − 150

    await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    const refunded = await Filament.findById(f._id);
    expect(refunded.spools[0].totalWeight).toBe(1000); // 850 + 150, not clamped
  });

  it("refund clamps to gross max when the refund would push the spool over capacity", async () => {
    const f = await Filament.create({
      name: "Gross Clamp Cap",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000, // gross capacity = 1200g
      // User started this spool at a near-full reading and ran a job.
      // Then they manually re-weighed and pushed totalWeight to 1100g (a
      // re-tare to "match the scale"). Undoing the 200g job would
      // attempt to set totalWeight to 1300g — above the 1200g gross
      // ceiling, which the clamp prevents.
      spools: [{ label: "", totalWeight: 1200 }],
    });
    const job = await postJob(f, "near-cap", 200);
    const f2 = await Filament.findById(f._id);
    f2.spools[0].totalWeight = 1100;
    await f2.save();

    await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    const after = await Filament.findById(f._id);
    expect(after.spools[0].totalWeight).toBe(1200); // capped at gross max
  });

  it("variant inherits parent's spoolWeight when clamping the refund", async () => {
    // Codex P1 specifically called out that spoolWeight inherits like
    // every other field in INHERITABLE_FIELDS. A variant with no own
    // spoolWeight must still use the parent's tare when computing
    // the gross ceiling.
    const parent = await Filament.create({
      name: "Clamp Parent",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 250, // tare lives on the parent
      netFilamentWeight: 1000,
    });
    const variant = await Filament.create({
      name: "Clamp Variant",
      vendor: "Test",
      type: "PLA",
      color: "#abcdef",
      parentId: parent._id,
      // spoolWeight + netFilamentWeight intentionally null → inherit
      spools: [{ label: "", totalWeight: 1100 }],
    });
    const job = await postJob(variant, "var-job", 200);
    // Manual correction pushes totalWeight to 1200 (mid-print re-weigh).
    const v2 = await Filament.findById(variant._id);
    v2.spools[0].totalWeight = 1200;
    await v2.save();

    await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    const after = await Filament.findById(variant._id);
    // Gross ceiling = parent.spoolWeight (250) + parent.netFilamentWeight (1000) = 1250.
    // Refund of 200 → 1400; clamps to 1250.
    expect(after.spools[0].totalWeight).toBe(1250);
  });

  it("no clamp when netFilamentWeight is unset (legacy filament behaviour)", async () => {
    // The pre-#228 code had no upper bound on refund. For legacy
    // filaments with no netFilamentWeight set, we preserve that
    // behaviour rather than guessing at a capacity.
    const f = await Filament.create({
      name: "No Capacity",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      // netFilamentWeight intentionally unset
      spools: [{ label: "", totalWeight: 100 }],
    });
    const job = await postJob(f, "legacy", 50);
    const f2 = await Filament.findById(f._id);
    // User manually corrected to 0 mid-job.
    f2.spools[0].totalWeight = 0;
    await f2.save();

    await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    const after = await Filament.findById(f._id);
    // No clamp: refund 50 onto 0 → 50.
    expect(after.spools[0].totalWeight).toBe(50);
  });

  // ─── GH #1074: refund pays back what was actually debited, not what the job requested ───

  it("refunds only the actually-debited grams when the debit was clamped (#1074)", async () => {
    // The issue's exact repro: a 50g spool consumed by a 100g job. The
    // debit clamps at 0 and absorbs the 50g shortfall; the refund used to
    // restore the full 100g, leaving the spool with MORE weight (100g)
    // than before the job existed (50g) — phantom inventory.
    const f = await Filament.create({
      name: "Clamped Debit",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 50 }],
    });
    const job = await postJob(f, "ran-dry", 100);

    const afterJob = await Filament.findById(f._id);
    expect(afterJob.spools[0].totalWeight).toBe(0);
    // grams keeps the REQUESTED amount (analytics contract unchanged);
    // debitedGrams records what actually came off — on BOTH ledgers.
    const jobRow = await PrintHistory.findById(job._id);
    expect(jobRow.usage[0].grams).toBe(100);
    expect(jobRow.usage[0].debitedGrams).toBe(50);
    expect(afterJob.spools[0].usageHistory[0].grams).toBe(100);
    expect(afterJob.spools[0].usageHistory[0].debitedGrams).toBe(50);

    const delRes = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(delRes.status).toBe(200);
    const refunded = await Filament.findById(f._id);
    // Pre-fix: 100 (0 + full requested grams). Post-fix: exactly the
    // pre-job 50g comes back.
    expect(refunded.spools[0].totalWeight).toBe(50);
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  it("legacy usage rows without debitedGrams keep the full-grams refund (#1074 accepted residual)", async () => {
    const f = await Filament.create({
      name: "Legacy Refund",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 50 }],
    });
    const job = await postJob(f, "pre-1074-job", 100);
    // Simulate a job recorded before debitedGrams existed: strip the field
    // from both ledgers at the driver level (bypassing the schema default).
    await PrintHistory.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(job._id)) },
      { $unset: { "usage.$[].debitedGrams": "" } },
    );
    await Filament.collection.updateOne(
      { _id: f._id },
      { $unset: { "spools.$[].usageHistory.$[].debitedGrams": "" } },
    );

    const delRes = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(delRes.status).toBe(200);
    const refunded = await Filament.findById(f._id);
    // Old behavior preserved for legacy rows: the actually-debited amount
    // is unknowable, so the full requested grams come back (bounded only
    // by the gross-capacity clamp, 1200g here).
    expect(refunded.spools[0].totalWeight).toBe(100);
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  it("a debitedGrams larger than grams falls back to the grams refund (Codex P2 — corrupt sync/restore row)", async () => {
    // debitedGrams deliberately has no schema bound (see the model comment),
    // so a corrupt row can arrive via snapshot restore / hybrid sync with an
    // inflated value. A genuine clamped debit can never EXCEED the requested
    // grams, so the refund must treat debitedGrams > grams as invalid and
    // fall back to grams — not credit a million grams to a spool with no
    // configured capacity ceiling (netFilamentWeight null here on purpose).
    const f = await Filament.create({
      name: "Inflated Debit",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      spools: [{ label: "", totalWeight: 500 }],
    });
    const job = await postJob(f, "corrupt-debit-job", 100);
    // The refund reads the LEDGER entry (round-2 fix), so corrupt that copy;
    // the PrintHistory copy is corrupted too for completeness.
    await PrintHistory.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(job._id)) },
      { $set: { "usage.$[].debitedGrams": 1_000_000 } },
    );
    await Filament.collection.updateOne(
      { _id: f._id },
      { $set: { "spools.$[].usageHistory.$[].debitedGrams": 1_000_000 } },
    );

    const delRes = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(delRes.status).toBe(200);
    const refunded = await Filament.findById(f._id);
    // 400 (post-debit) + 100 (grams fallback) — NOT 1,000,400.
    expect(refunded.spools[0].totalWeight).toBe(500);
  });

  it("a corrupt ledger grams falls back to the ROW's requested grams (Codex P2 r4)", async () => {
    // The entry's own grams is both the debitedGrams bound and the legacy
    // fallback — a sync/restore-corrupted 1e308 there (schema enforces only
    // min: 0) must not become the refund. Falls back to u.grams, which
    // passed the POST cap.
    const f = await Filament.create({
      name: "Corrupt Ledger Grams",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      spools: [{ label: "", totalWeight: 500 }],
    });
    const job = await postJob(f, "corrupt-ledger-grams-job", 100);
    await Filament.collection.updateOne(
      { _id: f._id },
      {
        $set: { "spools.$[].usageHistory.$[].grams": 1e308 },
        $unset: { "spools.$[].usageHistory.$[].debitedGrams": "" },
      },
    );

    const delRes = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(delRes.status).toBe(200);
    const refunded = await Filament.findById(f._id);
    // 400 (post-debit) + 100 (row-grams fallback) — NOT 400 + 1e308.
    expect(refunded.spools[0].totalWeight).toBe(500);
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  it("a retried partial refund undoes the MATCHED ledger entry, not the row (Codex P2 r2)", async () => {
    // Two rows against one spool with identical requested grams but
    // different actual debits: 150g spool, two 100g rows → debits 100 + 50.
    const f = await Filament.create({
      name: "Retry Refund",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      spools: [{ label: "", totalWeight: 150 }],
    });
    const res = await postPrintHistory(
      new NextRequest("http://localhost/api/print-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobLabel: "two-row-job",
          source: "manual",
          usage: [
            { filamentId: String(f._id), grams: 100 },
            { filamentId: String(f._id), grams: 100 },
          ],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const job = await res.json();
    const afterJob = await Filament.findById(f._id);
    expect(afterJob.spools[0].totalWeight).toBe(0);
    const debits = afterJob.spools[0].usageHistory.map(
      (h: { debitedGrams: number | null }) => h.debitedGrams,
    );
    expect(debits.sort((a: number, b: number) => b - a)).toEqual([100, 50]);

    // Simulate a PARTIAL first delete pass that removed + refunded the
    // 100g-debit entry and then failed before completing: the job stays
    // active, the spool holds 100g, and only the 50g-debit entry remains.
    const doc = await Filament.findById(f._id);
    doc.spools[0].usageHistory = doc.spools[0].usageHistory.filter(
      (h: { debitedGrams: number | null }) => h.debitedGrams !== 100,
    );
    doc.spools[0].totalWeight = 100;
    await doc.save({ validateModifiedOnly: true });

    // The retry pairs the remaining entry with the FIRST 100g row. Pre-fix
    // it refunded that ROW's debitedGrams (100) → 200g, minting 50g of
    // phantom weight; refunding the ENTRY's own debit (50) restores the
    // exact pre-job 150g.
    const delRes = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(delRes.status).toBe(200);
    const refunded = await Filament.findById(f._id);
    expect(refunded.spools[0].totalWeight).toBe(150);
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  it("untracked-weight spool records debitedGrams = grams (#1074)", async () => {
    // totalWeight null → nothing is subtracted at debit time, and the
    // refund path skips the weight write entirely. Recording the full
    // grams preserves the legacy posture for this edge (if weight ever
    // becomes tracked later, the refund behaves exactly as before #1074).
    const f = await Filament.create({
      name: "Untracked Weight",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "", totalWeight: null }],
    });
    const job = await postJob(f, "untracked", 100);

    const afterJob = await Filament.findById(f._id);
    expect(afterJob.spools[0].totalWeight).toBeNull();
    const jobRow = await PrintHistory.findById(job._id);
    expect(jobRow.usage[0].debitedGrams).toBe(100);
    expect(afterJob.spools[0].usageHistory[0].debitedGrams).toBe(100);

    const delRes = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(delRes.status).toBe(200);
    const refunded = await Filament.findById(f._id);
    expect(refunded.spools[0].totalWeight).toBeNull();
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  it("a PUT startedAt edit doesn't disturb the clamped refund (#1074 × #1004 F6)", async () => {
    // The #1004 F6 backfill walks legacy (jobId-less) entries on a
    // startedAt edit. Post-#1074 entries always carry a jobId, so the
    // backfill must leave them (and their debitedGrams) alone, and the
    // date-independent jobId refund tiers must still pay back the
    // clamped amount after the edit.
    const f = await Filament.create({
      name: "Edited Then Undone",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 50 }],
    });
    const job = await postJob(f, "clamped-then-edited", 100, new Date("2026-01-01T00:00:00Z"));

    const putRes = await putPrintHistory(
      new NextRequest(`http://localhost/api/print-history/${job._id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startedAt: "2026-02-01T00:00:00Z" }),
      }),
      { params: Promise.resolve({ id: job._id }) },
    );
    expect(putRes.status).toBe(200);

    const delRes = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(delRes.status).toBe(200);
    const refunded = await Filament.findById(f._id);
    expect(refunded.spools[0].totalWeight).toBe(50); // debited 50, not the requested 100
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  // ─── GH #621: retry after a partial failure must not double-refund ───

  it("retry after a mid-loop save failure refunds each filament exactly once (GH #621)", async () => {
    // The bug: the refund loop saves per filament and the _deletedAt
    // tombstone only lands after the loop. If filament B's save throws
    // (VersionError → the route's 409 "Please retry"), filament A is
    // already refunded with its usageHistory entry removed while the job
    // is still active — and the advertised retry used to refund A AGAIN.
    // netFilamentWeight is deliberately unset on A so the gross-capacity
    // clamp can't mask the double-refund.
    const a = await Filament.create({
      name: "Partial Fail A",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      // netFilamentWeight intentionally unset → no clamp ceiling
      spools: [{ label: "", totalWeight: 1000 }],
    });
    const b = await Filament.create({
      name: "Partial Fail B",
      vendor: "Test",
      type: "PETG",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 800 }],
    });

    const postRes = await postPrintHistory(
      new NextRequest("http://localhost/api/print-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobLabel: "two-filament job",
          source: "manual",
          usage: [
            { filamentId: String(a._id), grams: 50 },
            { filamentId: String(b._id), grams: 25 },
          ],
        }),
      }),
    );
    expect(postRes.status).toBe(201);
    const job = await postRes.json();
    expect((await Filament.findById(a._id)).spools[0].totalWeight).toBe(950);
    expect((await Filament.findById(b._id)).spools[0].totalWeight).toBe(775);

    // Make the SECOND filament.save() inside the DELETE loop throw a
    // VersionError (a concurrent edit landing mid-loop — exactly what
    // OCC raises in production). Same prototype-patch technique as
    // tests/print-history-concurrency.test.ts: the route holds its own
    // static model reference, so a spy on the test-side class wouldn't
    // see the route's calls.
    const proto = mongoose.Model.prototype as unknown as {
      save: () => Promise<unknown>;
    };
    const originalSave = proto.save;
    let saveCalls = 0;
    proto.save = async function () {
      saveCalls++;
      if (saveCalls === 2) {
        throw new mongoose.Error.VersionError(
          this as unknown as mongoose.Document,
          0,
          ["spools"],
        );
      }
      return originalSave.apply(this);
    };

    let firstDel;
    try {
      firstDel = await deletePrintHistory(delReq(job._id), {
        params: Promise.resolve({ id: job._id }),
      });
    } finally {
      proto.save = originalSave;
    }
    expect(firstDel.status).toBe(409);

    // Partial state after the failure: A refunded + entry removed, B
    // untouched, job still active (no tombstone).
    const aMid = await Filament.findById(a._id);
    expect(aMid.spools[0].totalWeight).toBe(1000);
    expect(aMid.spools[0].usageHistory).toHaveLength(0);
    const bMid = await Filament.findById(b._id);
    expect(bMid.spools[0].totalWeight).toBe(775);
    expect(bMid.spools[0].usageHistory).toHaveLength(1);
    expect((await PrintHistory.findById(job._id))._deletedAt).toBeNull();

    // The advertised retry. Must finish the job: refund B, tombstone the
    // entry — and NOT refund A a second time.
    const retry = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(retry.status).toBe(200);

    const aAfter = await Filament.findById(a._id);
    // Pre-#621 this was 1050 (refund applied twice, unbounded — no clamp).
    expect(aAfter.spools[0].totalWeight).toBe(1000);
    const bAfter = await Filament.findById(b._id);
    expect(bAfter.spools[0].totalWeight).toBe(800);
    expect(bAfter.spools[0].usageHistory).toHaveLength(0);

    const tombstone = await PrintHistory.findById(job._id);
    expect(tombstone._deletedAt).toBeInstanceOf(Date);
  });

  it("refunds every usage row when a job carries multiple rows against the same spool", async () => {
    // POST allows several usage rows for the same filament; without an
    // explicit spoolId they all resolve to the same spool, each pushing
    // its own usageHistory entry under the shared jobId. The #621 fix
    // consumes exactly ONE entry per usage row (preferring the
    // jobId+grams match) — a remove-all-jobId-matches sweep would leave
    // the second row with nothing to remove and skip its refund.
    const f = await Filament.create({
      name: "Two Rows One Spool",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [{ label: "", totalWeight: 1000 }],
    });
    const postRes = await postPrintHistory(
      new NextRequest("http://localhost/api/print-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobLabel: "two-part job",
          source: "manual",
          usage: [
            { filamentId: String(f._id), grams: 50 },
            { filamentId: String(f._id), grams: 30 },
          ],
        }),
      }),
    );
    expect(postRes.status).toBe(201);
    const job = await postRes.json();
    const afterPost = await Filament.findById(f._id);
    expect(afterPost.spools[0].totalWeight).toBe(920);
    expect(afterPost.spools[0].usageHistory).toHaveLength(2);

    const delRes = await deletePrintHistory(delReq(job._id), {
      params: Promise.resolve({ id: job._id }),
    });
    expect(delRes.status).toBe(200);

    const refunded = await Filament.findById(f._id);
    // Both rows refunded: 920 + 50 + 30 = 1000.
    expect(refunded.spools[0].totalWeight).toBe(1000);
    expect(refunded.spools[0].usageHistory).toHaveLength(0);
  });

  it("does not refund a usage row whose spool has no matching usageHistory entry (GH #621)", async () => {
    // Same fixture as "does not remove a manual entry even when fallback
    // runs", now pinning the WEIGHT: the only entry on the spool is a
    // manual log the source-restricted fallback refuses to touch, so
    // nothing is removed — and, new in #621, nothing is refunded either.
    // Pre-#621 the route refunded the 150g anyway, drifting the spool
    // weight out of sync with the surviving manual ledger entry (and
    // doing so again on every repeat of the same delete-shaped call).
    const startedAt = new Date("2026-04-30T12:00:00Z");
    const f = await Filament.create({
      name: "No Entry No Refund",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [
        {
          label: "",
          totalWeight: 850,
          usageHistory: [
            { grams: 150, jobLabel: "manual-only", date: startedAt, source: "manual", jobId: null },
          ],
        },
      ],
    });
    const orphan = await PrintHistory.create({
      jobLabel: "ghost",
      usage: [{ filamentId: f._id, spoolId: f.spools[0]._id, grams: 150 }],
      startedAt,
      source: "manual",
    });

    const delRes = await deletePrintHistory(delReq(String(orphan._id)), {
      params: Promise.resolve({ id: String(orphan._id) }),
    });
    expect(delRes.status).toBe(200);

    const fresh = await Filament.findById(f._id);
    // Weight unchanged — no entry was removed, so no refund applies.
    expect(fresh.spools[0].totalWeight).toBe(850);
    expect(fresh.spools[0].usageHistory).toHaveLength(1);
    expect(fresh.spools[0].usageHistory[0].source).toBe("manual");
  });
});

describe("analytics GET — double-counting regression", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;

  beforeEach(async () => {
    // The shared afterEach in tests/setup.ts wipes mongoose.models between
    // tests; ESM module caching means a dynamic `import(...)` won't
    // re-execute the model file, so the mongoose registry stays empty and
    // .populate() calls inside the routes fail with "Schema hasn't been
    // registered". Manually re-attach every model this file uses by pulling
    // the schema off the cached class and calling mongoose.model directly.
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

  it("does not double-count a manual job that also sits in spool.usageHistory", async () => {
    // Simulate what POST /api/print-history with source:"manual" produces:
    // a PrintHistory row AND a spool.usageHistory entry. With the fix, the
    // spool entry is tagged "job" so analytics picks up exactly one record
    // of the 100g consumption.
    const f = await Filament.create({
      name: "No Double Count",
      vendor: "Test",
      type: "PLA",
      cost: 25,
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [
        {
          label: "",
          totalWeight: 900,
          usageHistory: [
            { grams: 100, jobLabel: "printA", date: new Date(), source: "job" },
          ],
        },
      ],
    });
    await PrintHistory.create({
      jobLabel: "printA",
      usage: [{ filamentId: f._id, spoolId: f.spools[0]._id, grams: 100 }],
      startedAt: new Date(),
      source: "manual",
    });

    const req = new NextRequest("http://localhost/api/analytics?days=30");
    const res = await getAnalytics(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.totals.grams).toBe(100);
    expect(body.byFilament).toHaveLength(1);
    expect(body.byFilament[0].grams).toBe(100);
  });

  it("still includes manual-only spool entries (no PrintHistory row)", async () => {
    // User who logs weight directly on the spool UI — no slicer, no
    // PrintHistory row. These must still show up in analytics so the
    // dashboard isn't blank for manual-only users.
    await Filament.create({
      name: "Manual Only",
      vendor: "Test",
      type: "PLA",
      cost: 20,
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [
        {
          label: "",
          totalWeight: 800,
          usageHistory: [
            { grams: 50, jobLabel: "calibration", date: new Date(), source: "manual" },
          ],
        },
      ],
    });

    const req = new NextRequest("http://localhost/api/analytics?days=30");
    const res = await getAnalytics(req);
    const body = await res.json();
    expect(body.totals.grams).toBe(50);
  });


});

/**
 * GH #1121 — a job against a LEGACY single-spool filament (stock on the
 * filament's own totalWeight, no spools[] subdocument) recorded usage with
 * spoolId: null and NO debit: analytics reported the grams and cost while the
 * remaining weight never moved.
 */
describe("POST /api/print-history — legacy single-spool filaments (#1121)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let PrintHistory: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    for (const m of ["Filament", "PrintHistory", "Printer", "Nozzle", "BedType", "Location"]) {
      delete mongoose.models[m];
    }
    Filament = (await import("@/models/Filament")).default;
    await import("@/models/Printer");
    await import("@/models/Nozzle");
    await import("@/models/BedType");
    await import("@/models/Location");
    PrintHistory = (await import("@/models/PrintHistory")).default;
  });

  const postJob = (filamentId: string, grams: number) =>
    postPrintHistory(
      new NextRequest("http://localhost/api/print-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobLabel: "Legacy job",
          startedAt: new Date().toISOString(),
          usage: [{ filamentId, grams }],
        }),
      }),
    );

  it("migrates the legacy roll to a real spool and debits it", async () => {
    const f = await Filament.create({
      name: "Legacy Debit",
      vendor: "V",
      type: "PLA",
      spoolWeight: 200,
      totalWeight: 1000,
      spools: [],
    });
    const res = await postJob(String(f._id), 150);
    expect(res.status).toBe(201);
    const body = await res.json();
    // The whole point: a real spool ref, not the silent spoolId: null.
    expect(body.usage[0].spoolId).toBeTruthy();

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(850);
    // The legacy field is cleared, or the fallback would resurrect the roll.
    expect(fresh.totalWeight).toBeNull();
    // Carry-over identity preserved for printed labels / NFC tags.
    expect(fresh.spools[0].instanceId).toBe(f.instanceId);
  });

  it("round-trips: deleting the job restores the weight", async () => {
    // This is why migrating beats debiting the top-level field — the refund
    // works through the existing usageHistory machinery.
    const f = await Filament.create({
      name: "Legacy Undo",
      vendor: "V",
      type: "PLA",
      totalWeight: 1000,
      spools: [],
    });
    const created = await (await postJob(String(f._id), 250)).json();
    const mid = await Filament.findById(f._id);
    expect(mid.spools[0].totalWeight).toBe(750);

    const del = await deletePrintHistory(
      new NextRequest(`http://localhost/api/print-history/${created._id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: String(created._id) }) },
    );
    expect(del.status).toBe(200);

    const after = await Filament.findById(f._id);
    expect(after.spools[0].totalWeight).toBe(1000);
    expect(after.spools[0].usageHistory).toHaveLength(0);
  });

  it("refuses a legacy TEMPLATE — inventory belongs on its variants (#605)", async () => {
    const parent = await Filament.create({
      name: "Legacy Template",
      vendor: "V",
      type: "PLA",
      totalWeight: 1000,
      spools: [],
    });
    await Filament.create({
      name: "Legacy Template Red",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
    });

    const res = await postJob(String(parent._id), 100);
    expect(res.status).toBe(400);

    const fresh = await Filament.findById(parent._id);
    expect(fresh.spools).toHaveLength(0);
    expect(fresh.totalWeight).toBe(1000);
    expect(await PrintHistory.countDocuments({})).toBe(0);
  });

  it("migrates a record carrying a value that predates current validators (Codex P2)", async () => {
    // The persist paths here use validateModifiedOnly (GH #905) precisely so a
    // legacy record isn't rejected over a field the request never touched. The
    // migration save needs the same option, or the slicer's job is refused on
    // exactly the old records this change exists to serve.
    const f = await Filament.create({
      name: "Legacy Odd Values",
      vendor: "V",
      type: "PLA",
      totalWeight: 1000,
      spools: [],
    });
    // Write past the validators, the way a pre-validator record would exist.
    await Filament.collection.updateOne(
      { _id: f._id },
      { $set: { "temperatures.nozzle": 9999 } },
    );

    const res = await postJob(String(f._id), 100);
    expect(res.status).toBe(201);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(900);
  });

  it("migrates every legacy filament in a MULTI-filament job", async () => {
    // The multi-filament path can't hold a continuous lock (a cross-filament
    // transaction would need every key at once), so each migration takes its
    // own key one at a time — like the saves that follow it.
    const a = await Filament.create({
      name: "Legacy A", vendor: "V", type: "PLA", totalWeight: 1000, spools: [],
    });
    const b = await Filament.create({
      name: "Legacy B", vendor: "V", type: "PETG", totalWeight: 800, spools: [],
    });
    const req = new NextRequest("http://localhost/api/print-history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobLabel: "Two rolls",
        startedAt: new Date().toISOString(),
        usage: [
          { filamentId: String(a._id), grams: 100 },
          { filamentId: String(b._id), grams: 50 },
        ],
      }),
    });
    const res = await postPrintHistory(req);
    expect(res.status).toBe(201);

    const freshA = await Filament.findById(a._id);
    const freshB = await Filament.findById(b._id);
    expect(freshA.spools).toHaveLength(1);
    expect(freshA.spools[0].totalWeight).toBe(900);
    expect(freshA.totalWeight).toBeNull();
    expect(freshB.spools).toHaveLength(1);
    expect(freshB.spools[0].totalWeight).toBe(750);
  });

  it("refuses when a promotion cleared the parent while we waited for the lock (Codex P1)", async () => {
    // Made deterministic by HOLDING the filament's key while the route queues
    // behind it — the same technique tests/template-model-races.test.ts uses.
    //
    // Pass 1 reads the legacy shape (spools: [], totalWeight: 1000), so the
    // migration helper is entered. While it waits for the key, a confirmed
    // first-variant promotion moves the weight to a sibling and CLEARS the
    // parent. The in-lock read then sees spools: [] + totalWeight: null,
    // which is indistinguishable from "already handled, nothing to do"
    // unless the code asks whether the row is now a template. Without that
    // question the job 201s against an empty template with no debit.
    const parent = await Filament.create({
      name: "Cleared By Promotion",
      vendor: "V",
      type: "PLA",
      totalWeight: 1000,
      spools: [],
    });

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const lockHold = runExclusive(filamentLockKey(parent._id), () => held);

    const resPromise = postJob(String(parent._id), 100);
    // Let pass 1 run and the migration queue behind our hold.
    while (lockedKeyCount() === 0) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));

    // What the promotion leaves behind: a live variant carrying the weight,
    // and a parent cleared of it.
    await Filament.create({
      name: "Cleared By Promotion — Original",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
      spools: [{ label: "moved", totalWeight: 1000 }],
    });
    await Filament.updateOne({ _id: parent._id }, { $set: { totalWeight: null } });

    release();
    await lockHold;

    const res = await resPromise;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("template");
    // Nothing was recorded, and the promoted variant keeps its full roll.
    const moved = await Filament.findOne({ name: "Cleared By Promotion — Original" });
    expect(moved.spools[0].totalWeight).toBe(1000);
  });

  it("adopts an already-migrated document so the fallback can't double-write (Codex P1)", async () => {
    // Whoever held the lock first migrated it. Returning the STALE pass-1
    // copy left the standalone fallback applying the job to an empty-spool
    // document — a second spoolId: null history row with no debit.
    const f = await Filament.create({
      name: "Migrated By Peer", vendor: "V", type: "PLA", totalWeight: 1000, spools: [],
    });
    // Simulate the peer's migration landing between pass 1 and the lock.
    await Filament.updateOne(
      { _id: f._id },
      { $set: { totalWeight: null, spools: [{ label: "", totalWeight: 1000 }] } },
    );

    const res = await postJob(String(f._id), 100);
    expect(res.status).toBe(201);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(900);
    const job = await res.json();
    expect(job.usage[0].spoolId).toBeTruthy();
  });

  it("does NOT migrate an all-retired filament — that contract is unchanged (#305)", async () => {
    // A legacy filament has an EMPTY array; an all-retired one has a populated
    // array. Only the former migrates; the latter must still record
    // spoolId: null with no debit.
    const f = await Filament.create({
      name: "All Retired",
      vendor: "V",
      type: "PLA",
      spools: [{ label: "old", totalWeight: 500, retired: true }],
    });
    const res = await postJob(String(f._id), 100);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.usage[0].spoolId).toBeNull();

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(500);
  });
});
