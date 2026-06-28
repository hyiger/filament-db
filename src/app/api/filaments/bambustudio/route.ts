import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  parseBambuStudioProfile,
  type BambuParseResult,
} from "@/lib/bambuStudioImport";
import { prepareBambuUpdate, type BambuUpdatePayload } from "@/lib/bambuStudioApply";
import {
  assertMultipartFormData,
  checkFileSize,
  errorResponse,
  errorResponseFromCaught,
  isDuplicateKeyError,
} from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * Per-phase validation gate for a prepared Bambu update: the settings-bag
 * size-cap error AND the GH #892 inverted-nozzle-range guard (min > max, which
 * the per-field 0–600 schema validators can't express — matching the OrcaSlicer
 * sync route). Returns a 400 response, or null when the payload is clean. Used
 * at every upsert phase so the guard can't be dropped from one of them.
 */
function bambuPayloadError(payload: BambuUpdatePayload): NextResponse | null {
  if (payload.settingsResult.error) {
    return errorResponse(payload.settingsResult.error, 400);
  }
  if (payload.nozzleRangeInverted) {
    return errorResponse(
      "Nozzle range minimum temperature must be less than or equal to the maximum",
      400,
    );
  }
  return null;
}

/**
 * POST /api/filaments/bambustudio
 *
 * Import a Bambu Studio filament-preset (`.json`). Companion to the
 * existing per-id export at `GET /api/filaments/{id}/bambustudio`; the
 * pair gives Bambu users a full round-trip (export from the app, edit
 * + calibrate in Bambu Studio, re-import the calibrated values).
 *
 * The route accepts the file two ways:
 *   - `multipart/form-data` with a `file` field (UI flow)
 *   - `application/json` with the Bambu profile as the body (script flow)
 *
 * Upsert key is the filament name, derived from `filament_settings_id`
 * (preferred — that's what the slicer treats as the preset name) or
 * top-level `name` (matches the export-side filename stem). Existing
 * filaments are updated; missing ones are created. Spool data,
 * usageHistory and dryCycles on an existing filament are NEVER touched.
 *
 * Calibration handling (the design decision from the import discussion):
 *   1. Parse the Bambu JSON for calibration values + a printer hint
 *      (`printer_settings_id`, format roughly "Vendor Model 0.4 nozzle").
 *   2. If a Printer doc matches that hint AND has a unique nozzle at the
 *      hinted diameter, write the values to a calibrations[] row tagged
 *      with that (printer, nozzle) pair.
 *   3. Otherwise the maxVolumetricSpeed lift carries through as a top-
 *      level update and the per-nozzle-only values are skipped with a
 *      `calibrationUnresolved` flag on the response, so the caller knows
 *      to surface a nudge.
 *
 * Returns: `{ created, updated, filamentId, calibrationApplied,
 *   calibrationUnresolved?, settingsAdded }` so the UI can show a clear
 * outcome instead of a vague "imported".
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // ── Read the JSON body ─────────────────────────────────────────────
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
    // Codex P2 on PR #387 round 2: cap upload size BEFORE reading.
    // `file.text()` materialises the entire body into memory; without
    // this guard a multi-GB upload would happily exhaust the server.
    // Matches the existing 10 MB cap used by /api/filaments/import* and
    // /api/filaments/parse-ini.
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

  // ── Parse ──────────────────────────────────────────────────────────
  let parsed: BambuParseResult;
  try {
    parsed = parseBambuStudioProfile(raw);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 400);
  }

  try {
    await dbConnect();

    const name = parsed.filament.name;

    // ── Three-phase upsert ─────────────────────────────────────────────
    // Pattern mirrors `src/app/api/filaments/import/route.ts` (#327):
    //   1. update an existing ACTIVE row
    //   2. resurrect a TRASHED (non-purged) row
    //   3. create — handling the E11000 race against a concurrent create
    //
    // Each phase uses an atomic `findOneAndUpdate` guarded by the doc's
    // `_id` (and the soft-delete state at the time it was read) so a
    // concurrent soft-delete / purge / restore can't slip through the
    // findOne→write window. `runValidators: true` so the GH #337 numeric
    // validators fire on every write path (Codex P2 round 2).
    //
    // The merge logic in `prepareBambuUpdate` depends on the existing
    // doc (settings carry-over + calibration row dedup), so we have to
    // recompute the payload per phase against whatever `existing` we
    // resolved.

    // Phase 1 — active update.
    const existingActive = await Filament.findOne({
      name,
      _deletedAt: null,
    });
    if (existingActive) {
      const payload = await prepareBambuUpdate(
        parsed,
        await augmentExistingWithParent(existingActive),
      );
      const payloadError = bambuPayloadError(payload);
      if (payloadError) return payloadError;
      delete (payload.update as Record<string, unknown>).spools;
      try {
        const updated = await Filament.findOneAndUpdate(
          { _id: existingActive._id, _deletedAt: null },
          composeMongoUpdate(payload),
          { runValidators: true, context: "query", returnDocument: "after" },
        );
        if (updated) {
          return importResponse(updated, false, payload);
        }
      } catch (validationErr) {
        return errorResponseFromCaught(
          validationErr,
          "Bambu Studio profile contained invalid values",
        );
      }
      // Phase-1 update returned null → the row was deleted between our
      // findOne and the atomic write. Fall through to phase 2 / 3.
    }

    // Phase 2 — resurrect a trashed (non-purged) row of the same name
    // rather than creating a duplicate that would strand the trashed
    // record (its restore would 409 forever on the name conflict).
    // (Codex P1 on PR #387 round 5.)
    const existingTrashed = await Filament.findOne({
      name,
      _deletedAt: { $ne: null },
      _purged: { $ne: true },
    });
    if (existingTrashed) {
      const payload = await prepareBambuUpdate(
        parsed,
        await augmentExistingWithParent(existingTrashed),
      );
      const payloadError = bambuPayloadError(payload);
      if (payloadError) return payloadError;
      delete (payload.update as Record<string, unknown>).spools;
      try {
        // Splice `_deletedAt: null` into the $set body so the resurrect
        // atomic also drops the tombstone; $unset (if any) for stale
        // variant overrides composes alongside.
        const resurrectUpdate = composeMongoUpdate(payload);
        resurrectUpdate.$set = {
          ...(resurrectUpdate.$set as Record<string, unknown>),
          _deletedAt: null,
        };
        const resurrected = await Filament.findOneAndUpdate(
          {
            _id: existingTrashed._id,
            _deletedAt: { $ne: null },
            _purged: { $ne: true },
          },
          resurrectUpdate,
          { runValidators: true, context: "query", returnDocument: "after" },
        );
        if (resurrected) {
          return importResponse(resurrected, false, payload);
        }
      } catch (validationErr) {
        return errorResponseFromCaught(
          validationErr,
          "Bambu Studio profile contained invalid values",
        );
      }
      // Phase-2 returned null → the row was purged or restored between
      // findOne and write. Fall through to phase 3.
    }

    // Phase 3 — create. Required fields (vendor + type) must be present
    // in the Bambu profile or the create can't satisfy the schema.
    if (!parsed.filament.type) {
      return errorResponse(
        "Bambu Studio profile is missing filament_type — required to create a new filament",
        400,
      );
    }
    if (!parsed.filament.vendor) {
      return errorResponse(
        "Bambu Studio profile is missing filament_vendor — required to create a new filament",
        400,
      );
    }

    const createPayload = await prepareBambuUpdate(parsed, null);
    const createPayloadError = bambuPayloadError(createPayload);
    if (createPayloadError) return createPayloadError;
    try {
      const created = await Filament.create({
        name,
        ...createPayload.update,
      });
      return importResponse(created, true, createPayload);
    } catch (createErr) {
      // Codex P2 on PR #387 round 5: another concurrent import created
      // a row with the same name between our phase-1 findOne and our
      // create. Recompute the payload against THAT row (its settings
      // and calibrations[] differ from the null baseline used above)
      // and update it as if we'd taken the phase-1 path.
      if (!isDuplicateKeyError(createErr)) {
        return errorResponseFromCaught(createErr, "Failed to create filament");
      }
      const racing = await Filament.findOne({ name, _deletedAt: null });
      if (!racing) {
        // The winning row was already deleted; bail out with the
        // original error rather than spinning.
        return errorResponseFromCaught(createErr, "Failed to create filament");
      }
      const racePayload = await prepareBambuUpdate(
        parsed,
        await augmentExistingWithParent(racing),
      );
      const racePayloadError = bambuPayloadError(racePayload);
      if (racePayloadError) return racePayloadError;
      delete (racePayload.update as Record<string, unknown>).spools;
      try {
        const merged = await Filament.findOneAndUpdate(
          { _id: racing._id, _deletedAt: null },
          composeMongoUpdate(racePayload),
          { runValidators: true, context: "query", returnDocument: "after" },
        );
        if (!merged) {
          return errorResponseFromCaught(createErr, "Failed to create filament");
        }
        return importResponse(merged, false, racePayload);
      } catch (validationErr) {
        return errorResponseFromCaught(
          validationErr,
          "Bambu Studio profile contained invalid values",
        );
      }
    }
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to import Bambu Studio profile");
  }
}

/**
 * GH #403: load the parent doc when `existing` is a variant, so
 * `prepareBambuUpdate` → `buildStructuredUpdate` can skip pinning
 * inheritable scalars whose parsed value already matches the parent
 * (keeps inheritance live). A no-op for root filaments.
 */
