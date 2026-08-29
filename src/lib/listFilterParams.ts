/**
 * Filter/search/sort state carried in the URL query string (GH #1141), for
 * the filament list and Spool Inventory pages.
 *
 * ## Why a pure module
 *
 * `vitest.config.ts` runs `environment: "node"` with no jsdom, so page-level
 * behaviour is untestable by construction. The whole parse/serialize contract
 * lives in `src/lib/**` so it lands under the coverage gate, where the traps
 * below get permanent guards.
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
  /**
   * This key is backed by a PERSISTED preference, so its absence is
   * ambiguous — and the ambiguity is a bug (GH #1141).
   *
   * Serialization normally omits a value equal to its fallback, which means a
   * shared `?sort=cost` from a sender on ascending order says nothing about
   * direction; a recipient whose saved direction is descending then opens the
   * link sorted differently from the sender, and the mirror rewrites the URL
   * to match. Two people, one link, two views.
   *
   * A sticky key is therefore emitted EXPLICITLY whenever the serializer
   * emits anything at all, even at its fallback. Absence then means only one
   * thing — "this URL is not talking about filters" — which is exactly when
   * the persisted preference should win.
   *
   * A fully default view still serializes to a bare URL: nothing is emitted,
   * so nothing is made sticky. That gate is load-bearing. Without it every
   * printed dry-box QR (`/inventory?location=X`) would gain four preference
   * params and reset the scanner's saved grouping.
   *
   * INVARIANT, asserted in the tests: a sticky key's fallback must not
   * serialize to the empty string, or the delete branch below silently
   * un-sticks it and reintroduces this bug for that key alone.
   */
  sticky?: boolean;
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

/** Free text the USER TYPES — a substring query. Trimmed, because the pages
 *  canonicalize the live value the same way (the debounce trims), so the
 *  trimmed form IS the value; a link ending in `%20` would otherwise filter
 *  on whitespace and show nothing. Use `exactTextParam` for values that are
 *  keys into stored data. */
export const textParam = {
  parse: (raw: string): string | null => {
    const t = raw.trim();
    return t === "" ? null : t;
  },
};

/**
 * Free text that is an EXACT KEY into stored data — type and vendor
 * (GH #1141). The Filament schema trims `name` but NOT `type`/`vendor`, and
 * the list APIs compare both with exact `$eq` — so a stored `"PLA "` is a
 * legitimately selectable value, and trimming it at the URL boundary breaks
 * the round trip (refresh → the parsed `"PLA"` matches nothing). The stored
 * bytes are the value; the URL layer may not editorialize them. (A lone
 * `?type=%20` therefore filters on a space, faithfully — GH #1149 tracks
 * normalizing the FIELDS, after which this could trim again.)
 */
