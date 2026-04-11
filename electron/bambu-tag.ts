/**
 * Bambu Lab MIFARE Classic NFC tag decoder.
 *
 * Bambu Lab filament spools use MIFARE Classic 1K (ISO 14443-3A) tags with
 * encrypted sectors. Keys are derived from the tag UID via HKDF-SHA256.
 *
 * Reference: https://github.com/Bambu-Research-Group/RFID-Tag-Guide
 *
 * This module contains pure functions — no hardware dependency.
 */

import { hkdfSync } from "crypto";
import type { DecodedOpenPrintTag } from "../src/lib/openprinttag-decode";

// ── Key derivation ───────────────────────────────────────────────────

const BAMBU_MASTER_KEY = Buffer.from([
  0x9a, 0x75, 0x9c, 0xf2, 0xc4, 0xf7, 0xca, 0xff,
  0x22, 0x2c, 0xb9, 0x76, 0x9b, 0x41, 0xbc, 0x96,
]);

/**
 * Derive 16 MIFARE sector keys (6 bytes each) from a tag UID.
 * Mirrors the Python `deriveKeys.py` script using HKDF-SHA256.
 */
export function deriveBambuKeys(uid: Buffer): Buffer[] {
  // HKDF(digest, ikm, salt, info, keyLength)
  // Python: HKDF(uid, 6, master, SHA256, 16, context="RFID-A\0")
  //   → ikm=uid, salt=master, info="RFID-A\0", 16 keys of 6 bytes = 96 bytes
  const derived = Buffer.from(hkdfSync("sha256", uid, BAMBU_MASTER_KEY, "RFID-A\0", 96));
  const keys: Buffer[] = [];
  for (let i = 0; i < 16; i++) {
    keys.push(derived.subarray(i * 6, i * 6 + 6));
  }
  return keys;
}

// ── Block parsing ────────────────────────────────────────────────────

export interface BambuTagData {
  materialVariantId: string;
  materialId: string;
  filamentType: string;
  detailedFilamentType: string;
  colorRGBA: [number, number, number, number];
  spoolWeight: number;
  filamentDiameter: number;
  dryingTemp: number;
  dryingTime: number;        // hours
  bedTempType: number;
  bedTemp: number;
  maxHotendTemp: number;
  minHotendTemp: number;
  trayUid: string;
  spoolWidth: number;        // mm
  productionDate: string;
  filamentLength: number;    // meters
  colorCount: number;
  secondColorRGBA: [number, number, number, number] | null;
}

/** Read a null-trimmed ASCII string from a buffer region. */
function readString(buf: Buffer, start: number, length: number): string {
  let end = start + length;
  while (end > start && buf[end - 1] === 0) end--;
  return buf.subarray(start, end).toString("ascii");
}

/**
 * Parse raw MIFARE Classic blocks into structured Bambu tag data.
 * `blocks` is a sparse array indexed by absolute block number (0–63).
 * Sector trailers (blocks 3, 7, 11, ...) are excluded.
 */
