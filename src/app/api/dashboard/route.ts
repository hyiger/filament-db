import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { resolveFilament } from "@/lib/resolveFilament";
import { displayColor } from "@/lib/filamentColors";
import { sumUsageGrams } from "@/lib/capUsageHistory";

/** How many dry-due spools the dashboard panel lists. The response also
 *  carries `dryDueTotal`, the uncapped count (#1117(b)). */
const DRY_DUE_LIMIT = 20;

/**
 * GH #1078: the low-stock swatch color must follow `resolveFilament`'s
 * contract, exactly like the analytics route's `resolveColor` — a variant's
 * `color` is VARIANT-ONLY and never inherited; only `secondaryColors`
 * inherits, via the whole-array fallback rule (GH #477). A bare
 * `displayColor(f)` paints the gray sentinel for a blank-primary variant
 * whose parent carries `secondaryColors`.
 */
function lowStockSwatchColor(
  own: { color?: string | null; secondaryColors?: string[] | null },
  parent: { secondaryColors?: string[] | null } | undefined,
): string {
  const ownHasPrimary = own.color != null && own.color !== "";
  const ownHasSecondary =
    Array.isArray(own.secondaryColors) && own.secondaryColors.length > 0;
  if (
    !ownHasPrimary &&
    !ownHasSecondary &&
    parent &&
    Array.isArray(parent.secondaryColors) &&
    parent.secondaryColors.length > 0
  ) {
    return displayColor({ color: null, secondaryColors: parent.secondaryColors });
  }
  return displayColor(own);
}

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
      // GH #517: project only the fields the dashboard actually reads —
      // this is a hot path, and pulling whole documents streams photo blobs
      // + usage ledgers it never uses.
      Filament.find(
        { _deletedAt: null },
        {
          _id: 1,
          parentId: 1,
          name: 1,
          vendor: 1,
          color: 1,
          secondaryColors: 1,
          optTags: 1,
          spoolWeight: 1,
          // GH #777: needed to count a legacy single-spool row (empty
          // spools[] + a top-level totalWeight) the way the home stat does.
          totalWeight: 1,
          lowStockThreshold: 1,
          dryingTemperature: 1,
          "spools._id": 1,
          "spools.label": 1,
          "spools.totalWeight": 1,
          "spools.retired": 1,
          "spools.dryCycles.date": 1,
        },
      ).lean(),
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
    // GH #1113: the filament list headlines rows-it-renders, which excludes
    // TEMPLATES (grouping headers, not rolls); this counts every record.
    // Ship the count of the records the list REMOVES — that is what explains
    // the gap. Counting variants instead names a different number (one
    // parent + two variants is 3 here and 2 there; the extra record is the
    // parent).
    const parentIdsWithVariants = new Set(
      filaments.map((f) => f.parentId && String(f.parentId)).filter(Boolean),
    );
    const templateCount = filaments.filter((f) =>
      parentIdsWithVariants.has(String(f._id)),
    ).length;
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

    // Build a parentMap up front — variants inherit `spoolWeight` from
    // their parent, so subtracting only the variant's own field treats the
    // inherited case as 0 and re-introduces the GH #182 over-reporting.
    const parentMap = new Map<string, (typeof filaments)[number]>();
    for (const f of filaments) {
      if (!f.parentId) parentMap.set(f._id.toString(), f);
    }

    for (const f of filaments) {
      let remaining = 0;
      // GH #1078: mirror `getRemainingGrams`'s "any weight datum seen" gate
      // (src/lib/inventoryStats.ts) — without it, a filament whose spools
      // carry no `totalWeight` reads as 0 g and trips a permanent false
      // low-stock alert while the home list shows nothing. `weighed` flips
      // alongside every `remaining +=`.
      let weighed = false;
      // GH #182: `spool.totalWeight` is the live scale reading (filament +
      // empty spool), not remaining filament — subtract the tare, resolving
      // the parent's spoolWeight when the variant's is null.
      const ownMass = typeof f.spoolWeight === "number" ? f.spoolWeight : null;
      const parent = f.parentId ? parentMap.get(f.parentId.toString()) : undefined;
      const inheritedMass = parent && typeof parent.spoolWeight === "number" ? parent.spoolWeight : 0;
      const spoolMass = ownMass ?? inheritedMass;
      for (const s of f.spools || []) {
        if (s.retired) {
          retiredSpools++;
          continue;
        }
        spoolCount++;
        if (typeof s.totalWeight === "number") {
          remaining += Math.max(0, s.totalWeight - spoolMass);
          weighed = true;
        }
      }
      // GH #777: a legacy single-spool row (no spools[] but a top-level
      // totalWeight) counts as one physical roll, matching the home stat
      // (getSpoolCount) and the /inventory synthetic spool. Only fires when
      // spools[] is empty.
      if ((f.spools?.length ?? 0) === 0 && typeof f.totalWeight === "number") {
        spoolCount++;
        remaining += Math.max(0, f.totalWeight - spoolMass);
        weighed = true;
      }
      totalGrams += remaining;
      if (
        weighed &&
        typeof f.lowStockThreshold === "number" &&
        f.lowStockThreshold > 0 &&
        remaining < f.lowStockThreshold
      ) {
        lowStock.push({
          _id: String(f._id),
          name: f.name,
          vendor: f.vendor,
          // GH #477: primary `color` is nullable (coextruded) — the
          // representative color lives in `secondaryColors[0]`, with the
          // variant→parent array-fallback applied by lowStockSwatchColor.
          color: lowStockSwatchColor(f, parent),
          remainingGrams: remaining,
          threshold: f.lowStockThreshold,
        });
      }
    }

    // Spools due for a dry cycle — no dry cycle in the last 30 days and the
    // filament needs drying. A variant with no own dryingTemperature must
    // inherit from its parent (GH #133).
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
      // GH #783: legacy single-spool rows are intentionally NOT added to
      // dryDue even though they count toward the spool total — a dryDue
      // entry carries a `spoolId` driving per-spool actions that would 404
      // on a synthetic legacy id (same reason /inventory renders them
      // read-only), and a legacy roll has no dryCycles history anyway.
      for (const s of f.spools || []) {
        if (s.retired) continue;
        const cycles = s.dryCycles || [];
        // GH #887: take the MAX date, not the last element — the POST honors
        // an arbitrary client `date` with no sort, so a backdated cycle
        // would otherwise read as the most-recent dry.
        let lastCycleMs = 0;
        let lastCycle: typeof cycles[number]["date"] | null = null;
        for (const c of cycles) {
          const t = c.date ? new Date(c.date).getTime() : 0;
          if (t > lastCycleMs) {
            lastCycleMs = t;
            lastCycle = c.date;
          }
        }
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
        filamentTemplates: templateCount,
        nozzles: nozzleCount,
        printers: printerCount,
        bedTypes: bedTypeCount,
        spools: spoolCount,
        retiredSpools,
        // Active + retired, surfaced so a client breakdown needn't
        // re-derive the sum (GH #166).
        totalSpools: spoolCount + retiredSpools,
      },
      totalGrams,
      lowStock,
      // #1117(b): the list is capped for readability; the TRUE count rides
      // alongside so a heading can't silently render the cap.
      dryDue: dryDue.slice(0, DRY_DUE_LIMIT),
      dryDueTotal: dryDue.length,
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
        // GH #1078: clamp through the shared #1030 sanitizer — a sync-fed
        // pathological magnitude (1e308) overflows a raw sum to Infinity,
        // which JSON.stringify serializes as `null`.
        totalGrams: sumUsageGrams(h.usage),
      })),
    });
  } catch (err) {
    return errorResponse("Failed to build dashboard", 500, getErrorMessage(err));
  }
}
