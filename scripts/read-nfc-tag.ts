#!/usr/bin/env npx tsx
/**
 * Read and decode an OpenPrintTag NFC tag using the ACR1552U reader.
 *
 * Usage:
 *   npx tsx scripts/read-nfc-tag.ts
 *   npx tsx scripts/read-nfc-tag.ts --raw          # also dump raw hex
 *   npx tsx scripts/read-nfc-tag.ts --save out.bin  # save raw tag image to file
 *
 * Place a tag on the reader before or after running the script.
 */

import pcsclite from "@pokusew/pcsclite";
import { parseNdefFromTag } from "../electron/ndef";
import { decodeOpenPrintTagBinary } from "../src/lib/openprinttag-decode";
import { OPT_KEY, OPT_TAG_TO_NAME } from "../src/lib/openprinttag";
import * as fs from "fs";

// Reverse lookup: CBOR key number → field name (for detecting unknown keys)
const MAIN_KEY_TO_NAME: Record<number, string> = {};
const META_KEYS = new Set(["MAIN_REGION_OFFSET", "MAIN_REGION_SIZE", "AUX_REGION_OFFSET", "AUX_REGION_SIZE"]);
for (const [name, key] of Object.entries(OPT_KEY)) {
  if (!META_KEYS.has(name)) {
    MAIN_KEY_TO_NAME[key] = name;
  }
}

const BLOCK_SIZE = 4;
const DEFAULT_BLOCK_COUNT = 80;

// ── Parse CLI args ──
const args = process.argv.slice(2);
const showRaw = args.includes("--raw");
const saveIdx = args.indexOf("--save");
const saveFile = saveIdx >= 0 ? args[saveIdx + 1] : null;

// ── PC/SC helpers ──

type PCSCLite = ReturnType<typeof pcsclite>;
type CardReader = Parameters<Extract<Parameters<PCSCLite["on"]>[1], (reader: unknown) => void>>[0];

function transmit(reader: CardReader, data: Buffer, maxLen: number, protocol: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    reader.transmit(data, maxLen, protocol, (err: unknown, resp: Buffer) => {
      if (err) return reject(new Error(`Transmit: ${err instanceof Error ? err.message : String(err)}`));
      resolve(resp);
    });
  });
}

function checkSW(response: Buffer): boolean {
  const len = response.length;
  return len >= 2 && response[len - 2] === 0x90 && response[len - 1] === 0x00;
}

async function readBlock(reader: CardReader, protocol: number, blockNum: number): Promise<Buffer> {
  const cmd = Buffer.from([0xff, 0xfb, 0x00, 0x00, 0x02, 0x20, blockNum]);
  const response = await transmit(reader, cmd, BLOCK_SIZE + 10, protocol);
  if (checkSW(response)) {
    return response.subarray(0, response.length - 2);
  }
  throw new Error(`Read block ${blockNum} failed: SW=${response.toString("hex")}`);
}

async function getUID(reader: CardReader, protocol: number): Promise<string> {
  const cmd = Buffer.from([0xff, 0xca, 0x80, 0x00, 0x00]);
  const response = await transmit(reader, cmd, 20, protocol);
  if (checkSW(response)) {
    // Response: 1 byte DSFID + 8 bytes UID (LSB first) + SW
    const uid = response.subarray(1, response.length - 2);
    return Array.from(uid).reverse().map(b => b.toString(16).padStart(2, "0")).join(":");
  }
  return "unknown";
}

function tryConnect(reader: CardReader): Promise<number | null> {
  return new Promise((resolve) => {
    reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, (err: unknown, protocol: number) => {
      if (err) return resolve(null);
      resolve(protocol);
    });
  });
}

function disconnect(reader: CardReader): Promise<void> {
  return new Promise((resolve) => {
    reader.disconnect(reader.SCARD_LEAVE_CARD, () => resolve());
  });
}

// ── NDEF analysis ──

