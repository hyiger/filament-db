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
