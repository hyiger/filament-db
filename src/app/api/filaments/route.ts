import { NextRequest, NextResponse } from "next/server";
import {
  survivorNameConflict,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import Location from "@/models/Location";
import { getErrorMessage, errorResponse, errorResponseFromCaught, handleDuplicateKeyError, assertActiveRefs, assertActiveSpoolLocation } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest, stripServerOwnedFields } from "@/lib/requestGuard";
import {
  validateSettingsBag,
  validateDottedSettingsPaths,
  normalizeSettingsToWire,
} from "@/lib/slicerSettings";
import { validateSpoolPhotoDataUrl, isValidIsoDateString } from "@/lib/validateSpoolBody";
import { decodedTagToFilamentPayload } from "@/lib/decodedTagToFilament";
import { stripLegacyMachineCondition } from "@/lib/stripLegacyNozzleCondition";
import {
  isInvertedNozzleRange,
  effectiveNozzleRangeForUpdate,
  inheritNozzleRangeFromParent,
} from "@/lib/temperatureRange";
import {
  createVariantGated,
  promotionRequired409Body,
} from "@/lib/createVariantGated";

/**
 * GH #519: verify every cross-collection ref carried by a filament body
 * resolves to an active doc. Calibration refs are pulled out per-collection
 * so the error names the right field; null/missing refs pass through (the
 * schema handles required-ness at validation time).
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

    // GH #1108: a type/vendor filter that matches a TEMPLATE brings its
    // variants with it. `vendor`/`type` are `required: true` and stamped by
    // every creation path, so despite being listed as inheritable they never
    // actually inherit — filtering per ROW returned the template alone as a
    // memberless group header with its variants unreachable.
    //
    // Widening is scoped to type/vendor (a product line = a family); search
    // is left alone — and the name predicate must ride the family arm too,
    // or `?search=X&vendor=V` would quietly be broader than `?search=X`
    // (every child of a search-matched template regardless of name).
    //
    // OPT-IN via `?family=1`, NOT the default: `type`/`vendor` are
    // documented exact row filters, and callers depend on that literally —
    // FilamentForm derives vendor-keyed TDS suggestions from `?vendor=`, and
    // PrusamentImportDialog treats `?type=` results as material matches and
    // may auto-select one by name. Widening by default would offer another
    // vendor's TDS or attach a spool to a mismatched material.
    const wantFamily = searchParams.get("family") === "1";
    let matchStage: Record<string, unknown> = filter;
    if (wantFamily && (type || vendor)) {
      const matchedIds = await Filament.distinct("_id", filter);
      if (matchedIds.length > 0) {
        const familyArm: Record<string, unknown> = {
          _deletedAt: null,
          parentId: { $in: matchedIds },
        };
        if (search) familyArm.name = filter.name;
        matchStage = { $or: [filter, familyArm] };
      }
    }

    // Project to FilamentSummary shape: drop heavy spool subfields
    // (photoDataUrl, usageHistory, dryCycles) and surface `hasCalibrations`
    // for the noCalibration quick filter.
    //
    // tdsUrl is included because FilamentForm calls this endpoint with
    // ?vendor=... and reads f.tdsUrl off each result for TDS suggestions —
    // dropping the field silently empties that list.
    const filaments = await Filament.aggregate([
      { $match: matchStage },
      { $sort: { name: 1 } },
      // Look up the parent so hasCalibrations and the effective-array /
      // scalar projections below reflect variant INHERITANCE (a variant with
      // an empty array/null inherits — resolveFilament's rule); projecting
      // only the variant's own values would falsely flag inheriting variants
      // and blank inherited fields. GH #553: the scalars matter because a
      // name search returns only the matching variant (its parent is
      // filtered out by `$match`), while `$lookup` runs against the full
      // collection so the parent is always available here.
      {
        $lookup: {
          from: "filaments",
          localField: "parentId",
          foreignField: "_id",
          as: "_parent",
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
      // Probe whether any non-deleted filament references this row as parent
      // (capped at 1 doc — only a boolean is needed). A filament is a parent
      // ONLY when it currently has ≥1 variant — there is no explicit flag.
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
                    // when the field is MISSING — aggregation `$eq` does NOT
                    // collapse missing into null (see /api/spools/by-location
                    // for the same pattern). Legacy pre-v1.15 variants lack
                    // `_deletedAt` entirely, so without the `$ifNull` wrap
                    // their parent reports hasVariants:false.
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
          // GH #477: effective secondaryColors — same array-fallback merge
          // as `optTags` below (empty own array inherits the parent's).
          secondaryColors: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$secondaryColors", []] } }, 0] },
              "$secondaryColors",
              { $ifNull: [{ $arrayElemAt: ["$_parent.secondaryColors", 0] }, []] },
            ],
          },
          // GH #553: resolve inheritable scalars against the parent.
          // `$ifNull` collapses null + missing, matching resolveFilament's
          // scalar rule; `$arrayElemAt(…, 0)` is null with no parent, so
          // standalones/parents are unaffected.
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
          // Effective optTags (finish swatch/chip) — empty own array
          // inherits the parent's, per resolveFilament's array-field rule;
          // without the merge an inheriting variant renders plain here while
          // its detail page shows the finish.
          optTags: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$optTags", []] } }, 0] },
              "$optTags",
              { $ifNull: [{ $arrayElemAt: ["$_parent.optTags", 0] }, []] },
            ],
          },
          // Same parent-fallback as the scalars. Built as a single computed
          // object (not two `temperatures.x: 1` paths) — mixing a computed
          // field with dotted sub-paths of the same root is a
          // projection-path collision.
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
                // #732: per-spool 5-byte hex id (label QR / NFC / match).
                instanceId: "$$s.instanceId",
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
                // #941: drive the sortable Purchased/Opened columns on the
                // home list (earliest spool date per filament).
                purchaseDate: "$$s.purchaseDate",
                openedDate: "$$s.openedDate",
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

  // Create-from-decoded-tag (mobile): the scanner POSTs the tag exactly as
  // POST /api/nfc/decode returned it (`tagData`) plus the user's confirmed
  // edits (`overrides`). Map it server-side — the phone never reproduces
  // this mapping — then flow it through the normal create path below so it
  // inherits the same stripping/validation. `overrides` win over the tag.
  //
  // Unlike the PUT handler, this path deliberately needs no $-operator-key
  // rejection: the merged body flows to Filament.create() — schema strict
  // mode silently drops unknown $-prefixed paths — not to findOneAndUpdate.
  // instanceId is NOT taken from the tag — it stays system-assigned (the
  // strip below removes any client value, including a forged
  // tagData.spool_uid); see decodedTagToFilament for why.
  if (body && typeof body === "object" && body.tagData && typeof body.tagData === "object") {
    const overrides =
      body.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)
        ? body.overrides
        : {};
    const mapped = decodedTagToFilamentPayload(body.tagData);
    // Spool-on-create: the scanner sends remaining grams; the server
    // converts remaining → gross `totalWeight` by adding the tag tare (the
    // phone never does this math). Omitting `spoolRemainingGrams` creates no
    // spool. GH #1072: `Number.isFinite` joins the guard —
    // `JSON.parse("1e309") === Infinity` satisfies both the typeof check and
    // `>= 0`; a non-finite value takes the "no spool rather than a bad one"
    // posture.
    const spoolRemaining =
      typeof body.spoolRemainingGrams === "number" &&
      Number.isFinite(body.spoolRemainingGrams) &&
      body.spoolRemainingGrams >= 0
        ? body.spoolRemainingGrams
        : null;
    body = { ...mapped, ...overrides };
    if (spoolRemaining != null) {
      // Use the FINAL stored tare (after overrides), and persist a 0
      // fallback when the tag carried none, so the spool's gross weight and
      // the filament's spoolWeight agree — otherwise
      // `remaining = totalWeight - storedTare` wouldn't equal the entered grams.
      if (typeof body.spoolWeight !== "number") body.spoolWeight = 0;
      body.totalWeight = spoolRemaining + body.spoolWeight;
    }
  }

  // GH #605: `promoteParent` is a control flag, never a schema field —
  // capture then strip (after the tagData merge, so an `overrides` copy is
  // honoured/stripped the same way).
  const promoteParent = body?.promoteParent === true;
  delete body.promoteParent;

  // GH #222 / #1072: drop every SERVER-OWNED field — exact keys AND dotted
  // subpaths (Mongoose treats dotted keys as live nested paths in
  // Filament.create too, so exact-key deletes alone are bypassable). The
  // shared field list lives in SERVER_OWNED_FILAMENT_FIELDS
  // (src/lib/requestGuard.ts) so this strip and the PUT handler's can't
  // drift. `spools` stays allowed as an EXACT key on the create path — the
  // embedded-spool allowlist + validation loop below is the create-path
  // spool contract (GH #431) — but its dotted subpaths are still swept.
  stripServerOwnedFields(body, { allowExact: ["spools"] });

  // GH #1072: enforce the GH #266 settings-bag caps here too — `settings` is
  // Schema.Types.Mixed, so Filament.create validates nothing about it. Both
  // the whole-object and dotted `settings.<key>` forms are covered; the
  // dotted check is seeded with the WHOLE-object form's keys, because
  // Filament.create applies dotted assignments INTO the object bag — an
  // at-cap `settings` object plus dotted extras would otherwise store a
  // merged bag past MAX_SETTINGS_KEYS with each helper passing in isolation
  // (#1089). GH #1070: wire-normalize raw multi-line settings strings BEFORE
  // the caps, so the length check applies to the wrapped value.
  normalizeSettingsToWire(body);
  const wholeBagKeys =
    body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
      ? Object.keys(body.settings as Record<string, unknown>)
      : [];
  const settingsError =
    validateSettingsBag(body.settings) ??
    validateDottedSettingsPaths(body, wholeBagKeys);
  if (settingsError) return errorResponse(settingsError, 400);

  // GH #431: allowlist embedded spool fields — without it a fresh filament
  // could be created with client-supplied `usageHistory` / `dryCycles`
  // (faked history the analytics aggregator + spool-check refund would count
  // as real). Matches the PUT handler's posture (which strips `spools`).
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
    // Enforce the dedicated spool routes' per-field contracts here too, so
    // an embedded spool on create can't bypass them:
    //   - GH #626: photoDataUrl raster-only MIME allow-list + 5MB cap (SVG
    //     rejected — inline <script> can execute in some contexts).
    //   - GH #953: purchaseDate/openedDate must name a real ISO date —
    //     Mongoose silently normalises "2025-02-29" → Mar 1 on cast (the
    //     GH #372 bug).
    //   - GH #953: locationId must reference an active Location (a dangling
    //     ref produces a phantom "no location" group).
    //   - GH #1072: totalWeight must be finite non-negative or null — the
    //     schema's `min: 0` accepts Infinity, which then blanks the
    //     by-location $sum (JSON.stringify renders Infinity as null).
    //   (label/lotNumber length is backstopped by the schema maxlength.)
    for (let i = 0; i < body.spools.length; i++) {
      const spool = body.spools[i];

      if (spool.totalWeight !== undefined && spool.totalWeight !== null) {
        if (
          typeof spool.totalWeight !== "number" ||
          !Number.isFinite(spool.totalWeight)
        ) {
          return errorResponse(
            `spools[${i}]: totalWeight must be a finite number or null`,
            400,
          );
        }
        if (spool.totalWeight < 0) {
          return errorResponse(`spools[${i}]: totalWeight must be non-negative`, 400);
        }
      }

      const photo = validateSpoolPhotoDataUrl(spool.photoDataUrl);
      if (!photo.ok) {
        return errorResponse(`spools[${i}]: ${photo.error}`, 400);
      }
      spool.photoDataUrl = photo.value;

      for (const field of ["purchaseDate", "openedDate"] as const) {
        const v = spool[field];
        if (v !== null && v !== undefined && v !== "") {
          if (typeof v !== "string" || !isValidIsoDateString(v)) {
            return errorResponse(
              `spools[${i}]: ${field} must be a valid ISO date string (YYYY-MM-DD or full ISO 8601) or null`,
              400,
            );
          }
        }
      }

      const locGuard = await assertActiveSpoolLocation(Location, spool.locationId);
      if (locGuard) return locGuard;
    }
  }

  // GH #1072: finite-check the top-level totalWeight BEFORE it can become a
  // spool below. Same validateSpoolBody contract as the embedded-spool loop;
  // also backstops the create-from-tag path's computed sum.
  if (body.totalWeight !== undefined && body.totalWeight !== null) {
    if (typeof body.totalWeight !== "number" || !Number.isFinite(body.totalWeight)) {
      return errorResponse("totalWeight must be a finite number or null", 400);
    }
    if (body.totalWeight < 0) {
      return errorResponse("totalWeight must be non-negative", 400);
    }
  }

  // If an initial totalWeight is provided, auto-create a spool entry
  if (body.totalWeight != null && (!body.spools || body.spools.length === 0)) {
    body.spools = [{ label: "", totalWeight: body.totalWeight }];
    body.totalWeight = null;
  }

  try {
    // GH #605: the parent doc captured here serves PRE-LOCK validation only
    // (exists / not nested / diameter default); the gate + promotion run
    // right before the create, AFTER every other guard — an
    // otherwise-invalid request gets its 400 (not a promotion 409), a
    // rejected request can never leave a half-promoted parent — and they
    // re-fetch the parent FRESH inside a per-parent lock (see the gate
    // below).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let variantParent: Record<string, any> | null = null;

    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
      if (!parent) {
        return errorResponse("Parent filament not found", 400);
      }
      if (parent.parentId) {
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      // GH #106: variants inherit diameter unless the client provides one —
      // otherwise Mongoose's schema default of 1.75 materialises and
      // silently overrides a parent's non-1.75 diameter.
      if (body.diameter === undefined || body.diameter === null || body.diameter === "") {
        body.diameter = null;
      }
      variantParent = parent;
    }

    const refGuard = await assertFilamentBodyRefs(body);
    if (refGuard) return refGuard;

    // #574: reject an inverted nozzle temperature range (min > max) — the
    // per-field bounds don't catch it. Validate the EFFECTIVE range: a
    // variant inherits each missing endpoint from its parent, so a lone
    // `nozzleRangeMin: 300` against a parent `nozzleRangeMax: 200` is
    // inverted.
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

    // GH #1021: a full-document create can carry BOTH the ticks and a
    // pre-upgrade stamped machine condition (the shared-catalog import sends
    // exactly that shape) — and with the one-shot marker completed no
    // migration is left to catch it. Same provenance-matched strip as the
    // other ingestion boundaries; a non-matching pure nozzle condition
    // persists as a user pin.
    if (body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)) {
      await stripLegacyMachineCondition(body.settings as Record<string, unknown>, {
        compatibleNozzles: body.compatibleNozzles,
        parentId: body.parentId,
      });
    }

    // GH #605: promotion gate — FIRST variant only (from the second on, the
    // parent is already a template with nothing to move). Runs LAST, after
    // every other guard, so the 409 means "this request would succeed, but
    // it has a side effect on the parent you must opt into" (retry with
    // `promoteParent: true`). The gate→promote→create sequence lives in
    // createVariantGated: SERIALIZED per parent id, deciding off a snapshot
    // RE-FETCHED inside the lock — never the `variantParent` doc above — and
    // SHARED with the OpenPrintTag variant import so no secondary entry
    // point can mint the first variant without this confirmation contract.
    //
    // GH #1116: the survivor check sits BEFORE the gated variant path. The
    // partial unique index compares RAW stored strings, so "PLA" beside a
    // surviving "PLA " creates without tripping it — and createVariantGated
    // has the same blind spot (its duplicate probe is a cast Mongoose
    // query). Below the gate the check covered only the standalone create
    // (the gate RETURNS from the variant path), and for a confirmed carrying
    // parent the promotion would already have happened. Fail-fast before the
    // irreversible bit.
    const nameConflict = await survivorNameConflict(
      Filament.collection as unknown as MinimalNameCollection,
      body.name,
    );
    if (nameConflict) {
      return errorResponse(
        `A filament with that name already exists: "${String(body.name).trim()}"`,
        409,
      );
    }

    if (variantParent) {
      const result = await createVariantGated(Filament, variantParent._id, body, promoteParent);
      switch (result.outcome) {
        case "parent_not_found":
          // Validated above but vanished (soft-deleted) before the lock —
          // same 400 the pre-lock check would have given.
          return errorResponse("Parent filament not found", 400);
        case "parent_is_variant":
          // Validated above as a root, but a concurrent PUT re-parented it
          // before the gate's in-lock re-fetch — same no-nesting 400.
          return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
        case "promotion_required":
          return NextResponse.json(promotionRequired409Body(result), { status: 409 });
        case "name_taken":
          return errorResponse(
            `A filament with that name already exists: "${result.name}"`,
            409,
          );
        default:
          return NextResponse.json(result.filament, { status: 201 });
      }
    }

    const filament = await Filament.create(body);
    return NextResponse.json(filament, { status: 201 });
  } catch (err: unknown) {
    const dupResponse = handleDuplicateKeyError(err, "filament");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to create filament");
  }
}
