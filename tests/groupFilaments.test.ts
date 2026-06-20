import { describe, it, expect } from "vitest";
import { buildFilamentGroups } from "@/lib/groupFilaments";

type F = {
  _id: string;
  parentId?: string | null;
  name?: string;
  cost?: number | null;
};

const parent = (id: string, extra: Partial<F> = {}): F => ({ _id: id, ...extra });
const variant = (id: string, parentId: string, extra: Partial<F> = {}): F => ({
  _id: id,
  parentId,
  ...extra,
});

describe("buildFilamentGroups", () => {
  it("groups a parent with its variants and keeps standalones separate", () => {
    const all = [parent("p"), variant("v1", "p"), variant("v2", "p"), parent("s")];
    const { groups, standalone } = buildFilamentGroups(all, all);
    expect(groups).toHaveLength(1);
    expect(groups[0].parent._id).toBe("p");
    expect(groups[0].variants.map((v) => v._id)).toEqual(["v1", "v2"]);
    expect(standalone.map((f) => f._id)).toEqual(["s"]);
  });

  // The #744 / #786 invariant: the chip count (group.variants.length) equals the
  // number of variants in the FULL list, even when the out-of-stock filter has
  // dropped some variants from `visibleFilaments`.
  it("includes out-of-stock variants of a shown family (chip == displayed)", () => {
    const all = [
      parent("p"),
      variant("v1", "p"),
      variant("v2", "p"), // out of stock — filtered from visible
      variant("v3", "p"), // out of stock — filtered from visible
    ];
    // Simulate #712: the parent is shown (a sibling is in stock) but two
    // variants were stripped from the visible set.
    const visible = [parent("p"), variant("v1", "p")];

    const { groups } = buildFilamentGroups(all, visible);

    expect(groups).toHaveLength(1);
    const fullCount = all.filter((f) => f.parentId === "p").length;
    expect(groups[0].variants).toHaveLength(fullCount); // 3, not 1
    expect(groups[0].variants.map((v) => v._id)).toEqual(["v1", "v2", "v3"]);
  });

  it("keeps a parent shown via its own spool but with all variants out of stock", () => {
    const all = [parent("p"), variant("v1", "p"), variant("v2", "p")];
    // Parent itself is visible (own spool) but no variant survived the filter.
    const visible = [parent("p")];

    const { groups, standalone } = buildFilamentGroups(all, visible);

    expect(standalone).toHaveLength(0); // not demoted to a standalone row
    expect(groups).toHaveLength(1);
    expect(groups[0].variants.map((v) => v._id)).toEqual(["v1", "v2"]);
  });

  it("renders a visible variant standalone when its parent is filtered out", () => {
    const all = [parent("p"), variant("v1", "p")];
    // Server-side search matched the variant but not the parent row.
    const visible = [variant("v1", "p")];

    const { groups, standalone } = buildFilamentGroups(all, visible, {
      parentLookup: new Map([["p", parent("p", { cost: 25 })]]),
      enrichVariant: (v, p) => (p ? { ...v, cost: v.cost ?? p.cost } : v),
    });

    expect(groups).toHaveLength(0);
    expect(standalone.map((f) => f._id)).toEqual(["v1"]);
    expect(standalone[0].cost).toBe(25); // enriched from the hidden parent
  });

  it("does not double-render an in-stock variant that's both visible and grouped", () => {
    const all = [parent("p"), variant("v1", "p"), variant("v2", "p")];
    const visible = [parent("p"), variant("v1", "p")]; // v1 in stock + parent shown

    const { groups, standalone } = buildFilamentGroups(all, visible);

    expect(standalone).toHaveLength(0);
    expect(groups[0].variants.map((v) => v._id)).toEqual(["v1", "v2"]);
    // v1 appears exactly once (inside the group, not also as a standalone)
    const allRendered = [
      ...groups.flatMap((g) => g.variants.map((v) => v._id)),
      ...standalone.map((f) => f._id),
    ];
    expect(allRendered.filter((id) => id === "v1")).toHaveLength(1);
  });

  // Codex P2 on #788: the FIRST arg (source) controls membership, so the
  // caller can pass a content-filtered set (e.g. the `hasSpools` quick filter)
  // and the group will only carry variants that pass the filter — it must NOT
  // reach past the source into a wider list.
  it("limits a group's variants to the provided source set", () => {
    const all = [parent("p"), variant("v1", "p"), variant("v2", "p")];
    // hasSpools-style: only the parent + v1 survive the content filter.
    const filtered = [parent("p"), variant("v1", "p")];
    const { groups } = buildFilamentGroups(filtered, filtered);
    expect(groups).toHaveLength(1);
    expect(groups[0].variants.map((v) => v._id)).toEqual(["v1"]); // v2 excluded
    expect(all.length).toBe(3); // sanity: v2 exists, just not in the source
  });

  it("applies enrichVariant to grouped variants", () => {
    const all = [parent("p", { cost: 30 }), variant("v1", "p", { cost: null })];
    const { groups } = buildFilamentGroups(all, all, {
      enrichVariant: (v, p) => (p ? { ...v, cost: v.cost ?? p.cost } : v),
    });
    expect(groups[0].variants[0].cost).toBe(30);
  });
});
