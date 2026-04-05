import { describe, it, expect } from "vitest";
import {
  filamentToSlicerKeys,
  generatePrusaSlicerBundle,
} from "@/lib/prusaSlicerBundle";
import { parseIniFilaments } from "@/lib/parseIni";

describe("filamentToSlicerKeys", () => {
  it("maps core structured fields to PrusaSlicer keys", () => {
    const filament = {
      name: "Generic PLA",
      vendor: "Generic",
      type: "PLA",
      color: "#DDDDDD",
      diameter: 1.75,
      density: 1.24,
      cost: 20,
      spoolWeight: 230,
      maxVolumetricSpeed: 15,
      temperatures: {
        nozzle: 210,
        nozzleFirstLayer: 215,
        bed: 60,
        bedFirstLayer: 65,
      },
      settings: {},
    };

    const keys = filamentToSlicerKeys(filament);

    expect(keys.filament_type).toBe("PLA");
    expect(keys.filament_vendor).toBe("Generic");
    expect(keys.filament_colour).toBe("#DDDDDD");
    expect(keys.filament_diameter).toBe("1.75");
    expect(keys.filament_density).toBe("1.24");
    expect(keys.filament_cost).toBe("20");
    expect(keys.filament_spool_weight).toBe("230");
    expect(keys.filament_max_volumetric_speed).toBe("15");
    expect(keys.temperature).toBe("210");
    expect(keys.first_layer_temperature).toBe("215");
    expect(keys.bed_temperature).toBe("60");
    expect(keys.first_layer_bed_temperature).toBe("65");
    expect(keys.filament_settings_id).toBe("Generic PLA");
  });

  it("preserves settings bag keys not in the schema", () => {
    const filament = {
      name: "Test",
      vendor: "Test",
      type: "PLA",
      color: "#000000",
      diameter: 1.75,
      temperatures: {},
      settings: {
        cooling: "1",
        fan_always_on: "1",
        min_fan_speed: "100",
        max_fan_speed: "100",
        bridge_fan_speed: "100",
        filament_ramming_parameters: "120 100 6.6 6.8",
        start_filament_gcode: "; start\\nM104 S{first_layer_temperature[0]}",
      },
    };

    const keys = filamentToSlicerKeys(filament);

    expect(keys.cooling).toBe("1");
    expect(keys.fan_always_on).toBe("1");
    expect(keys.min_fan_speed).toBe("100");
    expect(keys.max_fan_speed).toBe("100");
    expect(keys.bridge_fan_speed).toBe("100");
    expect(keys.filament_ramming_parameters).toBe("120 100 6.6 6.8");
    expect(keys.start_filament_gcode).toBe(
      "; start\\nM104 S{first_layer_temperature[0]}",
    );
  });

  it("structured DB fields override settings bag on conflict", () => {
    const filament = {
      name: "Override Test",
      vendor: "RealVendor",
      type: "PETG",
      color: "#FF0000",
      diameter: 1.75,
      density: 1.27,
      cost: 25,
      maxVolumetricSpeed: 12,
      temperatures: {
        nozzle: 240,
        bed: 80,
      },
      settings: {
        // These should be overridden by structured fields
        filament_type: "PLA",
        filament_vendor: "WrongVendor",
        filament_colour: "#0000FF",
        filament_density: "0",
        filament_cost: "0",
        filament_max_volumetric_speed: "0",
        temperature: "200",
        bed_temperature: "60",
        // This should be preserved (no structured field for it)
        cooling: "1",
      },
    };

    const keys = filamentToSlicerKeys(filament);

    // Structured fields win
    expect(keys.filament_type).toBe("PETG");
    expect(keys.filament_vendor).toBe("RealVendor");
    expect(keys.filament_colour).toBe("#FF0000");
    expect(keys.filament_density).toBe("1.27");
    expect(keys.filament_cost).toBe("25");
    expect(keys.filament_max_volumetric_speed).toBe("12");
    expect(keys.temperature).toBe("240");
    expect(keys.bed_temperature).toBe("80");

    // Non-conflicting settings preserved
    expect(keys.cooling).toBe("1");
  });

  it("omits missing temperatures when not in settings (PrusaSlicer uses defaults)", () => {
    const filament = {
      name: "Minimal",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToSlicerKeys(filament);

    // Missing structured fields should be omitted entirely so PrusaSlicer
    // uses its built-in defaults instead of interpreting nil as zero.
    expect(keys.temperature).toBeUndefined();
    expect(keys.first_layer_temperature).toBeUndefined();
    expect(keys.bed_temperature).toBeUndefined();
    expect(keys.first_layer_bed_temperature).toBeUndefined();
  });

  it("preserves temperatures from settings when DB fields are null", () => {
    const filament = {
      name: "Settings Temps",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {
        nozzle: null,
        bed: null,
      },
      settings: {
        temperature: "200",
        bed_temperature: "55",
      },
    };

    const keys = filamentToSlicerKeys(filament);

    // Settings bag values preserved since DB fields are null
    expect(keys.temperature).toBe("200");
    expect(keys.bed_temperature).toBe("55");
  });

  it("maps inherits field", () => {
    const filament = {
      name: "Prusa PLA @MK3S",
      vendor: "Prusa",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      inherits: "Generic PLA",
      settings: {},
    };

    const keys = filamentToSlicerKeys(filament);
    expect(keys.inherits).toBe("Generic PLA");
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

    const keys = filamentToSlicerKeys(filament);
    expect(keys.filament_settings_id).toBe("My Custom PLA");
  });

  it("preserves filament_settings_id from settings if present", () => {
    const filament = {
      name: "Preset Name",
      vendor: "Vendor",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      temperatures: {},
      settings: {
        filament_settings_id: "Original Slicer ID",
      },
    };

    const keys = filamentToSlicerKeys(filament);
    expect(keys.filament_settings_id).toBe("Original Slicer ID");
  });

  it("null structured fields must not emit nil; settings bag nil is preserved", () => {
    const filament = {
      name: "Nil Test",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      density: null, // structured field is null
      cost: null, // structured field is null
      temperatures: {},
      settings: {
        filament_density: null, // settings bag nil — should be removed by set()
        cooling: null, // settings bag nil with no structured field — preserved
        fan_always_on: "1",
      },
    };

    const keys = filamentToSlicerKeys(filament);

    // Structured field density is null AND settings bag has nil for filament_density:
    // set() should delete the nil from settings bag so it doesn't emit "nil"
    expect(keys).not.toHaveProperty("filament_density");

    // Settings bag nil for a key with no corresponding structured field is preserved
    // (means "inherit from parent" in PrusaSlicer)
    expect(keys.cooling).toBeNull();

    // Verify the INI output: settings bag nil emits "nil"
    const bundle = generatePrusaSlicerBundle([filament]);
    expect(bundle).toContain("cooling = nil");
    // filament_density must NOT appear as nil
    expect(bundle).not.toContain("filament_density = nil");
    // Normal settings bag values still work
    expect(bundle).toContain("fan_always_on = 1");
  });
});

describe("generatePrusaSlicerBundle", () => {
  it("generates header and single filament section", () => {
    const filaments = [
      {
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
          bed: 60,
        },
        settings: {
          cooling: "1",
          fan_always_on: "1",
        },
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);
    const lines = bundle.split("\n");

    // Header
    expect(lines[0]).toBe("# PrusaSlicer config bundle generated by Filament DB");
    expect(lines[1]).toMatch(/^# \d{4}-\d{2}-\d{2}T/);

    // Section header
    expect(bundle).toContain("[filament:Generic PLA]");

    // Core keys present
    expect(bundle).toContain("filament_type = PLA");
    expect(bundle).toContain("filament_vendor = Generic");
    expect(bundle).toContain("filament_colour = #DDDDDD");
    expect(bundle).toContain("filament_diameter = 1.75");
    expect(bundle).toContain("filament_density = 1.24");
    expect(bundle).toContain("filament_cost = 20");
    expect(bundle).toContain("filament_max_volumetric_speed = 15");
    expect(bundle).toContain("temperature = 210");
    expect(bundle).toContain("bed_temperature = 60");

    // Settings passthrough
    expect(bundle).toContain("cooling = 1");
    expect(bundle).toContain("fan_always_on = 1");
  });

  it("ignores calibrations (applied dynamically via API)", () => {
    const filaments = [
      {
        name: "PLA",
        vendor: "Generic",
        type: "PLA",
        color: "#DDDDDD",
        diameter: 1.75,
        temperatures: { nozzle: 210, bed: 60 },
        settings: {},
        calibrations: [
          {
            nozzle: { name: "0.4mm Brass", diameter: 0.4 },
            printer: { name: "MK3S+" },
            extrusionMultiplier: 0.95,
            retractLength: 0.8,
          },
          {
            nozzle: { name: "0.6mm Brass", diameter: 0.6 },
            printer: null,
            maxVolumetricSpeed: 20,
          },
        ],
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);

    // Calibrations are not expanded into separate sections — they are
    // applied dynamically by PrusaSlicer via the calibration API endpoint.
    // Only the base filament section should be generated.
    expect(bundle).toContain("[filament:PLA]");
    expect(bundle).not.toContain("[filament:PLA MK3S+ 0.4mm Brass]");
    expect(bundle).not.toContain("[filament:PLA 0.6mm Brass]");

    // Base filament values present
    expect(bundle).toContain("temperature = 210");
    expect(bundle).toContain("bed_temperature = 60");
  });

  it("ignores presets (single section per filament)", () => {
    const filaments = [
      {
        name: "PETG",
        vendor: "Generic",
        type: "PETG",
        color: "#FF0000",
        diameter: 1.75,
        temperatures: { nozzle: 240, bed: 80 },
        settings: {},
        presets: [
          {
            label: "Standard",
            extrusionMultiplier: null,
            temperatures: { nozzle: 240, bed: 80 },
          },
          {
            label: "Fast",
            extrusionMultiplier: 0.93,
            temperatures: { nozzle: 250, bed: 85 },
          },
        ],
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);

    // Only the base section — no preset expansion
    expect(bundle).toContain("[filament:PETG]");
    expect(bundle).not.toContain("[filament:PETG 0.4mm Standard]");
    expect(bundle).not.toContain("[filament:PETG 0.4mm Fast]");
  });

  it("outputs base section for filaments with presets only", () => {
    const filaments = [
      {
        name: "ABS",
        vendor: "Generic",
        type: "ABS",
        color: "#000000",
        diameter: 1.75,
        temperatures: { nozzle: 255, bed: 100 },
        settings: {},
        presets: [
          {
            label: "Low Temp",
            temperatures: { nozzle: 245, bed: 95 },
          },
        ],
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);
    expect(bundle).toContain("[filament:ABS]");
    expect(bundle).toContain("temperature = 255");
    expect(bundle).toContain("bed_temperature = 100");
  });

  it("preserves start_filament_gcode from settings bag", () => {
    const filaments = [
      {
        name: "PA",
        vendor: "Test",
        type: "PA",
        color: "#808080",
        diameter: 1.75,
        temperatures: { nozzle: 260 },
        settings: {
          start_filament_gcode: "; setup\\nM572 S0.04\\n; done",
        },
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);

    // Settings bag gcode is preserved as-is in the base section
    expect(bundle).toContain("start_filament_gcode = ; setup\\nM572 S0.04\\n; done");
  });

  it("sorts keys alphabetically within sections", () => {
    const filaments = [
      {
        name: "Sorted",
        vendor: "Test",
        type: "PLA",
        color: "#808080",
        diameter: 1.75,
        temperatures: { nozzle: 200, bed: 60 },
        settings: {
          cooling: "1",
          fan_always_on: "1",
        },
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);
    const section = bundle.split("[filament:Sorted]")[1].trim();
    const keys = section
      .split("\n")
      .filter((l) => l.includes(" = "))
      .map((l) => l.split(" = ")[0]);

    // Verify keys are sorted
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("handles empty filaments array", () => {
    const bundle = generatePrusaSlicerBundle([]);
    expect(bundle).toContain("# PrusaSlicer config bundle generated by Filament DB");
    expect(bundle).not.toContain("[filament:");
  });

  it("outputs base section even when calibrations have no nozzle", () => {
    const filaments = [
      {
        name: "NoNozzle",
        vendor: "Test",
        type: "PLA",
        color: "#808080",
        diameter: 1.75,
        temperatures: {},
        settings: {},
        calibrations: [
          { nozzle: null, printer: null },
        ],
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);
    // Calibrations are ignored — base section is always generated
    expect(bundle).toContain("[filament:NoNozzle]");
    expect(bundle).not.toContain("[filament:NoNozzle ");
  });

  it("round-trips through parseIniFilaments", () => {

    const filaments = [
      {
        name: "Roundtrip PLA",
        vendor: "TestVendor",
        type: "PLA",
        color: "#FF8800",
        diameter: 1.75,
        density: 1.24,
        cost: 22.5,
        maxVolumetricSpeed: 15,
        temperatures: {
          nozzle: 210,
          nozzleFirstLayer: 215,
          bed: 60,
          bedFirstLayer: 65,
        },
        settings: {
          cooling: "1",
          fan_always_on: "1",
        },
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);
    const parsed = parseIniFilaments(bundle);

    expect(parsed).toHaveLength(1);
    const p = parsed[0];

    expect(p.name).toBe("Roundtrip PLA");
    expect(p.vendor).toBe("TestVendor");
    expect(p.type).toBe("PLA");
    expect(p.color).toBe("#FF8800");
    expect(p.diameter).toBe(1.75);
    expect(p.density).toBe(1.24);
    expect(p.cost).toBe(22.5);
    expect(p.maxVolumetricSpeed).toBe(15);
    expect(p.temperatures.nozzle).toBe(210);
    expect(p.temperatures.nozzleFirstLayer).toBe(215);
    expect(p.temperatures.bed).toBe(60);
    expect(p.temperatures.bedFirstLayer).toBe(65);
  });
});
