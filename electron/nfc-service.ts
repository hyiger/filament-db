/**
 * NFC reader/writer service for ACR1552U via PC/SC.
 *
 * On macOS, the built-in ifd-ccid.bundle and the ACS ifd-acsccid.bundle both
 * claim the reader, creating two PC/SC reader instances (e.g. "Reader(1)" and
 * "Reader(2)"). Only the ACS driver supports ISO 15693/NFC-V, so we try
 * SHARED connect on each reader instance and use whichever one succeeds.
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
  private readers: Map<string, any> = new Map();
  private activeReader: any = null;
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
      this.readers.set(reader.name, reader);
      console.log(`[NFC] Reader discovered: ${reader.name} (${this.readers.size} total)`);

      if (this.readers.size === 1) {
        this.updateStatus({ readerConnected: true, readerName: reader.name });
      }

      reader.on("status", (status: any) => {
        const changes = reader.state ^ status.state;
        if (!changes) return;
        const isPresent = !!(status.state & reader.SCARD_STATE_PRESENT);
        const isEmpty = !!(status.state & reader.SCARD_STATE_EMPTY);
        if (isPresent && !this.status.tagPresent) {
          this.updateStatus({ tagPresent: true, tagUid: null });
        } else if (isEmpty) {
          // Only mark empty if no reader reports present
          const anyPresent = [...this.readers.values()].some(r => {
            try { return !!(r._statusState & r.SCARD_STATE_PRESENT); } catch { return false; }
          });
          if (!anyPresent) {
            this.updateStatus({ tagPresent: false, tagUid: null });
          }
        }
      });

      reader.on("end", () => {
        this.readers.delete(reader.name);
        if (this.activeReader === reader) this.activeReader = null;
        if (this.readers.size === 0) {
          this.updateStatus({ readerConnected: false, readerName: null, tagPresent: false, tagUid: null });
        }
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

  private trySharedConnect(reader: any): Promise<number | null> {
    return new Promise((resolve) => {
      reader.connect(
        { share_mode: reader.SCARD_SHARE_SHARED },
        (err: any, protocol: number) => {
          if (err || protocol == null || protocol <= 0) return resolve(null);
          resolve(protocol);
        },
      );
    });
  }

  private disconnectReader(reader: any): Promise<void> {
    return new Promise((resolve) => {
      reader.disconnect(reader.SCARD_LEAVE_CARD, () => resolve());
    });
  }

  /**
   * Try SHARED connect on each reader instance. On macOS, the built-in
   * ifd-ccid driver and ifd-acsccid both claim the ACR1552U, but only
   * the ACS driver handles ISO 15693. We try each and use whichever works.
   */
  private async connect(): Promise<number> {
    if (this.readers.size === 0) throw new Error("No NFC reader connected");

    const readerList = [...this.readers.values()];

    // Try each reader instance with SHARED mode
    for (const reader of readerList) {
      const protocol = await this.trySharedConnect(reader);
      if (protocol) {
        this.activeReader = reader;
        console.log(`[NFC] Connected via ${reader.name}, protocol=${protocol}`);
        return protocol;
      }
    }

    // Retry with delays — the working driver may need time to enumerate the tag
    for (const delay of [500, 1000, 2000]) {
      await new Promise(r => setTimeout(r, delay));
      for (const reader of readerList) {
        const protocol = await this.trySharedConnect(reader);
        if (protocol) {
          this.activeReader = reader;
          console.log(`[NFC] Connected via ${reader.name} after ${delay}ms, protocol=${protocol}`);
          return protocol;
        }
      }
    }

    throw new Error(
      "Cannot connect to tag — the reader detected the tag but no driver supports ISO 15693. " +
      "Try removing and replacing the tag.",
    );
  }

  private disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.activeReader) return resolve();
      this.activeReader.disconnect(this.activeReader.SCARD_LEAVE_CARD, () => resolve());
    });
  }

  /**
   * Transmit APDU via SCardTransmit on the active reader.
   */
  private transmit(data: Buffer, maxLen: number, protocol: number): Promise<Buffer> {
    const reader = this.activeReader;
    if (!reader) throw new Error("No active reader connection");

    return new Promise((resolve, reject) => {
      reader.transmit(data, maxLen, protocol, (err: any, resp: Buffer) => {
        if (err) return reject(new Error(`Transmit: ${err.message}`));
        resolve(resp);
      });
    });
  }

  private checkSW(response: Buffer): boolean {
    const len = response.length;
    return len >= 2 && response[len - 2] === 0x90 && response[len - 1] === 0x00;
  }

  // ── Connection-scoped operations ────────────────────────────────

  private async withConnection<T>(fn: (protocol: number) => Promise<T>): Promise<T> {
    if (this.readers.size === 0) throw new Error("No NFC reader connected");

    const protocol = await this.connect();

    try {
      return await fn(protocol);
    } finally {
      try { await this.disconnect(); } catch { /* */ }
    }
  }

  // ── ISO 15693 block operations ──────────────────────────────────

  private async readBlock(protocol: number, blockNum: number): Promise<Buffer> {
    // Pass Through: FF FB 00 00 <Lc> <ISO15693 cmd>
    // ISO 15693 Read Single Block: flags(02) cmd(20) block_num
    const cmd = Buffer.from([0xff, 0xfb, 0x00, 0x00, 0x02, 0x20, blockNum]);
    const response = await this.transmit(cmd, BLOCK_SIZE + 10, protocol);
    if (this.checkSW(response)) {
      return response.subarray(0, response.length - 2);
    }
    throw new Error(`Read block ${blockNum} failed: SW=${response.toString("hex")}`);
  }

  private async writeBlock(protocol: number, blockNum: number, data: Buffer): Promise<void> {
    // Pass Through: FF FB 00 00 <Lc> <ISO15693 cmd>
    // ISO 15693 Write Single Block: flags(02) cmd(21) block_num data(4)
    const cmd = Buffer.from([
      0xff, 0xfb, 0x00, 0x00, 0x06, 0x21, blockNum,
      data[0], data[1], data[2], data[3],
    ]);
    const response = await this.transmit(cmd, 10, protocol);
    if (this.checkSW(response)) return;
    throw new Error(`Write block ${blockNum} failed: SW=${response.toString("hex")}`);
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
    for (const reader of this.readers.values()) {
      try { reader.close(); } catch { /* */ }
    }
    if (this.pcsc) { try { this.pcsc.close(); } catch { /* */ } }
  }
}
