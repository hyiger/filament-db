import { describe, it, expect } from "vitest";
import { parseIniFilaments } from "@/lib/parseIni";

describe("parseIniFilaments", () => {
  it("returns empty array for empty content", () => {
    expect(parseIniFilaments("")).toEqual([]);
  });

  it("returns empty array for content with no filament sections", () => {
    const content = `
[print:0.2mm QUALITY]
layer_height = 0.2
perimeters = 3

[printer:My Printer]
bed_shape = 0x0,250x0,250x210,0x210
`;
    expect(parseIniFilaments(content)).toEqual([]);
  });

  it("parses a single filament section with all fields", () => {
    const content = `
[filament:Test PLA]
filament_vendor = TestBrand
filament_type = PLA
filament_colour = #FF0000
filament_cost = 25.99
filament_density = 1.24
filament_diameter = 1.75
temperature = 210
first_layer_temperature = 215
bed_temperature = 60
first_layer_bed_temperature = 65
filament_max_volumetric_speed = 15
inherits = Generic PLA
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "Test PLA",
      vendor: "TestBrand",
      type: "PLA",
      color: "#FF0000",
      cost: 25.99,
      density: 1.24,
      diameter: 1.75,
      temperatures: {
        nozzle: 210,
        nozzleFirstLayer: 215,
        bed: 60,
        bedFirstLayer: 65,
      },
      maxVolumetricSpeed: 15,
      inherits: "Generic PLA",
    });
  });

  it("parses multiple filament sections", () => {
    const content = `
[filament:PLA One]
filament_vendor = VendorA
filament_type = PLA
temperature = 200

[filament:PETG Two]
filament_vendor = VendorB
filament_type = PETG
temperature = 240
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("PLA One");
    expect(result[0].vendor).toBe("VendorA");
    expect(result[1].name).toBe("PETG Two");
    expect(result[1].vendor).toBe("VendorB");
  });

  it("handles nil values correctly", () => {
    const content = `
[filament:Nil Test]
filament_vendor = Test
filament_type = PLA
temperature = nil
filament_cost = nil
filament_density = nil
inherits = nil
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0].temperatures.nozzle).toBeNull();
    expect(result[0].cost).toBeNull();
    expect(result[0].density).toBeNull();
    expect(result[0].inherits).toBeNull();
    // nil values stored as null in settings
    expect(result[0].settings.temperature).toBeNull();
  });

  it("handles missing optional fields with defaults", () => {
    const content = `
[filament:Minimal]
filament_type = ABS
temperature = 250
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0].vendor).toBe("Unknown");
    expect(result[0].color).toBe("#808080");
    expect(result[0].diameter).toBe(1.75);
    expect(result[0].cost).toBeNull();
    expect(result[0].density).toBeNull();
    expect(result[0].temperatures.nozzleFirstLayer).toBeNull();
    expect(result[0].temperatures.bed).toBeNull();
    expect(result[0].temperatures.bedFirstLayer).toBeNull();
    expect(result[0].maxVolumetricSpeed).toBeNull();
    expect(result[0].inherits).toBeNull();
  });

  it("handles percentage values in numeric fields", () => {
    const content = `
[filament:Percent Test]
filament_vendor = Test
filament_type = PLA
filament_cost = 50%
`;
    const result = parseIniFilaments(content);
    expect(result[0].cost).toBe(50);
  });

  it("handles NaN values gracefully", () => {
    const content = `
[filament:NaN Test]
filament_vendor = Test
filament_type = PLA
filament_cost = notanumber
temperature = abc
`;
    const result = parseIniFilaments(content);
    expect(result[0].cost).toBeNull();
    expect(result[0].temperatures.nozzle).toBeNull();
  });

  it("handles empty string values", () => {
    const content = `
[filament:Empty Test]
filament_vendor = Test
filament_type = PLA
filament_cost =
temperature =
filament_diameter =
`;
    const result = parseIniFilaments(content);
    expect(result[0].cost).toBeNull();
    expect(result[0].temperatures.nozzle).toBeNull();
    expect(result[0].diameter).toBe(1.75); // fallback default
  });

  it("skips non-filament sections between filament sections", () => {
    const content = `
[filament:First]
filament_vendor = A
filament_type = PLA
temperature = 200

[print:Some Print Profile]
layer_height = 0.2

[filament:Second]
filament_vendor = B
filament_type = PETG
temperature = 240
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("First");
    expect(result[1].name).toBe("Second");
  });

  it("stores all raw settings in the settings object", () => {
    const content = `
[filament:Settings Test]
filament_vendor = Test
filament_type = PLA
custom_key = custom_value
another_setting = 42
`;
    const result = parseIniFilaments(content);
    expect(result[0].settings).toMatchObject({
      filament_vendor: "Test",
      filament_type: "PLA",
      custom_key: "custom_value",
      another_setting: "42",
    });
  });

  it("handles values containing equals signs", () => {
    const content = `
[filament:Equals Test]
filament_vendor = Test
filament_type = PLA
some_gcode = G1 X=10 Y=20
`;
    const result = parseIniFilaments(content);
    expect(result[0].settings.some_gcode).toBe("G1 X=10 Y=20");
  });

  it("trims whitespace from keys and values", () => {
    const content = `
[filament:Whitespace Test]
  filament_vendor   =   Trimmed Vendor
  filament_type  =  PLA
  temperature  =  210
`;
    const result = parseIniFilaments(content);
    expect(result[0].vendor).toBe("Trimmed Vendor");
    expect(result[0].type).toBe("PLA");
    expect(result[0].temperatures.nozzle).toBe(210);
  });

  it("handles filament section with no key-value pairs", () => {
    const content = `
[filament:Empty Section]

[filament:Has Data]
filament_vendor = Test
filament_type = PLA
`;
    const result = parseIniFilaments(content);
    // Empty section produces no filament (no settings)
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Has Data");
  });

  it("flushes last filament at end of file", () => {
    const content = `[filament:Last One]
filament_vendor = Final
filament_type = ASA
temperature = 260`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Last One");
    expect(result[0].vendor).toBe("Final");
  });

  it("ignores lines without equals sign in filament section", () => {
    const content = `
[filament:Comment Test]
filament_vendor = Test
filament_type = PLA
# this is a comment
just some text
temperature = 200
`;
    const result = parseIniFilaments(content);
    expect(result[0].settings.filament_vendor).toBe("Test");
    expect(result[0].settings.temperature).toBe("200");
    expect(Object.keys(result[0].settings)).not.toContain("# this is a comment");
  });

  it("handles missing filament_vendor with Unknown default", () => {
    const content = `
[filament:No Vendor]
filament_type = PLA
temperature = 200
`;
    const result = parseIniFilaments(content);
    expect(result[0].vendor).toBe("Unknown");
  });

  it("handles missing filament_type with Unknown default", () => {
    const content = `
[filament:No Type]
filament_vendor = TestVendor
temperature = 200
`;
    const result = parseIniFilaments(content);
    expect(result[0].type).toBe("Unknown");
  });
});
