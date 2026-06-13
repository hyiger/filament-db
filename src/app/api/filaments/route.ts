import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import { getErrorMessage, errorResponse, errorResponseFromCaught, handleDuplicateKeyError, assertActiveRefs } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { validateSpoolPhotoDataUrl } from "@/lib/validateSpoolBody";
import { decodedTagToFilamentPayload } from "@/lib/decodedTagToFilament";
import {
  isInvertedNozzleRange,
  effectiveNozzleRangeForUpdate,
  inheritNozzleRangeFromParent,
} from "@/lib/temperatureRange";

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
                    // GH #625: `{ $eq: ["$_deletedAt", null] }` is FALSE
                    // when the field is missing entirely — in aggregation,
                    // missing is its own BSON type and `$eq` does NOT
                    // collapse it into null (the v1.32.2 quirk; see
                    // /api/spools/by-location for the same pattern).
                    // Legacy variants created before the soft-delete field
                    // existed (pre-v1.15) and never re-saved lack
                    // `_deletedAt` entirely, so without the `$ifNull` wrap
                    // their parent reported hasVariants:false and lost the
                    // composite parent swatch (#597 / #605 reports).
                    { $eq: [{ $ifNull: ["$_deletedAt", null] }, null] },
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
                // #616: the home-page stat line counts distinct spool
                // locations; the id is enough (no Location join needed).
                locationId: "$$s.locationId",
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

  // Create-from-decoded-tag (mobile Phase 2, plan §4.4): the scanner POSTs the
  // tag exactly as POST /api/nfc/decode returned it (`tagData`) plus the user's
  // confirmed edits (`overrides`). Map it to a filament payload server-side —
  // the phone never reproduces this mapping (design rule #1) — then flow it
  // through the normal create path below, so it inherits the same field
  // stripping, ref validation, nozzle-range check, unique-name handling, and
  // spool allowlist. `overrides` win over the tag (the user edits name / vendor
  // / type on the confirm screen, which are required fields).
  //
  // Unlike the PUT handler ([id]/route.ts), this path deliberately needs no
  // $-operator-key rejection: the merged body flows to Filament.create() — a
  // document under schema strict mode, which silently drops unknown
  // $-prefixed paths — not to findOneAndUpdate, so an `overrides` such as
  // { "$set": … } can never act as an update operator. instanceId is NOT taken
  // from the tag — it stays system-assigned (the strip below removes any
  // client value, including a forged tagData.spool_uid); see
  // decodedTagToFilament for why.
  if (body && typeof body === "object" && body.tagData && typeof body.tagData === "object") {
    const overrides =
      body.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)
        ? body.overrides
        : {};
    const mapped = decodedTagToFilamentPayload(body.tagData);
    // Spool-on-create: a scanner owns the roll it just scanned, so it sends the
    // remaining grams (defaulting to the tag's nominal net weight) and the
    // server creates ONE spool from it. We convert remaining → the gross
    // `totalWeight` the auto-spool logic below consumes by adding the tag tare
    // (the mapped spoolWeight) — the phone never does this math (design rule #1).
    // Omitting `spoolRemainingGrams` (e.g. a catalog-only or API caller) creates
    // no spool, so the field is the opt-in the scanner defaults on.
    const spoolRemaining =
      typeof body.spoolRemainingGrams === "number" && body.spoolRemainingGrams >= 0
        ? body.spoolRemainingGrams
        : null;
    body = { ...mapped, ...overrides };
    if (spoolRemaining != null) {
      // Use the FINAL stored tare (after overrides, which may correct it), and
      // persist a 0 fallback when the tag carried none (e.g. a Bambu tag) so the
      // spool's gross weight and the filament's spoolWeight agree — otherwise
      // `remaining = totalWeight - storedTare` wouldn't equal the entered grams.
      if (typeof body.spoolWeight !== "number") body.spoolWeight = 0;
      body.totalWeight = spoolRemaining + body.spoolWeight;
    }
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
  // GH #619: the OpenPrintTag provenance snapshot is server-owned — it
  // records what upstream last offered for every OPT-managed field and is
  // what decides adopt-vs-conflict in diffOptFields (src/lib/optResync.ts).
  // A client-supplied snapshot could forge `snapshot === current` and flip
  // user-edited fields to silently auto-adopt on the next re-sync. Only the
  // OPT import/sync routes may write it.
  delete body.openprinttagSnapshot;

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
    // GH #626: the dedicated spool routes validate photoDataUrl through
    // validateSpoolBody (raster-only MIME allow-list + 5MB cap — SVG is
    // rejected because inline <script> can execute in some rendering
    // contexts). The #431 allowlist above keeps the field but didn't
    // validate its content, so an embedded spool on filament create was
    // a bypass. Enforce the same rules here.
    for (let i = 0; i < body.spools.length; i++) {
      const photo = validateSpoolPhotoDataUrl(body.spools[i].photoDataUrl);
      if (!photo.ok) {
        return errorResponse(`spools[${i}]: ${photo.error}`, 400);
      }
      body.spools[i].photoDataUrl = photo.value;
    }
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

    // #574: reject an inverted nozzle temperature range (min > max). The
    // per-field 0–600 bounds don't catch a min above the max.
    //
    // Codex P2 r3 on #577: validate the EFFECTIVE range. A variant inherits
    // each missing endpoint from its parent (resolveFilament: own ?? parent),
    // so a variant that sets only `nozzleRangeMin: 300` while its parent has
    // `nozzleRangeMax: 200` renders an inverted 300/200 range. Resolve the
    // parent's endpoints into the variant's own before checking.
    let createRange = effectiveNozzleRangeForUpdate(body, null);
    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null })
        .select("temperatures.nozzleRangeMin temperatures.nozzleRangeMax")
        .lean();
      createRange = inheritNozzleRangeFromParent(createRange, parent?.temperatures);
    }
    if (isInvertedNozzleRange(createRange)) {
      return errorResponse(
        "Nozzle range minimum temperature must be less than or equal to the maximum",
        400,
      );
    }

    const filament = await Filament.create(body);
    return NextResponse.json(filament, { status: 201 });
  } catch (err: unknown) {
    const dupResponse = handleDuplicateKeyError(err, "filament");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to create filament");
  }
}
