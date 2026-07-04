import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { generateOrcaSlicerProfiles } from "@/lib/orcaSlicerBundle";
import { resolveSyncBackColor } from "@/lib/prusaSlicerBundle";
import {
  resolveFilamentForExport,
  exportFilenameStem,
} from "@/lib/singleFilamentExport";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { mergeSlicerSettings } from "@/lib/slicerSettings";
import { isUpdateNozzleRangeInverted } from "@/lib/temperatureRange";

/**
 * Top-level body keys that map to structured Filament DB fields.
 * Any other keys are merged into the settings bag for passthrough on
 * next export (so OrcaSlicer-specific settings round-trip cleanly).
 */
const STRUCTURED_KEYS = new Set([
  "type",
  "vendor",
  "color",
  "density",
  "cost",
  "diameter",
  "maxVolumetricSpeed",
  "temperatures",
]);

/** Top-level numeric structured fields — must arrive as finite numbers. */
const NUMERIC_FIELDS = ["density", "cost", "diameter", "maxVolumetricSpeed"] as const;

/** Numeric temperature sub-fields accepted from the sync body. */
const TEMP_FIELDS = [
  "nozzle",
  "nozzleFirstLayer",
  "bed",
  "bedFirstLayer",
  "nozzleRangeMin",
  "nozzleRangeMax",
] as const;

/**
 * GH #618: coerce a numeric body value the way Mongoose casts Number
 * schema paths — accept finite numbers and finite numeric strings,
 * reject everything else. Returns the coerced number, or undefined when
 * the value isn't usable (the caller 400s naming the field). Pre-fix, a
 * body like `cost: "abc"` rode into `$set` verbatim and surfaced as a
 * CastError-500, and objects/Infinity slipped through the same way.
 */
function coerceFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * GET /api/filaments/{id}/orcaslicer
 *
 * Download a single filament as an OrcaSlicer filament-preset (`.json`).
 *
 * Distinct from the bundle route `GET /api/filaments/orcaslicer`, which
 * returns a JSON *array* consumed by the OrcaSlicer FilamentDB module.
 * This route returns one preset object with a download header so the
 * detail-page "Export" button produces a file ready for OrcaSlicer's
 * filament-preset import. Variants are resolved against their parent.
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

    // generateOrcaSlicerProfiles works on an array — take the single
    // profile object, not the [obj] wrapper, so the file imports as one
    // preset rather than a list.
    const profile = generateOrcaSlicerProfiles([filament])[0];
    const stem = exportFilenameStem(filament.name);

    return new NextResponse(JSON.stringify(profile, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stem}.json"`,
      },
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to export filament for OrcaSlicer");
  }
}

