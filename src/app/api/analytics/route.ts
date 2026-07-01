import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { displayColor } from "@/lib/filamentColors";

/**
 * GET /api/analytics?days=30 — usage analytics aggregation.
 *
 * Returns:
 *   - usageByDay:   per-day total grams + per-filament breakdown for the
 *                   stacked bar chart (GH #934). Each `byFilament` entry
 *                   carries `{ id, name, color, grams }`, sorted desc by
 *                   grams so the bottom of the stack is the largest
 *                   contributor. The day's top-level `grams` equals the
 *                   sum of `byFilament[].grams` after rounding.
 *   - byFilament:   total grams and cost per filament, sorted desc
 *   - byVendor:     total grams per vendor
 *   - byPrinter:    total grams per printer (only printed jobs)
 *   - totals:       summary across the window
 *
 * Uses PrintHistory as the source of truth (slicer-driven) because it's
 * already aggregated per-job and timestamps; falls back to per-spool
 * usageHistory for older data points the user logged manually on a spool
 * that wasn't tied to a job.
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();
    const rawDays = Number(request.nextUrl.searchParams.get("days") ?? "30");
    // Codex P3 on PR #936: `Math.floor` after the clamp — a fractional
    // input like `?days=30.9` would compute `since = now - 30.9d` but
    // the seed loop `for (i = 0; i <= days; i++)` walks integer i only,
    // so it stops at `since + Math.floor(days) UTC-days` = 30 days
    // forward = 0.9d before now. Today's `dayKey` then has no bucket
    // and any in-window usage today lands in `dayBucket === undefined`
    // → the segment code path silently skips it while totals still
    // count it. Flooring keeps the seed range and the query range on
    // the same day-of-window boundary.
    const days = Math.floor(
      Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 30, 7), 365),
    );
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    // Codex P3 on PR #936: entries with a future timestamp (bad client
    // clock, snapshot import) get counted in totals / byFilament /
    // byVendor but silently dropped from usageByDay because no bucket
    // exists past `now` in the seed. Bound every aggregate at `now` so
    // the chart, headline, and top-filament tables never disagree on
    // the day-of-window boundary.

    const [history, filaments] = await Promise.all([
      PrintHistory.find({
        _deletedAt: null,
        // Codex P3 on PR #936: `$lte: now` on the DB side so future-dated
        // rows never reach the aggregation. The JS-side guard below is
        // belt-and-suspenders so the per-day-bucket invariant (every
        // dayKey has a seeded bucket in `byDayFilament`) holds even if
        // the DB filter is later relaxed or a row is synthesized in
        // memory (e.g. a test that hand-crafts a PrintHistory doc).
        startedAt: { $gte: since, $lte: now },
      })
        .populate("printerId", "name")
        // GH #223: include parentId + the bits we'll inherit (cost) so we
        // can resolve variant-inherited cost without a second round-trip.
        // Without this the populate returns the variant's own `cost`
        // (typically null on inheriting variants), so `totalCost` would
        // contribute 0 grams worth for every print job against a variant.
        // GH #934: also include color + secondaryColors so the stacked
        // chart can render each filament's segment in its real hex.
        .populate("usage.filamentId", "name vendor cost parentId color secondaryColors")
        .lean(),
      // Include `parentId` here as well so the manual-usage loop below can
      // walk inheritance. GH #934: + color/secondaryColors for the stack.
      Filament.find({ _deletedAt: null })
        .select("name vendor cost parentId color secondaryColors spools")
        .lean(),
    ]);

    // GH #223: build a parent-cost lookup so cost inheritance resolves
    // without per-row queries. Collect every unique `parentId` referenced
    // by either the populated PrintHistory.usage entries or the manual
    // spool loop, batch-fetch their costs, then expose a helper that
    // returns `variantCost ?? parentCost ?? null` for any filament shape.
    const parentIdSet = new Set<string>();
    for (const f of filaments) if (f.parentId) parentIdSet.add(String(f.parentId));
    for (const entry of history) {
      for (const u of entry.usage || []) {
        const populated = u.filamentId as { parentId?: unknown } | null;
        if (populated && typeof populated === "object" && populated.parentId) {
          parentIdSet.add(String(populated.parentId));
        }
      }
    }
    const parentCostMap = new Map<string, number | null>();
    // GH #934: parent color map mirrors the cost lookup so a variant that
    // leaves `color`/`secondaryColors` blank to inherit gets its parent's
    // palette resolved here, the same way `cost` already did.
    const parentColorMap = new Map<
      string,
      { color: string | null; secondaryColors: string[] }
    >();
    if (parentIdSet.size > 0) {
      // Parents are read-only here. A historical PrintHistory row whose
      // variant has since been trashed (its parent too) is still a real
      // job — resolving its color and cost from the on-disk parent gives
      // the right answer; filtering `_deletedAt: null` here would paint
      // the row with the "#808080" sentinel and zero out its cost.
      const parents = await Filament.find({
        _id: { $in: Array.from(parentIdSet) },
      })
        .select("_id cost color secondaryColors")
        .lean();
      for (const p of parents) {
        parentCostMap.set(String(p._id), (p.cost as number | null) ?? null);
        parentColorMap.set(String(p._id), {
          color: (p.color as string | null | undefined) ?? null,
          secondaryColors: Array.isArray(p.secondaryColors)
            ? (p.secondaryColors as string[])
            : [],
        });
      }
    }
    function resolveCost(
      ownCost: number | null | undefined,
      parentId: unknown,
    ): number | null {
      if (ownCost != null) return ownCost;
      if (!parentId) return null;
      return parentCostMap.get(String(parentId)) ?? null;
    }
    /**
     * GH #934: resolve the single hex color the chart should paint a
     * segment with. Mirrors `src/lib/resolveFilament.ts`'s inheritance
     * contract exactly:
     *
     *   - `color` is in `VARIANT_ONLY_FIELDS` — a variant's own primary
     *     color is used as-is; a blank-primary variant does NOT inherit
     *     the parent's primary color. Painting the parent's primary onto
     *     a variant here would diverge from every list, detail, and
     *     export path (Codex P2 on PR #936).
     *   - `secondaryColors` uses the array-fallback rule (GH #477): a
     *     variant with an empty array inherits the parent's whole array
     *     (through `displayColor()` that returns `secondaryColors[0]`
     *     when the primary is null).
     *   - Everything else falls through to the `"#808080"` sentinel,
     *     matching `displayColor()`'s standalone behaviour.
     *
     * Cached by filament id — the answer is deterministic per fid, and a
     * busy window can have 200+ usage rows for the same variant. Without
     * the cache the `Array.isArray` + length + `displayColor` +
     * `parentColorMap.get` work runs once per usage row instead of once
     * per filament.
     */
    const colorByFid = new Map<string, string>();
    function resolveColor(
      fid: string,
      own: { color?: string | null; secondaryColors?: string[] | null },
      parentId: unknown,
    ): string {
      const cached = colorByFid.get(fid);
      if (cached !== undefined) return cached;
      const ownHasPrimary = own.color != null && own.color !== "";
      const ownHasSecondary =
        Array.isArray(own.secondaryColors) && own.secondaryColors.length > 0;
      let color: string;
      if (ownHasPrimary || ownHasSecondary) {
        color = displayColor(own);
      } else if (parentId) {
        const parent = parentColorMap.get(String(parentId));
        // Inherit ONLY the parent's secondaryColors — not the parent's
        // primary `color` (variant-only per resolveFilament).
        if (
          parent &&
          Array.isArray(parent.secondaryColors) &&
          parent.secondaryColors.length > 0
        ) {
          color = displayColor({
            color: null,
            secondaryColors: parent.secondaryColors,
          });
        } else {
          color = displayColor(own); // falls through to "#808080" sentinel
        }
      } else {
        color = displayColor(own);
      }
      colorByFid.set(fid, color);
      return color;
    }

    // GH #934: per-day breakdown by filament for the stacked chart. Each
    // outer key is a YYYY-MM-DD; the inner map keys on filament id so a
    // job with multiple filaments lands in distinct stack segments.
    // `grams` is the RAW running total (fractional input is preserved so
    // sub-0.5g entries don't silently round to zero before the no-data
    // check) — segments and the day total are rounded at emission.
    const byDayFilament = new Map<
      string,
      Map<string, { name: string; color: string; grams: number }>
    >();
    const byFilament = new Map<
      string,
      { name: string; vendor: string; cost: number | null; grams: number }
    >();
    const byVendor = new Map<string, number>();
    const byPrinter = new Map<string, { name: string; grams: number }>();
    let totalGrams = 0;
    let totalCost = 0;
    // Codex P2 on PR #936: rows dropped by the JS guards below
    // (`Number.isNaN(entryDate.getTime())` — malformed startedAt;
    // `entryDate > now` — future-dated belt-and-suspenders) contribute
    // to `history.length` but NOT to any grams / cost / vendor / printer
    // / day aggregate. Emitting `history.length` as `totals.jobs` would
    // let the headline claim "N jobs" while every other aggregate has
    // no evidence of some of them. Count only rows that pass both
    // guards so the headline agrees with the rest of the response.
    let jobs = 0;
    // GH #204: per-spool `usageHistory` entries logged directly on the
    // spool UI (source: "manual") count toward grams + cost but are not
    // PrintHistory documents, so the existing `jobs` counter doesn't
    // include them. Surface a separate count so the user can attribute
    // the "Grams used" total — pre-fix the page showed `50 g · $1.10 ·
    // 0 jobs` with no hint that the 50 g came from a manual entry.
    let manualEntries = 0;

    // Seed all days in the window with 0 so the chart has no gaps.
    for (let i = 0; i <= days; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      byDayFilament.set(key, new Map());
    }

    for (const entry of history) {
      // GH #269: a malformed `startedAt` already in the DB (bad import,
      // snapshot restore, or the historical print-history bug) is an
      // Invalid Date — `.toISOString()` on it throws RangeError and 500s
      // the whole endpoint. Skip the offending row instead.
      const entryDate = new Date(entry.startedAt);
      // Malformed startedAt (bad import, snapshot restore, historical
      // print-history bug): `.toISOString()` on Invalid Date throws.
      // Ordered BEFORE the future-date check so `NaN > now` (always
      // false) can't accidentally let a NaN row through — the check
      // is symmetric today but this keeps intent readable.
      if (Number.isNaN(entryDate.getTime())) continue;
      // Codex P3 on PR #936: skip entries with a future timestamp so
      // usageByDay + totals stay in sync — the seed loop stops at `now`,
      // so a future dayKey wouldn't have a bucket and its grams would
      // vanish from the chart while still landing in totals/byFilament.
      if (entryDate > now) continue;
      // Codex P2 on PR #936: only count rows that pass BOTH guards so
      // `totals.jobs` agrees with every other aggregate. `history.length`
      // would over-report by the number of skipped rows.
      jobs += 1;
      const dayKey = entryDate.toISOString().slice(0, 10);
      const printerId =
        entry.printerId && typeof entry.printerId === "object"
          ? String((entry.printerId as { _id?: unknown })._id ?? "")
          : entry.printerId
            ? String(entry.printerId)
            : "";
      const printerName =
        entry.printerId && typeof entry.printerId === "object"
          ? ((entry.printerId as { name?: string }).name ?? "(unknown)")
          : "(unknown)";

      for (const u of entry.usage || []) {
        const fid = u.filamentId && typeof u.filamentId === "object"
          ? String((u.filamentId as { _id?: unknown })._id ?? "")
          : String(u.filamentId);
        const fdoc = u.filamentId && typeof u.filamentId === "object"
          ? (u.filamentId as {
              name?: string;
              vendor?: string;
              cost?: number | null;
              parentId?: unknown;
              color?: string | null;
              secondaryColors?: string[] | null;
            })
          : null;
        const name = fdoc?.name ?? "(unknown)";
        const vendor = fdoc?.vendor ?? "(unknown)";
        // GH #223: was `fdoc?.cost ?? null` — read the variant's own cost
        // directly and contributed 0 to totalCost for every job against
        // an inheriting variant. resolveCost falls back to the parent.
        const cost = resolveCost(fdoc?.cost ?? null, fdoc?.parentId);
        // GH #934: resolve color via variant→parent inheritance for the
        // stacked chart segment.
        const color = resolveColor(
          fid,
          { color: fdoc?.color ?? null, secondaryColors: fdoc?.secondaryColors ?? null },
          fdoc?.parentId,
        );
        const existing = byFilament.get(fid);
        if (existing) existing.grams += u.grams;
        else byFilament.set(fid, { name, vendor, cost, grams: u.grams });
        byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + u.grams);
        totalGrams += u.grams;
        if (cost != null) totalCost += (u.grams / 1000) * cost;
        // GH #934: per-day-per-filament bucket for the stacked chart.
        const dayBucket = byDayFilament.get(dayKey);
        if (dayBucket) {
          const fEntry = dayBucket.get(fid);
          if (fEntry) fEntry.grams += u.grams;
          else dayBucket.set(fid, { name, color, grams: u.grams });
        }
      }

      if (printerId) {
        const existing = byPrinter.get(printerId);
        if (existing) existing.grams += sumGrams(entry.usage);
        else byPrinter.set(printerId, { name: printerName, grams: sumGrams(entry.usage) });
      }
    }

    // Also incorporate per-spool manual usage entries that don't have a
    // matching PrintHistory record — users who log usage directly on a
    // spool (not through /api/print-history) shouldn't disappear from
    // analytics.
    for (const f of filaments) {
      for (const s of f.spools || []) {
        for (const u of s.usageHistory || []) {
          const uDate = new Date(u.date as unknown as string | Date);
          // GH #269: skip a malformed usageHistory date — `NaN < since`
          // is false, so without this check the entry slips through to
          // `uDate.toISOString()` below and throws RangeError.
          if (Number.isNaN(uDate.getTime())) continue;
          if (uDate < since) continue;
          // Codex P3 on PR #936: same future-timestamp cap as the
          // PrintHistory loop above — keep usageByDay and the aggregates
          // consistent on the day-of-window boundary.
          if (uDate > now) continue;
          // Only "manual" means "logged directly on the spool UI without a
          // PrintHistory record". "job" and "slicer" entries are owned by a
          // PrintHistory row and already counted in the first loop above;
          // including them here would double-count the same grams.
          if (u.source !== "manual") continue;
          const dayKey = uDate.toISOString().slice(0, 10);
          // GH #223: same fix as the PrintHistory loop above — fall back
          // to the parent's cost when the variant inherits.
          const fCost = resolveCost(f.cost ?? null, f.parentId);
          const fid = String(f._id);
          // GH #934: same variant→parent inheritance for color.
          const fColor = resolveColor(
            fid,
            { color: f.color ?? null, secondaryColors: f.secondaryColors ?? null },
            f.parentId,
          );
          const existing = byFilament.get(fid);
          if (existing) existing.grams += u.grams;
          else
            byFilament.set(fid, {
              name: f.name,
              vendor: f.vendor,
              cost: fCost,
              grams: u.grams,
            });
          byVendor.set(f.vendor, (byVendor.get(f.vendor) ?? 0) + u.grams);
          totalGrams += u.grams;
          if (fCost != null) totalCost += (u.grams / 1000) * fCost;
          // GH #934: per-day-per-filament bucket for the stacked chart.
          const dayBucket = byDayFilament.get(dayKey);
          if (dayBucket) {
            const fEntry = dayBucket.get(fid);
            if (fEntry) fEntry.grams += u.grams;
            else dayBucket.set(fid, { name: f.name, color: fColor, grams: u.grams });
          }
          manualEntries++;
        }
      }
    }

    // GH #934: emit each day with its per-filament breakdown for the
    // stacked chart. Two invariants tie the chart, the headline, and
    // the segments together:
    //
    //   1. `day.grams === Math.round(rawDaySum)` — sub-0.5g entries
    //      that individually round to 0 still contribute to the day
    //      total, so the no-data check (`every(d => d.grams === 0)`)
    //      doesn't silently hide a day whose usage is only counted in
    //      `totals.grams` (the Codex P2 concern on PR #936).
    //
    //   2. `day.grams === Σ byFilament[].grams` — the sum of the
    //      displayed segments equals the day total exactly, so the
    //      day-level tooltip and the per-segment tooltips can never
    //      disagree and a visibly-tall bar can never render as
    //      zero-height segments internally. This holds even in the
    //      pathological case (e.g. 4 segments at 0.49g → day = 2g,
    //      segments sum to 2g via largest-remainder distribution),
    //      which round-independently would have produced day = 2g
    //      with all segments = 0g.
    //
    // The apportionment is Hamilton's largest-remainder method: each
    // segment gets its proportional floor of `day.grams`, then the
    // deficit is distributed one unit at a time to the segments with
    // the largest fractional remainders, tie-breaking by raw grams
    // descending for determinism. Segments are then sorted DESC so
    // the largest contributor renders at the BOTTOM of the stack —
    // the client doesn't re-sort.
    const usageByDay = Array.from(byDayFilament.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, dayBucket]) => {
        const rawEntries = Array.from(dayBucket.entries())
          .filter(([, v]) => v.grams > 0)
          .map(([id, v]) => ({ id, name: v.name, color: v.color, raw: v.grams }));
        const rawDaySum = rawEntries.reduce((s, e) => s + e.raw, 0);
        const dayGrams = Math.round(rawDaySum);
        // Floor + fractional remainder per segment.
        const apportioned = rawEntries.map((e) => {
          const ideal = rawDaySum > 0 ? (e.raw / rawDaySum) * dayGrams : 0;
          const floor = Math.floor(ideal);
          return { ...e, grams: floor, frac: ideal - floor };
        });
        const deficit =
          dayGrams - apportioned.reduce((s, e) => s + e.grams, 0);
        // Distribute the deficit by largest fractional remainder,
        // breaking ties by raw grams desc so the largest contributor
        // gets rounded up first. Sort holds the same object refs so
        // `.grams++` mutates the entry in `apportioned` too.
        const byFrac = [...apportioned].sort(
          (a, b) => b.frac - a.frac || b.raw - a.raw,
        );
        for (let i = 0; i < deficit && i < byFrac.length; i++) {
          byFrac[i].grams += 1;
        }
        const byFil = apportioned
          .map(({ id, name, color, grams }) => ({ id, name, color, grams }))
          .sort((a, b) => b.grams - a.grams);
        return { date, grams: dayGrams, byFilament: byFil };
      });

    // GH #934: per-filament / vendor / printer totals are ROUND-OF-SUM
    // over the raw grams accumulated across the window — the "biggest
    // consumers" ranking wants the truest possible window total. The
    // stacked chart's per-day segments are Hamilton-apportioned integers
    // that sum to `day.grams` per day (see the usageByDay emission
    // above). These two views can drift by up to N/2 grams over N days
    // in the pathological case of sub-0.5g-per-day usage on the same
    // filament — a user who mentally sums chart segments across the
    // window won't get exactly the sidebar total.
    //
    // Trade-off: round-of-sum here keeps top-filament totals honest at
    // window scale (a filament that used 30.4g reads as 30g, not 28g /
    // 32g depending on daily rounding luck); the chart's per-day
    // Hamilton invariant makes each day's stack visually consistent
    // (Σ segments === day.grams). Both invariants can't hold at once —
    // this shape prioritises the ranking's accuracy over cross-day
    // segment-sum equality with the sidebar total.
    //
    // `byPrinter` intentionally excludes jobs without a `printerId` —
    // "By printer" answers "how much did each printer print", not
    // "how much did all jobs use", so an unattributed job legitimately
    // isn't in any printer's total. Σ byPrinter[].grams ≤ totals.grams
    // by design.
    const byFilamentArr = Array.from(byFilament.entries())
      .map(([id, v]) => ({ _id: id, ...v, grams: Math.round(v.grams) }))
      .sort((a, b) => b.grams - a.grams);

    const byVendorArr = Array.from(byVendor.entries())
      .map(([vendor, grams]) => ({ vendor, grams: Math.round(grams) }))
      .sort((a, b) => b.grams - a.grams);

    const byPrinterArr = Array.from(byPrinter.entries())
      .map(([id, v]) => ({ _id: id, name: v.name, grams: Math.round(v.grams) }))
      .sort((a, b) => b.grams - a.grams);

    return NextResponse.json({
      since: since.toISOString(),
      days,
      totals: {
        grams: Math.round(totalGrams),
        cost: Math.round(totalCost * 100) / 100,
        jobs,
        manualEntries,
      },
      usageByDay,
      byFilament: byFilamentArr,
      byVendor: byVendorArr,
      byPrinter: byPrinterArr,
    });
  } catch (err) {
    return errorResponse("Failed to build analytics", 500, getErrorMessage(err));
  }
}

function sumGrams(usage: { grams: number }[] | undefined): number {
  return (usage || []).reduce((sum, u) => sum + u.grams, 0);
}
