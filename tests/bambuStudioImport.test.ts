import { describe, it, expect } from "vitest";
import { parseBambuStudioProfile } from "@/lib/bambuStudioImport";
import {
  generateOrcaSlicerProfiles,
} from "@/lib/orcaSlicerBundle";

/**
 * Pure-parser tests for the Bambu Studio importer. Lives separately
 * from the route-level tests so the parser can be exercised without
 * spinning up mongodb-memory-server.
 *
 * The most important guarantee here is the round-trip: a filament
 * exported through the OrcaSlicer generator (which the Bambu export
 * route reuses verbatim) must parse back into the same fields. If that
 * invariant breaks, the export → calibrate-in-Bambu → re-import flow
 * silently loses data.
 */
describe("parseBambuStudioProfile", () => {
  it("throws on a non-object payload", () => {
    expect(() => parseBambuStudioProfile(null)).toThrow(/JSON object/);
    expect(() => parseBambuStudioProfile([])).toThrow(/JSON object/);
    expect(() => parseBambuStudioProfile("string")).toThrow(/JSON object/);
  });

  it("throws when the profile has no identifier", () => {
    expect(() => parseBambuStudioProfile({ filament_type: ["PLA"] })).toThrow(
      /filament_settings_id/,
    );
  });

  it("picks the name from filament_settings_id, name, or filament_id (in that order)", () => {
    expect(
      parseBambuStudioProfile({
        filament_settings_id: ["MyPLA"],
        name: ["NotThis"],
      }).filament.name,
    ).toBe("MyPLA");
    expect(parseBambuStudioProfile({ name: ["JustName"] }).filament.name).toBe("JustName");
    expect(parseBambuStudioProfile({ filament_id: ["GFA00"] }).filament.name).toBe("GFA00");
  });

  it("unwraps single-element arrays and coerces numerics", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      filament_diameter: ["1.75"],
      filament_density: ["1.24"],
      filament_cost: ["28.5"],
      filament_max_volumetric_speed: ["12"],
      nozzle_temperature: ["210"],
      nozzle_temperature_initial_layer: ["215"],
      hot_plate_temp: ["60"],
      hot_plate_temp_initial_layer: ["65"],
    });
    expect(filament.diameter).toBe(1.75);
    expect(filament.density).toBe(1.24);
    expect(filament.cost).toBe(28.5);
    expect(filament.maxVolumetricSpeed).toBe(12);
    expect(filament.temperatures.nozzle).toBe(210);
    expect(filament.temperatures.nozzleFirstLayer).toBe(215);
    expect(filament.temperatures.bed).toBe(60);
    expect(filament.temperatures.bedFirstLayer).toBe(65);
  });

  it("maps Bambu plate-temp keys into bedTypeTemps[]", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      cool_plate_temp: ["35"],
      eng_plate_temp: ["80"],
      eng_plate_temp_initial_layer: ["85"],
      textured_plate_temp: ["70"],
    });
    // hot_plate is the default + lands in temperatures.bed, not here.
    // cool/eng/textured become bedTypeTemps entries.
    const byName = Object.fromEntries(filament.bedTypeTemps.map((b) => [b.bedType, b]));
    expect(byName["Cool Plate"]?.temperature).toBe(35);
    expect(byName["Engineering Plate"]?.temperature).toBe(80);
    expect(byName["Engineering Plate"]?.firstLayerTemperature).toBe(85);
    expect(byName["Textured PEI Plate"]?.temperature).toBe(70);
  });

  it("strips trailing % from filament_shrink", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      filament_shrink: ["0.5%"],
      filament_shrinkage_compensation_z: ["1.2"],
    });
    expect(filament.shrinkageXY).toBe(0.5);
    expect(filament.shrinkageZ).toBe(1.2);
  });

  it("passes filament_soluble through the settings bag (no model column yet, Codex P1 #387 r2)", () => {
    // The Filament model has no `soluble` field, so we let the value
    // ride in the passthrough settings bag instead of trying to store
    // it on a column that doesn't exist (Mongoose strict mode would
    // silently drop it). Round-trip is preserved.
    expect(parseBambuStudioProfile({ name: ["X"], filament_soluble: ["1"] }).filament.settings.filament_soluble).toBe("1");
    expect(parseBambuStudioProfile({ name: ["X"], filament_soluble: ["0"] }).filament.settings.filament_soluble).toBe("0");
    expect(parseBambuStudioProfile({ name: ["X"] }).filament.settings.filament_soluble).toBeUndefined();
  });

  it("passes filament_notes through the settings bag and round-trips it (GH #620)", () => {
    // The Filament model has no top-level `notes` column (the form stores
    // notes as `settings.filament_notes`), so the key must ride the
    // settings passthrough bag like `filament_soluble`. Pre-fix it was
    // listed in STRUCTURED_KEYS — excluded from the bag AND silently
    // stripped by Mongoose strict mode on the applier's `u.notes` write,
    // destroying the value entirely.
    const { filament } = parseBambuStudioProfile({
      name: ["Noted PLA"],
      filament_notes: ["Dried 6h @ 55C. Prints best with 0.2mm layers."],
    });
    expect(filament.settings.filament_notes).toBe(
      "Dried 6h @ 55C. Prints best with 0.2mm layers.",
    );

    // Round-trip: a doc carrying the settings-bag key re-exports the key
    // verbatim, and a second parse lands it back in the settings bag.
    const [exported] = generateOrcaSlicerProfiles([
      {
        name: "Noted PLA",
        type: "PLA",
        vendor: "QA Labs",
        settings: filament.settings,
      },
    ]);
    expect(exported.filament_notes).toEqual([
      "Dried 6h @ 55C. Prints best with 0.2mm layers.",
    ]);
    const reparsed = parseBambuStudioProfile(exported);
    expect(reparsed.filament.settings.filament_notes).toBe(
      "Dried 6h @ 55C. Prints best with 0.2mm layers.",
    );
  });

  it("extracts calibration hints when present and flags hasAnyHint", () => {
    const { calibrationHints } = parseBambuStudioProfile({
      name: ["X"],
      printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
      filament_flow_ratio: ["0.978"],
      pressure_advance: ["0.028"],
      filament_retract_length: ["0.8"],
      filament_max_volumetric_speed: ["15"],
    });
    expect(calibrationHints.hasAnyHint).toBe(true);
    expect(calibrationHints.printerSettingsId).toBe("Bambu Lab P1S 0.4 nozzle");
    expect(calibrationHints.extrusionMultiplier).toBe(0.978);
    expect(calibrationHints.pressureAdvance).toBe(0.028);
    expect(calibrationHints.retractLength).toBe(0.8);
    expect(calibrationHints.maxVolumetricSpeed).toBe(15);
  });

  it("hasAnyHint is false when no calibration values are present", () => {
    const { calibrationHints } = parseBambuStudioProfile({
      name: ["X"],
      printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"], // hint exists but no values
      nozzle_temperature: ["210"],
    });
    expect(calibrationHints.hasAnyHint).toBe(false);
  });

  it("hasAnyHint excludes filament_max_volumetric_speed alone (Codex P3 #387 r6)", () => {
    // maxVolumetricSpeed is the one calibration-relevant value that
    // ALSO writes to a top-level filament field, so when it's the only
    // hint and the printer doesn't resolve, NOTHING is lost — the
    // top-level update carries it. Previously hasAnyHint became true,
    // driving a misleading "calibration couldn't be tagged" warning
    // toast on otherwise-successful imports.
    const { calibrationHints } = parseBambuStudioProfile({
      name: ["X"],
      printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
      filament_max_volumetric_speed: ["15"],
    });
    expect(calibrationHints.maxVolumetricSpeed).toBe(15); // still extracted
    expect(calibrationHints.hasAnyHint).toBe(false); // but doesn't trigger unresolved
  });

  it("extracts overhang_fan_speed + additional_cooling_fan_speed as fan hints (Codex P1 #387 r3)", () => {
    // These match what the exporter (calibrationToOrcaSlicerKeys) emits
    // for `fanMinSpeed` and `fanMaxSpeed`. Round 2 wrongly passed them
    // through settings — round 3 hooks them up properly so the
    // export → import round-trip preserves the calibration row.
    const { calibrationHints, filament } = parseBambuStudioProfile({
      name: ["X"],
      overhang_fan_speed: ["60"],
      additional_cooling_fan_speed: ["80"],
    });
    expect(calibrationHints.fanMinSpeed).toBe(60);
    expect(calibrationHints.fanMaxSpeed).toBe(80);
    expect(calibrationHints.hasAnyHint).toBe(true);
    // Must NOT also leak into settings, else the round-trip would
    // double-emit the key.
    expect(filament.settings.overhang_fan_speed).toBeUndefined();
    expect(filament.settings.additional_cooling_fan_speed).toBeUndefined();
  });

  it("falls back to fan_min_speed / fan_max_speed when the canonical names aren't present", () => {
    const { calibrationHints } = parseBambuStudioProfile({
      name: ["X"],
      fan_min_speed: ["20"],
      fan_max_speed: ["100"],
    });
    expect(calibrationHints.fanMinSpeed).toBe(20);
    expect(calibrationHints.fanMaxSpeed).toBe(100);
  });

  it("round-trips calibration values via calibrationToOrcaSlicerKeys (Codex P1 #387 r3)", async () => {
    // The bug Codex flagged would have been caught immediately by a
    // test that runs a representative calibration through the export
    // generator and then the import parser. Lock it in: every field
    // the exporter emits MUST land in calibrationHints after the
    // re-parse, so the export → calibrate-in-Bambu → re-import flow
    // can't silently drop calibration data again.
    const { calibrationToOrcaSlicerKeys } = await import("@/lib/orcaSlicerBundle");
    const original = {
      extrusionMultiplier: 0.965,
      maxVolumetricSpeed: 12,
      pressureAdvance: 0.028,
      retractLength: 0.8,
      retractSpeed: 35,
      retractLift: 0.2,
      nozzleTemp: 215,
      nozzleTempFirstLayer: 220,
      bedTemp: 60,
      bedTempFirstLayer: 65,
      fanMinSpeed: 50,
      fanMaxSpeed: 100,
      // GH #508: fanBridgeSpeed must round-trip too. Pre-fix
      // calibrationToOrcaSlicerKeys never emitted bridge_fan_speed even
      // though the importer side declared it in CALIBRATION_KEYS, so
      // every export → calibrate → re-import cycle silently dropped it.
      fanBridgeSpeed: 70,
    };
    const exported = calibrationToOrcaSlicerKeys(original);
    // Stamp a minimum identifier so the parser accepts the payload.
    const profile = { name: ["X"], ...exported };
    const { calibrationHints } = parseBambuStudioProfile(profile);
    expect(calibrationHints.extrusionMultiplier).toBe(original.extrusionMultiplier);
    expect(calibrationHints.maxVolumetricSpeed).toBe(original.maxVolumetricSpeed);
    expect(calibrationHints.pressureAdvance).toBe(original.pressureAdvance);
    expect(calibrationHints.retractLength).toBe(original.retractLength);
    expect(calibrationHints.retractSpeed).toBe(original.retractSpeed);
    expect(calibrationHints.retractLift).toBe(original.retractLift);
    expect(calibrationHints.fanMinSpeed).toBe(original.fanMinSpeed);
    expect(calibrationHints.fanMaxSpeed).toBe(original.fanMaxSpeed);
    expect(calibrationHints.fanBridgeSpeed).toBe(original.fanBridgeSpeed);
  });

  it("stashes unknown keys in the settings passthrough bag", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      filament_type: ["PLA"], // structured → NOT in settings
      filament_flow_ratio: ["0.99"], // calibration → NOT in settings
      slow_down_for_layer_cooling: ["1"], // unknown → settings
      custom_bambu_key: ["custom-value"],
    });
    expect(filament.settings.slow_down_for_layer_cooling).toBe("1");
    expect(filament.settings.custom_bambu_key).toBe("custom-value");
    // structured + calibration keys must NOT leak into settings (avoids
    // double-write on round-trip).
    expect(filament.settings.filament_type).toBeUndefined();
    expect(filament.settings.filament_flow_ratio).toBeUndefined();
  });

  it("treats empty arrays / empty strings as undefined", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      filament_cost: [],
      filament_density: [""],
      filament_vendor: [""],
    });
    expect(filament.cost).toBeUndefined();
    expect(filament.density).toBeUndefined();
    expect(filament.vendor).toBeUndefined();
  });

  it("round-trips an OrcaSlicer-format export through the parser", () => {
    // Build a representative filament doc; pass it through the export
    // generator (which the Bambu export route also uses); parse it back.
    // The Bambu route additionally sets `from: "User"`, but the parser
    // is agnostic to that since `from` is in STRUCTURED_KEYS (skipped).
    const doc = {
      name: "Round Trip PLA",
      type: "PLA",
      vendor: "QA Labs",
      color: "#33cc55",
      diameter: 1.75,
      density: 1.24,
      cost: 24.99,
      maxVolumetricSpeed: 12,
      temperatures: {
        nozzle: 210,
        nozzleFirstLayer: 215,
        bed: 60,
        bedFirstLayer: 65,
      },
      bedTypeTemps: [{ bedType: "Cool Plate", temperature: 35 }],
    };
    const [exported] = generateOrcaSlicerProfiles([doc]);
    const { filament } = parseBambuStudioProfile(exported);
    expect(filament.name).toBe("Round Trip PLA");
    expect(filament.type).toBe("PLA");
    expect(filament.vendor).toBe("QA Labs");
    expect(filament.color).toBe("#33cc55");
    expect(filament.diameter).toBe(1.75);
    expect(filament.density).toBe(1.24);
    expect(filament.cost).toBe(24.99);
    expect(filament.maxVolumetricSpeed).toBe(12);
    expect(filament.temperatures.nozzle).toBe(210);
    expect(filament.temperatures.bed).toBe(60);
    expect(filament.bedTypeTemps.find((b) => b.bedType === "Cool Plate")?.temperature).toBe(35);
  });
});
