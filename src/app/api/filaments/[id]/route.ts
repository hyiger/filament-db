import { NextRequest, NextResponse } from "next/server";
import {
  findExactRawNameId,
  survivorNameConflict,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament, { IFilament } from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import { resolveFilament, hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import {
  gateFirstVariantAdoption,
  promotionRequired409Body,
} from "@/lib/createVariantGated";
import { clearOrphanedParentThreshold } from "@/lib/promoteParent";
import { errorResponse, errorResponseFromCaught, handleDuplicateKeyError, isDuplicateKeyError, assertActiveRefs } from "@/lib/apiErrorHandler";
import {
  assertSameOriginRequest,
  assertSafeUpdateBody,
  stripServerOwnedFields,
} from "@/lib/requestGuard";
import {
  mergeSlicerSettings,
  MAX_SETTING_VALUE_LENGTH,
  validateSettingsBag,
  validateDottedSettingsPaths,
  normalizeSettingsToWire,
  bodyHasRawMultilineSettings,
} from "@/lib/slicerSettings";
import { stripLegacyMachineCondition } from "@/lib/stripLegacyNozzleCondition";
import { resolveSyncBackColor, isMachineDerivedPerNozzleCondition } from "@/lib/prusaSlicerBundle";
import { splitInheritedImportSet } from "@/lib/importFilaments";
import { escapeRegex } from "@/lib/matchFilament";
import { stripTemplateFieldsForWrite } from "@/lib/templateStrip";
import { assignSpoolToSlot } from "@/lib/spoolSlots";
import {
  isInvertedNozzleRange,
  effectiveNozzleRangeForUpdate,
  inheritNozzleRangeFromParent,
} from "@/lib/temperatureRange";

/**
 * GH #261: clear every spool of a filament out of all printer AMS slots.
 * `Printer.amsSlots[].spoolId` would otherwise keep referencing the deleted
 * spools — phantoms that can never be cleared from the (now-gone) spool side.
 */
async function clearFilamentSpoolsFromSlots(
  spools: { _id?: unknown }[] | undefined | null,
): Promise<void> {
  for (const spool of spools ?? []) {
    if (spool?._id) {
      await assignSpoolToSlot(Printer, String(spool._id), null);
    }
  }
}

/**
 * GH #1114: also clear slots that reference this FILAMENT without naming a
 * spool ("Any spool" — `filamentId` set, `spoolId` null). The spool-keyed
 * clear above filters on `amsSlots.spoolId`, so that shape never matched and
 * the slot kept pointing at a trashed/purged filament. Both refs are nulled,
 * matching the clear pass in `assignSpoolToSlot` and the v1.70 promotion
 * remap: leaving `filamentId` behind shows a phantom loaded filament.
 */
async function clearFilamentFromSlots(filamentId: string): Promise<void> {
  const oid = new mongoose.Types.ObjectId(filamentId);
  await Printer.updateMany(
    { _deletedAt: null, "amsSlots.filamentId": oid },
    { $set: { "amsSlots.$[s].filamentId": null, "amsSlots.$[s].spoolId": null } },
    { arrayFilters: [{ "s.filamentId": oid }] },
  );
}

/**
 * GET /api/filaments/{id}
 *
 * Returns a single filament with populated references. By default, if the
 * filament is a variant (has parentId) its inheritable fields are resolved
 * from its parent so the response is a complete view suitable for display.
 *
 * Pass `?raw=true` to skip inheritance resolution and receive the variant's
 * own values. Fields the variant does not override come back as `null`
 * (or empty). This is what the edit page needs — prefilling the form with
 * resolved values and then saving would copy the parent's fields onto the
 * variant and silently sever the inheritance link (GH #106).
 *
 * When `?raw=true` is passed on a parent, the response shape is unchanged
 * (parents don't inherit from anything).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const raw = request.nextUrl.searchParams.get("raw") === "true";

    const filament = await Filament.findOne({ _id: id, _deletedAt: null })
      .populate("compatibleNozzles")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }

    // Two parent-fetch shapes:
    //   raw=true  → variant edit form. Skip resolveFilament (the form must
    //               see only the variant's own overrides — GH #106) and
    //               attach a slim parent-summary projected to the inheritable
    //               display values FilamentForm consumes for hint placeholders
    //               (dropping settings/sync metadata stops leaking sync
    //               internals to the renderer — GH #162).
    //   raw=false → variant detail page. Run resolveFilament on the populated
    //               parent, then attach only `{ _id, name }`.
    let resolved: IFilament | ReturnType<typeof resolveFilament> = filament;
    let parentSummary: {
      _id: unknown; name?: string; vendor?: string; type?: string; color?: string;
      cost?: number | null; density?: number | null; diameter?: number | null;
      inherits?: string | null;
      // GH #1148: every field the edit form renders as an INHERITED
      // placeholder (FilamentForm's parentPh) must ride this projection.
      maxVolumetricSpeed?: number | null; minPrintSpeed?: number | null; maxPrintSpeed?: number | null;
      dryingTemperature?: number | null; dryingTime?: number | null;
      glassTempTransition?: number | null; heatDeflectionTemp?: number | null;
      shoreHardnessA?: number | null; shoreHardnessD?: number | null;
      shrinkageXY?: number | null; shrinkageZ?: number | null;
      spoolWeight?: number | null; netFilamentWeight?: number | null;
      transmissionDistance?: number | null; tdsUrl?: string | null;
      temperatures?: Record<string, number | null> | null;
    } | null = null;
    if (filament.parentId) {
      if (raw) {
        // `inherits` rides the projection for GH #1066: the form adopts a
        // legacy settings-bag `inherits` shadow into its editable field only
        // when neither the variant nor the parent supplies a top-level value
        // (the export masks the shadow whenever the resolved value is truthy).
        parentSummary = (await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
          // GH #1148: keep in lockstep with the parentPh call sites in
          // FilamentForm — a field missing here renders blank on the EDIT
          // page while the new-variant page (whole parent doc) shows it.
          .select(
            "_id name vendor type color secondaryColors cost density diameter inherits " +
              "maxVolumetricSpeed minPrintSpeed maxPrintSpeed dryingTemperature dryingTime " +
              "glassTempTransition heatDeflectionTemp shoreHardnessA shoreHardnessD " +
              "shrinkageXY shrinkageZ spoolWeight netFilamentWeight transmissionDistance " +
              "tdsUrl temperatures",
          )
          .lean()) as typeof parentSummary;
      } else {
        const parentDoc = (await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
          .populate("compatibleNozzles")
          .populate("calibrations.nozzle")
          .populate("calibrations.printer")
          .populate("calibrations.bedType")
          .lean()) as IFilament | null;
        if (parentDoc) {
          resolved = resolveFilament(filament, parentDoc);
          parentSummary = { _id: parentDoc._id, name: parentDoc.name };
        }
      }
    }

    // If this is a parent, include its variants. optTags + secondaryColors
    // are selected so the parent's color-variants list can render finish
    // textures / multi-color swatches without a second fetch per variant.
    //
    // Project the *effective* arrays, not the variant's own: resolveFilament
    // inherits array fields from the parent when the variant's array is
    // empty, so without this merge a variant with `[]` renders wrong here
    // while its own detail page (which goes through resolveFilament) is
    // correct. Mirrors resolveFilament's secondaryColors block + the list
    // aggregation's $project ternary (GH #477).
    const rawVariants = await Filament.find({ parentId: id, _deletedAt: null })
      .select("name color secondaryColors cost optTags")
      .sort({ name: 1 })
      .lean();
    const parentOptTags = (filament.optTags ?? []) as number[];
    const parentSecondaryColors = (filament.secondaryColors ?? []) as string[];
    const variants = rawVariants.map((v) => ({
      ...v,
      optTags: v.optTags && v.optTags.length > 0 ? v.optTags : parentOptTags,
      secondaryColors:
        v.secondaryColors && v.secondaryColors.length > 0
          ? v.secondaryColors
          : parentSecondaryColors,
    }));

    // GH #607: whether THIS row carries its own OpenPrintTag link, computed
    // from the RAW doc before resolveFilament shallow-merges the parent's
    // `settings` — a variant inherits the parent's `openprinttag_slug` in the
    // resolved view, which would show a dead "Check for updates" button (the
    // check/sync routes read the raw child row, which has no slug).
    const rawSlug = (filament.settings as Record<string, unknown> | undefined)?.openprinttag_slug;
    const _hasOwnOptLink = typeof rawSlug === "string" && rawSlug !== "";

    // GH #1103: does this row have children sitting in the TRASH?
    // `_variants` is live-only, so a parent whose variants are ALL trashed
    // reads as a plain standalone — its "Convert to template" action would
    // disappear exactly when the restore route tells users to press it. The
    // flag does NOT make the row a template anywhere else.
    const _hasTrashedVariants =
      (await Filament.countDocuments({
        parentId: id,
        _deletedAt: { $ne: null },
        _purged: { $ne: true },
      })) > 0;

    if (parentSummary) {
      return NextResponse.json({
        ...resolved,
        _variants: variants,
        _parent: parentSummary,
        _hasOwnOptLink,
        _hasTrashedVariants,
      });
    }

    return NextResponse.json({
      ...resolved,
      _variants: variants,
      _hasOwnOptLink,
      _hasTrashedVariants,
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to fetch filament");
  }
}

/**
 * Is `name` already taken by a DIFFERENT active filament — including one the
 * trim migration could not repair? (GH #1116)
 *
 * The ordinary `Filament.exists({ name })` casts, so it cannot see a stored
 * raw `"X "`; renaming onto it therefore passes the check AND does not trip
 * the unique index (the raw strings differ), leaving two active rows that
 * render identically.
 *
 * Self-exclusion is compared in JS, not pushed into the filter: this is a
 * RAW-DRIVER query, where nothing casts, so `{_id: {$ne: "507f…"}}` compares
 * an ObjectId against a string, never matches, and the row fails to exclude
 * ITSELF — every save echoing an unchanged name would 409.
 */
async function nameTakenBySurvivor(
  name: unknown,
  selfId: string,
): Promise<string | null> {
  // Delegates to the shared helper so the CAST normalization lives in exactly
  // one place. Do NOT add a local `typeof name === "string"` gate: a JSON
  // client can send `7`, Mongoose stores "7", and beside a survivor stored as
  // "7 " the raw index admits the duplicate while the guard never looked.
  return survivorNameConflict(
    Filament.collection as unknown as MinimalNameCollection,
    name,
    selfId,
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  try {
    await dbConnect();
    const { id } = await params;
    // GH #605: `promoteParent` is a control flag for the re-parent adoption
    // gate below, never a schema field — capture it, then strip it so it
    // can't ride into the update.
    const promoteParent = body?.promoteParent === true;
    delete body.promoteParent;
    // GH #222 / #1072: drop every SERVER-OWNED field — exact keys AND dotted
    // subpaths. This body feeds findOneAndUpdate, where a dotted key
    // (`spools.0.usageHistory`, `promotionInFlight.token`, …) is a live
    // update path that exact-key deletes miss. The shared field list +
    // per-field rationale live in SERVER_OWNED_FILAMENT_FIELDS
    // (src/lib/requestGuard.ts) so this strip and the POST handler's can't
    // drift.
    stripServerOwnedFields(body);
    // Server-side response-only fields that clients may echo back (e.g. the
    // edit page fetches with ?raw=true and receives _parent / _variants /
    // _inherited). Strip so they don't become persisted document fields.
    delete body._parent;
    delete body._variants;
    delete body._inherited;
    delete body._strippedTemplateFields;

    // A Mongo update OPERATOR ($set / $inc / $rename / …) in the body would
    // be forwarded verbatim to findOneAndUpdate and slip past every
    // field-level guard here — the range check, re-parent validation, and
    // mass-assignment strips all key off top-level fields. Reject
    // operator-style bodies outright (NoSQL-operator-injection guard).
    if (Object.keys(body).some((k) => k.startsWith("$"))) {
      return errorResponse(
        "Update operators (e.g. $set) are not allowed in the request body",
        400,
      );
    }

    // GH #1026: the SECOND injection class the operator check above does not
    // cover — a `__proto__`-prefixed DOTTED key (e.g. `{"__proto__.x": 1}`)
    // is neither a `$`-operator nor an exact key the strip block matches; it
    // reaches Mongoose's update casting and pollutes `Object.prototype`
    // (GHSA-664h-wqgq-64gw). Patched upstream in mongoose >= 9.7.2 (pinned in
    // package.json); this guard keeps a downgraded lockfile or an upstream
    // regression from silently reopening it.
    const unsafePath = assertSafeUpdateBody(body);
    if (unsafePath) return unsafePath;

    // GH #1072: enforce the GH #266 settings-bag caps on the generic PUT —
    // `settings` is Schema.Types.Mixed, so `runValidators: true` below is a
    // no-op for it. Both write shapes are covered: the whole-object form and
    // the dotted `settings.<key>` form (a live Mongoose update path). Dotted
    // paths MERGE into the stored bag rather than replacing it, so their key
    // count is bounded against the stored bag's keys — fetched only when a
    // dotted settings key is present.
    // GH #1070: wire-normalize raw multi-line settings strings BEFORE the
    // caps. The stored bag feeds the echo test (an incoming value byte-equal
    // to the stored one is the form's deliberate legacy-wrap echo and heals;
    // anything else is fresh content whose boundary quotes survive) —
    // fetched only when a raw multi-line settings string is present.
    const storedForWire = bodyHasRawMultilineSettings(body)
      ? (((
          await Filament.findOne({ _id: id, _deletedAt: null })
            .select("settings")
            .lean()
        )?.settings as Record<string, unknown> | undefined) ?? null)
      : null;
    normalizeSettingsToWire(body, storedForWire);
    const bagError = validateSettingsBag(body.settings);
    if (bagError) return errorResponse(bagError, 400);
    // This pre-lock pass is a fast-fail courtesy only — the AUTHORITATIVE
    // dotted-count check re-runs against a fresh stored-bag read INSIDE the
    // runExclusive critical section below, because two concurrent PUTs
    // adding distinct settings.<key> paths near the cap could both observe
    // the same stored key set here and both pass (#1089).
    const hasDottedSettings = Object.keys(body).some((k) =>
      k.startsWith("settings."),
    );
    if (hasDottedSettings) {
      const storedBag = await Filament.findOne({ _id: id, _deletedAt: null })
        .select("settings")
        .lean();
      const dottedError = validateDottedSettingsPaths(
        body,
        Object.keys(
          (storedBag?.settings as Record<string, unknown> | undefined) ?? {},
        ),
      );
      if (dottedError) return errorResponse(dottedError, 400);
    }

    // The legacy top-level `totalWeight` reached findOneAndUpdate
    // unvalidated — the schema's `min: 0` accepts Infinity
    // (`JSON.parse("1e309")`), which overflows aggregates into JSON null.
    // Mirror the POST paths' validateSpoolBody contract: finite non-negative
    // number, or null to clear (#1089).
    if (
      "totalWeight" in body &&
      body.totalWeight !== null &&
      (typeof body.totalWeight !== "number" ||
        !Number.isFinite(body.totalWeight) ||
        body.totalWeight < 0)
    ) {
      return errorResponse(
        "totalWeight must be a non-negative number or null",
        400,
      );
    }

    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
      if (!parent) {
        return errorResponse("Parent filament not found", 400);
      }
      if (parent.parentId) {
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      if (body.parentId === id) {
        return errorResponse("Cannot be your own parent", 400);
      }
      const variantCount = await Filament.countDocuments({ parentId: id, _deletedAt: null });
      if (variantCount > 0) {
        return errorResponse("Cannot set parent on a filament that has variants — remove variants first", 400);
      }
    }

    // GH #519: same cross-collection ref existence check the POST handler
    // runs — without it a PUT could attach phantom refs the GET handler's
    // .populate() then silently drops.
    {
      const nozzleRefs = new Set<string>();
      const printerRefs = new Set<string>();
      const bedRefs = new Set<string>();
      if (Array.isArray(body.compatibleNozzles)) {
        for (const refId of body.compatibleNozzles) {
          if (typeof refId === "string") nozzleRefs.add(refId);
        }
      }
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
    }

    // #574: reject an inverted nozzle temperature range (min > max) —
    // runValidators enforces the per-field 0–600 bounds but not the
    // cross-field relationship. Validate the range that will ACTUALLY be
    // persisted: a dotted/partial update merges into the stored subdoc, so a
    // lone min can combine with a stored max into an inverted range a
    // body-only check would miss. Always fetch the stored endpoints;
    // `effectiveNozzleRangeForUpdate` understands all the update shapes.
    const stored = await Filament.findOne({ _id: id, _deletedAt: null })
      .select("temperatures.nozzleRangeMin temperatures.nozzleRangeMax parentId")
      .lean();
    const rangeUpdate = effectiveNozzleRangeForUpdate(body, stored?.temperatures);
    // A variant inherits missing endpoints from its parent (resolveFilament:
    // own ?? parent), so a lone min can invert against an inherited parent
    // max. The effective range changes only when a range field is touched OR
    // the variant is re-parented — validate only then, since re-validating an
    // unrelated edit could 400 on pre-existing data the user isn't touching.
    const effectiveParentId =
      body.parentId !== undefined ? body.parentId : stored?.parentId;
    const reparenting =
      body.parentId !== undefined &&
      String(body.parentId ?? "") !== String(stored?.parentId ?? "");
    if (rangeUpdate !== null || reparenting) {
      // On a pure re-parent, seed the variant's own range from the stored
      // endpoints (the request carries none) so an existing override is
      // checked against the NEW parent.
      const own =
        rangeUpdate ?? {
          nozzleRangeMin: stored?.temperatures?.nozzleRangeMin ?? null,
          nozzleRangeMax: stored?.temperatures?.nozzleRangeMax ?? null,
        };
      let effRange: ReturnType<typeof effectiveNozzleRangeForUpdate> = own;
      if (effectiveParentId) {
        const parent = await Filament.findOne({ _id: effectiveParentId, _deletedAt: null })
          .select("temperatures.nozzleRangeMin temperatures.nozzleRangeMax")
          .lean();
        effRange = inheritNozzleRangeFromParent(own, parent?.temperatures);
      }
      if (isInvertedNozzleRange(effRange)) {
        return errorResponse(
          "Nozzle range minimum temperature must be less than or equal to the maximum",
          400,
        );
      }

      // Editing a PARENT's range can retroactively invert an inheriting
      // variant's effective range (e.g. lowering the parent's max to 200
      // while a child overrides only its own min to 300). Reject the parent
      // edit if it would invert any inheriting child. Only runs when a range
      // field actually changed (rangeUpdate !== null).
      if (rangeUpdate !== null) {
        const children = await Filament.find({ parentId: id, _deletedAt: null })
          .select("temperatures.nozzleRangeMin temperatures.nozzleRangeMax")
          .lean();
        for (const child of children) {
          const childEffective = inheritNozzleRangeFromParent(
            {
              nozzleRangeMin: child.temperatures?.nozzleRangeMin ?? null,
              nozzleRangeMax: child.temperatures?.nozzleRangeMax ?? null,
            },
            effRange,
          );
          if (isInvertedNozzleRange(childEffective)) {
            return errorResponse(
              "This nozzle range would create an inverted range on an inheriting variant — adjust the variant's override first",
              400,
            );
          }
        }
      }
    }

    // GH #605: a PUT that INTRODUCES a parentId (none → some, or a re-parent
    // to a DIFFERENT parent) can mint that parent's first live variant — the
    // same restructuring event the POST create path gates — so it round-trips
    // the same confirmation: 409 `parent_promotion_required` until the caller
    // repeats the request with `promoteParent: true`. The gate runs LAST,
    // after every other guard PLUS the schema dry-run inside this block, so
    // an otherwise-invalid request gets its 400 before any promotion side
    // effect.
    //
    // Lock ordering: the gate (and a confirmed promotion) runs under the
    // PARENT's key inside gateFirstVariantAdoption; the write section below
    // runs under the TARGET's key. The two are strictly SEQUENTIAL — never
    // held together — because two opposing re-parent PUTs (A→B and B→A)
    // acquiring {parent, target} pairs in opposite orders would deadlock.
    // Residual window: between the parent-lock release and the target-lock
    // write, a concurrent writer could hand the parent new carrying state.
    // The result is a template that still carries legacy state — the
    // pre-#605 shape the enforce-forward posture already tolerates and
    // "Convert to template" recovers, so the window degrades gracefully.
    // A soft-DELETE of the TARGET in that gap is shrunk from both ends (the
    // gate re-checks liveness inside the parent lock via `targetId`; the
    // write section re-checks under the target lock); the microsecond window
    // left between them deliberately stays open — losing it yields a valid,
    // user-confirmed, COMPLETED promotion with no adoption (owner decision:
    // never demote/compensate), and closing it would need the two-key hold
    // ruled out above.
    // `stored` gating: without the target check, a confirmed request could
    // promote the parent and THEN 404 — an irreversible side effect on an
    // error response.
    // When the adoption mints the first variant of a threshold-ONLY parent
    // (nothing gates, so no 409/promotion), the parent's lowStockThreshold
    // becomes dead config — the gate reports it and THIS route clears it,
    // but only AFTER the write section succeeds (parent state change last:
    // an error response, a 404, or the cycle rollback below must leave the
    // parent untouched).
    let clearParentThresholdAfterWrite = false;
    // True once the adoption gate cleared for this request — gates the write
    // section's target-liveness re-check below (only the adoption path can
    // have promoted a parent in between).
    let adoptionGateCleared = false;
    if (stored && body.parentId && reparenting) {
      // Dry-run-validate the target AS IT WOULD BE AFTER this PUT before the
      // gate can promote the parent — the write's `runValidators` fires only
      // AFTER a confirmed adoption has restructured the parent, so a
      // schema-invalid body would surface its 400 with the promotion side
      // effect already irreversible. The update is a plain field object
      // ($-operators rejected above), so `doc.set(body)` on a hydrated,
      // never-saved copy reproduces exactly what findOneAndUpdate would
      // persist; a ValidationError maps to the same 400 shape as the
      // write-time validators (errorResponseFromCaught).
      const dryRunTarget = await Filament.findOne({ _id: id, _deletedAt: null });
      if (!dryRunTarget) {
        // Vanished since the `stored` snapshot — same 404 the write would
        // return, taken here so a confirmed request can't promote first.
        return errorResponse("Not found", 404);
      }
      dryRunTarget.set(body);
      await dryRunTarget.validate();

      // Fail a doomed RENAME before the gate can promote the parent: the
      // unique name constraint is a partial INDEX, not a validator, so a
      // confirmed reparent+rename to a taken name would pass the dry-run,
      // promote the parent, and THEN E11000 at the write. Query shape
      // matches the index semantics (non-deleted, exact name equality) plus
      // self-exclusion, so re-sending the target's OWN current name (the
      // edit form echoes `name` on every save) never false-positives. The
      // 409 is byte-identical to what the write-time E11000 produces via
      // handleDuplicateKeyError, so the client contract is unchanged; a
      // residual TOCTOU window still falls back to that handler.
      const effectiveName =
        typeof body.name === "string" ? body.name : dryRunTarget.name;
      if (
        // name-lookup-ok: the survivor check below covers the cast case
        (await Filament.exists({
          name: effectiveName,
          _deletedAt: null,
          _id: { $ne: id },
        })) ||
        // GH #1116: this has to catch a SURVIVOR too, and HERE — left to the
        // post-gate guard, a confirmed reparent+rename would irreversibly
        // promote the carrying parent and only then 409. Fail-fast before
        // the irreversible bit is this route's own contract.
        (await nameTakenBySurvivor(effectiveName, id))
      ) {
        return errorResponse(
          `A filament with that name already exists: "${effectiveName}"`,
          409,
        );
      }

      const adoption = await gateFirstVariantAdoption(Filament, body.parentId, {
        promoteParent,
        // Reserve the name this document will carry after the PUT (a rename
        // can ride the same request) so the promotion copy can't squat on it.
        adoptedName: typeof body.name === "string" ? body.name : undefined,
        // The target-existence precondition (dryRunTarget above) runs
        // PRE-lock, so a soft-DELETE of this target could land before a
        // confirmed promotion restructures the parent. Passing the target id
        // makes the gate re-check its liveness INSIDE the parent's lock,
        // immediately before performParentPromotion.
        targetId: id,
      });
      if (adoption.outcome === "parent_not_found") {
        // Validated above but vanished (soft-deleted) before the gate —
        // same 400 the pre-lock check would have given.
        return errorResponse("Parent filament not found", 400);
      }
      if (adoption.outcome === "parent_is_variant") {
        // Validated above as a root, but a concurrent PUT re-parented it
        // before the gate's in-lock re-fetch — same no-nesting 400 the
        // pre-lock check produces.
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      if (adoption.outcome === "target_not_found") {
        // This PUT's own target was soft-deleted after the pre-lock checks —
        // caught in-lock BEFORE the promotion, so the parent is untouched.
        return errorResponse("Not found", 404);
      }
      if (adoption.outcome === "promotion_required") {
        return NextResponse.json(promotionRequired409Body(adoption), { status: 409 });
      }
      clearParentThresholdAfterWrite = adoption.clearOrphanedThreshold;
      adoptionGateCleared = true;
    }

    // GH #1116: refuse a rename onto a SURVIVING untrimmed name. The PUT has
    // no name pre-check by design — it lets the write-time E11000 handler
    // produce the 409 — but renaming to "X" while an unresolved active "X "
    // survives does NOT trip the unique index (the raw stored strings
    // differ), so the write would succeed and leave two active rows
    // rendering identically. Trimmed comparison, because that is the
    // question being asked. NON-reparent path (the pre-lock check above only
    // runs when this PUT also re-parents) — same helper, so the two cannot
    // drift.
    if (body.name != null) {
      const survivorId = await nameTakenBySurvivor(body.name, id);
      if (survivorId) {
        // Same shape as this route's duplicate-key 409
        // (`handleDuplicateKeyError`), NOT the sync route's structured
        // `name_taken` envelope — this guard intercepts a case that used to
        // reach the E11000 handler, so it must answer the way that handler
        // does.
        return errorResponse(
          `A filament with that name already exists: "${String(body.name).trim()}"`,
          409,
        );
      }
    }

    // GH #605: a filament with ≥1 live variant is a TEMPLATE and must not
    // carry its own INVENTORY or per-variant color identity. STRIP (don't
    // reject) a non-null write of `totalWeight`, `color`, `colorName`, or
    // `lowStockThreshold`: a form loaded PRE-promotion and saved
    // POST-promotion echoes the promoted-away values back verbatim and would
    // re-materialize them on the template (and a 400 would brick parent
    // edits entirely, since the edit form echoes every field). An explicit
    // null passes through: clearing a legacy parent's leftover value is
    // legitimate cleanup, and blocking it would freeze exactly the state
    // we're trying to migrate away from. The response carries
    // `_strippedTemplateFields` (response-only, underscore-prefixed like
    // _parent/_variants) so a client can surface a warning.
    //
    // `spoolWeight` / `netFilamentWeight` are deliberately NOT stripped:
    // they are SPEC — the product line's tare and nominal net weight — and
    // stay editable on templates, where every variant inherits them
    // (resolveFilament's INHERITABLE_FIELDS; GH #1048).
    //
    // The strip DECISION and the persisting write share one per-id critical
    // section (runExclusive — the same key the promotion paths lock).
    // Decided-then-written across a gap, a totalWeight PUT racing a
    // first-variant promotion could pass the hasVariants check while the
    // parent was still a standalone and then persist AFTER the promotion
    // cleared the parent — re-materializing inventory on a fresh template.

    // The field set lives in the shared TEMPLATE_STRIP_FIELDS
    // (src/lib/templateStrip.ts), used verbatim by the slicer sync-back
    // routes and both INI bulk importers; atlas imports drop the same set
    // with their own per-field notes (import-atlas/route.ts) — keep that
    // mirror in lockstep with the shared list.
    let strippedTemplateFields: string[] = [];
    // Set inside the lock when the in-lock dotted re-validation trips;
    // mapped to a 400 after the critical section.
    let inLockDottedError: string | null = null;
    const filament = await runExclusive(filamentLockKey(id), async () => {
      // On the adoption path, re-check the target is still alive under ITS
      // lock before the adoption write — the parent lock was released above,
      // so a soft-DELETE serialized on this key can win the gap. DELIBERATE
      // (owner decision): the promotion, if it ran, STANDS — a
      // user-confirmed, completed promotion is a valid end state, not
      // corruption, and closing the remaining window would require holding
      // the parent and target locks together (the AB/BA deadlock ruled out
      // above).
      if (adoptionGateCleared) {
        const targetAlive = await Filament.exists({ _id: id, _deletedAt: null });
        if (!targetAlive) return null;
      }
      // AUTHORITATIVE dotted-settings cap check — re-read the stored bag
      // under the SAME lock as the write, so two concurrent PUTs adding
      // distinct keys near the cap serialize through one validate-then-write
      // section. (All same-id settings writers share this lock key.)
      if (hasDottedSettings) {
        const lockedBag = await Filament.findOne({ _id: id, _deletedAt: null })
          .select("settings")
          .lean();
        inLockDottedError = validateDottedSettingsPaths(
          body,
          Object.keys(
            (lockedBag?.settings as Record<string, unknown> | undefined) ?? {},
          ),
        );
        if (inLockDottedError) return null;
      }
      strippedTemplateFields = await stripTemplateFieldsForWrite(Filament, id, body);
      return await Filament.findOneAndUpdate(
        { _id: id, _deletedAt: null },
        body,
        { returnDocument: "after", runValidators: true }
      ).lean();
    });
    if (inLockDottedError) {
      return errorResponse(inLockDottedError, 400);
    }
    if (!filament) {
      return errorResponse("Not found", 404);
    }

    // GH #1004 F7: the parentId validation above is check-then-act — two
    // concurrent re-parent PUTs (A→B and B→A) can each pass validation
    // against pre-write state and both persist, creating a cycle or nested
    // inheritance that every single-level read path (resolveFilament)
    // assumes cannot exist. Re-assert the invariant against POST-write state
    // and, on violation, roll this doc back to a safe root + 409.
    //
    // Runs whenever a NON-NULL parentId is written — NOT only when
    // `reparenting` is true: the edit form echoes `parentId` on every save,
    // so a stale re-save writes back an unchanged parentId, and if a race
    // turned that parent into a variant meanwhile a `reparenting`-gated
    // check would let a nested chain persist. Un-parenting (parentId null)
    // can't create a cycle, so it's skipped.
    if (body.parentId) {
      const [newParent, childCount] = await Promise.all([
        Filament.findOne({ _id: body.parentId, _deletedAt: null }).select("parentId").lean(),
        Filament.countDocuments({ parentId: id, _deletedAt: null }),
      ]);
      const parentIsVariant = !newParent || newParent.parentId != null;
      const gainedChildren = childCount > 0;
      if (parentIsVariant || gainedChildren) {
        // Roll back to a SAFE state — a root (`parentId: null`) — NOT the
        // old parent:
        //   1. A concurrent PUT may have turned the OLD parent into a
        //      variant meanwhile, so restoring it could recreate the nested
        //      inheritance being rejected; a root is always a valid
        //      single-level state.
        //   2. Scope the write to the parent THIS request wrote
        //      (`parentId: body.parentId`) + a live row, so a *newer* valid
        //      re-parent (or delete) that landed since our findOneAndUpdate
        //      isn't clobbered — matchedCount 0, and we still 409.
        // Under any interleaving of two opposing re-parents, at least one
        // side detects the conflict and nulls out.
        await Filament.updateOne(
          { _id: id, parentId: body.parentId, _deletedAt: null },
          { $set: { parentId: null } },
        );
        return errorResponse(
          "Re-parenting conflicts with a concurrent change (it would create nested inheritance or a parent cycle). The filament was left without a parent; re-check and retry.",
          409,
        );
      }
    }

    // The adoption write landed (and the cycle re-assert above didn't roll
    // it back) — clear the threshold-only parent's dead threshold last.
    if (clearParentThresholdAfterWrite) {
      await clearOrphanedParentThreshold(Filament, body.parentId);
    }

    return NextResponse.json(
      strippedTemplateFields.length > 0
        ? { ...filament, _strippedTemplateFields: strippedTemplateFields }
        : filament,
    );
  } catch (err) {
    // Surface duplicate-key errors (rename collision) as a specific 409
    // rather than a generic 500.
    const dupResponse = handleDuplicateKeyError(err, "filament");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to update filament");
  }
}

/**
 * POST /api/filaments/:nameOrId
 *
 * Sync a filament preset back from PrusaSlicer. The param can be a
 * URL-encoded preset name (e.g. "The%20K8%20PC") or a MongoDB ObjectId.
 *
 * Body: { name: string, config: Record<string, string> }
 *
 * Finds the filament by name (falling back to _id), then merges the
 * incoming config keys into the filament's `settings` bag.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  try {
    await dbConnect();
    const { id } = await params;
    const config: Record<string, string> = body.config || {};

    if (!config || Object.keys(config).length === 0) {
      return errorResponse("No config provided", 400);
    }

    // #867: resolve the target filament. The fork's normal sync addresses by
    // the mutable preset NAME, so for a NAME url match the STABLE config
    // `filamentdb_id` FIRST (round-tripped through the export) — resilient
    // to a renamed preset, which otherwise 404s and the fork spawns an
    // orphan that swallows every later edit. The id falls back gracefully
    // when absent/stale (it's DB-instance-specific).
    //
    // An ObjectId URL is EXPLICIT addressing — the URL id is authoritative
    // and a carried filamentdb_id must NOT override it, or a copied/stale id
    // in the config would redirect the write to a different row.
    //
    // `params.id` is ALREADY URL-decoded — re-decoding throws URIError on a
    // name with a literal `%` ("ABS 100%") and 500s the sync (#671).
    const decodedName = id;
    const urlIsObjectId = /^[a-f0-9]{24}$/i.test(id);
    const sentId = typeof config.filamentdb_id === "string" ? config.filamentdb_id.trim() : "";

    let filament = urlIsObjectId
      ? await Filament.findOne({ _id: id, _deletedAt: null })
      : null;
    // True ONLY when the URL ObjectId itself resolved the record (the
    // authoritative form). NOT the same as urlIsObjectId: a 24-hex URL whose
    // _id misses falls through to name/config-id matching below (e.g. a
    // preset legitimately named with 24 hex chars), and renaming THERE (a
    // name-addressed semantic) would be wrong. This is the precise gate for
    // the rename.
    const matchedByUrlObjectId = !!filament;
    let matchedBy: "id" | "name" | null = filament ? "id" : null;
    // True only for a config-filamentdb_id match on a NAME-addressed sync —
    // the sole case where a name divergence is meaningful.
    let matchedByConfigId = false;
    if (!filament) {
      if (/^[a-f0-9]{24}$/i.test(sentId)) {
        filament = await Filament.findOne({ _id: sentId, _deletedAt: null });
        if (filament) {
          matchedBy = "id";
          matchedByConfigId = true;
        }
      }
      if (!filament) {
        // GH #1116: the EXACT stored spelling wins. `decodedName` is the
        // addressing key, and the `trim: true` setter casts this query — so
        // with both "X" and "X " active (an unresolved migration) a preset
        // addressed as "X " would select the CANONICAL row and apply the
        // preset to the wrong filament.
        const exactId = await findExactRawNameId(
          Filament.collection as unknown as MinimalNameCollection,
          decodedName,
          { _deletedAt: null },
        );
        // name-lookup-ok: exact-spelling resolution above covers the cast case
        filament = exactId
          ? await Filament.findOne({ _id: exactId, _deletedAt: null })
          : await Filament.findOne({ name: decodedName, _deletedAt: null });
        if (filament) matchedBy = "name";
      }
      // GH #950: a #872 per-nozzle preset is named "<base> <Ø type [HF]>".
      // When its filamentdb_id is stale/absent AND the full suffixed name
      // misses, retry the BASE name so the sync updates the base filament
      // instead of 404 → the fork spawning a "<base> <hint>" orphan.
      if (!filament) {
        const hint =
          typeof config.filamentdb_nozzle === "string" ? config.filamentdb_nozzle.trim() : "";
        if (hint && decodedName.endsWith(` ${hint}`)) {
          // GH #1116: keep the RAW slice as well as the trimmed one. A
          // per-nozzle preset generated for an unresolved `"X "` is named
          // `"X  0.4 Brass"`, so slicing the hint leaves `"X "` — and
          // `.trim()` here, plus the setter's cast, both land on the
          // CANONICAL `"X"`, writing the legacy row's settings onto the
          // bystander. Resolve the raw slice first; it is unambiguous when
          // it hits, and falls through when it doesn't.
          const rawBase = decodedName.slice(0, -(hint.length + 1));
          const baseName = rawBase.trim();
          if (baseName) {
            const baseExactId = await findExactRawNameId(
              Filament.collection as unknown as MinimalNameCollection,
              rawBase,
              { _deletedAt: null },
            );
            // name-lookup-ok: exact-spelling resolution above covers the cast case
            filament = baseExactId
              ? await Filament.findOne({ _id: baseExactId, _deletedAt: null })
              : await Filament.findOne({ name: baseName, _deletedAt: null });
            if (filament) matchedBy = "name";
          }
        }
      }
    }

    if (!filament) {
      return errorResponse(`Filament not found: ${decodedName}`, 404);
    }

    // #872: a multi-nozzle filament exports as N flat presets named
    // "<base> <Ø type [HF]>", all carrying the base filamentdb_id plus a
    // filamentdb_nozzle hint. Recognize a per-nozzle preset so (a) its
    // suffixed name isn't read as a rename mismatch below, and (b) its
    // calibration routes to the matching per-nozzle entry even without an
    // explicit ?nozzle_diameter= query param (parsed from the hint).
    const perNozzleHint =
      typeof config.filamentdb_nozzle === "string" ? config.filamentdb_nozzle.trim() : "";
    // Recognized for BOTH addressing modes: a name-addressed sync whose URL
    // name is exactly "<base> <hint>", AND an id-addressed sync carrying the
    // hint.
    const isPerNozzlePreset =
      perNozzleHint !== "" &&
      (matchedByUrlObjectId || decodedName === `${filament.name} ${perNozzleHint}`);
    const hintHighFlow = / HF$/i.test(perNozzleHint);
    const hintCore = perNozzleHint.replace(/ HF$/i, "").trim();
    const hintSpace = hintCore.indexOf(" ");
    const hintDiameter = hintSpace > 0 ? parseFloat(hintCore.slice(0, hintSpace)) : NaN;
    const hintType = hintSpace > 0 ? hintCore.slice(hintSpace + 1).trim() : "";
    // #872: the calibration target diameter — the explicit ?nozzle_diameter=
    // query when present, else the per-nozzle hint's. `routeToCalibration`
    // gates whether the preset's baked NOZZLE-SPECIFIC keys (max-vol / temps
    // / fan) land on the matching calibration entry instead of the
    // filament-wide top level — otherwise one nozzle's value overwrites the
    // shared default.
    const nozzleDiameterParam = request.nextUrl.searchParams.get("nozzle_diameter");
    const nozzleDiameter = nozzleDiameterParam
      ? parseFloat(nozzleDiameterParam)
      : isPerNozzlePreset
        ? hintDiameter
        : NaN;
    const routeToCalibration =
      isPerNozzlePreset && !isNaN(nozzleDiameter) && nozzleDiameter > 0;

    // #867: the config filamentdb_id resolves to a filament whose stored
    // name differs from the preset name in the URL. This is EITHER a renamed
    // preset (id is right) OR a copied/cloned id pointing at the WRONG
    // filament — indistinguishable server-side. So DO NOT mutate (a copied
    // id would silently overwrite the source filament); return 409
    // `name_id_mismatch` so the fork can prompt. To update the resolved
    // filament anyway, re-sync by the authoritative ObjectId URL.
    // (matchedByConfigId is only set on a name-addressed config-id match, so
    // ObjectId-URL syncs never reach here.) #872: a recognized per-nozzle
    // preset's suffixed name is EXPECTED, not a rename.
    if (matchedByConfigId && filament.name !== decodedName && !isPerNozzlePreset) {
      return NextResponse.json(
        {
          error: "name_id_mismatch",
          message: `filamentdb_id resolves to "${filament.name}", but the preset is named "${decodedName}". Not updated — confirm before the id wins (re-sync by id to apply).`,
          matchedBy: "id",
          filamentId: String(filament._id),
          matchedName: filament.name,
          sentName: decodedName,
        },
        { status: 409 },
      );
    }

    // Reverse-map PrusaSlicer INI keys → structured DB fields
    const update: Record<string, unknown> = {};
    const temps: Record<string, unknown> = {};

    if (config.filament_type) update.type = config.filament_type;
    if (config.filament_vendor) update.vendor = config.filament_vendor;
    // GH #883: a coextruded filament exports secondaryColors[0] as its
    // single colour key; suppress writing that echo back onto the null
    // primary. GH #913: resolve the parent's secondaryColors so the
    // inherited-coextruded case is detected too.
    if (config.filament_colour) {
      const colorParent = filament.parentId
        ? await Filament.findById(filament.parentId, { secondaryColors: 1 }).lean<{ secondaryColors?: string[] | null } | null>()
        : null;
      const resolvedColor = resolveSyncBackColor(filament, config.filament_colour, colorParent);
      if (resolvedColor !== undefined) {
        update.color = resolvedColor;
        // GH #885: the slicer sends only a hex — when the synced hex
        // actually changes the colour, clear the stale human-readable name
        // (cleared rather than reverse-looked-up: an arbitrary hex won't
        // reliably map to a named colour). Gated on resolvedColor !==
        // undefined so the coextruded-echo suppression doesn't clear it.
        // Compare case-insensitively (#918): the schema accepts mixed-case
        // hex, so `#ff0000` → `#FF0000` isn't a real colour change and must
        // NOT drop the name.
        if (
          typeof filament.color !== "string" ||
          resolvedColor.toLowerCase() !== filament.color.toLowerCase()
        ) {
          update.colorName = null;
        }
      }
    }
    if (config.filament_diameter) { const v = parseFloat(config.filament_diameter); if (!isNaN(v)) update.diameter = v; }
    if (config.filament_density) { const v = parseFloat(config.filament_density); if (!isNaN(v)) update.density = v; }
    if (config.filament_cost) { const v = parseFloat(config.filament_cost); if (!isNaN(v)) update.cost = v; }
    if (config.filament_spool_weight) { const v = parseFloat(config.filament_spool_weight); if (!isNaN(v)) update.spoolWeight = v; }
    // #872: when routing to a per-nozzle calibration entry, these baked
    // nozzle-specific values must NOT also overwrite the filament-wide top
    // level — they join the calibration `calFields` below instead (with a
    // top-level fallback if no calibration target resolves).
    if (config.filament_max_volumetric_speed && !routeToCalibration) { const v = parseFloat(config.filament_max_volumetric_speed); if (!isNaN(v)) update.maxVolumetricSpeed = v; }

    if (!routeToCalibration) {
      if (config.temperature) { const v = parseInt(config.temperature); if (!isNaN(v)) temps.nozzle = v; }
      if (config.first_layer_temperature) { const v = parseInt(config.first_layer_temperature); if (!isNaN(v)) temps.nozzleFirstLayer = v; }
      if (config.bed_temperature) { const v = parseInt(config.bed_temperature); if (!isNaN(v)) temps.bed = v; }
      if (config.first_layer_bed_temperature) { const v = parseInt(config.first_layer_bed_temperature); if (!isNaN(v)) temps.bedFirstLayer = v; }
    }

    if (config.filament_shrinkage_compensation_xy) { const v = parseFloat(config.filament_shrinkage_compensation_xy); if (!isNaN(v)) update.shrinkageXY = v; }
    if (config.filament_shrinkage_compensation_z) { const v = parseFloat(config.filament_shrinkage_compensation_z); if (!isNaN(v)) update.shrinkageZ = v; }

    // GH #1066: `inherits` is a settings-bag SHADOW of the top-level field.
    // Bagging it verbatim let the fork's whole-preset echo re-create a
    // shadow the export's settings seed kept emitting even after the form
    // cleared the top-level value. Lift it like the bulk INI import:
    // "nil"/"" → null (parseIni's nilOrVal convention). `inherits` is in
    // INHERITABLE_FIELDS, so the variant split below treats it like every
    // other structured field. The GH #266 bounded-write cap still applies —
    // a structured write must not become the one uncapped path on the
    // deliberately unauthenticated local/LAN API.
    if (Object.prototype.hasOwnProperty.call(config, "inherits")) {
      const v = config.inherits;
      const lifted = v == null || v === "" || v === "nil" ? null : String(v);
      if (lifted !== null && lifted.length > MAX_SETTING_VALUE_LENGTH) {
        return errorResponse(
          `inherits value exceeds the ${MAX_SETTING_VALUE_LENGTH}-character limit`,
          400,
        );
      }
      update.inherits = lifted;
    }

    // #859: write ONLY the temperature keys PrusaSlicer actually sent, as
    // dotted paths — never a $set of the whole `temperatures` object.
    // Update-validators check every path in the $set, so a
    // `{ ...existing, ...temps }` merge drags the filament's STORED temps
    // into the validated payload; a single legacy out-of-range value then
    // 400s the ENTIRE sync. Dotted paths leave untouched siblings unchanged
    // AND unvalidated, while a genuinely-bad INCOMING value is still
    // rejected.
    for (const [key, value] of Object.entries(temps)) {
      update[`temperatures.${key}`] = value;
    }

    // GH #265: per-nozzle calibration sync must respect variant inheritance.
    // resolveFilament uses the variant's OWN `calibrations` /
    // `compatibleNozzles` when non-empty, else the parent's. So a variant
    // that OVERRIDES calibrations gets the sync written to itself (writing
    // to the parent would land on a document the variant ignores), while an
    // INHERITING variant (empty own array) gets it written to the parent, so
    // inheritance isn't severed by appending a lone entry to the variant.
    // The compatible-nozzle list follows the same rule. Every other field
    // always writes to the filament itself.
    const calParent = filament.parentId
      ? await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
      : null;
    const ownCalibrations = (filament.calibrations as unknown[] | undefined) ?? [];
    const ownCompatNozzles =
      (filament.compatibleNozzles as unknown[] | undefined) ?? [];
    // The document whose `calibrations` array is effective for this
    // filament — and whose `compatibleNozzles` scope the nozzle match.
    const calTarget =
      ownCalibrations.length > 0 || !calParent ? filament : calParent;
    const compatTarget =
      ownCompatNozzles.length > 0 || !calParent ? filament : calParent;
    // The matched calibration entry is recorded here and applied with an
    // atomic per-entry write after the main update — see the write site
    // below (GH #265 / #618).
    let calibrationWrite:
      | { nozzleId: string; fields: Record<string, number | null> }
      | null = null;

    // Update per-nozzle calibration data when a nozzle is resolvable.
    // PrusaSlicer passes ?nozzle_diameter=0.4&high_flow=0|1; high_flow
    // disambiguates e.g. 0.4mm standard vs 0.4mm HF.
    if (!isNaN(nozzleDiameter) && nozzleDiameter > 0) {
      const calFields: Record<string, number | null> = {};
      if (config.extrusion_multiplier) {
        const v = parseFloat(config.extrusion_multiplier);
        if (!isNaN(v)) calFields.extrusionMultiplier = v;
      }
      if (config.pressure_advance_value || config.pressure_advance) {
        const raw = config.pressure_advance_value || config.pressure_advance;
        const v = parseFloat(raw);
        if (!isNaN(v)) calFields.pressureAdvance = v;
      }
      if (config.filament_retract_length) {
        const v = config.filament_retract_length === "nil" ? null : parseFloat(config.filament_retract_length);
        calFields.retractLength = v !== null && !isNaN(v) ? v : null;
      }
      if (config.filament_retract_speed) {
        const v = config.filament_retract_speed === "nil" ? null : parseFloat(config.filament_retract_speed);
        calFields.retractSpeed = v !== null && !isNaN(v) ? v : null;
      }
      if (config.filament_retract_lift) {
        const v = config.filament_retract_lift === "nil" ? null : parseFloat(config.filament_retract_lift);
        calFields.retractLift = v !== null && !isNaN(v) ? v : null;
      }

      // #872: for a per-nozzle preset, the baked nozzle-specific temps /
      // max-vol / fan belong on THIS calibration entry (skipped at the top
      // level above).
      if (routeToCalibration) {
        const numFromConfig = (raw: string | undefined) => {
          if (!raw) return undefined;
          const v = parseFloat(raw);
          return isNaN(v) ? undefined : v;
        };
        const calMap: Record<string, string> = {
          filament_max_volumetric_speed: "maxVolumetricSpeed",
          temperature: "nozzleTemp",
          first_layer_temperature: "nozzleTempFirstLayer",
          bed_temperature: "bedTemp",
          first_layer_bed_temperature: "bedTempFirstLayer",
          min_fan_speed: "fanMinSpeed",
          max_fan_speed: "fanMaxSpeed",
          bridge_fan_speed: "fanBridgeSpeed",
        };
        for (const [cfgKey, calKey] of Object.entries(calMap)) {
          const v = numFromConfig(config[cfgKey]);
          if (v !== undefined) calFields[calKey] = v;
        }
      }

      if (Object.keys(calFields).length > 0) {
        // Find the nozzle by diameter (and optionally high_flow) among the
        // effective compatible nozzles (`compatTarget`).
        const compatIds = (compatTarget.compatibleNozzles || []).map((n: unknown) => String(n));
        if (compatIds.length > 0) {
          const highFlowParam = request.nextUrl.searchParams.get("high_flow");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nozzleQuery: Record<string, any> = {
            _id: { $in: compatIds },
            diameter: nozzleDiameter,
            _deletedAt: null,
          };
          // Only filter by highFlow when the param is explicitly provided, else
          // fall back to the per-nozzle hint's HF flag (#872). A non-HF hint
          // matches `{ $ne: true }` (false OR unset) so a legacy nozzle without
          // the field still resolves; an HF hint requires true.
          if (highFlowParam !== null) {
            nozzleQuery.highFlow = highFlowParam === "1";
          } else if (isPerNozzlePreset) {
            nozzleQuery.highFlow = hintHighFlow ? true : { $ne: true };
          }
          // #872: disambiguate same-diameter nozzles (Brass vs Diamondback)
          // by the hint's type. Case-INSENSITIVE (anchored regex) so it
          // agrees with the /calibration read path's type match — both sides
          // must resolve the same nozzle.
          if (isPerNozzlePreset && hintType) {
            nozzleQuery.type = { $regex: `^${escapeRegex(hintType)}$`, $options: "i" };
          }
          const matchingNozzle = await Nozzle.findOne(nozzleQuery).lean();

          if (matchingNozzle) {
            // The entry lands on whichever document owns this filament's
            // effective calibrations (`calTarget`); both cases defer to the
            // atomic per-entry write below.
            calibrationWrite = {
              nozzleId: String(matchingNozzle._id),
              fields: calFields,
            };
          }
        }

        // #859: when the filament has no matching COMPATIBLE nozzle
        // (commonly an empty `compatibleNozzles`), fall back to the GLOBAL
        // nozzle catalog — mirrors the Bambu/OrcaSlicer sync routes; only
        // when EXACTLY ONE catalog nozzle matches, so we never guess.
        // Without this, EM / pressure-advance edits are silently dropped for
        // any filament with no compatible nozzles set.
        if (!calibrationWrite) {
          const highFlowParam = request.nextUrl.searchParams.get("high_flow");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const globalQuery: Record<string, any> = {
            diameter: nozzleDiameter,
            _deletedAt: null,
          };
          if (highFlowParam !== null) {
            globalQuery.highFlow = highFlowParam === "1";
          } else if (isPerNozzlePreset) {
            globalQuery.highFlow = hintHighFlow ? true : { $ne: true };
          }
          // #872: the hint's type narrows same-diameter catalog nozzles (the
          // bare-diameter query would punt as >1). Case-insensitive,
          // symmetric with the read path.
          if (isPerNozzlePreset && hintType) {
            globalQuery.type = { $regex: `^${escapeRegex(hintType)}$`, $options: "i" };
          }
          const globalMatches = await Nozzle.find(globalQuery).limit(2).lean();
          if (globalMatches.length === 1) {
            calibrationWrite = {
              nozzleId: String(globalMatches[0]._id),
              fields: calFields,
            };
          }
        }

        // #872: the baked nozzle-specific values were skipped at the top
        // level on the assumption they'd land on a calibration entry. If NO
        // nozzle resolved, don't lose them — write the top-level-homed ones
        // (max-vol + temps) back to the filament-wide fields. Fan has no
        // top-level home.
        if (routeToCalibration && !calibrationWrite) {
          if (calFields.maxVolumetricSpeed != null) update.maxVolumetricSpeed = calFields.maxVolumetricSpeed;
          if (calFields.nozzleTemp != null) update["temperatures.nozzle"] = calFields.nozzleTemp;
          if (calFields.nozzleTempFirstLayer != null) update["temperatures.nozzleFirstLayer"] = calFields.nozzleTempFirstLayer;
          if (calFields.bedTemp != null) update["temperatures.bed"] = calFields.bedTemp;
          if (calFields.bedTempFirstLayer != null) update["temperatures.bedFirstLayer"] = calFields.bedTempFirstLayer;
        }
      }
    }

    // Everything else goes into the settings bag. GH #266: bounded
    // merge — caps the key count and per-value size so a sync write
    // can't bloat the embedded `settings` field unboundedly.
    const STRUCTURED_KEYS = new Set([
      "filament_type", "filament_vendor", "filament_colour", "filament_diameter",
      "filament_density", "filament_cost", "filament_spool_weight",
      "filament_max_volumetric_speed", "temperature", "first_layer_temperature",
      "bed_temperature", "first_layer_bed_temperature",
      "filament_shrinkage_compensation_xy", "filament_shrinkage_compensation_z",
      // GH #950: filament_soluble / filament_abrasive are deliberately NOT
      // structured — the schema has no such fields (a Mongoose strict write
      // persisted them NOWHERE). They ride the settings bag, where the
      // exports' settings seed and the OPT encoder read them.
      "filament_settings_id",
      // #867 / #872: routing hints, consumed for matching above and
      // re-emitted on export — never stored in the settings bag (a bag copy
      // would go stale against the canonical _id).
      "filamentdb_id",
      "filamentdb_nozzle",
      // GH #1066: lifted to the top-level field above — a bag copy would
      // shadow a later form-cleared top-level value on export.
      "inherits",
    ]);
    // #872: a per-nozzle preset's nozzle-specific keys (fan, EM,
    // pressure-advance, retraction) must NOT land in the filament-wide
    // settings bag — one nozzle's value would become the shared default for
    // every preset. Gated on `routeToCalibration` alone (NOT
    // calibrationWrite): when a nozzle resolved they ride the calibration
    // entry; when it did NOT, these keys have no top-level home and are
    // dropped rather than allowed to pollute the shared bag.
    if (routeToCalibration) {
      STRUCTURED_KEYS.add("min_fan_speed");
      STRUCTURED_KEYS.add("max_fan_speed");
      STRUCTURED_KEYS.add("bridge_fan_speed");
      STRUCTURED_KEYS.add("extrusion_multiplier");
      STRUCTURED_KEYS.add("pressure_advance");
      STRUCTURED_KEYS.add("pressure_advance_value");
      STRUCTURED_KEYS.add("filament_retract_length");
      STRUCTURED_KEYS.add("filament_retract_speed");
      STRUCTURED_KEYS.add("filament_retract_lift");
    }
    const merge = mergeSlicerSettings(
      (filament.settings as Record<string, unknown>) || {},
      config,
      STRUCTURED_KEYS,
    );
    if (merge.error) {
      return errorResponse(merge.error, 400);
    }
    // GH #1021: a PRE-upgrade fork preset still carries the machine-derived
    // nozzle condition the old export stamped; persisting it would resurrect
    // the hidden-preset bug after the one-shot DB cleanup. Strip it (→ "")
    // when it provenance-matches this filament's effective ticks; a
    // non-matching pure nozzle condition is a user pin and persists. Gated
    // on the SYNC actually sending the key: merge.settings is seeded from
    // the STORED bag, and a partial sync that omits the key must not
    // re-judge — and blank — a post-cleanup pin that legitimately lives
    // there.
    if (Object.prototype.hasOwnProperty.call(config, "compatible_printers_condition")) {
      await stripLegacyMachineCondition(merge.settings, filament);
      // GH #1040: a recognized per-nozzle preset's condition is
      // machine-written by construction (the export bakes it from the hinted
      // nozzle and the fork echoes every key back). Persisting it would
      // freeze ONE sibling's condition into the SHARED settings bag, which
      // the export gate then stamps on every fan-out section. Shape-matched
      // via the same module that emits it, so the two can't drift; a
      // user-authored condition doesn't match and persists.
      if (
        isPerNozzlePreset &&
        Number.isFinite(hintDiameter) &&
        isMachineDerivedPerNozzleCondition(
          merge.settings["compatible_printers_condition"],
          hintDiameter,
        )
      ) {
        merge.settings["compatible_printers_condition"] = "";
      }
    }
    // GH #1066: purge a pre-lift `inherits` shadow still stored in the bag —
    // merge.settings is seeded from the STORED bag, so without this the
    // shadow survives every sync and the export seed keeps emitting it.
    // Mirrors the bulk import's staleSettingsShadowUnset. When a partial
    // sync omitted the key AND the EFFECTIVE top-level value is empty, adopt
    // the shadow's value top-level first so the purge is a pure storage
    // normalization (dropping it without the adopt would change the exported
    // preset's parent). The gate must be the RESOLVED value, not the
    // variant's own field: exports run resolveFilament, so a parent-supplied
    // `inherits` masked the shadow — adopting there would PIN the stale
    // shadow as a variant override and sever GH #106 live inheritance. A
    // ""/"nil" shadow is purged without adopting.
    if (
      typeof merge.settings.inherits === "string" &&
      merge.settings.inherits !== "" &&
      merge.settings.inherits !== "nil" &&
      !("inherits" in update) &&
      !filament.inherits &&
      !calParent?.inherits
    ) {
      update.inherits = merge.settings.inherits;
    }
    delete merge.settings.inherits;
    update.settings = merge.settings;

    // #867 Phase 2: on the AUTHORITATIVE ObjectId path, honor a renamed
    // preset by applying the sent body name — this is what makes the fork's
    // "Update anyway" reconcile STICK (otherwise every later name-addressed
    // sync re-hits name_id_mismatch). The NAME-addressed path deliberately
    // never renames (the name is its addressing key; a body.name there is
    // ignored). #872: a per-nozzle preset's name is the DERIVED suffix,
    // never a user rename — suppress the rename when the sync carries a
    // filamentdb_nozzle hint, or an id-addressed per-nozzle sync would
    // overwrite the base filament's name.
    if (matchedByUrlObjectId && typeof body.name === "string" && perNozzleHint === "") {
      const sentName = body.name.trim();
      if (sentName && sentName !== filament.name) {
        // Refuse if another ACTIVE filament already owns that name — the
        // pre-check turns the write-time E11000 into a friendly 409 (a
        // TOCTOU race still falls back to the E11000 handler below).
        // GH #1116: a MISSED clash fails in the dangerous direction — `name`
        // casts, so renaming to "X" while an unresolved active "X " survives
        // finds nothing here AND does not E11000 (the raw strings differ),
        // leaving two active rows rendering identically. The survivor lookup
        // compares TRIMMED forms, the question the guard is really asking.
        // name-lookup-ok: survivor lookup below covers the cast case
        let clash: { _id: unknown } | null = await Filament.findOne({
          name: sentName,
          _deletedAt: null,
          _id: { $ne: filament._id },
        });
        if (!clash) {
          const survivorId = await survivorNameConflict(
            Filament.collection as unknown as MinimalNameCollection,
            sentName,
            filament._id,
          );
          if (survivorId) clash = { _id: survivorId };
        }
        if (clash) {
          return NextResponse.json(
            {
              error: "name_taken",
              message: `Cannot rename to "${sentName}" — another filament already has that name.`,
              conflictId: String(clash._id),
            },
            { status: 409 },
          );
        }
        update.name = sentName;
        filament.name = sentName; // keep the 200 response's matchedName accurate
      }
    }

    // #872: the per-nozzle calibration writes below are atomic $set/$push
    // updateOne calls that do NOT run schema validators, so a baked
    // out-of-range value (e.g. temperature=900) would persist unchecked.
    // Validate the calibration sub-document UP-FRONT so an invalid value
    // rejects the WHOLE sync with 400 and nothing is written.
    if (calibrationWrite) {
      const probe = new Filament({
        name: filament.name,
        vendor: filament.vendor,
        type: filament.type,
        calibrations: [
          { nozzle: calibrationWrite.nozzleId, printer: null, ...calibrationWrite.fields },
        ],
      });
      try {
        await probe.validate(["calibrations"]);
      } catch (calValidationErr) {
        return errorResponseFromCaught(
          calValidationErr,
          "PrusaSlicer config contained invalid values",
        );
      }
    }

    // GH #951: a variant's export flattens its inherited values through
    // resolveFilament, so the fork echoes the parent's
    // density/cost/temps/… back on every sync. Blindly $set-ing them onto
    // the variant pins each as a local override and severs GH #106 live
    // inheritance. Reuse the CSV importer's split: drop each inheritable
    // field whose incoming value equals the parent's, and $unset a stale
    // local override so inheritance resumes. Variant-only + non-inheritable
    // keys pass through untouched. When `calParent` is null (standalone /
    // missing parent) the update is written verbatim. GH #971: a
    // parent-EQUAL incoming value is indistinguishable from a true inherit
    // on this path, so the presence-based clear is correct here too.
    const mongoUpdate: Record<string, unknown> = { $set: update };
    if (filament.parentId && calParent) {
      const split = splitInheritedImportSet(
        update,
        filament.toObject(),
        calParent.toObject(),
      );
      mongoUpdate.$set = split.set;
      if (split.unset.length > 0) {
        mongoUpdate.$unset = Object.fromEntries(split.unset.map((k) => [k, ""]));
      }
    }

    // GH #618: `runValidators` so the numeric range validators actually fire
    // on a sync — without it `filament_cost = -3` persists a negative cost
    // the regular PUT would reject. `context: "query"` matches the Bambu
    // sync route.
    //
    // GH #605: a TEMPLATE must not re-acquire per-variant color/inventory —
    // the preset echoes `filament_colour` back on every sync (the exact
    // form-echo failure mode the PUT strips). Apply the SAME strip (shared
    // helper; non-null only, explicit nulls pass), decided + written inside
    // the per-id mutex the promotion paths lock, so a concurrent
    // first-variant promotion can't land between the check and this write.
    let strippedTemplateFields: string[] = [];
    try {
      await runExclusive(filamentLockKey(filament._id), async () => {
        const setBody = mongoUpdate.$set as Record<string, unknown>;
        strippedTemplateFields = await stripTemplateFieldsForWrite(
          Filament,
          filament._id,
          setBody,
        );
        // The GH #885 `colorName: null` clear is DERIVED from the color
        // write — when the color write is stripped, its derivation goes with
        // it, or a template holding a legacy color/colorName pair would keep
        // the color but lose the name. (Narrower than the explicit-null
        // pass-through: that covers CLIENT nulls, and this null is one the
        // route itself synthesized from the stripped color.)
        if (strippedTemplateFields.includes("color") && setBody.colorName === null) {
          delete setBody.colorName;
        }
        await Filament.findByIdAndUpdate(
          filament._id,
          mongoUpdate,
          { runValidators: true, context: "query" },
        );
      });
    } catch (validationErr) {
      // A rename that lost a TOCTOU race against a concurrent rename
      // surfaces here as a duplicate-key error — report it as the SAME
      // name_taken 409 shape as the pre-check (incl. conflictId), not a
      // generic 400, so the client sees one consistent contract.
      if (update.name != null && isDuplicateKeyError(validationErr)) {
        // name-lookup-ok: name_taken guard that REFUSES; it never creates
        const clash = await Filament.findOne({ name: update.name, _deletedAt: null });
        return NextResponse.json(
          {
            error: "name_taken",
            message: `Cannot rename to "${String(update.name)}" — another filament already has that name.`,
            ...(clash ? { conflictId: String(clash._id) } : {}),
          },
          { status: 409 },
        );
      }
      return errorResponseFromCaught(
        validationErr,
        "PrusaSlicer config contained invalid values",
      );
    }

    // GH #265 / #618: persist the calibration change on its owning document
    // (`calTarget`) with an ATOMIC per-entry write — never a
    // read-modify-write of the whole `calibrations` array, so two concurrent
    // syncs against the same document can't drop each other's entries.
    if (calibrationWrite) {
      const { nozzleId, fields } = calibrationWrite;
      const setEntry: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(fields)) {
        setEntry[`calibrations.$.${k}`] = v;
      }
      const elemMatch = { calibrations: { $elemMatch: { nozzle: nozzleId, printer: null } } };
      // 1) Update the matching calibration sub-document in place.
      const res = await Filament.updateOne(
        { _id: calTarget._id, ...elemMatch },
        { $set: setEntry },
      );
      if (res.matchedCount === 0) {
        // 2) No entry yet — append one CONDITIONALLY: the filter requires
        // the array to STILL lack a matching element. Not a check-then-act
        // race: MongoDB serialises updates to one _id, so of two racing
        // requests the second's filter no longer matches and it falls
        // through to step 3. At most one (nozzle, printer:null) entry is
        // ever created.
        const inserted = await Filament.updateOne(
          { _id: calTarget._id, calibrations: { $not: { $elemMatch: { nozzle: nozzleId, printer: null } } } },
          { $push: { calibrations: { nozzle: nozzleId, printer: null, ...fields } } },
        );
        if (inserted.matchedCount === 0) {
          // 3) A concurrent request inserted the entry first — apply our
          // fields to it in place so this sync isn't silently lost.
          await Filament.updateOne(
            { _id: calTarget._id, ...elemMatch },
            { $set: setEntry },
          );
        }
      }
    }

    return NextResponse.json({
      message: `Synced ${Object.keys(config).length} settings for "${decodedName}"`,
      filamentId: filament._id,
      // #867: how the filament was resolved + the canonical name, so the
      // fork can re-stamp the id into a name-matched preset. A 200 always
      // means the update WAS applied — a name/id mismatch 409s above
      // without mutating.
      matchedBy,
      matchedName: filament.name,
      // Per-variant fields the template guard refused to apply — same
      // reporting key the PUT uses.
      ...(strippedTemplateFields.length > 0
        ? { _strippedTemplateFields: strippedTemplateFields }
        : {}),
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to sync filament");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { id } = await params;

    // ?permanent=true deletes for real; the regular flow soft-deletes.
    const permanent = request.nextUrl.searchParams.get("permanent") === "true";

    if (permanent) {
      // Permanent delete is only allowed once a filament is already in the
      // trash, so an accidental DELETE?permanent=true on an active filament
      // doesn't bypass the soft-delete safety net.
      const trashed = await Filament.findOne({
        _id: id,
        _deletedAt: { $ne: null },
        _purged: { $ne: true },
      })
        .select("_id spools")
        .lean();
      if (!trashed) {
        return errorResponse(
          "Permanent delete requires the filament to be in the trash. Soft-delete it first.",
          400,
        );
      }
      // Variant guard: permanently deleting a parent would orphan its
      // variants. GH #884: counts ALL non-purged variants (active OR
      // trashed) — there is deliberately no `_deletedAt` clause. Do NOT
      // narrow it to trashed-only: that would let a purge orphan an active
      // variant (a should-not-happen state this still blocks).
      // Already-purged tombstones don't count.
      const variantCount = await Filament.countDocuments({
        parentId: id,
        _purged: { $ne: true },
      });
      if (variantCount > 0) {
        return errorResponse(
          "Cannot permanently delete a filament that still has variants. Permanently delete (or re-parent) those first.",
          400,
        );
      }
      // GH #261/#333: drop this filament's spools from every printer AMS
      // slot BEFORE the purge write. `_purged` is a one-way tombstone — if
      // slot cleanup ran afterwards and failed, the precondition above
      // (`_purged: { $ne: true }`) would reject every retry, leaving
      // dangling slot refs uncleanable forever. Clearing first keeps the
      // operation retryable.
      await clearFilamentSpoolsFromSlots(
        (trashed as { spools?: { _id?: unknown }[] }).spools,
      );
      await clearFilamentFromSlots(id);
      // Don't physically `deleteOne` here. The hybrid sync engine treats
      // "missing on one side" as a fresh insert from the other side, so a
      // hard delete on one peer would get resurrected on the next sync
      // cycle. Instead set the `_purged` tombstone flag; the sync engine
      // propagates it and both sides hide the row for good.
      await Filament.updateOne(
        { _id: id },
        { $set: { _purged: true, _deletedAt: new Date() } },
      );
      return NextResponse.json({ message: "Permanently deleted" });
    }

    // Soft delete — the default path.
    //
    // The hasVariants refusal AND the soft-delete write run as ONE section
    // under the per-filament mutex — the same key the first-variant
    // creation/adoption gates hold (they lock the PARENT's id, which is
    // this id when a parent is being trashed). Unserialized, this
    // check-then-act could interleave with a first-variant POST and yield a
    // TRASHED doc with LIVE variants, breaking the invariant the import
    // resurrect exemptions and the restore guards rely on ("a trashed doc
    // cannot have live variants"). In-lock, both orders end lawful:
    // delete-first makes the gate's in-lock re-fetch answer parent_not_found
    // (the POST 400s); create-first makes this hasVariants re-check refuse.
    // Single key, no nested locks.
    return await runExclusive(filamentLockKey(id), async () => {
      if (await hasVariants(Filament, id)) {
        return errorResponse(
          "Cannot delete a filament that has color variants. Delete the variants first.",
          400,
        );
      }

      const filament = await Filament.findOne({ _id: id, _deletedAt: null })
        .select("_id spools")
        .lean();
      if (!filament) {
        return errorResponse("Not found", 404);
      }
      // GH #261/#333: clear AMS slots BEFORE the soft-delete write. If slot
      // cleanup fails the filament is still active and the DELETE is
      // retryable; clearing afterwards would 404 the retry (`_deletedAt:
      // null` no longer matches) and leave dangling slot refs behind.
      await clearFilamentSpoolsFromSlots(
        (filament as { spools?: { _id?: unknown }[] }).spools,
      );
      await clearFilamentFromSlots(id);
      await Filament.updateOne(
        { _id: id, _deletedAt: null },
        { _deletedAt: new Date() },
      );
      return NextResponse.json({ message: "Deleted" });
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete filament");
  }
}
