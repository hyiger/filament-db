/**
 * Mobile NFC service for OpenPrintTag read/write.
 *
 * Uses react-native-nfc-manager for ISO 15693 (NFC-V) tag access on iOS and Android.
 * The CBOR encoder/decoder and NDEF wrapper/parser come from @filament-db/shared.
 */

import { Platform } from "react-native";
import NfcManager, { NfcTech } from "react-native-nfc-manager";
import { parseNdefFromTag, wrapNdefForTag } from "@filament-db/shared/ndef";
import { decodeOpenPrintTagBinary } from "@filament-db/shared/openprinttag/decoder";
import { generateOpenPrintTagBinary } from "@filament-db/shared/openprinttag/encoder";
import type { OpenPrintTagInput } from "@filament-db/shared/openprinttag/encoder";
import type { DecodedOpenPrintTag } from "@filament-db/shared/openprinttag/decoder";

const BLOCK_SIZE = 4;
const DEFAULT_BLOCK_COUNT = 80; // SLIX2: 80 blocks × 4 bytes = 320 bytes

export { type DecodedOpenPrintTag, type OpenPrintTagInput };

class MobileNfcService {
  private _supported: boolean | null = null;

  /** Check if NFC is supported and enabled on this device. */
  async isSupported(): Promise<boolean> {
    if (this._supported !== null) return this._supported;
    try {
      this._supported = await NfcManager.isSupported();
      if (this._supported) {
        await NfcManager.start();
      }
    } catch {
      this._supported = false;
    }
    return this._supported;
  }

