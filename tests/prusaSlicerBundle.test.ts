import { describe, it, expect } from "vitest";
import {
  filamentToSlicerKeys,
  generatePrusaSlicerBundle,
  collapsePerNozzleImportSections,
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

  it("#867 — emits filamentdb_id (the _id) so the sync-back can match by id", () => {
    const keys = filamentToSlicerKeys({
      _id: "6a1a7bef677d648e9ba9cd3a",
      name: "Fibreheart PPA",
      vendor: "Siraya Tech",
      type: "PPA",
      settings: {},
    });
    expect(keys.filamentdb_id).toBe("6a1a7bef677d648e9ba9cd3a");
  });

  it("#867 — omits filamentdb_id when the doc has no _id (graceful)", () => {
    const keys = filamentToSlicerKeys({ name: "X", vendor: "V", type: "PLA", settings: {} });
    expect("filamentdb_id" in keys).toBe(false);
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

  it("emits empty compatible_printers + compatible_printers_condition by default", () => {
    // Without these, synced presets are filtered out of the active
    // printer's filament dropdown in PrusaSlicer — programmatic
    // Tab::select_preset falls back to the closest compatible default
    // and the scan-stream auto-select can't switch to a scanned tag.
    const filament = {
      name: "Overture PETG",
      vendor: "Overture",
      type: "PETG",
      color: "#000000",
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToSlicerKeys(filament);

    expect(keys.compatible_printers).toBe("");
    expect(keys.compatible_printers_condition).toBe("");
  });

  it("#872: derives compatible_printers_condition from compatible nozzle diameters (deduped + sorted)", () => {
    const keys = filamentToSlicerKeys({
      name: "PA12-CF",
      vendor: "X",
      type: "PA",
      diameter: 1.75,
      temperatures: {},
      settings: {},
      compatibleNozzles: [{ diameter: 0.6 }, { diameter: 0.4 }, { diameter: 0.4 }],
    });
    expect(keys.compatible_printers_condition).toBe(
      "nozzle_diameter[0]==0.4 or nozzle_diameter[0]==0.6",
    );
  });

  it("#872: a user-pinned compatible_printers_condition wins over the nozzle-diameter derivation", () => {
    const keys = filamentToSlicerKeys({
      name: "Pinned",
      vendor: "X",
      type: "PLA",
      diameter: 1.75,
      temperatures: {},
      settings: { compatible_printers_condition: "printer_model==MK4" },
      compatibleNozzles: [{ diameter: 0.4 }],
    });
    expect(keys.compatible_printers_condition).toBe("printer_model==MK4");
  });

  it("#872: an EMPTY settings condition (round-tripped default) is overridden by the nozzle derivation", () => {
    const keys = filamentToSlicerKeys({
      name: "RoundTripped",
      vendor: "X",
      type: "PLA",
      diameter: 1.75,
      temperatures: {},
      // PrusaSlicer round-trip stores `compatible_printers_condition = ` as "".
      settings: { compatible_printers_condition: "" },
      compatibleNozzles: [{ diameter: 0.4 }],
    });
    expect(keys.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
  });

  it("#872: a NULL (nil/inherit) settings condition is preserved, not derived over", () => {
    const keys = filamentToSlicerKeys({
      name: "Inherited",
      vendor: "X",
      type: "PLA",
      diameter: 1.75,
      temperatures: {},
      // PrusaSlicer `nil` round-trips through parseIniFilaments as null (inherit).
      settings: { compatible_printers_condition: null },
      compatibleNozzles: [{ diameter: 0.4 }],
    });
    expect(keys.compatible_printers_condition).toBeNull();
  });

  it("#872: no compatible nozzles → empty condition (no restriction)", () => {
    const keys = filamentToSlicerKeys({
      name: "Bare",
      vendor: "X",
      type: "PLA",
      diameter: 1.75,
      temperatures: {},
      settings: {},
      compatibleNozzles: [],
    });
    expect(keys.compatible_printers_condition).toBe("");
  });

  it("preserves a user-set compatible_printers from the settings bag", () => {
    // If a previous import (or hand-edit) pinned the preset to a
    // specific printer, the default-blanking must NOT clobber that.
    const filament = {
      name: "Restricted PLA",
      vendor: "Test",
      type: "PLA",
      color: "#000000",
      diameter: 1.75,
      temperatures: {},
      settings: {
        compatible_printers: "Original Prusa MK4S",
        compatible_printers_condition: 'printer_model=="MK4S"',
      },
    };

    const keys = filamentToSlicerKeys(filament);

    expect(keys.compatible_printers).toBe("Original Prusa MK4S");
    expect(keys.compatible_printers_condition).toBe(
      'printer_model=="MK4S"',
    );
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

    const keys = filamentToSlicerKeys(filament);

    expect(keys.filament_colour).toBe("#FF0000");
    // No secondary-color keys are ever emitted — slicer presets are
    // single-color and the detail page warns the user about this.
    expect(JSON.stringify(keys)).not.toContain("#00FF00");
    expect(JSON.stringify(keys)).not.toContain("#0000FF");
  });

  it("coextruded filament (null primary) falls back to the first secondary", () => {
    const filament = {
      name: "Coextruded",
      vendor: "Test",
      type: "PLA",
      color: null, // coextruded: no single primary
      secondaryColors: ["#3366CC", "#CC3366"],
      diameter: 1.75,
      temperatures: {},
      settings: {},
    };

    const keys = filamentToSlicerKeys(filament);

    // Primary is null but the slicer-export fallback promotes the first
    // secondary so the slicer sees a valid color rather than its bare
    // default.
    expect(keys.filament_colour).toBe("#3366CC");
    expect(JSON.stringify(keys)).not.toContain("#CC3366");
  });

  it("coextruded filament with NO secondaries omits filament_colour entirely", () => {
    // Reachable state: user picked "coextruded" in the form (clears
    // primary to null) and saved before adding any secondary slots.
    // We must NOT fall back to displayColor()'s gray sentinel — that
    // would force a #808080 the user never picked. Better to omit the
    // key and let the slicer use its own default. (Codex P2 on PR #485.)
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

    const keys = filamentToSlicerKeys(filament);

    expect(keys).not.toHaveProperty("filament_colour");
    expect(JSON.stringify(keys)).not.toContain("#808080");
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

  it("#872: expands a MULTI-nozzle filament into one suffixed preset per nozzle, baking calibration", () => {
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
            nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" },
            printer: { name: "MK3S+" },
            extrusionMultiplier: 0.95,
            retractLength: 0.8,
          },
          {
            nozzle: { name: "0.6 Brass", diameter: 0.6, type: "Brass" },
            printer: null,
            maxVolumetricSpeed: 20,
          },
        ],
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);

    // Two distinct nozzles → two flat, suffixed sections (no bare base section).
    expect(bundle).toContain("[filament:PLA 0.4 Brass]");
    expect(bundle).toContain("[filament:PLA 0.6 Brass]");
    expect(bundle).not.toContain("[filament:PLA]");
    // Each bakes its nozzle's filament-level calibration + a nozzle-scoped condition.
    expect(bundle).toContain("extrusion_multiplier = 0.95");
    expect(bundle).toContain("filament_retract_length = 0.8");
    expect(bundle).toContain("filament_max_volumetric_speed = 20");
    expect(bundle).toContain("compatible_printers_condition = nozzle_diameter[0]==0.4");
    expect(bundle).toContain("compatible_printers_condition = nozzle_diameter[0]==0.6");
    // Nozzle hint for sync-back routing.
    expect(bundle).toContain("filamentdb_nozzle = 0.4 Brass");
    // Base filament temps still carried in each preset.
    expect(bundle).toContain("temperature = 210");
  });

  it("#872: same-diameter nozzles differing only in type CASING collapse into ONE preset", () => {
    // "Brass" vs "brass" at the same Ø+HF are the same physical nozzle; the
    // grouping key case-folds the type so they don't split into two presets that
    // would both resolve to the same calibration on the case-insensitive read/sync.
    const filaments = [
      {
        name: "PLA",
        vendor: "Generic",
        type: "PLA",
        diameter: 1.75,
        temperatures: { nozzle: 210 },
        settings: {},
        calibrations: [
          { nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" }, printer: null, extrusionMultiplier: 0.95 },
          { nozzle: { name: "0.4 brass", diameter: 0.4, type: "brass" }, printer: { name: "MK4" }, extrusionMultiplier: 0.97 },
        ],
      },
    ];
    const bundle = generatePrusaSlicerBundle(filaments);
    // Only ONE distinct nozzle after case-folding → a single, unsuffixed preset.
    const sectionCount = (bundle.match(/^\[filament:/gm) || []).length;
    expect(sectionCount).toBe(1);
    expect(bundle).toContain("[filament:PLA]");
    expect(bundle).not.toContain("[filament:PLA 0.4 Brass]");
  });

  it("#872: a SINGLE-nozzle filament stays one preset (calibration applied dynamically)", () => {
    const filaments = [
      {
        name: "PETG",
        vendor: "Generic",
        type: "PETG",
        color: "#DDDDDD",
        diameter: 1.75,
        temperatures: { nozzle: 240 },
        settings: {},
        calibrations: [
          {
            nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" },
            printer: null,
            extrusionMultiplier: 0.98,
          },
        ],
      },
    ];

    const bundle = generatePrusaSlicerBundle(filaments);

    // One distinct nozzle → single base section, NOT expanded/suffixed.
    expect(bundle).toContain("[filament:PETG]");
    expect(bundle).not.toContain("[filament:PETG 0.4 Brass]");
    // Calibration is NOT baked in the single-nozzle path (stays dynamic).
    expect(bundle).not.toContain("extrusion_multiplier = 0.98");
    expect(bundle).not.toContain("filamentdb_nozzle");
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

describe("collapsePerNozzleImportSections (#872)", () => {
  it("collapses two suffixed sibling sections (shared filamentdb_id) into ONE base", () => {
    // Build a real multi-nozzle bundle and re-parse it — the exact round-trip.
    const filaments = [
      {
        name: "PLA",
        vendor: "Generic",
        type: "PLA",
        color: "#DDDDDD",
        diameter: 1.75,
        _id: "64b000000000000000000001",
        temperatures: { nozzle: 210, bed: 60 },
        settings: {},
        calibrations: [
          { nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" }, printer: null, extrusionMultiplier: 0.95, nozzleTemp: 205 },
          { nozzle: { name: "0.6 Brass", diameter: 0.6, type: "Brass" }, printer: null, maxVolumetricSpeed: 20, nozzleTemp: 215 },
        ],
      },
    ];
    const bundle = generatePrusaSlicerBundle(filaments);
    const parsed = parseIniFilaments(bundle);
    expect(parsed).toHaveLength(2); // two suffixed sections before collapsing

    const collapsed = collapsePerNozzleImportSections(parsed);
    expect(collapsed).toHaveLength(1); // ← folded back into the base
    const base = collapsed[0];
    expect(base.name).toBe("PLA"); // de-suffixed
    // Routing hints + per-nozzle baked keys are stripped from the settings bag.
    expect(base.settings.filamentdb_id).toBeUndefined();
    expect(base.settings.filamentdb_nozzle).toBeUndefined();
    expect(base.settings.extrusion_multiplier).toBeUndefined();
    expect(base.settings.compatible_printers_condition).toBeUndefined();
    // temps / max-vol are OMITTED (baked per-nozzle) so an update can't clobber them.
    expect("temperatures" in base).toBe(false);
    expect("maxVolumetricSpeed" in base).toBe(false);
    // Shared identity survives.
    expect(base.vendor).toBe("Generic");
    expect(base.type).toBe("PLA");
  });

  it("passes a non-hinted section through, stripping only the routing hint", () => {
    const parsed = parseIniFilaments(
      `[filament:Plain PLA]\nfilament_type = PLA\nfilament_vendor = Acme\ntemperature = 210\nfilamentdb_id = 64b000000000000000000009\n`,
    );
    const collapsed = collapsePerNozzleImportSections(parsed);
    expect(collapsed).toHaveLength(1);
    const f = collapsed[0];
    expect(f.name).toBe("Plain PLA"); // unchanged — no filamentdb_nozzle hint
    expect(f.settings.filamentdb_id).toBeUndefined(); // hint never stored as data
    expect(f.temperatures?.nozzle).toBe(210); // temps preserved for a single-nozzle import
  });

  it("groups siblings by de-suffixed name when no filamentdb_id is present", () => {
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilament_type = PLA\nfilamentdb_nozzle = 0.4 Brass\nextrusion_multiplier = 0.95\n\n` +
        `[filament:PLA 0.6 Brass]\nfilament_type = PLA\nfilamentdb_nozzle = 0.6 Brass\nfilament_max_volumetric_speed = 20\n`,
    );
    const collapsed = collapsePerNozzleImportSections(parsed);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].name).toBe("PLA");
  });

  it("omits a shared scalar a collapsed section did NOT supply (no clobber of base cost/density/color/diameter)", () => {
    // A hint-only suffixed section that omits filament_cost/density/colour/diameter:
    // parseIni would default them (null / null / #808080 / 1.75), but the collapse
    // must DROP the keys so $set can't overwrite the base filament's real values.
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilament_type = PLA\nfilament_vendor = Generic\nfilamentdb_nozzle = 0.4 Brass\nfilamentdb_id = 64b000000000000000000002\n`,
    );
    const collapsed = collapsePerNozzleImportSections(parsed);
    expect(collapsed).toHaveLength(1);
    const base = collapsed[0];
    expect("cost" in base).toBe(false);
    expect("density" in base).toBe(false);
    expect("color" in base).toBe(false);
    expect("diameter" in base).toBe(false);
    // Identity that WAS supplied is kept.
    expect(base.vendor).toBe("Generic");
    expect(base.type).toBe("PLA");
  });

  it("omits vendor/type a collapsed section did NOT supply (no clobber of base identity)", () => {
    // Only the routing hint present — parseIni would default vendor/type to "Unknown".
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilamentdb_nozzle = 0.4 Brass\nfilamentdb_id = 64b000000000000000000004\n`,
    );
    const base = collapsePerNozzleImportSections(parsed)[0];
    expect("vendor" in base).toBe(false);
    expect("type" in base).toBe(false);
  });

  it("carries a shared scalar a collapsed section DID supply (normal export bakes them from the base)", () => {
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilament_type = PLA\nfilament_colour = #112233\nfilament_cost = 25\nfilament_density = 1.24\nfilament_diameter = 1.75\nfilamentdb_nozzle = 0.4 Brass\n`,
    );
    const base = collapsePerNozzleImportSections(parsed)[0];
    expect(base.color).toBe("#112233");
    expect(base.cost).toBe(25);
    expect(base.density).toBe(1.24);
    expect(base.diameter).toBe(1.75);
  });
});
