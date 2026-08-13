import { describe, it, expect } from "vitest";
import {
  parseFilterParams,
  serializeFilterParams,
  nextFilterHref,
  presentFilterKeys,
  seedFilterState,
  queryStringOf,
  oneOf,
  boolParam,
  textParam,
  exactTextParam,
  type FilterSpec,
} from "@/lib/listFilterParams";

/**
 * GH #1141. The pages themselves are untestable here — `vitest.config.ts` is
 * `environment: "node"` with no jsdom — so the whole contract lives in this
 * pure module and is pinned here.
 */

const SPEC = {
  search: { param: "q", fallback: "", ...textParam },
  type: { param: "type", fallback: "", ...textParam },
  quick: {
    param: "quick",
    fallback: "all" as const,
    parse: oneOf(["all", "lowStock", "hasSpools", "noCalibration"] as const),
  },
  showOutOfStock: { param: "oos", fallback: false, ...boolParam },
} satisfies FilterSpec;

describe("parseFilterParams", () => {
  it("returns every key, defaulted, for an empty query string", () => {
    expect(parseFilterParams("", SPEC)).toEqual({
      search: "",
      type: "",
      quick: "all",
      showOutOfStock: false,
    });
  });

  it("reads values, with or without the leading ?", () => {
    const want = { search: "pla", type: "PETG", quick: "lowStock", showOutOfStock: true };
    expect(parseFilterParams("?q=pla&type=PETG&quick=lowStock&oos=1", SPEC)).toEqual(want);
    expect(parseFilterParams("q=pla&type=PETG&quick=lowStock&oos=1", SPEC)).toEqual(want);
  });

  it("falls back on a value this app does not accept", () => {
    // A hand-edited or stale link must not put the UI in an impossible state.
    expect(parseFilterParams("?quick=nonsense", SPEC).quick).toBe("all");
    expect(parseFilterParams("?oos=yes", SPEC).showOutOfStock).toBe(false);
  });

  it("treats whitespace-only text as absent", () => {
    // Otherwise a link ending in %20 filters on a space and shows nothing.
    expect(parseFilterParams("?q=%20%20", SPEC).search).toBe("");
    expect(parseFilterParams("?q=%20pla%20", SPEC).search).toBe("pla");
  });
});

describe("serializeFilterParams", () => {
  it("omits values equal to their default", () => {
    expect(
      serializeFilterParams("", SPEC, {
        search: "",
        type: "",
        quick: "all",
        showOutOfStock: false,
      }),
    ).toBe("");
  });

  it("writes only the keys that differ from their default", () => {
    const out = serializeFilterParams("", SPEC, {
      search: "pla",
      type: "",
      quick: "lowStock",
      showOutOfStock: false,
    });
    expect(new URLSearchParams(out).get("q")).toBe("pla");
    expect(new URLSearchParams(out).get("quick")).toBe("lowStock");
    expect(new URLSearchParams(out).has("type")).toBe(false);
    expect(new URLSearchParams(out).has("oos")).toBe(false);
  });

  /**
   * THE LOAD-BEARING TEST.
   *
   * `?location=` is encoded into physically printed dry-box QR stickers
   * (`src/lib/labelDeepLink.ts`) and cannot be reissued. Its consumer waits
   * for the first fetch before reading it, while a URL-writing effect fires on
   * mount — so a serializer that REBUILT the query string would blank the
   * param before anything read it, and every printed label would silently
   * scroll nowhere.
   */
  it("preserves params it does not own", () => {
    const out = serializeFilterParams("?location=507f1f77bcf86cd799439011&spool=abc", SPEC, {
      search: "pla",
      type: "",
      quick: "all",
      showOutOfStock: false,
    });
    const p = new URLSearchParams(out);
    expect(p.get("location")).toBe("507f1f77bcf86cd799439011");
    expect(p.get("spool")).toBe("abc");
    expect(p.get("q")).toBe("pla");
  });

  it("clears a param when its value returns to the default", () => {
    const out = serializeFilterParams("?q=pla&location=xyz", SPEC, {
      search: "",
      type: "",
      quick: "all",
      showOutOfStock: false,
    });
    const p = new URLSearchParams(out);
    expect(p.has("q")).toBe(false);
    // ...without taking the unowned param with it.
    expect(p.get("location")).toBe("xyz");
  });

  it("round-trips: parse -> serialize -> parse is stable", () => {
    const first = parseFilterParams("?q=pla&quick=lowStock&oos=1", SPEC);
    const again = parseFilterParams(serializeFilterParams("", SPEC, first), SPEC);
    expect(again).toEqual(first);
  });

  it("survives a malformed query string instead of throwing", () => {
    expect(() => serializeFilterParams("%%%", SPEC, parseFilterParams("%%%", SPEC))).not.toThrow();
  });
});

