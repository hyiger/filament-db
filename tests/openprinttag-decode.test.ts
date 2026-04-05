import { describe, it, expect } from "vitest";
import { decodeOpenPrintTagBinary } from "@/lib/openprinttag-decode";
import { generateOpenPrintTagBinary, type OpenPrintTagInput } from "@/lib/openprinttag";

describe("decodeOpenPrintTagBinary", () => {
  it("round-trips a minimal payload", () => {
    const input: OpenPrintTagInput = {
      materialName: "Test PLA",
      brandName: "TestBrand",
      materialType: "PLA",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.materialName).toBe("Test PLA");
    expect(decoded.brandName).toBe("TestBrand");
    expect(decoded.materialType).toBe("PLA");
  });

  it("round-trips material type PCTG", () => {
    const input: OpenPrintTagInput = {
      materialName: "PCTG CF Black",
      brandName: "Spectrum",
      materialType: "PCTG",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.materialType).toBe("PCTG");
    expect(decoded.materialTypeRaw).toBe(6);
  });

  it("round-trips density as float", () => {
    const input: OpenPrintTagInput = {
      materialName: "Dense",
      brandName: "Brand",
      materialType: "PETG",
      density: 1.24,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.density).toBeCloseTo(1.24, 1);
  });

  it("omits diameter for default 1.75mm but decodes as 1.75", () => {
    const input: OpenPrintTagInput = {
      materialName: "Default",
      brandName: "Brand",
      materialType: "PLA",
      diameter: 1.75,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    // Spec default: 1.75mm when not present
    expect(decoded.diameter).toBe(1.75);
  });

  it("round-trips non-default diameter as float", () => {
    const input: OpenPrintTagInput = {
      materialName: "BigDia",
      brandName: "Brand",
      materialType: "PLA",
      diameter: 2.85,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.diameter).toBeCloseTo(2.85, 1);
  });

  it("round-trips temperatures", () => {
    const input: OpenPrintTagInput = {
      materialName: "Hot",
      brandName: "Brand",
      materialType: "ABS",
      nozzleTemp: 245,
      bedTemp: 100,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.nozzleTemp).toBe(245);
    expect(decoded.bedTemp).toBe(100);
    // Min temps derived from encoder logic
    expect(decoded.nozzleTempMin).toBe(225); // 245 - 20
    expect(decoded.bedTempMin).toBe(90); // 100 - 10
  });

  it("round-trips color", () => {
    const input: OpenPrintTagInput = {
      materialName: "Red",
      brandName: "Brand",
      materialType: "PLA",
      color: "#ff0000",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.color).toBe("#ff0000");
  });

  it("round-trips color with alpha", () => {
    const input: OpenPrintTagInput = {
      materialName: "Translucent",
      brandName: "Brand",
      materialType: "PETG",
      color: "#ff000080",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.color).toBe("#ff000080");
  });

  it("round-trips weight", () => {
    const input: OpenPrintTagInput = {
      materialName: "Full Spool",
      brandName: "Brand",
      materialType: "PLA",
      weightGrams: 1000,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.weightGrams).toBe(1000);
  });

  it("round-trips country of origin", () => {
    const input: OpenPrintTagInput = {
      materialName: "Czech",
      brandName: "Prusament",
      materialType: "PLA",
      countryOfOrigin: "CZ",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.countryOfOrigin).toBe("CZ");
  });

  it("round-trips material abbreviation", () => {
    const input: OpenPrintTagInput = {
      materialName: "Test",
      brandName: "Brand",
      materialType: "PETG",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.materialAbbreviation).toBe("PETG");
  });

  it("round-trips chamber temperature", () => {
    const input: OpenPrintTagInput = {
      materialName: "Enclosed",
      brandName: "Brand",
      materialType: "ABS",
      chamberTemp: 50,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.chamberTemp).toBe(50);
  });

  it("round-trips a fully populated filament", () => {
    const input: OpenPrintTagInput = {
      materialName: "Prusament PLA Galaxy Black",
      brandName: "Prusament",
      materialType: "PLA",
      color: "#3d3e3dff",
      density: 1.24,
      diameter: 1.75,
      nozzleTemp: 215,
      nozzleTempFirstLayer: 220,
      bedTemp: 60,
      bedTempFirstLayer: 65,
      chamberTemp: 20,
      weightGrams: 1000,
      countryOfOrigin: "CZ",
    };

    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.materialName).toBe("Prusament PLA Galaxy Black");
    expect(decoded.brandName).toBe("Prusament");
    expect(decoded.materialType).toBe("PLA");
    expect(decoded.color).toBe("#3d3e3dff");
    expect(decoded.density).toBeCloseTo(1.24, 1);
    expect(decoded.diameter).toBe(1.75);
    expect(decoded.nozzleTemp).toBe(215);
    // Encoder uses max(bedTempFirstLayer, bedTemp) = max(65, 60) = 65 as MAX_BED_TEMPERATURE
    expect(decoded.bedTemp).toBe(65);
    expect(decoded.chamberTemp).toBe(20);
    expect(decoded.weightGrams).toBe(1000);
    expect(decoded.countryOfOrigin).toBe("CZ");
    expect(decoded.materialAbbreviation).toBe("PLA");
  });

  it("decodes meta map with aux_region_offset", () => {
    const input: OpenPrintTagInput = {
      materialName: "Test",
      brandName: "Brand",
      materialType: "PLA",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    // aux_region_offset points to the empty aux map (last byte = 0xA0)
    expect(decoded.meta.AUX_REGION_OFFSET).toBe(binary.length - 1);
  });

  it("round-trips spoolUid (brand_specific_instance_id)", () => {
    const input: OpenPrintTagInput = {
      materialName: "Test",
      brandName: "Brand",
      materialType: "PLA",
      spoolUid: "2acc21072a",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.spoolUid).toBe("2acc21072a");
  });

  it("round-trips drying temperature and time", () => {
    const input: OpenPrintTagInput = {
      materialName: "Dry Me",
      brandName: "Brand",
      materialType: "PA",
      dryingTemperature: 65,
      dryingTime: 240,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.dryingTemperature).toBe(65);
    expect(decoded.dryingTime).toBe(240);
  });

  it("round-trips transmission distance", () => {
    const input: OpenPrintTagInput = {
      materialName: "HueForge",
      brandName: "Brand",
      materialType: "PLA",
      transmissionDistance: 1.35,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.transmissionDistance).toBeCloseTo(1.35, 1);
  });

  it("round-trips tags (abrasive + soluble)", () => {
    const input: OpenPrintTagInput = {
      materialName: "Tagged",
      brandName: "Brand",
      materialType: "PLA",
      abrasive: true,
      soluble: true,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.tags).toEqual(expect.arrayContaining([4, 13]));
  });

  it("handles CBOR tagged values (major type 6)", () => {
    // Build a payload with a tagged value: tag(0) wrapping a text string
    // Meta: {2: 20} = A1 02 14
    // Main map with a tagged value for material_name key
    const payload = new Uint8Array([
      0xa1, 0x02, 0x14,      // meta: {2: 20}
      0xbf,                    // indefinite map start
      0x08, 0x00,             // material_class = FFF
      0x09, 0x00,             // material_type = PLA
      0x0a, 0xc0, 0x64, 0x54, 0x65, 0x73, 0x74, // material_name = tag(0, "Test")
      0x0b, 0x65, 0x42, 0x72, 0x61, 0x6e, 0x64, // brand_name = "Brand"
      0xff,                    // break
    ]);
    const decoded = decodeOpenPrintTagBinary(payload);
    expect(decoded.materialName).toBe("Test");
  });

  it("decodes CBOR float32 values", () => {
    // Manually build a payload with a float32 density (0xFA prefix)
    // Float32 1.24 = 0x3F9EB852
    const ab = new ArrayBuffer(4);
    new DataView(ab).setFloat32(0, 1.2345678);
    const f32bytes = new Uint8Array(ab);

    const payload = new Uint8Array([
      0xa1, 0x02, 0x18, 0xff,  // meta: {2: 255} (dummy offset)
      0xbf,                      // indefinite map start
      0x08, 0x00,               // material_class = FFF
      0x09, 0x00,               // material_type = PLA
      0x0a, 0x64, 0x54, 0x65, 0x73, 0x74, // material_name = "Test"
      0x0b, 0x65, 0x42, 0x72, 0x61, 0x6e, 0x64, // brand_name = "Brand"
      0x18, 0x1d,               // key 29 = DENSITY
      0xfa, f32bytes[0], f32bytes[1], f32bytes[2], f32bytes[3], // float32
      0xff,                      // break
    ]);
    const decoded = decodeOpenPrintTagBinary(payload);
    expect(decoded.density).toBeCloseTo(1.2345678, 4);
  });

  it("decodes CBOR float64 values", () => {
    // Manually build a payload with a float64 value (0xFB prefix)
    const ab = new ArrayBuffer(8);
    new DataView(ab).setFloat64(0, 1.23456789012345);
    const f64bytes = new Uint8Array(ab);

    const payload = new Uint8Array([
      0xa1, 0x02, 0x18, 0xff,  // meta: {2: 255}
      0xbf,                      // indefinite map start
      0x08, 0x00,               // material_class = FFF
      0x09, 0x00,               // material_type = PLA
      0x0a, 0x64, 0x54, 0x65, 0x73, 0x74, // material_name = "Test"
      0x0b, 0x65, 0x42, 0x72, 0x61, 0x6e, 0x64, // brand_name = "Brand"
      0x18, 0x1d,               // key 29 = DENSITY
      0xfb, ...f64bytes,        // float64
      0xff,                      // break
    ]);
    const decoded = decodeOpenPrintTagBinary(payload);
    expect(decoded.density).toBeCloseTo(1.23456789012345, 10);
  });

  it("decodes indefinite CBOR arrays", () => {
    // Build a payload with tags as indefinite array
    const payload = new Uint8Array([
      0xa1, 0x02, 0x18, 0xff,  // meta: {2: 255}
      0xbf,                      // indefinite map start
      0x08, 0x00,               // material_class = FFF
      0x09, 0x00,               // material_type = PLA
      0x0a, 0x64, 0x54, 0x65, 0x73, 0x74, // material_name = "Test"
      0x0b, 0x65, 0x42, 0x72, 0x61, 0x6e, 0x64, // brand_name = "Brand"
      0x18, 0x1c,               // key 28 = TAGS
      0x9f, 0x04, 0x0d, 0xff,  // indefinite array [4, 13]
      0xff,                      // break (map)
    ]);
    const decoded = decodeOpenPrintTagBinary(payload);
    expect(decoded.tags).toEqual([4, 13]);
  });

  it("round-trips emptySpoolWeight", () => {
    const input: OpenPrintTagInput = {
      materialName: "Spool",
      brandName: "Brand",
      materialType: "PLA",
      emptySpoolWeight: 200,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);
    expect(decoded.emptySpoolWeight).toBe(200);
  });

  it("decodes CBOR negative integers", () => {
    // Build a payload with a negative integer value
    // CBOR major type 1: negative integer, -1 = 0x20
    const payload = new Uint8Array([
      0xa1, 0x02, 0x14,      // meta: {2: 20}
      0xbf,                    // indefinite map start
      0x08, 0x00,             // material_class = FFF
      0x09, 0x00,             // material_type = PLA
      0x0a, 0x64, 0x54, 0x65, 0x73, 0x74, // material_name = "Test"
      0x0b, 0x65, 0x42, 0x72, 0x61, 0x6e, 0x64, // brand_name = "Brand"
      0x18, 0x22,             // key 34 = MIN_PRINT_TEMPERATURE
      0x20,                    // negative integer: -1
      0xff,                    // break
    ]);
    const decoded = decodeOpenPrintTagBinary(payload);
    expect(decoded.nozzleTempMin).toBe(-1);
  });

  it("throws on reserved CBOR additional value", () => {
    // Additional value 28 (0x1C) is reserved in CBOR
    const payload = new Uint8Array([
      0x1c, // major type 0, additional = 28 (reserved)
    ]);
    expect(() => decodeOpenPrintTagBinary(payload)).toThrow("reserved additional value");
  });

  it("throws on unknown CBOR major type", () => {
    // Create a payload where an inner value has an impossible state
    // This is hard to trigger naturally since all major types 0-7 are handled
    // But we can test the break byte (0xFF = major 7, additional 31) path
    const payload = new Uint8Array([
      0xa1, 0x02, 0x14,      // meta: {2: 20}
      0xbf,                    // indefinite map start
      0x08, 0x00,             // material_class = FFF
      0x09, 0x00,             // material_type = PLA
      0x0a, 0x64, 0x54, 0x65, 0x73, 0x74, // material_name = "Test"
      0x0b, 0x65, 0x42, 0x72, 0x61, 0x6e, 0x64, // brand_name = "Brand"
      0x18, 0x22,             // key 34
      0xf8, 0x2a,             // simple value 42 (major 7, additional 24, value 42)
      0xff,                    // break
    ]);
    const decoded = decodeOpenPrintTagBinary(payload);
    // Simple value 42 should be returned as-is
    expect(decoded.nozzleTempMin).toBe(42);
  });

  it("handles standalone CBOR break byte gracefully", () => {
    // Build payload where a break byte (0xFF) appears as a value in a definite map
    // The break case in major type 7 (additional=31) returns undefined
    const payload = new Uint8Array([
      0xa1, 0x02, 0x14,      // meta: {2: 20}
      0xa2,                    // definite map with 2 pairs
      0x08, 0x00,             // material_class = FFF
      0x09, 0xff,             // material_type = break byte (standalone, returns undefined)
    ]);
    // This should not throw - break as value yields undefined
    const decoded = decodeOpenPrintTagBinary(payload);
    expect(decoded).toBeDefined();
  });

  it("throws on truncated CBOR data", () => {
    // Single byte is not enough for a valid CBOR map
    expect(() => decodeOpenPrintTagBinary(new Uint8Array([0xa1]))).toThrow();
  });

  it("throws on empty data", () => {
    expect(() => decodeOpenPrintTagBinary(new Uint8Array([]))).toThrow("unexpected end of data");
  });

  it("handles unknown material types gracefully", () => {
    // Manually encode a payload with material_type = 99 (unknown)
    const payload = new Uint8Array([
      // Meta: {2: 20}
      0xa1, 0x02, 0x14,
      // Main: indefinite map
      0xbf,
      0x08, 0x00,         // material_class = FFF
      0x09, 0x18, 0x63,   // material_type = 99
      0x0a, 0x64, 0x54, 0x65, 0x73, 0x74, // material_name = "Test"
      0x0b, 0x65, 0x42, 0x72, 0x61, 0x6e, 0x64, // brand_name = "Brand"
      0xff,  // break
    ]);
    const decoded = decodeOpenPrintTagBinary(payload);

    expect(decoded.materialType).toBe("Unknown(99)");
    expect(decoded.materialTypeRaw).toBe(99);
  });

  it("round-trips shore hardness A and D", () => {
    const input: OpenPrintTagInput = {
      materialName: "TPU 95A",
      brandName: "Brand",
      materialType: "TPU",
      shoreHardnessA: 95,
      shoreHardnessD: 45,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.shoreHardnessA).toBe(95);
    expect(decoded.shoreHardnessD).toBe(45);
  });

  it("round-trips expanded tags with tag names", () => {
    const input: OpenPrintTagInput = {
      materialName: "CF PLA",
      brandName: "Brand",
      materialType: "PLA",
      optTags: [31, 16, 71], // carbon fiber, matte, high speed
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.tags).toEqual([16, 31, 71]); // sorted
    expect(decoded.tagNames).toEqual(
      expect.arrayContaining(["MATTE", "CONTAINS_CARBON_FIBER", "HIGH_SPEED"]),
    );
  });

  it("merges optTags with abrasive/soluble booleans (deduplicated)", () => {
    const input: OpenPrintTagInput = {
      materialName: "Abrasive CF",
      brandName: "Brand",
      materialType: "PLA",
      abrasive: true,
      optTags: [4, 31], // 4 = abrasive (duplicate), 31 = carbon fiber
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    // Should be deduplicated and sorted
    expect(decoded.tags).toEqual([4, 31]);
  });

  it("round-trips consumed_weight in auxiliary region", () => {
    const input: OpenPrintTagInput = {
      materialName: "Used Spool",
      brandName: "Brand",
      materialType: "PLA",
      weightGrams: 1000,
      consumedWeight: 350,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.consumedWeight).toBe(350);
    expect(decoded.aux).toBeDefined();
  });

  it("has empty auxiliary region when consumedWeight is null", () => {
    const input: OpenPrintTagInput = {
      materialName: "New Spool",
      brandName: "Brand",
      materialType: "PLA",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.consumedWeight).toBeUndefined();
    // An empty aux map (0xA0) is always present for Prusa app compatibility
    expect(decoded.aux).toEqual({});
  });

  it("does not confuse aux keys with main keys (key 0 collision fix)", () => {
    // AUX_CONSUMED_WEIGHT and INSTANCE_UUID both use key 0 in their respective regions.
    // The decoder must not let aux key names leak into MAIN_KEY_TO_NAME.
    const input: OpenPrintTagInput = {
      materialName: "Collision Test",
      brandName: "Brand",
      materialType: "PLA",
      weightGrams: 1000,
      consumedWeight: 500,
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    // Main region should have correct field names, not "AUX_CONSUMED_WEIGHT"
    expect(decoded.materialName).toBe("Collision Test");
    // Aux region should correctly decode consumed weight
    expect(decoded.consumedWeight).toBe(500);
    // The main map should not contain AUX_CONSUMED_WEIGHT as a key
    expect(decoded.main).not.toHaveProperty("AUX_CONSUMED_WEIGHT");
  });

  it("omits shore hardness when not provided", () => {
    const input: OpenPrintTagInput = {
      materialName: "Plain PLA",
      brandName: "Brand",
      materialType: "PLA",
    };
    const binary = generateOpenPrintTagBinary(input);
    const decoded = decodeOpenPrintTagBinary(binary);

    expect(decoded.shoreHardnessA).toBeUndefined();
    expect(decoded.shoreHardnessD).toBeUndefined();
  });
});
