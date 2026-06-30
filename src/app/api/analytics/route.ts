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
    const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 30, 7), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [history, filaments] = await Promise.all([
      PrintHistory.find({ _deletedAt: null, startedAt: { $gte: since } })
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
     * segment with. Mirrors `resolveCost`'s variant→parent inheritance
     * pattern but routes through `displayColor()` so coextruded
     * filaments (null primary) fall through to `secondaryColors[0]`.
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
      if (ownHasPrimary || ownHasSecondary) color = displayColor(own);
      else if (parentId && parentColorMap.has(String(parentId)))
        color = displayColor(parentColorMap.get(String(parentId))!);
      else color = displayColor(own); // falls through to "#808080" sentinel
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
      if (Number.isNaN(entryDate.getTime())) continue;
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
    // stacked chart. Sort byFilament descending so the largest contributor
    // renders at the BOTTOM of the stack — the client doesn't re-sort.
    //
    // The day total is derived from the RAW running sum (round-of-sum) so
    // sub-0.5g entries — which round to 0 individually — don't collapse
    // the day to 0g and disappear from the no-data check while still
    // contributing to `totals.grams` (Codex P2). Segments are emitted as
    // rounded grams for display but kept whenever their raw contribution
    // is positive, so a rounded-zero segment still appears in the legend
    // and the tooltip rather than being silently dropped.
    const usageByDay = Array.from(byDayFilament.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, dayBucket]) => {
        let rawDaySum = 0;
        const byFil = Array.from(dayBucket.entries())
          .filter(([, v]) => v.grams > 0)
          .map(([id, v]) => {
            rawDaySum += v.grams;
            return {
              id,
              name: v.name,
              color: v.color,
              grams: Math.round(v.grams),
            };
          })
          .sort((a, b) => b.grams - a.grams);
        return { date, grams: Math.round(rawDaySum), byFilament: byFil };
      });

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
        jobs: history.length,
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
