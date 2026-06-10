import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { IFilament } from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import { resolveFilament, hasVariants } from "@/lib/resolveFilament";
import { errorResponse, errorResponseFromCaught, handleDuplicateKeyError, assertActiveRefs } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { mergeSlicerSettings } from "@/lib/slicerSettings";
import { assignSpoolToSlot } from "@/lib/spoolSlots";
import {
  isInvertedNozzleRange,
  effectiveNozzleRangeForUpdate,
  inheritNozzleRangeFromParent,
} from "@/lib/temperatureRange";

/**
 * GH #261: clear every spool of a filament out of all printer AMS slots.
 * Deleting a filament removes its spools, but `Printer.amsSlots[].spoolId`
 * still references them — leaving printers showing a phantom spool that
 * can never be cleared from the (now-gone) spool side. The spool DELETE
 * handler already does this per-spool; the filament DELETE must too.
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
    //
    //   raw=true  → variant edit form. Skip resolveFilament (the form must
    //               see only the variant's own overrides — GH #106) and
    //               attach a slim parent-summary projected to the inheritable
    //               display values FilamentForm consumes for hint placeholders.
    //               Dropping settings/presets/populated nozzles/sync metadata
    //               (__v, syncId, instanceId) cuts ~2KB/request and stops
    //               leaking sync internals to the renderer (GH #162).
    //
    //   raw=false → variant detail page. Run resolveFilament on the populated
    //               parent so inherited fields render correctly, then attach
    //               only `{ _id, name }` for the "Up to <parent>" link.
    let resolved: IFilament | ReturnType<typeof resolveFilament> = filament;
    let parentSummary: { _id: unknown; name?: string; vendor?: string; type?: string; color?: string; cost?: number | null; density?: number | null; diameter?: number | null } | null = null;
    if (filament.parentId) {
      if (raw) {
        parentSummary = (await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
          .select("_id name vendor type color secondaryColors cost density diameter")
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

    // If this is a parent, include its variants.
    // optTags is selected so the color-variants list on the parent's
    // detail page can render finish-derived swatch textures + chips
    // (matte/silk/sparkle/glow/translucent/transparent) without a second
    // fetch per variant — see `src/lib/filamentFinish.ts`.
    //
    // We project the *effective* optTags, not the variant's own array.
    // resolveFilament inherits optTags (and the other array fields) from
    // the parent when the variant's array is empty, so a variant whose
    // own optTags is `[]` should still render with the parent's finish
    // in the parent's color-variants list. Without this merge, the chip
    // is missing here even though clicking through to the variant's
    // detail page shows it (that path goes through resolveFilament).
    // Codex round-1 P2 on PR #353.
    const rawVariants = await Filament.find({ parentId: id, _deletedAt: null })
      // GH #477: secondaryColors so the parent's color-variants chips can
      // render multi-color swatches without a follow-up fetch per variant.
      .select("name color secondaryColors cost optTags")
      .sort({ name: 1 })
      .lean();
    // GH #477 (Codex P2 on PR #482 r2): apply the same array-fallback
    // resolution to `secondaryColors` that we apply to `optTags` —
    // otherwise a variant that inherits its parent's multi-color slots
    // (empty own array) renders single-color on the parent's variant
    // chips while the same variant resolves correctly everywhere else.
    // Mirrors resolveFilament's secondaryColors block + the list
    // aggregation's $project ternary.
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

    // GH #607 (Codex P2 r4): whether THIS row carries its own OpenPrintTag
    // link, computed from the RAW doc before resolveFilament shallow-merges
    // the parent's `settings`. A variant inherits the parent's
    // `openprinttag_slug` in the resolved view, which would otherwise show a
    // dead "Check for updates" button (the check/sync routes read the raw
    // child row, which has no slug). The UI gates the button on this flag.
    const rawSlug = (filament.settings as Record<string, unknown> | undefined)?.openprinttag_slug;
    const _hasOwnOptLink = typeof rawSlug === "string" && rawSlug !== "";

    if (parentSummary) {
      return NextResponse.json({
        ...resolved,
        _variants: variants,
        _parent: parentSummary,
        _hasOwnOptLink,
      });
    }

    return NextResponse.json({ ...resolved, _variants: variants, _hasOwnOptLink });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to fetch filament");
  }
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
    delete body._id;
    delete body._deletedAt;
    // GH #222 (P1 security): `_purged` is a sync-engine tombstone signal,
    // not a client-writable field. Omitting this strip lets a caller send
    // `{ "_purged": true }` in a regular PUT body, which persists the flag
    // on an active (non-trashed) document. On the next hybrid-sync cycle
    // the engine propagates the purge to the peer DB, effectively
    // permanent-deleting the filament across both sides without going
    // through the trash → permanent-delete UI gate that's supposed to
    // require `_deletedAt != null` first. Repro: see the issue body.
    delete body._purged;
    delete body.createdAt;
    delete body.updatedAt;
    delete body.__v;
    delete body.instanceId;
    delete body.syncId;
    // GH #619: server-owned OPT provenance — see the parallel strip in the
    // POST handler. The edit form fetches `?raw=true` and receives this
    // field, so an innocent client echo-back would rewrite provenance; a
    // malicious body could forge `snapshot === current` to flip a user-
    // edited field from `conflict` to pre-checked `adopt` in the re-sync
    // dialog. Only the OPT import/sync routes may write it.
    delete body.openprinttagSnapshot;
    // Server-side response-only fields that clients may echo back (e.g. the
    // edit page fetches with ?raw=true and receives _parent / _variants /
    // _inherited). Strip so they don't become persisted document fields.
    delete body._parent;
    delete body._variants;
    delete body._inherited;
    // GH #260: `spools` is NOT editable through the filament PUT. Spools
    // have dedicated CRUD endpoints (POST/PUT/DELETE /spools/...) that
    // validate via validateSpoolBody — a bulk PUT of the whole `spools`
    // array would bypass that and let a client rewrite a spool's
    // usageHistory ledger, inject a non-numeric totalWeight, etc. The
    // edit form never sends `spools`; strip it as a hard guarantee.
    delete body.spools;

    // Codex P2 on PR #577: the renderer only ever sends a plain field object.
    // A Mongo update OPERATOR ($set / $inc / $rename / …) in the body would be
    // forwarded verbatim to findOneAndUpdate and slip past every field-level
    // guard here — the cross-field range check, the parentId re-parent
    // validation, and the mass-assignment strips above all key off top-level
    // fields. Reject operator-style bodies outright; it closes that whole
    // bypass class and is a latent NoSQL-operator-injection fix.
    if (Object.keys(body).some((k) => k.startsWith("$"))) {
      return errorResponse(
        "Update operators (e.g. $set) are not allowed in the request body",
        400,
      );
    }

    // Validate parentId if provided
    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
      if (!parent) {
        return errorResponse("Parent filament not found", 400);
      }
      // Prevent circular references
      if (parent.parentId) {
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      // Prevent self-reference
      if (body.parentId === id) {
        return errorResponse("Cannot be your own parent", 400);
      }
      // Prevent converting a parent to a variant while it has children
      const variantCount = await Filament.countDocuments({ parentId: id, _deletedAt: null });
      if (variantCount > 0) {
        return errorResponse("Cannot set parent on a filament that has variants — remove variants first", 400);
      }
    }

    // GH #519: same cross-collection ref existence check the POST handler
    // runs (Nozzle / Printer / BedType from compatibleNozzles +
    // calibrations[]). Without this, a PUT could attach phantom refs the
    // GET handler's .populate() then silently drops, leaving the slicer
    // / compare UI looking at calibrations that point at nothing.
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

    // #574: reject an inverted nozzle temperature range (min > max) on edit
    // too. runValidators enforces the per-field 0–600 bounds but not the
    // cross-field min ≤ max relationship.
    //
    // Codex P2 on PR #577: validate the range that will ACTUALLY be persisted.
    // The update can carry the endpoints as a full `temperatures` object
    // (replaces the subdoc), as dotted paths (`temperatures.nozzleRangeMin`),
    // or wrapped in `$set` — and a dotted/partial update merges into the
    // stored subdoc, so a lone min can combine with a stored max into an
    // inverted range a body-only check would miss. Always fetch the stored
    // endpoints (one indexed lookup on an edit) and validate the effective
    // result; `effectiveNozzleRangeForUpdate` understands all the shapes.
    const stored = await Filament.findOne({ _id: id, _deletedAt: null })
      .select("temperatures.nozzleRangeMin temperatures.nozzleRangeMax parentId")
      .lean();
    const rangeUpdate = effectiveNozzleRangeForUpdate(body, stored?.temperatures);
    // Codex P2 r3/r4 on #577: a variant inherits missing endpoints from its
    // parent (resolveFilament: own ?? parent), so a lone min can invert
    // against an inherited parent max. Two ways the effective range changes
    // on edit: a range field is touched, OR the variant is re-parented (which
    // swaps in a new parent's endpoints). Only validate when one of those
    // happens — re-validating an unrelated edit could 400 on pre-existing
    // data the user isn't touching.
    const effectiveParentId =
      body.parentId !== undefined ? body.parentId : stored?.parentId;
    const reparenting =
      body.parentId !== undefined &&
      String(body.parentId ?? "") !== String(stored?.parentId ?? "");
    if (rangeUpdate !== null || reparenting) {
      // On a pure re-parent, seed the variant's own range from the stored
      // endpoints (the request carries none) so an existing override is
      // checked against the NEW parent (Codex P2 r4).
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

      // Codex P2 r5 on #577: editing a PARENT's range can retroactively
      // invert an inheriting variant's effective range — e.g. lowering this
      // parent's max to 200 while a child overrides only its own min to 300
      // leaves the child resolving to 300/200. The edited doc is a root
      // parent when it has variants (no nested inheritance), so its new own
      // range (`own`/`effRange`) is what children inherit. Reject the parent
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

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(filament);
  } catch (err) {
    // Surface MongoDB duplicate-key errors (renaming a filament to a
    // name that already exists) as a specific 409 rather than the
    // generic 500 "Failed to update filament" toast. The POST handler
    // does this already; the PUT was missing it, so users saw a vague
    // error toast on the most common rename-collision case.
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

    // Try to find by name first (PrusaSlicer sends URL-encoded name),
    // then fall back to ObjectId
    const decodedName = decodeURIComponent(id);
    let filament = await Filament.findOne({ name: decodedName, _deletedAt: null });
    if (!filament && /^[a-f0-9]{24}$/i.test(id)) {
      filament = await Filament.findOne({ _id: id, _deletedAt: null });
    }

    if (!filament) {
      return errorResponse(`Filament not found: ${decodedName}`, 404);
    }

    // Reverse-map PrusaSlicer INI keys → structured DB fields
    const update: Record<string, unknown> = {};
    const temps: Record<string, unknown> = {};

    // Core fields
    if (config.filament_type) update.type = config.filament_type;
    if (config.filament_vendor) update.vendor = config.filament_vendor;
    if (config.filament_colour) update.color = config.filament_colour;
    if (config.filament_diameter) { const v = parseFloat(config.filament_diameter); if (!isNaN(v)) update.diameter = v; }
    if (config.filament_density) { const v = parseFloat(config.filament_density); if (!isNaN(v)) update.density = v; }
    if (config.filament_cost) { const v = parseFloat(config.filament_cost); if (!isNaN(v)) update.cost = v; }
    if (config.filament_spool_weight) { const v = parseFloat(config.filament_spool_weight); if (!isNaN(v)) update.spoolWeight = v; }
    if (config.filament_max_volumetric_speed) { const v = parseFloat(config.filament_max_volumetric_speed); if (!isNaN(v)) update.maxVolumetricSpeed = v; }

    // Temperatures
    if (config.temperature) { const v = parseInt(config.temperature); if (!isNaN(v)) temps.nozzle = v; }
    if (config.first_layer_temperature) { const v = parseInt(config.first_layer_temperature); if (!isNaN(v)) temps.nozzleFirstLayer = v; }
    if (config.bed_temperature) { const v = parseInt(config.bed_temperature); if (!isNaN(v)) temps.bed = v; }
    if (config.first_layer_bed_temperature) { const v = parseInt(config.first_layer_bed_temperature); if (!isNaN(v)) temps.bedFirstLayer = v; }

    // Shrinkage
    if (config.filament_shrinkage_compensation_xy) { const v = parseFloat(config.filament_shrinkage_compensation_xy); if (!isNaN(v)) update.shrinkageXY = v; }
    if (config.filament_shrinkage_compensation_z) { const v = parseFloat(config.filament_shrinkage_compensation_z); if (!isNaN(v)) update.shrinkageZ = v; }

    // Flags
    if (config.filament_soluble) update.soluble = config.filament_soluble === "1";
    if (config.filament_abrasive) update.abrasive = config.filament_abrasive === "1";

    // Merge temperatures into existing
    if (Object.keys(temps).length > 0) {
      const existing = (filament.temperatures as Record<string, unknown>) || {};
      update.temperatures = { ...existing, ...temps };
    }

    // GH #265 / Codex P1: per-nozzle calibration sync must respect
    // variant inheritance — but only when the variant actually inherits.
    // resolveFilament uses the variant's OWN `calibrations` /
    // `compatibleNozzles` whenever those arrays are non-empty, and falls
    // back to the parent only when they're empty. So:
    //   - a variant that OVERRIDES calibrations owns them itself → the
    //     sync must write to the variant (writing to the parent would
    //     silently land the change on a document the variant ignores);
    //   - a variant that INHERITS (empty own array) → the sync writes to
    //     the parent, so resolveFilament keeps surfacing it and we don't
    //     sever inheritance by appending a lone entry to the variant.
    // The compatible-nozzle list used for the nozzle match follows the
    // same own-if-set-else-parent rule. Every other field in this sync
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
    // GH #265 (Codex P1) / GH #618: the matched calibration entry is
    // recorded here and applied with an atomic per-entry write after the
    // main update — never a read-modify-write of the whole `calibrations`
    // array, which would lose a concurrent sync's entry for a different
    // nozzle. #265 fixed the parent-targeted case (an inheriting variant
    // syncing its parent); #618 extends the same construction to the
    // own-calibrations case, which used to fold a whole-array $set into
    // the main update.
    let calibrationWrite:
      | { nozzleId: string; fields: Record<string, number | null> }
      | null = null;

    // Update per-nozzle calibration data when nozzle_diameter is provided.
    // PrusaSlicer passes ?nozzle_diameter=0.4&high_flow=0|1 so the API
    // knows which calibration entry to update with EM, PA, retraction, etc.
    // The high_flow flag disambiguates e.g. 0.4mm standard vs 0.4mm HF.
    const nozzleDiameterParam = request.nextUrl.searchParams.get("nozzle_diameter");
    const nozzleDiameter = nozzleDiameterParam ? parseFloat(nozzleDiameterParam) : NaN;
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

      if (Object.keys(calFields).length > 0) {
        // Find the nozzle by diameter (and optionally high_flow) among
        // the effective compatible nozzles (`compatTarget` — the
        // variant's own list when set, else the parent's; see the #265
        // note above). The high_flow param disambiguates e.g. 0.4mm
        // Diamondback vs 0.4mm HF.
        const compatIds = (compatTarget.compatibleNozzles || []).map((n: unknown) => String(n));
        if (compatIds.length > 0) {
          const highFlowParam = request.nextUrl.searchParams.get("high_flow");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nozzleQuery: Record<string, any> = {
            _id: { $in: compatIds },
            diameter: nozzleDiameter,
            _deletedAt: null,
          };
          // Only filter by highFlow when the param is explicitly provided
          if (highFlowParam !== null) {
            nozzleQuery.highFlow = highFlowParam === "1";
          }
          const matchingNozzle = await Nozzle.findOne(nozzleQuery).lean();

          if (matchingNozzle) {
            // GH #265: the entry lands on whichever document owns this
            // filament's effective calibrations (`calTarget` — the
            // filament itself for a standalone or an overriding variant,
            // the parent for an inheriting variant). GH #618: BOTH cases
            // defer to the atomic per-entry write below — the own-document
            // case used to spread `[...calTarget.calibrations]` into the
            // main $set, a read-modify-write that dropped a concurrent
            // sync's entry for a different nozzle.
            calibrationWrite = {
              nozzleId: String(matchingNozzle._id),
              fields: calFields,
            };
          }
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
      "filament_soluble", "filament_abrasive", "filament_settings_id",
    ]);
    const merge = mergeSlicerSettings(
      (filament.settings as Record<string, unknown>) || {},
      config,
      STRUCTURED_KEYS,
    );
    if (merge.error) {
      return errorResponse(merge.error, 400);
    }
    update.settings = merge.settings;

    // GH #618: `runValidators` so the numeric range validators (#337)
    // actually fire on a PrusaSlicer sync — without it a config like
    // `filament_cost = -3` parses clean and persists a negative cost the
    // regular PUT would have rejected. `context: "query"` matches the
    // Bambu sync route (Codex P2 on #387); the shared helper maps a
    // ValidationError to a JSON 400 rather than a generic 500.
    try {
      await Filament.findByIdAndUpdate(
        filament._id,
        { $set: update },
        { runValidators: true, context: "query" },
      );
    } catch (validationErr) {
      return errorResponseFromCaught(
        validationErr,
        "PrusaSlicer config contained invalid values",
      );
    }

    // GH #265 (Codex P1) / GH #618: persist the calibration change on its
    // owning document (`calTarget` — the filament itself or, for an
    // inheriting variant, its parent) with an ATOMIC per-entry write —
    // never a read-modify-write of the whole `calibrations` array, so two
    // syncs hitting the same document concurrently (two variants syncing
    // one parent, or two nozzle contexts syncing one filament) can't drop
    // each other's entries.
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
        // 2) No entry yet — append one CONDITIONALLY. The filter
        // requires the array to STILL lack a matching element. This is
        // not a check-then-act race: MongoDB applies an updateOne to a
        // single document atomically and serialises concurrent updates
        // to the same _id, so of two racing requests the first $pushes
        // and the second re-evaluates this filter against the first's
        // committed write, no longer matches, returns matchedCount 0,
        // and falls through to the in-place $set in step 3. At most one
        // (nozzle, printer:null) entry is ever created (Codex P1).
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

    // ?permanent=true deletes the document for real. Used by the trash UI
    // for "Permanently delete" — the regular flow soft-deletes so users can
    // recover from a misclick.
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
      // Variant guard still applies — although a parent in trash can't
      // have active variants (the original soft-delete refused), it could
      // theoretically have other trashed variants pointing at it.
      // Permanently deleting the parent would orphan them, so block. Only
      // count variants that are themselves still in the trash and not yet
      // purged — already-purged variant tombstones are dead weight.
      const variantCount = await Filament.countDocuments({
        parentId: id,
        _purged: { $ne: true },
      });
      if (variantCount > 0) {
        return errorResponse(
          "Cannot permanently delete a filament that still has variants in the trash. Permanently delete those first.",
          400,
        );
      }
      // GH #261/#333: drop this filament's spools from every printer AMS
      // slot BEFORE the purge write. `_purged` is a one-way tombstone — if
      // slot cleanup ran afterwards and failed, the precondition above
      // (`_purged: { $ne: true }`) would reject every retry, leaving the
      // dangling slot refs uncleanable forever. Clearing first keeps the
      // operation retryable: a failure here leaves the filament in the
      // trash, exactly the state the retry expects.
      await clearFilamentSpoolsFromSlots(
        (trashed as { spools?: { _id?: unknown }[] }).spools,
      );
      // Don't physically `deleteOne` here. The hybrid sync engine pairs
      // docs across peers by syncId and treats "missing on one side" as a
      // fresh insert from the other side — so a hard delete on one peer
      // would get resurrected from the trash on the next sync cycle (codex
      // PR #213 #discussion). Instead, set the `_purged` tombstone flag;
      // the sync engine propagates it to the peer, both sides hide the row
      // from every UI surface, and the row stays gone for good.
      await Filament.updateOne(
        { _id: id },
        { $set: { _purged: true, _deletedAt: new Date() } },
      );
      return NextResponse.json({ message: "Permanently deleted" });
    }

    // Soft delete — the default path.
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
    // GH #261/#333: drop this filament's spools from every printer AMS slot
    // BEFORE the soft-delete write. If slot cleanup fails the filament is
    // still active and the whole DELETE is retryable; clearing afterwards
    // would 404 the retry (`_deletedAt: null` no longer matches) and leave
    // dangling slot refs behind.
    await clearFilamentSpoolsFromSlots(
      (filament as { spools?: { _id?: unknown }[] }).spools,
    );
    await Filament.updateOne(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
    );
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete filament");
  }
}