async function augmentExistingWithParent(existing: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}) {
  let parent: Record<string, unknown> | null = null;
  if (existing.parentId) {
    parent = (await Filament.findOne({
      _id: existing.parentId,
      _deletedAt: null,
    }).lean()) as Record<string, unknown> | null;
  }
  return {
    // Codex P1 on PR #473 round 2: inheritable scalars MUST ride along
    // so `buildStructuredUpdate` can detect a stale variant override
    // (variant=1.30, parent=1.24, import=1.24 → emit $unset). Pre-fix
    // these were stripped, making the $unset branch unreachable in
    // the actual route even though unit tests passed against a richer
    // shape.
    type: existing.type ?? null,
    vendor: existing.vendor ?? null,
    // GH #883: ride color + secondaryColors along so resolveSyncBackColor can
    // detect the coextruded shape and suppress the exported-secondary echo.
    color: existing.color ?? null,
    secondaryColors: existing.secondaryColors ?? null,
    diameter: existing.diameter ?? null,
    density: existing.density ?? null,
    cost: existing.cost ?? null,
    maxVolumetricSpeed: existing.maxVolumetricSpeed ?? null,
    shrinkageXY: existing.shrinkageXY ?? null,
    shrinkageZ: existing.shrinkageZ ?? null,
    temperatures: existing.temperatures,
    bedTypeTemps: existing.bedTypeTemps,
    settings: existing.settings,
    calibrations: existing.calibrations,
    parentId: existing.parentId ? String(existing.parentId) : null,
    parent,
  };
}

