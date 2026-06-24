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
import { wrapNdefForTag, parseNdefFromTag, isCcByteReadOnly, setCcByteReadOnly } from "./ndef";
import { decodeOpenPrintTagBinary, type DecodedOpenPrintTag } from "../src/lib/openprinttag-decode";
import { deriveBambuKeys, parseBambuBlocks, bambuToDecodedTag } from "./bambu-tag";
import {
  classifyNfcError as classifyNfcErrorImpl,
  type NfcErrorCode,
} from "../src/lib/nfcErrorClassify";
import { isLikelyContactlessReader } from "../src/lib/nfcReaderFilter";

export type { NfcErrorCode };
/** Re-export the classifier so the existing call-sites in this file
 *  keep their local-looking import while the impl + unit tests live
 *  under `src/lib/`. */
export const classifyNfcError = classifyNfcErrorImpl;

export interface NfcStatus {
  readerConnected: boolean;
  readerName: string | null;
  tagPresent: boolean;
  tagUid: string | null;
  /** Last error surfaced by the pcsc/reader layer, classified for the UI.
   *  Cleared as soon as a reader successfully reports a status update so
   *  a transient failure doesn't linger on the pill forever. */
  lastError: {
    code: NfcErrorCode;
    /** Raw upstream message — surfaced in the tooltip as a fallback when
     *  the code is "generic" or the user wants the exact wording. */
    message: string;
  } | null;
}


type PCSCLite = ReturnType<typeof pcsclite>;

/**
 * Extract the (non-exported) CardReader type from the pcsclite "reader" event
 * overload. `@pokusew/pcsclite` does `export = pcsc`, so the CardReader
 * interface isn't importable directly. The previous `Parameters<Extract<…>>`
 * form collapsed to `never` (the listener overload isn't assignable to
 * `(reader: unknown) => void` under contravariant parameter checking), which
 * silently turned every reader access into a `never` — only caught once
 * electron/ started being type-checked (#816). Infer the parameter from the
 * specific "reader" overload instead.
 */
type CardReader =
  PCSCLite extends { on(type: "reader", listener: (reader: infer R) => void): unknown }
    ? R
    : never;

/** Status payload from CardReader "status" event. */
interface CardReaderStatus {
  atr?: Buffer;
  state: number;
}

const BLOCK_SIZE = 4;
const DEFAULT_BLOCK_COUNT = 80;

/** The MLEN byte a healthy SLIX2 tag reports: total memory / 8 =
 * 80 blocks × 4 bytes / 8 = 40. */
const EXPECTED_MLEN = (DEFAULT_BLOCK_COUNT * BLOCK_SIZE) / 8;

/**
 * Sanitize the raw MLEN byte read from a tag's Capability Container
 * (GH #301). MLEN is "memory length / 8" and comes straight off the
 * tag. Only a genuinely UNUSABLE value is rejected — zero, a
 * non-integer, or out of byte range (block0 too short → `block0[2]`
 * is `undefined`) — and replaced with the SLIX2 default.
 *
 * GH #322 (Codex P1): a value merely OUTSIDE the SLIX2 band is
 * preserved. It is the real declared capacity of a non-SLIX2 NFC-V
 * chip; clamping it would make `formatTag()` write a wrong CC and
 * corrupt an otherwise-valid tag. The bounds that actually matter for
 * safety are enforced at the USE sites instead — the read loops clamp
 * the block count to DEFAULT_BLOCK_COUNT, and `writeTag()` caps its
 * write extent at EXPECTED_MLEN — so a large MLEN can't drive reads or
 * writes off the end of the chip.
 */
