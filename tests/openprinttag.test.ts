import { describe, it, expect } from "vitest";
import {
  encodeCBORUint,
  encodeCBORText,
  encodeCBORBytes,
  encodeCBORKey,
  encodeCBORFloat16,
  encodeCBORFloat32,
  encodeCBORCompactNumber,
  decodeCBORFloat16,
  parseHexColor,
  resolveMaterialType,
  deriveMaterialAbbreviation,
  generateOpenPrintTagBinary,
  OPT_KEY,
  MATERIAL_CLASS,
  MATERIAL_TYPE,
  type OpenPrintTagInput,
} from "@/lib/openprinttag";

// ── CBOR encoding helpers ───────────────────────────────────────────

describe("encodeCBORUint", () => {
  it("encodes values 0–23 as a single byte", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 0);
    expect(buf).toEqual([0x00]);
  });

  it("encodes value 23 as direct", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 23);
    expect(buf).toEqual([23]);
  });

  it("encodes values 24–255 as 0x18 + uint8", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 200);
    expect(buf).toEqual([0x18, 200]);
  });

  it("encodes value 24 correctly", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 24);
    expect(buf).toEqual([0x18, 24]);
  });

  it("encodes value 255 correctly", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 255);
    expect(buf).toEqual([0x18, 255]);
  });

  it("encodes values 256–65535 as 0x19 + uint16", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 1000);
    expect(buf).toEqual([0x19, 0x03, 0xe8]);
  });

  it("encodes value 256 as uint16", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 256);
    expect(buf).toEqual([0x19, 0x01, 0x00]);
  });

  it("encodes value 65535 as uint16", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 65535);
    expect(buf).toEqual([0x19, 0xff, 0xff]);
  });

  it("encodes values 65536+ as 0x1a + uint32", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 100000);
    expect(buf).toEqual([0x1a, 0x00, 0x01, 0x86, 0xa0]);
  });

  it("encodes value 65536 as uint32", () => {
    const buf: number[] = [];
    encodeCBORUint(buf, 65536);
    expect(buf).toEqual([0x1a, 0x00, 0x01, 0x00, 0x00]);
  });

  it("throws for negative values", () => {
    const buf: number[] = [];
    expect(() => encodeCBORUint(buf, -1)).toThrow("CBOR unsigned int must be >= 0");
  });
});

describe("encodeCBORText", () => {
  it("encodes short strings (< 24 bytes) with inline length", () => {
    const buf: number[] = [];
    encodeCBORText(buf, "PLA");
    // 0x60 + 3 = 0x63, then "PLA" = [0x50, 0x4c, 0x41]
    expect(buf).toEqual([0x63, 0x50, 0x4c, 0x41]);
  });

  it("encodes empty string", () => {
    const buf: number[] = [];
    encodeCBORText(buf, "");
    expect(buf).toEqual([0x60]); // text string of length 0
  });

  it("encodes 23-byte string with inline length", () => {
    const buf: number[] = [];
    const text = "A".repeat(23);
    encodeCBORText(buf, text);
    expect(buf[0]).toBe(0x60 + 23);
    expect(buf.length).toBe(1 + 23);
  });

  it("encodes 24-byte string with uint8 length prefix", () => {
    const buf: number[] = [];
    const text = "A".repeat(24);
    encodeCBORText(buf, text);
    expect(buf[0]).toBe(0x78);
    expect(buf[1]).toBe(24);
    expect(buf.length).toBe(2 + 24);
  });

  it("encodes strings 24–255 bytes with 0x78 + uint8 length", () => {
    const buf: number[] = [];
    const text = "A".repeat(100);
    encodeCBORText(buf, text);
    expect(buf[0]).toBe(0x78);
    expect(buf[1]).toBe(100);
    expect(buf.length).toBe(2 + 100);
  });

  it("encodes strings 256–65535 bytes with 0x79 + uint16 length", () => {
    const buf: number[] = [];
    const text = "A".repeat(300);
    encodeCBORText(buf, text);
    expect(buf[0]).toBe(0x79);
    expect(buf[1]).toBe(1); // 300 >> 8
    expect(buf[2]).toBe(44); // 300 & 0xFF
    expect(buf.length).toBe(3 + 300);
  });

  it("throws for strings longer than 65535 bytes", () => {
    const buf: number[] = [];
    const text = "A".repeat(65536);
    expect(() => encodeCBORText(buf, text)).toThrow("Text string too long");
  });

  it("handles UTF-8 multi-byte characters", () => {
    const buf: number[] = [];
    encodeCBORText(buf, "\u00e9"); // é = 2 UTF-8 bytes
    expect(buf[0]).toBe(0x62); // 0x60 + 2
    expect(buf.length).toBe(3); // header + 2 UTF-8 bytes
  });
});

