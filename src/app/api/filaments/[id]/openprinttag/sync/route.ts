import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  fetchOpenPrintTagDatabase,
  mapToFilamentPayload,
} from "@/lib/openprinttagBrowser";
import {
  buildOptSnapshot,
  buildOptSyncUpdate,
  diffOptFields,
  OPT_MANAGED_FIELD_KEYS,
} from "@/lib/optResync";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * POST /api/filaments/{id}/openprinttag/sync  (GH #607, Phase 1)
 *
 * Applies the user-accepted subset of OpenPrintTag updates to a linked
 * filament. Body: `{ fields: string[] }` — the field keys (from the check
 * endpoint's changelist) the user chose to adopt.
 *
 * Two guards on what can be written:
 *   1. Only keys in OPT_MANAGED_FIELD_KEYS are honoured — an arbitrary path
 *      can't be `$set` through this route.
 *   2. Each requested field must actually appear in the live `diffOptFields`
 *      changelist — so a stale / hand-crafted POST can't push a value OPT
 *      isn't offering (e.g. wiping local `density` when the upstream
 *      material has `density: null`). Sparse OPT data must never clear good
 *      local data (Codex P2, round 3).
 *
 * The provenance snapshot (`openprinttagSnapshot`) is refreshed to the FULL
 * current OPT offer on every sync, regardless of which fields were applied,
 * so a later check can still tell "OPT changed it" from "the user changed
 * it" for the fields that were declined.
 *
 * Responses:
 *   { error: "not linked" } 400         — no openprinttag_slug on the row
 *   { error: "No current … update" } 400 — a requested field isn't offered
 *   { error: "Material not found" } 404 — slug gone upstream
 *   { applied: string[], filament }     — fields actually written + fresh doc
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    const { id } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const rawFields = (body as { fields?: unknown }).fields;
    if (!Array.isArray(rawFields) || rawFields.some((f) => typeof f !== "string")) {
      return NextResponse.json(
        { error: "Request body must include a 'fields' string array" },
        { status: 400 },
      );
    }
    const fields = rawFields as string[];
    // Reject unknown field keys outright rather than silently dropping them,
    // so a typo in the client surfaces instead of a no-op "success".
    const unknown = fields.filter((f) => !OPT_MANAGED_FIELD_KEYS.has(f));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: `Unknown field(s): ${unknown.join(", ")}` },
        { status: 400 },
      );
    }

    await dbConnect();

    const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const settings = (filament.settings ?? {}) as Record<string, unknown>;
    const slug = settings.openprinttag_slug;
    if (typeof slug !== "string" || slug === "") {
      return NextResponse.json(
        { error: "This filament is not linked to an OpenPrintTag material" },
        { status: 400 },
      );
    }

    const db = await fetchOpenPrintTagDatabase();
    const material = db.materials.find((m) => m.slug === slug);
    if (!material) {
      return NextResponse.json(
        { error: "OpenPrintTag material not found", slug },
        { status: 404 },
      );
    }

    const payload = mapToFilamentPayload(material);

    // GH #607 (Codex P2, round 3): validate each requested field against the
    // SAME diff the check endpoint computes — don't blindly turn the current
    // payload into a $set. `buildOptSyncUpdate` alone would let a stale or
    // hand-crafted POST of e.g. `fields: ["density"]` wipe the user's local
    // density when the upstream material has `density: null`, because OPT
    // offers nothing there. `diffOptFields` intentionally skips that case
    // (sparse OPT data must never clear good local data), so only fields
    // that actually appear in the changelist may be applied.
    const snapshotForDiff = filament.openprinttagSnapshot as Record<string, unknown> | undefined;
    const offered = new Set(
      diffOptFields(filament as unknown as Record<string, unknown>, payload, snapshotForDiff).map(
        (c) => c.field,
      ),
    );
    const notOffered = fields.filter((f) => !offered.has(f));
    if (notOffered.length > 0) {
      return NextResponse.json(
        {
          error: `No current OpenPrintTag update for field(s): ${notOffered.join(", ")}`,
          detail: "These fields are unchanged or not offered upstream. Re-run the check and try again.",
        },
        { status: 400 },
      );
    }

    const update = buildOptSyncUpdate(fields, payload);
    const snapshot = buildOptSnapshot(payload);

    const $set: Record<string, unknown> = {
      ...update,
      openprinttagSnapshot: snapshot,
    };

    const updated = await Filament.findByIdAndUpdate(
      filament._id,
      { $set },
      { returnDocument: "after", runValidators: true, context: "query" },
    ).lean();

    return NextResponse.json({
      applied: Object.keys(update),
      filament: updated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to sync OpenPrintTag updates", detail: message },
      { status: 500 },
    );
  }
}
