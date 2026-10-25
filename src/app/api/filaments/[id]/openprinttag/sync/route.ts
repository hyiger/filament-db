import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  fetchOpenPrintTagDatabase,
  mapToFilamentPayload,
} from "@/lib/openprinttagBrowser";
import {
  buildOptSyncSnapshot,
  buildOptSyncUpdate,
  diffOptFields,
  OPT_MANAGED_FIELD_KEYS,
} from "@/lib/optResync";
import { hasVariants } from "@/lib/resolveFilament";
import { resolveEffectiveFilament } from "@/lib/resolveEffectiveFilament";
import { effectiveOptTagsAwaitReview, type OptTagReviewRow } from "@/lib/optTagLegacy";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * POST /api/filaments/{id}/openprinttag/sync  (GH #607)
 *
 * Applies the user-accepted subset of OpenPrintTag updates to a linked
 * filament. Body: `{ fields: string[] }` from the check endpoint's
 * changelist.
 *
 * Two guards on what can be written:
 *   1. Only keys in OPT_MANAGED_FIELD_KEYS are honoured — an arbitrary path
 *      can't be `$set` through this route.
 *   2. Each requested field must appear in the live `diffOptFields`
 *      changelist — a stale / hand-crafted POST can't push a value OPT
 *      isn't offering (sparse OPT data must never clear good local data).
 *
 * The provenance snapshot is refreshed to the FULL current OPT offer on
 * every sync, regardless of which fields were applied, so a later check can
 * still tell "OPT changed it" from "the user changed it" for declined
 * fields. The one exception is the tags of a row still awaiting numbering
 * review (GH #1227): they were never compared, so their provenance is left
 * as stored (`buildOptSyncSnapshot`).
 *
 * GH #1227: a request naming `optTags` while the row's effective tags still
 * await numbering review is refused with 409 `opt_tags_pending_review`, the
 * same answer the PUT gives a changed array on such a row. The check route
 * lists that change as `pendingReview`, never pre-checked.
 *
 * Responses: 400 not linked / field not offered; 404 slug gone upstream;
 * 409 opt_tags_pending_review; 200 { applied: string[], filament }.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    const { id } = await params;
    // Reject a non-ObjectId id up front (400) instead of a CastError 500
    // (#818).
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
    }

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

    // Fast-path guards on a PRE-lock snapshot (unchanged response contract:
    // a missing/unlinked filament answers without paying the upstream
    // fetch). Everything that feeds the WRITE is re-derived from a fresh
    // snapshot inside the lock below.
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

    // Network fetch stays OUTSIDE the lock — it can take seconds (cached
    // 1h, but cold misses hit GitHub) and must not stall every other
    // serialized operation on this filament's key.
    const db = await fetchOpenPrintTagDatabase();
    if (!db.materials.some((m) => m.slug === slug)) {
      return NextResponse.json(
        { error: "OpenPrintTag material not found", slug },
        { status: 404 },
      );
    }

    // GH #605: the offered-set derivation (which decides whether `color`
    // may land) and the final write are one check-then-act pair —
    // un-serialized, a FIRST variant created in between would promote the
    // parent to a colorless template and this sync would re-attach a color.
    // Run derive→validate→write inside the same per-filament mutex the
    // promotion gate holds, re-fetching + re-deriving hasVariants IN-LOCK,
    // so the variant creation lands strictly before (in-lock diff excludes
    // color → 400) or strictly after (the promotion moves the just-synced
    // color onto the carrying variant).
    return await runExclusive(filamentLockKey(id), async () => {
      const locked = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
      if (!locked) {
        // Soft-deleted between the pre-lock snapshot and the lock — same
        // answer the GH #629 write re-filter gives for the same race.
        return NextResponse.json(
          { error: "Filament was deleted before the sync could complete" },
          { status: 404 },
        );
      }
      const lockedSettings = (locked.settings ?? {}) as Record<string, unknown>;
      const lockedSlug = lockedSettings.openprinttag_slug;
      if (typeof lockedSlug !== "string" || lockedSlug === "") {
        // Unlinked in the window (e.g. a concurrent unlink) — same 400 as
        // the fast path.
        return NextResponse.json(
          { error: "This filament is not linked to an OpenPrintTag material" },
          { status: 400 },
        );
      }
      // Re-resolve against the (possibly re-linked) in-lock slug from the
      // already-fetched upstream db — in-memory, no network under the lock.
      const material = db.materials.find((m) => m.slug === lockedSlug);
      if (!material) {
        return NextResponse.json(
          { error: "OpenPrintTag material not found", slug: lockedSlug },
          { status: 404 },
        );
      }

      const payload = mapToFilamentPayload(material);

      // GH #607: validate each requested field against the SAME diff the
      // check endpoint computes — `buildOptSyncUpdate` alone would let a
      // stale POST of `fields: ["density"]` wipe local density when the
      // upstream material offers nothing there. And validate against the
      // SAME effective (variant→parent) view the check route diffs, passing
      // the same `parentEffective`, so check and sync agree exactly on
      // what's offered — otherwise an inherited field could be offered by
      // one route and rejected by the other.
      const snapshotForDiff = locked.openprinttagSnapshot as Record<string, unknown> | undefined;
      const { effective, parentEffective } = await resolveEffectiveFilament(
        locked as unknown as Record<string, unknown>,
      );
      // GH #605: templates are colorless — the same excludeColor flag the
      // check route uses makes a sync naming `color` for a template fall
      // out of `offered` and 400 as not-offered. Derived IN-LOCK (see the
      // runExclusive rationale above).
      const excludeColor = await hasVariants(Filament, id);
      // GH #1227: derived exactly as the check route derives it (and in-lock,
      // like everything that feeds the write), so both list the same
      // `pendingReview` change.
      const optTagsAwaitReview = effectiveOptTagsAwaitReview(
        locked as unknown as OptTagReviewRow,
        parentEffective as OptTagReviewRow | null,
      );
      const changes = diffOptFields(effective, payload, snapshotForDiff, parentEffective, {
        excludeColor,
        optTagsAwaitReview,
      });
      // GH #1227: unreviewed tags can't be replaced from here (Codex P1 on PR
      // #1237). Whether OPT's spec ids differ from them at all depends on
      // which numbering they are in, which only the user knows; the Data
      // health decision settles that, and the sync works normally after it.
      // Nothing is written, so a request that also names other fields
      // applies none of them.
      if (fields.some((f) => changes.some((c) => c.field === f && c.pendingReview))) {
        return NextResponse.json(
          {
            error: "opt_tags_pending_review",
            message:
              "This filament's tags (its own, or the ones it inherits from its parent) were saved before Filament DB adopted the OpenPrintTag numbering and have not been reviewed, so they can't be compared with OpenPrintTag's. Resolve them under Settings → Data health first, then check for updates again.",
          },
          { status: 409 },
        );
      }
      const offered = new Set(changes.map((c) => c.field));
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
      // GH #1227: on a row whose tags await review the stored tag provenance
      // is kept, and with no snapshot object to keep it in, none is written
      // (the bare link is Data health's `opt-provenance` hint).
      const snapshot = buildOptSyncSnapshot(
        payload,
        locked.openprinttagSnapshot,
        optTagsAwaitReview,
      );

      const $set: Record<string, unknown> = { ...update };
      if (snapshot) $set.openprinttagSnapshot = snapshot;
      // GH #1227: `mapToFilamentPayload` emits spec ids, so a row that adopts
      // OPT's tags is spec-numbered from here on. Only reached for tags that
      // were already settled (an unreviewed row got the 409 above), so the
      // stamp never settles a numbering decision as a side effect.
      if ("optTags" in update) $set.optTagsSpec = true;

      // GH #629: re-filter `_deletedAt: null` on the final write so a
      // concurrent soft-delete can't quietly mutate a tombstoned row (same
      // race the Bambu per-id sync closed) — 404 when trashed in the window.
      const updated = await Filament.findOneAndUpdate(
        { _id: locked._id, _deletedAt: null },
        { $set },
        { returnDocument: "after", runValidators: true, context: "query" },
      ).lean();
      if (!updated) {
        return NextResponse.json(
          { error: "Filament was deleted before the sync could complete" },
          { status: 404 },
        );
      }

      return NextResponse.json({
        applied: Object.keys(update),
        filament: updated,
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to sync OpenPrintTag updates", detail: message },
      { status: 500 },
    );
  }
}