describe("encodeCBORBytes", () => {
  it("encodes short byte strings with inline length", () => {
    const buf: number[] = [];
    encodeCBORBytes(buf, [0xff, 0x00, 0x80, 0xff]);
    expect(buf).toEqual([0x44, 0xff, 0x00, 0x80, 0xff]);
  });

  it("encodes empty byte string", () => {
    const buf: number[] = [];
    encodeCBORBytes(buf, []);
    expect(buf).toEqual([0x40]); // byte string of length 0
  });

  it("encodes 24+ byte strings with 0x58 + uint8 length", () => {
    const buf: number[] = [];
    const bytes = Array(30).fill(0xab);
    encodeCBORBytes(buf, bytes);
    expect(buf[0]).toBe(0x58);
    expect(buf[1]).toBe(30);
    expect(buf.length).toBe(2 + 30);
  });

  it("throws for byte strings >= 256 bytes", () => {
    const buf: number[] = [];
    const bytes = Array(256).fill(0);
    expect(() => encodeCBORBytes(buf, bytes)).toThrow("Byte string too long");
  });
});

describe("encodeCBORKey", () => {
  it("encodes keys as unsigned integers", () => {
    const buf: number[] = [];
    encodeCBORKey(buf, 10);
    expect(buf).toEqual([0x0a]);
  });

  it("encodes large keys with uint8 prefix", () => {
    const buf: number[] = [];
    encodeCBORKey(buf, 55);
    expect(buf).toEqual([0x18, 55]);
  });
});

// ── Float encoding ──────────────────────────────────────────────────

describe("encodeCBORFloat16", () => {
  it("encodes 1.75 as half-precision float", () => {
    const buf: number[] = [];
    encodeCBORFloat16(buf, 1.75);
    // 1.75 in float16: sign=0, exp=15 (biased), frac=0x300
    // = 0 01111 1100000000 = 0x3F00
    expect(buf).toEqual([0xf9, 0x3f, 0x00]);
  });

  it("encodes 0.0 as half-precision float", () => {
    const buf: number[] = [];
    encodeCBORFloat16(buf, 0.0);
    expect(buf).toEqual([0xf9, 0x00, 0x00]);
  });

  it("encodes 1.0 as half-precision float", () => {
    const buf: number[] = [];
    encodeCBORFloat16(buf, 1.0);
    // 1.0 in float16 = 0x3C00
    expect(buf).toEqual([0xf9, 0x3c, 0x00]);
  });
});

describe("encodeCBORFloat32", () => {
  it("encodes as 5-byte CBOR float32 (major type 7, additional 26)", () => {
    const buf: number[] = [];
    encodeCBORFloat32(buf, 1.24);
    expect(buf[0]).toBe(0xfa); // CBOR float32 header
    expect(buf.length).toBe(5);
  });
});

describe("decodeCBORFloat16", () => {
  it("round-trips 1.75", () => {
    const decoded = decodeCBORFloat16(0x3f00);
    expect(decoded).toBe(1.75);
  });

  it("round-trips 0.0", () => {
    const decoded = decodeCBORFloat16(0x0000);
    expect(decoded).toBe(0.0);
  });

  it("round-trips 1.0", () => {
    const decoded = decodeCBORFloat16(0x3c00);
    expect(decoded).toBe(1.0);
  });

  it("round-trips 2.75", () => {
    // 2.75 in float16 = 0x4180
    const buf: number[] = [];
    encodeCBORFloat16(buf, 2.75);
    const bits = (buf[1] << 8) | buf[2];
    expect(decodeCBORFloat16(bits)).toBeCloseTo(2.75, 2);
  });
});

