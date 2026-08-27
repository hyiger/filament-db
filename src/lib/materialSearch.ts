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

/** Normalized whitespace-separated query tokens. Empty for a blank query. */
export function tokenizeSearchQuery(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

/** Pre-normalize a row's searchable fields (drops null/undefined/empty). */
export function normalizeSearchFields(
  fields: ReadonlyArray<string | null | undefined>,
): string[] {
  return fields
    .filter((f): f is string => typeof f === "string" && f !== "")
    .map(normalizeSearchText);
}

/**
 * AND across tokens, OR across fields, over PRE-normalized inputs. Zero
 * tokens match everything — callers that want "no query → no results" gate
 * that case themselves (the link dialog does).
 *
 * Split from matchesTokenizedQuery so hot callers pay normalization once per
 * SEARCH, not once per ROW: both UI callers filter the ~11.7k-material OPT
 * list per keystroke inside useMemo, where re-tokenizing the query (and
 * re-normalizing every row's fields) 11.7k times per keystroke measurably
 * blocks input (Codex P2 on PR #1181). Tokenize the query once per search
 * and cache normalizeSearchFields per row keyed on the loaded list.
 */
export function matchesSearchTokens(
  normalizedFields: ReadonlyArray<string>,
  tokens: ReadonlyArray<string>,
): boolean {
  return tokens.every((token) => normalizedFields.some((h) => h.includes(token)));
}

/**
 * Convenience one-shot: true when EVERY whitespace-separated token of `query`
 * is a substring of AT LEAST ONE of `fields` (accent- and case-insensitive).
 * For per-keystroke filtering of large lists use the split form above.
 */
export function matchesTokenizedQuery(
  fields: ReadonlyArray<string | null | undefined>,
  query: string,
): boolean {
  return matchesSearchTokens(normalizeSearchFields(fields), tokenizeSearchQuery(query));
}
