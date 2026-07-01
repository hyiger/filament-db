import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  buildStructuredUpdate,
  resolveAndApplyCalibration,
  type ExistingFilamentForApply,
} from "@/lib/bambuStudioApply";
import type {
  CalibrationHints,
  ParsedFilament,
} from "@/lib/bambuStudioImport";

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

    it("suppresses writing the exported echo color back onto a null coextruded primary (GH #883)", () => {
      // A coextruded filament stores color:null + secondaryColors; the
      // export echoes secondaryColors[0] as the single color. On sync-back
      // resolveSyncBackColor returns undefined for that echo, so color is
      // NOT written — the null primary is preserved (line 269 false branch).
      const existing: ExistingFilamentForApply = {
        color: null,
        secondaryColors: ["#112233", "#445566"],
      };
      const { set: update } = buildStructuredUpdate(
        makeParsed({ color: "#112233" }),
        existing,
      );
      expect("color" in update).toBe(false);
    });

    it("writes a genuinely-edited color even when the stored filament is coextruded", () => {
      // Incoming hex differs from secondaryColors[0], so it's a real edit
      // and resolveSyncBackColor returns it — color IS written (line 269 true).
      const existing: ExistingFilamentForApply = {
        color: null,
        secondaryColors: ["#112233"],
      };
      const { set: update } = buildStructuredUpdate(
        makeParsed({ color: "#ABCDEF" }),
        existing,
      );
      expect(update.color).toBe("#ABCDEF");
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

/**
 * DB-backed tests for `resolveAndApplyCalibration` (and, through it,
 * the private `matchPrinterNozzle`). These reach the calibration-row
 * field mapping, the existing-row merge vs append branches, and the
 * printer/nozzle match heuristics — all of which need Printer / Nozzle
 * docs, so they run against mongodb-memory-server (tests/setup.ts).
 *
 * The route tests in tests/bambustudio-route.test.ts exercise the happy
 * paths end-to-end, but never in isolation hit: the full hint→row field
 * copy, the merge-into-an-existing-calibration-row branch, or the
 * no-diameter / no-model-hint / non-finite-diameter guards in
 * matchPrinterNozzle.
 */
describe("resolveAndApplyCalibration (DB-backed)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Printer: any;
  let Nozzle: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const prtMod = await import("@/models/Printer");
    const nozMod = await import("@/models/Nozzle");
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    Printer = mongoose.models.Printer;
    Nozzle = mongoose.models.Nozzle;
  });

  function makeHints(over: Partial<CalibrationHints> = {}): CalibrationHints {
    return { hasAnyHint: true, ...over };
  }

  function makeParsedFil(over: Partial<ParsedFilament> = {}): ParsedFilament {
    return {
      name: "Cal Filament",
      temperatures: {},
      bedTypeTemps: [],
      settings: {},
      ...over,
    };
  }

  it("returns early (no match, no unresolved) when there are no hints", async () => {
    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ hasAnyHint: false }),
      update,
      null,
    );
    expect(outcome).toEqual({ applied: false, unresolved: false });
    expect("calibrations" in update).toBe(false);
  });

  it("copies every present hint + temperature onto the calibration row", async () => {
    const nozzle = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    const printer = await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle._id],
    });

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil({
        temperatures: {
          nozzle: 210,
          nozzleFirstLayer: 215,
          bed: 60,
          bedFirstLayer: 65,
        },
      }),
      makeHints({
        printerSettingsId: "Bambu Lab P1S 0.4 nozzle",
        extrusionMultiplier: 0.98,
        maxVolumetricSpeed: 15,
        pressureAdvance: 0.02,
        retractLength: 0.8,
        retractSpeed: 30,
        retractLift: 0.2,
        fanMinSpeed: 20,
        fanMaxSpeed: 100,
        fanBridgeSpeed: 80,
      }),
      update,
      null,
    );

    expect(outcome.applied).toBe(true);
    expect(outcome.unresolved).toBe(false);
    expect(outcome.context?.printerName).toBe("Bambu Lab P1S");
    expect(outcome.context?.nozzleDiameter).toBe(0.4);

    const rows = update.calibrations as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(String(row.printer)).toBe(String(printer._id));
    expect(String(row.nozzle)).toBe(String(nozzle._id));
    expect(row.extrusionMultiplier).toBe(0.98);
    expect(row.maxVolumetricSpeed).toBe(15);
    expect(row.pressureAdvance).toBe(0.02);
    expect(row.retractLength).toBe(0.8);
    expect(row.retractSpeed).toBe(30);
    expect(row.retractLift).toBe(0.2);
    expect(row.fanMinSpeed).toBe(20);
    expect(row.fanMaxSpeed).toBe(100);
    expect(row.fanBridgeSpeed).toBe(80);
    expect(row.nozzleTemp).toBe(210);
    expect(row.nozzleTempFirstLayer).toBe(215);
    expect(row.bedTemp).toBe(60);
    expect(row.bedTempFirstLayer).toBe(65);
  });

  it("MERGES into an existing calibration row for the same printer+nozzle (does not append)", async () => {
    const nozzle = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    const printer = await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle._id],
    });

    // Existing row for the same printer/nozzle carrying a value the new
    // import doesn't set — it must be preserved on merge (line 373 branch).
    const existing = {
      calibrations: [
        {
          printer: String(printer._id),
          nozzle: String(nozzle._id),
          pressureAdvance: 0.05,
          extrusionMultiplier: 0.9,
        },
      ],
    };

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({
        printerSettingsId: "Bambu Lab P1S 0.4 nozzle",
        extrusionMultiplier: 0.97, // overrides the existing 0.9
      }),
      update,
      existing,
    );

    expect(outcome.applied).toBe(true);
    const rows = update.calibrations as Array<Record<string, unknown>>;
    // Still ONE row (merged, not appended).
    expect(rows).toHaveLength(1);
    expect(rows[0].extrusionMultiplier).toBe(0.97); // overwritten
    expect(rows[0].pressureAdvance).toBe(0.05); // preserved from existing
  });

  it("APPENDS a new calibration row when no existing row matches the printer+nozzle", async () => {
    const nozzle = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    const printer = await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle._id],
    });

    // Existing row for a DIFFERENT printer/nozzle — must be kept, and a
    // new row appended (line 375 else branch, complementing 373).
    const existing = {
      calibrations: [
        {
          printer: new mongoose.Types.ObjectId().toString(),
          nozzle: new mongoose.Types.ObjectId().toString(),
          pressureAdvance: 0.05,
        },
      ],
    };

    const update: Record<string, unknown> = {};
    await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ printerSettingsId: "Bambu Lab P1S 0.4 nozzle", extrusionMultiplier: 0.97 }),
      update,
      existing,
    );

    const rows = update.calibrations as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(String(rows[1].printer)).toBe(String(printer._id));
    expect(String(rows[1].nozzle)).toBe(String(nozzle._id));
  });

  it("adopts a unique global-catalog nozzle when the matched printer has none at that diameter", async () => {
    // Printer installed with a 0.6 only; a single 0.4 exists in the global
    // catalog → the global-fallback branch adopts it.
    const big = await Nozzle.create({ name: "Brass 0.6", diameter: 0.6, type: "Brass" });
    const global04 = await Nozzle.create({ name: "Only 0.4", diameter: 0.4, type: "Brass" });
    const printer = await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [big._id],
    });

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ printerSettingsId: "Bambu Lab P1S 0.4 nozzle", extrusionMultiplier: 0.97 }),
      update,
      null,
    );

    expect(outcome.applied).toBe(true);
    expect(outcome.context?.nozzleId).toBe(String(global04._id));
    expect(outcome.context?.printerId).toBe(String(printer._id));
  });

  it("is unresolved when the printer has no matching nozzle AND the global catalog has multiple at that diameter (line 477 area)", async () => {
    const big = await Nozzle.create({ name: "Brass 0.6", diameter: 0.6, type: "Brass" });
    // Two global 0.4 nozzles → ambiguous global fallback → unresolved.
    await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    await Nozzle.create({ name: "Hardened 0.4", diameter: 0.4, type: "Hardened Steel" });
    await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [big._id],
    });

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ printerSettingsId: "Bambu Lab P1S 0.4 nozzle", extrusionMultiplier: 0.97 }),
      update,
      null,
    );

    expect(outcome).toEqual({ applied: false, unresolved: true });
    expect("calibrations" in update).toBe(false);
  });

  it("is unresolved when the printer has MULTIPLE installed nozzles at the target diameter (ambiguous, line 477)", async () => {
    const brass = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    const hard = await Nozzle.create({ name: "Hardened 0.4", diameter: 0.4, type: "Hardened Steel" });
    await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [brass._id, hard._id],
    });

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ printerSettingsId: "Bambu Lab P1S 0.4 nozzle" }),
      update,
      null,
    );

    expect(outcome).toEqual({ applied: false, unresolved: true });
  });

  it("is unresolved when the hint carries no trailing diameter (line 407)", async () => {
    const nozzle = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle._id],
    });

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ printerSettingsId: "Bambu Lab P1S nozzle" }),
      update,
      null,
    );
    // No number in the hint → diameterMatch fails → null → unresolved.
    expect(outcome).toEqual({ applied: false, unresolved: true });
  });

  it("is unresolved when there is no model-hint substring before the diameter (line 416)", async () => {
    const nozzle = await Nozzle.create({ name: "Bambu Lab P1S", diameter: 0.4, type: "Brass" });
    await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle._id],
    });

    const update: Record<string, unknown> = {};
    // Hint is just the diameter — modelHint slice is empty → null.
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ printerSettingsId: "0.4 nozzle" }),
      update,
      null,
    );
    expect(outcome).toEqual({ applied: false, unresolved: true });
  });

  it("is unresolved when neither printerSettingsId nor compatiblePrinters is present (line 402)", async () => {
    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      // hasAnyHint true (e.g. a bare flow ratio) but no printer reference.
      makeHints({ extrusionMultiplier: 0.98 }),
      update,
      null,
    );
    expect(outcome).toEqual({ applied: false, unresolved: true });
  });

  it("falls back to compatiblePrinters when printerSettingsId is absent (line 401)", async () => {
    const nozzle = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    const printer = await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle._id],
    });

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ compatiblePrinters: "Bambu Lab P1S 0.4 nozzle", extrusionMultiplier: 0.97 }),
      update,
      null,
    );
    expect(outcome.applied).toBe(true);
    expect(outcome.context?.printerId).toBe(String(printer._id));
  });

  it("matches a printer via manufacturer + printerModel when the free-text name doesn't contain the hint (line 433)", async () => {
    const nozzle = await Nozzle.create({ name: "Brass 0.4", diameter: 0.4, type: "Brass" });
    const printer = await Printer.create({
      name: "Garage machine", // free-text name has no model hint
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle._id],
    });

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ printerSettingsId: "Bambu Lab P1S 0.4 nozzle" }),
      update,
      null,
    );
    // Matched on `${manufacturer} ${printerModel}` = "Bambu Lab P1S".
    expect(outcome.applied).toBe(true);
    expect(outcome.context?.printerId).toBe(String(printer._id));
  });

  it("is unresolved when more than one printer matches the model hint (ambiguous, line 435)", async () => {
    const nozzle1 = await Nozzle.create({ name: "Brass 0.4 a", diameter: 0.4, type: "Brass" });
    const nozzle2 = await Nozzle.create({ name: "Brass 0.4 b", diameter: 0.4, type: "Brass" });
    await Printer.create({
      name: "Bambu Lab P1S",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle1._id],
    });
    await Printer.create({
      name: "Bambu Lab P1S (downstairs)",
      manufacturer: "Bambu Lab",
      printerModel: "P1S",
      installedNozzles: [nozzle2._id],
    });

    const update: Record<string, unknown> = {};
    const outcome = await resolveAndApplyCalibration(
      makeParsedFil(),
      makeHints({ printerSettingsId: "Bambu Lab P1S 0.4 nozzle" }),
      update,
      null,
    );
    expect(outcome).toEqual({ applied: false, unresolved: true });
  });
});