function sanitizeMlen(rawByte: number): number {
  return Number.isInteger(rawByte) && rawByte > 0 && rawByte <= 255
    ? rawByte
    : EXPECTED_MLEN;
}

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
    lastError: null,
  };

  constructor() {
    super();
    this.pcsc = pcsclite();

    this.pcsc.on("reader", (reader: CardReader) => {
      // GH #847: ignore virtual/system + contact-only PC/SC "readers" the OS
      // enumerates (Windows Hello / UICC / TPM virtual smart cards, built-in
      // contact slots). On Windows a virtual card's "present" bit otherwise
      // drove a false "Tag detected" + an auto-read popup with no NFC hardware
      // installed. The name is still logged so a misfiltered real reader can be
      // spotted (and it's surfaced in the status tooltip).
      if (!isLikelyContactlessReader(reader.name)) {
        console.log(`[NFC] Ignoring non-contactless reader: ${reader.name}`);
        return;
      }
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
        // interfaces. Two known false positives:
        //
        //   1. The SAM slot on Linux reports present=true with no tag. We must
        //      skip setting readerPresent here too, otherwise the SAM
        //      reader's phantom "present" permanently blocks tag removal
        //      detection.
        //
        //   2. The ACR1552U on macOS (and likely other ACS-driver readers)
        //      reports present=true WITH a non-empty `status.atr` on the
        //      first event even when no tag is in the field (GH #230). The
        //      previous code carved out an exception when
        //      `status.atr?.length` was truthy, on the theory that ATR
        //      presence meant a tag was already on the reader at plug-in.
        //      That theory was wrong for at least one driver and caused
        //      every reader plug-in to surface a "Cannot connect to tag"
        //      toast — because the auto-read in main.ts saw tagPresent
        //      flip true and tried to read a tag that wasn't there.
        //
        // Trade-off: a user who plugs in the reader with a tag already on it
        // doesn't get an auto-read on plug-in. They lift + re-place the tag
        // once (or any other physical perturbation) and the next status
        // event runs through the normal `isPresent` path below. That minor
        // friction is far less disruptive than the previous behaviour of
        // throwing a scary error on every plug-in.
        if (firstStatus) {
          firstStatus = false;
          // GH #572: PC/SC reports a tag already resting on the reader at
          // connect time as this very first status event — which we skip to
          // dodge the documented plug-in phantom (GH #230). For a tag that
          // never moves there is no further state-change event, so the
          // present-edge auto-read in main.ts never fires and the pill stays
          // "Ready — place tag" while a tag is sitting there. We still skip
          // (not flipping tagPresent here keeps the SAM-slot persistent
          // phantom from blocking tag-removal detection), but signal that a
          // card MIGHT be resting so the main process can do a one-shot,
          // silent verification read: a real tag connects and reads (its
          // connect emits an INUSE status event that flips tagPresent
          // organically); a phantom/empty reader fails the connect and stays
          // quiet.
          if (isPresent) {
            this.emit("presentAtConnect");
          }
          return;
        }

        // Track each reader's presence independently
        this.readerPresent.set(reader.name, isPresent && !isEmpty);

        // GH #450: a successful status event proves the reader is
        // talking again; clear any lingering error so the pill drops
        // back to its normal state instead of stuck on a transient
        // sharing-violation from a previous tick.
        this.clearLastError();

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

      reader.on("error", (err: Error) => {
        this.recordError(err);
        this.emit("error", err);
      });
    });

    this.pcsc.on("error", (err: Error) => {
      if (!err.message?.includes("SCardListReaders")) {
        this.recordError(err);
        this.emit("error", err);
      }
    });
  }

  /** GH #450: store the most recent reader/pcsc error on the status so
   *  the renderer can surface a translated hint on the NFC pill. We do
   *  NOT clear `readerConnected` here — the reader event might still be
   *  alive and the error transient. The status pill renders both. */
  private recordError(err: unknown): void {
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    this.updateStatus({ lastError: { code: classifyNfcError(err), message } });
  }

  /** Clear any lingering error once a reader successfully reports a
   *  status update or a tag round-trip completes. Called from the
   *  reader.on("status") success path so a one-shot daemon hiccup
   *  doesn't keep the pill stuck on a stale error message. */
  public clearLastError(): void {
    if (this.status.lastError) this.updateStatus({ lastError: null });
  }

  private updateStatus(partial: Partial<NfcStatus>): void {
    this.status = { ...this.status, ...partial };
    this.emit("statusChange", { ...this.status });
  }

  getStatus(): NfcStatus {
    return { ...this.status };
  }

  /**
   * Force-clear the phantom "tag present" state when an auto-read
   * verification fails because PC/SC said `isPresent=true` but
   * `connect()` couldn't establish a connection after multiple retries.
   *
   * The first-event skip at the top of the reader status handler already
   * dodges the documented ACR1552U phantom on plug-in (GH #230). But on
   * some drivers the `SCARD_STATE_CHANGED` bit can toggle on a later
   * status event without any real physical change in the field —
   * `changes != 0`, `isPresent=true`, and the service flips
   * `tagPresent: true` on the strength of that bit alone. The status
   * pill in the renderer is then stuck at "Tag detected" indefinitely:
   *
   *   - No subsequent status event will clear it (the driver thinks
   *     present=true is the current state).
   *   - Unplug+replug resets state momentarily but the same phantom
   *     path runs on every replug, re-sticking `tagPresent: true`.
   *
   * The auto-read in `electron/main.ts` fires on the present=true
   * transition. If the tag is real, the read succeeds and we leave
   * `tagPresent: true` alone. If the connect retries exhaust with
   * `"Cannot connect to tag"`, this method is called to corrective-
   * clear the state. The renderer pill recovers to "Ready, place a
   * tag" once the corrective status update propagates.
   *
   * NOTE: we do NOT blanket-clear `readerPresent`. In a multi-reader
   * setup (multiple physical readers, or mixed virtual/physical PC/SC
   * entries) another reader may legitimately have a real tag whose
   * presence event we already recorded. Wiping every entry would let
   * a subsequent `isEmpty` event for that other reader incorrectly
   * conclude `anyPresent === false` and clobber a valid `tagPresent:
   * true` later on. Codex round-1 P2 on PR #359. Only `tagPresent` is
   * force-cleared here; subsequent reader status events maintain
   * `readerPresent` organically as physical changes occur.
   */
  clearPhantomPresence(): void {
    if (this.status.tagPresent) {
      this.updateStatus({ tagPresent: false, tagUid: null });
    }
  }

  // ── Connection helpers ──────────────────────────────────────────

  private trySharedConnect(reader: CardReader): Promise<number | null> {
    return new Promise((resolve) => {
      reader.connect(
        { share_mode: reader.SCARD_SHARE_SHARED },
        (err: unknown, protocol: number) => {
          if (err || protocol == null || protocol <= 0) {
            // Codex follow-up on #469: an earlier round called
            // `reader.disconnect()` on this path. The @pokusew/pcsclite
            // public wrapper short-circuits when its internal
            // `connected` flag is false, which is the case after a
            // failed connect — so the call was a no-op and didn't
            // actually release the native handle.
            //
            // The native fix would require touching pcsclite internals
            // (`reader._disconnect` or driving the C++ binding
            // directly), which is hostile to portability across
            // pcsclite versions. The leak is bounded by the OS PC/SC
            // daemon's GC of disowned handles and the retry-loop
            // hand-off in `connect()` above, which DOES release
            // successfully-connected readers. Accept the residual
            // failed-connect leak and resolve cleanly.
            resolve(null);
            return;
          }
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
    //
    // GH #436: when a retry iteration succeeds on reader B after a
    // previous iteration had set `this.activeReader = readerA` (and
    // returned a valid protocol on A, but withConnection's caller
    // failed somewhere in between), readerA's handle stays open. PC/SC
    // handles are scarce on Linux pcscd; after a few cycles the OS
    // reports "no readers." Track every reader we've connected to in
    // this attempt so they all get released if we hand off to a new one
    // or fall through to the final throw.
    const connectedReaders = new Set<CardReader>();
    const tryAllReaders = async (): Promise<number | null> => {
      for (const reader of this.readers.values()) {
        const protocol = await this.trySharedConnect(reader);
        if (protocol) {
          // Hand-off: previous candidate (if any) loses its connection.
          if (this.activeReader && this.activeReader !== reader) {
            await this.disconnectReader(this.activeReader).catch(() => {});
            connectedReaders.delete(this.activeReader);
          }
          this.activeReader = reader;
          connectedReaders.add(reader);
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

    // GH #436: every reader we ever opened in this attempt is now stale —
    // there's no `activeReader` to hand back, and `withConnection`'s
    // disconnect path only knows about `activeReader`. Walk our tracking
    // set and release each handle.
    for (const r of connectedReaders) {
      await this.disconnectReader(r).catch(() => {});
    }
    this.activeReader = null;
    throw new Error(
      "Cannot connect to tag — the reader detected a tag but could not establish a connection. " +
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
      const result = await fn(protocol);
      // Codex P2 on PR #476 round 2: a successful round-trip proves the
      // reader + PC/SC daemon are healthy, so clear any lingering
      // lastError. Without this, a user who resolves a transient busy /
      // permission issue and then successfully reads or writes a tag
      // would still see the red error pill until a reader status event
      // fires (which doesn't have to happen if the same tag is still
      // sitting on the reader).
      this.clearLastError();
      return result;
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

  // ── ISO 14443 / MIFARE Classic operations ───────────────────────

  /** Get tag UID via PC/SC pseudo-APDU. Succeeds on ISO 14443 tags. */
  private async getUID(protocol: number): Promise<Buffer> {
    const cmd = Buffer.from([0xff, 0xca, 0x00, 0x00, 0x00]);
    const resp = await this.transmit(cmd, 20, protocol);
    if (!this.checkSW(resp)) throw new Error("Get UID failed");
    return resp.subarray(0, resp.length - 2);
  }

  /** Load a 6-byte MIFARE authentication key into a reader key slot. */
  private async loadMifareKey(protocol: number, keySlot: number, key: Buffer): Promise<void> {
    const cmd = Buffer.alloc(11);
    cmd[0] = 0xff; cmd[1] = 0x82; cmd[2] = 0x00; cmd[3] = keySlot;
    cmd[4] = 0x06;
    key.copy(cmd, 5);
    const resp = await this.transmit(cmd, 10, protocol);
    if (!this.checkSW(resp)) throw new Error(`Load MIFARE key slot ${keySlot} failed`);
  }

  /** Authenticate a MIFARE Classic block with a loaded key. */
  private async authenticateMifareBlock(
    protocol: number, blockNum: number, keyType: number, keySlot: number,
  ): Promise<void> {
    const cmd = Buffer.from([
      0xff, 0x86, 0x00, 0x00, 0x05,
      0x01, 0x00, blockNum, keyType, keySlot,
    ]);
    const resp = await this.transmit(cmd, 10, protocol);
    if (!this.checkSW(resp)) throw new Error(`Auth block ${blockNum} failed`);
  }

  /** Read a single 16-byte MIFARE Classic block. */
  private async readMifareBlock(protocol: number, blockNum: number): Promise<Buffer> {
    const cmd = Buffer.from([0xff, 0xb0, 0x00, blockNum, 0x10]);
    const resp = await this.transmit(cmd, 20, protocol);
    if (!this.checkSW(resp)) throw new Error(`Read MIFARE block ${blockNum} failed`);
    return resp.subarray(0, resp.length - 2);
  }

  /**
   * Read a Bambu Lab MIFARE Classic tag. Derives sector keys from the UID,
   * authenticates each sector, and parses the proprietary data format.
   */
  private async readBambuTag(protocol: number): Promise<DecodedOpenPrintTag> {
    const uid = await this.getUID(protocol);
    const keys = deriveBambuKeys(uid);

    const blocks: (Buffer | undefined)[] = [];

    // Read sectors 0–9 (data). Sectors 10–15 contain RSA signature — skip.
    for (let sector = 0; sector < 10; sector++) {
      const firstBlock = sector * 4;
      const key = keys[sector];

      // loadMifareKey loads a key into a reader slot — it's reader-level, not
      // sector-specific, so a failure here is a real PCSC/hardware error that
      // MUST surface, not be masked as a "damaged sector" (Codex on #687).
      await this.loadMifareKey(protocol, 0, key);

      try {
        await this.authenticateMifareBlock(protocol, firstBlock, 0x60, 0); // Key A
      } catch (err) {
        // Sector-0 auth failing means this isn't a (readable) Bambu tag, so
        // surface that. But a LATER sector's auth failing (damaged /
        // partially-read tag) must not abort the whole read with a misleading
        // OpenPrintTag error — zero-fill its blocks and keep going so
        // parseBambuBlocks gets what it can (#680; mirrors the per-block read
        // guard below).
        if (sector === 0) throw err;
        for (let i = 0; i < 3; i++) blocks[firstBlock + i] = Buffer.alloc(16);
        continue;
      }

      // Read 3 data blocks per sector (block 3 of each sector is the trailer)
      for (let i = 0; i < 3; i++) {
        const blockNum = firstBlock + i;
        try {
          blocks[blockNum] = await this.readMifareBlock(protocol, blockNum);
        } catch {
          blocks[blockNum] = Buffer.alloc(16);
        }
      }
    }

    const bambuData = parseBambuBlocks(blocks);
    return bambuToDecodedTag(bambuData);
  }

  /**
   * Probe whether the tag in the field is a Bambu Lab MIFARE Classic tag.
   * Attempts the UID-derived Key-A auth on sector 0 (the first step of
   * {@link readBambuTag}); success means the tag answered the Bambu key
   * derivation, so it's a Bambu tag. Bambu tags are RSA-signed and
   * read-only, so erase/format must refuse them with a friendly message
   * rather than failing on the raw ISO 15693 `readBlock(0)` (GH #583).
   */
  private async isBambuTag(protocol: number): Promise<boolean> {
    try {
      const uid = await this.getUID(protocol);
      const keys = deriveBambuKeys(uid);
      await this.loadMifareKey(protocol, 0, keys[0]);
      await this.authenticateMifareBlock(protocol, 0, 0x60, 0); // Key A, sector 0
      return true;
    } catch {
      return false;
    }
  }

  // ── High-level operations ───────────────────────────────────────

  /** Read an OpenPrintTag (NFC-V / ISO 15693) tag. */
  private async readOpenPrintTag(protocol: number): Promise<DecodedOpenPrintTag> {
    const block0 = await this.readBlock(protocol, 0);
    const mlen = sanitizeMlen(block0[2]);
    const numBlocks = Math.min(Math.ceil((mlen * 8) / BLOCK_SIZE), DEFAULT_BLOCK_COUNT);

    const allData = Buffer.alloc(numBlocks * BLOCK_SIZE);
    block0.copy(allData, 0);

    for (let i = 1; i < numBlocks; i++) {
      try {
        const bd = await this.readBlock(protocol, i);
        bd.copy(allData, i * BLOCK_SIZE);
      } catch {
        // Retry once for transient RF errors
        try {
          const bd = await this.readBlock(protocol, i);
          bd.copy(allData, i * BLOCK_SIZE);
          continue;
        } catch {
          break; // Give up — likely past readable memory
        }
      }
    }

    const cborPayload = parseNdefFromTag(allData);
    const decoded = decodeOpenPrintTagBinary(cborPayload);
    // GH #583: surface the soft read-only state (CC byte 1 write-access bits)
    // so the renderer can show a lock badge and the write probe can refuse it.
    decoded.readOnly = isCcByteReadOnly(block0[1]);
    return decoded;
  }

  /**
   * Read a tag, auto-detecting its type.
   *
   * The ACR1552U returns a UID for both ISO 14443 and ISO 15693 tags via
   * FF CA, so Get UID alone can't distinguish tag types. Instead we try
   * the full Bambu MIFARE Classic read (auth + block reads). If auth
   * fails, the tag isn't Bambu — fall through to ISO 15693 OpenPrintTag.
   */
  async readTag(): Promise<DecodedOpenPrintTag> {
    // Try Bambu (MIFARE Classic) first
    try {
      return await this.withConnection(async (protocol) => {
        return await this.readBambuTag(protocol);
      });
    } catch {
      // Auth or read failed — not a Bambu tag, fall through to OpenPrintTag
    }

    // Reconnect for ISO 15693 (OpenPrintTag) — a fresh connection ensures
    // the reader isn't in a stale state after a failed MIFARE auth attempt.
    return this.withConnection(async (protocol) => {
      return this.readOpenPrintTag(protocol);
    });
  }

  async writeTag(cborPayload: Uint8Array, productUrl?: string): Promise<void> {
    return this.withConnection(async (protocol) => {
      const block0 = await this.readBlock(protocol, 0);
      // GH #437: refuse to overwrite a tag that doesn't carry an NFC-
      // Forum Type 5 CC byte. The read path checks this; the write
      // path historically didn't, so a user with a non-blank tag of
      // a different format (proprietary, RFID inventory, transit
      // card) in the field at the moment they triggered Write got
      // its block 0 overwritten — potentially bricking it for its
      // original use. A blank tag (`0x00 0x00 ...`) still passes
      // because formatTag is the path for that; a wrong-format tag
      // is the case this guard catches.
      // NFC Forum Type 5 CC magic byte is 0xE1 (standard) or 0xE2
      // (extended CC, used by larger ISO 15693 tags). Both are valid
      // NDEF-formatted tags the app can safely reformat. Blank (0x00)
      // is also fine — that's exactly what formatTag is for.
      if (block0[0] !== 0xe1 && block0[0] !== 0xe2 && block0[0] !== 0x00) {
        throw new Error(
          "Tag refuses NFC-Forum write (block 0 is neither 0xE1/0xE2 CC nor blank 0x00). " +
            "This looks like a non-NDEF formatted tag — remove and replace with a blank or NDEF-formatted tag.",
        );
      }
      // GH #583: honor the soft read-only flag (CC byte 1 write-access bits).
      // Defense-in-depth — the renderer probe also refuses, but enforce here so
      // a locked tag can't be overwritten even if a caller skips the probe.
      // Erase (formatTag) deliberately does NOT check this — it's the escape
      // hatch that clears the lock.
      if (isCcByteReadOnly(block0[1])) {
        throw new Error(
          "TAG_READ_ONLY: This tag is marked read-only. Erase it, or make it writable in Settings, before writing.",
        );
      }
      const mlen = sanitizeMlen(block0[2]);
      // GH #301/#322: cap the write extent at the SLIX2-class size the
      // app's own payloads are built for. sanitizeMlen now preserves a
      // larger real MLEN (so formatTag writes a correct CC), but the
      // write loop must not run far past a normal chip when the tag
      // reports an over-large — or corrupt-but-in-byte-range — MLEN.
      const tagMemorySize = Math.min(mlen, EXPECTED_MLEN) * 8;

      const tagMemory = wrapNdefForTag(cborPayload, tagMemorySize, productUrl);

      // Write all blocks through the full payload length to ensure zero-padding
      // is written to the tag (required for correct NDEF parsing by some readers).
      // The last block on SLIX2 tags (block 79) may be write-protected, so we
      // catch and stop on write errors below.
      const numBlocks = Math.ceil(tagMemory.length / BLOCK_SIZE);

      for (let i = 0; i < numBlocks; i++) {
        const offset = i * BLOCK_SIZE;
        const blockData = Buffer.alloc(BLOCK_SIZE);
        for (let j = 0; j < BLOCK_SIZE && offset + j < tagMemory.length; j++) {
          blockData[j] = tagMemory[offset + j];
        }

        try {
          await this.writeBlock(protocol, i, blockData);
        } catch {
          // Last block(s) may be write-protected on SLIX2 (config area) — stop
          break;
        }

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
    // GH #583: a Bambu Lab tag is MIFARE Classic (ISO 14443) and read-only
    // (RSA-signed). The ISO 15693 `readBlock(0)` below would fail on it with
    // a raw "Read block 0 failed: SW=6a81" — opaque to the user. Detect it
    // first (mirroring readTag's dispatch) and surface a friendly read-only
    // message. Run the probe in its OWN connection so a failed MIFARE auth
    // doesn't leave the reader in a stale state for the 15693 format below.
    let bambu = false;
    try {
      bambu = await this.withConnection((protocol) => this.isBambuTag(protocol));
    } catch {
      bambu = false;
    }
    if (bambu) {
      throw new Error(
        "BAMBU_READ_ONLY: Bambu Lab tags are RSA-signed and read-only — they cannot be erased.",
      );
    }

    return this.withConnection(async (protocol) => {
      // Read block 0 to get memory size from the CC. GH #301: the raw
      // MLEN byte is sanitized before it's trusted for numBlocks OR
      // written back into the CC — a corrupt byte written here would
      // brick the tag for the app.
      const block0 = await this.readBlock(protocol, 0);
      // GH #437: same CC-byte guard as writeTag. A blank tag (0x00)
      // is fine — that's exactly what formatTag is for. A wrong-
      // format tag (anything other than 0xE1 or 0x00 at position 0)
      // would have its block 0 silently overwritten, potentially
      // bricking the tag for its original use.
      // NFC Forum Type 5 CC magic byte is 0xE1 (standard) or 0xE2
      // (extended CC, used by larger ISO 15693 tags). Both are valid
      // NDEF-formatted tags the app can safely reformat. Blank (0x00)
      // is also fine — that's exactly what formatTag is for.
      if (block0[0] !== 0xe1 && block0[0] !== 0xe2 && block0[0] !== 0x00) {
        throw new Error(
          "Tag refuses NFC-Forum format (block 0 is neither 0xE1/0xE2 CC nor blank 0x00). " +
            "This looks like a non-NDEF formatted tag — remove and replace with a blank or NDEF-formatted tag.",
        );
      }
      const mlen = sanitizeMlen(block0[2]);
      const numBlocks = Math.min(Math.ceil((mlen * 8) / BLOCK_SIZE), DEFAULT_BLOCK_COUNT);

      // Write CC with valid NFC Forum Type 5 header, then zero everything else
      // CC: E1 40 <size/8> 01 — magic, v1.0 RW, size, read-multiple-blocks supported
      const cc = Buffer.from([0xe1, 0x40, mlen, 0x01]);
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

  /**
   * GH #583: set (or clear) the soft read-only flag on an OpenPrintTag by
   * flipping the NFC-Forum Type 5 CC byte-1 write-access bits and rewriting
   * block 0. Reversible — `setReadOnly(false)` clears it without touching the
   * tag's data, and Erase clears it too. A Bambu tag is already read-only and
   * a blank/foreign tag has no CC to lock, so both are refused with a typed
   * message the renderer maps to friendly copy.
   */
  async setReadOnly(readOnly: boolean): Promise<void> {
    // Bambu tags are MIFARE Classic, RSA-signed and inherently read-only —
    // there's no NFC-Forum CC to toggle. Detect first (own connection, like
    // formatTag) so we give a clear message instead of a raw ISO 15693 error.
    let bambu = false;
    try {
      bambu = await this.withConnection((protocol) => this.isBambuTag(protocol));
    } catch {
      bambu = false;
    }
    if (bambu) {
      throw new Error("BAMBU_READ_ONLY: Bambu Lab tags are already read-only.");
    }

    return this.withConnection(async (protocol) => {
      // Codex P2 on PR #585: a bare CC-magic check (0xE1/0xE2) isn't enough —
      // a foreign NFC-Forum Type 5 tag (a URL/contact tag with a 0xE1 CC) would
      // pass it and we'd flip ITS write-access bits, marking an unrelated tag
      // read-only. Fully parse the tag and confirm it carries an OpenPrintTag
      // record before touching block 0; only OpenPrintTags are ours to lock.
      try {
        await this.readOpenPrintTag(protocol);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Definitive "this isn't an OpenPrintTag" signals from ndef.ts → tell
        // the user to write a filament first. Transient/connection errors
        // bubble up unchanged so a flaky read isn't mislabelled.
        const notOpt = [
          "Blank or unformatted",
          "No NDEF",
          "Invalid CC magic",
          "Tag data too short",
          "truncated",
        ].some((s) => msg.includes(s));
        if (notOpt) {
          throw new Error(
            "TAG_NOT_FORMATTED: This tag has no OpenPrintTag data to lock — write a filament to it first.",
          );
        }
        throw err;
      }

      const block0 = await this.readBlock(protocol, 0);
      const newByte1 = setCcByteReadOnly(block0[1], readOnly);
      if (newByte1 === block0[1]) {
        return; // already in the requested state — no write needed
      }
      // Rewrite block 0 with only the access bit changed; preserve magic, MLEN
      // and the read-multiple-blocks byte.
      const cc = Buffer.from([block0[0], newByte1, block0[2], block0[3]]);
      await this.writeBlock(protocol, 0, cc);
    });
  }

  destroy(): void {
    for (const reader of this.readers.values()) {
      try { reader.close(); } catch { /* */ }
    }
    if (this.pcsc) { try { this.pcsc.close(); } catch { /* */ } }
  }
}
