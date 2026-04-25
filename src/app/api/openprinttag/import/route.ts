import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  fetchOpenPrintTagDatabase,
  mapToFilamentPayload,
} from "@/lib/openprinttagBrowser";

/**
 * POST /api/openprinttag/import
 *
 * Import selected OpenPrintTag materials into Filament DB.
 *
 * Request body: { slugs: string[] }
 *
 * For each slug, the material is fetched from the cached OpenPrintTag
 * database, mapped to the Filament schema, and created or updated
 * (upsert by name + vendor).
 */
export async function POST(request: NextRequest) {
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

    await dbConnect();

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

        // The unique index is on { name } where _deletedAt is null, so we
        // must query by name alone to avoid a duplicate-key error when the
        // same name exists under a different vendor.
        //
        // Use findOneAndUpdate to atomically find-and-update, avoiding a
        // race where two concurrent imports could both see "no existing"
        // and both try to create, causing a duplicate-key error.

        // Always include the OpenPrintTag reference in settings
        const optUpdateFields: Record<string, unknown> = {
          "settings.openprinttag_uuid":
            (payload.settings as Record<string, string>).openprinttag_uuid,
          "settings.openprinttag_slug":
            (payload.settings as Record<string, string>).openprinttag_slug,
        };

        // Build conditional updates: only set fields that are currently null.
        const conditionalDefaults: Record<string, unknown> = {};
        if (payload.density != null)
          conditionalDefaults.density = payload.density;
        if (payload.color && payload.color !== "#808080")
          conditionalDefaults.color = payload.color;
        if (payload.transmissionDistance != null)
          conditionalDefaults.transmissionDistance = payload.transmissionDistance;
        if (payload.dryingTemperature != null)
          conditionalDefaults.dryingTemperature = payload.dryingTemperature;
        if (payload.dryingTime != null)
          conditionalDefaults.dryingTime = payload.dryingTime;
        if (payload.shoreHardnessD != null)
          conditionalDefaults.shoreHardnessD = payload.shoreHardnessD;

        const existing = await Filament.findOneAndUpdate(
          { name, _deletedAt: null, vendor },
          { $set: optUpdateFields },
          { returnDocument: "after" },
        );

        if (existing) {
          // Apply conditional defaults (only set if currently null) in a
          // second update — $set alone cannot express "set if null".
          const conditionalSet: Record<string, unknown> = {};
          if (conditionalDefaults.density != null && existing.density == null)
            conditionalSet.density = conditionalDefaults.density;
          if (conditionalDefaults.color && existing.color === "#808080")
            conditionalSet.color = conditionalDefaults.color;
          if (conditionalDefaults.transmissionDistance != null && existing.transmissionDistance == null)
            conditionalSet.transmissionDistance = conditionalDefaults.transmissionDistance;
          if (conditionalDefaults.dryingTemperature != null && existing.dryingTemperature == null)
            conditionalSet.dryingTemperature = conditionalDefaults.dryingTemperature;
          if (conditionalDefaults.dryingTime != null && existing.dryingTime == null)
            conditionalSet.dryingTime = conditionalDefaults.dryingTime;
          if (conditionalDefaults.shoreHardnessD != null && existing.shoreHardnessD == null)
            conditionalSet.shoreHardnessD = conditionalDefaults.shoreHardnessD;

          if (Object.keys(conditionalSet).length > 0) {
            await Filament.findByIdAndUpdate(existing._id, { $set: conditionalSet });
          }
          updated++;
        } else {
          // Check if a filament exists with a different vendor (name collision)
          const nameCollision = await Filament.findOne({ name, _deletedAt: null }).lean();
          if (nameCollision) {
            errors.push(
              `${material.name}: skipped — a filament named "${name}" already exists under vendor "${nameCollision.vendor}"`,
            );
            continue;
          }
          await Filament.create(payload);
          created++;
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
