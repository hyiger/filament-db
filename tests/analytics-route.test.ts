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

/**
 * GH #934 — per-day per-filament breakdown for the stacked Usage-by-day
 * chart. Each `usageByDay[i].byFilament` carries `{id, name, color, grams}`,
 * sorted DESCENDING so the bottom of the stack is the largest contributor.
 * The day's top-level `grams` equals the sum of the rounded segment grams.
 *
 * Color resolves through variant→parent inheritance via `displayColor()`
 * so an inheriting variant shows the parent's color and a coextruded
 * filament with `color === null` falls through to `secondaryColors[0]`.
 */
describe("/api/analytics — usageByDay.byFilament breakdown (GH #934)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    delete mongoose.models.Filament;
    Filament = (await import("@/models/Filament")).default;
    delete mongoose.models.PrintHistory;
    await import("@/models/PrintHistory");
  });

  it("single-filament day → byFilament has one entry whose grams equals the day total", async () => {
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await Filament.create({
      name: "Red PLA",
      vendor: "Vendor",
      type: "PLA",
      color: "#FF0000",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 40, date: recent, source: "manual", jobId: null }],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const nonZero = body.usageByDay.filter(
      (d: { grams: number }) => d.grams > 0,
    );
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0].byFilament).toHaveLength(1);
    expect(nonZero[0].byFilament[0].name).toBe("Red PLA");
    expect(nonZero[0].byFilament[0].color).toBe("#FF0000");
    expect(nonZero[0].byFilament[0].grams).toBe(40);
    expect(nonZero[0].grams).toBe(40);
  });

  it("multi-filament day → byFilament sorted DESC and total = sum of segments", async () => {
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await Filament.create({
      name: "Red PLA",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 10, date: recent, source: "manual", jobId: null }],
        },
      ],
    });
    await Filament.create({
      name: "Blue PLA",
      vendor: "V",
      type: "PLA",
      color: "#0000FF",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 50, date: recent, source: "manual", jobId: null }],
        },
      ],
    });
    await Filament.create({
      name: "Green PLA",
      vendor: "V",
      type: "PLA",
      color: "#00FF00",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 25, date: recent, source: "manual", jobId: null }],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find(
      (d: { grams: number }) => d.grams > 0,
    );
    expect(day).toBeDefined();
    expect(day.byFilament).toHaveLength(3);
    // Sorted DESC by grams.
    expect(day.byFilament.map((e: { name: string }) => e.name)).toEqual([
      "Blue PLA",
      "Green PLA",
      "Red PLA",
    ]);
    const sum = day.byFilament.reduce(
      (acc: number, e: { grams: number }) => acc + e.grams,
      0,
    );
    expect(sum).toBe(day.grams);
    expect(day.grams).toBe(85);
  });

  it("variant inherits parent color when own color is blank", async () => {
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const parent = await Filament.create({
      name: "Parent PLA",
      vendor: "V",
      type: "PLA",
      color: "#ABCDEF",
    });
    await Filament.create({
      name: "Variant PLA",
      vendor: "V",
      type: "PLA",
      // Variant has no own color — should inherit "#ABCDEF" from parent.
      color: null,
      parentId: parent._id,
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 30, date: recent, source: "manual", jobId: null }],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find(
      (d: { grams: number }) => d.grams > 0,
    );
    expect(day).toBeDefined();
    expect(day.byFilament).toHaveLength(1);
    expect(day.byFilament[0].name).toBe("Variant PLA");
    expect(day.byFilament[0].color).toBe("#ABCDEF");
  });

  it("coextruded filament (null primary) resolves to secondaryColors[0] via displayColor()", async () => {
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await Filament.create({
      name: "Coextruded PLA",
      vendor: "V",
      type: "PLA",
      color: null,
      secondaryColors: ["#112233", "#445566"],
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 20, date: recent, source: "manual", jobId: null }],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find(
      (d: { grams: number }) => d.grams > 0,
    );
    expect(day).toBeDefined();
    expect(day.byFilament).toHaveLength(1);
    expect(day.byFilament[0].color).toBe("#112233");
  });

  /**
   * PrintHistory loop coverage. The four tests above all seed via
   * `spools[].usageHistory` (`source: "manual"`), exercising only the
   * second loop in `route.ts`. The first loop reads its color from the
   * `.populate("usage.filamentId", "name vendor cost parentId color secondaryColors")`
   * select string — trimming that select would silently regress every
   * PrintHistory-driven segment to the `"#808080"` sentinel. This test
   * pins the populate-select shape against both inheritance and
   * coextruded fallback (Codex P2 on PR #936).
   */
  it("PrintHistory loop: variant inherits parent color + coextruded falls back to secondaryColors[0]", async () => {
    // The PrintHistory route uses
    // `.populate("usage.filamentId", "name vendor cost parentId color secondaryColors")`,
    // which resolves the "Filament" model by name. The shared `beforeEach`
    // above deletes models then re-imports — but the cached module's
    // first-import side-effect already ran, so the registry can end up
    // empty at populate time. Mirror the (working) pattern in
    // `tests/variant-inheritance-routes.test.ts:30` and re-register the
    // schemas if absent.
    const filMod = await import("@/models/Filament");
    const phMod = await import("@/models/PrintHistory");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filMod.default.schema);
    }
    if (!mongoose.models.PrintHistory) {
      mongoose.model("PrintHistory", phMod.default.schema);
    }
    const printerMod = await import("@/models/Printer");
    if (!mongoose.models.Printer) {
      mongoose.model("Printer", printerMod.default.schema);
    }
    const F = mongoose.models.Filament;
    const PH = mongoose.models.PrintHistory;
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const parent = await F.create({
      name: "PH Parent",
      vendor: "V",
      type: "PLA",
      color: "#ABCDEF",
    });
    const variant = await F.create({
      name: "PH Variant",
      vendor: "V",
      type: "PLA",
      color: null,
      parentId: parent._id,
    });
    const coex = await F.create({
      name: "PH Coextruded",
      vendor: "V",
      type: "PLA",
      color: null,
      secondaryColors: ["#112233"],
    });

    await PH.create({
      jobLabel: "ph color job",
      startedAt: recent,
      usage: [
        { filamentId: variant._id, grams: 10 },
        { filamentId: coex._id, grams: 20 },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find((d: { grams: number }) => d.grams > 0);
    expect(day).toBeDefined();
    expect(day.byFilament).toHaveLength(2);
    const byName = new Map<string, { color: string; grams: number }>(
      day.byFilament.map((e: { name: string; color: string; grams: number }) => [
        e.name,
        { color: e.color, grams: e.grams },
      ]),
    );
    expect(byName.get("PH Variant")?.color).toBe("#ABCDEF");
    expect(byName.get("PH Coextruded")?.color).toBe("#112233");
  });

  /**
   * Inherited-coextruded path: parent carries `secondaryColors` only and
   * a variant inheriting both `color` and `secondaryColors` should
   * resolve through `parentColorMap.get(...) → displayColor(p)` →
   * `secondaryColors[0]`. The other inheritance test gives the parent a
   * primary `color`, so this is the only case that pins
   * `.select("_id cost color secondaryColors")` at the parents query
   * (Codex P2 on PR #936) — trimming `secondaryColors` from that select
   * would silently break only this case.
   */
  it("variant inherits parent's secondaryColors[0] when both color and own secondaryColors are empty", async () => {
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const parent = await Filament.create({
      name: "Coex Parent",
      vendor: "V",
      type: "PLA",
      color: null,
      secondaryColors: ["#998877", "#665544"],
    });
    await Filament.create({
      name: "Coex Variant",
      vendor: "V",
      type: "PLA",
      color: null,
      // Variant declares no own colors — inherits from parent via
      // resolveFilament's array-fallback rule.
      secondaryColors: [],
      parentId: parent._id,
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 30, date: recent, source: "manual", jobId: null }],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find((d: { grams: number }) => d.grams > 0);
    expect(day).toBeDefined();
    expect(day.byFilament).toHaveLength(1);
    expect(day.byFilament[0].name).toBe("Coex Variant");
    expect(day.byFilament[0].color).toBe("#998877");
  });

  /**
   * Rounding invariant — fractional grams. Pre-fix the chart dropped
   * sub-0.5g segments to zero AND derived the day total as the
   * sum-of-rounded-zero-segments, while `totals.grams` rounded the raw
   * sum and the no-data check at `every(d => d.grams === 0)` would
   * silently hide the bar. After the fix, the day total is round-of-raw
   * so a 0.4g entry contributes to the visible day, and segments with
   * raw > 0 are kept in the breakdown even when they round to zero
   * (Codex P2 on PR #936).
   */
  it("preserves sub-0.5g usage in the day total and keeps positive-raw segments visible", async () => {
    const recent = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    await Filament.create({
      name: "Sub-half PLA",
      vendor: "V",
      type: "PLA",
      color: "#FF00FF",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          // Three 0.4g entries on the same day, same filament → raw sum
          // 1.2g → day total rounds to 1g and segment grams rounds to 1g.
          usageHistory: [
            { grams: 0.4, date: recent, source: "manual", jobId: null },
            { grams: 0.4, date: recent, source: "manual", jobId: null },
            { grams: 0.4, date: recent, source: "manual", jobId: null },
          ],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find((d: { grams: number }) => d.grams > 0);
    expect(day).toBeDefined();
    // Round-of-raw: Math.round(1.2) === 1.
    expect(day.grams).toBe(1);
    // The segment for this filament aggregates raw 1.2g → rounds to 1g,
    // not dropped by the rounded-zero filter.
    expect(day.byFilament).toHaveLength(1);
    expect(day.byFilament[0].name).toBe("Sub-half PLA");
    expect(day.byFilament[0].grams).toBe(1);
    expect(body.totals.grams).toBe(1);
  });
});
