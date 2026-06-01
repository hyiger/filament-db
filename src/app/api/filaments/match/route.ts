import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

/**
 * Match a scanned NFC tag against the filament database.
 *
 * A non-null `match` is only ever returned for a *confident* match:
 *   1. an exact (case-insensitive) name match, or
 *   2. exactly one filament agreeing on BOTH vendor and type.
 *
 * Vendor alone is never enough — a PC spool must not silently match the
 * user's only Bambu PLA filament. The vendor-only fallback returns the
 * vendor's filaments as `candidates` for the user to pick from, with
 * `match: null`.
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const params = request.nextUrl.searchParams;
    const name = params.get("name");
    const vendor = params.get("vendor");
    const type = params.get("type");
    const instanceId = params.get("instanceId");

    // 0. Instance-ID match — the strongest signal we have. Filament DB
    //    auto-generates a unique 5-byte hex per filament (Prusament's
    //    `brand_specific_instance_id` format) which is what NFC tags
    //    and printed label QRs encode in instance-ID mode. An exact
    //    instance-ID match is unambiguous: return the filament directly
    //    and skip the name/vendor/type fallback. (Codex P2 round 13 on
    //    PR #487 — without this branch the instance-ID QR mode on the
    //    label printer dialog has no resolver, so scanning the printed
    //    QR returns an opaque hex string with nowhere to go.)
    if (instanceId) {
      // Case-insensitive comparison on BOTH sides. The schema generates
      // lowercase hex going forward, but legacy / re-imported filaments
      // may carry mixed-case hex OR arbitrary non-hex strings
      // (importFilaments.ts assigns row.instanceId verbatim; the model
      // tests use values like "custom-id-123"). Match the stored value
      // via case-insensitive regex with escapeRegex protecting against
      // injection — same pattern the name/vendor/type branches below
      // use. Length cap is the only validator we need: it bounds the
      // regex compile cost so a 10MB query string can't DoS the route.
      // (Codex P2 rounds 13-15 on PR #487.)
      const trimmed = instanceId.trim();
      if (trimmed.length > 0 && trimmed.length <= 128) {
        const byInstanceId = await Filament.findOne({
          instanceId: {
            $regex: `^${escapeRegex(trimmed)}$`,
            $options: "i",
          },
          _deletedAt: null,
        }).lean();
        if (byInstanceId) {
          return NextResponse.json({ match: byInstanceId, candidates: [] });
        }
      }
      // No match → fall through so the caller can still get name /
      // vendor / type suggestions if they supplied those alongside.
    }

    // 1. Exact name match (case-insensitive) — a confident match.
    if (name) {
      const exact = await Filament.findOne({
        name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
        _deletedAt: null,
      }).lean();
      if (exact) {
        return NextResponse.json({ match: exact, candidates: [] });
      }
    }

    // 2. Vendor + type match. A confident auto-match requires BOTH vendor
    //    and type to agree.
    const vendorTypeMatches =
      vendor && type
        ? await Filament.find({
            vendor: { $regex: escapeRegex(vendor), $options: "i" },
            type: { $regex: `^${escapeRegex(type)}$`, $options: "i" },
            _deletedAt: null,
          })
            .sort({ name: 1 })
            .limit(5)
            .lean()
        : [];

    // Exactly one vendor+type hit → confident match. More than one → hand
    // them back as candidates for the user to disambiguate.
    if (vendorTypeMatches.length === 1) {
      return NextResponse.json({ match: vendorTypeMatches[0], candidates: [] });
    }
    if (vendorTypeMatches.length > 1) {
      return NextResponse.json({ match: null, candidates: vendorTypeMatches });
    }

    // 3. Vendor-only fallback — suggestions ONLY, never an auto-match. The
    //    type didn't agree (or none was supplied), so the most we can do
    //    is surface the vendor's filaments for the user to pick from.
    if (vendor) {
      const vendorMatches = await Filament.find({
        vendor: { $regex: escapeRegex(vendor), $options: "i" },
        _deletedAt: null,
      })
        .sort({ name: 1 })
        .limit(5)
        .lean();
      return NextResponse.json({ match: null, candidates: vendorMatches });
    }

    return NextResponse.json({ match: null, candidates: [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to match filaments", detail: message },
      { status: 500 },
    );
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
