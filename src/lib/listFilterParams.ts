/**
 * Filter/search/sort state carried in the URL query string (GH #1141).
 *
 * The filament list and Spool Inventory kept every filter in a bare
 * `useState`, so a filtered view could not be shared or bookmarked and a
 * refresh — or a Back from a detail page — silently dropped the user to the
 * unfiltered list. `src/app/page.tsx` documented the gap and deferred it;
 * this is that deferral.
 *
 * ## Why a pure module
 *
 * `vitest.config.ts` runs `environment: "node"` with no jsdom and no component
 * harness, so page-level behaviour is untestable here by construction. Putting
 * the whole parse/serialize contract in `src/lib/**` is the only shape that
 * can be pinned — and it lands under the coverage gate, where the traps below
 * get permanent guards instead of review comments.
 *
 * ## The rule that must never be broken: MERGE, never rebuild
 *
 * `serializeFilterParams` starts from the CURRENT query string and edits only
 * the keys it owns. It must never construct a fresh one.
 *
 * `/inventory` accepts `?location=<id>` as a deep link, and that link is
 * encoded into **physically printed QR stickers on dry boxes**
 * (`src/lib/labelDeepLink.ts`). Those cannot be reissued. Its consumer waits
 * for the first fetch to resolve before reading the param, while a
 * URL-writing effect fires on mount — so a serializer that rebuilt the query
 * string would blank `?location=` before anything read it, and every printed
 * label would silently scroll nowhere. `preservesUnknownParams` in the tests
 * is the permanent guard on that.
 *
 * ## Defaults are omitted
 *
 * A value equal to its default is dropped, so an unfiltered list has a clean
 * URL and `?q=&type=` never accumulates. Round-tripping is therefore
 * idempotent: parse → serialize → parse yields the same state.
 */

