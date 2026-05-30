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
      const update = buildStructuredUpdate(
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
    });

    it("skips fields that are not set on the parsed input (keeps update tiny)", () => {
      const update = buildStructuredUpdate(makeParsed({ type: "PLA" }), null);
      expect(Object.keys(update)).toEqual(["type"]);
    });

    it("treats numeric 0 as a real value, not as missing", () => {
      const update = buildStructuredUpdate(
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
      const update = buildStructuredUpdate(
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
      const update = buildStructuredUpdate(makeParsed(), null);
      expect("temperatures" in update).toBe(false);
    });

    it("skips parsed temperature keys whose value is null", () => {
      const update = buildStructuredUpdate(
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
      const update = buildStructuredUpdate(
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
      const update = buildStructuredUpdate(
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
      const update = buildStructuredUpdate(makeParsed(), null);
      expect("bedTypeTemps" in update).toBe(false);
    });
  });

  describe("create branch (existing === null)", () => {
    it("emits temperatures from the parsed bag with no merge anchor", () => {
      const update = buildStructuredUpdate(
        makeParsed({ temperatures: { nozzle: 215 } }),
        null,
      );
      expect(update.temperatures).toEqual({ nozzle: 215 });
    });

    it("emits bedTypeTemps from the parsed array directly when existing is null", () => {
      const update = buildStructuredUpdate(
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
});