describe("nextFilterHref", () => {
  const loc = (search: string) => ({ pathname: "/inventory", search, hash: "" });

  it("returns null when nothing would change", () => {
    // No-op writes would otherwise fire on every render that recomputes the
    // same state, each one re-rendering the useSearchParams subtree.
    const state = parseFilterParams("?q=pla", SPEC);
    expect(nextFilterHref(loc("?q=pla"), SPEC, state)).toBeNull();
  });

  it("returns null for an unfiltered state on a bare URL", () => {
    expect(nextFilterHref(loc(""), SPEC, parseFilterParams("", SPEC))).toBeNull();
  });

  it("builds pathname + query when the state changed", () => {
    const state = { ...parseFilterParams("", SPEC), search: "pla" };
    expect(nextFilterHref(loc(""), SPEC, state)).toBe("/inventory?q=pla");
  });

  it("drops the query entirely when the last filter clears", () => {
    const state = parseFilterParams("", SPEC);
    expect(nextFilterHref(loc("?q=pla"), SPEC, state)).toBe("/inventory");
  });

  it("keeps the hash", () => {
    const state = { ...parseFilterParams("", SPEC), search: "pla" };
    expect(
      nextFilterHref({ pathname: "/inventory", search: "", hash: "#spool-1" }, SPEC, state),
    ).toBe("/inventory?q=pla#spool-1");
  });

  it("keeps an unowned param when the state changes", () => {
    const state = { ...parseFilterParams("?location=xyz", SPEC), search: "pla" };
    const href = nextFilterHref(loc("?location=xyz"), SPEC, state);
    expect(href).not.toBeNull();
    const p = new URLSearchParams(href!.split("?")[1]);
    expect(p.get("location")).toBe("xyz");
    expect(p.get("q")).toBe("pla");
  });
});

/**
 * GH #1141 (Codex P2). `parseFilterParams` cannot answer "did the URL actually
 * say anything about this key?" — it returns the fallback either way, which is
 * right for a fresh visit and wrong for a key backed by a persisted preference.
 * Clicking the header link while filtered navigates to a bare route; treating
 * the fallback as an instruction there reset the user's saved sort AND had the
 * persist effect overwrite storage with it.
 */
describe("presentFilterKeys", () => {
  it("is empty for a bare query string — the case that caused the regression", () => {
    expect(presentFilterKeys("", SPEC).size).toBe(0);
    // ...while parse still hands back a full, defaulted state. Both are
    // correct; conflating them is what destroyed the stored preference.
    expect(parseFilterParams("", SPEC).quick).toBe("all");
  });

  it("reports a param present even when its value equals the fallback", () => {
    // `?quick=all` is an explicit instruction, not silence — a shared link
    // that pins the default has to override a persisted non-default.
    const present = presentFilterKeys("quick=all&oos=0&q=", SPEC);
    expect(present.has("quick")).toBe(true);
    expect(present.has("oos" as never)).toBe(false); // keyed by SPEC key, not param
    expect(present.has("showOutOfStock")).toBe(true);
    // `q=` parses to null (textParam trims to empty), so it counts as absent.
    expect(present.has("search")).toBe(false);
  });

  it("treats an unparseable value as absent, keeping the persisted preference", () => {
    // A default the URL never asked for is worse than leaving things alone.
    expect(presentFilterKeys("quick=bogus&oos=maybe", SPEC).size).toBe(0);
  });

  it("ignores params outside the spec", () => {
    // `?location=` rides on printed dry-box QR stickers; it is not ours.
    expect(presentFilterKeys("location=abc123", SPEC).size).toBe(0);
  });

  it("accepts a leading ? like the other helpers", () => {
    expect(presentFilterKeys("?type=PLA", SPEC).has("type")).toBe(true);
  });
});

