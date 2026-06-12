import Filament from "@/models/Filament";

/**
 * Resolve a scanned tag / QR / barcode against the filament database.
 *
 * Extracted from `GET /api/filaments/match` (GH: mobile-scanner Phase 0) so the
 * new `POST /api/nfc/decode` endpoint can attach a DB match to a decoded tag in
 * the same request, without the match priority logic drifting between two call
 * sites. The match route is a thin wrapper around this helper.
 *
 * A non-null `match` is only ever returned for a *confident* match:
 *   0. an exact instance-ID match (the strongest signal — auto-generated 5-byte
 *      hex that NFC tags and printed-label QRs encode), or
 *   1. an exact (case-insensitive) name match, or
 *   2. exactly one filament agreeing on BOTH vendor and type.
 *
 * Vendor alone is never enough — a PC spool must not silently match the user's
 * only Bambu PLA filament. The vendor-only fallback returns the vendor's
 * filaments as `candidates` for the user to pick from, with `match: null`.
 *
 * Inputs are assumed already trimmed/length-bounded by the caller (the route
 * applies `boundedParam`, GH #513). `escapeRegex` keeps the case-insensitive
 * comparisons literal.
 */

export interface MatchQuery {
  name?: string | null;
  vendor?: string | null;
  type?: string | null;
  instanceId?: string | null;
}

export interface MatchResult {
  /** A lean filament document, or null when there's no confident match. */
  match: unknown;
  /** Lean filament documents to disambiguate, when the match is ambiguous. */
  candidates: unknown[];
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function matchFilament(query: MatchQuery): Promise<MatchResult> {
  const name = query.name || null;
  const vendor = query.vendor || null;
  const type = query.type || null;
  const instanceId = query.instanceId || null;

  // 0. Instance-ID match — the strongest signal we have. An exact instance-ID
  //    match is unambiguous: return the filament directly and skip the
  //    name/vendor/type fallback.
  if (instanceId) {
    // 1. Exact-case match first — unambiguous, fast, and deterministic when
    //    the query case matches what's stored (the common case).
    const exact = await Filament.findOne({
      instanceId,
      _deletedAt: null,
    }).lean();
    if (exact) {
      return { match: exact, candidates: [] };
    }

    // 2. Case-insensitive fallback for legacy case drift. The partial unique
    //    index on instanceId is case-sensitive (so "ABC" and "abc" can both
    //    exist), but if the CI fallback turns up exactly ONE row that's still
    //    an unambiguous match — only multiple CI hits are genuinely ambiguous.
    //    Cap the find at 2 to detect "more than one" without scanning the DB.
    const ciMatches = await Filament.find({
      instanceId: { $regex: `^${escapeRegex(instanceId)}$`, $options: "i" },
      _deletedAt: null,
    })
      .limit(2)
      .lean();
    if (ciMatches.length === 1) {
      return { match: ciMatches[0], candidates: [] };
    }
    if (ciMatches.length > 1) {
      // Ambiguous — case-only collision in legacy data. Surface as candidates
      // instead of returning an arbitrary row.
      return { match: null, candidates: ciMatches };
    }
    // No match → fall through so the caller can still get name / vendor / type
    // suggestions if they supplied those alongside.
  }

  // 1. Exact name match (case-insensitive) — a confident match.
  if (name) {
    const exact = await Filament.findOne({
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
      _deletedAt: null,
    }).lean();
    if (exact) {
      return { match: exact, candidates: [] };
    }
  }

  // 2. Vendor + type match. A confident auto-match requires BOTH to agree.
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

  // Exactly one vendor+type hit → confident match. More than one → hand them
  // back as candidates for the user to disambiguate.
  if (vendorTypeMatches.length === 1) {
    return { match: vendorTypeMatches[0], candidates: [] };
  }
  if (vendorTypeMatches.length > 1) {
    return { match: null, candidates: vendorTypeMatches };
  }

  // 3. Vendor-only fallback — suggestions ONLY, never an auto-match. The type
  //    didn't agree (or none was supplied), so the most we can do is surface
  //    the vendor's filaments for the user to pick from.
  if (vendor) {
    const vendorMatches = await Filament.find({
      vendor: { $regex: escapeRegex(vendor), $options: "i" },
      _deletedAt: null,
    })
      .sort({ name: 1 })
      .limit(5)
      .lean();
    return { match: null, candidates: vendorMatches };
  }

  return { match: null, candidates: [] };
}