export function parseBambuBlocks(blocks: (Buffer | undefined)[]): BambuTagData {
  const block = (n: number): Buffer => blocks[n] ?? Buffer.alloc(16);

  // Block 1: Material Variant ID (0-7) + Material ID (8-15)
  const b1 = block(1);
  const materialVariantId = readString(b1, 0, 8);
  const materialId = readString(b1, 8, 8);

  // Block 2: Filament Type (16 bytes)
  const filamentType = readString(block(2), 0, 16);

  // Block 4: Detailed Filament Type (16 bytes)
  const detailedFilamentType = readString(block(4), 0, 16);

  // Block 5: Color RGBA (0-3) + Spool Weight uint16 LE (4-5) + pad (6-7) + Diameter float32 LE (8-11)
  const b5 = block(5);
  const colorRGBA: [number, number, number, number] = [b5[0], b5[1], b5[2], b5[3]];
  const spoolWeight = b5.readUInt16LE(4);
  const filamentDiameter = b5.readFloatLE(8);

  // Block 6: Drying Temp (0-1) + Drying Time hours (2-3) + Bed Temp Type (4-5)
  //         + Bed Temp (6-7) + Max Hotend (8-9) + Min Hotend (10-11)
  const b6 = block(6);
  const dryingTemp = b6.readUInt16LE(0);
  const dryingTime = b6.readUInt16LE(2);
  const bedTempType = b6.readUInt16LE(4);
  const bedTemp = b6.readUInt16LE(6);
  const maxHotendTemp = b6.readUInt16LE(8);
  const minHotendTemp = b6.readUInt16LE(10);

  // Block 9: Tray UID (16 bytes)
  const trayUid = readString(block(9), 0, 16);

  // Block 10: pad (0-3) + Spool Width uint16 LE (4-5, ÷100 for mm)
  const b10 = block(10);
  const spoolWidth = b10.readUInt16LE(4) / 100;

  // Block 12: Production Date ASCII "YYYY_MM_DD_HH_MM"
  const productionDate = readString(block(12), 0, 16);

  // Block 14: pad (0-3) + Filament Length meters uint16 LE (4-5)
  const b14 = block(14);
  const filamentLength = b14.readUInt16LE(4);

  // Block 16: Format ID uint16 LE (0-1) + Color Count uint16 LE (2-3) + Second Color RGBA (4-7)
  const b16 = block(16);
  const formatId = b16.readUInt16LE(0);
  const colorCount = b16.readUInt16LE(2);
  const secondColorRGBA: [number, number, number, number] | null =
    formatId === 0x0002 && colorCount >= 2
      ? [b16[4], b16[5], b16[6], b16[7]]
      : null;

  return {
    materialVariantId, materialId, filamentType, detailedFilamentType,
    colorRGBA, spoolWeight, filamentDiameter,
    dryingTemp, dryingTime, bedTempType, bedTemp, maxHotendTemp, minHotendTemp,
    trayUid, spoolWidth, productionDate, filamentLength,
    colorCount, secondColorRGBA,
  };
}

// ── Mapping to DecodedOpenPrintTag ───────────────────────────────────

/** Map Bambu filament type string prefix to a canonical material type. */
const BAMBU_MATERIAL_MAP: Record<string, string> = {
  PLA: "PLA", PETG: "PETG", ABS: "ABS", ASA: "ASA",
  TPU: "TPU", PA: "PA", PC: "PC", PVA: "PVA",
  HIPS: "HIPS", PPA: "PPA", PET: "PET", PPS: "PPS",
  BVOH: "BVOH", EVA: "EVA",
};

function extractMaterialType(filamentType: string): string {
  // Bambu types look like "PLA Basic", "PETG HF", "TPU 95A", "PA6-CF", "PLA-CF"
  // Extract the base material by taking the first word, then stripping any
  // trailing digits/hyphens for compound names like "PA6" → "PA"
  const firstWord = filamentType.split(/[\s-]/)[0].toUpperCase();
  if (BAMBU_MATERIAL_MAP[firstWord]) return BAMBU_MATERIAL_MAP[firstWord];
  // Try stripping trailing digits: "PA6" → "PA"
  const stripped = firstWord.replace(/\d+$/, "");
  if (BAMBU_MATERIAL_MAP[stripped]) return BAMBU_MATERIAL_MAP[stripped];
  return firstWord; // fallback to raw
}

function rgbaToHex(rgba: [number, number, number, number]): string {
  const [r, g, b] = rgba;
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Convert parsed Bambu tag data to a DecodedOpenPrintTag for the rest of the app. */
export function bambuToDecodedTag(bambu: BambuTagData): DecodedOpenPrintTag {
  const materialName = bambu.detailedFilamentType || bambu.filamentType;
  const materialType = extractMaterialType(bambu.filamentType);

  return {
    meta: {},
    main: {},
    tagSource: "bambu",
    brandName: "Bambu Lab",
    materialName,
    materialType,
    materialAbbreviation: bambu.materialVariantId || undefined,
    color: rgbaToHex(bambu.colorRGBA),
    diameter: bambu.filamentDiameter > 0 ? bambu.filamentDiameter : undefined,
    nozzleTemp: bambu.maxHotendTemp > 0 ? bambu.maxHotendTemp : undefined,
    nozzleTempMin: bambu.minHotendTemp > 0 ? bambu.minHotendTemp : undefined,
    bedTemp: bambu.bedTemp > 0 ? bambu.bedTemp : undefined,
    weightGrams: bambu.spoolWeight > 0 ? bambu.spoolWeight : undefined,
    dryingTemperature: bambu.dryingTemp > 0 ? bambu.dryingTemp : undefined,
    dryingTime: bambu.dryingTime > 0 ? bambu.dryingTime * 60 : undefined, // hours → minutes
    spoolUid: bambu.trayUid || undefined,
    productionDate: bambu.productionDate || undefined,
    filamentLength: bambu.filamentLength > 0 ? bambu.filamentLength : undefined,
  };
}
