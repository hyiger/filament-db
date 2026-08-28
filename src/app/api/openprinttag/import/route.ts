import { NextRequest, NextResponse } from "next/server";
import {
  findSurvivorId,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  fetchOpenPrintTagDatabase,
  mapToFilamentPayload,
} from "@/lib/openprinttagBrowser";
import {
  buildOptLinkUpdate,
  buildOptSnapshot,
  pruneOptPayloadAgainstParent,
} from "@/lib/optResync";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { isDuplicateKeyError } from "@/lib/apiErrorHandler";
import {
  createVariantGated,
  promotionRequired409Body,
} from "@/lib/createVariantGated";
import { stripTemplateFieldsForWrite } from "@/lib/templateStrip";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";

/**
 * POST /api/openprinttag/import
 *
 * Import selected OpenPrintTag materials into Filament DB.
 *
 * Request body: { slugs: string[], parentId?: string }
 *
 * Bulk mode (no `parentId`): for each slug, the material is fetched from the
 * cached OpenPrintTag database, mapped to the Filament schema, and created or
 * updated (upsert by name + vendor).
 *
 * Variant mode (`parentId` set — Issue #753): imports exactly ONE slug AS A
 * VARIANT of `parentId`, pulling only the fields DISTINCT from the parent
 * (everything identical is left to inherit dynamically), linked to the OPT
 * material for the re-sync loop.
 *
 * GH #605: variant mode runs through the SAME promotion gate as
 * POST /api/filaments (createVariantGated) — the FIRST variant of a carrying
 * parent 409s `parent_promotion_required` until the caller confirms with
 * `promoteParent: true`. Promotion is never silent, on any entry point.
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const slugs: string[] = body.slugs;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return NextResponse.json(
        { error: "Request body must include a non-empty 'slugs' array" },
        { status: 400 },
      );
    }
    // GH #427: cap the per-request slug count — the loop does per-slug
    // sequential round-trips, so an unbounded payload is a DoS. Sibling
    // import routes enforce similar caps.
    const MAX_SLUGS = 500;
    if (slugs.length > MAX_SLUGS) {
      return NextResponse.json(
        { error: `Too many slugs (max ${MAX_SLUGS})` },
        { status: 400 },
      );
    }

    await dbConnect();

    // Variant mode. `promoteParent` is the GH #605 confirmation flag — a
    // control flag, never a schema field.
    const parentId = body.parentId;
    if (parentId != null && parentId !== "") {
      return importAsVariant(slugs, parentId, body.promoteParent === true);
    }

    const db = await fetchOpenPrintTagDatabase();
    const slugSet = new Set(slugs);
    const selected = db.materials.filter((m) => slugSet.has(m.slug));

    if (selected.length === 0) {
      return NextResponse.json(
        { error: "No matching materials found for the provided slugs" },
        { status: 404 },
      );
    }

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const material of selected) {
      try {
        const payload = mapToFilamentPayload(material);
        const name = payload.name as string;
        const vendor = payload.vendor as string;

        // GH #607: capture the OPT-offered value for every managed field at
        // import time, so a later re-sync check can tell "OPT changed it
        // upstream" from "the user edited it locally". Top-level field, NOT
        // inside `settings` — settings entries render directly in the
        // detail-page table and ride into slicer exports, neither of which
        // tolerates an object value.
        const optSnapshot = buildOptSnapshot(payload);
        payload.openprinttagSnapshot = optSnapshot;

        // The unique index is on { name } where _deletedAt is null, so query
        // by name alone; findOneAndUpdate is atomic so two concurrent
        // imports can't both create.

        // Always refresh the linkage + provenance snapshot on re-import —
        // shared with the variant-import + link routes via buildOptLinkUpdate.
        const optUpdateFields: Record<string, unknown> = buildOptLinkUpdate(payload);

        // Conditional updates: only set fields that are currently null.
        const conditionalDefaults: Record<string, unknown> = {};
        if (payload.density != null)
          conditionalDefaults.density = payload.density;
        if (payload.color && payload.color !== "#808080")
          conditionalDefaults.color = payload.color;
        // GH #477: spec keys 20–24 — applied only when the existing row has
        // none, like the other conditional defaults.
        if (
          Array.isArray(payload.secondaryColors) &&
          payload.secondaryColors.length > 0
        ) {
          conditionalDefaults.secondaryColors = payload.secondaryColors;
        }
        if (payload.transmissionDistance != null)
          conditionalDefaults.transmissionDistance = payload.transmissionDistance;
        if (payload.dryingTemperature != null)
          conditionalDefaults.dryingTemperature = payload.dryingTemperature;
        if (payload.dryingTime != null)
          conditionalDefaults.dryingTime = payload.dryingTime;
        if (payload.shoreHardnessD != null)
          conditionalDefaults.shoreHardnessD = payload.shoreHardnessD;

        /** Apply conditional defaults (only set if currently null) to a
         *  row — shared by the normal existing-row path AND the
         *  duplicate-key race-recovery path, so a doc created by a
         *  concurrent caller still gets density/color/drying backfilled. */
        const applyConditionalDefaults = async (
          row: { _id: unknown; density?: number | null; color?: string | null; secondaryColors?: string[] | null; transmissionDistance?: number | null; dryingTemperature?: number | null; dryingTime?: number | null; shoreHardnessD?: number | null },
        ): Promise<void> => {
          const conditionalSet: Record<string, unknown> = {};
          if (conditionalDefaults.density != null && row.density == null)
            conditionalSet.density = conditionalDefaults.density;
          if (conditionalDefaults.color && row.color === "#808080")
            conditionalSet.color = conditionalDefaults.color;
          // GH #477: only adopt the OPT db's secondaryColors when the
          // existing row has none — don't overwrite user-set arrays.
          if (
            conditionalDefaults.secondaryColors &&
            (!row.secondaryColors || row.secondaryColors.length === 0)
          ) {
            conditionalSet.secondaryColors = conditionalDefaults.secondaryColors;
            // When the OPT material is coextruded (null primary) AND the row
            // still has the gray sentinel, clear it to null — the
            // conditionalDefaults.color branch only fires on a truthy
            // payload.color, so the sentinel would otherwise persist beside
            // the adopted secondaries (a state the spec doesn't permit).
            if (payload.color === null && row.color === "#808080") {
              conditionalSet.color = null;
            }
          }
          if (conditionalDefaults.transmissionDistance != null && row.transmissionDistance == null)
            conditionalSet.transmissionDistance = conditionalDefaults.transmissionDistance;
          if (conditionalDefaults.dryingTemperature != null && row.dryingTemperature == null)
            conditionalSet.dryingTemperature = conditionalDefaults.dryingTemperature;
          if (conditionalDefaults.dryingTime != null && row.dryingTime == null)
            conditionalSet.dryingTime = conditionalDefaults.dryingTime;
          if (conditionalDefaults.shoreHardnessD != null && row.shoreHardnessD == null)
            conditionalSet.shoreHardnessD = conditionalDefaults.shoreHardnessD;

          if (Object.keys(conditionalSet).length > 0) {
            // GH #605: the existing row may be a TEMPLATE — a LEGACY
            // template can still carry the '#808080' sentinel, and the
            // sentinel branch above would backfill the OPT color straight
            // onto it. Strip the shared TEMPLATE_STRIP_FIELDS with the PUT's
            // semantics (non-null only, so the coextruded explicit
            // `color: null` clear still passes). Decision + write share the
            // per-filament mutex the promotion paths lock. The strip never
            // fails the row — reported as a per-row note on errors.
            await runExclusive(filamentLockKey(row._id), async () => {
              const stripped = await stripTemplateFieldsForWrite(
                Filament,
                row._id,
                conditionalSet,
              );
              if (stripped.length > 0) {
                errors.push(
                  `${material.name}: skipped ${stripped.join(", ")} — the local filament is a template (inventory and color live on its variants)`,
                );
              }
              if (Object.keys(conditionalSet).length === 0) return;
              // GH #632: runValidators — bare findByIdAndUpdate skips schema
              // validators, letting a malformed color_rgba from a community
              // YAML persist an invalid hex on re-import.
              await Filament.findByIdAndUpdate(
                row._id,
                { $set: conditionalSet },
                { runValidators: true, context: "query" },
              );
            });
          }
        };

        // CANONICAL FIRST, survivor only on a miss. A row the migration
        // could not trim is invisible to a name-filtered query (the setter
        // casts it), so on its own this upsert would miss it and the create
        // below would mint a second active row. But the survivor scan must
        // not run FIRST: its `$expr` matches the canonical and the untrimmed
        // row alike, so in exactly the collision state that produces a
        // survivor a scan-first lookup could pick the legacy row where the
        // indexed query deterministically chooses the canonical one.
        let existing = await Filament.findOneAndUpdate(
          { name, _deletedAt: null, vendor },
          { $set: optUpdateFields },
          { returnDocument: "after" },
        );
        if (!existing) {
          const survivorId = await findSurvivorId(
            Filament.collection as unknown as MinimalNameCollection,
            name,
            { _deletedAt: null, vendor },
          );
          if (survivorId) {
            existing = await Filament.findOneAndUpdate(
              { _id: survivorId, _deletedAt: null, vendor },
              { $set: optUpdateFields },
              { returnDocument: "after" },
            );
          }
        }

        if (existing) {
          await applyConditionalDefaults(existing);
          updated++;
        } else {
          // Different-vendor name collision check.
          let nameCollision = await Filament.findOne({ name, _deletedAt: null }).lean();
          if (!nameCollision) {
            // Same survivor blind spot, opposite direction: a MISSED
            // collision lets the create proceed into a duplicate.
            const otherVendorId = await findSurvivorId(
              Filament.collection as unknown as MinimalNameCollection,
              name,
              { _deletedAt: null },
            );
            if (otherVendorId) {
              nameCollision = await Filament.findOne({ _id: otherVendorId }).lean();
            }
          }
          if (nameCollision) {
            errors.push(
              `${material.name}: skipped — a filament named "${name}" already exists under vendor "${nameCollision.vendor}"`,
            // name-lookup-ok: post-E11000 recovery: the index proved an exact stored-string match
            );
            continue;
          }
          // GH #524.1: a concurrent POST can win the unique-name race and
          // the loser's create throws E11000. Mirror the three-phase
          // recovery the bambustudio / filament-import / prusament importers
          // use: re-fetch the winner and treat it as an update (never leak
          // the raw MongoServerError text).
          try {
            await Filament.create(payload);
            created++;
          } catch (createErr) {
            if (!isDuplicateKeyError(createErr)) throw createErr;
            const winner = await Filament.findOneAndUpdate(
              // name-lookup-ok: post-E11000 recovery: the index proved an exact stored-string match
              { name, vendor, _deletedAt: null },
              { $set: optUpdateFields },
              { returnDocument: "after" },
            );
            if (winner) {
              // Same conditional-default backfill as the normal
              // existing-row path — otherwise this branch reports "updated"
              // while leaving density/color/drying unset on the raced-in
              // row.
              await applyConditionalDefaults(winner);
              updated++;
            } else {
              // The race winner is in a different vendor — same shape as
              // the pre-create nameCollision branch above.
              // name-lookup-ok: post-E11000 recovery; the index proved an exact stored-string match
              const racedCollision = await Filament.findOne({ name, _deletedAt: null }).lean();
              if (racedCollision) {
                errors.push(
                  `${material.name}: skipped — a filament named "${name}" already exists under vendor "${racedCollision.vendor}"`,
                );
              } else {
                // Shouldn't happen — but don't leak the raw E11000.
                errors.push(`${material.name}: write conflict, please retry`);
              }
            }
          }
        }
      } catch (err) {
        errors.push(`${material.name}: ${String(err)}`);
      }
    }

    const total = created + updated;
    let message = `Imported ${total} filament${total !== 1 ? "s" : ""}`;
    if (created > 0) message += ` (${created} new)`;
    if (updated > 0) message += ` (${updated} updated)`;
    if (errors.length > 0) message += `. ${errors.length} error(s).`;

    return NextResponse.json({
      message,
      total,
      created,
      updated,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("OpenPrintTag import error:", err);
    return NextResponse.json(
      { error: "Import failed", detail: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

/**
 * Issue #753: import ONE OpenPrintTag material as a VARIANT of an existing
 * parent. Only fields distinct from the parent land on the variant
 * (identical values are pruned so they inherit dynamically); created linked
 * so it can use the re-sync loop. Create-only: a name collision is refused,
 * never silently updating / re-parenting another row.
 */
async function importAsVariant(slugs: string[], parentId: string, promoteParent: boolean) {
  if (typeof parentId !== "string" || !mongoose.isValidObjectId(parentId)) {
    return NextResponse.json({ error: "'parentId' must be a valid filament id" }, { status: 400 });
  }
  if (slugs.length !== 1) {
    return NextResponse.json(
      { error: "Variant import takes exactly one slug (a variant has a single parent)" },
      { status: 400 },
    );
  }

  // Parent must exist, be active, and not itself be a variant — mirrors the
  // create route's parent validation.
  const parent = await Filament.findOne({ _id: parentId, _deletedAt: null }).lean();
  if (!parent) {
    return NextResponse.json({ error: "Parent filament not found" }, { status: 400 });
  }
  if (parent.parentId) {
    return NextResponse.json(
      { error: "Cannot set a variant as parent (no nested inheritance)" },
      { status: 400 },
    );
  }

  const db = await fetchOpenPrintTagDatabase();
  const material = db.materials.find((m) => m.slug === slugs[0]);
  if (!material) {
    return NextResponse.json(
      { error: "No matching material found for the provided slug" },
      { status: 404 },
    );
  }

  const payload = mapToFilamentPayload(material);
  // Snapshot the FULL OPT offer BEFORE pruning: a pruned (inherited) field
  // must still carry provenance so a later user override classifies
  // correctly instead of as a no-provenance conflict.
  const snapshot = buildOptSnapshot(payload);
  const name = payload.name as string;

  // Refuse a name collision — a "create variant" action must never mutate
  // another filament.
  let collision = await Filament.findOne({ name, _deletedAt: null }).lean();
  if (!collision) {
    // GH #1116: a MISSED collision fails in the dangerous direction — an
    // untrimmed survivor is invisible to this cast query, so the refusal
    // would be skipped and the variant created as an identically-rendering
    // duplicate.
    const survivorId = await findSurvivorId(
      Filament.collection as unknown as MinimalNameCollection,
      name,
      { _deletedAt: null },
    );
    if (survivorId)
      collision = await Filament.findOne({ _id: survivorId, _deletedAt: null }).lean();
  }
  if (collision) {
    return NextResponse.json(
      { error: `A filament named "${name}" already exists — rename it, or import it without a parent.` },
      { status: 409 },
    );
  }

  // Prune against the parent's effective values (a root's stored values ARE
  // its effective values). Strict equality only. Pruning against THIS
  // pre-lock snapshot is equivalent to pruning against the post-promotion
  // parent the gate below may produce: a promotion moves only
  // color/colorName/spools/totalWeight/lowStockThreshold, and NONE of those
  // participate in the prune — so the payload the gate dry-run validates is
  // exactly the payload the create persists.
  const variantPayload = pruneOptPayloadAgainstParent(
    payload,
    parent as unknown as Record<string, unknown>,
  );
  variantPayload.parentId = parentId;
  variantPayload.openprinttagSnapshot = snapshot;
  // diameter is hardcoded 1.75 by mapToFilamentPayload (not real OPT data) —
  // null it so the variant inherits the parent's diameter (GH #106).
  variantPayload.diameter = null;

  try {
    // GH #605: the same in-lock gate sequence as POST /api/filaments — see
    // createVariantGated.
    const result = await createVariantGated(Filament, parentId, variantPayload, promoteParent);
    switch (result.outcome) {
      case "parent_not_found":
        // Vanished (soft-deleted) between the pre-lock validation and the
        // lock — same 400 the pre-lock check would have given.
        return NextResponse.json({ error: "Parent filament not found" }, { status: 400 });
      case "parent_is_variant":
        // A concurrent PUT re-parented it before the gate's in-lock re-fetch
        // — same no-nesting 400.
        return NextResponse.json(
          { error: "Cannot set a variant as parent (no nested inheritance)" },
          { status: 400 },
        );
      case "promotion_required":
        return NextResponse.json(promotionRequired409Body(result), { status: 409 });
      case "name_taken":
        // The raced variant of the pre-lock collision check, caught by the
        // gate's pre-promotion re-check.
        return NextResponse.json(
          { error: `A filament named "${name}" already exists — rename it, or import it without a parent.` },
          { status: 409 },
        );
      default:
        return NextResponse.json({
          message: `Imported "${name}" as a variant`,
          total: 1,
          created: 1,
          updated: 0,
          filament: result.filament,
        });
    }
  } catch (createErr) {
    // A concurrent create can win the unique-name race between the collision
    // check and here — surface it as a 409, never leak the raw E11000.
    if (isDuplicateKeyError(createErr)) {
      return NextResponse.json(
        { error: `A filament named "${name}" already exists — rename it, or import it without a parent.` },
        { status: 409 },
      );
    }
    throw createErr;
  }
}