function analyzeNdef(raw: Buffer): void {
  console.log("\n═══ NDEF Structure ═══");

  if (raw[0] !== 0xe1) {
    console.log("  ⚠ No valid CC (magic byte not 0xE1)");
    return;
  }

  const version = (raw[1] >> 4) & 0xf;
  const access = raw[1] & 0x0f;
  const mlen = raw[2];
  const features = raw[3];
  console.log(`  CC: magic=0xE1 version=${version}.0 access=0x${access.toString(16)} mlen=${mlen} (${mlen * 8} bytes) features=0x${features.toString(16).padStart(2, "0")}`);

  let offset = 4;

  while (offset < raw.length - 1) {
    const tlvTag = raw[offset++];
    if (tlvTag === 0xfe) {
      console.log(`  TLV Terminator at offset ${offset - 1}`);
      break;
    }
    if (tlvTag === 0x00) continue;

    let tlvLen: number;
    if (raw[offset] === 0xff) {
      offset++;
      tlvLen = (raw[offset] << 8) | raw[offset + 1];
      offset += 2;
    } else {
      tlvLen = raw[offset++];
    }

    if (tlvTag === 0x03) {
      console.log(`  NDEF TLV: length=${tlvLen}`);
      // Parse NDEF records
      const end = offset + tlvLen;
      let recNum = 0;
      while (offset < end) {
        recNum++;
        const flags = raw[offset++];
        const tnf = flags & 0x07;
        const mb = (flags >> 7) & 1;
        const me = (flags >> 6) & 1;
        const sr = (flags >> 4) & 1;
        const il = (flags >> 3) & 1;

        const typeLen = raw[offset++];
        let payloadLen: number;
        if (sr) { payloadLen = raw[offset++]; }
        else {
          payloadLen = (raw[offset] << 24) | (raw[offset + 1] << 16) | (raw[offset + 2] << 8) | raw[offset + 3];
          offset += 4;
        }
        let idLen = 0;
        if (il) { idLen = raw[offset++]; }

        const typeBytes = raw.subarray(offset, offset + typeLen);
        offset += typeLen;
        if (idLen) offset += idLen;

        const tnfNames = ["Empty", "Well-Known", "Media", "URI", "External", "Unknown", "Unchanged", "Reserved"];
        const typeStr = tnf === 1 ? `"${String.fromCharCode(...typeBytes)}"` : `"${typeBytes.toString()}"`;

        console.log(`    Record ${recNum}: TNF=${tnf} (${tnfNames[tnf]}) MB=${mb} ME=${me} SR=${sr}`);
        console.log(`      Type (${typeLen}B): ${typeStr}`);
        console.log(`      Payload: ${payloadLen} bytes`);

        if (tnf === 1 && typeBytes[0] === 0x55) {
          // URI record
          const prefixes: Record<number, string> = {
            0x00: "", 0x01: "http://www.", 0x02: "https://www.", 0x03: "http://", 0x04: "https://",
          };
          const prefix = prefixes[raw[offset]] ?? `[0x${raw[offset].toString(16)}]`;
          const uri = prefix + raw.subarray(offset + 1, offset + payloadLen).toString();
          console.log(`      URI: ${uri}`);
        }

        offset += payloadLen;
      }
    } else {
      console.log(`  TLV tag=0x${tlvTag.toString(16)} length=${tlvLen}`);
      offset += tlvLen;
    }
  }
}

// ── Main ──