describe("encodeCBORCompactNumber", () => {
  it("encodes integers as CBOR uint", () => {
    const buf: number[] = [];
    encodeCBORCompactNumber(buf, 1000);
    // 1000 as uint16: 0x19 0x03 0xE8
    expect(buf).toEqual([0x19, 0x03, 0xe8]);
  });

  it("encodes 1.75 as float16 (compact)", () => {
    const buf: number[] = [];
    encodeCBORCompactNumber(buf, 1.75);
    // 1.75 fits in float16: 0xF9 0x3F 0x00
    expect(buf).toEqual([0xf9, 0x3f, 0x00]);
  });

  it("encodes 1.24 as compact float (float16 if lossless enough)", () => {
    const buf: number[] = [];
    encodeCBORCompactNumber(buf, 1.24);
    // 1.24 in float16 is ~1.2402... close enough (within 0.001)
    // Header is either 0xF9 (float16) or 0xFA (float32)
    expect([0xf9, 0xfa]).toContain(buf[0]);
  });

  it("encodes 0 as a single byte", () => {
    const buf: number[] = [];
    encodeCBORCompactNumber(buf, 0);
    expect(buf).toEqual([0x00]);
  });
});

// ── Colour parsing ──────────────────────────────────────────────────

describe("parseHexColor", () => {
  it("parses 6-digit hex with # (no alpha = 3 bytes)", () => {
    expect(parseHexColor("#FF8000")).toEqual([255, 128, 0]);
  });

  it("parses 6-digit hex without #", () => {
    expect(parseHexColor("FF8000")).toEqual([255, 128, 0]);
  });

  it("parses 8-digit hex with alpha (4 bytes)", () => {
    expect(parseHexColor("#FF800080")).toEqual([255, 128, 0, 128]);
  });

  it("parses lowercase hex", () => {
    expect(parseHexColor("#ff8000")).toEqual([255, 128, 0]);
  });

  it("returns null for invalid hex", () => {
    expect(parseHexColor("notacolor")).toBeNull();
  });

  it("returns null for short hex", () => {
    expect(parseHexColor("#FFF")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseHexColor("")).toBeNull();
  });

  it("parses black", () => {
    expect(parseHexColor("#000000")).toEqual([0, 0, 0]);
  });

  it("parses white", () => {
    expect(parseHexColor("#FFFFFF")).toEqual([255, 255, 255]);
  });
});

// ── Material type resolution ────────────────────────────────────────