export const exactTextParam = {
  parse: (raw: string): string | null => (raw === "" ? null : raw),
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
  /** The persisted values behind the sticky keys, when the caller has them.
   *  See the second trigger below — without this the boundary case regresses. */
  persistedSticky?: Partial<FilterState<S>>,
): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(current);
  } catch {
    params = new URLSearchParams();
  }
  // TWO passes, and the split is required rather than tidy: whether a sticky
  // key must be emitted depends on whether ANY key emitted, which is not known
  // until every key has been visited. Deciding inside one loop would make the
  // output depend on `Object.keys(spec)` ordering.
  let emittedAny = false;
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
    else {
      params.set(entry.param, raw);
      // Armed by an ACTUAL set, never by `value !== fallback` — the branch
      // above deletes, and a non-default value that serializes to empty must
      // not drag the sticky keys into an otherwise-bare URL.
      emittedAny = true;
    }
  }
  // Sticky keys are emitted on EITHER trigger:
  //
  //  1. anything else emitted — the original rule, which makes a shared link
  //     deterministic; or
  //  2. the sticky state DIFFERS from the caller's persisted values — the
  //     boundary the first trigger alone missed. Open a shared sort link and
  //     clear its search: pass 1 deletes everything (the link's sort may equal
  //     the spec fallback), the URL went bare, and a reload then seeded the
  //     PERSISTED sort while the page still showed the link's. A bare URL
  //     means "use my prefs"; it is only truthful while the view actually
  //     matches them, so the sticky keys stay encoded until it does.
  //
  // A fully-default view over matching prefs still serializes bare — the gate
  // that keeps printed dry-box QRs clean — and callers without persisted
  // values (or without sticky keys) get trigger 1 alone, the prior behaviour.
  let emitSticky = emittedAny;
  if (!emitSticky && persistedSticky) {
    for (const key of Object.keys(spec) as (keyof S)[]) {
      const entry = spec[key];
      if (!entry.sticky || !(key in persistedSticky)) continue;
      if (state[key] !== persistedSticky[key]) {
        emitSticky = true;
        break;
      }
    }
  }
  if (emitSticky) {
    for (const key of Object.keys(spec) as (keyof S)[]) {
      const entry = spec[key];
      if (!entry.sticky) continue;
      const value = state[key];
      const raw = entry.serialize ? entry.serialize(value) : String(value);
      if (raw !== "") params.set(entry.param, raw);
    }
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
  persistedSticky?: Partial<FilterState<S>>,
): string | null {
  const query = serializeFilterParams(location.search, spec, state, persistedSticky);
  const next = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
  const currentQuery = location.search.startsWith("?")
    ? location.search.slice(1)
    : location.search;
  const currentHref = `${location.pathname}${currentQuery ? `?${currentQuery}` : ""}${location.hash}`;
  return next === currentHref ? null : next;
}

/**
 * The query component of an href, without the `?` and WITHOUT the fragment.
 *
 * For the own-write marker (GH #1141): the pages record what they hand to
 * `router.replace` so the echo through `useSearchParams` can
 * be told apart from an external navigation. `nextFilterHref` preserves the
 * hash — correctly, the skip link's `#main-content` must survive a write — but
 * `useSearchParams().toString()` never contains one. A naive
 * `href.slice(indexOf("?") + 1)` therefore stored `q=pla#main-content` while
 * the echo reported `q=pla`: the marker never matched, the page misclassified
 * its own write as external, and the re-seed clobbered live input — with the
 * debounce trim, typing `"pla "` and pausing ate the separator space.
 */
export function queryStringOf(href: string): string {
  // The fragment bounds the search: a `?` inside the hash is fragment text,
  // not a query delimiter (`/#section?fake=1` has no query at all).
  const h = href.indexOf("#");
  const beforeHash = h === -1 ? href : href.slice(0, h);
  const q = beforeHash.indexOf("?");
  return q === -1 ? "" : beforeHash.slice(q + 1);
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
 * Resolve the state a page should adopt from a query string.
 *
 * One rule, declared once: a STICKY key falls back to the persisted preference
 * when the URL does not carry it; everything else takes the URL's value, which
 * for an absent param is the spec fallback — i.e. a filter the URL is silent
 * about is CLEARED, while a preference it is silent about is KEPT.
 *
 * Lives here rather than in the pages so the rule is declared once (rather
 * than hand-copied ternaries drifting per page) and sits under the coverage
 * gate.
 *
 * Both callers use it: the mount seed passes the STORED preferences, and the
 * re-seed (a same-route navigation) passes the CURRENT state, which is the
 * same question asked at a different moment — "what should survive a URL that
 * does not mention this?"
 */
export function seedFilterState<S extends FilterSpec>(
  search: string,
  spec: S,
  persisted: Partial<FilterState<S>>,
): FilterState<S> {
  const url = parseFilterParams(search, spec);
  const present = presentFilterKeys(search, spec);
  const out = {} as FilterState<S>;
  for (const key of Object.keys(spec) as (keyof S & string)[]) {
    const usePersisted = spec[key].sticky && !present.has(key) && key in persisted;
    out[key] = usePersisted ? (persisted[key] as FilterState<S>[typeof key]) : url[key];
  }
  return out;
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
 *     (GH #1141).
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