async function main() {
  console.log("🔍 OpenPrintTag NFC Reader");
  console.log("  Place a tag on the ACR1552U reader...\n");

  const pcsc = pcsclite();

  pcsc.on("error", (err: Error) => {
    console.error("PC/SC error:", err.message);
    process.exit(1);
  });

  pcsc.on("reader", (reader: CardReader) => {
    console.log(`  Reader found: ${reader.name}`);

    reader.on("status", async (status: { atr?: Buffer; state: number }) => {
      const changes = reader.state ^ status.state;
      if (!(changes & reader.SCARD_STATE_PRESENT)) return;
      if (!(status.state & reader.SCARD_STATE_PRESENT)) return;

      // Tag detected — try to connect
      await new Promise(r => setTimeout(r, 500)); // brief settle time
      const protocol = await tryConnect(reader);
      if (!protocol && protocol !== 0) return;

      try {
        // Get UID
        const uid = await getUID(reader, protocol);
        console.log(`\n═══ Tag Detected ═══`);
        console.log(`  UID: ${uid}`);

        // Read CC to determine memory size
        const block0 = await readBlock(reader, protocol, 0);
        const mlen = block0[2];
        const numBlocks = Math.min(Math.ceil((mlen * 8) / BLOCK_SIZE), DEFAULT_BLOCK_COUNT);
        console.log(`  Memory: ${mlen * 8} bytes (${numBlocks} blocks)`);

        // Read all blocks
        const allData = Buffer.alloc(numBlocks * BLOCK_SIZE);
        block0.copy(allData, 0);

        for (let i = 1; i < numBlocks; i++) {
          try {
            const bd = await readBlock(reader, protocol, i);
            bd.copy(allData, i * BLOCK_SIZE);
          } catch {
            console.log(`  ⚠ Read failed at block ${i}, using ${i} blocks`);
            break;
          }
        }

        // Raw hex dump
        if (showRaw) {
          console.log("\n═══ Raw Tag Memory ═══");
          for (let i = 0; i < allData.length; i += 16) {
            const hex = Array.from(allData.subarray(i, Math.min(i + 16, allData.length)))
              .map(b => b.toString(16).padStart(2, "0"))
              .join(" ");
            const ascii = Array.from(allData.subarray(i, Math.min(i + 16, allData.length)))
              .map(b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")
              .join("");
            console.log(`  ${i.toString(16).padStart(4, "0")}:  ${hex.padEnd(48)}  ${ascii}`);
          }
        }

        // Save to file
        if (saveFile) {
          fs.writeFileSync(saveFile, allData);
          console.log(`\n  💾 Saved raw tag image to ${saveFile}`);
        }

        // Analyze NDEF structure
        analyzeNdef(allData);

        // Decode OpenPrintTag
        try {
          const cborPayload = parseNdefFromTag(allData);
          console.log(`\n═══ CBOR Payload ═══`);
          console.log(`  Size: ${cborPayload.length} bytes`);
          if (showRaw) {
            console.log(`  Hex: ${Array.from(cborPayload).map(b => b.toString(16).padStart(2, "0")).join(" ")}`);
          }

          const decoded = decodeOpenPrintTagBinary(cborPayload);
          console.log("\n═══ Decoded OpenPrintTag Data ═══");

          // Material info
          console.log("\n  ── Material ──");
          if (decoded.materialType != null) console.log(`  Material Type:  ${decoded.materialType} (enum ${decoded.materialTypeRaw})`);
          if (decoded.materialName) console.log(`  Material Name:  ${decoded.materialName}`);
          if (decoded.materialAbbreviation) console.log(`  Abbreviation:   ${decoded.materialAbbreviation}`);
          if (decoded.brandName) console.log(`  Brand:          ${decoded.brandName}`);
          if (decoded.countryOfOrigin) console.log(`  Country:        ${decoded.countryOfOrigin}`);

          // Physical properties
          console.log("\n  ── Physical Properties ──");
          if (decoded.density != null) console.log(`  Density:        ${decoded.density} g/cm³`);
          if (decoded.diameter != null) console.log(`  Diameter:       ${decoded.diameter} mm`);
          if (decoded.shoreHardnessA != null) console.log(`  Shore A:        ${decoded.shoreHardnessA}`);
          if (decoded.shoreHardnessD != null) console.log(`  Shore D:        ${decoded.shoreHardnessD}`);
          if (decoded.transmissionDistance != null) console.log(`  TD (HueForge):  ${decoded.transmissionDistance}`);

          // Color
          if (decoded.color) {
            console.log(`  Color:          ${decoded.color}`);
          }

          // Weight
          console.log("\n  ── Weight ──");
          if (decoded.weightGrams != null) console.log(`  Nominal Weight: ${decoded.weightGrams}g`);
          if (decoded.actualWeightGrams != null) console.log(`  Actual Weight:  ${decoded.actualWeightGrams}g`);
          if (decoded.emptySpoolWeight != null) console.log(`  Spool Weight:   ${decoded.emptySpoolWeight}g`);

          // Temperatures
          console.log("\n  ── Temperatures ──");
          if (decoded.nozzleTempMin != null) console.log(`  Nozzle Min:     ${decoded.nozzleTempMin}°C`);
          if (decoded.nozzleTemp != null) console.log(`  Nozzle Max:     ${decoded.nozzleTemp}°C`);
          if (decoded.preheatTemp != null) console.log(`  Preheat:        ${decoded.preheatTemp}°C`);
          if (decoded.bedTempMin != null) console.log(`  Bed Min:        ${decoded.bedTempMin}°C`);
          if (decoded.bedTemp != null) console.log(`  Bed Max:        ${decoded.bedTemp}°C`);
          if (decoded.chamberTemp != null) console.log(`  Chamber:        ${decoded.chamberTemp}°C`);
          if (decoded.dryingTemperature != null) console.log(`  Drying Temp:    ${decoded.dryingTemperature}°C`);
          if (decoded.dryingTime != null) console.log(`  Drying Time:    ${decoded.dryingTime} min`);

          // Tags
          if (decoded.tags && decoded.tags.length > 0) {
            const tagStrs = decoded.tags.map((t: number) => OPT_TAG_TO_NAME[t] ?? `tag_${t}`);
            console.log(`\n  ── Tags ──`);
            console.log(`  Tags:           ${tagStrs.join(", ")}`);
          }

          // Identity
          if (decoded.spoolUid) {
            console.log("\n  ── Identity ──");
            console.log(`  Instance ID:    ${decoded.spoolUid}`);
          }

          // Show all raw main map keys for debugging
          const knownKeys = new Set(Object.values(MAIN_KEY_TO_NAME));
          const unknownEntries = Object.entries(decoded.main).filter(([k]) => !knownKeys.has(k));
          if (unknownEntries.length > 0) {
            console.log("\n  ── Additional Fields ──");
            for (const [k, v] of unknownEntries) {
              console.log(`  ${k}: ${v}`);
            }
          }

          // Consumed weight (aux region)
          if (decoded.consumedWeight != null) {
            console.log(`\n  Consumed:       ${decoded.consumedWeight}g`);
          }

        } catch (err) {
          console.log(`\n  ⚠ Failed to decode OpenPrintTag: ${err instanceof Error ? err.message : err}`);
          console.log("  The tag may not contain OpenPrintTag data.");
        }

      } catch (err) {
        console.error(`\n  ✗ Error: ${err instanceof Error ? err.message : err}`);
      } finally {
        await disconnect(reader);
      }

      console.log("\n  Remove tag and place another, or press Ctrl+C to exit.\n");
    });

    reader.on("error", (err: Error) => {
      if (!err.message.includes("Card was reset") && !err.message.includes("SCARD_W_RESET_CARD")) {
        console.error(`  Reader error: ${err.message}`);
      }
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
