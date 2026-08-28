import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  fetchOpenPrintTagDatabase,
  mapToFilamentPayload,
} from "@/lib/openprinttagBrowser";
import { diffOptFields } from "@/lib/optResync";
import { hasVariants } from "@/lib/resolveFilament";
import { resolveEffectiveFilament } from "@/lib/resolveEffectiveFilament";

/**
 * GET /api/filaments/{id}/openprinttag/check  (GH #607)
 *
 * Compares an OpenPrintTag-linked filament against the *current* upstream
 * material and returns a field-level changelist. Read-only — the user
 * applies changes via the sibling POST `.../sync`.
 *
 * Responses:
 *   { linked: false }                     — row has no openprinttag_slug
 *   { linked: true, found: false, slug }  — slug no longer in the OPT db
 *   { linked: true, found: true, slug, materialName, changes: [...] }
 * `changes[]` entries carry `kind ∈ {adopt, conflict}` (src/lib/optResync).
 *
 * GH #605: this route deliberately does NOT take the per-filament mutex the
 * sync route holds — its output is ADVISORY, and the sync route re-derives
 * the whole offered set from a fresh in-lock snapshot before any write, so
 * a staled changelist can never be applied (it 400s on sync and the user
 * re-checks). Locking here would serialize a read-only endpoint against
 * every write for no correctness gain.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;
    // Reject a non-ObjectId id up front (400) instead of a CastError 500
    // (#818).
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
    }

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

    // Diff against the variant's EFFECTIVE values, not its raw doc — a
    // field left unset to inherit reads as null raw, so diffOptFields would
    // offer it as a spurious "adopt" gap-fill even though the inherited
    // value already matches OPT. The sibling `sync` route resolves the same
    // way so the two stay in lockstep. The slug and snapshot still come
    // from the raw doc (`settings` isn't carried through resolveFilament;
    // `openprinttagSnapshot` is variant-only).
    const { effective, parentEffective } = await resolveEffectiveFilament(
      filament as unknown as Record<string, unknown>,
    );

    const snapshot = filament.openprinttagSnapshot as Record<string, unknown> | undefined;
    // GH #605: templates are colorless, so the diff must not offer the
    // primary color. secondaryColors stays offered (inheritable, GH #477).
    // The sibling sync route passes the same flag so check and sync agree.
    const excludeColor = await hasVariants(Filament, id);
    const changes = diffOptFields(effective, payload, snapshot, parentEffective, {
      excludeColor,
    });

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
