/**
 * NFC reader/writer service for ACR1552U via PC/SC.
 *
 * On macOS, SCardConnect SHARED mode fails for ISO 15693/NFC-V tags.
 * We use SCARD_SHARE_DIRECT mode and send pseudo-APDUs via SCardTransmit
 * with SCARD_PROTOCOL_UNDEFINED (protocol=0).
 *
 * The ACR1552U's Pass Through command (FF FB) wraps ISO 15693 commands.
 *
 * Reference: REF-ACR1552U-Series-1.07.pdf, section 5.3.4.2
 */

import { EventEmitter } from "events";
import pcsclite from "@pokusew/pcsclite";
import { wrapNdefForTag, parseNdefFromTag } from "./ndef";
import { decodeOpenPrintTagBinary, type DecodedOpenPrintTag } from "../src/lib/openprinttag-decode";

export interface NfcStatus {
  readerConnected: boolean;
  readerName: string | null;
  tagPresent: boolean;
  tagUid: string | null;
}

const BLOCK_SIZE = 4;
const DEFAULT_BLOCK_COUNT = 80;

export class NfcService extends EventEmitter {
  private pcsc: any;
  private pcscReader: any = null;
  private status: NfcStatus = {
    readerConnected: false,
    readerName: null,
    tagPresent: false,
    tagUid: null,
  };

  constructor() {
    super();
    this.pcsc = pcsclite();

    this.pcsc.on("reader", (reader: any) => {
      this.pcscReader = reader;
      this.updateStatus({ readerConnected: true, readerName: reader.name });

      reader.on("status", (status: any) => {
        const changes = reader.state ^ status.state;
        if (!changes) return;
        const isPresent = !!(status.state & reader.SCARD_STATE_PRESENT);
        const isEmpty = !!(status.state & reader.SCARD_STATE_EMPTY);
        if (isPresent && !this.status.tagPresent) {
          this.updateStatus({ tagPresent: true, tagUid: null });
        } else if (isEmpty && this.status.tagPresent) {
          this.updateStatus({ tagPresent: false, tagUid: null });
        }
      });

      reader.on("end", () => {
        this.pcscReader = null;
        this.updateStatus({ readerConnected: false, readerName: null, tagPresent: false, tagUid: null });
      });

      reader.on("error", (err: Error) => this.emit("error", err));
    });

    this.pcsc.on("error", (err: Error) => {
      if (!err.message?.includes("SCardListReaders")) this.emit("error", err);
    });
  }

  private updateStatus(partial: Partial<NfcStatus>): void {
    this.status = { ...this.status, ...partial };
    this.emit("statusChange", { ...this.status });
  }

  getStatus(): NfcStatus {
    return { ...this.status };
  }

  // ── Connection helpers ──────────────────────────────────────────

  /**
   * Connect to the reader. Tries multiple strategies:
   * 1. SHARED mode (works on Windows/Linux)
   * 2. DIRECT mode with protocol 0 (macOS fallback for ISO 15693)
   *
   * Returns the protocol to use for transmit.
   */
  private async connect(): Promise<number> {
    const reader = this.pcscReader;
    if (!reader) throw new Error("No NFC reader connected");

    // Strategy 1: SHARED mode
    try {
      const protocol: number = await new Promise((resolve, reject) => {
        reader.connect(
          { share_mode: reader.SCARD_SHARE_SHARED },
          (err: any, proto: number) => err ? reject(err) : resolve(proto),
        );
      });
      if (protocol != null && protocol > 0) return protocol;
    } catch {
      // Fall through to DIRECT
    }

    // Strategy 2: DIRECT mode (protocol=0 for pseudo-APDU via transmit)
    await new Promise<void>((resolve, reject) => {
      reader.connect(
        { share_mode: reader.SCARD_SHARE_DIRECT },
        (err: any) => err ? reject(new Error(`Connect failed: ${err.message}`)) : resolve(),
      );
    });

    return 0; // SCARD_PROTOCOL_UNDEFINED
  }