/**
 * GH #1141 (Codex P1). Serialization omits a value equal to its fallback, so a
 * sender sorted cost/ASC shared `?sort=cost` and said nothing about direction —
 * a recipient with a saved DESC opened the same link sorted differently, and
 * the mirror then rewrote the URL to match. Two people, one link, two views.
 *
 * A sticky key is emitted explicitly whenever anything is emitted, so absence
 * means exactly one thing: this URL is not talking about filters.
 */
describe("sticky keys", () => {
  const STICKY_SPEC = {
    search: { param: "q", fallback: "", ...textParam },
    sortKey: { param: "sort", fallback: "name", parse: oneOf(["name", "cost"] as const), sticky: true },
    sortDir: { param: "dir", fallback: "asc", parse: oneOf(["asc", "desc"] as const), sticky: true },
  } satisfies FilterSpec;

  it("emits a sticky key at its fallback once anything else is emitted", () => {
    // The reported case: cost + ASC. Pre-fix this was `sort=cost` alone.
    const q = serializeFilterParams("", STICKY_SPEC, {
      search: "",
      sortKey: "cost",
      sortDir: "asc",
    });
    expect(new URLSearchParams(q).get("sort")).toBe("cost");
    expect(new URLSearchParams(q).get("dir")).toBe("asc");
  });

  it("arms on a NON-sticky key too — a plain search carries the preferences", () => {
    const q = serializeFilterParams("", STICKY_SPEC, {
      search: "pla",
      sortKey: "name",
      sortDir: "asc",
    });
    expect(new URLSearchParams(q).get("q")).toBe("pla");
    expect(new URLSearchParams(q).get("sort")).toBe("name");
    expect(new URLSearchParams(q).get("dir")).toBe("asc");
  });

  it("stays BARE for an all-default view — the gate that keeps printed QRs clean", () => {
    // Load-bearing: without it every `/inventory?location=X` sticker would
    // gain four preference params and reset the scanner's saved grouping.
    expect(
      serializeFilterParams("", STICKY_SPEC, { search: "", sortKey: "name", sortDir: "asc" }),
    ).toBe("");
  });

  it("is not a ratchet — clearing the last filter returns to bare", () => {
    const filtered = serializeFilterParams("", STICKY_SPEC, {
      search: "pla",
      sortKey: "name",
      sortDir: "asc",
    });
    expect(
      serializeFilterParams(filtered, STICKY_SPEC, {
        search: "",
        sortKey: "name",
        sortDir: "asc",
      }),
    ).toBe("");
  });

  it("does not arm on an unowned param alone", () => {
    // `?location=` is printed on dry-box stickers and is not ours.
    const q = serializeFilterParams("location=abc123", STICKY_SPEC, {
      search: "",
      sortKey: "name",
      sortDir: "asc",
    });
    expect(new URLSearchParams(q).get("location")).toBe("abc123");
    expect(new URLSearchParams(q).has("sort")).toBe(false);
  });

  it("still preserves unknown params when it does arm", () => {
    const q = serializeFilterParams("location=abc123", STICKY_SPEC, {
      search: "pla",
      sortKey: "name",
      sortDir: "asc",
    });
    expect(new URLSearchParams(q).get("location")).toBe("abc123");
    expect(new URLSearchParams(q).get("sort")).toBe("name");
  });

  it("reaches a fixed point, so the mirror does not churn", () => {
    const href = nextFilterHref(
      { pathname: "/", search: "", hash: "" },
      STICKY_SPEC,
      { search: "pla", sortKey: "cost", sortDir: "desc" },
    );
    const written = href!.slice(href!.indexOf("?"));
    expect(
      nextFilterHref({ pathname: "/", search: written, hash: "" }, STICKY_SPEC, {
        search: "pla",
        sortKey: "cost",
        sortDir: "desc",
      }),
    ).toBeNull();
  });

  it("round-trips a shared link identically regardless of the reader's prefs", () => {
    // The whole point. Sender is cost/ASC; two recipients with opposite saved
    // directions must both see the sender's view.
    const shared = serializeFilterParams("", STICKY_SPEC, {
      search: "",
      sortKey: "cost",
      sortDir: "asc",
    });
    for (const saved of ["asc", "desc"] as const) {
      const seeded = seedFilterState(shared, STICKY_SPEC, { sortKey: "name", sortDir: saved });
      expect(seeded.sortKey).toBe("cost");
      expect(seeded.sortDir).toBe("asc");
    }
  });
});

