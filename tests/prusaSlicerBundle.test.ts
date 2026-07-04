import { describe, it, expect } from "vitest";
import {
  filamentToSlicerKeys,
  generatePrusaSlicerBundle,
  collapsePerNozzleImportSections,
  resolveSyncBackColor,
  nozzleSuffix,
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

  it("#950: a per-nozzle calibration bake derives the nozzle-diameter condition when unpinned", () => {
    const keys = filamentToSlicerKeys(
      {
        name: "PLA",
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
        temperatures: {},
        settings: {},
      },
      { nozzle: { diameter: 0.4, type: "Brass" }, extrusionMultiplier: 1.02 } as never,
    );
    expect(keys.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
    expect(keys.filamentdb_nozzle).toBe("0.4 Brass");
  });

  it("#950: a user-pinned condition survives the per-nozzle calibration bake (not overwritten)", () => {
    const keys = filamentToSlicerKeys(
      {
        name: "PLA",
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
        temperatures: {},
        // A round-tripped user pin — the calibration bake must NOT clobber it.
        settings: { compatible_printers_condition: "printer_model==MK4" },
      },
      { nozzle: { diameter: 0.4, type: "Brass" }, extrusionMultiplier: 1.02 } as never,
    );
    expect(keys.compatible_printers_condition).toBe("printer_model==MK4");
    // The routing hint is still emitted (it's a hint for THIS nozzle, not a user setting).
    expect(keys.filamentdb_nozzle).toBe("0.4 Brass");
  });

  it("#950: a nil (inherit) condition survives the per-nozzle calibration bake", () => {
    const keys = filamentToSlicerKeys(
      {
        name: "PLA",
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
        temperatures: {},
        settings: { compatible_printers_condition: null },
      },
      { nozzle: { diameter: 0.4, type: "Brass" }, extrusionMultiplier: 1.02 } as never,
    );
    expect(keys.compatible_printers_condition).toBeNull();
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

  it("maps notes to filament_notes when unset in the settings bag (line 293)", () => {
    const keys = filamentToSlicerKeys({
      name: "Noted",
      vendor: "V",
      type: "PLA",
      notes: "dry at 55C before printing",
      temperatures: {},
      settings: {},
    });
    expect(keys.filament_notes).toBe("dry at 55C before printing");
  });

  it("does NOT overwrite an existing settings-bag filament_notes with the DB notes (line 292 false branch)", () => {
    const keys = filamentToSlicerKeys({
      name: "Noted",
      vendor: "V",
      type: "PLA",
      notes: "db notes",
      temperatures: {},
      settings: { filament_notes: "preset notes win" },
    });
    expect(keys.filament_notes).toBe("preset notes win");
  });

  it("GH #950: round-trips filament_soluble / filament_abrasive through the settings bag", () => {
    // These keys have no schema field — the old top-level `soluble`/`abrasive`
    // booleans were never persisted (Mongoose stripped them) so the exporter's
    // `set(..., filament.soluble)` was always a no-op. They now ride the settings
    // passthrough bag verbatim, so an import→export round-trip preserves them.
    const solubleTrue = filamentToSlicerKeys({
      name: "PVA",
      vendor: "V",
      type: "PVA",
      temperatures: {},
      settings: { filament_soluble: "1", filament_abrasive: "0" },
    });
    expect(solubleTrue.filament_soluble).toBe("1");
    expect(solubleTrue.filament_abrasive).toBe("0");

    const abrasiveTrue = filamentToSlicerKeys({
      name: "CF",
      vendor: "V",
      type: "PA-CF",
      temperatures: {},
      settings: { filament_soluble: "0", filament_abrasive: "1" },
    });
    expect(abrasiveTrue.filament_soluble).toBe("0");
    expect(abrasiveTrue.filament_abrasive).toBe("1");
  });

  it("GH #950: omits soluble/abrasive keys entirely when the settings bag has neither", () => {
    const keys = filamentToSlicerKeys({
      name: "Plain",
      vendor: "V",
      type: "PLA",
      temperatures: {},
      settings: {},
    });
    expect(keys).not.toHaveProperty("filament_soluble");
    expect(keys).not.toHaveProperty("filament_abrasive");
  });

  it("GH #950: does NOT read a (dead) top-level soluble/abrasive field — settings bag is authoritative", () => {
    // Regression guard: the schema has no soluble/abrasive column, so the old
    // `set("filament_soluble", filament.soluble ? "1" : "0")` reader was dead.
    // If it were restored, a top-level flag would CLOBBER the settings-bag value.
    // Pin the settings bag as authoritative so a revert fails here.
    const keys = filamentToSlicerKeys({
      name: "Conflict",
      vendor: "V",
      type: "PVA",
      temperatures: {},
      soluble: true, // dead field — must be ignored
      abrasive: true, // dead field — must be ignored
      settings: { filament_soluble: "0", filament_abrasive: "0" },
    });
    expect(keys.filament_soluble).toBe("0"); // settings wins; top-level ignored
    expect(keys.filament_abrasive).toBe("0");
  });

  it("emits shrinkage compensation keys from shrinkageXY / shrinkageZ (lines 301-304)", () => {
    const keys = filamentToSlicerKeys({
      name: "Shrinky",
      vendor: "V",
      type: "ABS",
      shrinkageXY: 100.4,
      shrinkageZ: 100.2,
      temperatures: {},
      settings: {},
    });
    expect(keys.filament_shrinkage_compensation_xy).toBe("100.4");
    expect(keys.filament_shrinkage_compensation_z).toBe("100.2");
  });

  it("omits shrinkage keys when shrinkageXY / shrinkageZ are absent (301-303 false branch)", () => {
    const keys = filamentToSlicerKeys({
      name: "NoShrink",
      vendor: "V",
      type: "PLA",
      temperatures: {},
      settings: {},
    });
    expect(keys).not.toHaveProperty("filament_shrinkage_compensation_xy");
    expect(keys).not.toHaveProperty("filament_shrinkage_compensation_z");
  });

  it("emits shrinkage of 0 (falsy but non-null → still written)", () => {
    // shrinkage compensation of exactly 0 is a real value; the guard is `!= null`
    // so it must pass through `set()`, not be swallowed as a falsy default.
    const keys = filamentToSlicerKeys({
      name: "ZeroShrink",
      vendor: "V",
      type: "PLA",
      shrinkageXY: 0,
      shrinkageZ: 0,
      temperatures: {},
      settings: {},
    });
    // set() treats 0 as a value (only null/"" are skipped) → written as "0".
    expect(keys.filament_shrinkage_compensation_xy).toBe("0");
    expect(keys.filament_shrinkage_compensation_z).toBe("0");
  });

  it("tolerates a missing settings bag (line 235 `settings || {}` fallback)", () => {
    // A doc with no `settings` field must not throw — the spread falls back to {}.
    const keys = filamentToSlicerKeys({
      name: "NoSettings",
      vendor: "V",
      type: "PLA",
      temperatures: { nozzle: 205 },
    });
    expect(keys.filament_type).toBe("PLA");
    expect(keys.temperature).toBe("205");
    expect(keys.filament_settings_id).toBe("NoSettings");
  });

  it("falls back to empty string for filament_settings_id when name is empty (line 279)", () => {
    const keys = filamentToSlicerKeys({
      name: "",
      vendor: "V",
      type: "PLA",
      temperatures: {},
      settings: {},
    });
    expect(keys.filament_settings_id).toBe("");
  });

  it("ignores non-numeric compatibleNozzles entries when deriving the condition (line 374)", () => {
    // Entries without a numeric `diameter`, and non-object entries, map to null and
    // are filtered out; only the valid 0.4 survives the derivation.
    const keys = filamentToSlicerKeys({
      name: "Mixed",
      vendor: "V",
      type: "PLA",
      temperatures: {},
      settings: {},
      compatibleNozzles: [
        { diameter: 0.4 },
        { diameter: "0.6" }, // non-number → dropped
        { type: "Brass" }, // no diameter → dropped
        null, // non-object → dropped
        "0.8", // non-object → dropped
      ],
    });
    expect(keys.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
  });

  it("drops zero / negative nozzle diameters from the derived condition", () => {
    const keys = filamentToSlicerKeys({
      name: "ZeroDia",
      vendor: "V",
      type: "PLA",
      temperatures: {},
      settings: {},
      compatibleNozzles: [{ diameter: 0 }, { diameter: -1 }, { diameter: 0.4 }],
    });
    expect(keys.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
  });

  it("coextruded with an empty-string first secondary omits filament_colour (line 38 branch)", () => {
    // color null + secondaryColors[0] is "" → slicerExportColor returns null, so
    // set() is a no-op and no gray sentinel is invented.
    const keys = filamentToSlicerKeys({
      name: "BadSecondary",
      vendor: "V",
      type: "PLA",
      color: null,
      secondaryColors: ["", "#00FF00"],
      temperatures: {},
      settings: {},
    });
    expect(keys).not.toHaveProperty("filament_colour");
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

describe("nozzleSuffix (#872)", () => {
  it("returns '' for a null/undefined nozzle or one with no diameter (lines 110-111)", () => {
    expect(nozzleSuffix(null)).toBe("");
    expect(nozzleSuffix(undefined)).toBe("");
    expect(nozzleSuffix({ type: "Brass" })).toBe(""); // diameter missing
  });

  it("composes '<Ø> <type>' and appends HF for a high-flow nozzle", () => {
    expect(nozzleSuffix({ diameter: 0.4, type: "Brass" })).toBe("0.4 Brass");
    expect(nozzleSuffix({ diameter: 0.4, type: "Brass", highFlow: true })).toBe(
      "0.4 Brass HF",
    );
  });

  it("collapses the missing type to a bare diameter (type ?? '' branch, line 111)", () => {
    // No type → the interpolated "" leaves a trailing space that trim() strips.
    expect(nozzleSuffix({ diameter: 0.6 })).toBe("0.6");
    // High-flow with no type keeps the HF marker.
    expect(nozzleSuffix({ diameter: 0.6, highFlow: true })).toBe("0.6 HF");
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

  it("#872: prefers the any-printer/any-bed default over a printer-specific calibration for the same nozzle (line 459)", () => {
    // Same nozzle key appears twice. The FIRST seen is printer-specific; the SECOND
    // is the any-printer/any-bed default. The default must win as the representative
    // (existing exists but new isDefault && !existingIsDefault → replace).
    const bundle = generatePrusaSlicerBundle([
      {
        name: "PLA",
        vendor: "Generic",
        type: "PLA",
        diameter: 1.75,
        temperatures: { nozzle: 210 },
        settings: {},
        calibrations: [
          // second-nozzle entry so byNozzle.size >= 2 → suffixed presets are emitted
          { nozzle: { name: "0.6 Brass", diameter: 0.6, type: "Brass" }, printer: null, extrusionMultiplier: 0.9 },
          // 0.4 Brass, printer-specific FIRST
          { nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" }, printer: { name: "MK4" }, bedType: { name: "Textured" }, extrusionMultiplier: 0.91 },
          // 0.4 Brass default SECOND — should become the representative
          { nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" }, printer: null, bedType: null, extrusionMultiplier: 0.95 },
        ],
      },
    ]);
    // The default's extrusion multiplier is baked, not the printer-specific one.
    expect(bundle).toContain("extrusion_multiplier = 0.95");
    expect(bundle).not.toContain("extrusion_multiplier = 0.91");
  });

  it("#872: keeps the first-seen default when a later printer-specific cal shares its nozzle (line 459 no-replace branch)", () => {
    // FIRST 0.4 Brass is the default; a later printer-specific one for the same
    // nozzle must NOT replace it (existing is already default → keep existing).
    const bundle = generatePrusaSlicerBundle([
      {
        name: "PLA",
        vendor: "Generic",
        type: "PLA",
        diameter: 1.75,
        temperatures: { nozzle: 210 },
        settings: {},
        calibrations: [
          { nozzle: { name: "0.6 Brass", diameter: 0.6, type: "Brass" }, printer: null, extrusionMultiplier: 0.9 },
          { nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" }, printer: null, bedType: null, extrusionMultiplier: 0.95 },
          { nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" }, printer: { name: "MK4" }, extrusionMultiplier: 0.91 },
        ],
      },
    ]);
    expect(bundle).toContain("extrusion_multiplier = 0.95");
    expect(bundle).not.toContain("extrusion_multiplier = 0.91");
  });

  it("#872: groups distinct typeless nozzles by diameter (nz.type ?? '' key branch, line 454)", () => {
    // Two calibrations, both with a diameter but NO type — they must still key
    // distinctly by diameter and expand into two suffixed presets.
    const bundle = generatePrusaSlicerBundle([
      {
        name: "PLA",
        vendor: "Generic",
        type: "PLA",
        diameter: 1.75,
        temperatures: { nozzle: 210 },
        settings: {},
        calibrations: [
          { nozzle: { diameter: 0.4 }, printer: null, extrusionMultiplier: 0.95 },
          { nozzle: { diameter: 0.6 }, printer: null, extrusionMultiplier: 0.9 },
        ],
      },
    ]);
    expect(bundle).toContain("[filament:PLA 0.4]");
    expect(bundle).toContain("[filament:PLA 0.6]");
    expect(bundle).toContain("filamentdb_nozzle = 0.4");
  });

  it("#872: a standard and a high-flow nozzle of the same Ø+type are DISTINCT presets (line 454 HF key branch)", () => {
    // The grouping key includes highFlow, so 0.4 Brass and 0.4 Brass HF don't
    // collapse — they expand into two suffixed presets.
    const bundle = generatePrusaSlicerBundle([
      {
        name: "PLA",
        vendor: "Generic",
        type: "PLA",
        diameter: 1.75,
        temperatures: { nozzle: 210 },
        settings: {},
        calibrations: [
          { nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" }, printer: null, extrusionMultiplier: 0.95 },
          { nozzle: { name: "0.4 Brass HF", diameter: 0.4, type: "Brass", highFlow: true }, printer: null, extrusionMultiplier: 0.9 },
        ],
      },
    ]);
    expect(bundle).toContain("[filament:PLA 0.4 Brass]");
    expect(bundle).toContain("[filament:PLA 0.4 Brass HF]");
    expect(bundle).toContain("filamentdb_nozzle = 0.4 Brass HF");
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

  it("#950: strips filament_settings_id from a non-hinted section's settings bag", () => {
    // filament_settings_id is re-derived from the filament name on export; a stale
    // copy in the bag would make a renamed filament export its old name.
    const parsed = parseIniFilaments(
      `[filament:Plain PLA]\nfilament_type = PLA\nfilament_vendor = Acme\nfilament_settings_id = Plain PLA\ncooling = 1\n`,
    );
    const f = collapsePerNozzleImportSections(parsed)[0];
    expect(f.settings.filament_settings_id).toBeUndefined();
    expect(f.settings.cooling).toBe("1"); // genuine passthrough key survives
  });

  it("#950: a non-hinted section drops scalar fields it did NOT supply (leave-when-omitted)", () => {
    // A hand-crafted / partial section that supplies only identity: parseIni
    // defaults cost/density/color/diameter/max-vol, but $set-ing those defaults
    // over a name-matched existing filament would CLOBBER its real values.
    const parsed = parseIniFilaments(
      `[filament:Plain PLA]\nfilament_type = PLA\nfilament_vendor = Acme\ntemperature = 210\n`,
    );
    const f = collapsePerNozzleImportSections(parsed)[0];
    expect("cost" in f).toBe(false);
    expect("density" in f).toBe(false);
    expect("color" in f).toBe(false);
    expect("diameter" in f).toBe(false);
    expect("maxVolumetricSpeed" in f).toBe(false);
    // Supplied identity + temps are kept.
    expect(f.vendor).toBe("Acme");
    expect(f.type).toBe("PLA");
    expect(f.temperatures?.nozzle).toBe(210);
  });

  it("#950: a non-hinted section KEEPS scalars it DID supply (normal full export)", () => {
    const parsed = parseIniFilaments(
      `[filament:Full PLA]\nfilament_type = PLA\nfilament_vendor = Acme\nfilament_cost = 22\nfilament_density = 1.24\nfilament_colour = #445566\nfilament_diameter = 1.75\nfilament_max_volumetric_speed = 15\n`,
    );
    const f = collapsePerNozzleImportSections(parsed)[0];
    expect(f.cost).toBe(22);
    expect(f.density).toBe(1.24);
    expect(f.color).toBe("#445566");
    expect(f.diameter).toBe(1.75);
    expect(f.maxVolumetricSpeed).toBe(15);
  });

  it("#950: captures a non-hinted section's filamentdb_id as filamentdbId (routing hint, not settings data)", () => {
    const parsed = parseIniFilaments(
      `[filament:Plain PLA]\nfilament_type = PLA\nfilamentdb_id = 64b000000000000000000abc\n`,
    );
    const f = collapsePerNozzleImportSections(parsed)[0];
    expect(f.filamentdbId).toBe("64b000000000000000000abc"); // captured for id-first resolution
    expect(f.settings.filamentdb_id).toBeUndefined(); // never stored as data
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
    // GH #950: the hinted branch also captures filamentdb_id for id-first resolution.
    expect(base.filamentdbId).toBe("64b000000000000000000002");
    expect(base.settings.filamentdb_id).toBeUndefined();
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

  it("leaves the name unchanged when it does NOT end with the hint suffix (line 192 false branch)", () => {
    // A hinted section whose section name does NOT end with " <hint>" (hand-crafted
    // or renamed) can't be de-suffixed, so the base name stays as-is.
    const parsed = parseIniFilaments(
      `[filament:MyCustomPLA]\nfilament_type = PLA\nfilament_vendor = Acme\nfilamentdb_nozzle = 0.4 Brass\n`,
    );
    const collapsed = collapsePerNozzleImportSections(parsed);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].name).toBe("MyCustomPLA"); // hint present but name doesn't end with it
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

  it("#950 (Codex r3): KEEPS a user-pinned compatible_printers_condition on a hinted collapse (round-trip)", () => {
    // 950.2 makes the export carry a user pin through per-nozzle sections; the
    // import must NOT strip it (the $set replaces the whole bag), else the pin is
    // destroyed on export→import.
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilament_type = PLA\nfilamentdb_nozzle = 0.4 Brass\ncompatible_printers_condition = printer_model==MK4\n`,
    );
    const base = collapsePerNozzleImportSections(parsed)[0];
    expect(base.settings.compatible_printers_condition).toBe("printer_model==MK4");
  });

  it("#950 (Codex r3): STRIPS an auto-derived nozzle_diameter condition on a hinted collapse (re-derived on export)", () => {
    // The baked per-nozzle value differs per section, so pinning it onto the base
    // would be wrong — it's stripped and re-derived from compatibleNozzles.
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilament_type = PLA\nfilamentdb_nozzle = 0.4 Brass\ncompatible_printers_condition = nozzle_diameter[0]==0.4\n`,
    );
    const base = collapsePerNozzleImportSections(parsed)[0];
    expect("compatible_printers_condition" in base.settings).toBe(false);
  });

  it("#950 (Codex r3): KEEPS a nil (inherit) compatible_printers_condition on a hinted collapse", () => {
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilament_type = PLA\nfilamentdb_nozzle = 0.4 Brass\ncompatible_printers_condition = nil\n`,
    );
    const base = collapsePerNozzleImportSections(parsed)[0];
    // nil parses to null (the inheritance marker) and must survive the collapse.
    expect(base.settings.compatible_printers_condition).toBeNull();
  });

  it("#950 (Codex r4): KEEPS a user pin that merely REFERENCES nozzle_diameter (not the exact derived shape)", () => {
    // A substring test would wrongly strip this legitimate compound restriction.
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilament_type = PLA\nfilamentdb_nozzle = 0.4 Brass\ncompatible_printers_condition = printer_model==MK4 and nozzle_diameter[0]==0.4\n`,
    );
    const base = collapsePerNozzleImportSections(parsed)[0];
    expect(base.settings.compatible_printers_condition).toBe(
      "printer_model==MK4 and nozzle_diameter[0]==0.4",
    );
  });

  it("#950 (Codex r4): STRIPS a multi-term auto-derived condition (nozzle_diameter or-joined)", () => {
    const parsed = parseIniFilaments(
      `[filament:PLA 0.4 Brass]\nfilament_type = PLA\nfilamentdb_nozzle = 0.4 Brass\ncompatible_printers_condition = nozzle_diameter[0]==0.4 or nozzle_diameter[0]==0.6\n`,
    );
    const base = collapsePerNozzleImportSections(parsed)[0];
    expect("compatible_printers_condition" in base.settings).toBe(false);
  });

  it("#950 (Codex r3): a pinned condition survives a full multi-nozzle export→parse→collapse round-trip", () => {
    const filament = {
      name: "PLA",
      vendor: "Generic",
      type: "PLA",
      _id: "64b000000000000000000010",
      temperatures: { nozzle: 210, bed: 60 },
      // User pin at filament scope.
      settings: { compatible_printers_condition: "printer_model==MK4" },
      calibrations: [
        { nozzle: { name: "0.4 Brass", diameter: 0.4, type: "Brass" }, printer: null, extrusionMultiplier: 0.95, nozzleTemp: 205 },
        { nozzle: { name: "0.6 Brass", diameter: 0.6, type: "Brass" }, printer: null, maxVolumetricSpeed: 20, nozzleTemp: 215 },
      ],
    };
    const bundle = generatePrusaSlicerBundle([filament]);
    // The export carries the user pin (not the derived diameter condition) in each section.
    expect(bundle).toContain("compatible_printers_condition = printer_model==MK4");
    const base = collapsePerNozzleImportSections(parseIniFilaments(bundle))[0];
    expect(base.settings.compatible_printers_condition).toBe("printer_model==MK4"); // survived
  });
});

describe("resolveSyncBackColor (#883)", () => {
  it("suppresses the echoed secondary on a coextruded filament (keeps null primary)", () => {
    const stored = { color: null, secondaryColors: ["#112233", "#445566"] };
    // The slicer echoes secondaryColors[0]; must NOT be written onto the primary.
    expect(resolveSyncBackColor(stored, "#112233")).toBeUndefined();
    // Case-insensitive — the slicer may upper-case it.
    expect(resolveSyncBackColor(stored, "#112233".toUpperCase())).toBeUndefined();
  });

  it("writes a genuinely different incoming color on a coextruded filament", () => {
    const stored = { color: null, secondaryColors: ["#112233"] };
    expect(resolveSyncBackColor(stored, "#ff0000")).toBe("#ff0000");
  });

  it("writes the incoming color for a normal single-color filament", () => {
    expect(resolveSyncBackColor({ color: "#000000", secondaryColors: [] }, "#ff0000")).toBe("#ff0000");
    expect(resolveSyncBackColor({ color: "#000000" }, "#abcdef")).toBe("#abcdef");
  });

  it("writes the incoming color when there is no stored doc (create branch)", () => {
    expect(resolveSyncBackColor(null, "#123456")).toBe("#123456");
  });

  it("#913: suppresses the echo for a variant that INHERITS the parent's coextruded secondaries", () => {
    // Variant's own color null + own secondaryColors empty → inherits parent's.
    const variant = { color: null, secondaryColors: [] };
    const parent = { secondaryColors: ["#112233", "#445566"] };
    // The export gave the slicer the PARENT's secondaryColors[0]; the echo must
    // not be written onto the variant's primary.
    expect(resolveSyncBackColor(variant, "#112233", parent)).toBeUndefined();
    expect(resolveSyncBackColor(variant, "#112233".toUpperCase(), parent)).toBeUndefined();
    // A genuinely different incoming color is still written.
    expect(resolveSyncBackColor(variant, "#ff0000", parent)).toBe("#ff0000");
    // A variant that OWNS its secondaries uses those, not the parent's.
    expect(resolveSyncBackColor({ color: null, secondaryColors: ["#abcabc"] }, "#abcabc", parent)).toBeUndefined();
  });

  it("returns undefined for an absent incoming color", () => {
    expect(resolveSyncBackColor({ color: null, secondaryColors: ["#112233"] }, null)).toBeUndefined();
    expect(resolveSyncBackColor({ color: "#000000" }, "")).toBeUndefined();
  });
});
