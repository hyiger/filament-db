import { describe, it, expect, beforeEach, vi } from "vitest";
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

  /**
   * Variant color inheritance MATCHES `src/lib/resolveFilament.ts`:
   *
   *   - `color` is variant-only — a blank-primary variant does NOT
   *     inherit the parent's primary color (Codex P2 on PR #936; would
   *     otherwise diverge from every list/detail/export path).
   *   - `secondaryColors` uses the array-fallback rule: a variant with
   *     an empty/absent array inherits the parent's whole array (GH
   *     #477), so a blank-primary variant under a parent with
   *     `secondaryColors` picks up the parent's `secondaryColors[0]`.
   *   - Otherwise the segment falls through to `"#808080"` — the same
   *     hex the list/detail views paint for the same shape.
   */
  it("blank-primary variant WITHOUT parent secondaryColors resolves to the #808080 sentinel — parent primary is NOT inherited", async () => {
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const parent = await Filament.create({
      name: "Parent Solid PLA",
      vendor: "V",
      type: "PLA",
      color: "#ABCDEF",
      // Parent has NO secondaryColors — so the variant has nothing to
      // inherit and MUST fall through to the sentinel, matching the
      // list/detail/export rendering.
    });
    await Filament.create({
      name: "Variant Blank PLA",
      vendor: "V",
      type: "PLA",
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
    expect(day.byFilament[0].name).toBe("Variant Blank PLA");
    // Sentinel — parent primary #ABCDEF is intentionally NOT inherited.
    expect(day.byFilament[0].color).toBe("#808080");
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
   * Coextruded VARIANT under a coextruded PARENT — pins the
   * `ownHasPrimary || ownHasSecondary` short-circuit in resolveColor.
   * The standalone coextruded test above doesn't discriminate this
   * branch: with no parentId, dropping the `ownHasSecondary` from the
   * OR would still land in the final `else displayColor(own)` branch
   * and return `secondaryColors[0]` unchanged. Here the parent has
   * DIFFERENT secondaries — the current code returns the variant's
   * `#112233` via the short-circuit; a mutation that fell through to
   * the parent-lookup branch instead would return `#999999`.
   */
  it("coextruded variant's OWN secondaryColors beat parent's (short-circuit before parent lookup)", async () => {
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const parent = await Filament.create({
      name: "Coex Parent (differently colored)",
      vendor: "V",
      type: "PLA",
      color: null,
      secondaryColors: ["#999999", "#AAAAAA"],
    });
    await Filament.create({
      name: "Coex Variant (own secondaries)",
      vendor: "V",
      type: "PLA",
      color: null,
      secondaryColors: ["#112233"],
      parentId: parent._id,
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
    const day = body.usageByDay.find((d: { grams: number }) => d.grams > 0);
    expect(day).toBeDefined();
    expect(day.byFilament).toHaveLength(1);
    // Variant's own secondaries win via the short-circuit — NOT parent's #999999.
    expect(day.byFilament[0].color).toBe("#112233");
  });

  /**
   * PrintHistory loop coverage. The four tests above all seed via
   * `spools[].usageHistory` (`source: "manual"`), exercising only the
   * second loop in `route.ts`. The first loop reads its color from the
   * `.populate("usage.filamentId", "name vendor cost parentId color secondaryColors")`
   * select string — trimming that select would silently regress every
   * PrintHistory-driven segment to the `"#808080"` sentinel. This test
   * pins the populate-select shape against both parent-secondary
   * inheritance and coextruded fallback (Codex P2 on PR #936). Variant
   * primary `color` is NOT inherited (matches `resolveFilament`'s
   * `VARIANT_ONLY_FIELDS`); only parent's `secondaryColors` may fall
   * through.
   */
  it("PrintHistory loop: variant inherits parent secondaryColors + coextruded falls back to own secondaryColors[0]", async () => {
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
      // Parent has BOTH a primary and secondaries. The variant below
      // MUST inherit the secondary chain (`#DDDDEE`) NOT the primary
      // (`#ABCDEF`), matching resolveFilament's VARIANT_ONLY_FIELDS.
      color: "#ABCDEF",
      secondaryColors: ["#DDDDEE"],
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
    // Variant inherits ONLY parent's secondaryColors[0] — the primary
    // #ABCDEF is intentionally NOT propagated (variant-only field).
    expect(byName.get("PH Variant")?.color).toBe("#DDDDEE");
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
   * Rounding invariant — fractional grams spread across DISTINCT
   * filaments on the same day. Pre-fix the route did
   * `.map(([id, v]) => ({ ..., grams: Math.round(v.grams) }))
   *   .filter((e) => e.grams > 0)` and derived the day total as
   * `sum-of-rounded-segments`, so three 0.4g entries on distinct
   * filaments each rounded to 0 and were dropped → `day.grams = 0`
   * while `totals.grams = Math.round(1.2) = 1`. The no-data check
   * `every(d => d.grams === 0)` then hid the day from the chart even
   * though the headline showed 1 g of usage.
   *
   * Post-fix (Codex P2 on PR #936 + the follow-up round on `034788bc`):
   *   1. `day.grams = Math.round(rawDaySum)` — the sub-0.5g entries are
   *      preserved in the day total.
   *   2. `filter(([, v]) => v.grams > 0)` filters on RAW grams, so
   *      rounded-zero segments survive to the byFilament breakdown.
   *   3. Segments are apportioned via Hamilton's largest-remainder
   *      method so `Σ byFilament[].grams === day.grams` by
   *      construction (no visible drift between the day-bar total
   *      and its stacked segments — the pathological case is exactly
   *      this one: 3 segments at 0.4g → each round-independently to 0
   *      but day = 1 → one segment gets the +1 apportionment).
   *
   * NB: three entries on the SAME filament would aggregate to a single
   * segment with raw sum 1.2 g that rounds to 1 regardless of strategy,
   * failing to discriminate pre-fix from post-fix. Distinct filaments
   * are load-bearing here.
   */
  it("preserves sub-0.5g usage AND apportions the day total across distinct filaments (Σ segments === day.grams)", async () => {
    const recent = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    // Three DISTINCT filaments — the segment must be their aggregation
    // bucket to hit the round-to-zero-per-segment pathology.
    for (let i = 0; i < 3; i++) {
      await Filament.create({
        name: `Sub-half PLA ${i}`,
        vendor: "V",
        type: "PLA",
        color: `#${(i + 1).toString(16).padStart(2, "0")}${(i + 1).toString(16).padStart(2, "0")}${(i + 1).toString(16).padStart(2, "0")}`,
        spools: [
          {
            label: "main",
            totalWeight: 950,
            usageHistory: [
              { grams: 0.4, date: recent, source: "manual", jobId: null },
            ],
          },
        ],
      });
    }

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find((d: { grams: number }) => d.grams > 0);
    expect(day).toBeDefined();
    // Round-of-raw: Math.round(3 × 0.4) === 1.
    expect(day.grams).toBe(1);
    // All three segments survive the raw-> 0 filter (raw > 0, not rounded > 0).
    // Pre-fix (rounded > 0 filter): array would be empty.
    expect(day.byFilament).toHaveLength(3);
    // Hamilton apportionment guarantees Σ segments === day.grams. One
    // segment gets +1 via the largest-remainder distribution; the other
    // two stay at 0. Which one wins isn't asserted (ties broken by raw
    // grams desc — all three raws are equal here so the winner depends
    // on stable order), but the SUM invariant is pinned.
    const segmentSum = day.byFilament.reduce(
      (s: number, e: { grams: number }) => s + e.grams,
      0,
    );
    expect(segmentSum).toBe(day.grams);
    expect(segmentSum).toBe(1);
    expect(body.totals.grams).toBe(1);
  });

  /**
   * Filter-position regression guard. The route filters on RAW grams
   * BEFORE rounding: `filter(([, v]) => v.grams > 0)`. Reverting to a
   * filter on rounded grams (`filter((e) => e.grams > 0)` after the
   * rounding map) would silently drop sub-0.5g segments — the exact
   * regression Codex flagged on PR #936. This test pins the current
   * shape by seeding one sub-0.5g filament ALONGSIDE a well-above
   * filament on the same day, so the day.grams total is non-trivially
   * non-zero and the small segment MUST appear in the breakdown.
   */
  it("sub-0.5g segment survives the raw-grams filter alongside a larger segment", async () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await Filament.create({
      name: "Small PLA",
      vendor: "V",
      type: "PLA",
      color: "#001122",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 0.4, date: recent, source: "manual", jobId: null }],
        },
      ],
    });
    await Filament.create({
      name: "Big PLA",
      vendor: "V",
      type: "PLA",
      color: "#334455",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 5, date: recent, source: "manual", jobId: null }],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find((d: { grams: number }) => d.grams > 0);
    expect(day).toBeDefined();
    // day.grams = Math.round(5.4) = 5.
    expect(day.grams).toBe(5);
    // Both segments present — the 0.4g one survives raw-filter even
    // though its Hamilton-apportioned display is 0.
    expect(day.byFilament).toHaveLength(2);
    const names = day.byFilament.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(["Big PLA", "Small PLA"]);
    // Σ segments === day.grams by construction.
    const segmentSum = day.byFilament.reduce(
      (s: number, e: { grams: number }) => s + e.grams,
      0,
    );
    expect(segmentSum).toBe(day.grams);
  });

  /**
   * Hamilton tie-break DIRECTION. The existing sub-0.5g test uses
   * three EQUAL 0.4g raws — with all fracs equal the sort comparator
   * (`b.frac - a.frac || b.raw - a.raw`) returns 0 for every pair, so
   * the +1 deficit lands on whichever segment sorts first via engine
   * stability. That's insufficient to pin the DESC-by-frac direction:
   * a mutation flipping to `a.frac - b.frac` would still yield the
   * same segmentSum, and the test comment already acknowledges "which
   * one wins isn't asserted". This test uses UNEQUAL fracs (0.7 vs
   * 0.3) so the larger-frac winner is deterministic and the direction
   * IS pinned. Reversing the comparator sign would fail the
   * `byFilament[name].grams === 1` assertion for the 0.7 filament.
   */
  it("Hamilton apportionment tie-break gives the +1 to the LARGER-frac segment", async () => {
    const recent = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    await Filament.create({
      name: "Larger Frac",
      vendor: "V",
      type: "PLA",
      color: "#111111",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 0.7, date: recent, source: "manual", jobId: null }],
        },
      ],
    });
    await Filament.create({
      name: "Smaller Frac",
      vendor: "V",
      type: "PLA",
      color: "#222222",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 0.3, date: recent, source: "manual", jobId: null }],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const day = body.usageByDay.find((d: { grams: number }) => d.grams > 0);
    expect(day).toBeDefined();
    // rawDaySum = 1.0 → dayGrams = 1.
    expect(day.grams).toBe(1);
    // Both segments present (raw-filter, not rounded-filter).
    expect(day.byFilament).toHaveLength(2);
    const byName = new Map<string, number>(
      day.byFilament.map((e: { name: string; grams: number }) => [e.name, e.grams]),
    );
    // Larger-frac winner: 0.7g → ideal ≈ 0.7 → floor 0, frac 0.7.
    // Smaller-frac: 0.3g → ideal ≈ 0.3 → floor 0, frac 0.3. Deficit=1
    // → 0.7 wins the +1, Smaller stays at 0.
    expect(byName.get("Larger Frac")).toBe(1);
    expect(byName.get("Smaller Frac")).toBe(0);
  });

  /**
   * usageByDay outer-day sort direction. Every other usageByDay test
   * uses `.find(d => d.grams > 0)` / `.reduce` — none depend on the
   * emit order. A mutation flipping the sort comparator to render the
   * chart right-to-left in time would pass every existing assertion.
   * This test seeds usage on two DISTINCT days and pins ASC order via
   * index comparison.
   */
  it("emits usageByDay in ASC date order (older days first)", async () => {
    const olderDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const olderKey = olderDate.toISOString().slice(0, 10);
    const recentKey = recentDate.toISOString().slice(0, 10);

    await Filament.create({
      name: "Two-day PLA",
      vendor: "V",
      type: "PLA",
      color: "#654321",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [
            { grams: 5, date: olderDate, source: "manual", jobId: null },
            { grams: 5, date: recentDate, source: "manual", jobId: null },
          ],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    const idxOld = body.usageByDay.findIndex(
      (d: { date: string }) => d.date === olderKey,
    );
    const idxRecent = body.usageByDay.findIndex(
      (d: { date: string }) => d.date === recentKey,
    );
    expect(idxOld).toBeGreaterThanOrEqual(0);
    expect(idxRecent).toBeGreaterThanOrEqual(0);
    // ASC: older day appears BEFORE recent day. A mutation flipping
    // the sort would trip this.
    expect(idxOld).toBeLessThan(idxRecent);
    // Also assert the array is monotonically ASC over its full length.
    for (let i = 1; i < body.usageByDay.length; i++) {
      expect(body.usageByDay[i].date > body.usageByDay[i - 1].date).toBe(true);
    }
  });

  /**
   * Future-dated entries: a bad client clock or a mis-imported snapshot
   * can plant a `startedAt` / `usageHistory[].date` past `now`. Pre-fix
   * the entry was counted in `totals.grams` / `byFilament` / `byVendor`
   * but the corresponding `dayKey` had no bucket (the seed loop stops
   * at `now`), so it silently vanished from `usageByDay` — chart and
   * headline disagreed. Post-fix both loops skip `date > now` at
   * ingestion time and the DB query caps `startedAt: { $lte: now }`
   * as belt-and-suspenders (Codex P3 on PR #936).
   */
  it("skips future-dated entries in ALL aggregates so headline and chart agree", async () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await Filament.create({
      name: "Bad Clock PLA",
      vendor: "V",
      type: "PLA",
      color: "#010101",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [
            // Real entry in-window — should count everywhere.
            { grams: 10, date: recent, source: "manual", jobId: null },
            // Future-dated — must NOT contribute to any aggregate.
            { grams: 999, date: future, source: "manual", jobId: null },
          ],
        },
      ],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    // Future entry excluded from totals + per-filament + per-vendor +
    // manualEntries — every aggregate agrees.
    expect(body.totals.grams).toBe(10);
    expect(body.totals.manualEntries).toBe(1);
    expect(body.byFilament).toHaveLength(1);
    expect(body.byFilament[0].grams).toBe(10);
    expect(body.byVendor.find((v: { vendor: string }) => v.vendor === "V")?.grams).toBe(10);
    // usageByDay sums to the same total. Any future-dated day (past the
    // window) would be absent from the seeded key set.
    const chartSum = body.usageByDay.reduce(
      (s: number, d: { grams: number }) => s + d.grams,
      0,
    );
    expect(chartSum).toBe(10);
  });

  /**
   * Future-dated PrintHistory row (bad slicer clock / mis-imported)
   * end-to-end. The sibling test above only exercises the manual-usage
   * loop (`spools[].usageHistory` with `source: "manual"`); this one
   * covers the PrintHistory-side round-trip via `PH.create` +
   * `PrintHistory.find`. Seeds a `printerId` on both rows so the
   * `byPrinter` and `byVendor` aggregates are also stressed — a
   * regression that reordered aggregation to accumulate before the
   * future-date guard would show up in EVERY aggregate here, not just
   * `totals.grams`.
   *
   * NB: this test alone does NOT discriminate the DB filter
   * (`startedAt: { $lte: now }` at route.ts:49) from the JS guard
   * (`entryDate > now` at route.ts:224). Under the DB filter alone the
   * future row is dropped server-side; under the JS guard alone it's
   * fetched then skipped in-loop. Both produce the same observable
   * result here. The FOLLOWING test (`… JS-side guard in isolation`)
   * bypasses the DB via a `PrintHistory.find` spy and pins the JS
   * guard on its own so a future "cleanup" that removes the
   * belt-and-suspenders in-code guard is caught by CI.
   */
  it("skips future-dated PrintHistory rows from every aggregate (end-to-end)", async () => {
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
    const P = mongoose.models.Printer;

    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const fil = await F.create({
      name: "PH Bad Clock PLA",
      vendor: "V",
      type: "PLA",
      color: "#020202",
    });
    const printer = await P.create({
      name: "PH Test Printer",
      manufacturer: "M",
      printerModel: "T-1",
    });

    // Real, in-window job — should count everywhere.
    await PH.create({
      jobLabel: "in-window job",
      startedAt: recent,
      printerId: printer._id,
      usage: [{ filamentId: fil._id, grams: 20 }],
    });
    // Future-dated job — MUST be excluded from every aggregate,
    // including byPrinter and byVendor.
    await PH.create({
      jobLabel: "future-dated job",
      startedAt: future,
      printerId: printer._id,
      usage: [{ filamentId: fil._id, grams: 500 }],
    });

    const res = await getAnalytics(new NextRequest("http://localhost/api/analytics?days=30"));
    const body = await res.json();
    // totals.jobs counts PrintHistory rows returned from the DB — with
    // the $lte: now filter, only the in-window row makes it through.
    expect(body.totals.jobs).toBe(1);
    expect(body.totals.grams).toBe(20);
    expect(body.byFilament).toHaveLength(1);
    expect(body.byFilament[0].grams).toBe(20);
    // byVendor and byPrinter aggregates: both must sum to 20g, NOT
    // 520g — the 500g future-dated segment is excluded EVERYWHERE.
    const vendorRow = body.byVendor.find(
      (v: { vendor: string }) => v.vendor === "V",
    );
    expect(vendorRow?.grams).toBe(20);
    expect(body.byPrinter).toHaveLength(1);
    expect(body.byPrinter[0].grams).toBe(20);
    const chartSum = body.usageByDay.reduce(
      (s: number, d: { grams: number }) => s + d.grams,
      0,
    );
    expect(chartSum).toBe(20);
  });

  /**
   * JS-side future-date guard in isolation. The DB filter
   * `startedAt: { $lte: now }` is the front-line defense; the JS guard
   * at route.ts:225 (`if (entryDate > now) continue;`) is
   * belt-and-suspenders per the route comment ("in case the DB filter
   * is later relaxed or a row is synthesized in memory"). Every other
   * test in this file goes through `PH.create()` + the real DB query,
   * so the DB filter drops future rows before the JS guard is even
   * reachable — a partial revert that removes the JS guard would land
   * green in CI.
   *
   * This test spies on `PrintHistory.find` and returns a future-dated
   * row directly, bypassing the DB filter and pinning the JS guard on
   * its own. If a future refactor removes the `entryDate > now` guard
   * (perhaps as a "redundant" cleanup), this test trips.
   */
  it("skips future-dated PrintHistory rows via the JS-side guard alone (bypassing the DB filter)", async () => {
    // Grab the SAME PrintHistory reference the route holds. The route
    // does `import PrintHistory from "@/models/PrintHistory"` — Node
    // caches the module, so importing here returns the identical
    // `default` export. The shared `beforeEach` above deletes and
    // re-imports `mongoose.models.PrintHistory`, which can leave the
    // route's cached ref pointing at a different model instance than
    // `mongoose.models.PrintHistory` — spying on the latter would then
    // never intercept the route's calls. Spying on THIS reference
    // works regardless.
    const phMod = await import("@/models/PrintHistory");
    const PH = phMod.default;
    // Filament needs to be registered so PH.create's schema paths
    // resolve; same beforeEach caveat applies but PH's Filament ref
    // isn't the spy target.
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filMod.default.schema);
    }
    const F = mongoose.models.Filament;

    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const fil = await F.create({
      name: "PH Isolate Guard PLA",
      vendor: "IsoV",
      type: "PLA",
      color: "#030303",
    });

    // Seed one in-window row through the real DB path — the spy below
    // returns BOTH so the in-window baseline is real, but the future
    // row is force-injected past the DB filter.
    const inWindowRow = await PH.create({
      jobLabel: "iso in-window",
      startedAt: recent,
      usage: [{ filamentId: fil._id, grams: 30 }],
    });

    // Synthesize the future-dated row — this mirrors "a row synthesized
    // in memory" from the route comment.
    const syntheticFuture = {
      _id: new mongoose.Types.ObjectId(),
      _deletedAt: null,
      jobLabel: "iso future-dated (bypasses DB filter)",
      startedAt: future,
      printerId: null,
      // The route calls `populate("usage.filamentId", "…")` on the
      // query — the spy returns a chain that produces a POPULATED
      // shape so downstream `u.filamentId._id` reads work. Match the
      // real filament so the aggregation attempts to count it.
      usage: [
        {
          filamentId: {
            _id: fil._id,
            name: fil.name,
            vendor: fil.vendor,
            cost: fil.cost ?? null,
            parentId: null,
            color: fil.color,
            secondaryColors: [],
          },
          grams: 999,
        },
      ],
    };

    // Populate the in-window row the same way so the shape matches.
    const populatedInWindow = {
      ...inWindowRow.toObject(),
      usage: [
        {
          filamentId: {
            _id: fil._id,
            name: fil.name,
            vendor: fil.vendor,
            cost: fil.cost ?? null,
            parentId: null,
            color: fil.color,
            secondaryColors: [],
          },
          grams: 30,
        },
      ],
    };

    // Chain: PrintHistory.find(...).populate(...).populate(...).lean().
    // The route also awaits Promise.all so we need to return a thenable
    // for the terminal .lean() step.
    const chain = {
      populate: () => chain,
      lean: async () => [populatedInWindow, syntheticFuture],
    };
    const findSpy = vi
      .spyOn(PH, "find")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValueOnce(chain as any);

    try {
      const res = await getAnalytics(
        new NextRequest("http://localhost/api/analytics?days=30"),
      );
      const body = await res.json();
      // totals.jobs is now incremented ONLY for rows that pass the JS
      // guards (Codex P2 on PR #936), so the spy's future row is
      // excluded from the count too. This is what pins that the JS
      // guard actually skipped the row rather than silently letting it
      // through — if the guard were removed, `jobs` would become 2 AND
      // the aggregate grams below would balloon.
      expect(body.totals.jobs).toBe(1);
      // The JS guard drops the 999g future row. Without it,
      // totals.grams would be 30 + 999 = 1029.
      expect(body.totals.grams).toBe(30);
      // byFilament reflects the single in-window contribution.
      expect(body.byFilament).toHaveLength(1);
      expect(body.byFilament[0].grams).toBe(30);
      // byVendor also excludes the future row.
      const vendorRow = body.byVendor.find(
        (v: { vendor: string }) => v.vendor === "IsoV",
      );
      expect(vendorRow?.grams).toBe(30);
      // Chart sum agrees.
      const chartSum = body.usageByDay.reduce(
        (s: number, d: { grams: number }) => s + d.grams,
        0,
      );
      expect(chartSum).toBe(30);
    } finally {
      findSpy.mockRestore();
    }
  });

  /**
   * Fractional `days` input. The route accepts any finite number via
   * `Number(searchParams.get("days"))`, clamps to [7, 365], then floors.
   * Pre-fix: without the floor, a fractional input like `?days=30.9`
   * left `since = now - 30.9d` while the seed loop `for (i = 0; i <=
   * days; i++)` covered only integer i, stopping at `since + 30d` —
   * 0.9d before now. Today's `dayKey` had no bucket, so today's usage
   * silently dropped from `usageByDay` while `totals.grams` /
   * `byFilament` still counted it (Codex P3 on PR #936).
   *
   * Post-fix: `Math.floor(days)` after the clamp, so the seed range
   * and the query range end on the same UTC calendar day, and today's
   * usage lands in a real bucket.
   */
  it("coerces fractional ?days= to an integer so today's usage isn't dropped from the chart", async () => {
    const today = new Date();
    await Filament.create({
      name: "Fractional Days PLA",
      vendor: "V",
      type: "PLA",
      color: "#040404",
      spools: [
        {
          label: "main",
          totalWeight: 950,
          usageHistory: [{ grams: 7, date: today, source: "manual", jobId: null }],
        },
      ],
    });

    // ?days=30.9 — pre-fix: today's dayKey missing from seed → usage
    // silently dropped from chart while totals still count 7 g.
    const res = await getAnalytics(
      new NextRequest("http://localhost/api/analytics?days=30.9"),
    );
    const body = await res.json();
    expect(body.totals.grams).toBe(7);
    const chartSum = body.usageByDay.reduce(
      (s: number, d: { grams: number }) => s + d.grams,
      0,
    );
    // Post-fix: chart and totals agree; today's bucket exists.
    expect(chartSum).toBe(7);
    // days coerced to 30 → 31 daily buckets in the seed.
    expect(body.days).toBe(30);
    expect(body.usageByDay).toHaveLength(31);
  });
});
