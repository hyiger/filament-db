import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import {
  TEMPLATE_STRIP_FIELDS,
  stripTemplateFieldsForWrite,
} from "@/lib/templateStrip";

/**
 * GH #605 (codex P2, slicer-sync sweep) — the SHARED template strip helper.
 *
 * `stripTemplateFieldsForWrite` owns the strip semantics the PUT defined
 * (non-null members stripped in place when the target is a template;
 * explicit nulls pass through; nothing queried when nothing offends) and is
 * reused by every slicer sync-back write path plus both INI bulk importers.
 * The model is injected exactly like `hasVariants`' own signature, so these
 * tests run against stubs — the route-level behavior (locking, reporting
 * channels) is pinned in tests/slicer-sync-template-strip.test.ts.
 */
describe("stripTemplateFieldsForWrite (GH #605)", () => {
  /** A model stub whose live-variant count is fixed. */
  const modelWithVariantCount = (n: number) => ({
    countDocuments: async () => n,
  });

  it("pins the exact field list (atlas mirror + PUT + sync routes stay in lockstep)", () => {
    expect([...TEMPLATE_STRIP_FIELDS]).toEqual([
      "totalWeight",
      "color",
      "colorName",
      "lowStockThreshold",
    ]);
  });

  it("strips every non-null listed field in place on a template and returns them", async () => {
    const setBody: Record<string, unknown> = {
      color: "#00FF00",
      colorName: "Green",
      totalWeight: 1000,
      lowStockThreshold: 200,
      cost: 25, // unlisted — must survive
    };
    const stripped = await stripTemplateFieldsForWrite(
      modelWithVariantCount(2),
      "64b0000000000000000000aa",
      setBody,
    );
    expect(stripped).toEqual(["totalWeight", "color", "colorName", "lowStockThreshold"]);
    expect(setBody).toEqual({ cost: 25 });
  });

  it("lets an explicit null pass through (clearing a legacy carrying parent is cleanup)", async () => {
    const setBody: Record<string, unknown> = { color: null, colorName: null, cost: 9 };
    const stripped = await stripTemplateFieldsForWrite(
      modelWithVariantCount(1),
      "64b0000000000000000000aa",
      setBody,
    );
    expect(stripped).toEqual([]);
    // Nulls untouched — the write may clear the stored legacy values.
    expect(setBody).toEqual({ color: null, colorName: null, cost: 9 });
  });

  it("does not query variant state at all when no listed field offends", async () => {
    const explodingModel = {
      countDocuments: async () => {
        throw new Error("hasVariants must not be queried for a no-op strip");
      },
    };
    const setBody: Record<string, unknown> = { cost: 25, "temperatures.nozzle": 210 };
    const stripped = await stripTemplateFieldsForWrite(
      explodingModel,
      "64b0000000000000000000aa",
      setBody,
    );
    expect(stripped).toEqual([]);
    expect(setBody).toEqual({ cost: 25, "temperatures.nozzle": 210 });
  });

  it("leaves a NON-template's fields untouched (returns empty)", async () => {
    const setBody: Record<string, unknown> = { color: "#00FF00", totalWeight: 750 };
    const stripped = await stripTemplateFieldsForWrite(
      modelWithVariantCount(0),
      "64b0000000000000000000aa",
      setBody,
    );
    expect(stripped).toEqual([]);
    expect(setBody).toEqual({ color: "#00FF00", totalWeight: 750 });
  });

  it("string-coerces the id for the variant query (accepts an ObjectId)", async () => {
    let seenParentId: unknown;
    const capturingModel = {
      countDocuments: async (filter: { parentId: unknown }) => {
        seenParentId = filter.parentId;
        return 1;
      },
    };
    const oid = new mongoose.Types.ObjectId();
    const setBody: Record<string, unknown> = { color: "#123456" };
    const stripped = await stripTemplateFieldsForWrite(capturingModel, oid, setBody);
    expect(stripped).toEqual(["color"]);
    expect(seenParentId).toBe(String(oid));
  });
});
