import { describe, it, expect } from "vitest";
import {
  excludeTemplates,
  liveTemplateIds,
  TEMPLATE_NOT_EXPORTABLE,
} from "@/lib/templateExportFilter";

/** Minimal stand-in for the Mongoose model — only `distinct` is used. */
function modelReturning(ids: unknown[]) {
  return {
    distinct: async (field: string, filter: Record<string, unknown>) => {
      expect(field).toBe("parentId");
      // Trashed variants must not confer template-ness, and the null-parent
      // rows (every root) must not come back as their own parents.
      expect(filter).toEqual({ _deletedAt: null, parentId: { $ne: null } });
      return ids;
    },
  };
}

describe("liveTemplateIds", () => {
  it("returns the distinct parents of live variants as strings", async () => {
    const ids = await liveTemplateIds(modelReturning(["aaa", "bbb", "aaa"]));
    expect(ids).toEqual(new Set(["aaa", "bbb"]));
  });

  it("stringifies ObjectId-like values so Set lookups match route callers", async () => {
    // The driver hands back ObjectIds, while callers test `String(f._id)`.
    // Without the coercion every lookup would miss and nothing would filter.
    const oid = { toString: () => "507f1f77bcf86cd799439011" };
    const ids = await liveTemplateIds(modelReturning([oid]));
    expect(ids.has("507f1f77bcf86cd799439011")).toBe(true);
  });

  it("drops null and undefined rather than admitting an empty-string id", async () => {
    const ids = await liveTemplateIds(modelReturning([null, undefined, "ccc"]));
    expect(ids).toEqual(new Set(["ccc"]));
  });

  it("is empty when no filament has variants", async () => {
    expect(await liveTemplateIds(modelReturning([]))).toEqual(new Set());
  });
});

describe("excludeTemplates", () => {
  const rows = [
    { _id: "t1", parentId: null }, // template
    { _id: "v1", parentId: "t1" }, // its variant
    { _id: "s1", parentId: null }, // standalone
  ];

  it("drops templates and keeps variants and standalones", () => {
    expect(excludeTemplates(rows, new Set(["t1"])).map((r) => r._id)).toEqual(["v1", "s1"]);
  });

  it("keeps a childless root — a standalone is not a template", () => {
    expect(excludeTemplates(rows, new Set()).map((r) => r._id)).toEqual(["t1", "v1", "s1"]);
  });

  it("matches on the stringified id, so ObjectId rows still filter", () => {
    const withOid = [{ _id: { toString: () => "t1" }, parentId: null }];
    expect(excludeTemplates(withOid, new Set(["t1"]))).toEqual([]);
  });

  it("never drops a variant whose own id is absent from the template set", () => {
    // A variant can never itself be a template (no nested inheritance), so a
    // parentId pointing at a template must not disqualify the child.
    expect(excludeTemplates(rows, new Set(["t1"])).some((r) => r._id === "v1")).toBe(true);
  });

  it("does not mutate the input", () => {
    const input = [...rows];
    excludeTemplates(input, new Set(["t1"]));
    expect(input).toHaveLength(3);
  });
});

describe("TEMPLATE_NOT_EXPORTABLE", () => {
  it("carries a stable machine-readable code the three routes share", () => {
    expect(TEMPLATE_NOT_EXPORTABLE.error).toBe("template_not_exportable");
    expect(TEMPLATE_NOT_EXPORTABLE.message).toMatch(/colour variant/i);
  });
});