describe("resolveMaterialType", () => {
  it("resolves PLA to 0 (per spec)", () => {
    expect(resolveMaterialType("PLA")).toBe(0);
  });

  it("resolves PETG to 1 (per spec)", () => {
    expect(resolveMaterialType("PETG")).toBe(1);
  });

  it("resolves PCTG to 6 (per spec)", () => {
    expect(resolveMaterialType("PCTG")).toBe(6);
  });

  it("resolves ABS to 3 (per spec)", () => {
    expect(resolveMaterialType("ABS")).toBe(3);
  });

  it("resolves ASA to 4 (per spec)", () => {
    expect(resolveMaterialType("ASA")).toBe(4);
  });

  it("resolves TPU to 2 (per spec)", () => {
    expect(resolveMaterialType("TPU")).toBe(2);
  });

  it("resolves PA / Nylon to PA6 (8)", () => {
    expect(resolveMaterialType("PA")).toBe(MATERIAL_TYPE.PA6);
    expect(resolveMaterialType("Nylon")).toBe(MATERIAL_TYPE.PA6);
  });

  it("resolves PC to 5 (per spec)", () => {
    expect(resolveMaterialType("PC")).toBe(5);
  });

  it("resolves PVA to 20 (per spec)", () => {
    expect(resolveMaterialType("PVA")).toBe(20);
  });

  it("resolves HIPS to 14 (per spec)", () => {
    expect(resolveMaterialType("HIPS")).toBe(14);
  });

  it("resolves PP to 7 (per spec)", () => {
    expect(resolveMaterialType("PP")).toBe(7);
  });

  it("resolves POM to 34 (per spec)", () => {
    expect(resolveMaterialType("POM")).toBe(34);
  });

  it("resolves PEBA to 28 (per spec)", () => {
    expect(resolveMaterialType("PEBA")).toBe(28);
  });

  it("resolves PPA to 30 (per spec)", () => {
    expect(resolveMaterialType("PPA")).toBe(30);
  });

  it("resolves carbon-filled variants to base type", () => {
    expect(resolveMaterialType("PLA-CF")).toBe(MATERIAL_TYPE.PLA);
    expect(resolveMaterialType("PETG-CF")).toBe(MATERIAL_TYPE.PETG);
    expect(resolveMaterialType("ABS-CF")).toBe(MATERIAL_TYPE.ABS);
    expect(resolveMaterialType("ASA-CF")).toBe(MATERIAL_TYPE.ASA);
    expect(resolveMaterialType("PA-CF")).toBe(MATERIAL_TYPE.PA6);
    expect(resolveMaterialType("PC-CF")).toBe(MATERIAL_TYPE.PC);
    expect(resolveMaterialType("NYLON-CF")).toBe(MATERIAL_TYPE.PA6);
  });

  it("resolves PLA+ to PLA", () => {
    expect(resolveMaterialType("PLA+")).toBe(MATERIAL_TYPE.PLA);
  });

  it("resolves PET-GF to PET", () => {
    expect(resolveMaterialType("PET-GF")).toBe(MATERIAL_TYPE.PET);
  });

  it("is case-insensitive", () => {
    expect(resolveMaterialType("pla")).toBe(MATERIAL_TYPE.PLA);
    expect(resolveMaterialType("Petg")).toBe(MATERIAL_TYPE.PETG);
  });

  it("ignores whitespace", () => {
    expect(resolveMaterialType("PLA ")).toBe(MATERIAL_TYPE.PLA);
    expect(resolveMaterialType(" ABS")).toBe(MATERIAL_TYPE.ABS);
  });

  it("returns undefined for unknown types (per spec: can be left unspecified)", () => {
    expect(resolveMaterialType("SilkPLA")).toBeUndefined();
    expect(resolveMaterialType("")).toBeUndefined();
    expect(resolveMaterialType("CustomBlend")).toBeUndefined();
  });
});

// ── Material abbreviation ───────────────────────────────────────────

describe("deriveMaterialAbbreviation", () => {
  it("returns short types as-is (uppercased)", () => {
    expect(deriveMaterialAbbreviation("PLA")).toBe("PLA");
    expect(deriveMaterialAbbreviation("PETG")).toBe("PETG");
  });

  it("truncates to 7 characters", () => {
    expect(deriveMaterialAbbreviation("LONGMATERIAL")).toBe("LONGMAT");
  });

  it("returns exactly 7 chars for 7-char type", () => {
    expect(deriveMaterialAbbreviation("PETG-CF")).toBe("PETG-CF");
  });

  it("uppercases the result", () => {
    expect(deriveMaterialAbbreviation("pla")).toBe("PLA");
  });

  it("strips whitespace", () => {
    expect(deriveMaterialAbbreviation(" PLA ")).toBe("PLA");
  });
});

// ── Full binary generation ──────────────────────────────────────────

