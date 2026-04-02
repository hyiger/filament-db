import { describe, it, expect } from "vitest";
import { generateOpenPrintTagBinary, type OpenPrintTagInput } from "@/lib/openprinttag";
import { decodeOpenPrintTagBinary } from "@/lib/openprinttag-decode";
import { wrapNdefForTag, parseNdefFromTag } from "../electron/ndef";

/**
 * End-to-end round-trip tests:
 *   encode CBOR → wrap NDEF → parse NDEF → decode CBOR
 * Simulates the full NFC write→read cycle.
 */
describe("NFC round-trip: encode → NDEF wrap → NDEF parse → decode", () => {
  it("round-trips a minimal filament", () => {
    const input: OpenPrintTagInput = {
      materialName: "PLA Basic",
      brandName: "Generic",
      materialType: "PLA",
    };

    const cbor = generateOpenPrintTagBinary(input);
    const tagMemory = wrapNdefForTag(cbor, 320);
    const extracted = parseNdefFromTag(tagMemory);
    const decoded = decodeOpenPrintTagBinary(extracted);

    expect(decoded.materialName).toBe("PLA Basic");
    expect(decoded.brandName).toBe("Generic");
    expect(decoded.materialType).toBe("PLA");
  });

  it("round-trips a fully populated filament through tag memory", () => {
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

    const cbor = generateOpenPrintTagBinary(input);
    const tagMemory = wrapNdefForTag(cbor, 320);
    const extracted = parseNdefFromTag(tagMemory);
    const decoded = decodeOpenPrintTagBinary(extracted);

    expect(decoded.materialName).toBe("Prusament PLA Galaxy Black");
    expect(decoded.brandName).toBe("Prusament");
    expect(decoded.materialType).toBe("PLA");
    expect(decoded.color).toBe("#3d3e3dff");
    expect(decoded.density).toBeCloseTo(1.24, 1);
    expect(decoded.diameter).toBe(1.75);
    expect(decoded.nozzleTemp).toBe(215);
    expect(decoded.bedTemp).toBe(65);
    expect(decoded.chamberTemp).toBe(20);
    expect(decoded.weightGrams).toBe(1000);
    expect(decoded.countryOfOrigin).toBe("CZ");
  });

  it("round-trips PCTG CF through tag memory", () => {
    const input: OpenPrintTagInput = {
      materialName: "3D-Fuel PCTG CF",
      brandName: "Spectrum",
      materialType: "PCTG",
      color: "#666666",
      density: 1.23,
      nozzleTemp: 245,
      bedTemp: 80,
      weightGrams: 750,
      countryOfOrigin: "US",
    };

    const cbor = generateOpenPrintTagBinary(input);
    const tagMemory = wrapNdefForTag(cbor, 320);
    const extracted = parseNdefFromTag(tagMemory);
    const decoded = decodeOpenPrintTagBinary(extracted);

    expect(decoded.materialName).toBe("3D-Fuel PCTG CF");
    expect(decoded.brandName).toBe("Spectrum");
    expect(decoded.materialType).toBe("PCTG");
    expect(decoded.materialTypeRaw).toBe(6);
    expect(decoded.color).toBe("#666666");
    expect(decoded.density).toBeCloseTo(1.23, 1);
    expect(decoded.nozzleTemp).toBe(245);
    expect(decoded.weightGrams).toBe(750);
    expect(decoded.countryOfOrigin).toBe("US");
  });

  it("CBOR payload fits in SLIX2 tag memory (320 bytes)", () => {
    const input: OpenPrintTagInput = {
      materialName: "A Very Long Material Name That Takes Up Space",
      brandName: "A Verbose Brand Name Inc.",
      materialType: "PETG",
      color: "#aabbccdd",
      density: 1.27,
      diameter: 2.85,
      nozzleTemp: 240,
      nozzleTempFirstLayer: 245,
      bedTemp: 85,
      bedTempFirstLayer: 90,
      chamberTemp: 40,
      weightGrams: 2000,
      countryOfOrigin: "DE",
    };

    const cbor = generateOpenPrintTagBinary(input);
    // NDEF overhead: CC(4) + TLV(2) + record header(~31) + terminator(1) ≈ 38 bytes
    expect(cbor.length + 38).toBeLessThan(320);

    // Should not throw
    const tagMemory = wrapNdefForTag(cbor, 320);
    expect(tagMemory.length).toBe(320);
  });
});

describe("writeTag block count optimization", () => {
  it("padded NDEF payload fills tag memory with aux region space", () => {
    const input: OpenPrintTagInput = {
      materialName: "Test",
      brandName: "Brand",
      materialType: "PLA",
    };

    const cbor = generateOpenPrintTagBinary(input);
    const tagMemory = wrapNdefForTag(cbor, 320);

    // The NDEF payload is padded to fill the tag, leaving the TLV terminator
    // near the end. This ensures the CBOR aux_region_offset points to
    // valid data within the NDEF payload (matching Prusa firmware behavior).
    expect(tagMemory.length).toBe(320);

    // Find the TLV terminator (0xFE) — it should be near the end
    let terminatorIdx = -1;
    for (let i = tagMemory.length - 1; i >= 0; i--) {
      if (tagMemory[i] === 0xfe) {
        terminatorIdx = i;
        break;
      }
    }
    // Terminator should be in the last few bytes (after padded NDEF + zeros)
    expect(terminatorIdx).toBeGreaterThan(300);
  });

  it("terminator byte (0xFE) is present in tag memory", () => {
    const input: OpenPrintTagInput = {
      materialName: "Test",
      brandName: "Brand",
      materialType: "PLA",
    };

    const cbor = generateOpenPrintTagBinary(input);
    const tagMemory = wrapNdefForTag(cbor, 320);

    // Find last non-zero byte
    let lastDataByte = 0;
    for (let i = tagMemory.length - 1; i >= 0; i--) {
      if (tagMemory[i] !== 0x00) {
        lastDataByte = i;
        break;
      }
    }

    expect(tagMemory[lastDataByte]).toBe(0xfe); // TLV terminator
  });
});
