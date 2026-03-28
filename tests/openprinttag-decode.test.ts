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

    expect(decoded.meta.AUX_REGION_OFFSET).toBe(binary.length);
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
});
