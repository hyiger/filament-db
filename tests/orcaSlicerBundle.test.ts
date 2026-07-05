import { describe, it, expect } from "vitest";
import {
  filamentToOrcaSlicerKeys,
  calibrationToOrcaSlicerKeys,
  generateOrcaSlicerProfiles,
  pickRepresentativeCalibration,
  droppedCalibrationCount,
} from "@/lib/orcaSlicerBundle";

describe("filamentToOrcaSlicerKeys", () => {
  it("maps core structured fields to OrcaSlicer keys as arrays", () => {
    const filament = {
      name: "Generic PLA",
      vendor: "Generic",
      type: "PLA",
      color: "#DDDDDD",
      diameter: 1.75,
      density: 1.24,
      cost: 20,
      maxVolumetricSpeed: 15,
      temperatures: {
        nozzle: 210,
        nozzleFirstLayer: 215,
        bed: 60,
        bedFirstLayer: 65,
        nozzleRangeMin: 190,
        nozzleRangeMax: 230,
      },
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    expect(keys.filament_type).toEqual(["PLA"]);
    expect(keys.filament_vendor).toEqual(["Generic"]);
    expect(keys.filament_colour).toEqual(["#DDDDDD"]);
    expect(keys.filament_diameter).toEqual(["1.75"]);
    expect(keys.filament_density).toEqual(["1.24"]);
    expect(keys.filament_cost).toEqual(["20"]);
    expect(keys.filament_max_volumetric_speed).toEqual(["15"]);
    expect(keys.nozzle_temperature).toEqual(["210"]);
    expect(keys.nozzle_temperature_initial_layer).toEqual(["215"]);
    expect(keys.nozzle_temperature_range_low).toEqual(["190"]);
    expect(keys.nozzle_temperature_range_high).toEqual(["230"]);
    expect(keys.hot_plate_temp).toEqual(["60"]);
    expect(keys.hot_plate_temp_initial_layer).toEqual(["65"]);
    expect(keys.filament_settings_id).toEqual(["Generic PLA"]);
  });

  it("maps bed-type-specific temperatures to plate keys", () => {
    const filament = {
      name: "PETG",
      vendor: "Generic",
      type: "PETG",
      color: "#FF0000",
      diameter: 1.75,
      temperatures: { nozzle: 240, bed: 80 },
      bedTypeTemps: [
        { bedType: "Cool Plate", temperature: 50, firstLayerTemperature: 55 },
        { bedType: "Engineering Plate", temperature: 90, firstLayerTemperature: 95 },
        { bedType: "Hot Plate", temperature: 80, firstLayerTemperature: 85 },
        { bedType: "Textured PEI Plate", temperature: 75, firstLayerTemperature: 80 },
        { bedType: "Textured Cool Plate", temperature: 45, firstLayerTemperature: 50 },
      ],
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    expect(keys.cool_plate_temp).toEqual(["50"]);
    expect(keys.cool_plate_temp_initial_layer).toEqual(["55"]);
    expect(keys.eng_plate_temp).toEqual(["90"]);
    expect(keys.eng_plate_temp_initial_layer).toEqual(["95"]);
    expect(keys.hot_plate_temp).toEqual(["80"]);
    expect(keys.hot_plate_temp_initial_layer).toEqual(["85"]);
    expect(keys.textured_plate_temp).toEqual(["75"]);
    expect(keys.textured_plate_temp_initial_layer).toEqual(["80"]);
    expect(keys.textured_cool_plate_temp).toEqual(["45"]);
    expect(keys.textured_cool_plate_temp_initial_layer).toEqual(["50"]);
  });

  it("multi-color filament exports only the primary; secondaries are dropped", () => {
    const filament = {
      name: "Multi Solid",
      vendor: "Test",
      type: "PLA",
      color: "#FF0000",
      secondaryColors: ["#00FF00", "#0000FF"],
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    expect(keys.filament_colour).toEqual(["#FF0000"]);
    // No secondary-color values are ever emitted — OrcaSlicer presets
    // are single-color and the detail page warns the user about this.
    expect(JSON.stringify(keys)).not.toContain("#00FF00");
    expect(JSON.stringify(keys)).not.toContain("#0000FF");
  });

  it("coextruded filament (null primary) falls back to the first secondary", () => {
    const filament = {
      name: "Coextruded",
      vendor: "Test",
      type: "PLA",
      color: null,
      secondaryColors: ["#3366CC", "#CC3366"],
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    expect(keys.filament_colour).toEqual(["#3366CC"]);
    expect(JSON.stringify(keys)).not.toContain("#CC3366");
  });

  it("coextruded filament with NO secondaries omits filament_colour entirely", () => {
    // Reachable state: user picked "coextruded" in the form (clears
    // primary to null) and saved before adding any secondary slots.
    // We must NOT fall back to displayColor()'s gray sentinel — that
    // would force a #808080 the user never picked. (Codex P2 on PR #485.)
    const filament = {
      name: "Coextruded Empty",
      vendor: "Test",
      type: "PLA",
      color: null,
      secondaryColors: [],
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    expect(keys).not.toHaveProperty("filament_colour");
    expect(JSON.stringify(keys)).not.toContain("#808080");
  });

  it("preserves settings bag keys as arrays", () => {
    const filament = {
      name: "Test",
      vendor: "Test",
      type: "PLA",
      color: "#000000",
      diameter: 1.75,
      temperatures: {},
      settings: {
        overhang_fan_speed: "80",
        additional_cooling_fan_speed: "70",
        filament_start_gcode: "; start",
      },
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    expect(keys.overhang_fan_speed).toEqual(["80"]);
    expect(keys.additional_cooling_fan_speed).toEqual(["70"]);
    expect(keys.filament_start_gcode).toEqual(["; start"]);
  });

  it("structured DB fields override settings bag on conflict", () => {
    const filament = {
      name: "Override Test",
      vendor: "RealVendor",
      type: "PETG",
      color: "#FF0000",
      diameter: 1.75,
      density: 1.27,
      maxVolumetricSpeed: 12,
      temperatures: { nozzle: 240 },
      settings: {
        filament_type: "PLA",
        filament_vendor: "WrongVendor",
        nozzle_temperature: "200",
        overhang_fan_speed: "90",
      },
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    // Structured fields win
    expect(keys.filament_type).toEqual(["PETG"]);
    expect(keys.filament_vendor).toEqual(["RealVendor"]);
    expect(keys.nozzle_temperature).toEqual(["240"]);

    // Non-conflicting settings preserved
    expect(keys.overhang_fan_speed).toEqual(["90"]);
  });

  it("omits missing temperatures when not in settings", () => {
    const filament = {
      name: "Minimal",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    expect(keys.nozzle_temperature).toBeUndefined();
    expect(keys.nozzle_temperature_initial_layer).toBeUndefined();
    expect(keys.hot_plate_temp).toBeUndefined();
    expect(keys.hot_plate_temp_initial_layer).toBeUndefined();
    expect(keys.nozzle_temperature_range_low).toBeUndefined();
    expect(keys.nozzle_temperature_range_high).toBeUndefined();
  });

  it("omits null values from bed type temps", () => {
    const filament = {
      name: "Partial Bed",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      bedTypeTemps: [
        { bedType: "Cool Plate", temperature: 50, firstLayerTemperature: null },
      ],
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    expect(keys.cool_plate_temp).toEqual(["50"]);
    expect(keys.cool_plate_temp_initial_layer).toBeUndefined();
  });

  it("ignores unknown bed type names", () => {
    const filament = {
      name: "Unknown Bed",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      bedTypeTemps: [
        { bedType: "Custom Weird Plate", temperature: 70, firstLayerTemperature: 75 },
      ],
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);

    // Unknown bed type should not produce any keys
    expect(Object.keys(keys).filter(k => k.includes("plate_temp"))).toHaveLength(0);
  });

  it("GH #950: round-trips filament_soluble through the settings bag", () => {
    // No schema field — the old top-level `soluble` boolean was never persisted,
    // so the exporter's `set(..., filament.soluble)` was a no-op. It now rides the
    // settings passthrough bag verbatim.
    const filament = {
      name: "PVA",
      vendor: "Test",
      type: "PVA",
      color: "#FFFFFF",
      diameter: 1.75,
      temperatures: {},
      settings: { filament_soluble: "1" },
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_soluble).toEqual(["1"]);
  });

  it("GH #950: passes filament_soluble '0' through the settings bag", () => {
    const filament = {
      name: "Not Soluble",
      vendor: "Test",
      type: "PLA",
      color: "#FFFFFF",
      diameter: 1.75,
      temperatures: {},
      settings: { filament_soluble: "0" },
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_soluble).toEqual(["0"]);
  });

  it("GH #950: does NOT read a (dead) top-level soluble field — settings bag is authoritative", () => {
    // Regression guard: no schema column, so the old
    // `set("filament_soluble", filament.soluble ? "1" : "0")` reader was dead.
    // If restored, a top-level flag would clobber the settings-bag value.
    const filament = {
      name: "Conflict",
      vendor: "Test",
      type: "PVA",
      color: "#FFFFFF",
      diameter: 1.75,
      temperatures: {},
      soluble: true, // dead field — must be ignored
      settings: { filament_soluble: "0" },
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_soluble).toEqual(["0"]); // settings wins; top-level ignored
  });

  it("emits filament_notes from the notes field", () => {
    const filament = {
      name: "Noted",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      notes: "Dry at 45C for 6h",
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_notes).toEqual(["Dry at 45C for 6h"]);
  });

  it("preserves filament_notes from settings bag over the notes field", () => {
    const filament = {
      name: "Note Conflict",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      notes: "structured note",
      temperatures: {},
      settings: {
        filament_notes: "settings-bag note",
      },
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    // The `!keys.filament_notes` guard means the settings-bag value wins.
    expect(keys.filament_notes).toEqual(["settings-bag note"]);
  });

  it("maps shrinkage XY (percent-suffixed) and Z", () => {
    const filament = {
      name: "Shrinker",
      vendor: "Test",
      type: "ABS",
      color: "#808080",
      diameter: 1.75,
      shrinkageXY: 0.4,
      shrinkageZ: 0.2,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    // shrinkageXY is emitted with a trailing "%"
    expect(keys.filament_shrink).toEqual(["0.4%"]);
    expect(keys.filament_shrinkage_compensation_z).toEqual(["0.2"]);
  });

  it("emits shrinkage keys even when the value is 0 (only null skips)", () => {
    const filament = {
      name: "Zero Shrink",
      vendor: "Test",
      type: "ABS",
      color: "#808080",
      diameter: 1.75,
      shrinkageXY: 0,
      shrinkageZ: 0,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    // The guard is `!= null`, so 0 still emits (via set()'s own `!= null` check).
    expect(keys.filament_shrink).toEqual(["0%"]);
    expect(keys.filament_shrinkage_compensation_z).toEqual(["0"]);
  });

  it("skips a null value in the settings bag", () => {
    const filament = {
      name: "Null Setting",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      settings: {
        filament_start_gcode: null,
        overhang_fan_speed: "80",
      },
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    // The null settings value is dropped entirely; the non-null one survives.
    expect(keys).not.toHaveProperty("filament_start_gcode");
    expect(keys.overhang_fan_speed).toEqual(["80"]);
  });

  it("coextruded filament whose first secondary is empty omits filament_colour", () => {
    const filament = {
      name: "Empty First Secondary",
      vendor: "Test",
      type: "PLA",
      color: null,
      // first slot is an empty string — slicerExportColor must skip it and
      // fall through to null rather than emitting an empty colour
      secondaryColors: ["", "#AABBCC"],
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys).not.toHaveProperty("filament_colour");
  });

  it("handles settings bag with array values", () => {
    const filament = {
      name: "Array Settings",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      settings: {
        filament_retraction_length: ["0.8"],
        filament_z_hop: ["0.2"],
      },
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_retraction_length).toEqual(["0.8"]);
    expect(keys.filament_z_hop).toEqual(["0.2"]);
  });

  it("generates filament_settings_id from name if not in settings", () => {
    const filament = {
      name: "My Custom PLA",
      vendor: "Custom",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_settings_id).toEqual(["My Custom PLA"]);
  });

  it("preserves filament_settings_id from settings if present", () => {
    const filament = {
      name: "Display Name",
      vendor: "Vendor",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      settings: {
        filament_settings_id: "Original Slicer ID",
      },
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_settings_id).toEqual(["Original Slicer ID"]);
  });
});

describe("calibrationToOrcaSlicerKeys", () => {
  it("maps calibration fields to OrcaSlicer keys as arrays", () => {
    const calibration = {
      extrusionMultiplier: 0.95,
      pressureAdvance: 0.045,
      maxVolumetricSpeed: 15,
      retractLength: 0.6,
      retractSpeed: 45,
      retractLift: 0.2,
      nozzleTemp: 210,
      nozzleTempFirstLayer: 215,
      bedTemp: 60,
      bedTempFirstLayer: 65,
      fanMinSpeed: 80,
      fanMaxSpeed: 100,
    };

    const keys = calibrationToOrcaSlicerKeys(calibration);

    expect(keys.filament_flow_ratio).toEqual(["0.95"]);
    expect(keys.pressure_advance).toEqual(["0.045"]);
    expect(keys.filament_max_volumetric_speed).toEqual(["15"]);
    expect(keys.filament_retraction_length).toEqual(["0.6"]);
    expect(keys.filament_retraction_speed).toEqual(["45"]);
    expect(keys.filament_z_hop).toEqual(["0.2"]);
    expect(keys.nozzle_temperature).toEqual(["210"]);
    expect(keys.nozzle_temperature_initial_layer).toEqual(["215"]);
    expect(keys.hot_plate_temp).toEqual(["60"]);
    expect(keys.hot_plate_temp_initial_layer).toEqual(["65"]);
    expect(keys.overhang_fan_speed).toEqual(["80"]);
    expect(keys.additional_cooling_fan_speed).toEqual(["100"]);
  });

  it("omits null calibration fields", () => {
    const calibration = {
      extrusionMultiplier: 0.95,
      pressureAdvance: null,
      maxVolumetricSpeed: null,
      retractLength: null,
      retractSpeed: null,
      retractLift: null,
      nozzleTemp: null,
      bedTemp: null,
      chamberTemp: null,
      fanMinSpeed: null,
      fanMaxSpeed: null,
    };

    const keys = calibrationToOrcaSlicerKeys(calibration);

    expect(keys.filament_flow_ratio).toEqual(["0.95"]);
    expect(keys.pressure_advance).toBeUndefined();
    expect(keys.filament_max_volumetric_speed).toBeUndefined();
    expect(keys.nozzle_temperature).toBeUndefined();
    expect(keys.hot_plate_temp).toBeUndefined();
    expect(keys.chamber_temperature).toBeUndefined();
  });

  it("handles chamber temp with activation flag", () => {
    const calibration = {
      chamberTemp: 45,
    };

    const keys = calibrationToOrcaSlicerKeys(calibration);
    expect(keys.chamber_temperature).toEqual(["45"]);
  });

  it("handles empty calibration object", () => {
    const keys = calibrationToOrcaSlicerKeys({});
    expect(Object.keys(keys)).toHaveLength(0);
  });
});

describe("generateOrcaSlicerProfiles", () => {
  it("generates array of OrcaSlicer profile objects with metadata", () => {
    const filaments = [
      {
        _id: "abc123def456789012345678",
        name: "Generic PLA",
        vendor: "Generic",
        type: "PLA",
        color: "#DDDDDD",
        diameter: 1.75,
        density: 1.24,
        temperatures: { nozzle: 210, bed: 60 },
        settings: {},
      },
    ];

    const profiles = generateOrcaSlicerProfiles(filaments);

    expect(profiles).toHaveLength(1);
    const profile = profiles[0];

    // Metadata (plain strings)
    expect(profile.name).toBe("Generic PLA");
    expect(profile.type).toBe("filament");
    expect(profile.filament_id).toBe("fdb_abc123def456789012345678");
    expect(profile.from).toBe("filament_db");
    expect(profile.instantiation).toBe("true");

    // Slicer settings (arrays)
    expect(profile.filament_type).toEqual(["PLA"]);
    expect(profile.nozzle_temperature).toEqual(["210"]);
    expect(profile.hot_plate_temp).toEqual(["60"]);
  });

  it("handles empty filaments array", () => {
    const profiles = generateOrcaSlicerProfiles([]);
    expect(profiles).toEqual([]);
  });

  it("generates multiple profiles", () => {
    const filaments = [
      {
        _id: "id1",
        name: "PLA",
        vendor: "A",
        type: "PLA",
        color: "#FF0000",
        diameter: 1.75,
        temperatures: {},
        settings: {},
      },
      {
        _id: "id2",
        name: "PETG",
        vendor: "B",
        type: "PETG",
        color: "#00FF00",
        diameter: 1.75,
        temperatures: {},
        settings: {},
      },
    ];

    const profiles = generateOrcaSlicerProfiles(filaments);

    expect(profiles).toHaveLength(2);
    expect(profiles[0].name).toBe("PLA");
    expect(profiles[1].name).toBe("PETG");
  });

  it("falls back to an empty name string when the filament has no name", () => {
    const filaments = [
      {
        _id: "id-noname",
        // no `name` — the `filament.name || ""` fallback should kick in
        vendor: "Anon",
        type: "PLA",
        color: "#808080",
        diameter: 1.75,
        temperatures: {},
        settings: {},
      },
    ];

    const profiles = generateOrcaSlicerProfiles(filaments);
    expect(profiles[0].name).toBe("");
  });

  it("falls back to empty filament_id suffix when _id is missing", () => {
    const filaments = [
      {
        // no `_id` — the `filament._id?.toString() || ""` fallback yields "fdb_"
        name: "No Id",
        vendor: "Anon",
        type: "PLA",
        color: "#808080",
        diameter: 1.75,
        temperatures: {},
        settings: {},
      },
    ];

    const profiles = generateOrcaSlicerProfiles(filaments);
    expect(profiles[0].filament_id).toBe("fdb_");
  });

  it("includes bed-type-specific temps in profiles", () => {
    const filaments = [
      {
        _id: "id1",
        name: "ABS",
        vendor: "Generic",
        type: "ABS",
        color: "#000000",
        diameter: 1.75,
        temperatures: { nozzle: 255, bed: 100 },
        bedTypeTemps: [
          { bedType: "Cool Plate", temperature: 0, firstLayerTemperature: 0 },
          { bedType: "Hot Plate", temperature: 100, firstLayerTemperature: 110 },
        ],
        settings: {},
      },
    ];

    const profiles = generateOrcaSlicerProfiles(filaments);
    const profile = profiles[0];

    expect(profile.cool_plate_temp).toEqual(["0"]);
    expect(profile.hot_plate_temp).toEqual(["100"]);
    expect(profile.hot_plate_temp_initial_layer).toEqual(["110"]);
  });
});

describe("GH #950.4 — bake calibration into the Orca/Bambu export", () => {
  it("filamentToOrcaSlicerKeys bakes a supplied calibration (flow / PA / retraction / fans) over the base keys", () => {
    const filament = { name: "PLA", vendor: "X", type: "PLA", diameter: 1.75, temperatures: {}, settings: {} };
    const keys = filamentToOrcaSlicerKeys(filament, {
      extrusionMultiplier: 0.978,
      pressureAdvance: 0.028,
      retractLength: 0.8,
      fanMinSpeed: 60,
      fanMaxSpeed: 100,
    });
    expect(keys.filament_flow_ratio).toEqual(["0.978"]);
    expect(keys.pressure_advance).toEqual(["0.028"]); // baked for Bambu (no dynamic fallback)
    expect(keys.filament_retraction_length).toEqual(["0.8"]);
    expect(keys.overhang_fan_speed).toEqual(["60"]);
    expect(keys.additional_cooling_fan_speed).toEqual(["100"]);
  });

  it("calibration values WIN over structured/settings defaults", () => {
    const filament = {
      name: "PLA", vendor: "X", type: "PLA", diameter: 1.75, maxVolumetricSpeed: 12,
      temperatures: { nozzle: 210 }, settings: {},
    };
    const keys = filamentToOrcaSlicerKeys(filament, { maxVolumetricSpeed: 20, nozzleTemp: 225 });
    expect(keys.filament_max_volumetric_speed).toEqual(["20"]); // calibration, not the 12 default
    expect(keys.nozzle_temperature).toEqual(["225"]);
  });

  it("no calibration → base keys unchanged (backward compatible)", () => {
    const filament = { name: "PLA", vendor: "X", type: "PLA", diameter: 1.75, temperatures: {}, settings: {} };
    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_flow_ratio).toBeUndefined();
    expect(keys.pressure_advance).toBeUndefined();
  });

  it("generateOrcaSlicerProfiles bakes the representative calibration ONLY when opted in (GH #969 r5)", () => {
    const filaments = [{
      name: "PLA", vendor: "X", type: "PLA", diameter: 1.75, temperatures: {}, settings: {},
      calibrations: [
        { nozzle: { diameter: 0.4, type: "Brass" }, printer: { name: "MK4" }, extrusionMultiplier: 0.9 },
        { nozzle: { diameter: 0.4, type: "Brass" }, printer: null, bedType: null, extrusionMultiplier: 0.978 }, // default
      ],
    }];
    // Bulk bundle (default): must NOT bake — the OrcaSlicer module fetches
    // /calibration dynamically for the active nozzle/bed, so a baked static
    // representative would seed wrong-context tuning.
    const bulk = generateOrcaSlicerProfiles(filaments)[0];
    expect(bulk.filament_flow_ratio).toBeUndefined();
    // Single-preset download (opt-in): bakes the any-printer/any-bed default.
    const single = generateOrcaSlicerProfiles(filaments, { bakeCalibration: true })[0];
    expect(single.filament_flow_ratio).toEqual(["0.978"]);
  });

  it("pickRepresentativeCalibration prefers the any-printer/any-bed default, else the first", () => {
    expect(pickRepresentativeCalibration({ calibrations: [] })).toBeNull();
    const withDefault = {
      calibrations: [
        { printer: { name: "MK4" }, extrusionMultiplier: 0.9 },
        { printer: null, bedType: null, extrusionMultiplier: 0.978 },
      ],
    };
    expect(pickRepresentativeCalibration(withDefault)?.extrusionMultiplier).toBe(0.978);
    const noDefault = { calibrations: [{ printer: { name: "MK4" }, extrusionMultiplier: 0.9 }] };
    expect(pickRepresentativeCalibration(noDefault)?.extrusionMultiplier).toBe(0.9);
  });

  it("droppedCalibrationCount is calibrations beyond the one baked representative", () => {
    // 0 or 1 calibration → nothing dropped.
    expect(droppedCalibrationCount({ calibrations: [] })).toBe(0);
    expect(droppedCalibrationCount({})).toBe(0);
    expect(
      droppedCalibrationCount({ calibrations: [{ nozzle: { diameter: 0.4, type: "Brass" } }] }),
    ).toBe(0);
    // GH #969 (Codex r3): two calibrations on the SAME nozzle but different bed
    // types must count as a drop — the old distinct-nozzle count collapsed these
    // to 1 and under-warned. Only one is baked, so one is dropped.
    expect(
      droppedCalibrationCount({
        calibrations: [
          { nozzle: { diameter: 0.4, type: "Brass" }, printer: null, bedType: null },
          { nozzle: { diameter: 0.4, type: "Brass" }, printer: null, bedType: { name: "Textured PEI" } },
        ],
      }),
    ).toBe(1);
    // Multiple across nozzles + contexts → all but the representative dropped.
    const f = {
      calibrations: [
        { nozzle: { diameter: 0.4, type: "Brass" }, printer: null },
        { nozzle: { diameter: 0.4, type: "brass" }, printer: { name: "MK4" } },
        { nozzle: { diameter: 0.6, type: "Brass" }, printer: null },
        { nozzle: { diameter: 0.4, type: "Brass", highFlow: true }, printer: null },
      ],
    };
    expect(droppedCalibrationCount(f)).toBe(3);
  });
});