/** Codex P1 on PR #473: when the parsed Bambu value equals the parent
 *  and the variant carries a stale local override, `prepareBambuUpdate`
 *  flags those fields in `unsetKeys` so they can be cleared. Compose a
 *  Mongo update body that carries both `$set` and (when needed) `$unset`
 *  in one atomic write — the resurrection branch then splices
 *  `_deletedAt: null` into the `$set` portion. */
function composeMongoUpdate(
  payload: Awaited<ReturnType<typeof prepareBambuUpdate>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { $set: payload.update };
  if (payload.unsetKeys.length > 0) {
    out.$unset = Object.fromEntries(payload.unsetKeys.map((k) => [k, ""]));
  }
  return out;
}

/** Common response shape so all three upsert phases return the same
 * envelope. */
function importResponse(
  doc: { _id: unknown; name: string },
  created: boolean,
  payload: Awaited<ReturnType<typeof prepareBambuUpdate>>,
) {
  return NextResponse.json({
    created,
    updated: !created,
    filamentId: String(doc._id),
    name: doc.name,
    calibrationApplied: payload.calibrationOutcome.applied,
    calibrationUnresolved: payload.calibrationOutcome.unresolved || undefined,
    calibrationContext: payload.calibrationOutcome.context || undefined,
    settingsAdded: payload.settingsResult.added,
  });
}

// ─── Helpers live in src/lib/bambuStudioApply.ts so the per-id route
//     (POST /api/filaments/[id]/bambustudio) can share them.
