import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
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
