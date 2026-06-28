import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
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
import {
  buildStructuredUpdate,
  resolveAndApplyCalibration,
} from "@/lib/bambuStudioApply";
import {
  assertMultipartFormData,
  checkFileSize,
  errorResponse,
  errorResponseFromCaught,
} from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { mergeSlicerSettings } from "@/lib/slicerSettings";

/**
 * GET /api/filaments/{id}/bambustudio
 *
 * Download a single filament as a Bambu Studio filament-preset (`.json`).
 *
 * OrcaSlicer is a fork of Bambu Studio and the two share the filament-
 * preset JSON schema (same keys, same single-element-array value
 * convention). So this route reuses the OrcaSlicer profile generator and
 * applies the one meaningful Bambu-specific tweak:
 *
 *   `from` → "User"
 *
 * Bambu Studio classifies presets by their `from` field — "User" marks a
 * user-created preset (which is what an exported filament is). The
 * OrcaSlicer generator stamps a custom "filament_db" marker there, which
 * Bambu Studio doesn't recognise as a user preset.
 *
 * No `inherits` is set: that would have to name a base system preset
 * present in *this user's* Bambu Studio install, which the server can't
 * know. The exported preset is therefore standalone — it imports fine
 * via Bambu Studio's custom-filament import, the user just won't get
 * system-preset inheritance.
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

    const profile = generateOrcaSlicerProfiles([filament])[0];
    // Bambu-specific: mark as a user preset so Bambu Studio files it
    // under the user's custom filaments on import.
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
 * POST /api/filaments/{id}/bambustudio
 *
 * Sync a Bambu Studio filament-preset (`.json`) INTO this specific
 * filament — the bulk companion is `POST /api/filaments/bambustudio`,
 * which upserts by name; this variant pins the target by id so a UI
 * "Sync from Bambu Studio" button on the filament detail page can
 * update the filament the user is already looking at, even if the
 * Bambu file's `filament_settings_id` doesn't match (renamed in the
 * slicer, lost the link to the app's record, etc.).
 *
 * Body: multipart/form-data with a `file` field, OR application/json
 * with the Bambu profile directly. The handler:
 *   1. Parses the profile (shared parser with the bulk route).
 *   2. Applies structured fields, settings-bag passthrough, and
 *      calibration hints to the EXISTING filament identified by id.
 *      The parsed `name` field is intentionally ignored — pinning is
 *      by id, not by name.
 *   3. Returns the same response shape as the bulk route so the UI
 *      can render either outcome uniformly.
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
    // Codex P2 on PR #387 round 2: cap upload size before `file.text()`
    // materialises the body in memory. Same 10 MB cap as the bulk route
    // and the existing /api/filaments/import* family.
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
    // `buildStructuredUpdate` can detect inheritable scalars whose
    // parsed value already matches the parent and skip writing them
    // (preserves inheritance). Lookup is a no-op for root filaments.
    let parent: Record<string, unknown> | null = null;
    if (existing.parentId) {
      parent = (await Filament.findOne({
        _id: existing.parentId,
        _deletedAt: null,
      }).lean()) as Record<string, unknown> | null;
    }

    const existingWithParent = {
      // Codex P1 on PR #473 round 2: inheritable scalars MUST ride
      // along so `buildStructuredUpdate` can detect a stale variant
      // override and emit $unset. Pre-fix these were stripped, leaving
      // the unset branch unreachable in this route.
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
      parentId: existing.parentId ? String(existing.parentId) : null,
      parent,
    };

    const { set: update, unset: unsetKeys } = buildStructuredUpdate(
      parsed.filament,
      existingWithParent,
    );

    const settingsResult = mergeSlicerSettings(
      (existing.settings as Record<string, unknown>) || {},
      parsed.filament.settings,
      new Set(Object.keys(parsed.filament.settings).filter(() => false)),
    );
    if (settingsResult.error) {
      return errorResponse(settingsResult.error, 400);
    }
    if (settingsResult.added.length > 0) {
      update.settings = settingsResult.settings;
    }

    const calibrationOutcome = await resolveAndApplyCalibration(
      parsed.filament,
      parsed.calibrationHints,
      update,
      existing,
    );

    // Never touch spool subdocs on a sync — that's strictly inventory
    // state and not in the Bambu file.
    delete (update as Record<string, unknown>).spools;

    // Codex P1 on PR #473: when the import value equals the parent's
    // value AND the variant carries a diverging local override, unset
    // that field so the variant returns to inheriting. `$unset` payload
    // value is conventionally the empty string in Mongo.
    const mongoUpdate: Record<string, unknown> = { $set: update };
    if (unsetKeys.length > 0) {
      mongoUpdate.$unset = Object.fromEntries(unsetKeys.map((k) => [k, ""]));
    }

    // Codex P2 on PR #387: `runValidators` so the new numeric range
    // validators (#337) actually fire on a Bambu sync.
    //
    // Codex P2 on PR #387 round 6: also include `_deletedAt: null` in
    // the filter so a concurrent soft-delete between the findOne above
    // and this write doesn't quietly mutate a tombstoned row and
    // return updated:true. Check matchedCount and 404 if the row was
    // removed in the race.
    let updateRes: { matchedCount: number };
    try {
      updateRes = await Filament.updateOne(
        { _id: existing._id, _deletedAt: null },
        mongoUpdate,
        { runValidators: true, context: "query" },
      );
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
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to sync Bambu Studio profile");
  }
}