  /**
   * Read an OpenPrintTag from an NFC-V tag.
   *
   * Starts an NFC session, reads all blocks, parses NDEF, and decodes CBOR.
   * The session UI is handled by the OS (iOS shows "Ready to Scan", Android uses foreground dispatch).
   */
  async readTag(): Promise<DecodedOpenPrintTag> {
    try {
      // Request NFC-V technology
      if (Platform.OS === "ios") {
        await NfcManager.requestTechnology(NfcTech.Iso15693ICode);
      } else {
        await NfcManager.requestTechnology(NfcTech.NfcV);
      }

      // Read all blocks
      const raw = await this.readAllBlocks();

      // Parse NDEF and decode CBOR using shared library
      const cbor = parseNdefFromTag(raw);
      const decoded = decodeOpenPrintTagBinary(cbor);

      return decoded;
    } finally {
      await NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  }

  /**
   * Write an OpenPrintTag CBOR payload to an NFC-V tag.
   *
   * @param input - Filament data to encode
   * @param productUrl - Optional product URL for compatibility
   * @param onProgress - Optional callback for write progress
   */
  async writeTag(
    input: OpenPrintTagInput,
    productUrl?: string,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    try {
      // Generate CBOR binary from filament data
      const cbor = generateOpenPrintTagBinary(input);

      // Request NFC-V technology
      if (Platform.OS === "ios") {
        await NfcManager.requestTechnology(NfcTech.Iso15693ICode);
      } else {
        await NfcManager.requestTechnology(NfcTech.NfcV);
      }

      // Read block 0 to determine tag memory size
      const block0 = await this.readBlock(0);
      const mlen = block0[2]; // CC byte 2 = memory size / 8
      const tagMemorySize = mlen * 8;
      const numBlocks = Math.min(Math.ceil(tagMemorySize / BLOCK_SIZE), DEFAULT_BLOCK_COUNT);

      // Wrap CBOR in NDEF for tag
      const tagMemory = wrapNdefForTag(cbor, tagMemorySize, productUrl);

      // Write blocks
      for (let i = 0; i < numBlocks; i++) {
        const blockData = tagMemory.slice(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
        try {
          await this.writeBlock(i, blockData);
        } catch {
          // Block 79 on SLIX2 is write-protected — skip silently
          if (i === 79) continue;
          throw new Error(`Failed to write block ${i}`);
        }
        onProgress?.(Math.round(((i + 1) / numBlocks) * 100));
      }
    } finally {
      await NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  }

  /**
   * Write raw CBOR payload to tag (for pre-encoded data like from the API).
   */
  async writeRawCbor(
    cbor: Uint8Array,
    productUrl?: string,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    try {
      if (Platform.OS === "ios") {
        await NfcManager.requestTechnology(NfcTech.Iso15693ICode);
      } else {
        await NfcManager.requestTechnology(NfcTech.NfcV);
      }

      const block0 = await this.readBlock(0);
      const mlen = block0[2];
      const tagMemorySize = mlen * 8;
      const numBlocks = Math.min(Math.ceil(tagMemorySize / BLOCK_SIZE), DEFAULT_BLOCK_COUNT);

      const tagMemory = wrapNdefForTag(cbor, tagMemorySize, productUrl);

      for (let i = 0; i < numBlocks; i++) {
        const blockData = tagMemory.slice(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
        try {
          await this.writeBlock(i, blockData);
        } catch {
          if (i === 79) continue;
          throw new Error(`Failed to write block ${i}`);
        }
        onProgress?.(Math.round(((i + 1) / numBlocks) * 100));
      }
    } finally {
      await NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  }

  /**
   * Format (erase) an NFC-V tag.
   */
  async formatTag(onProgress?: (percent: number) => void): Promise<void> {
    try {
      if (Platform.OS === "ios") {
        await NfcManager.requestTechnology(NfcTech.Iso15693ICode);
      } else {
        await NfcManager.requestTechnology(NfcTech.NfcV);
      }

      const block0 = await this.readBlock(0);
      const mlen = block0[2];
      const numBlocks = Math.min(Math.ceil((mlen * 8) / BLOCK_SIZE), DEFAULT_BLOCK_COUNT);

      // Write CC
      await this.writeBlock(0, new Uint8Array([0xe1, 0x40, mlen, 0x01]));
      // TLV terminator
      await this.writeBlock(1, new Uint8Array([0xfe, 0x00, 0x00, 0x00]));

      // Zero remaining blocks
      const zeros = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      for (let i = 2; i < numBlocks; i++) {
        try {
          await this.writeBlock(i, zeros);
        } catch {
          if (i === 79) continue;
        }
        onProgress?.(Math.round(((i + 1) / numBlocks) * 100));
      }
    } finally {
      await NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  }

  // ── Low-level block operations ───────────────────────────────────

  private async readBlock(blockNumber: number): Promise<Uint8Array> {
    if (Platform.OS === "ios") {
      const result = await NfcManager.iso15693HandlerIOS.readSingleBlock({
        flags: 0x02, // High data rate
        blockNumber,
      });
      return new Uint8Array(result);
    } else {
      // Android NfcV: flags=0x02, cmd=0x20 (ReadSingleBlock), blockNumber
      const cmd = [0x02, 0x20, blockNumber];
      const result = await NfcManager.nfcVHandler.transceive(cmd);
      // Response: [flags_byte, ...data_bytes]
      return new Uint8Array(result.slice(1));
    }
  }

  private async writeBlock(blockNumber: number, data: Uint8Array): Promise<void> {
    if (Platform.OS === "ios") {
      await NfcManager.iso15693HandlerIOS.writeSingleBlock({
        flags: 0x02,
        blockNumber,
        dataBlock: Array.from(data),
      });
    } else {
      // Android NfcV: flags=0x02, cmd=0x21 (WriteSingleBlock), blockNumber, data
      const cmd = [0x02, 0x21, blockNumber, ...Array.from(data)];
      await NfcManager.nfcVHandler.transceive(cmd);
    }
  }

  private async readAllBlocks(): Promise<Uint8Array> {
    // Read block 0 to get CC and determine memory size
    const block0 = await this.readBlock(0);
    const mlen = block0[2]; // CC byte 2 = memory size / 8
    const numBlocks = Math.min(Math.ceil((mlen * 8) / BLOCK_SIZE), DEFAULT_BLOCK_COUNT);

    const raw = new Uint8Array(numBlocks * BLOCK_SIZE);
    raw.set(block0, 0);

    for (let i = 1; i < numBlocks; i++) {
      try {
        const block = await this.readBlock(i);
        raw.set(block, i * BLOCK_SIZE);
      } catch {
        // If a block read fails, fill with zeros and continue
        // (last block may be protected)
        break;
      }
    }

    return raw;
  }
}

/** Singleton NFC service instance */
export const nfcService = new MobileNfcService();