describe("sticky keys at the clear-to-bare boundary (Codex P2, second pass)", () => {
  const SPEC3 = {
    search: { param: "q", fallback: "", ...textParam },
    sortKey: { param: "sort", fallback: "name", parse: oneOf(["name", "cost"] as const), sticky: true },
    sortDir: { param: "dir", fallback: "asc", parse: oneOf(["asc", "desc"] as const), sticky: true },
  } satisfies FilterSpec;
  const persisted = { sortKey: "cost", sortDir: "desc" } as const;

  it("keeps the sticky keys encoded while the view differs from the persisted prefs", () => {
    // The reported sequence, end to end. A recipient saved cost/desc opens a
    // shared name/asc link and clears its search: pass 1 deletes everything
    // (the link's sort equals the spec fallback), and pre-fix the URL went
    // bare while the page still showed name/asc — so a reload silently
    // swapped the view for cost/desc. Bare means "use my prefs"; it must be
    // TRUE before the URL is allowed to say it.
    const shared = "q=pla&sort=name&dir=asc";
    const seeded = seedFilterState(shared, SPEC3, persisted);
    expect(seeded.sortKey).toBe("name");

    const cleared = serializeFilterParams(shared, SPEC3, { ...seeded, search: "" }, persisted);
    expect(new URLSearchParams(cleared).get("sort")).toBe("name");
    expect(new URLSearchParams(cleared).get("dir")).toBe("asc");

    // The round trip is what matters: a reload of the produced URL shows
    // exactly what the page was showing.
    const reloaded = seedFilterState(cleared, SPEC3, persisted);
    expect(reloaded.sortKey).toBe("name");
    expect(reloaded.sortDir).toBe("asc");
  });

  it("goes bare exactly when bare is TRUE: view == prefs == the fallbacks", () => {
    // A view matching NON-fallback prefs still encodes (pass 1 emits the
    // non-default value, which arms the sticky pass) — fine, deterministic,
    // and a refresh reproduces it either way. Bare is reserved for the one
    // state it truthfully describes.
    expect(
      serializeFilterParams("sort=cost&dir=desc", SPEC3, {
        search: "",
        sortKey: "cost",
        sortDir: "desc",
      }, persisted),
    ).toBe("sort=cost&dir=desc");
    expect(
      serializeFilterParams("sort=name&dir=asc", SPEC3, {
        search: "",
        sortKey: "name",
        sortDir: "asc",
      }, { sortKey: "name", sortDir: "asc" }),
    ).toBe("");
  });

  it("still goes bare for an all-default view when nothing is persisted for the keys", () => {
    // Back-compat: no persisted arg (or none of the keys present) keeps the
    // original emitted-anything trigger alone.
    expect(
      serializeFilterParams("", SPEC3, { search: "", sortKey: "name", sortDir: "asc" }),
    ).toBe("");
    expect(
      serializeFilterParams("", SPEC3, { search: "", sortKey: "name", sortDir: "asc" }, {}),
    ).toBe("");
  });

  it("reaches a fixed point, so the mirror does not churn at the boundary", () => {
    const state = { search: "", sortKey: "name", sortDir: "asc" } as const;
    const href = nextFilterHref(
      { pathname: "/", search: "?q=pla&sort=name&dir=asc", hash: "" },
      SPEC3,
      state,
      persisted,
    );
    const written = href!.slice(href!.indexOf("?"));
    expect(
      nextFilterHref({ pathname: "/", search: written, hash: "" }, SPEC3, state, persisted),
    ).toBeNull();
  });
});

