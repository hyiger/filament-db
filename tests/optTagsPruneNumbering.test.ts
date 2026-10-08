import { describe, it, expect } from "vitest";
import { pruneOptPayloadAgainstParent } from "@/lib/optResync";
import { pruneParentEqualPrefill } from "@/lib/nfcVariantPrefill";
import { pruneInheritedCreateDoc } from "@/lib/importFilaments";

/**
 * GH #1227 — the three "drop what the parent already has" prunes compare a
 * variant's optTags with its parent's by VALUE. Equal values say nothing about
 * numbering: legacy 2 is "transparent", spec 2 is "antibacterial". Pruning an
 * array whose numbering differs from the parent's (or is unknown) hands the
 * variant the parent's reading — or the outcome of the parent's later review.
 * The OpenPrintTag and NFC paths always bring spec ids, so they prune only
 * under a parent whose ids are known spec ids too. The CSV path can also
 * bring unverified bare ids, so it prunes only when both sides are in the
 * same state: both reviewed, or both from one old export awaiting review.
 */
describe("tag prunes against a parent respect the numbering (GH #1227)", () => {
  const unreviewedParent = { optTags: [2] }; // no marker, ambiguous ids
  const reviewedParent = { optTags: [2], optTagsSpec: true };
  const trivialParent = { optTags: [16] }; // 16 matte means the same in both numberings

  describe("OpenPrintTag import as a variant (pruneOptPayloadAgainstParent)", () => {
    it("keeps the variant's spec tags under a parent still awaiting review", () => {
      const out = pruneOptPayloadAgainstParent({ optTags: [2] }, unreviewedParent);
      expect(out.optTags).toEqual([2]);
    });
    it("still prunes equal tags under a reviewed or trivially-spec parent", () => {
      expect(pruneOptPayloadAgainstParent({ optTags: [2] }, reviewedParent).optTags).toEqual([]);
      expect(pruneOptPayloadAgainstParent({ optTags: [16] }, trivialParent).optTags).toEqual([]);
    });
  });

  describe("Create variant from an NFC tag (pruneParentEqualPrefill)", () => {
    it("keeps the tag's spec ids under a parent still awaiting review", () => {
      const out = pruneParentEqualPrefill({ optTags: [2] }, unreviewedParent);
      expect(out.optTags).toEqual([2]);
    });
    it("still drops equal ids under a reviewed or trivially-spec parent", () => {
      expect(pruneParentEqualPrefill({ optTags: [2] }, reviewedParent)).not.toHaveProperty("optTags");
      expect(pruneParentEqualPrefill({ optTags: [16] }, trivialParent)).not.toHaveProperty("optTags");
    });
  });

  describe("CSV/XLSX create or resurrect of a variant (pruneInheritedCreateDoc)", () => {
    it("keeps an unverified cell's ids under a reviewed parent, so the row stays listed for review", () => {
      const out = pruneInheritedCreateDoc({ name: "V", optTags: [2], optTagsSpec: false }, reviewedParent);
      expect(out.optTags).toEqual([2]);
      expect(out.optTagsSpec).toBe(false);
    });
    it("keeps a verified cell's ids under a parent still awaiting review", () => {
      const out = pruneInheritedCreateDoc({ name: "V", optTags: [2], optTagsSpec: true }, unreviewedParent);
      expect(out.optTags).toEqual([2]);
    });
    it("prunes an unverified cell under a parent that also awaits review (one old export, GH #954)", () => {
      const out = pruneInheritedCreateDoc({ name: "V", optTags: [2], optTagsSpec: false }, { optTags: [2], optTagsSpec: false });
      expect(out.optTags).toEqual([]);
    });
    it("still prunes equal verified ids under a reviewed parent (the GH #954 round trip)", () => {
      expect(pruneInheritedCreateDoc({ name: "V", optTags: [2], optTagsSpec: true }, reviewedParent).optTags).toEqual([]);
      expect(pruneInheritedCreateDoc({ name: "V", optTags: [16] }, trivialParent).optTags).toEqual([]);
    });
  });
});
