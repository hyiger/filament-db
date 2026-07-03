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
 *   0a. an instance-ID match against a SPOOL's id (#732 — the durable per-spool
 *       identity; resolved first, exact-case then CI, and the matched spool is
 *       reported in `matchedSpool`), or
 *   0b. an instance-ID match against the FILAMENT's id (the transitional
 *       fallback kept until the Phase-3 writers move off it — `matchedSpool`
 *       stays null), or
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

/** The specific spool a scan resolved to (#732). Non-null ONLY when the match
 * came from a `spools[].instanceId` hit — a filament-level instanceId hit (the
 * transitional fallback) leaves this null. */
export interface MatchedSpool {
  _id: string;
  instanceId: string;
  label: string;
}

export interface MatchResult {
  /** A lean filament document, or null when there's no confident match. */
  match: unknown;
  /** Lean filament documents to disambiguate, when the match is ambiguous. */
  candidates: unknown[];
  /** The spool whose instanceId matched (#732), or null for a filament-level
   * (legacy fallback) / name / vendor+type match. */
  matchedSpool: MatchedSpool | null;
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal lean shapes for reading spool subdocs off a `.lean()` filament. */
interface LeanSpool {
  _id: unknown;
  instanceId?: string | null;
  label?: string | null;
}
interface LeanFilamentWithSpools {
  spools?: LeanSpool[];
}

function toMatchedSpool(spool: LeanSpool): MatchedSpool {
  return {
    _id: String(spool._id),
    instanceId: String(spool.instanceId ?? ""),
    label: typeof spool.label === "string" ? spool.label : "",
  };
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
    // 0a. SPOOL-level instanceId (#732) — the durable per-spool identity is
    //     resolved FIRST (exact-case, then CI), and the matched spool is
    //     reported so callers know which roll was scanned. The dot-notation
    //     query matches the FILAMENT if ANY spool matches, so re-scan the
    //     subdocs to find which one (and its _id/label). A filament with
    //     multiple spools sharing an id picks the first by array order
    //     (creation order); only a CROSS-filament collision is ambiguous.
    const spoolExact = (await Filament.find({
      "spools.instanceId": instanceId,
      _deletedAt: null,
    })
      .limit(2)
      .lean()) as LeanFilamentWithSpools[];
    const exactPairs = spoolExact.flatMap((f) => {
      const s = (f.spools ?? []).find((sp) => sp.instanceId === instanceId);
      return s ? [{ filament: f, spool: s }] : [];
    });
    if (exactPairs.length === 1) {
      return {
        match: exactPairs[0].filament,
        candidates: [],
        matchedSpool: toMatchedSpool(exactPairs[0].spool),
      };
    }
    if (exactPairs.length > 1) {
      return { match: null, candidates: exactPairs.map((p) => p.filament), matchedSpool: null };
    }

    const spoolCi = (await Filament.find({
      "spools.instanceId": { $regex: `^${escapeRegex(instanceId)}$`, $options: "i" },
      _deletedAt: null,
    })
      .limit(2)
      .lean()) as LeanFilamentWithSpools[];
    const lowerId = instanceId.toLowerCase();
    // Like the exact tier, this picks the first lowercase-equal spool by array
    // order when a single filament has multiple case-only-colliding spool ids
    // (only a CROSS-filament collision below is ambiguous). Unreachable from
    // auto-generated lowercase-hex ids; reachable only via deliberate manual
    // entry, where the filament still resolves and only which spool is reported
    // is arbitrary.
    const ciPairs = spoolCi.flatMap((f) => {
      const s = (f.spools ?? []).find(
        (sp) => typeof sp.instanceId === "string" && sp.instanceId.toLowerCase() === lowerId,
      );
      return s ? [{ filament: f, spool: s }] : [];
    });
    if (ciPairs.length === 1) {
      return {
        match: ciPairs[0].filament,
        candidates: [],
        matchedSpool: toMatchedSpool(ciPairs[0].spool),
      };
    }
    if (ciPairs.length > 1) {
      return { match: null, candidates: ciPairs.map((p) => p.filament), matchedSpool: null };
    }

    // 0b. FILAMENT-level instanceId — the transitional fallback (#732). The
    //     label / NFC writers still encode the filament id until Phase 3, so
    //     this MUST stay until those writers move AND no field tag carries a
    //     filament id any longer. See the ISpool.instanceId contract in
    //     src/models/Filament.ts. matchedSpool is null here (no spool hit).
    //
    // 1. Exact-case match first — unambiguous, fast, and deterministic when
    //    the query case matches what's stored (the common case).
    const exact = await Filament.findOne({
      instanceId,
      _deletedAt: null,
    }).lean();
    if (exact) {
      return { match: exact, candidates: [], matchedSpool: null };
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
      return { match: ciMatches[0], candidates: [], matchedSpool: null };
    }
    if (ciMatches.length > 1) {
      // Ambiguous — case-only collision in legacy data. Surface as candidates
      // instead of returning an arbitrary row.
      return { match: null, candidates: ciMatches, matchedSpool: null };
    }
    // No match → fall through so the caller can still get name / vendor / type
    // suggestions if they supplied those alongside.
  }

