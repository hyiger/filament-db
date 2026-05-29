import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Location";
import { errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * GH #389 — `/inventory` page support route.
 *
 * Returns every active (non-retired by default) spool across the catalog,
 * grouped by its storage Location. A spool whose `locationId` is null
 * lands in a synthetic "no location" group so users can spot stragglers.
 *
 * Why an aggregation rather than the existing `/api/filaments` list:
 *   - the list endpoint deliberately drops heavy spool subfields
 *     (`photoDataUrl`, `usageHistory`, `dryCycles`) and only keeps
 *     `label`/`totalWeight`/`retired` for the AMS-slot picker — so it
 *     can't power a "show me every spool's details, grouped by where it
 *     lives" view without a second fetch.
 *   - the natural grouping key (`spools[].locationId`) is INSIDE the
 *     filament document, so client-side grouping would require pulling
 *     every spool subdoc on every list refresh. The aggregation does it
 *     once on the server.
 *
 * Variant inheritance: `spoolWeight` and `netFilamentWeight` are
 * inheritable from a variant's parent (see resolveFilament.ts). The
 * client computes "% remaining" from those values, so the aggregation
 * surfaces the variant's own AND the parent's values; the client picks
 * whichever is non-null. Done with a self-`$lookup` on `parentId` so
 * the route stays a single round-trip.
 *
 * Query params:
 *   - `kind`              filter to a single location kind (shelf, drybox, printer, …)
 *   - `type`              filter to a single filament type (PLA, PETG, …)
 *   - `vendor`            filter to a single vendor
 *   - `includeRetired=1`  include retired spools (default: excluded — they're
 *                         out of inventory)
 *
 * Each group:
 *   {
 *     locationId: string | null,
 *     location: { _id, name, kind, humidity, notes } | null,
 *     spools: Array<SpoolWithFilament>,
 *     count: number,
 *     totalGrams: number   // sum of spool.totalWeight; null entries skipped
 *   }
 */

interface AggregatedSpool {
  _id: string;
  label: string;
  totalWeight: number | null;
  lotNumber: string | null;
  purchaseDate: Date | null;
  openedDate: Date | null;
  retired: boolean;
  photoDataUrl: string | null;
  dryCycleCount: number;
  lastDryAt: Date | null;
  filamentId: string;
  filamentName: string;
  filamentVendor: string;
  filamentType: string;
  filamentColor: string;
  /** Variant's own values; null falls back to `parent*` on the client. */
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  parentSpoolWeight: number | null;
  parentNetFilamentWeight: number | null;
}

interface InventoryGroup {
  locationId: string | null;
  location: { _id: string; name: string; kind: string; humidity: number | null; notes: string } | null;
  spools: AggregatedSpool[];
  count: number;
  totalGrams: number;
}

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const { searchParams } = request.nextUrl;
    const kindFilter = searchParams.get("kind");
    const typeFilter = searchParams.get("type");
    const vendorFilter = searchParams.get("vendor");
    const includeRetired = searchParams.get("includeRetired") === "1";

    // ── Build the pipeline ─────────────────────────────────────────────
    // Loose typing here is intentional — the mongoose PipelineStage union
    // is a tagged discriminated type that doesn't cleanly accept a
    // mixed conditional-spread array. We trust the runtime: every entry
    // here is a well-formed stage object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline: any[] = [
      { $match: { _deletedAt: null, spools: { $exists: true, $ne: [] } } },
      // Optional filament-level filters before the unwind so we narrow
      // the working set as early as possible.
      ...(typeFilter ? [{ $match: { type: typeFilter } }] : []),
      ...(vendorFilter ? [{ $match: { vendor: vendorFilter } }] : []),
      // Self-lookup for parent (needed for spoolWeight / netFilamentWeight
      // inheritance — see resolveFilament INHERITABLE_FIELDS). Only one
      // doc, so $arrayElemAt below safely flattens.
      {
        $lookup: {
          from: "filaments",
          localField: "parentId",
          foreignField: "_id",
          pipeline: [{ $project: { spoolWeight: 1, netFilamentWeight: 1 } }],
          as: "_parent",
        },
      },
      { $unwind: "$spools" },
      // Retired filter happens AFTER unwind because it's on the spool
      // subdoc, not the filament.
      ...(!includeRetired ? [{ $match: { "spools.retired": { $ne: true } } }] : []),
      {
        $group: {
          _id: "$spools.locationId",
          spools: {
            $push: {
              _id: "$spools._id",
              label: "$spools.label",
              totalWeight: "$spools.totalWeight",
              lotNumber: "$spools.lotNumber",
              purchaseDate: "$spools.purchaseDate",
              openedDate: "$spools.openedDate",
              retired: "$spools.retired",
              photoDataUrl: "$spools.photoDataUrl",
              dryCycleCount: { $size: { $ifNull: ["$spools.dryCycles", []] } },
              lastDryAt: {
                // Latest dryCycles[].date if any. Subdocs are appended
                // chronologically; the last element is the newest.
                $let: {
                  vars: { cycles: { $ifNull: ["$spools.dryCycles", []] } },
                  in: {
                    $cond: [
                      { $gt: [{ $size: "$$cycles" }, 0] },
                      { $arrayElemAt: ["$$cycles.date", -1] },
                      null,
                    ],
                  },
                },
              },
              filamentId: "$_id",
              filamentName: "$name",
              filamentVendor: "$vendor",
              filamentType: "$type",
              filamentColor: "$color",
              spoolWeight: "$spoolWeight",
              netFilamentWeight: "$netFilamentWeight",
              parentSpoolWeight: {
                $ifNull: [{ $arrayElemAt: ["$_parent.spoolWeight", 0] }, null],
              },
              parentNetFilamentWeight: {
                $ifNull: [{ $arrayElemAt: ["$_parent.netFilamentWeight", 0] }, null],
              },
            },
          },
          count: { $sum: 1 },
          // Sum totalWeight; missing values contribute 0. `$ifNull` so
          // null doesn't poison the $sum result (Mongo treats null as 0
          // inside $sum but the explicit ifNull documents intent).
          totalGrams: { $sum: { $ifNull: ["$spools.totalWeight", 0] } },
        },
      },
      {
        $lookup: {
          from: "locations",
          localField: "_id",
          foreignField: "_id",
          pipeline: [
            { $match: { _deletedAt: null } },
            { $project: { _id: 1, name: 1, kind: 1, humidity: 1, notes: 1 } },
          ],
          as: "_location",
        },
      },
      {
        $project: {
          _id: 0,
          locationId: "$_id",
          location: { $arrayElemAt: ["$_location", 0] },
          spools: 1,
          count: 1,
          totalGrams: 1,
        },
      },
      // Optional kind filter is applied AFTER the lookup since `kind`
      // lives on the Location doc.
      ...(kindFilter ? [{ $match: { "location.kind": kindFilter } }] : []),
      // Sort by location name; the synthetic null-location group sorts
      // last because BSON null orders before strings — we flip it below
      // on the client side OR with a $sort that pushes null to the end.
      // Initial sort by location name — null lands first in BSON; we
      // re-sort on the way out below to push the synthetic null-location
      // group to the END (a "no location" bucket at the top would bury
      // the real shelves).
      { $sort: { "location.name": 1 } },
    ];

    const groups = (await Filament.aggregate(pipeline)) as InventoryGroup[];

    // Sort the null-location group to the end on the way out — Mongo
    // sorts null first, but a "no location" group at the top of the
    // page would look like the most-populated bucket and bury the real
    // shelves. Move it to the bottom.
    groups.sort((a, b) => {
      const aNull = a.locationId == null;
      const bNull = b.locationId == null;
      if (aNull && !bNull) return 1;
      if (bNull && !aNull) return -1;
      return (a.location?.name || "").localeCompare(b.location?.name || "");
    });

    // Per-group: sort spools by filament name, then spool label, so the
    // page renders deterministically across reloads.
    for (const g of groups) {
      g.spools.sort((a, b) => {
        const n = (a.filamentName || "").localeCompare(b.filamentName || "");
        if (n !== 0) return n;
        return (a.label || "").localeCompare(b.label || "");
      });
    }

    return NextResponse.json({ groups, totalSpools: groups.reduce((s, g) => s + g.count, 0) });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to load inventory");
  }
}
