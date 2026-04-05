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
  try {
    const body = await request.json();
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
        const existing = await Filament.findOne({
          name,
          _deletedAt: null,
        });

        if (existing) {
          // Only update if the vendor matches — don't silently merge data
          // from a different brand into an unrelated filament.
          if (existing.vendor !== vendor) {
            errors.push(
              `${material.name}: skipped — a filament named "${name}" already exists under vendor "${existing.vendor}"`,
            );
            continue;
          }

          // Update with new data but don't overwrite user calibrations/settings
          const updateFields: Record<string, unknown> = {};
          if (payload.density != null && existing.density == null)
            updateFields.density = payload.density;
          if (payload.color && payload.color !== "#808080" && existing.color === "#808080")
            updateFields.color = payload.color;
          if (payload.transmissionDistance != null && existing.transmissionDistance == null)
            updateFields.transmissionDistance = payload.transmissionDistance;
          if (payload.dryingTemperature != null && existing.dryingTemperature == null)
            updateFields.dryingTemperature = payload.dryingTemperature;
          if (payload.dryingTime != null && existing.dryingTime == null)
            updateFields.dryingTime = payload.dryingTime;
          if (payload.shoreHardnessD != null && existing.shoreHardnessD == null)
            updateFields.shoreHardnessD = payload.shoreHardnessD;

          // Always update the OpenPrintTag reference in settings
          updateFields["settings.openprinttag_uuid"] =
            (payload.settings as Record<string, string>).openprinttag_uuid;
          updateFields["settings.openprinttag_slug"] =
            (payload.settings as Record<string, string>).openprinttag_slug;

          if (Object.keys(updateFields).length > 0) {
            await Filament.findByIdAndUpdate(existing._id, { $set: updateFields });
          }
          updated++;
        } else {
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
      { error: "Import failed", detail: String(err) },
      { status: 500 },
    );
  }
}
