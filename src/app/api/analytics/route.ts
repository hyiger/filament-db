import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/analytics?days=30 — usage analytics aggregation.
 *
 * Returns:
 *   - usageByDay:   per-day total grams (for the bar chart)
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
        .populate("usage.filamentId", "name vendor cost")
        .lean(),
      Filament.find({ _deletedAt: null })
        .select("name vendor cost spools")
        .lean(),
    ]);

    // Build usageByDay bucket. Date key = YYYY-MM-DD in UTC for stability.
    const byDay = new Map<string, number>();
    const byFilament = new Map<
      string,
      { name: string; vendor: string; cost: number | null; grams: number }
    >();
    const byVendor = new Map<string, number>();
    const byPrinter = new Map<string, { name: string; grams: number }>();
    let totalGrams = 0;
    let totalCost = 0;

    // Seed all days in the window with 0 so the chart has no gaps.
    for (let i = 0; i <= days; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      byDay.set(d.toISOString().slice(0, 10), 0);
    }

    for (const entry of history) {
      const dayKey = new Date(entry.startedAt).toISOString().slice(0, 10);
      byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + sumGrams(entry.usage));
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
          ? (u.filamentId as { name?: string; vendor?: string; cost?: number | null })
          : null;
        const name = fdoc?.name ?? "(unknown)";
        const vendor = fdoc?.vendor ?? "(unknown)";
        const cost = fdoc?.cost ?? null;
        const existing = byFilament.get(fid);
        if (existing) existing.grams += u.grams;
        else byFilament.set(fid, { name, vendor, cost, grams: u.grams });
        byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + u.grams);
        totalGrams += u.grams;
        if (cost != null) totalCost += (u.grams / 1000) * cost;
      }

      if (printerId) {
        const existing = byPrinter.get(printerId);
        if (existing) existing.grams += sumGrams(entry.usage);
        else byPrinter.set(printerId, { name: printerName, grams: sumGrams(entry.usage) });
      }
    }

    // Also incorporate per-spool manual usage entries that don't have a
    // matching PrintHistory record — users who log usage directly on a
    // spool shouldn't disappear from analytics.
    for (const f of filaments) {
      for (const s of f.spools || []) {
        for (const u of s.usageHistory || []) {
          const uDate = new Date(u.date as unknown as string | Date);
          if (uDate < since) continue;
          // Skip slicer-sourced entries; those are already counted via PrintHistory.
          if (u.source !== "manual") continue;
          const dayKey = uDate.toISOString().slice(0, 10);
          byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + u.grams);
          const existing = byFilament.get(String(f._id));
          if (existing) existing.grams += u.grams;
          else
            byFilament.set(String(f._id), {
              name: f.name,
              vendor: f.vendor,
              cost: f.cost ?? null,
              grams: u.grams,
            });
          byVendor.set(f.vendor, (byVendor.get(f.vendor) ?? 0) + u.grams);
          totalGrams += u.grams;
          if (f.cost != null) totalCost += (u.grams / 1000) * f.cost;
        }
      }
    }

    const usageByDay = Array.from(byDay.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, grams]) => ({ date, grams: Math.round(grams) }));

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