/** How one piece of filter state maps to and from a query param. */
export interface FilterParamSpec<T> {
  /** The query-string key. Kept short — these end up in shared links. */
  param: string;
  /** The value meaning "not filtered". Omitted from the serialized string. */
  fallback: T;
  /** Raw string → value, or `null` when the value is not one this app accepts
   *  (a hand-edited or stale link), in which case the fallback is used. */
  parse: (raw: string) => T | null;
  /** Value → raw string. Defaults to `String(value)`. */
  serialize?: (value: T) => string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- a spec is heterogeneous
   by nature (string | boolean | union), and the exported helpers below are
   generic over the caller's own state type, which is what actually type-checks
   at the call sites. */
export type FilterSpec = Record<string, FilterParamSpec<any>>;
export type FilterState<S extends FilterSpec> = {
  [K in keyof S]: S[K] extends FilterParamSpec<infer T> ? T : never;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A parser for a fixed set of allowed strings. */
export function oneOf<T extends string>(allowed: readonly T[]): (raw: string) => T | null {
  return (raw) => (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** A parser for a flag written as `1` / `0`. Anything else is rejected, so a
 *  hand-typed `?oos=yes` falls back rather than silently reading as true. */
export const boolParam = {
  parse: (raw: string): boolean | null => (raw === "1" ? true : raw === "0" ? false : null),
  serialize: (v: boolean): string => (v ? "1" : "0"),
};

/** Free text: any non-empty string. Trimmed, because a link ending in `%20`
 *  would otherwise filter on whitespace and show nothing. */
export const textParam = {
  parse: (raw: string): string | null => {
    const t = raw.trim();
    return t === "" ? null : t;
  },
};

/**
 * Read a fully-defaulted state object out of a query string.
 *
 * Every key is present in the result, so callers can seed state without
 * per-key presence checks. An absent, empty or unparseable param yields that
 * key's fallback.
 */
export function parseFilterParams<S extends FilterSpec>(
  search: string,
  spec: S,
): FilterState<S> {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    params = new URLSearchParams();
  }
  const out = {} as FilterState<S>;
  for (const key of Object.keys(spec) as (keyof S)[]) {
    const entry = spec[key];
    const raw = params.get(entry.param);
    if (raw === null) {
      out[key] = entry.fallback;
      continue;
    }
    const parsed = entry.parse(raw);
    out[key] = (parsed === null ? entry.fallback : parsed) as FilterState<S>[keyof S];
  }
  return out;
}

/**
 * Produce the query string for `state`, PRESERVING every param the spec does
 * not own.
 *
 * Returns the string WITHOUT a leading `?` (empty when nothing is set), which
 * is what `history.replaceState` wants alongside `location.pathname`.
 *
 * Keys the spec owns are rewritten from `state`; a value equal to its fallback
 * is removed. Everything else in `current` is passed through untouched — see
 * the printed-QR note at the top of this file.
 */
export function serializeFilterParams<S extends FilterSpec>(
  current: string,
  spec: S,
  state: FilterState<S>,
): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(current);
  } catch {
    params = new URLSearchParams();
  }
  for (const key of Object.keys(spec) as (keyof S)[]) {
    const entry = spec[key];
    const value = state[key];
    if (value === entry.fallback) {
      params.delete(entry.param);
      continue;
    }
    const raw = entry.serialize ? entry.serialize(value) : String(value);
    // A value that serializes to empty is indistinguishable from absent once
    // it round-trips, so drop it rather than emitting a bare `key=`.
    if (raw === "") params.delete(entry.param);
    else params.set(entry.param, raw);
  }
  return params.toString();
}

/**
 * The full path to write, or `null` when it would not change the current URL.
 *
 * Returning null lets callers skip a no-op `replaceState`, which otherwise
 * fires on every render pass that recomputes the same state — and each write
 * re-renders the `useSearchParams` subtree elsewhere in the tree.
 */
export function nextFilterHref<S extends FilterSpec>(
  location: { pathname: string; search: string; hash: string },
  spec: S,
  state: FilterState<S>,
): string | null {
  const query = serializeFilterParams(location.search, spec, state);
  const next = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
  const currentQuery = location.search.startsWith("?")
    ? location.search.slice(1)
    : location.search;
  const currentHref = `${location.pathname}${currentQuery ? `?${currentQuery}` : ""}${location.hash}`;
  return next === currentHref ? null : next;
}

/**
 * The option list for a `<select>` whose current value may not be in it.
 *
 * A URL-supplied `?type=` / `?vendor=` is free text — the values come from the
 * user's own data, so they cannot be validated against a fixed union the way
 * `kind` or `sort` can. A stale bookmark or a hand-edited link can therefore
 * carry a value the distinct-value endpoints no longer return, and a
 * controlled `<select>` with no matching option renders as "All …": the filter
 * is applied to the query, invisible in the control, and re-choosing the shown
 * option may emit no change event, so it cannot even be cleared.
 *
 * Rendering the orphan as its own option keeps it visible and clearable.
 * Preferred over dropping the value, because the option lists load
 * asynchronously — clearing on absence would race the fetch and silently
 * discard a filter the URL explicitly asked for.
 */
export function withCurrentValue(options: string[], current: string): string[] {
  if (!current || options.includes(current)) return options;
  return [current, ...options];
}

/**
 * Which of the spec's keys the query string actually CARRIES.
 *
 * `parseFilterParams` deliberately cannot answer this: it returns the
 * fallback for an absent param, which is what a fresh visit wants. But two
 * callers need "absent" and "present with the default value" to differ,
 * because some keys are backed by a persisted preference:
 *
 *   - the mount seed — a bare `/` opens the way the user left it, while
 *     `?sortKey=cost` applies the link's sort for the visit;
 *   - the re-seed on a same-route navigation — clicking the header link
 *     clears the FILTERS but must not reset the sort the user has saved and
 *     then let the persist effect overwrite storage with the fallback
 *     (GH #1141, Codex P2).
 *
 * Presence means the param is there AND its value parses. A garbage value is
 * treated as absent, which keeps the persisted preference rather than
 * resetting to a default the URL never actually asked for.
 */
export function presentFilterKeys<S extends FilterSpec>(
  search: string,
  spec: S,
): Set<keyof S & string> {
  const params = new URLSearchParams(search);
  const present = new Set<keyof S & string>();
  for (const key of Object.keys(spec) as (keyof S & string)[]) {
    const raw = params.get(spec[key].param);
    if (raw !== null && spec[key].parse(raw) !== null) present.add(key);
  }
  return present;
}