  private disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.pcscReader) return resolve();
      this.pcscReader.disconnect(this.pcscReader.SCARD_LEAVE_CARD, () => resolve());
    });
  }

  /**
   * Transmit APDU. For protocol=0 (DIRECT mode), we try both
   * SCardTransmit with protocol 0 and SCardControl with escape code.
   */
  private async transmit(data: Buffer, maxLen: number, protocol: number): Promise<Buffer> {
    const reader = this.pcscReader;

    if (protocol > 0) {
      // Normal SCardTransmit
      return new Promise((resolve, reject) => {
        reader.transmit(data, maxLen, protocol, (err: any, resp: Buffer) => {
          if (err) return reject(new Error(`Transmit: ${err.message}`));
          resolve(resp);
        });
      });
    }

    // DIRECT mode: try SCardTransmit with protocol 0
    try {
      const resp: Buffer = await new Promise((resolve, reject) => {
        reader.transmit(data, maxLen, 0, (err: any, resp: Buffer) => {
          if (err) return reject(err);
          resolve(resp);
        });
      });
      return resp;
    } catch {
      // Fall back to SCardControl
    }

    // Try SCardControl with multiple control codes
    const controlCodes = [
      reader.SCARD_CTL_CODE(3500),     // Standard escape
      reader.SCARD_CTL_CODE(2079),     // IOCTL_SMARTCARD_VENDOR_IFD_EXCHANGE (some drivers)
      0x42000DAC,                       // macOS: 0x42000000 + 3500
      0x42000000 + 2079,               // macOS: vendor IFD exchange
    ];

    for (const ctlCode of controlCodes) {
      try {
        const resp: Buffer = await new Promise((resolve, reject) => {
          reader.control(data, ctlCode, maxLen, (err: any, resp: Buffer) => {
            if (err) return reject(err);
            resolve(resp);
          });
        });
        return resp;
      } catch {
        continue;
      }
    }

    throw new Error("All transmit methods failed — reader may not support this command in DIRECT mode");
  }

  private checkSW(response: Buffer): boolean {
    const len = response.length;
    return len >= 2 && response[len - 2] === 0x90 && response[len - 1] === 0x00;
  }

  // ── Connection-scoped operations ────────────────────────────────

  private async withConnection<T>(fn: (protocol: number) => Promise<T>): Promise<T> {
    if (!this.pcscReader) throw new Error("No NFC reader connected");

    const protocol = await this.connect();

    try {
      return await fn(protocol);
    } finally {
      try { await this.disconnect(); } catch { /* */ }
    }
  }

  // ── ISO 15693 block operations ──────────────────────────────────

  /**
   * Build a PCSC 2.0 Part 3 Transparent Exchange APDU for ISO 15693.
   *
   * Format: FF C2 00 01 <Lc> <TLVs> 00
   * TLVs:
   *   90 02 00 00  — Transceive flags (CRC handled by reader)
   *   5F 46 04 <timeout_us_le32> — Timeout
   *   95 <len> <ISO15693 frame>  — Data to transceive
   */
  private buildTransparentExchange(iso15693Frame: Buffer): Buffer {
    const flagsTlv = Buffer.from([0x90, 0x02, 0x00, 0x00]);
    const timerTlv = Buffer.from([0x5f, 0x46, 0x04, 0xa0, 0x86, 0x01, 0x00]); // 100ms

    const transceiveTlv = Buffer.alloc(2 + iso15693Frame.length);
    transceiveTlv[0] = 0x95;
    transceiveTlv[1] = iso15693Frame.length;
    iso15693Frame.copy(transceiveTlv, 2);

    const cmdData = Buffer.concat([flagsTlv, timerTlv, transceiveTlv]);

    const apdu = Buffer.alloc(5 + cmdData.length + 1);
    apdu[0] = 0xff;
    apdu[1] = 0xc2;
    apdu[2] = 0x00;
    apdu[3] = 0x01; // Transparent Exchange
    apdu[4] = cmdData.length;
    cmdData.copy(apdu, 5);
    apdu[apdu.length - 1] = 0x00; // Le

    return apdu;
  }

  /**
   * Parse Transparent Exchange response.
   * Looks for TLV tag 0x97 (response data).
   * ISO 15693 response: flags(1) + data(N)
   */
  private parseTransparentResponse(response: Buffer): Buffer {
    let offset = 0;
    while (offset < response.length) {
      const tag = response[offset++];
      if (offset >= response.length) break;

      let len = response[offset++];
      if (len === 0x81) {
        len = response[offset++];
      }

      if (tag === 0x97 && offset + len <= response.length) {
        const value = response.subarray(offset, offset + len);
        // First byte of ISO 15693 response is flags — skip it
        if (value.length > 1 && (value[0] & 0x01) === 0) {
          // No error — return data after flags byte
          return Buffer.from(value.subarray(1));
        } else if (value.length > 0 && (value[0] & 0x01) !== 0) {
          throw new Error(`ISO 15693 error flag: 0x${value[0].toString(16)}`);
        }
        return Buffer.from(value);
      }

      offset += len;
    }

    throw new Error(`No response data in transparent exchange`);
  }

  private async readBlock(protocol: number, blockNum: number): Promise<Buffer> {
    // ISO 15693 Read Single Block: flags(02) cmd(20) block_num
    const iso15693Frame = Buffer.from([0x02, 0x20, blockNum]);

    // Pass Through via SCardTransmit (works when SHARED connect succeeded)
    if (protocol > 0) {
      const cmd = Buffer.from([0xff, 0xfb, 0x00, 0x00, 0x02, 0x20, blockNum]);
      const response = await this.transmit(cmd, BLOCK_SIZE + 10, protocol);
      if (this.checkSW(response)) {
        return response.subarray(0, response.length - 2);
      }
      throw new Error(`Read block ${blockNum} failed: SW=${response.toString("hex")}`);
    }

    // DIRECT mode fallback: Transparent Exchange
    const teCmd = this.buildTransparentExchange(iso15693Frame);
    const response = await this.transmit(teCmd, 50, protocol);
    return this.parseTransparentResponse(response);
  }

  private async writeBlock(protocol: number, blockNum: number, data: Buffer): Promise<void> {
    // ISO 15693 Write Single Block: flags(02) cmd(21) block_num data(4)
    const iso15693Frame = Buffer.from([
      0x02, 0x21, blockNum,
      data[0], data[1], data[2], data[3],
    ]);

    // Pass Through via SCardTransmit (works when SHARED connect succeeded)
    if (protocol > 0) {
      const cmd = Buffer.from([
        0xff, 0xfb, 0x00, 0x00, 0x06, 0x21, blockNum,
        data[0], data[1], data[2], data[3],
      ]);
      const response = await this.transmit(cmd, 10, protocol);
      if (this.checkSW(response)) return;
      throw new Error(`Write block ${blockNum} failed: SW=${response.toString("hex")}`);
    }

    // DIRECT mode fallback: Transparent Exchange
    const teCmd = this.buildTransparentExchange(iso15693Frame);
    const response = await this.transmit(teCmd, 50, protocol);
    this.parseTransparentResponse(response);
  }

  // ── High-level operations ───────────────────────────────────────

  async readTag(): Promise<DecodedOpenPrintTag> {
    return this.withConnection(async (protocol) => {
      const block0 = await this.readBlock(protocol, 0);
      const mlen = block0[2];
      const numBlocks = Math.min(Math.ceil((mlen * 8) / BLOCK_SIZE), DEFAULT_BLOCK_COUNT);

      const allData = Buffer.alloc(numBlocks * BLOCK_SIZE);
      block0.copy(allData, 0);

      for (let i = 1; i < numBlocks; i++) {
        try {
          const bd = await this.readBlock(protocol, i);
          bd.copy(allData, i * BLOCK_SIZE);
        } catch { break; }
      }

      const cborPayload = parseNdefFromTag(allData);
      return decodeOpenPrintTagBinary(cborPayload);
    });
  }

  async writeTag(cborPayload: Uint8Array): Promise<void> {
    return this.withConnection(async (protocol) => {
      const block0 = await this.readBlock(protocol, 0);
      const mlen = block0[2];
      const tagMemorySize = mlen * 8 || DEFAULT_BLOCK_COUNT * BLOCK_SIZE;

      const tagMemory = wrapNdefForTag(cborPayload, tagMemorySize);

      // Only write blocks up through the TLV terminator (0xFE), not the zero-padded tail.
      // The last block on SLIX2 tags (block 79) may be write-protected (config/password area).
      let lastDataByte = 0;
      for (let i = tagMemory.length - 1; i >= 0; i--) {
        if (tagMemory[i] !== 0x00) {
          lastDataByte = i;
          break;
        }
      }
      const numBlocks = Math.ceil((lastDataByte + 1) / BLOCK_SIZE);

      for (let i = 0; i < numBlocks; i++) {
        const offset = i * BLOCK_SIZE;
        const blockData = Buffer.alloc(BLOCK_SIZE);
        for (let j = 0; j < BLOCK_SIZE && offset + j < tagMemory.length; j++) {
          blockData[j] = tagMemory[offset + j];
        }
        await this.writeBlock(protocol, i, blockData);

        // Small delay for EEPROM programming time
        if (i < numBlocks - 1) {
          await new Promise(r => setTimeout(r, 10));
        }

        this.emit("writeProgress", {
          block: i, total: numBlocks,
          percent: Math.round(((i + 1) / numBlocks) * 100),
        });
      }
    });
  }

  destroy(): void {
    if (this.pcscReader) { try { this.pcscReader.close(); } catch { /* */ } }
    if (this.pcsc) { try { this.pcsc.close(); } catch { /* */ } }
  }
}
