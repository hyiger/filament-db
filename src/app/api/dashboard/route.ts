import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { resolveFilament } from "@/lib/resolveFilament";

/**
 * GET /api/dashboard — aggregate summary for the dashboard page.
 *
 * Heavy-enough to warrant a single endpoint rather than five client fetches.
 * Everything is computed server-side so the dashboard renders in one round
 * trip with stable numbers (no drift between counts and totals).
 */
export async function GET() {
  try {
    await dbConnect();

    const [
      filaments,
      nozzleCount,
      printerCount,
      bedTypeCount,
      recentPrintHistory,
    ] = await Promise.all([
      Filament.find({ _deletedAt: null }).lean(),
      Nozzle.countDocuments({ _deletedAt: null }),
      Printer.countDocuments({ _deletedAt: null }),
      BedType.countDocuments({ _deletedAt: null }),
      PrintHistory.find({ _deletedAt: null })
        .sort({ startedAt: -1 })
        .limit(10)
        .populate("printerId", "name")
        .lean(),
    ]);

    const filamentCount = filaments.length;
    let totalGrams = 0;
    let spoolCount = 0;
    let retiredSpools = 0;
    const lowStock: {
      _id: string;
      name: string;
      vendor: string;
      color: string;
      remainingGrams: number;
      threshold: number;
    }[] = [];

    for (const f of filaments) {
      let remaining = 0;
      for (const s of f.spools || []) {
        if (s.retired) {
          retiredSpools++;
          continue;
        }
        spoolCount++;
        if (typeof s.totalWeight === "number") {
          remaining += s.totalWeight;
        }
      }
      totalGrams += remaining;
      if (
        typeof f.lowStockThreshold === "number" &&
        f.lowStockThreshold > 0 &&
        remaining < f.lowStockThreshold
      ) {
        lowStock.push({
          _id: String(f._id),
          name: f.name,
          vendor: f.vendor,
          color: f.color,
          remainingGrams: remaining,
          threshold: f.lowStockThreshold,
        });
      }
    }

    // Spools due for a dry cycle — no dry cycle in the last 30 days and the
    // filament needs drying. A variant with no own dryingTemperature must
    // inherit from its parent; pre-v1.12.5 this branch only checked the
    // variant's own field, so child filaments with inherited drying values
    // were silently skipped (GH #133).
    const parentMap = new Map<string, (typeof filaments)[number]>();
    for (const f of filaments) {
      if (!f.parentId) parentMap.set(f._id.toString(), f);
    }
    const now = Date.now();
    const dryThresholdMs = 30 * 24 * 60 * 60 * 1000;
    const dryDue: {
      filamentId: string;
      filamentName: string;
      spoolId: string;
      spoolLabel: string;
      lastDried: string | null;
    }[] = [];
    for (const f of filaments) {
      const resolved = f.parentId
        ? resolveFilament(f, parentMap.get(f.parentId.toString()))
        : f;
      if (typeof resolved.dryingTemperature !== "number") continue;
      for (const s of f.spools || []) {
        if (s.retired) continue;
        const cycles = s.dryCycles || [];
        const lastCycle = cycles.length > 0 ? cycles[cycles.length - 1].date : null;
        const lastCycleMs = lastCycle ? new Date(lastCycle).getTime() : 0;
        if (now - lastCycleMs > dryThresholdMs) {
          dryDue.push({
            filamentId: String(f._id),
            filamentName: f.name,
            spoolId: String(s._id),
            spoolLabel: s.label || "",
            lastDried: lastCycle ? new Date(lastCycle).toISOString() : null,
          });
        }
      }
    }

    return NextResponse.json({
      counts: {
        filaments: filamentCount,
        nozzles: nozzleCount,
        printers: printerCount,
        bedTypes: bedTypeCount,
        spools: spoolCount,
        retiredSpools,
        // Active + retired. The "Active Spools" tile renders `spools`; the
        // "(N retired)" hint renders when `retiredSpools > 0`. Surfacing
        // the total here means a future tooltip / breakdown can show it
        // without re-deriving the sum on the client (GH #166).
        totalSpools: spoolCount + retiredSpools,
      },
      totalGrams,
      lowStock,
      dryDue: dryDue.slice(0, 20), // cap so the dashboard stays readable
      recentPrintHistory: recentPrintHistory.map((h) => ({
        _id: String(h._id),
        jobLabel: h.jobLabel,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        printerName: (h.printerId as any)?.name ?? null,
        startedAt:
          h.startedAt instanceof Date
            ? h.startedAt.toISOString()
            : String(h.startedAt),
        source: h.source,
        totalGrams: (h.usage || []).reduce(
          (sum: number, u: { grams: number }) => sum + u.grams,
          0,
        ),
      })),
    });
  } catch (err) {
    return errorResponse("Failed to build dashboard", 500, getErrorMessage(err));
  }
}
