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
  /** Lazy-loaded by the client from `/api/filaments/{id}` on row expand;
   * dropped from this aggregation (GH #429) to keep the payload small —
   * a deployment with 5k filaments × 3 spools each could otherwise
   * stream ~15k photo data URLs in one response. */
  photoDataUrl?: string | null;
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
      // Self-lookup for parent — needed for spoolWeight / netFilamentWeight
      // inheritance (see resolveFilament INHERITABLE_FIELDS) AND for the
      // type / vendor filters, which both fields inherit from. Done
      // BEFORE the type/vendor matches so a variant that leaves either
      // field blank still resolves to its parent's value. Only one
      // parent doc, so $arrayElemAt below safely flattens.
      //
      // Codex P2 on PR #391 round 2: type and vendor are listed in
      // INHERITABLE_FIELDS, so filtering on the variant's raw value
      // dropped any variant that inherited those fields. Project both
      // into the parent lookup and match on effective values below.
      {
        $lookup: {
          from: "filaments",
          localField: "parentId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                spoolWeight: 1,
                netFilamentWeight: 1,
                type: 1,
                vendor: 1,
              },
            },
          ],
          as: "_parent",
        },
      },
      // Compute effective (parent-fallback) `type` and `vendor` ONCE so
      // both the filter stages below AND the row projection share the
      // same value. `resolveFilament` treats all three of MISSING /
      // NULL / EMPTY-STRING as "inherit from parent" (see
      // INHERITABLE_FIELDS in src/lib/resolveFilament.ts:67-72), so we
      // do the same here — otherwise `?type=PLA` would exclude a
      // variant that left the field blank to inherit, even though the
      // rest of the app resolves it as PLA.
      //
      // Important quirk: `{ $eq: ["$missingField", null] }` returns
      // FALSE in MongoDB aggregation (NOT true). Missing and null are
      // distinct types and `$eq` does NOT collapse them. To detect
      // null-or-missing, wrap in `$ifNull` first — that returns the
      // 2nd arg for BOTH null and missing. Then the empty-string check
      // is a separate $eq branch.
      {
        $set: {
          _effectiveType: {
            $let: {
              vars: { v: { $ifNull: ["$type", null] } },
              in: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$$v", null] },
                      { $eq: ["$$v", ""] },
                    ],
                  },
                  { $arrayElemAt: ["$_parent.type", 0] },
                  "$$v",
                ],
              },
            },
          },
          _effectiveVendor: {
            $let: {
              vars: { v: { $ifNull: ["$vendor", null] } },
              in: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$$v", null] },
                      { $eq: ["$$v", ""] },
                    ],
                  },
                  { $arrayElemAt: ["$_parent.vendor", 0] },
                  "$$v",
                ],
              },
            },
          },
        },
      },
      // Optional filament-level filters use the EFFECTIVE values so an
      // inheriting variant is matched the same way the rest of the app
      // sees it via resolveFilament.
      ...(typeFilter
        ? [{ $match: { _effectiveType: typeFilter } }]
        : []),
      ...(vendorFilter
        ? [{ $match: { _effectiveVendor: vendorFilter } }]
        : []),
      { $unwind: "$spools" },
      // Retired filter happens AFTER unwind because it's on the spool
      // subdoc, not the filament.
      ...(!includeRetired ? [{ $match: { "spools.retired": { $ne: true } } }] : []),
      // GH #429: the response is still nominally unbounded (one row
      // per spool across every active filament). The earlier
      // photoDataUrl drop killed the worst-case per-row size — a
      // realistic deployment with thousands of spools now serialises
      // to a few hundred KB rather than tens of MB. A post-`$unwind`
      // `$limit` was tried here but Codex pointed out it would have
      // SILENTLY truncated groups: `kind=printer` etc. filters run
      // AFTER unwind, so the cap would drop spools by document order
      // and leave `totalSpools`/per-location counts wrong. Pagination
      // (limit/offset with deterministic sort + truncated flag) is the
      // correct fix when a deployment really has 10k+ spools; tracked
      // separately rather than capping unsafely here.
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
              // GH #429: photoDataUrl intentionally omitted — see the
              // AggregatedSpool field comment above. The /inventory page
              // lazy-loads photos when expanding a row.
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
              // Use the same EFFECTIVE values the filter stages used so
              // the page's chips and the server's filters can't disagree.
              filamentVendor: "$_effectiveVendor",
              filamentType: "$_effectiveType",
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
          // Codex P2 on PR #391: sum REMAINING filament grams, not gross
          // on-scale weight. `spools.totalWeight` is the gross reading
          // (filament + empty-spool tare), so summing it directly
          // over-reports by `N × empty-spool-mass` — the existing
          // inventoryStats path explicitly subtracts the tare for the
          // same reason. The variant's own `spoolWeight` wins; otherwise
          // fall back to the parent's via the self-`$lookup` above.
          //
          // Codex P2 round 4 on PR #400: when NEITHER tare value is set
          // (legacy data shape — rolls tracked before `spoolWeight` was
          // a field), fall through to a 0g tare so the gross weight
          // still shows up in the inventory total. That matches the
          // posture of `/api/dashboard` and `/api/locations`, both of
          // which use a 0 fallback for the missing tare. Without this,
          // legacy rolls would silently report 0g of inventory on the
          // `/inventory` page while still contributing to dashboard
          // totals — a confusing inconsistency.
          totalGrams: {
            $sum: {
              $cond: [
                { $ne: ["$spools.totalWeight", null] },
                {
                  $max: [
                    0,
                    {
                      $subtract: [
                        "$spools.totalWeight",
                        {
                          $ifNull: [
                            "$spoolWeight",
                            {
                              $ifNull: [
                                { $arrayElemAt: ["$_parent.spoolWeight", 0] },
                                0,
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                0,
              ],
            },
          },
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
