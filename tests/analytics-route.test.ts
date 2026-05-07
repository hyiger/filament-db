import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as getAnalytics } from "@/app/api/analytics/route";

/**
 * Per-spool manual usage entries (logged via the spool detail UI, not via
 * /api/print-history) count toward grams + cost in /api/analytics, but
 * are NOT PrintHistory documents — so they don't show up in `totals.jobs`.
 *
 * Pre-fix the analytics page rendered "Grams used 50 g · $1.10 · 0 jobs"
 * with no way for the user to attribute the 50 g. Now the route exposes
 * `totals.manualEntries` so the renderer can show "+N manual" alongside
 * the jobs counter (GH #204).
 */
describe("/api/analytics — manualEntries counter (GH #204)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    delete mongoose.models.Filament;
    Filament = (await import("@/models/Filament")).default;
    // PrintHistory needs to be registered too — analytics queries it.
    delete mongoose.models.PrintHistory;
    await import("@/models/PrintHistory");
  });

  it("counts each manual usageHistory entry in the window", async () => {
    const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    await Filament.create({
      name: "Test PLA",
      vendor: "Vendor",
      type: "PLA",
      cost: 22,
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [
            // 3 manual entries — all should count.
            { grams: 25, date: recent, source: "manual", jobId: null },
            { grams: 15, date: recent, source: "manual", jobId: null },
            { grams: 10, date: recent, source: "manual", jobId: null },
          ],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    expect(body.totals.grams).toBe(50);
    expect(body.totals.jobs).toBe(0);
    expect(body.totals.manualEntries).toBe(3);
  });

  it("does NOT count manual entries outside the window", async () => {
    const tooOld = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days
    await Filament.create({
      name: "Test PLA",
      vendor: "Vendor",
      type: "PLA",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 25, date: tooOld, source: "manual", jobId: null }],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    expect(body.totals.manualEntries).toBe(0);
  });

  it("does NOT count `source: 'job'` entries (they're owned by PrintHistory and would double-count)", async () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await Filament.create({
      name: "Test PLA",
      vendor: "Vendor",
      type: "PLA",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [
            { grams: 25, date: recent, source: "manual", jobId: null },
            { grams: 100, date: recent, source: "job", jobId: new mongoose.Types.ObjectId() },
            { grams: 50, date: recent, source: "slicer", jobId: null },
          ],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    // Only the "manual" entry counts — same-loop guard for `source !== 'manual'`.
    expect(body.totals.manualEntries).toBe(1);
  });

  it("totals.manualEntries is 0 when no manual entries exist", async () => {
    await Filament.create({
      name: "Test PLA",
      vendor: "Vendor",
      type: "PLA",
      spools: [{ label: "main", totalWeight: 950 }],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    expect(body.totals.manualEntries).toBe(0);
    expect(body.totals.jobs).toBe(0);
  });
});
