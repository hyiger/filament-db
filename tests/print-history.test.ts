import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { DELETE as deletePrintHistory } from "@/app/api/print-history/[id]/route";
import { GET as getAnalytics } from "@/app/api/analytics/route";

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