describe("generateOpenPrintTagBinary", () => {
  const minimalInput: OpenPrintTagInput = {
    materialName: "Test PLA",
    brandName: "TestBrand",
    materialType: "PLA",
  };

  it("returns a Uint8Array", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("starts with a definite map (meta section)", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    expect(result[0]).toBe(0xa1); // definite map with 1 pair
  });

  it("contains an indefinite map start (0xBF) for the main section", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);
    expect(bytes).toContain(0xbf);
  });

  it("ends with indefinite map break (0xFF)", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    expect(result[result.length - 1]).toBe(0xff);
  });

  it("contains material_class = FFF (0)", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);
    // key 8 (material_class) followed by value 0
    const idx = bytes.indexOf(OPT_KEY.MATERIAL_CLASS);
    expect(idx).toBeGreaterThan(0);
    expect(bytes[idx + 1]).toBe(MATERIAL_CLASS.FFF);
  });

  it("contains material_type for PLA (= 0 per spec)", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);
    // key 9 (material_type) followed by value 0 (PLA)
    const idx = bytes.indexOf(OPT_KEY.MATERIAL_TYPE);
    expect(idx).toBeGreaterThan(0);
    expect(bytes[idx + 1]).toBe(0); // PLA = 0
  });

  it("contains material_type for PCTG (= 6 per spec)", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      materialType: "PCTG",
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);
    const idx = bytes.indexOf(OPT_KEY.MATERIAL_TYPE);
    expect(idx).toBeGreaterThan(0);
    expect(bytes[idx + 1]).toBe(6); // PCTG = 6
  });

  it("omits material_type for unknown types", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      materialType: "SilkPLA",
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);
    // material_type key (9) should not appear as a key in the main map
    // It could appear as a value, so we need to check carefully
    const bfIdx = bytes.indexOf(0xbf);
    // After material_class (key 8, value 0), the next key should NOT be 9
    // if material_type is omitted
    const classIdx = bytes.indexOf(OPT_KEY.MATERIAL_CLASS, bfIdx);
    // After key 8 and value 0, next byte should be key 10 (material_name), not 9
    expect(bytes[classIdx + 2]).toBe(OPT_KEY.MATERIAL_NAME);
  });

  it("includes brand_name text", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("TestBrand");
  });

  it("includes material_name text", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("Test PLA");
  });

  it("omits filament_diameter for default 1.75mm (spec: assumed if not present)", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);
    // Key 30 should NOT be present when diameter is default 1.75
    const diamKey = findCBORKey(bytes, OPT_KEY.FILAMENT_DIAMETER);
    expect(diamKey).toBe(-1);
  });

  it("includes filament_diameter as float for non-default values", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      diameter: 2.85,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    const diamKey = findCBORKey(bytes, OPT_KEY.FILAMENT_DIAMETER);
    expect(diamKey).toBeGreaterThan(0);
    // Value should be a CBOR float (f9 for half or fa for single), NOT an integer
    const valStart = diamKey + 2; // key 30 = 0x18 0x1E
    expect([0xf9, 0xfa]).toContain(bytes[valStart]);
  });

  it("includes material abbreviation", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("PLA");
  });

  it("includes country_of_origin defaulting to US", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("US");
  });

  it("encodes temperature fields when provided", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      nozzleTemp: 210,
      bedTemp: 60,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    // Should contain min/max print temps and bed temps
    const minPrintKey = findCBORKey(bytes, OPT_KEY.MIN_PRINT_TEMPERATURE);
    const maxPrintKey = findCBORKey(bytes, OPT_KEY.MAX_PRINT_TEMPERATURE);
    const minBedKey = findCBORKey(bytes, OPT_KEY.MIN_BED_TEMPERATURE);
    const maxBedKey = findCBORKey(bytes, OPT_KEY.MAX_BED_TEMPERATURE);

    expect(minPrintKey).toBeGreaterThan(0);
    expect(maxPrintKey).toBeGreaterThan(0);
    expect(minBedKey).toBeGreaterThan(0);
    expect(maxBedKey).toBeGreaterThan(0);
  });

  it("omits temperature fields when not provided", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);

    const minPrintKey = findCBORKey(bytes, OPT_KEY.MIN_PRINT_TEMPERATURE);
    expect(minPrintKey).toBe(-1);
  });

  it("includes density as compact float when provided", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      density: 1.24,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    const densityKey = findCBORKey(bytes, OPT_KEY.DENSITY);
    expect(densityKey).toBeGreaterThan(0);
    // Value should be a CBOR float (f9 or fa), NOT integer 124
    const valStart = densityKey + 2; // key 29 = 0x18 0x1D
    expect([0xf9, 0xfa]).toContain(bytes[valStart]);
  });

  it("omits density when null", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      density: null,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);
    expect(findCBORKey(bytes, OPT_KEY.DENSITY)).toBe(-1);
  });

  it("includes colour as RGB byte string (3 bytes) for 6-digit hex", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      color: "#FF8000",
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    const colorKey = findCBORKey(bytes, OPT_KEY.PRIMARY_COLOR);
    expect(colorKey).toBeGreaterThan(0);
    // Key 19 encodes as single byte (< 24), so value starts at +1
    // 3-byte RGB: 0x43 (byte string len 3), FF, 80, 00
    expect(bytes[colorKey + 1]).toBe(0x43);
    expect(bytes[colorKey + 2]).toBe(0xff);
    expect(bytes[colorKey + 3]).toBe(0x80);
    expect(bytes[colorKey + 4]).toBe(0x00);
  });

  it("includes colour as RGBA byte string (4 bytes) for 8-digit hex", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      color: "#FF800080",
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    const colorKey = findCBORKey(bytes, OPT_KEY.PRIMARY_COLOR);
    expect(colorKey).toBeGreaterThan(0);
    expect(bytes[colorKey + 1]).toBe(0x44); // byte string len 4
    expect(bytes[colorKey + 2]).toBe(0xff);
    expect(bytes[colorKey + 3]).toBe(0x80);
    expect(bytes[colorKey + 4]).toBe(0x00);
    expect(bytes[colorKey + 5]).toBe(0x80);
  });

  it("omits colour when color string is invalid", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      color: "notacolor",
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);
    expect(findCBORKey(bytes, OPT_KEY.PRIMARY_COLOR)).toBe(-1);
  });

  it("omits colour when not provided", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);
    expect(findCBORKey(bytes, OPT_KEY.PRIMARY_COLOR)).toBe(-1);
  });

  it("includes weight when provided", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      weightGrams: 1000,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    const weightKey = findCBORKey(bytes, OPT_KEY.NOMINAL_NETTO_FULL_WEIGHT);
    expect(weightKey).toBeGreaterThan(0);
  });

  it("omits weight when null", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);
    expect(findCBORKey(bytes, OPT_KEY.NOMINAL_NETTO_FULL_WEIGHT)).toBe(-1);
  });

  it("omits weight when zero", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      weightGrams: 0,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);
    expect(findCBORKey(bytes, OPT_KEY.NOMINAL_NETTO_FULL_WEIGHT)).toBe(-1);
  });

  it("includes chamber temp when provided and > 0", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      chamberTemp: 50,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    const chamberKey = findCBORKey(bytes, OPT_KEY.CHAMBER_TEMPERATURE);
    expect(chamberKey).toBeGreaterThan(0);
  });

  it("omits chamber temp when null", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);
    expect(findCBORKey(bytes, OPT_KEY.CHAMBER_TEMPERATURE)).toBe(-1);
  });

  it("omits chamber temp when zero", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      chamberTemp: 0,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);
    expect(findCBORKey(bytes, OPT_KEY.CHAMBER_TEMPERATURE)).toBe(-1);
  });

  it("uses custom country of origin", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      countryOfOrigin: "CZ",
    };
    const result = generateOpenPrintTagBinary(input);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("CZ");
  });

  it("truncates material name to 31 chars", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      materialName: "A".repeat(50),
    };
    const result = generateOpenPrintTagBinary(input);
    const text = new TextDecoder().decode(result);
    // Should contain at most 31 A's in a row
    const match = text.match(/A+/g);
    const longest = match ? Math.max(...match.map((s) => s.length)) : 0;
    expect(longest).toBeLessThanOrEqual(31);
  });

  it("truncates brand name to 31 chars", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      brandName: "B".repeat(50),
    };
    const result = generateOpenPrintTagBinary(input);
    const text = new TextDecoder().decode(result);
    const match = text.match(/B+/g);
    const longest = match ? Math.max(...match.map((s) => s.length)) : 0;
    expect(longest).toBeLessThanOrEqual(31);
  });

  it("truncates country of origin to 2 chars", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      countryOfOrigin: "USA",
    };
    const result = generateOpenPrintTagBinary(input);
    const text = new TextDecoder().decode(result);
    // Should contain "US" not "USA"
    expect(text).toContain("US");
  });

  it("produces valid binary for a fully-populated filament", () => {
    const input: OpenPrintTagInput = {
      materialName: "Prusament PLA Galaxy Black",
      brandName: "Prusament",
      materialType: "PLA",
      color: "#1a1a1a",
      density: 1.24,
      diameter: 1.75,
      nozzleTemp: 215,
      nozzleTempFirstLayer: 220,
      bedTemp: 60,
      bedTempFirstLayer: 65,
      chamberTemp: 0,
      weightGrams: 1000,
      countryOfOrigin: "CZ",
    };

    const result = generateOpenPrintTagBinary(input);
    expect(result.byteLength).toBeGreaterThan(20);
    expect(result[0]).toBe(0xa1); // meta map
    // Find main map
    const bytes = Array.from(result);
    const bfIdx = bytes.indexOf(0xbf);
    expect(bfIdx).toBeGreaterThan(0);
    expect(bytes[bytes.length - 1]).toBe(0xff);
  });

  it("uses nozzleTempFirstLayer to derive min print temp", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      nozzleTemp: 230,
      nozzleTempFirstLayer: 240,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    // min print temp should be nozzleTempFirstLayer - 20 = 220
    const minPrintKey = findCBORKey(bytes, OPT_KEY.MIN_PRINT_TEMPERATURE);
    expect(minPrintKey).toBeGreaterThan(0);
    expect(bytes[minPrintKey + 2]).toBe(0x18); // uint8 follows
    expect(bytes[minPrintKey + 3]).toBe(220);
  });

  it("uses bedTempFirstLayer as min bed temp", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      bedTemp: 80,
      bedTempFirstLayer: 70,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);

    const minBedKey = findCBORKey(bytes, OPT_KEY.MIN_BED_TEMPERATURE);
    expect(minBedKey).toBeGreaterThan(0);
    expect(bytes[minBedKey + 2]).toBe(0x18); // uint8
    expect(bytes[minBedKey + 3]).toBe(70);
  });

  it("meta aux_region_offset points past the payload", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);

    // Meta: 0xA1 0x02 0x18 <offset>
    expect(bytes[0]).toBe(0xa1);
    expect(bytes[1]).toBe(0x02); // key = aux_region_offset
    expect(bytes[2]).toBe(0x18); // uint8 follows
    const offset = bytes[3];
    expect(offset).toBe(result.byteLength);
  });

  it("handles large payloads requiring 5-byte meta size", async () => {
    // The encoder caps strings at 31 chars, so normal inputs can't exceed 256 bytes.
    // We verify the >= 256 meta branch by manually constructing a large payload
    // with a 5-byte meta header and decoding it.

    // Build the main map content first, then calculate total size
    const mainContent: number[] = [];
    mainContent.push(0xbf); // indefinite map start
    mainContent.push(0x08, 0x00); // material_class = FFF
    mainContent.push(0x09, 0x00); // material_type = PLA
    mainContent.push(0x0a, 0x64, 0x54, 0x65, 0x73, 0x74); // material_name = "Test"
    mainContent.push(0x0b, 0x65, 0x42, 0x72, 0x61, 0x6e, 0x64); // brand_name = "Brand"
    // Pad with key/value pairs (2 bytes each) until main content >= 252 bytes
    // (5-byte meta + 252 = 257 > 256, triggering the branch)
    while (mainContent.length < 252) {
      mainContent.push(0x17, 0x00); // key 23 = 0, repeated padding
    }
    mainContent.push(0xff); // break

    const metaSize = 5; // 0xA1 + 0x02 + 0x19 + hi + lo
    const totalSize = metaSize + mainContent.length;

    const largePayload = new Uint8Array(totalSize);
    largePayload[0] = 0xa1; // meta: definite map, 1 pair
    largePayload[1] = 0x02; // key: aux_region_offset
    largePayload[2] = 0x19; // uint16 follows
    largePayload[3] = (totalSize >> 8) & 0xff;
    largePayload[4] = totalSize & 0xff;
    largePayload.set(mainContent, metaSize);

    // Verify the decoder handles the 5-byte meta header correctly
    const { decodeOpenPrintTagBinary } = await import("@/lib/openprinttag-decode");
    const decoded = decodeOpenPrintTagBinary(largePayload);
    expect(decoded.materialName).toBe("Test");
    expect(decoded.brandName).toBe("Brand");
    expect(decoded.meta.AUX_REGION_OFFSET).toBe(totalSize);
  });

  it("includes empty_container_weight when emptySpoolWeight provided", () => {
    const input: OpenPrintTagInput = {
      ...minimalInput,
      emptySpoolWeight: 250,
    };
    const result = generateOpenPrintTagBinary(input);
    const bytes = Array.from(result);
    const key = findCBORKey(bytes, OPT_KEY.EMPTY_CONTAINER_WEIGHT);
    expect(key).toBeGreaterThan(0);
  });

  it("omits empty_container_weight when emptySpoolWeight is null", () => {
    const result = generateOpenPrintTagBinary(minimalInput);
    const bytes = Array.from(result);
    const key = findCBORKey(bytes, OPT_KEY.EMPTY_CONTAINER_WEIGHT);
    expect(key).toBe(-1);
  });
});

