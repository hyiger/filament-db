#!/usr/bin/env npx tsx
/**
 * DEV WRITE HARNESS — flash a blank NTAG (213/215/216) with a synthetic
 * OpenTag3D tag so the OpenTag3D READ path (#864) can be tested without owning a
 * commercial OpenTag3D spool.
 *
 * THIS IS NOT A PRODUCT WRITE FEATURE. Product OpenTag3D write is Phase 2; this
 * script exists only to produce a test tag. It writes an NFC-Forum Type 2 image:
 * a Type-2 Capability Container at page 3 and an NDEF message (one
 * `application/opentag3d` media record) from page 4, via the PC/SC UPDATE BINARY
 * pseudo-APDU (FF D6) on an ACR1552U.
 *
 * Usage:
 *   npx tsx scripts/write-opentag3d-tag.ts
 *   npx tsx scripts/write-opentag3d-tag.ts --material PETG --mod CF \
 *       --brand "Polar Filament" --color "#1E90FF" --name "Sky Blue" \
 *       --print-temp 240 --bed-temp 80 --diameter 1.75
 *   npx tsx scripts/write-opentag3d-tag.ts --core-only   # Core map only (NTAG213-sized)
 *   npx tsx scripts/write-opentag3d-tag.ts --ntag 215    # required to format a BLANK tag
 *                                                        # (a pre-formatted tag's CC is reused)
 *
 * Place a blank NTAG on the reader before or after running.
 */

import pcsclite from "@pokusew/pcsclite";
import {
  encodeOpenTag3D,
  OPENTAG3D_MIME,
  type Ot3dValue,
} from "../src/lib/opentag3d";
import {
  buildMediaNdefRecord,
  buildNdefMessageTlv,
  buildType2Cc,
  parseNdefRecords,
} from "../src/lib/ndef";
import { decodeFromNdefRecords } from "../src/lib/tagCodecs";

// NDEF-usable capacity (bytes) per NTAG family, i.e. CC byte-2 × 8.
const NTAG_NDEF_BYTES: Record<string, number> = { "213": 144, "215": 496, "216": 872 };

// ── CLI args ──
const argv = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const coreOnly = argv.includes("--core-only");
const ntagSize = arg("ntag"); // "213" | "215" | "216" — required only to format a BLANK tag

// Build the OpenTag3D field set from flags, with a complete sample default so a
// bare run still writes a meaningful, multi-field tag.
const hex = arg("color", "#1E90FF")!;
function hexToRgba(h: string) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(h.trim());
  if (!m) throw new Error(`Invalid --color hex: ${h}`);
  const v = m[1];
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
    a: 255,
  };
}

const fields: Record<string, Ot3dValue> = {
  tag_version: 1.0,
  material_base: arg("material", "PETG")!,
  material_mod: arg("mod", "")!,
  manufacturer: arg("brand", "Polar Filament")!,
  color_name: arg("name", "Sky Blue")!,
  color_1: hexToRgba(hex),
  target_diameter: Number(arg("diameter", "1.75")),
  target_weight: Number(arg("weight", "1000")),
  print_temp: Number(arg("print-temp", "240")),
  bed_temp: Number(arg("bed-temp", "80")),
  density: Number(arg("density", "1.27")),
  td: Number(arg("td", "10")),
};
if (!coreOnly) {
  Object.assign(fields, {
    serial: arg("serial", "TEST-0001")!,
    spool_core_diameter: 100,
    max_dry_temp: Number(arg("dry-temp", "65")),
    dry_time: Number(arg("dry-time", "6")),
    min_print_temp: Number(arg("min-print-temp", "230")),
    max_print_temp: Number(arg("max-print-temp", "250")),
    target_vso: Number(arg("vso", "15")),
  });
}
// Drop the empty modifier so it isn't written as a blank field.
if (!fields.material_mod) delete fields.material_mod;

const payload = encodeOpenTag3D(fields, { includeExtended: !coreOnly });
const ndefMessage = buildMediaNdefRecord(OPENTAG3D_MIME, payload);
const tlv = buildNdefMessageTlv(ndefMessage);

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
function checkSW(r: Buffer): boolean {
  return r.length >= 2 && r[r.length - 2] === 0x90 && r[r.length - 1] === 0x00;
}
async function readPages(reader: CardReader, protocol: number, startPage: number): Promise<Buffer> {
  const cmd = Buffer.from([0xff, 0xb0, 0x00, startPage, 0x10]);
  const resp = await transmit(reader, cmd, 20, protocol);
  if (!checkSW(resp)) throw new Error(`Read pages @${startPage} failed: SW=${resp.toString("hex")}`);
  return resp.subarray(0, resp.length - 2);
}
async function writePage(reader: CardReader, protocol: number, page: number, four: Buffer): Promise<void> {
  const cmd = Buffer.from([0xff, 0xd6, 0x00, page, 0x04, four[0], four[1], four[2], four[3]]);
  const resp = await transmit(reader, cmd, 10, protocol);
  if (!checkSW(resp)) throw new Error(`Write page ${page} failed: SW=${resp.toString("hex")}`);
}
function tryConnect(reader: CardReader): Promise<number | null> {
  return new Promise((resolve) => {
    reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, (err: unknown, protocol: number) => {
      resolve(err ? null : protocol);
    });
  });
}
function disconnect(reader: CardReader): Promise<void> {
  return new Promise((resolve) => reader.disconnect(reader.SCARD_LEAVE_CARD, () => resolve()));
}

