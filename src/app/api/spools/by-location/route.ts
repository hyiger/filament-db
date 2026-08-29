import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Location";
import { errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * GH #389 — `/inventory` page support route.
 *
 * Returns every active (non-retired by default) spool across the catalog,
 * grouped by its storage Location; a null `locationId` lands in a synthetic
 * "no location" group.
 *
 * Variant inheritance: `spoolWeight` / `netFilamentWeight` inherit from a
 * variant's parent (resolveFilament.ts), so the aggregation surfaces both
 * the variant's own AND the parent's values via a self-`$lookup` on
 * `parentId`; the client picks whichever is non-null.
 *
 * Query params: `kind`, `type`, `vendor`, `includeRetired=1` (default
 * excluded — retired spools are out of inventory).
 *
 * Each group: { locationId, location, spools, count, totalGrams }.
 */

interface AggregatedSpool {
  _id: string;
  /** #732 Phase 4: the durable per-spool id, surfaced on /inventory. Nullable —
   * a legacy spool not yet backfilled can emit null. */
  instanceId: string | null;
  /** GH #806: the spool's current location, so /inventory's move-to dropdown
   * pre-selects it. Null for the synthetic legacy / no-location bucket. */
  locationId: string | null;
  label: string;
  totalWeight: number | null;
  lotNumber: string | null;
  purchaseDate: Date | null;
  openedDate: Date | null;
  retired: boolean;
  /** Lazy-loaded by the client on row expand; dropped from this aggregation
   * (GH #429) to keep the payload small. */
  photoDataUrl?: string | null;
  dryCycleCount: number;
  lastDryAt: Date | null;
  filamentId: string;
  filamentName: string;
  filamentVendor: string;
  filamentType: string;
  /** Raw variant primary — null for coextruded filaments (OpenPrintTag
   * spec key 19), whose colors live in `secondaryColors`. */
  filamentColor: string | null;
  /** GH #1050: EFFECTIVE color arrays (variant's own non-empty array, else
   * the parent's — the GH #477 array-fallback rule) so the /inventory row
   * swatch renders multi-color arrangements and finishes like the home
   * list does. */
  secondaryColors: string[];
  optTags: number[];
  /** Variant's own values; null falls back to `parent*` on the client. */
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  parentSpoolWeight: number | null;
  parentNetFilamentWeight: number | null;
  /** GH #783: a synthetic row for a legacy single-spool filament (empty
   * spools[] + a top-level totalWeight). Has no real spools[] subdoc, so the
   * /inventory page renders it read-only — its inline edit routes would 404. */
  legacySingleSpool: boolean;
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

    // Loose typing is intentional — the mongoose PipelineStage union doesn't
    // cleanly accept a mixed conditional-spread array.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline: any[] = [
      // GH #777: keep legacy single-spool rows (empty `spools[]` but a
      // top-level `totalWeight`) so the /inventory count matches the home
      // stat; the `$set` below materializes their one synthetic spool.
      // Still prune catalog-only rows (no spools AND no legacy totalWeight)
      // UP FRONT — sending them through the parent `$lookup` only to drop
      // them at `$unwind` would self-lookup the whole active catalog.
      // (`{ totalWeight: { $ne: null } }` matches present-and-non-null only
      // — missing is treated as null in query matching.)
      {
        $match: {
          _deletedAt: null,
          $or: [
            { spools: { $exists: true, $ne: [] } },
            { totalWeight: { $ne: null } },
          ],
        },
      },
      // GH #1005 F4: drop the heavy per-spool subfields BEFORE they ride
      // through the $lookup/$unwind/$group stages (the legacy-spool $set
      // below references the whole `$spools` array, which would materialize
      // photo blobs + ledgers only to discard them at the $group $push).
      // KEEP spools.dryCycles — dryCycleCount / lastDryAt are computed from
      // it.
      { $unset: ["spools.photoDataUrl", "spools.usageHistory"] },
      // Self-lookup for parent — needed for spoolWeight / netFilamentWeight
      // inheritance AND for the type/vendor filters (both inheritable, so
      // filtering on the variant's raw value would drop inheriting
      // variants). Done BEFORE the type/vendor matches. Only one parent doc,
      // so $arrayElemAt safely flattens.
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
                // GH #1050: parent color arrays for the array-fallback
                // inheritance rule in the row projection (GH #477).
                secondaryColors: 1,
                optTags: 1,
              },
            },
          ],
          as: "_parent",
        },
      },
      // Compute effective (parent-fallback) `type`/`vendor` ONCE so the
      // filter stages AND the row projection share the value.
      // `resolveFilament` treats MISSING / NULL / EMPTY-STRING all as
      // "inherit from parent"; match that here or `?type=PLA` would exclude
      // an inheriting variant.
      //
      // Important quirk: `{ $eq: ["$missingField", null] }` returns FALSE in
      // aggregation — missing and null are distinct BSON types and `$eq`
      // does NOT collapse them. Wrap in `$ifNull` first (returns the 2nd arg
      // for BOTH); the empty-string check is a separate $eq branch.
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
      // Filters use the EFFECTIVE values so an inheriting variant matches
      // the way the rest of the app resolves it.
      ...(typeFilter
        ? [{ $match: { _effectiveType: typeFilter } }]
        : []),
      ...(vendorFilter
        ? [{ $match: { _effectiveVendor: vendorFilter } }]
        : []),
      // GH #777: materialize a synthetic spool for a LEGACY single-spool row
      // (empty `spools[]` + non-null top-level `totalWeight`) so the
      // `$unwind` doesn't miss it. It carries `locationId: null` (lands in
      // the "no location" group, matching the home page), `retired: false`
      // (legacy rolls have no retired notion), and the filament-level
      // `instanceId`. A spool-less + weightless row resolves to `[]` and is
      // dropped by `$unwind`.
      {
        $set: {
          spools: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$spools", []] } }, 0] },
              "$spools",
              {
                $cond: [
                  { $ne: [{ $ifNull: ["$totalWeight", null] }, null] },
                  [
                    {
                      _id: "$_id",
                      instanceId: "$instanceId",
                      label: "",
                      totalWeight: "$totalWeight",
                      lotNumber: null,
                      purchaseDate: null,
                      openedDate: null,
                      retired: false,
                      locationId: null,
                      dryCycles: [],
                      // GH #783: this row has no real spools[] subdoc (its
                      // _id is the filament id), so the inline
                      // edit/move/retire routes would 404 — flag it so the
                      // page renders it read-only.
                      legacySingleSpool: true,
                    },
                  ],
                  [],
                ],
              },
            ],
          },
        },
      },
      { $unwind: "$spools" },
      // Retired filter happens AFTER unwind because it's on the spool
      // subdoc, not the filament.
      ...(!includeRetired ? [{ $match: { "spools.retired": { $ne: true } } }] : []),
      // GH #429: the response is nominally unbounded (one row per spool). Do
      // NOT add a post-`$unwind` `$limit`: the `kind` filter runs AFTER
      // unwind, so a cap would silently truncate groups by document order
      // and leave `totalSpools`/per-location counts wrong. Pagination is the
      // correct fix for 10k+ spools; the photoDataUrl drop already bounds
      // per-row size.
      {
        $group: {
          _id: "$spools.locationId",
          spools: {
            $push: {
              _id: "$spools._id",
              // #732 Phase 4: surface the per-spool id on /inventory.
              instanceId: "$spools.instanceId",
              // GH #806: per-spool locationId so the "Move to…" dropdown
              // pre-selects the current location.
              locationId: "$spools.locationId",
              label: "$spools.label",
              totalWeight: "$spools.totalWeight",
              lotNumber: "$spools.lotNumber",
              purchaseDate: "$spools.purchaseDate",
              openedDate: "$spools.openedDate",
              retired: "$spools.retired",
              // GH #429: photoDataUrl intentionally omitted (lazy-loaded on
              // row expand).
              dryCycleCount: { $size: { $ifNull: ["$spools.dryCycles", []] } },
              // GH #887: the MAX date over dryCycles, NOT the last element —
              // the POST honors an arbitrary client `date` with no $sort, so
              // a backdated cycle lands last. $reduce (an EXPRESSION nested
              // in $push, not a $group accumulator); $max ignores the null
              // seed, so an empty/missing array yields null.
              lastDryAt: {
                $reduce: {
                  input: { $ifNull: ["$spools.dryCycles", []] },
                  initialValue: null,
                  in: { $max: ["$$value", "$$this.date"] },
                },
              },
              filamentId: "$_id",
              filamentName: "$name",
              // Use the same EFFECTIVE values the filter stages used so
              // the page's chips and the server's filters can't disagree.
              filamentVendor: "$_effectiveVendor",
              filamentType: "$_effectiveType",
              filamentColor: "$color",
              // GH #1050: effective (parent-fallback) color arrays — same
              // array-fallback merge as the /api/filaments list aggregation
              // (GH #477). Without these, a coextruded filament (null
              // primary) renders as the gray #808080 sentinel here.
              secondaryColors: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ["$secondaryColors", []] } }, 0] },
                  "$secondaryColors",
                  { $ifNull: [{ $arrayElemAt: ["$_parent.secondaryColors", 0] }, []] },
                ],
              },
              optTags: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ["$optTags", []] } }, 0] },
                  "$optTags",
                  { $ifNull: [{ $arrayElemAt: ["$_parent.optTags", 0] }, []] },
                ],
              },
              spoolWeight: "$spoolWeight",
              netFilamentWeight: "$netFilamentWeight",
              parentSpoolWeight: {
                $ifNull: [{ $arrayElemAt: ["$_parent.spoolWeight", 0] }, null],
              },
              parentNetFilamentWeight: {
                $ifNull: [{ $arrayElemAt: ["$_parent.netFilamentWeight", 0] }, null],
              },
              // GH #783: true only for the synthetic legacy single-spool
              // row; real spools default to false.
              legacySingleSpool: { $ifNull: ["$spools.legacySingleSpool", false] },
            },
          },
          count: { $sum: 1 },
          // Sum REMAINING filament grams, not gross on-scale weight —
          // `spools.totalWeight` includes the empty-spool tare, so summing
          // it directly over-reports by N × tare (inventoryStats subtracts
          // it for the same reason). Variant's own `spoolWeight` wins, else
          // the parent's. When NEITHER tare is set (legacy data), fall
          // through to a 0g tare so the gross weight still counts — matches
          // `/api/dashboard` and `/api/locations`.
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
            { $project: { _id: 1, name: 1, kind: 1, humidity: 1, desiccantChangedAt: 1, notes: 1 } },
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
      // Kind filter is applied AFTER the lookup since `kind` lives on the
      // Location doc.
      ...(kindFilter ? [{ $match: { "location.kind": kindFilter } }] : []),
      { $sort: { "location.name": 1 } },
    ];

    const groups = (await Filament.aggregate(pipeline)) as InventoryGroup[];

    // Re-sort the null-location group to the END — Mongo sorts null first,
    // and a "no location" bucket at the top would bury the real shelves.
    groups.sort((a, b) => {
      const aNull = a.locationId == null;
      const bNull = b.locationId == null;
      if (aNull && !bNull) return 1;
      if (bNull && !aNull) return -1;
      return (a.location?.name || "").localeCompare(b.location?.name || "");
    });

    // Per-group: sort spools by filament name then label for a
    // deterministic render.
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