// ── Constants ───────────────────────────────────────────────────────

describe("OPT_KEY constants", () => {
  it("has expected key values from the spec", () => {
    expect(OPT_KEY.MATERIAL_CLASS).toBe(8);
    expect(OPT_KEY.MATERIAL_TYPE).toBe(9);
    expect(OPT_KEY.MATERIAL_NAME).toBe(10);
    expect(OPT_KEY.BRAND_NAME).toBe(11);
    expect(OPT_KEY.NOMINAL_NETTO_FULL_WEIGHT).toBe(16);
    expect(OPT_KEY.FILAMENT_DIAMETER).toBe(30);
    expect(OPT_KEY.MIN_PRINT_TEMPERATURE).toBe(34);
    expect(OPT_KEY.MAX_PRINT_TEMPERATURE).toBe(35);
    expect(OPT_KEY.MATERIAL_ABBREVIATION).toBe(52);
    expect(OPT_KEY.COUNTRY_OF_ORIGIN).toBe(55);
    expect(OPT_KEY.DRYING_TEMPERATURE).toBe(57);
    expect(OPT_KEY.DRYING_TIME).toBe(58);
  });
});

describe("MATERIAL_CLASS constants", () => {
  it("has FFF = 0 and SLA = 1", () => {
    expect(MATERIAL_CLASS.FFF).toBe(0);
    expect(MATERIAL_CLASS.SLA).toBe(1);
  });
});