  // 1. Name match. GH #954: the name partial-unique index is case-SENSITIVE
  //    (src/models/Filament.ts — no collation), so two active filaments
  //    differing only by case ("PLA Black" vs "pla black") can coexist. A bare
  //    case-insensitive findOne returned whichever Mongo yielded first as a
  //    CONFIDENT match — the SSE scan bus then auto-selects a possibly-wrong
  //    PrusaSlicer preset silently. Mirror the instanceId tier above: exact case
  //    first (deterministic in the common case, and not demoted to "ambiguous"
  //    just because a case-variant sibling exists), then a case-insensitive
  //    fallback that only auto-matches when it's unambiguous. Same class as the
  //    GH #896 vendor-substring fix.
  if (name) {
    // 1a. Exact-case — a confident match even when a case-variant sibling exists.
    const exact = await Filament.findOne({ name, _deletedAt: null }).lean();
    if (exact) {
      return { match: exact, candidates: [], matchedSpool: null };
    }
    // 1b. Case-insensitive fallback for legacy case drift. Cap at 2 to detect
    //     "more than one" without scanning the DB. One hit → confident match;
    //     multiple → case-only collision, surface as candidates.
    const ciMatches = await Filament.find({
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
      _deletedAt: null,
    })
      .limit(2)
      .lean();
    if (ciMatches.length === 1) {
      return { match: ciMatches[0], candidates: [], matchedSpool: null };
    }
    if (ciMatches.length > 1) {
      return { match: null, candidates: ciMatches, matchedSpool: null };
    }
  }

  // 2. Vendor + type match. A confident auto-match requires BOTH to agree.
  // GH #896: anchor the vendor regex to a full-string match (`^…$`), matching
  // the name + type tiers. Unanchored, a scanned vendor was a SUBSTRING match
  // ("Sun" → "Sunlu"), so a substring collision yielding a single vendor+type
  // hit silently auto-resolved to a DIFFERENT vendor's filament with no chooser.
  // (The vendor-ONLY suggestions tier below stays unanchored — it only ever
  // returns `candidates`, so substring there is harmless.)
  const vendorTypeMatches =
    vendor && type
      ? await Filament.find({
          vendor: { $regex: `^${escapeRegex(vendor)}$`, $options: "i" },
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
    return { match: vendorTypeMatches[0], candidates: [], matchedSpool: null };
  }
  if (vendorTypeMatches.length > 1) {
    return { match: null, candidates: vendorTypeMatches, matchedSpool: null };
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
    return { match: null, candidates: vendorMatches, matchedSpool: null };
  }

  return { match: null, candidates: [], matchedSpool: null };
}
