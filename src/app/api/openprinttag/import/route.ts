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
 * Variant mode (`parentId` set — Issue #753, approach A): imports exactly ONE
 * slug AS A VARIANT of `parentId`, pulling only the fields DISTINCT from the
 * parent onto the variant (everything identical to the parent is left to
 * inherit dynamically). The variant is linked to the OPT material so it can use
 * the "Check for updates" re-sync loop afterwards.
 *
 * GH #605 (codex round 3, Finding A): variant mode runs through the SAME
 * promotion gate as POST /api/filaments (createVariantGated) — importing the
 * FIRST variant of a parent that still carries its own color/spools 409s
 * with the structured `parent_promotion_required` payload until the caller
 * confirms with `promoteParent: true` in the body. Promotion is never
 * silent, on any entry point.
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
    // GH #427: cap the per-request slug count. The loop below does a
    // per-slug findOneAndUpdate followed by a findById on match, so a
    // 50k-slug payload performed 50k+ sequential round-trips. Sibling
    // import routes already enforce caps (share/POST: 500,
    // print-history/POST: 100, filaments/import: 10k). 500 is plenty
    // for any realistic bulk import from the OpenPrintTag browse page.
    const MAX_SLUGS = 500;
    if (slugs.length > MAX_SLUGS) {
      return NextResponse.json(
        { error: `Too many slugs (max ${MAX_SLUGS})` },
        { status: 400 },
      );
    }

    await dbConnect();

    // Issue #753 (approach A): variant mode — import a single material as a
    // variant of an existing parent, pulling only its distinct fields.
    // `promoteParent` is the GH #605 confirmation flag, mirroring
    // POST /api/filaments — a control flag, never a schema field.
    const parentId = body.parentId;
    if (parentId != null && parentId !== "") {
      return importAsVariant(slugs, parentId, body.promoteParent === true);
    }

    // Get the cached database (should already be cached from the browse page)
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
        // import time. This provenance snapshot lets a later "check for
        // updates" (the re-sync feature) tell "OPT changed it upstream" from
        // "the user edited it locally" without a manual sync-first dance.
        const optSnapshot = buildOptSnapshot(payload);
        // Seed it on the create path too (the update path uses
        // optUpdateFields below). Top-level field, NOT inside `settings` —
        // settings entries render directly in the detail-page table and ride
        // into slicer exports, neither of which tolerates an object value
        // (Codex P2 on PR #612).
        payload.openprinttagSnapshot = optSnapshot;

        // The unique index is on { name } where _deletedAt is null, so we
        // must query by name alone to avoid a duplicate-key error when the
        // same name exists under a different vendor.
        //
        // Use findOneAndUpdate to atomically find-and-update, avoiding a
        // race where two concurrent imports could both see "no existing"
        // and both try to create, causing a duplicate-key error.

        // Always include the OpenPrintTag reference in settings + refresh the
        // GH #607 provenance snapshot on every (re-)import so an existing row's
        // snapshot stays current with the upstream offer. Shared with the
        // variant-import + link routes via buildOptLinkUpdate.
        const optUpdateFields: Record<string, unknown> = buildOptLinkUpdate(payload);

        // Build conditional updates: only set fields that are currently null.
        const conditionalDefaults: Record<string, unknown> = {};
        if (payload.density != null)
          conditionalDefaults.density = payload.density;
        if (payload.color && payload.color !== "#808080")
          conditionalDefaults.color = payload.color;
        // GH #477: OpenPrintTag spec keys 20–24. Apply only when the
        // existing row has none — mirrors the "only set if currently
        // null/sentinel" rule the other conditional defaults use.
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
         *  row — used by both the normal existing-row path AND the
         *  duplicate-key race-recovery path (Codex P2 round 1 on
         *  PR #531). Without this shared helper, a doc that's created
         *  by a concurrent caller between the existing-lookup and the
         *  create below would land with ONLY the optUpdateFields set —
         *  density/color/drying/etc. would never get backfilled from
         *  the OPT material the user explicitly chose to import. */
        const applyConditionalDefaults = async (
          row: { _id: unknown; density?: number | null; color?: string | null; secondaryColors?: string[] | null; transmissionDistance?: number | null; dryingTemperature?: number | null; dryingTime?: number | null; shoreHardnessD?: number | null },
        ): Promise<void> => {
          const conditionalSet: Record<string, unknown> = {};
          if (conditionalDefaults.density != null && row.density == null)
            conditionalSet.density = conditionalDefaults.density;
          if (conditionalDefaults.color && row.color === "#808080")
            conditionalSet.color = conditionalDefaults.color;
          // GH #477: only adopt the OPT db's secondaryColors when the
          // existing row has none. Don't overwrite user-set arrays.
          if (
            conditionalDefaults.secondaryColors &&
            (!row.secondaryColors || row.secondaryColors.length === 0)
          ) {
            conditionalSet.secondaryColors = conditionalDefaults.secondaryColors;
            // GH #477 (Codex P2 on PR #484 r3): when the OPT material
            // is coextruded (payload.color === null, secondaryColors
            // populated) AND the row still has the gray sentinel
            // "#808080", clear it to null so we don't end up with the
            // gray+secondaries state the spec doesn't permit for
            // coextruded materials. mapToFilamentPayload already emits
            // null for this case so payload.color is null here, but the
            // conditionalDefaults.color branch above only fires when
            // payload.color is truthy — leaving the sentinel in place.
            // This explicit clear closes the gap. Matches the create
            // branch which gets null directly via mapToFilamentPayload.
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
            // GH #605 (codex P2, importer sweep): the existing row may be a
            // TEMPLATE (≥1 live variant). Its color was moved onto the
            // variants at promotion, but a LEGACY template can still carry
            // the '#808080' sentinel — the `row.color === "#808080"` branch
            // above would then backfill the OPT color straight onto it,
            // re-materializing per-variant state the re-sync flow already
            // refuses (diffOptFields' excludeColor). Strip the shared
            // TEMPLATE_STRIP_FIELDS (of which only `color` can appear in
            // `conditionalSet`) with the PUT's semantics: non-null only, so
            // the coextruded explicit `color: null` clear still passes.
            // Decision + write share the per-filament mutex the promotion
            // paths lock (this route's bulk mode holds no other lock).
            // The strip never fails the row (atlas posture) — it's reported
            // as a per-row note on the errors channel.
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
              // GH #632: runValidators so the GH #503 hex validators on
              // color/secondaryColors (and the numeric range validators)
              // fire on this update path too — bare findByIdAndUpdate
              // skips schema validators, which let a malformed color_rgba
              // from a community YAML persist an invalid hex on re-import.
              await Filament.findByIdAndUpdate(
                row._id,
                { $set: conditionalSet },
                { runValidators: true, context: "query" },
              );
            });
          }
        };

        // GH #1116 (Codex P1): a row the migration could not trim is
        // invisible to a name-filtered query (the setter casts it), so this
        // atomic upsert would miss it and the create below would mint a
        // second active row. Pre-resolve the survivor and address it by
        // `_id`, which is strictly MORE specific than the name filter it
        // replaces — the atomic write semantics are unchanged.
        const survivorId = await findSurvivorId(
          Filament.collection as unknown as MinimalNameCollection,
          name,
          { _deletedAt: null, vendor },
        );
        const existing = await Filament.findOneAndUpdate(
          survivorId
            ? { _id: survivorId, _deletedAt: null, vendor }
            : { name, _deletedAt: null, vendor },
          { $set: optUpdateFields },
          { returnDocument: "after" },
        );

        if (existing) {
          await applyConditionalDefaults(existing);
          updated++;
        } else {
          // Check if a filament exists with a different vendor (name collision)
          let nameCollision = await Filament.findOne({ name, _deletedAt: null }).lean();
          if (!nameCollision) {
            // Same blind spot, and it matters in the opposite direction: a
            // MISSED collision lets the create proceed into a duplicate.
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
            );
            continue;
          }
          // GH #524.1: between the nameCollision check above and the
          // create below, a concurrent POST can win the race and the
          // loser's create throws E11000 with the raw MongoServerError
          // text that used to leak into errors[]. Mirror the three-phase
          // recovery the bambustudio / filament-import / prusament
          // importers all use: on a duplicate-key error, re-fetch the
          // winner and treat it as an update.
          try {
            await Filament.create(payload);
            created++;
          } catch (createErr) {
            if (!isDuplicateKeyError(createErr)) throw createErr;
            const winner = await Filament.findOneAndUpdate(
              { name, vendor, _deletedAt: null },
              { $set: optUpdateFields },
              { returnDocument: "after" },
            );
            if (winner) {
              // Codex P2 round 1: same conditional-default backfill the
              // normal existing-row path applies — without this the
              // duplicate-recovery branch would report "updated" while
              // leaving the OPT material's density/color/drying-temp
              // unset on the raced-in row.
              await applyConditionalDefaults(winner);
              updated++;
            } else {
              // The race winner is in a different vendor — same shape as
              // the pre-create nameCollision branch above.
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
 * Issue #753 (approach A): import ONE OpenPrintTag material as a VARIANT of an
 * existing parent. Only fields distinct from the parent land on the variant —
 * everything identical is pruned so it inherits dynamically (resolveFilament).
 * The variant is created linked (settings.openprinttag_* + snapshot) so it can
 * use the re-sync loop. Create-only: a name collision is refused, never
 * silently updating / re-parenting another row.
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

  // Parent must exist, be active, and not itself be a variant (no nested
  // inheritance) — mirrors the create route's parent validation.
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
  // Snapshot the FULL OPT offer BEFORE pruning: a field we prune (the variant
  // inherits it) must still carry provenance, so if the user later overrides it
  // a re-check classifies it correctly instead of as a no-provenance conflict.
  const snapshot = buildOptSnapshot(payload);
  const name = payload.name as string;

  // Refuse a name collision rather than updating / re-parenting an existing
  // row — a "create variant" action must never mutate another filament.
  const collision = await Filament.findOne({ name, _deletedAt: null }).lean();
  if (collision) {
    return NextResponse.json(
      { error: `A filament named "${name}" already exists — rename it, or import it without a parent.` },
      { status: 409 },
    );
  }

  // Prune against the parent's effective values (the parent is a root, so its
  // stored values ARE its effective values). Strict equality only — a value
  // that merely resembles the parent's is kept as the variant's distinct data.
  //
  // Pruning against THIS pre-lock snapshot is equivalent to pruning against
  // the post-promotion parent the gate below may produce: a promotion moves
  // only color/colorName/spools/totalWeight/lowStockThreshold, and NONE of
  // those participate in the prune (color/colorName are never pruned by
  // design, and the inventory trio is neither inheritable nor present in an
  // OPT payload). So the payload the gate dry-run validates is exactly the
  // payload the create persists.
  const variantPayload = pruneOptPayloadAgainstParent(
    payload,
    parent as unknown as Record<string, unknown>,
  );
  variantPayload.parentId = parentId;
  variantPayload.openprinttagSnapshot = snapshot;
  // diameter is hardcoded 1.75 by mapToFilamentPayload (not real OPT data) —
  // null it so the variant inherits the parent's diameter (GH #106), exactly
  // as the create route does for variants.
  variantPayload.diameter = null;

  try {
    // GH #605 (codex round 3, Finding A): the same in-lock gate sequence as
    // POST /api/filaments — per-parent mutex, in-lock parent re-fetch,
    // structured 409 until `promoteParent: true`, dry-run validate, then
    // promote copy-first/clear-last and create. See createVariantGated.
    const result = await createVariantGated(Filament, parentId, variantPayload, promoteParent);
    switch (result.outcome) {
      case "parent_not_found":
        // Vanished (soft-deleted) between the pre-lock validation above and
        // the lock — same 400 the pre-lock check would have given.
        return NextResponse.json({ error: "Parent filament not found" }, { status: 400 });
      case "parent_is_variant":
        // Validated above as a root, but a concurrent PUT re-parented it
        // before the gate's in-lock re-fetch (round 8 F1) — same no-nesting
        // 400 the pre-lock check produces.
        return NextResponse.json(
          { error: "Cannot set a variant as parent (no nested inheritance)" },
          { status: 400 },
        );
      case "promotion_required":
        return NextResponse.json(promotionRequired409Body(result), { status: 409 });
      case "name_taken":
        // Same copy as the pre-lock collision check — this is the raced
        // variant of it, caught by the gate's pre-promotion re-check.
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