async function writeTag(reader: CardReader, protocol: number): Promise<void> {
  // Read pages 0–3 → the Type-2 CC lives at page 3 (bytes 12–15).
  const head = await readPages(reader, protocol, 0);
  let ccSizeByte = head[14];
  if (head[12] !== 0xe1 || !ccSizeByte) {
    // Blank / unformatted tag has no CC telling us the chip size. Do NOT assume
    // NTAG215 — a smaller NTAG213 would get a too-large CC and the capacity
    // check below would pass, letting us write past the end of the chip. Require
    // the caller to declare the size with --ntag.
    const ndefBytes = ntagSize ? NTAG_NDEF_BYTES[ntagSize] : undefined;
    if (!ndefBytes) {
      throw new Error(
        "Blank/unformatted tag has no capability container — re-run with --ntag 213|215|216 to declare the chip size (or pre-format the tag).",
      );
    }
    ccSizeByte = Math.floor(ndefBytes / 8);
    console.log(
      `  Blank tag → writing an NTAG${ntagSize} capability container ` +
        `(E1 10 ${ccSizeByte.toString(16).padStart(2, "0")} 00, ${ndefBytes} NDEF bytes)`,
    );
    const cc = buildType2Cc(ndefBytes);
    await writePage(reader, protocol, 3, Buffer.from(cc));
    // Patch the in-memory head so the verification read below sees the NEW CC,
    // not the stale pre-format zero bytes (a false "Blank or unformatted"
    // verification failure otherwise) — Codex P2.
    Buffer.from(cc).copy(head, 12);
  } else {
    console.log(`  Existing CC: E1 10 ${ccSizeByte.toString(16).padStart(2, "0")} 00 (${ccSizeByte * 8} NDEF bytes)`);
  }

  const capacityBytes = ccSizeByte * 8;
  if (tlv.length > capacityBytes) {
    throw new Error(
      `NDEF message (${tlv.length} bytes) exceeds tag capacity (${capacityBytes}). ` +
        `Use --core-only or a larger NTAG.`,
    );
  }

  // Write the TLV (0x03 … NDEF message … 0xFE) from page 4, 4 bytes per page.
  console.log(`  Writing ${tlv.length}-byte NDEF message (payload ${payload.length} bytes) from page 4…`);
  for (let i = 0; i < tlv.length; i += 4) {
    const page = 4 + i / 4;
    const chunk = Buffer.alloc(4);
    Buffer.from(tlv).copy(chunk, 0, i, Math.min(i + 4, tlv.length));
    await writePage(reader, protocol, page, chunk);
  }
  console.log("  ✓ Write complete");

  // Verify: read back and decode through the registry.
  const total = 16 + capacityBytes;
  const image = Buffer.alloc(total);
  head.copy(image, 0);
  for (let page = 4, off = 16; off < total; page += 4, off += 16) {
    try {
      const burst = await readPages(reader, protocol, page);
      burst.copy(image, off, 0, Math.min(burst.length, total - off));
    } catch {
      break;
    }
  }
  const decoded = decodeFromNdefRecords(parseNdefRecords(image, 12));
  if (!decoded || decoded.tagSource !== "opentag3d") {
    throw new Error("Verification read did NOT decode as OpenTag3D");
  }
  console.log("\n═══ Verified OpenTag3D read-back ═══");
  console.log(`  material:  ${decoded.materialName ?? decoded.materialType ?? "?"}`);
  console.log(`  brand:     ${decoded.brandName ?? "?"}`);
  console.log(`  color:     ${decoded.color ?? "?"}  (${decoded.colorName ?? "?"})`);
  console.log(`  nozzle:    ${decoded.nozzleTemp ?? "?"}°C   bed: ${decoded.bedTemp ?? "?"}°C`);
  console.log(`  diameter:  ${decoded.diameter ?? "?"}mm`);
  if (decoded.aux) console.log(`  aux:       ${JSON.stringify(decoded.aux)}`);
}

async function main() {
  console.log("OpenTag3D dev write harness — place a blank NTAG on the reader.\n");
  const pcsc = pcsclite();
  pcsc.on("error", (err: Error) => {
    console.error("PC/SC error:", err.message);
    process.exit(1);
  });
  pcsc.on("reader", (reader: CardReader) => {
    console.log(`  Reader: ${reader.name}`);
    reader.on("error", (err: Error) => console.error("Reader error:", err.message));
    reader.on("status", async (status: { state: number }) => {
      const changes = reader.state ^ status.state;
      if (!(changes & reader.SCARD_STATE_PRESENT)) return;
      if (!(status.state & reader.SCARD_STATE_PRESENT)) return;
      await new Promise((r) => setTimeout(r, 500));
      const protocol = await tryConnect(reader);
      if (protocol === null) {
        console.error("  Could not connect to the tag.");
        return;
      }
      try {
        await writeTag(reader, protocol);
        console.log("\nDone. You can remove the tag.");
      } catch (err) {
        console.error("  ✗", err instanceof Error ? err.message : String(err));
      } finally {
        await disconnect(reader);
        process.exit(0);
      }
    });
  });
}

main();
