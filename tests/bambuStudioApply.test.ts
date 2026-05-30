import { describe, it, expect } from "vitest";
import {
  buildStructuredUpdate,
  type ExistingFilamentForApply,
} from "@/lib/bambuStudioApply";
import type { ParsedFilament } from "@/lib/bambuStudioImport";

/**
 * GH #422 — direct tests for the pure `buildStructuredUpdate` helper.
 * The route tests indirectly exercise this through full Bambu-Studio
 * import flows but never reach the temperature-merge or bed-type
 * dedup edges in isolation, so coverage on those branches has been
 * implicit. These tests pin the pure mapping logic so a future tweak
 * surfaces immediately.
 *
 * The other exports in `bambuStudioApply.ts` (`prepareBambuUpdate`,
 * `resolveAndApplyCalibration`) are async + do mongoose queries; they
 * stay covered by the integration tests in `tests/bambustudio-route.
 * test.ts` where the in-memory DB is available.
 */
function makeParsed(over: Partial<ParsedFilament> = {}): ParsedFilament {
  return {
    name: "Test Filament",
    temperatures: {},
    bedTypeTemps: [],
    settings: {},
    ...over,
  };
}

describe("buildStructuredUpdate", () => {
  describe("scalar field mapping (only non-null fields are projected)", () => {
    it("emits every scalar field that's set on the parsed input", () => {
      const { set: update, unset } = buildStructuredUpdate(
        makeParsed({
          type: "PLA",
          vendor: "Bambu Lab",
          color: "#FF0000",
          diameter: 1.75,
          density: 1.24,
          cost: 24.99,
          maxVolumetricSpeed: 12,
          notes: "test",
          shrinkageXY: 1.5,
          shrinkageZ: 1.0,
        }),
        null,
      );
      expect(update.type).toBe("PLA");
      expect(update.vendor).toBe("Bambu Lab");
      expect(update.color).toBe("#FF0000");
      expect(update.diameter).toBe(1.75);
      expect(update.density).toBe(1.24);
      expect(update.cost).toBe(24.99);
      expect(update.maxVolumetricSpeed).toBe(12);
      expect(update.notes).toBe("test");
      expect(update.shrinkageXY).toBe(1.5);
      expect(update.shrinkageZ).toBe(1.0);
      expect(unset).toEqual([]);
    });

    it("skips fields that are not set on the parsed input (keeps update tiny)", () => {
      const { set: update } = buildStructuredUpdate(makeParsed({ type: "PLA" }), null);
      expect(Object.keys(update)).toEqual(["type"]);
    });

    it("treats numeric 0 as a real value, not as missing", () => {
      const { set: update } = buildStructuredUpdate(
        makeParsed({ shrinkageXY: 0, shrinkageZ: 0 }),
        null,
      );
      expect(update.shrinkageXY).toBe(0);
      expect(update.shrinkageZ).toBe(0);
    });
  });

  describe("temperatures: merge with existing", () => {
    it("merges parsed temperature keys with the existing temperatures bag", () => {
      const existing: ExistingFilamentForApply = {
        temperatures: {
          nozzle: 215,
          nozzleRangeMin: 200,
          nozzleRangeMax: 230,
        },
      };
      const { set: update } = buildStructuredUpdate(
        makeParsed({ temperatures: { nozzle: 220, bed: 60 } }),
        existing,
      );
      expect(update.temperatures).toEqual({
        nozzle: 220, // overwritten
        nozzleRangeMin: 200, // preserved from existing
        nozzleRangeMax: 230, // preserved from existing
        bed: 60, // added
      });
    });

    it("does not emit temperatures when the parsed bag has no non-null values", () => {
      const { set: update } = buildStructuredUpdate(makeParsed(), null);
      expect("temperatures" in update).toBe(false);
    });

    it("skips parsed temperature keys whose value is null", () => {
      const { set: update } = buildStructuredUpdate(
        makeParsed({ temperatures: { nozzle: 220, bed: null as unknown as number } }),
        null,
      );
      expect(update.temperatures).toEqual({ nozzle: 220 });
    });
  });

  describe("bedTypeTemps: merge by bedType name", () => {
    it("appends new bed types and replaces matching ones", () => {
      const existing: ExistingFilamentForApply = {
        bedTypeTemps: [
          { bedType: "PEI", temperature: 60 },
          { bedType: "Glass", temperature: 50 },
        ],
      };
      const { set: update } = buildStructuredUpdate(
        makeParsed({
          bedTypeTemps: [
            { bedType: "PEI", temperature: 65, firstLayerTemperature: 70 },
            { bedType: "Cool Plate", temperature: 35 },
          ],
        }),
        existing,
      );
      const list = update.bedTypeTemps as Array<Record<string, unknown>>;
      const byType = Object.fromEntries(list.map((e) => [e.bedType, e]));
      expect(byType.PEI).toEqual({
        bedType: "PEI",
        temperature: 65,
        firstLayerTemperature: 70,
      });
      expect(byType.Glass).toEqual({ bedType: "Glass", temperature: 50 });
      expect(byType["Cool Plate"]).toEqual({
        bedType: "Cool Plate",
        temperature: 35,
      });
    });

    it("converts null temperature/firstLayerTemperature on existing entries to undefined", () => {
      // Without this, the spread below would reintroduce nulls the model
      // accepts but the parser doesn't, churning the doc on every sync.
      const existing: ExistingFilamentForApply = {
        bedTypeTemps: [
          {
            bedType: "PEI",
            temperature: null,
            firstLayerTemperature: null,
          },
        ],
      };
      const { set: update } = buildStructuredUpdate(
        makeParsed({
          bedTypeTemps: [{ bedType: "PEI", temperature: 70 }],
        }),
        existing,
      );
      const list = update.bedTypeTemps as Array<Record<string, unknown>>;
      // Source-side null is mapped to undefined; the parsed entry then
      // overrides `temperature` and leaves `firstLayerTemperature` as
      // undefined. The on-disk Mongoose model will treat undefined as
      // missing, so the doc doesn't churn on re-sync.
      expect(list[0].bedType).toBe("PEI");
      expect(list[0].temperature).toBe(70);
      expect(list[0].firstLayerTemperature).toBeUndefined();
    });

    it("does not emit bedTypeTemps when the parsed array is empty", () => {
      const { set: update } = buildStructuredUpdate(makeParsed(), null);
      expect("bedTypeTemps" in update).toBe(false);
    });
  });

  describe("create branch (existing === null)", () => {
    it("emits temperatures from the parsed bag with no merge anchor", () => {
      const { set: update } = buildStructuredUpdate(
        makeParsed({ temperatures: { nozzle: 215 } }),
        null,
      );
      expect(update.temperatures).toEqual({ nozzle: 215 });
    });

    it("emits bedTypeTemps from the parsed array directly when existing is null", () => {
      const { set: update } = buildStructuredUpdate(
        makeParsed({
          bedTypeTemps: [{ bedType: "PEI", temperature: 60 }],
        }),
        null,
      );
      expect(update.bedTypeTemps).toEqual([
        { bedType: "PEI", temperature: 60 },
      ]);
    });
  });

  describe("variant inheritance preservation (GH #403)", () => {
    // The per-id Bambu sync route used to stamp every parsed scalar
    // onto the target document even when the target was a variant
    // currently inheriting those fields from its parent. After one
    // sync, density/cost/diameter/etc. were pinned on the variant —
    // silently severing inheritance for every field the Bambu profile
    // carried. The variant-aware branch in buildStructuredUpdate
    // skips a scalar when the parsed value already matches what the
    // parent provides, so inheritance continues to resolve dynamically
    // at read time via resolveFilament().

    it("does NOT pin a scalar on a variant when the parent already has the same value", () => {
      const parent = { type: "PLA", vendor: "Polymaker", density: 1.24, cost: 25 };
      const existing = { parentId: "parent-id", parent };
      const { set: update, unset } = buildStructuredUpdate(
        makeParsed({ type: "PLA", vendor: "Polymaker", density: 1.24, cost: 25 }),
        existing,
      );
      expect("type" in update).toBe(false);
      expect("vendor" in update).toBe(false);
      expect("density" in update).toBe(false);
      expect("cost" in update).toBe(false);
      // No stale variant value to clear — variant already inherited.
      expect(unset).toEqual([]);
    });

    it("DOES pin a scalar on a variant when the parsed value differs from the parent", () => {
      const parent = { type: "PLA", density: 1.24 };
      const existing = { parentId: "parent-id", parent };
      const { set: update } = buildStructuredUpdate(
        makeParsed({ type: "PLA+", density: 1.30 }),
        existing,
      );
      expect(update.type).toBe("PLA+");
      expect(update.density).toBe(1.30);
    });

    it("always emits color even on a variant (color is NOT inheritable)", () => {
      const parent = { color: "#FF0000" };
      const existing = { parentId: "parent-id", parent };
      const { set: update } = buildStructuredUpdate(
        makeParsed({ color: "#FF0000" }),
        existing,
      );
      // Even though parent.color matches, color is the variant's own
      // identity — never inherited.
      expect(update.color).toBe("#FF0000");
    });

    it("treats existing without parentId as a root filament — every scalar emits", () => {
      const { set: update } = buildStructuredUpdate(
        makeParsed({ type: "PLA", vendor: "Polymaker" }),
        { parentId: null, parent: null },
      );
      expect(update.type).toBe("PLA");
      expect(update.vendor).toBe("Polymaker");
    });

    it("treats existing with parentId but missing parent doc as a root (defensive)", () => {
      // If the parent doc was deleted between the variant fetch and
      // the parent lookup, fall back to emitting (avoid losing data
      // on the variant). The downstream resolveFilament call at read
      // time then returns the variant's own value, which is what we
      // wrote here.
      const { set: update } = buildStructuredUpdate(
        makeParsed({ type: "PLA" }),
        { parentId: "missing", parent: null },
      );
      expect(update.type).toBe("PLA");
    });
  });

  describe("stale variant override clearance (Codex P1 on PR #473)", () => {
    // The original variant-aware branch checked "parent has same value
    // → don't pin". But that left a window: if the variant already
    // carried a STALE local override (variant=1.30, parent=1.24,
    // imported=1.24), we'd skip writing — the variant's stale 1.30
    // would stick around forever because subsequent imports matching
    // the parent would also no-op. Emit `$unset` for those fields so
    // the variant returns to inheriting from the parent.

    it("emits $unset for a variant field whose parsed value matches the parent and whose variant override diverges", () => {
      const parent = { density: 1.24, cost: 25 };
      const existing = {
        parentId: "parent-id",
        parent,
        // Stale local overrides — different from parent.
        density: 1.30,
        cost: 30,
      };
      const { set: update, unset } = buildStructuredUpdate(
        makeParsed({ density: 1.24, cost: 25 }),
        existing,
      );
      // No $set for these fields — they shouldn't be pinned…
      expect("density" in update).toBe(false);
      expect("cost" in update).toBe(false);
      // …but they DO need to be unset so inheritance resumes.
      expect(unset.sort()).toEqual(["cost", "density"]);
    });

    it("does NOT emit $unset when the variant already lacks a local value (no stale override)", () => {
      const parent = { density: 1.24 };
      // Variant has no local density — already inheriting.
      const existing = { parentId: "parent-id", parent };
      const { unset } = buildStructuredUpdate(
        makeParsed({ density: 1.24 }),
        existing,
      );
      expect(unset).toEqual([]);
    });

    it("does NOT emit $unset when the variant's local value already matches the parent", () => {
      // Variant has the same local value as the parent. No new pin
      // needed AND no unset needed — the doc is already consistent.
      const parent = { density: 1.24 };
      const existing = { parentId: "parent-id", parent, density: 1.24 };
      const { set: update, unset } = buildStructuredUpdate(
        makeParsed({ density: 1.24 }),
        existing,
      );
      expect("density" in update).toBe(false);
      expect(unset).toEqual([]);
    });

    it("emits $set when the parsed value differs from the parent — no $unset entry for the same field", () => {
      const parent = { density: 1.24 };
      const existing = { parentId: "parent-id", parent, density: 1.30 };
      const { set: update, unset } = buildStructuredUpdate(
        makeParsed({ density: 1.40 }),
        existing,
      );
      expect(update.density).toBe(1.40);
      expect(unset).not.toContain("density");
    });

    it("does NOT emit $unset on root filaments — no parent to inherit from", () => {
      // A root filament cannot 'inherit' a field — there's no parent
      // doc. A no-op import value should never produce $unset on it.
      const existing = { parentId: null, parent: null, density: 1.24 };
      const { set: update, unset } = buildStructuredUpdate(
        makeParsed({ density: 1.24 }),
        existing,
      );
      // Root with same value: still gets $set (parent-aware skip
      // requires both parentId AND parent doc).
      expect(update.density).toBe(1.24);
      expect(unset).toEqual([]);
    });

    it("treats empty-string variant overrides as 'no local value' (mirrors resolveFilament)", () => {
      // resolveFilament treats "" the same as null/missing — variant
      // is considered to be inheriting. So an empty-string override
      // doesn't need clearing.
      const parent = { vendor: "Polymaker" };
      const existing = {
        parentId: "parent-id",
        parent,
        // Empty-string vendor — resolveFilament treats this as "no local
        // value" (variant is considered to be inheriting), so we should
        // NOT emit $unset for it.
        vendor: "",
      };
      const { unset } = buildStructuredUpdate(
        makeParsed({ vendor: "Polymaker" }),
        existing,
      );
      expect(unset).toEqual([]);
    });

    it("does NOT emit $unset for REQUIRED schema fields (type, vendor) even with a stale variant override (Codex P2 PR #473 r3)", () => {
      // The Filament schema declares `vendor` and `type` as required.
      // The Bambu routes apply `$unset` with `runValidators: true`, so
      // routing required fields into the unset list would fail schema
      // validation. The variant's override is left in place — it's
      // still a non-null value, just one that happens to equal the
      // parent's, so no inheritance-resume benefit is lost (the
      // variant doc already resolves to the same value).
      const parent = { type: "PLA", vendor: "Polymaker", density: 1.24 };
      const existing = {
        parentId: "parent-id",
        parent,
        // Stale local values that diverge from parent for both required
        // and optional fields.
        type: "PLA+",
        vendor: "OldVendor",
        density: 1.30,
      };
      const { set: update, unset } = buildStructuredUpdate(
        makeParsed({ type: "PLA", vendor: "Polymaker", density: 1.24 }),
        existing,
      );
      // None of the three get $set (parent already carries them)…
      expect("type" in update).toBe(false);
      expect("vendor" in update).toBe(false);
      expect("density" in update).toBe(false);
      // …but only `density` (optional) gets $unset. `type` and `vendor`
      // stay pinned because $unset would trip the required validator.
      expect(unset).toEqual(["density"]);
    });
  });
});