describe("seedFilterState", () => {
  const SPEC2 = {
    search: { param: "q", fallback: "", ...textParam },
    sortKey: { param: "sort", fallback: "name", parse: oneOf(["name", "cost"] as const), sticky: true },
  } satisfies FilterSpec;

  it("keeps the persisted value for a sticky key the URL does not carry", () => {
    // A bare route means "use my preference" — the mount case, and the case
    // that clicking the header link while filtered has to preserve.
    expect(seedFilterState("", SPEC2, { sortKey: "cost" })).toEqual({
      search: "",
      sortKey: "cost",
    });
  });

  it("CLEARS a non-sticky filter the URL does not carry", () => {
    // The asymmetry is the feature: a filter the URL is silent about is
    // cleared, a preference it is silent about is kept.
    expect(seedFilterState("", SPEC2, { sortKey: "cost" }).search).toBe("");
    expect(seedFilterState("sort=name", SPEC2, { sortKey: "cost" }).sortKey).toBe("name");
  });

  it("lets the URL win over the persisted value", () => {
    expect(seedFilterState("q=pla&sort=cost", SPEC2, { sortKey: "name" })).toEqual({
      search: "pla",
      sortKey: "cost",
    });
  });

  it("falls back to the spec default when nothing is persisted for the key", () => {
    expect(seedFilterState("", SPEC2, {}).sortKey).toBe("name");
  });

  it("treats an unparseable sticky value as silence, not as a reset", () => {
    expect(seedFilterState("sort=bogus", SPEC2, { sortKey: "cost" }).sortKey).toBe("cost");
  });
});

/**
 * GH #1141 (Codex P2, third pass). The own-write marker must store exactly
 * what `useSearchParams().toString()` will echo — which never includes a
 * fragment, while `nextFilterHref` (correctly) preserves one. A marker with
 * the hash baked in never matches, so the page misclassifies its own write as
 * an external navigation and the re-seed clobbers live input.
 */
describe("queryStringOf", () => {
  it("strips the fragment the skip link leaves on the URL", () => {
    expect(queryStringOf("/?q=pla#main-content")).toBe("q=pla");
  });

  it("returns the query alone when there is no fragment", () => {
    expect(queryStringOf("/inventory?q=pla&group=vendor")).toBe("q=pla&group=vendor");
  });

  it("returns empty for a bare path, with or without a fragment", () => {
    expect(queryStringOf("/")).toBe("");
    expect(queryStringOf("/#main-content")).toBe("");
  });

  it("ignores a ? that appears inside the fragment", () => {
    // A hash may itself contain a ?; only the real query counts.
    expect(queryStringOf("/#section?fake=1")).toBe("");
  });
});

/**
 * GH #1141 (Codex P2, fourth pass). Type and vendor are EXACT keys into
 * stored data — the schema trims `name` but not these, and the list APIs
 * compare them with `$eq` — so a stored `"PLA "` is a selectable value that
 * must round-trip byte-exact. `textParam`'s trim broke the refresh: select
 * it, filter correctly, reload, and the parsed `"PLA"` matches nothing.
 */
describe("exactTextParam", () => {
  const SPEC4 = {
    type: { param: "type", fallback: "", ...exactTextParam },
  } satisfies FilterSpec;

  it("round-trips a value with edge whitespace byte-exact", () => {
    const q = serializeFilterParams("", SPEC4, { type: "PLA " });
    expect(q).toBe("type=PLA+");
    expect(parseFilterParams(q, SPEC4).type).toBe("PLA ");
  });

  it("treats an empty param as absent, like its trimming sibling", () => {
    expect(parseFilterParams("type=", SPEC4).type).toBe("");
    expect(exactTextParam.parse("")).toBeNull();
  });

  it("faithfully passes a whitespace-only value through", () => {
    // `?type=%20` filters on a literal space — probably an empty result, but
    // exact means exact; editorializing here is how the round trip broke.
    expect(parseFilterParams("type=%20", SPEC4).type).toBe(" ");
  });
});
