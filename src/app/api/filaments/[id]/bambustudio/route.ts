import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { TEMPLATE_NOT_EXPORTABLE } from "@/lib/templateExportFilter";
import { hasVariants } from "@/lib/resolveFilament";
import Filament from "@/models/Filament";
import { generateOrcaSlicerProfiles } from "@/lib/orcaSlicerBundle";
import {
  resolveFilamentForExport,
  exportFilenameStem,
} from "@/lib/singleFilamentExport";
import {
  parseBambuStudioProfile,
  type BambuParseResult,
} from "@/lib/bambuStudioImport";
import { prepareBambuUpdate } from "@/lib/bambuStudioApply";
import {
  assertMultipartFormData,
  checkFileSize,
  errorResponse,
  errorResponseFromCaught,
} from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { stripTemplateFieldsForWrite } from "@/lib/templateStrip";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";

/**
 * GET /api/filaments/{id}/bambustudio — download one filament as a Bambu
 * Studio filament-preset (`.json`).
 *
 * OrcaSlicer and Bambu Studio share the filament-preset JSON schema, so
 * this reuses the OrcaSlicer profile generator with one Bambu-specific
 * tweak: `from` → "User" (Bambu Studio classifies presets by `from`, and
 * the Orca generator's "filament_db" marker isn't recognised as a user
 * preset).
 *
 * No `inherits` is set: it would have to name a base system preset present
 * in *this user's* install, which the server can't know — the exported
 * preset is standalone.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;

    const filament = await resolveFilamentForExport(id);
    if (!filament) {
      return errorResponse("Filament not found", 404);
    }

    // GH: a template is an abstract product line, not printable stock — there
    // is no spool of it to load, so refuse rather than hand the slicer a
    // preset the user can select but never actually have.
    if (await hasVariants(Filament, String(filament._id))) {
      return NextResponse.json(TEMPLATE_NOT_EXPORTABLE, { status: 400 });
    }

    // bakeCalibration: stock Bambu Studio has no dynamic calibration module,
    // so bake the representative calibration into this single preset
    // (GH #950.4).
    const profile = generateOrcaSlicerProfiles([filament], { bakeCalibration: true })[0];
    profile.from = "User";

    const stem = exportFilenameStem(filament.name);

    return new NextResponse(JSON.stringify(profile, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stem}.json"`,
      },
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to export filament for Bambu Studio");
  }
}

/**
 * POST /api/filaments/{id}/bambustudio — sync a Bambu Studio
 * filament-preset (`.json`) INTO this specific filament. The bulk
 * companion (`POST /api/filaments/bambustudio`) upserts by name; this
 * variant pins the target by id, so a renamed preset still updates the
 * right record — the parsed `name` is intentionally ignored.
 *
 * Body: multipart/form-data with a `file` field, OR application/json with
 * the profile directly. Returns the same response shape as the bulk route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // ── Read the JSON body (same dispatch as the bulk route) ──────────
  let raw: unknown;
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    const ctErr = assertMultipartFormData(request);
    if (ctErr) return ctErr;
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse("Failed to read multipart body", 400);
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return errorResponse("multipart upload must include a 'file' field", 400);
    }
    // Cap upload size before `file.text()` materialises the body in memory
    // (same 10 MB cap as the bulk route).
    const sizeErr = checkFileSize(file);
    if (sizeErr) return sizeErr;
    const text = await file.text();
    try {
      raw = JSON.parse(text);
    } catch {
      return errorResponse("Uploaded file is not valid JSON", 400);
    }
  } else if (contentType.includes("application/json")) {
    try {
      raw = await request.json();
    } catch {
      return errorResponse("Invalid JSON in request body", 400);
    }
  } else {
    return errorResponse(
      "Send the Bambu Studio profile as multipart/form-data (file= field) or application/json.",
      400,
    );
  }

  let parsed: BambuParseResult;
  try {
    parsed = parseBambuStudioProfile(raw);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 400);
  }

  try {
    await dbConnect();
    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) {
      return errorResponse("Invalid filament id", 400);
    }

    // ── Pin by id, NOT by parsed.name. The whole point of this route
    //    is that the user has already chosen which filament to update.
    const existing = await Filament.findOne({ _id: id, _deletedAt: null });
    if (!existing) {
      return errorResponse("Filament not found", 404);
    }

    // GH #403: when `existing` is a variant, load its parent so
    // `buildStructuredUpdate` can skip writing inheritable scalars whose
    // parsed value already matches the parent (preserves inheritance).
    let parent: Record<string, unknown> | null = null;
    if (existing.parentId) {
      parent = (await Filament.findOne({
        _id: existing.parentId,
        _deletedAt: null,
      }).lean()) as Record<string, unknown> | null;
    }

    const existingWithParent = {
      // Inheritable scalars MUST ride along so `buildStructuredUpdate` can
      // detect a stale variant override and emit $unset — stripping them
      // makes the unset branch unreachable.
      type: existing.type ?? null,
      vendor: existing.vendor ?? null,
      // GH #883: color + secondaryColors let resolveSyncBackColor detect the
      // coextruded shape and suppress the exported-secondary echo on sync-back.
      color: existing.color ?? null,
      secondaryColors: existing.secondaryColors ?? null,
      diameter: existing.diameter ?? null,
      density: existing.density ?? null,
      cost: existing.cost ?? null,
      maxVolumetricSpeed: existing.maxVolumetricSpeed ?? null,
      shrinkageXY: existing.shrinkageXY ?? null,
      shrinkageZ: existing.shrinkageZ ?? null,
      temperatures: existing.temperatures as Record<string, unknown> | undefined,
      bedTypeTemps: existing.bedTypeTemps,
      settings: existing.settings as Record<string, unknown> | undefined,
      calibrations: existing.calibrations,
      // GH #1021 r14: tick refs for the legacy-condition ingestion guard in
      // prepareBambuUpdate (stripLegacyMachineCondition provenance).
      compatibleNozzles: existing.compatibleNozzles,
      parentId: existing.parentId ? String(existing.parentId) : null,
      parent,
    };

    // GH #893: the shared prepareBambuUpdate keeps this route from drifting
    // from the bulk route / helper.
    const { update, unsetKeys, settingsResult, calibrationOutcome, nozzleRangeInverted } =
      await prepareBambuUpdate(parsed, existingWithParent);
    if (settingsResult.error) {
      return errorResponse(settingsResult.error, 400);
    }
    // GH #892: reject an inverted nozzle range (min > max) like the
    // OrcaSlicer sync route — the per-field validators can't.
    if (nozzleRangeInverted) {
      return errorResponse(
        "Nozzle range minimum temperature must be less than or equal to the maximum",
        400,
      );
    }

    // Never touch spool subdocs on a sync — strictly inventory state, not
    // in the Bambu file.
    delete (update as Record<string, unknown>).spools;

    // When the import value equals the parent's AND the variant carries a
    // diverging local override, unset that field so the variant returns to
    // inheriting.
    const mongoUpdate: Record<string, unknown> = { $set: update };
    if (unsetKeys.length > 0) {
      mongoUpdate.$unset = Object.fromEntries(unsetKeys.map((k) => [k, ""]));
    }

    // `runValidators` so the numeric range validators fire on a Bambu sync.
    // `_deletedAt: null` in the filter so a concurrent soft-delete between
    // the findOne and this write can't quietly mutate a tombstoned row —
    // matchedCount 0 → 404.
    //
    // GH #605: a TEMPLATE must not re-acquire per-variant color/inventory,
    // but the Bambu preset carries `filament_colour`. Apply the SAME strip
    // as the PUT (shared helper; non-null only, explicit nulls pass),
    // decided + written inside the per-id mutex the promotion paths lock.
    // `update` IS mongoUpdate.$set, so the in-place strip reaches the write.
    let strippedTemplateFields: string[] = [];
    let updateRes: { matchedCount: number };
    try {
      updateRes = await runExclusive(filamentLockKey(existing._id), async () => {
        strippedTemplateFields = await stripTemplateFieldsForWrite(
          Filament,
          existing._id,
          update as Record<string, unknown>,
        );
        return await Filament.updateOne(
          { _id: existing._id, _deletedAt: null },
          mongoUpdate,
          { runValidators: true, context: "query" },
        );
      });
    } catch (validationErr) {
      return errorResponseFromCaught(
        validationErr,
        "Bambu Studio profile contained invalid values",
      );
    }
    if (updateRes.matchedCount === 0) {
      return errorResponse(
        "Filament was deleted before the sync could complete",
        404,
      );
    }

    return NextResponse.json({
      created: false,
      updated: true,
      filamentId: String(existing._id),
      name: existing.name,
      calibrationApplied: calibrationOutcome.applied,
      calibrationUnresolved: calibrationOutcome.unresolved || undefined,
      calibrationContext: calibrationOutcome.context || undefined,
      settingsAdded: settingsResult.added,
      // Per-variant fields the template guard refused to apply — same
      // reporting key the PUT uses.
      ...(strippedTemplateFields.length > 0
        ? { _strippedTemplateFields: strippedTemplateFields }
        : {}),
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to sync Bambu Studio profile");
  }
}
