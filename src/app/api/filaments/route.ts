import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import { getErrorMessage, errorResponse, errorResponseFromCaught, handleDuplicateKeyError, assertActiveRefs } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * GH #519: collect every cross-collection ref carried by a filament body and
 * verify each id resolves to an active doc. Mirrors the printer-route shape
 * (`assertActiveRefs(model, ids, label)`). Calibration refs are pulled out
 * per-collection so the error message names the right field; null/missing
 * refs in calibration entries are passed through (the schema marks
 * `nozzle` required and handles it at validation time).
 */
async function assertFilamentBodyRefs(
  body: Record<string, unknown>,
): Promise<Response | null> {
  const compatibleNozzles = Array.isArray(body.compatibleNozzles)
    ? (body.compatibleNozzles as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const nozzleRefs = new Set<string>(compatibleNozzles);
  const printerRefs = new Set<string>();
  const bedRefs = new Set<string>();
  if (Array.isArray(body.calibrations)) {
    for (const cal of body.calibrations as Array<Record<string, unknown>>) {
      if (typeof cal?.nozzle === "string") nozzleRefs.add(cal.nozzle);
      if (typeof cal?.printer === "string") printerRefs.add(cal.printer);
      if (typeof cal?.bedType === "string") bedRefs.add(cal.bedType);
    }
  }
  const nozzleGuard = await assertActiveRefs(Nozzle, Array.from(nozzleRefs), "referenced nozzles");
  if (nozzleGuard) return nozzleGuard;
  const printerGuard = await assertActiveRefs(Printer, Array.from(printerRefs), "referenced printers");
  if (printerGuard) return printerGuard;
  const bedGuard = await assertActiveRefs(BedType, Array.from(bedRefs), "referenced bed types");
  if (bedGuard) return bedGuard;
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function GET(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const type = searchParams.get("type");
    const vendor = searchParams.get("vendor");
    const search = searchParams.get("search");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (type) filter.type = type;
    if (vendor) filter.vendor = vendor;
    if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };

    // Project to FilamentSummary shape: drop heavy spool subfields
    // (photoDataUrl, usageHistory, dryCycles), keep only the temperatures
    // the list renders, and surface `hasCalibrations` so the noCalibration
    // quick filter has a signal it can act on without fetching every doc.
    // The full document is still available via /api/filaments/{id}.
    //
    // tdsUrl is included on top of FilamentSummary because FilamentForm
    // (src/app/filaments/FilamentForm.tsx) calls this endpoint with
    // ?vendor=... to derive vendor-keyed TDS suggestions and reads
    // f.tdsUrl off each result. Dropping the field silently empties the
    // suggestion list on create/edit.
    const filaments = await Filament.aggregate([
      { $match: filter },
      { $sort: { name: 1 } },
      // Look up parent's calibrations so hasCalibrations reflects the
      // *effective* state rather than the variant's own array. Variants
      // with empty calibrations inherit from their parent (see
      // resolveFilament in src/lib/resolveFilament.ts), so projecting
      // only the variant's own array would falsely flag inheriting
      // variants under the noCalibration filter.
      {
        $lookup: {
          from: "filaments",
          localField: "parentId",
          foreignField: "_id",
          as: "_parent",
          // GH #477: include `secondaryColors` so the effective projection
          // below can merge a variant's empty array with the parent's full
          // array — same array-fallback inheritance pattern resolveFilament
          // uses at read time. Without this the list drops inherited
          // multi-color data and the list-row swatch can't render it.
          // (Codex P2 on PR #482.)
          //
          // GH #553: also carry the inheritable scalar fields (temperatures,
          // cost, density, spoolWeight, netFilamentWeight) so the projection
          // can resolve them server-side. The list page used to merge these
          // client-side from the parent row, but a name search returns only
          // the matching variant (its parent is filtered out by `$match`),
          // so the variant rendered `—` for inherited Nozzle/Bed in search
          // results. `$lookup` runs against the full collection regardless of
          // the search filter, so the parent is always available here.
          pipeline: [
            {
              $project: {
                calibrations: 1,
                optTags: 1,
                secondaryColors: 1,
                temperatures: 1,
                cost: 1,
                density: 1,
                spoolWeight: 1,
                netFilamentWeight: 1,
              },
            },
          ],
        },
      },
      // Look up whether any non-deleted filament references this row as
      // parent. A single match is enough — we only need a boolean — so the
      // sub-pipeline caps at one document. Drives the cross-hatch "multi
      // color" swatch on the inventory list (rendered by FilamentSwatch
      // whenever isParent is true). Per project agreement: a filament is
      // a parent ONLY when it currently has ≥1 variant — there is no
      // explicit flag.
      {
        $lookup: {
          from: "filaments",
          let: { fid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$parentId", "$$fid"] },
                    { $eq: ["$_deletedAt", null] },
                  ],
                },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "_variantProbe",
        },
      },
      {
        $project: {
          name: 1,
          vendor: 1,
          type: 1,
          color: 1,
          // GH #477: secondaryColors rides the list so a multi-color
          // filament renders its full swatch in the list view without a
          // follow-up fetch. Same effective-array merge as `optTags`
          // below — variants with an empty secondaryColors inherit the
          // parent's array per resolveFilament's array-fallback rule.
          // Without this merge, a variant whose parent is a tri-color
          // coextruded but whose own secondaryColors is `[]` would
          // render single-color on the list / parent's color-variant
          // chips despite the detail page showing the full set.
          // (Codex P2 on PR #482.)
          secondaryColors: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$secondaryColors", []] } }, 0] },
              "$secondaryColors",
              { $ifNull: [{ $arrayElemAt: ["$_parent.secondaryColors", 0] }, []] },
            ],
          },
          // GH #553: resolve inheritable scalars against the parent so a
          // variant surfaced as a standalone search-result row still shows
          // its effective cost/density/spool weights (the parent row is
          // filtered out of search results). `$ifNull` collapses null +
          // missing, matching resolveFilament's scalar-inheritance rule.
          // `$_parent` holds 0-or-1 docs; `$arrayElemAt(…, 0)` is null when
          // there's no parent, so standalones/parents are unaffected.
          cost: { $ifNull: ["$cost", { $arrayElemAt: ["$_parent.cost", 0] }] },
          density: {
            $ifNull: ["$density", { $arrayElemAt: ["$_parent.density", 0] }],
          },
          parentId: 1,
          spoolWeight: {
            $ifNull: [
              "$spoolWeight",
              { $arrayElemAt: ["$_parent.spoolWeight", 0] },
            ],
          },
          netFilamentWeight: {
            $ifNull: [
              "$netFilamentWeight",
              { $arrayElemAt: ["$_parent.netFilamentWeight", 0] },
            ],
          },
          totalWeight: 1,
          lowStockThreshold: 1,
          tdsUrl: 1,
          // optTags rides the list payload so the inventory row can
          // render the finish-derived swatch texture + chip beside the
          // name without hitting /api/filaments/{id} for every row.
          //
          // We project the *effective* optTags rather than the variant's
          // own array — variants with an empty optTags inherit from the
          // parent per resolveFilament's array-field rule. Without this
          // merge, a variant whose parent is matte but whose own optTags
          // is `[]` would render plain on the list and on the parent's
          // color-variants chips, even though clicking through to the
          // variant's detail page shows it as matte (because that path
          // does go through resolveFilament). Codex round-1 P2 on PR
          // #353.
          optTags: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$optTags", []] } }, 0] },
              "$optTags",
              { $ifNull: [{ $arrayElemAt: ["$_parent.optTags", 0] }, []] },
            ],
          },
          // GH #553: same parent-fallback as the scalars above. Built as a
          // single computed object (not two `temperatures.x: 1` paths) both
          // because mixing a computed field with dotted sub-paths of the
          // same root is a projection-path collision, and so the variant
          // inherits the parent's nozzle/bed temps in search-result rows.
          temperatures: {
            nozzle: {
              $ifNull: [
                "$temperatures.nozzle",
                { $arrayElemAt: ["$_parent.temperatures.nozzle", 0] },
              ],
            },
            bed: {
              $ifNull: [
                "$temperatures.bed",
                { $arrayElemAt: ["$_parent.temperatures.bed", 0] },
              ],
            },
          },
          hasCalibrations: {
            $or: [
              { $gt: [{ $size: { $ifNull: ["$calibrations", []] } }, 0] },
              {
                $gt: [
                  {
                    $size: {
                      $ifNull: [
                        { $arrayElemAt: ["$_parent.calibrations", 0] },
                        [],
                      ],
                    },
                  },
                  0,
                ],
              },
            ],
          },
          hasVariants: { $gt: [{ $size: "$_variantProbe" }, 0] },
          spools: {
            $map: {
              input: { $ifNull: ["$spools", []] },
              as: "s",
              in: {
                _id: "$$s._id",
                // PrinterForm's AMS slot picker renders each option as
                // `s.label || s._id.slice(-4)`, so dropping label degrades
                // every choice to a 4-char id and breaks multi-spool
                // identification.
                label: "$$s.label",
                totalWeight: "$$s.totalWeight",
                retired: "$$s.retired",
              },
            },
          },
        },
      },
    ]);
    return NextResponse.json(filaments);
  } catch (err) {
    return errorResponse("Failed to fetch filaments", 500, getErrorMessage(err));
  }
}