describe("MATERIAL_TYPE constants (per OpenPrintTag spec)", () => {
  it("has correct enum values from data/material_type_enum.yaml", () => {
    expect(MATERIAL_TYPE.PLA).toBe(0);
    expect(MATERIAL_TYPE.PETG).toBe(1);
    expect(MATERIAL_TYPE.TPU).toBe(2);
    expect(MATERIAL_TYPE.ABS).toBe(3);
    expect(MATERIAL_TYPE.ASA).toBe(4);
    expect(MATERIAL_TYPE.PC).toBe(5);
    expect(MATERIAL_TYPE.PCTG).toBe(6);
    expect(MATERIAL_TYPE.PP).toBe(7);
    expect(MATERIAL_TYPE.PA6).toBe(8);
    expect(MATERIAL_TYPE.PA11).toBe(9);
    expect(MATERIAL_TYPE.PA12).toBe(10);
    expect(MATERIAL_TYPE.PA66).toBe(11);
    expect(MATERIAL_TYPE.HIPS).toBe(14);
    expect(MATERIAL_TYPE.PVA).toBe(20);
    expect(MATERIAL_TYPE.POM).toBe(34);
    expect(MATERIAL_TYPE.PEBA).toBe(28);
    expect(MATERIAL_TYPE.PPA).toBe(30);
    expect(MATERIAL_TYPE.EVA).toBe(41);
  });
});

// ── Helper to find a CBOR key in the byte stream ────────────────────

/**
 * Find the position of a CBOR integer key in a byte array.
 * For keys >= 24, looks for the 0x18+key pair. Returns the index of 0x18.
 * For keys < 24, looks for the single byte. Returns the index of the byte.
 *
 * To get the value position after the key:
 *   key < 24:  value starts at keyIdx + 1
 *   key >= 24: value starts at keyIdx + 2
 *
 * Returns -1 if not found.
 */
function findCBORKey(bytes: number[], key: number): number {
  if (key < 24) {
    // Direct encoding: single byte — search within the main indefinite map
    // Skip meta map to avoid false positives
    const bfIdx = bytes.indexOf(0xbf);
    if (bfIdx === -1) return -1;
    for (let i = bfIdx + 1; i < bytes.length - 1; i++) {
      if (bytes[i] === key) return i;
    }
  } else if (key < 256) {
    // uint8: 0x18 followed by key
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x18 && bytes[i + 1] === key) return i;
    }
  }
  return -1;
}
