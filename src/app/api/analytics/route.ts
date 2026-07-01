import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { displayColor } from "@/lib/filamentColors";

/**
 * GET /api/analytics?days=30 — usage analytics aggregation.
 *
 * Uses PrintHistory as the source of truth (slicer-driven, aggregated
 * per-job); falls back to per-spool `usageHistory` for entries the user
 * logged directly on a spool without a job.
 *
 * `days` is floored after clamping — a fractional value like `?days=30.9`
 * would leave today's `dayKey` unseeded (the seed loop walks integer
 * `i`), so today's usage would land in `dayBucket === undefined` and
 * vanish from the chart while still counting in totals (#936).
 *
 * Future-dated entries are excluded from every aggregate at both the DB
 * (`$lte: now`) and JS layer so the chart, headline, and per-filament
 * tables agree on the day-of-window boundary (#936).
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();
    const rawDays = Number(request.nextUrl.searchParams.get("days") ?? "30");
    const days = Math.floor(
      Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 30, 7), 365),
    );
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [history, filaments] = await Promise.all([
      PrintHistory.find({
        _deletedAt: null,
        startedAt: { $gte: since, $lte: now },
      })
        .populate("printerId", "name")
        // GH #223 + #934: parentId for cost/color inheritance,
        // color/secondaryColors for the stacked-chart hex.
        .populate("usage.filamentId", "name vendor cost parentId color secondaryColors")
        .lean(),
      Filament.find({ _deletedAt: null })
        .select("name vendor cost parentId color secondaryColors spools")
        .lean(),
    ]);

    // GH #223 + #934: build parent-cost + parent-color lookups so
    // variant→parent inheritance resolves in-loop without per-row queries.
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
    const parentColorMap = new Map<
      string,
      { color: string | null; secondaryColors: string[] }
    >();
    if (parentIdSet.size > 0) {
      // No `_deletedAt` filter — a trashed variant's still-trashed parent
      // is still the right answer for a historical job that consumed it.
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
     * GH #934 + #936: chart-segment color, matching `resolveFilament`'s
     * `VARIANT_ONLY_FIELDS` contract — a variant's `color` is used as-is,
     * NEVER inherited from its parent (which would diverge from every
     * list / detail / export path). Only `secondaryColors` inherits, via
     * the array-fallback rule (GH #477). Cached per fid because a busy
     * window can have 200+ usage rows for one variant.
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
          color = displayColor(own);
        }
      } else {
        color = displayColor(own);
      }
      colorByFid.set(fid, color);
      return color;
    }

    // Per-day breakdown by filament for the stacked chart. Outer key
    // YYYY-MM-DD, inner keyed on fid. `grams` stays RAW so sub-0.5g
    // entries survive the no-data check; rounded at emission (#934).
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
    // `jobs` counts only rows that pass the JS guards below, so the
    // headline agrees with every other aggregate (#936).
    let jobs = 0;
    // GH #204: spool-side `usageHistory` entries with `source: "manual"`
    // count toward grams + cost but aren't PrintHistory rows — surface
    // separately so the "Grams used" total is attributable.
    let manualEntries = 0;

    for (let i = 0; i <= days; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      byDayFilament.set(key, new Map());
    }

    for (const entry of history) {
      const entryDate = new Date(entry.startedAt);
      // GH #269: malformed startedAt (bad import / snapshot restore /
      // legacy PrintHistory bug) — `.toISOString()` on Invalid Date
      // throws. Skip. Ordered BEFORE the `> now` check so a NaN row
      // can't slip through (`NaN > now` is always false).
      if (Number.isNaN(entryDate.getTime())) continue;
      // Belt-and-suspenders with the DB filter (#936).
      if (entryDate > now) continue;
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
        const cost = resolveCost(fdoc?.cost ?? null, fdoc?.parentId);
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

    // Manual per-spool usage entries (source: "manual") not backed by a
    // PrintHistory row. Job/slicer entries would double-count against the
    // loop above.
    for (const f of filaments) {
      for (const s of f.spools || []) {
        for (const u of s.usageHistory || []) {
          const uDate = new Date(u.date as unknown as string | Date);
          if (Number.isNaN(uDate.getTime())) continue;
          if (uDate < since) continue;
          if (uDate > now) continue;
          if (u.source !== "manual") continue;
          const dayKey = uDate.toISOString().slice(0, 10);
          const fCost = resolveCost(f.cost ?? null, f.parentId);
          const fid = String(f._id);
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

    // Emit each day with its per-filament breakdown for the stacked
    // chart. Two invariants (#934, #936):
    //   1. `day.grams === Math.round(rawDaySum)` — sub-0.5g entries
    //      that round to 0 individually still contribute to the day
    //      total, so the no-data check can't hide them.
    //   2. `day.grams === Σ byFilament[].grams` — Hamilton's
    //      largest-remainder method distributes the day total to the
    //      segments so their sum matches by construction, even in the
    //      pathological 4×0.49g → day=2g / segments=[1,1,0,0] case.
    //  Tie-break: largest fractional remainder, then largest raw grams.
    //  byFilament pre-sorted DESC so the largest contributor renders
    //  at the bottom of the stack; client doesn't re-sort.
    const usageByDay = Array.from(byDayFilament.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, dayBucket]) => {
        const rawEntries = Array.from(dayBucket.entries())
          .filter(([, v]) => v.grams > 0)
          .map(([id, v]) => ({ id, name: v.name, color: v.color, raw: v.grams }));
        const rawDaySum = rawEntries.reduce((s, e) => s + e.raw, 0);
        const dayGrams = Math.round(rawDaySum);
        const apportioned = rawEntries.map((e) => {
          const ideal = rawDaySum > 0 ? (e.raw / rawDaySum) * dayGrams : 0;
          const floor = Math.floor(ideal);
          return { ...e, grams: floor, frac: ideal - floor };
        });
        const deficit =
          dayGrams - apportioned.reduce((s, e) => s + e.grams, 0);
        // Sort holds the same object refs so `.grams++` mutates
        // `apportioned` too.
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

    // Top-N rankings — round-of-sum over the window so a filament that
    // used 30.4g reads as 30g regardless of daily rounding luck. These
    // can drift by up to N/2g from Σ across days of that fid's chart
    // segments in the sub-0.5g/day pathological case (documented
    // trade-off #936: ranking accuracy vs cross-day segment-sum parity).
    // byPrinter excludes jobs without a `printerId` by design — "how
    // much did each printer print" ≠ "how much did all jobs use".
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