/**
 * POST /api/filaments/{id}/orcaslicer
 *
 * Sync filament settings back from OrcaSlicer. Accepts a JSON body with
 * OrcaSlicer config keys and maps them back to Filament DB structured fields.
 *
 * The filament is looked up by name (URL-encoded) or ObjectId.
 * Structured fields are updated on the model; any other top-level keys are
 * stored in the `settings` bag for passthrough on next export.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // Guard JSON parsing — malformed bodies should return 400, not 500
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 }
    );
  }

  try {
    await dbConnect();
    const { id } = await params;

    // GH #950 / #867: a 24-hex param is an ObjectId and is AUTHORITATIVE — try it
    // FIRST, name lookup only when that _id misses (a preset named with 24 hex
    // chars). Name-first let such a name shadow another filament's real _id. The
    // App Router `params.id` is ALREADY URL-decoded — do NOT re-decode (a literal
    // `%` like "ABS 100%" would throw URIError and 500 the sync, #671).
    const decodedName = id;
    let filament = /^[a-f0-9]{24}$/i.test(id)
      ? await Filament.findOne({ _id: id, _deletedAt: null })
      : null;
    if (!filament) {
      filament = await Filament.findOne({ name: decodedName, _deletedAt: null });
    }

    if (!filament) {
      return NextResponse.json(
        { error: `Filament not found: ${decodedName}` },
        { status: 404 }
      );
    }

    // Map OrcaSlicer keys back to DB fields
    const update: Record<string, unknown> = {};

    if (body.type != null) update.type = body.type;
    if (body.vendor != null) update.vendor = body.vendor;
    // GH #883: don't write a coextruded filament's exported secondary back onto
    // its null primary (see resolveSyncBackColor). undefined = leave color alone.
    // GH #913: pass the parent's secondaryColors so an inherited-coextruded
    // variant is detected too.
    if (typeof body.color === "string") {
      const colorParent = filament.parentId
        ? await Filament.findById(filament.parentId, { secondaryColors: 1 }).lean<{ secondaryColors?: string[] | null } | null>()
        : null;
      const resolvedColor = resolveSyncBackColor(filament, body.color, colorParent);
      if (resolvedColor !== undefined) update.color = resolvedColor;
    }

    // GH #618: numeric fields must coerce to finite numbers (numeric
    // strings are accepted, matching the cast Mongoose applies on save).
    // Anything else is a client error — pre-fix `cost: "abc"` threw a
    // CastError that surfaced as a generic 500.
    for (const field of NUMERIC_FIELDS) {
      const v = body[field];
      if (v == null) continue;
      const n = coerceFiniteNumber(v);
      if (n === undefined) {
        return errorResponse(`${field} must be a finite number`, 400);
      }
      update[field] = n;
    }

    // Temperatures — same finite-number coercion per sub-field (GH #618).
    let touchesNozzleRange = false;
    if (body.temperatures && typeof body.temperatures === "object") {
      const src = body.temperatures as Record<string, unknown>;
      const temps: Record<string, unknown> = {};
      for (const field of TEMP_FIELDS) {
        const v = src[field];
        if (v == null) continue;
        const n = coerceFiniteNumber(v);
        if (n === undefined) {
          return errorResponse(`temperatures.${field} must be a finite number`, 400);
        }
        temps[field] = n;
      }
      touchesNozzleRange = "nozzleRangeMin" in temps || "nozzleRangeMax" in temps;
      if (Object.keys(temps).length > 0) {
        update.temperatures = { ...filament.temperatures, ...temps };
      }
    }

    // #574 / GH #618: reject an inverted nozzle range (min > max) the same
    // way the regular PUT does — the per-field 0–600 validators can't catch
    // the cross-field relationship. `update.temperatures` is a full replace
    // built from stored + incoming, so it IS the effective own range; only
    // validate when the sync actually touches an endpoint, so pre-existing
    // bad data can't 400 an unrelated sync. A variant inherits any endpoint
    // it leaves null from its parent (resolveFilament: own ?? parent), so
    // resolve the parent's endpoints in before checking (#577).
    if (touchesNozzleRange) {
      // GH #892: shared combinator (same guard the Bambu routes use) — own
      // effective range + parent inheritance + inversion test in one call.
      let parentTemps = null;
      if (filament.parentId) {
        const parent = await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
          .select("temperatures.nozzleRangeMin temperatures.nozzleRangeMax")
          .lean();
        parentTemps = parent?.temperatures ?? null;
      }
      if (isUpdateNozzleRangeInverted(update, filament.temperatures, parentTemps)) {
        return errorResponse(
          "Nozzle range minimum temperature must be less than or equal to the maximum",
          400,
        );
      }
    }

    // Merge any unknown top-level keys into the settings passthrough bag.
    // GH #266: bounded merge — caps key count and per-value size so a
    // sync write can't bloat the embedded `settings` field unboundedly.
    const merge = mergeSlicerSettings(
      (filament.settings as Record<string, unknown>) || {},
      body,
      STRUCTURED_KEYS,
    );
    if (merge.error) {
      return errorResponse(merge.error, 400);
    }
    const settingsAdded = merge.added;
    // GH #950 (Codex P2 on PR #968 r5): also write when the merge PURGED a stale
    // structured key from the existing bag (`removed`) — otherwise a sync that
    // only changes structured fields discards the cleaned bag and the stale
    // shadow (e.g. a legacy filament_settings_id) survives to shadow the
    // re-derived export value.
    if (settingsAdded.length > 0 || merge.removed.length > 0) {
      update.settings = merge.settings;
    }

    // GH #618: `runValidators` so the #337 numeric range validators fire
    // on an OrcaSlicer sync (negative cost/density, out-of-range temps) —
    // `context: "query"` matches the Bambu sync route (Codex P2 on #387).
    // The shared helper maps a ValidationError to a JSON 400.
    // GH #819: also re-filter `_deletedAt: null` on the write so a concurrent
    // soft-delete in the read→write window can't mutate a now-trashed row —
    // mirrors the Bambu/OPT sync+link sibling routes.
    let updateResult: { matchedCount: number };
    try {
      updateResult = await Filament.updateOne(
        { _id: filament._id, _deletedAt: null },
        { $set: update },
        { runValidators: true, context: "query" },
      );
    } catch (validationErr) {
      return errorResponseFromCaught(
        validationErr,
        "OrcaSlicer profile contained invalid values",
      );
    }
    if (updateResult.matchedCount === 0) {
      return NextResponse.json(
        { error: "Filament was deleted before the sync could complete" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      filament: filament.name,
      updated: Object.keys(update),
      settingsAdded,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to sync from OrcaSlicer", detail: message },
      { status: 500 }
    );
  }
}
