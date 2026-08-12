import { describe, it, expect } from "vitest";
import {
  parseFilterParams,
  serializeFilterParams,
  nextFilterHref,
  presentFilterKeys,
  oneOf,
  boolParam,
  textParam,
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