export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  delete body._id;
  delete body._deletedAt;
  // GH #222: parallel of the PUT-handler fix. `_purged` is a sync-engine
  // tombstone signal — never client-writable. A POST that creates a doc
  // with `_purged: true` would immediately be ignored by every list / get
  // endpoint and trigger cross-peer purge on the next sync cycle.
  delete body._purged;
  delete body.createdAt;
  delete body.updatedAt;
  delete body.__v;
  delete body.instanceId;
  delete body.syncId;

  // GH #431: the PUT handler explicitly strips `body.spools` to prevent a
  // bulk rewrite of a spool's `usageHistory` ledger. The POST handler
  // didn't filter spool subdocs at all — a fresh filament could be
  // created with client-supplied `usageHistory` / `dryCycles` (and faked
  // `createdAt`), which the analytics aggregator + spool-check refund
  // would then count as real history. Allowlist only the legitimate
  // "this is what the user is registering on the new spool" fields and
  // drop everything else, matching the PUT handler's posture.
  if (Array.isArray(body.spools)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body.spools = body.spools.map((s: any) => ({
      label: s?.label,
      totalWeight: s?.totalWeight,
      lotNumber: s?.lotNumber,
      purchaseDate: s?.purchaseDate,
      openedDate: s?.openedDate,
      locationId: s?.locationId,
      photoDataUrl: s?.photoDataUrl,
      retired: s?.retired,
    }));
  }

  // If an initial totalWeight is provided, auto-create a spool entry
  if (body.totalWeight != null && (!body.spools || body.spools.length === 0)) {
    body.spools = [{ label: "", totalWeight: body.totalWeight }];
    body.totalWeight = null;
  }

  try {
    // Validate parentId if provided
    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
      if (!parent) {
        return errorResponse("Parent filament not found", 400);
      }
      // Prevent nested inheritance (parent cannot itself be a variant)
      if (parent.parentId) {
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      // Variants should inherit diameter from the parent unless the client
      // explicitly provides one. Without this, Mongoose's schema default of
      // 1.75 materialises on the new variant and silently overrides a
      // parent's non-1.75 diameter (e.g. 2.85mm). GH #106.
      if (body.diameter === undefined || body.diameter === null || body.diameter === "") {
        body.diameter = null;
      }
    }

    const refGuard = await assertFilamentBodyRefs(body);
    if (refGuard) return refGuard;

    const filament = await Filament.create(body);
    return NextResponse.json(filament, { status: 201 });
  } catch (err: unknown) {
    const dupResponse = handleDuplicateKeyError(err, "filament");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to create filament");
  }
}
