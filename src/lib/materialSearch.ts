/**
 * Tokenized multi-field search for the OpenPrintTag material lists (GH #1173).
 *
 * The OPT link dialog and the /openprinttag browser both used to require the
 * WHOLE query as one contiguous substring inside a SINGLE field
 * (name | brandName | type). The row title is the material name WITHOUT the
 * brand (the brand renders as the subtitle), so the natural query
 * "arianeplast pl" — brand + start of the material type — matched nothing:
 * no single field contains that string. Tokenizing fixes it: every
 * whitespace-separated token must match somewhere (AND across tokens), but
 * each token may land in a different field (OR across fields).
 *
 * Accent folding uses NFD + the explicit combining range [̀-ͯ],
 * NOT `\p{M}` — property escapes are ES2018 while the repo targets ES2017,
 * and tsc validates regex FLAGS against the target but not regex BODIES, so
 * `\p{M}` would typecheck and fail only at runtime (the tsplEncoder lesson).
 * The OPT database is international (French "Améthyste", German umlauts), so
 * folding matters in both directions: an unaccented query must match an
 * accented name and vice versa.
 */

const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/** Lowercase + strip combining accents for comparison. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS_RE, "").toLowerCase();
}

/**
 * True when EVERY whitespace-separated token of `query` is a substring of AT
 * LEAST ONE of `fields` (AND across tokens, OR across fields), compared
 * accent- and case-insensitively. An empty / whitespace-only query matches
 * everything — callers that want "no query → no results" gate that case
 * themselves (the link dialog does).
 */
export function matchesTokenizedQuery(
  fields: ReadonlyArray<string | null | undefined>,
  query: string,
): boolean {
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystacks = fields
    .filter((f): f is string => typeof f === "string" && f !== "")
    .map(normalizeSearchText);
  return tokens.every((token) => haystacks.some((h) => h.includes(token)));
}
