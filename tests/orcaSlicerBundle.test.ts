import { describe, it, expect } from "vitest";
import {
  filamentToOrcaSlicerKeys,
  calibrationToOrcaSlicerKeys,
  generateOrcaSlicerProfiles,
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

  it("maps soluble flag", () => {
    const filament = {
      name: "PVA",
      vendor: "Test",
      type: "PVA",
      color: "#FFFFFF",
      diameter: 1.75,
      soluble: true,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToOrcaSlicerKeys(filament);
    expect(keys.filament_soluble).toEqual(["1"]);
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
