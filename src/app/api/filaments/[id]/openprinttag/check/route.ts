import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  fetchOpenPrintTagDatabase,
  mapToFilamentPayload,
} from "@/lib/openprinttagBrowser";
import { diffOptFields } from "@/lib/optResync";
import { resolveEffectiveFilament } from "@/lib/resolveEffectiveFilament";

/**
 * GET /api/filaments/{id}/openprinttag/check  (GH #607, Phase 1)
 *
 * Compares an OpenPrintTag-linked filament against the *current* upstream
 * material and returns a field-level changelist. Read-only — nothing is
 * mutated; the user picks which changes to apply via the sibling POST
 * `.../sync` endpoint.
 *
 * Responses:
 *   { linked: false }                        — row has no openprinttag_slug
 *   { linked: true, found: false, slug }     — slug no longer in the OPT db
 *   { linked: true, found: true, slug, materialName, changes: [...] }
 *
 * `changes[]` entries are `{ field, labelKey, current, incoming, kind }`
 * where `kind ∈ {adopt, conflict}` (see src/lib/optResync.ts). An empty
 * `changes` array means the row is already up to date with OPT.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;

    const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const settings = (filament.settings ?? {}) as Record<string, unknown>;
    const slug = settings.openprinttag_slug;
    if (typeof slug !== "string" || slug === "") {
      return NextResponse.json({ linked: false });
    }

    const db = await fetchOpenPrintTagDatabase();
    const material = db.materials.find((m) => m.slug === slug);
    if (!material) {
      // The material was removed / renamed upstream. Surface that rather
      // than pretending there are no updates.
      return NextResponse.json({ linked: true, found: false, slug });
    }

    const payload = mapToFilamentPayload(material);

    // GH #607 follow-up: diff against the variant's EFFECTIVE values, not its
    // raw doc. A field a variant leaves unset to inherit from its parent
    // reads as null on the raw doc, so diffOptFields would classify it as an
    // empty local value and offer it as a spurious "adopt" gap-fill — even
    // though the resolved (inherited) value already matches OPT. The sibling
    // `sync` route resolves the same way so the two stay in lockstep. The
    // slug and snapshot still come from the raw doc: `settings` isn't carried
    // through resolveFilament, and `openprinttagSnapshot` is variant-only (so
    // it survives resolution unchanged either way). Root filaments have no
    // parentId, so they diff exactly as before.
    const { effective, parentEffective } = await resolveEffectiveFilament(
      filament as unknown as Record<string, unknown>,
    );

    const snapshot = filament.openprinttagSnapshot as Record<string, unknown> | undefined;
    const changes = diffOptFields(effective, payload, snapshot, parentEffective);

    return NextResponse.json({
      linked: true,
      found: true,
      slug,
      materialName: payload.name,
      changes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to check OpenPrintTag updates", detail: message },
      { status: 500 },
    );
  }
}
