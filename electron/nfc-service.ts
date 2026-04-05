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

type PCSCLite = ReturnType<typeof pcsclite>;

/** Extract the CardReader type from the pcsclite "reader" event listener. */
type CardReader = Parameters<Extract<Parameters<PCSCLite["on"]>[1], (reader: unknown) => void>>[0];

/** Status payload from CardReader "status" event. */
interface CardReaderStatus {
  atr?: Buffer;
  state: number;
}

const BLOCK_SIZE = 4;
const DEFAULT_BLOCK_COUNT = 80;

export class NfcService extends EventEmitter {
  private pcsc: PCSCLite;
  private readers: Map<string, CardReader> = new Map();
  private readerPresent: Map<string, boolean> = new Map();
  private activeReader: CardReader | null = null;
  private lastReaderDiscoveredAt = 0;
  private status: NfcStatus = {
    readerConnected: false,
    readerName: null,
    tagPresent: false,
    tagUid: null,
  };

  constructor() {
    super();
    this.pcsc = pcsclite();

    this.pcsc.on("reader", (reader: CardReader) => {
      this.readers.set(reader.name, reader);
      this.lastReaderDiscoveredAt = Date.now();
      console.log(`[NFC] Reader discovered: ${reader.name} (${this.readers.size} total)`);

      if (this.readers.size === 1) {
        this.updateStatus({ readerConnected: true, readerName: reader.name });
      }

      let firstStatus = true;
      reader.on("status", (status: CardReaderStatus) => {
        const changes = reader.state ^ status.state;
        const isPresent = !!(status.state & reader.SCARD_STATE_PRESENT);
        const isEmpty = !!(status.state & reader.SCARD_STATE_EMPTY);
        if (!changes) return;

        // Ignore the first status event per reader — it reflects the reader's
        // initial state which can falsely report SCARD_STATE_PRESENT on some
        // interfaces (e.g. the SAM slot on Linux reports present=true with no
        // tag). We must skip setting readerPresent here too, otherwise the SAM
        // reader's phantom "present" permanently blocks tag removal detection.
        if (firstStatus) {
          firstStatus = false;
          if (isPresent && !isEmpty && status.atr?.length) {
            // ATR present means a tag is genuinely on the reader at startup
            this.readerPresent.set(reader.name, true);
            this.updateStatus({ tagPresent: true, tagUid: null });
          }
          return;
        }

        // Track each reader's presence independently
        this.readerPresent.set(reader.name, isPresent && !isEmpty);

        if (isPresent && !this.status.tagPresent) {
          this.updateStatus({ tagPresent: true, tagUid: null });
        } else if (isEmpty) {
          // Only mark empty if no reader reports present
          const anyPresent = [...this.readerPresent.values()].some(Boolean);
          if (!anyPresent) {
            this.updateStatus({ tagPresent: false, tagUid: null });
          }
        }
      });

      reader.on("end", () => {
        this.readers.delete(reader.name);
        this.readerPresent.delete(reader.name);
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

  private trySharedConnect(reader: CardReader): Promise<number | null> {
    return new Promise((resolve) => {
      reader.connect(
        { share_mode: reader.SCARD_SHARE_SHARED },
        (err: unknown, protocol: number) => {
          if (err || protocol == null || protocol <= 0) return resolve(null);
          resolve(protocol);
        },
      );
    });
  }

  private disconnectReader(reader: CardReader): Promise<void> {
    return new Promise((resolve) => {
      reader.disconnect(reader.SCARD_UNPOWER_CARD, () => resolve());
    });
  }

  /**
   * Try SHARED connect on each reader instance. On macOS, the built-in
   * ifd-ccid driver and ifd-acsccid both claim the ACR1552U, but only
   * the ACS driver handles ISO 15693. We try each and use whichever works.
   */
  private async connect(): Promise<number> {
    if (this.readers.size === 0) throw new Error("No NFC reader connected");

    // On hot-plug, macOS registers two reader instances sequentially. If a reader
    // was just discovered, wait for both driver instances (ifd-ccid and
    // ifd-acsccid) to register before we try to connect.
    const msSinceDiscovery = Date.now() - this.lastReaderDiscoveredAt;
    if (msSinceDiscovery < 3000) {
      const settleDelay = Math.max(1000, 3000 - msSinceDiscovery);
      console.log(`[NFC] Reader recently discovered, waiting ${settleDelay}ms for drivers to settle`);
      await new Promise(r => setTimeout(r, settleDelay));
    }

    // On Linux (especially Raspberry Pi), the PC/SC daemon may not finish
    // enumerating the tag before the status event fires. Give it a brief
    // head-start before the first connect attempt.
    if (process.platform === "linux") {
      await new Promise(r => setTimeout(r, 500));
    }

    // Try each reader instance with SHARED mode.
    // Re-read this.readers on each attempt since new readers may register during waits.
    const tryAllReaders = async (): Promise<number | null> => {
      for (const reader of this.readers.values()) {
        const protocol = await this.trySharedConnect(reader);
        if (protocol) {
          this.activeReader = reader;
          return protocol;
        }
      }
      return null;
    };

    const protocol = await tryAllReaders();
    if (protocol) {
      console.log(`[NFC] Connected via ${this.activeReader!.name}, protocol=${protocol}`);
      return protocol;
    }

    // Retry with delays — the working driver may need time to enumerate the tag.
    // Re-read the reader list each time since new instances may appear mid-retry.
    for (const delay of [1000, 2000, 3000]) {
      await new Promise(r => setTimeout(r, delay));
      const p = await tryAllReaders();
      if (p) {
        console.log(`[NFC] Connected via ${this.activeReader!.name} after ${delay}ms, protocol=${p}`);
        return p;
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
      reader.transmit(data, maxLen, protocol, (err: unknown, resp: Buffer) => {
        if (err) return reject(new Error(`Transmit: ${err instanceof Error ? err.message : String(err)}`));
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
    if (response.length < 2) throw new Error("Truncated NFC response");
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

  async writeTag(cborPayload: Uint8Array, productUrl?: string): Promise<void> {
    return this.withConnection(async (protocol) => {
      const block0 = await this.readBlock(protocol, 0);
      const mlen = block0[2];
      const tagMemorySize = mlen * 8 || DEFAULT_BLOCK_COUNT * BLOCK_SIZE;

      const tagMemory = wrapNdefForTag(cborPayload, tagMemorySize, productUrl);

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

  async formatTag(): Promise<void> {
    return this.withConnection(async (protocol) => {
      // Read block 0 to get memory size from the CC
      const block0 = await this.readBlock(protocol, 0);
      const mlen = block0[2];
      const numBlocks = mlen ? Math.min(Math.ceil((mlen * 8) / BLOCK_SIZE), DEFAULT_BLOCK_COUNT) : DEFAULT_BLOCK_COUNT;

      // Write CC with valid NFC Forum Type 5 header, then zero everything else
      // CC: E1 40 <size/8> 01 — magic, v1.0 RW, size, read-multiple-blocks supported
      const cc = Buffer.from([0xe1, 0x40, mlen || (DEFAULT_BLOCK_COUNT * BLOCK_SIZE / 8), 0x01]);
      await this.writeBlock(protocol, 0, cc);

      // Write TLV terminator in block 1, zero the rest
      const terminator = Buffer.from([0xfe, 0x00, 0x00, 0x00]);
      await this.writeBlock(protocol, 1, terminator);

      // Zero remaining blocks (skip block 0 and 1, already written)
      const zeroes = Buffer.alloc(BLOCK_SIZE);
      for (let i = 2; i < numBlocks; i++) {
        try {
          await this.writeBlock(protocol, i, zeroes);
        } catch {
          // Last block(s) may be write-protected on SLIX2 (config area) — stop
          break;
        }

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
