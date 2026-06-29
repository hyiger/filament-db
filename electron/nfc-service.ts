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
import {
  wrapNdefForTag,
  parseNdefRecords,
  isCcByteReadOnly,
  setCcByteReadOnly,
  buildType2Cc,
  buildMediaNdefRecord,
  buildNdefMessageTlv,
} from "./ndef";
import { type DecodedOpenPrintTag } from "../src/lib/openprinttag-decode";
import { decodeFromNdefRecords, OPENPRINTTAG_MIME } from "../src/lib/tagCodecs";
import { OPENTAG3D_MIME } from "../src/lib/opentag3d";
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

// NTAG (NFC-A / ISO 14443 Type 2) read tuning (#864). FF B0 READ BINARY returns
// a 4-page (16-byte) burst; the Type-2 CC sits in page 3 (bytes 12–15) with the
// NDEF TLV area starting at page 4 (byte 16). NTAG216 tops out near 872 user
// bytes, so 1 KB is a generous ceiling that bounds the read loop.
const NTAG_CC_OFFSET = 12;
const NTAG_TLV_OFFSET = 16;
const NTAG_MAX_NDEF_BYTES = 1024;
// Write/erase extent caps (Codex #927 — bound a corrupt/foreign CC size so a
// write never runs off the chip / into config-lock pages). NTAG216 (the largest
// real NTAG) holds 872 NDEF bytes → last user page 221 (< 256, no APDU wrap).
const NTAG_MAX_NDEF_WRITE_BYTES = 872;
// When the true chip size is UNKNOWN (GET_VERSION unsupported), bound the
// hygiene zero-fill to NTAG213's user area (144 bytes) — safe on ANY chip, since
// even the smallest NTAG's lock/config pages sit above its user area. The fresh
// CC + empty-NDEF TLV already make the tag blank; the deeper wipe is just hygiene
// and stale bytes past the TLV terminator are unreachable by NDEF readers.
const NTAG_CONSERVATIVE_WIPE_BYTES = 144;
// NXP manufacturer code (ISO/IEC 7816-6). A real NTAG21x's page-0 byte-0 (UID0)
// is ALWAYS 0x04; it's never 0x00 or 0xE1. Used to tell a genuine Type-2 NTAG
// apart from an ISO-15693 SLIX2 that the ACS reader also answers FF B0 for
// (Codex P1, #927 — a blank SLIX2 reads 0x00 here, a formatted one 0xE1).
const NTAG_NXP_MANUFACTURER_CODE = 0x04;

/**
 * OpenTag3D write (Layers 2/3): the standard a writer lays down. The renderer
 * sends the native binary (OPT CBOR for SLIX2, the OpenTag3D fixed-binary image
 * for NTAG) plus this discriminator so the service knows how to wrap + which
 * chip to require.
 */
export type WriteStandard = "openprinttag" | "opentag3d";

/**
 * Detection result surfaced to the renderer (`detectTag()` / `nfc-detect-tag`).
 * `family` is the chip class; `standard` is the data format already on it (null
 * for a blank/unrecognised tag).
 */
export interface TagDetection {
  family: "ntag" | "slix2" | "bambu" | "unknown";
  standard: "opentag3d" | "openprinttag" | "bambu" | null;
  formatted: boolean;
  readOnly: boolean;
  /** NDEF-usable byte capacity for an NTAG (CC size, or GET_VERSION for a blank
   * tag), so the renderer can pick the Core (112B) vs Extended (187B) OpenTag3D
   * image to fit a small NTAG213. null when unknown / not an NTAG. */
  ndefCapacity: number | null;
}

/**
 * NTAG storage-size byte (GET_VERSION response byte 6) → NDEF-usable bytes
 * (CC byte-2 × 8). Used ONLY to size a BLANK NTAG when writing its first CC —
 * a formatted tag's existing CC is trusted instead. An UNKNOWN size byte is
 * treated as an error (refuse the blank tag) rather than guessing a size that
 * could drive a write past the end of a smaller chip and corrupt it.
 *
 * Values are the NXP NTAG21x datasheet's authoritative storage-size bytes
 * (§8.3.7): 213 = 0x0F, 215 = 0x11, 216 = 0x13. (The task brief quoted
 * 0x11/0x13/0x15, which is off by one position vs. real silicon; the datasheet
 * is the source of truth and the two sets collide on 0x11/0x13, so guessing
 * both would be unsafe.) NDEF-usable bytes match the hardware-proven
 * NTAG_NDEF_BYTES map in the dev write CLI: 213→144, 215→496, 216→872.
 *
 * GET_VERSION itself is HARDWARE-UNVERIFIED on the ACR1552U via this transport;
 * an unsupported/odd response sizes nothing and the blank-tag write is refused.
 */
const NTAG_GETVERSION_STORAGE_SIZE: Record<number, number> = {
  0x0f: 144, // NTAG213
  0x11: 496, // NTAG215
  0x13: 872, // NTAG216
};

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

  /**
   * GH #903: a single PC/SC connection is shared across all transport ops, so
   * the present-edge auto-read in `electron/main.ts` (one-shot verification on
   * tag arrival) could run a `readTag()` while a user-triggered write/read/erase
   * is mid-flight — interleaving APDUs on the same reader. Serialize every
   * public transport op through this chain: QUEUE-AND-WAIT, so a second op runs
   * only after the first finishes. A failed op doesn't reject the next caller.
   */
  private txChain: Promise<unknown> = Promise.resolve();

  /**
   * Run `op` after all prior transport ops settle. When a `signal` is passed
   * (from the IPC-timeout AbortController in main.ts), it is checked at DEQUEUE
   * — the moment this op reaches the front of the queue — so a mutation whose
   * 15s IPC timeout already fired WHILE QUEUED is dropped before it touches the
   * tag (GH #915: otherwise a queued write/format runs later against whatever
   * tag is now present, after the user saw failure and may have swapped tags).
   * An op already in progress when the timeout fires is left to finish (the
   * hazard is the still-queued one, not the in-flight one).
   */
  private runExclusive<T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const guarded = () => {
      if (signal?.aborted) {
        throw new Error(
          "NFC operation aborted — the reader was busy too long; remove the tag and try again.",
        );
      }
      return op();
    };
    const run = this.txChain.then(guarded, guarded);
    this.txChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

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

  private disconnect(reset = false): Promise<void> {
    return new Promise((resolve) => {
      if (!this.activeReader) return resolve();
      // `reset` re-powers the card on disconnect (SCARD_RESET_CARD). NTAG mutating
      // ops pass it: the ACR1552U serves Type-2 FF B0 READ BINARY from an internal
      // card buffer that's only refreshed on card (re)activation, so after an
      // FF D6 write the NEXT operation's read would otherwise return the STALE
      // buffer until the tag is physically re-presented (the read-only flag not
      // clearing, post-write "no record", erase-then-write still read-only — all
      // observed on hardware). Resetting forces the next connect to re-read the
      // tag fresh. SLIX2/ISO-15693 (FF FB) is a direct pass-through and never
      // needs this, so its ops keep SCARD_LEAVE_CARD.
      const disposition = reset
        ? this.activeReader.SCARD_RESET_CARD
        : this.activeReader.SCARD_LEAVE_CARD;
      this.activeReader.disconnect(disposition, () => resolve());
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

  private async withConnection<T>(
    fn: (protocol: number) => Promise<T>,
    opts: { resetAfter?: boolean } = {},
  ): Promise<T> {
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
      try { await this.disconnect(opts.resetAfter); } catch { /* */ }
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

  /**
   * Read an NFC-V / ISO 15693 (SLIX2) tag and decode it via the codec registry.
   * This is the OpenPrintTag transport, but #864 routes the parsed NDEF records
   * through the registry so an `application/opentag3d` record on a SLIX2 tag also
   * decodes (OpenTag3D ships on both SLIX2 and NTAG). An OpenPrintTag record
   * still decodes exactly as before.
   */
  /** Assemble the full NFC-V / ISO-15693 (SLIX2) tag image (CC at byte 0). */
  private async readNfcVImage(protocol: number): Promise<Buffer> {
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
    return allData;
  }

  private async readOpenPrintTag(protocol: number): Promise<DecodedOpenPrintTag> {
    const allData = await this.readNfcVImage(protocol);
    // parseNdefRecords throws the friendly "Blank or unformatted" / CC errors
    // (Type-5 CC at offset 0), preserved verbatim for the renderer's empty-tag UI.
    const records = parseNdefRecords(allData, 0);
    const decoded = decodeFromNdefRecords(records);
    if (!decoded) {
      // NDEF present but neither OpenPrintTag nor OpenTag3D — keep the historical
      // message so nfcErrorClassify continues to bucket it as a wrong-format tag.
      throw new Error('No NDEF record with type "application/vnd.openprinttag" found');
    }
    // GH #583: surface the soft read-only state (CC byte 1 write-access bits)
    // so the renderer can show a lock badge and the write probe can refuse it.
    decoded.readOnly = isCcByteReadOnly(allData[1]);
    return decoded;
  }

  // ── NTAG (NFC-A / ISO 14443 Type 2) — OpenTag3D, #864 ───────────────

  /** Read one 16-byte (4-page) burst via the PC/SC READ BINARY pseudo-APDU. */
  private async readNtagBurst(protocol: number, startPage: number): Promise<Buffer> {
    const cmd = Buffer.from([0xff, 0xb0, 0x00, startPage, 0x10]);
    const resp = await this.transmit(cmd, 20, protocol);
    if (!this.checkSW(resp)) {
      throw new Error(`NTAG read page ${startPage} failed: SW=${resp.toString("hex")}`);
    }
    return resp.subarray(0, resp.length - 2);
  }

  /**
   * Assemble a full NTAG Type-2 image (pages 0–3 head + user pages from page 4)
   * sized to the CC byte-2 capacity, returning the buffer and the number of
   * bytes actually read back. Shared by the read path, the read-only OpenTag3D
   * record check, and the write verify so they agree on assembly.
   */
  private async assembleNtagImage(
    protocol: number,
    head: Buffer,
  ): Promise<{ data: Buffer; written: number }> {
    const mlen = head[NTAG_CC_OFFSET + 2]; // CC byte 2 = NDEF area size / 8
    const ndefBytes = Math.min(Math.max(0, mlen * 8), NTAG_MAX_NDEF_BYTES);
    const data = Buffer.alloc(NTAG_TLV_OFFSET + ndefBytes);
    head.copy(data, 0);

    let page = 4;
    let written = NTAG_TLV_OFFSET;
    while (written < data.length) {
      let burst: Buffer;
      try {
        burst = await this.readNtagBurst(protocol, page);
      } catch {
        try {
          burst = await this.readNtagBurst(protocol, page); // retry once
        } catch {
          break; // past readable memory
        }
      }
      const copyLen = Math.min(burst.length, data.length - written);
      burst.copy(data, written, 0, copyLen);
      written += copyLen;
      page += 4;
    }
    return { data, written };
  }

  /**
   * Write one 4-byte page via the PC/SC UPDATE BINARY pseudo-APDU (FF D6),
   * checking SW=9000. Ported verbatim from scripts/write-opentag3d-tag.ts's
   * writePage — that exact APDU is HARDWARE-PROVEN on the ACR1552U + NTAG215.
   *
   * SAFETY: callers must NEVER target page 2 (the static lock bytes, bytes 2–3)
   * or the dynamic/config lock pages — those are OTP and permanent. The only
   * pages this codebase writes are page 3 (the rewritable Type-2 CC) and the
   * user data region (page 4 onward). See setReadOnlyImpl / writeTagImpl /
   * formatTagImpl, all of which start at page 3 or 4.
   */
  private async writeNtagPage(protocol: number, page: number, four: Buffer): Promise<void> {
    // SAFETY backstop (Codex #927): the page rides in a SINGLE APDU byte, so a
    // page >= 256 would silently wrap (e.g. 513 → page 1) and a page < 3 would
    // hit the UID/static-lock pages (0–2). Refuse anything outside [3, 255] so a
    // corrupt/foreign CC size can never drive a write into the lock/config area
    // or wrap to a low page — the OTP-lock invariant holds regardless of caller.
    if (!Number.isInteger(page) || page < 3 || page > 0xff) {
      throw new Error(`Refusing unsafe NTAG page write: page ${page} is out of the safe [3,255] range`);
    }
    const cmd = Buffer.from([0xff, 0xd6, 0x00, page, 0x04, four[0], four[1], four[2], four[3]]);
    const resp = await this.transmit(cmd, 10, protocol);
    if (!this.checkSW(resp)) {
      throw new Error(`NTAG write page ${page} failed: SW=${resp.toString("hex")}`);
    }
  }

  /**
   * Detect an NFC-Forum Type 2 (NTAG) chip and return its pages-0–3 head (16
   * bytes; the Type-2 CC is at byte 12). Returns null when the tag is NOT a
   * Type-2 NTAG — i.e. READ BINARY (FF B0) throws (most 15693 SLIX2 tags), the
   * burst is short, or page-0 byte-0 is not the NXP manufacturer code (0x04).
   * Some ACS readers ALSO answer FF B0 for an ISO-15693 SLIX2, returning its
   * block 0 — which starts with 0xE1 on a FORMATTED OpenPrintTag (the NFC-Forum
   * Type 5 CC magic) or 0x00 on a BLANK one. A real NTAG21x's page-0 byte-0 is
   * the UID manufacturer code (always 0x04, never 0x00/0xE1), so requiring it is
   * the robust discriminator: it defers BOTH SLIX2 states to the proven 15693
   * path. Codex P1 (#927): the old `=== 0xE1`-only guard let a BLANK SLIX2 (0x00)
   * through as a "blank NTAG", so OpenPrintTag write/erase took the NTAG path and
   * failed (NTAG_SIZE_UNKNOWN / Type-2 page writes) instead of formatting it.
   * Mirrors readNtagTag's head-validation logic so detection and read agree.
   *
   * Non-null ⇒ NTAG (Type 2); null ⇒ SLIX2 (Type 5) / not Type 2.
   */
  private async detectType2Head(protocol: number): Promise<Buffer | null> {
    let head: Buffer;
    try {
      head = await this.readNtagBurst(protocol, 0);
    } catch {
      return null; // READ BINARY not supported → not a Type-2 NTAG
    }
    if (head.length < NTAG_TLV_OFFSET) return null;
    // Require the NXP manufacturer byte — a 15693 SLIX2 answering FF B0 has 0xE1
    // (formatted) or 0x00 (blank) here, neither of which is a real NTAG UID.
    if (head[0] !== NTAG_NXP_MANUFACTURER_CODE) return null;
    return head;
  }

  /**
   * Size a BLANK NTAG (no CC) via the GET_VERSION command so we can write a
   * correctly-sized Type-2 CC. GET_VERSION is ISO 14443A `60h`; on the ACR1552U
   * it's issued as a pass-through APDU. Returns the NDEF-usable byte count for a
   * recognised storage-size byte, else null — in which case the caller MUST
   * refuse the blank tag (per the locked decision: never guess the size).
   *
   * HARDWARE-UNVERIFIED on this reader/transport — implemented to spec; the null
   * path keeps a wrong guess from ever corrupting a smaller chip.
   */
  private async getNtagNdefBytesViaGetVersion(protocol: number): Promise<number | null> {
    let resp: Buffer;
    try {
      // FF 00 00 00 02 60 00 — InCommunicateThru-style pass-through carrying the
      // ISO14443A GET_VERSION (0x60) command, mirroring the FF FB / FF B0
      // pseudo-APDU convention this reader uses for the other transports.
      const cmd = Buffer.from([0xff, 0x00, 0x00, 0x00, 0x02, 0x60, 0x00]);
      resp = await this.transmit(cmd, 16, protocol);
    } catch {
      return null;
    }
    // GET_VERSION returns 8 bytes (+ SW). The storage-size byte is byte 6 of the
    // version data. Be lenient about trailing SW — only trust a well-formed,
    // recognised response.
    const data = this.checkSW(resp) ? resp.subarray(0, resp.length - 2) : resp;
    if (data.length < 7) return null;
    const storageByte = data[6];
    return NTAG_GETVERSION_STORAGE_SIZE[storageByte] ?? null;
  }

  /**
   * Resolve the SAFE NDEF byte capacity of a FORMATTED NTAG for write/size
   * decisions (Codex P1, #927). GET_VERSION (`verSize`) is authoritative when
   * available — take the smaller of it and the CC-claimed size. When GET_VERSION
   * is UNAVAILABLE we must NOT trust a possibly-inflated CC: a corrupt CC claiming
   * 215/216 on a real NTAG213 would let an Extended write run past the 213's user
   * area into its lock/config pages — a brick the writeNtagPage [3,255] guard
   * can't catch, since those pages sit INSIDE that range on a small chip. So fall
   * back to the conservative NTAG213 extent (144 B), safe on ANY NTAG. Real
   * 215/216 tags then degrade to Core-only writes when GET_VERSION is unsupported
   * (the renderer surfaces the opentag3dCoreOnly notice) rather than risking a
   * brick. In practice GET_VERSION works on the ACR1552U (a blank-NTAG write
   * requires it), so this conservative branch is the rare edge case.
   */
  private safeNtagNdefBytes(ccByte2: number, verSize: number | null): number {
    const ccBytes = Math.min(Math.max(0, ccByte2 * 8), NTAG_MAX_NDEF_WRITE_BYTES);
    return verSize != null
      ? Math.min(ccBytes, verSize)
      : Math.min(ccBytes, NTAG_CONSERVATIVE_WIPE_BYTES);
  }

  /**
   * Read an NFC-Forum Type 2 (NTAG213/215/216) tag carrying an OpenTag3D (or any
   * registered) NDEF record. Returns:
   *   - the decoded tag on success,
   *   - `null` when this isn't a Type-2 tag at all (READ BINARY unsupported, e.g.
   *     a 15693 tag) OR the CC isn't an NDEF Type-2 CC — so readTag() falls
   *     through to the ISO-15693 path,
   *   - throws for a REAL Type-2 tag with blank/unrecognized content, so the
   *     friendly message surfaces instead of being buried by the 15693 attempt.
   */
  private async readNtagTag(protocol: number): Promise<DecodedOpenPrintTag | null> {
    let head: Buffer;
    try {
      head = await this.readNtagBurst(protocol, 0); // pages 0–3 → CC at byte 12
    } catch {
      return null; // READ BINARY not supported here → not an NTAG/Type-2 tag
    }
    if (head.length < NTAG_TLV_OFFSET) return null;

    // Safety guard (no hardware needed): some ACS readers answer FF B0 for a
    // 15693 SLIX2 storage tag too, returning its block 0 — which is the NFC-Forum
    // Type 5 CC magic (0xE1) on a formatted OpenPrintTag, or 0x00 on a blank one.
    // A real NTAG21x's page-0 byte-0 is the NXP manufacturer code (always 0x04,
    // never 0x00/0xE1). Require it so BOTH SLIX2 states defer to the proven
    // ISO-15693 path rather than being mis-parsed as Type-2 (Codex P1, #927 —
    // mirrors detectType2Head). A genuine NTAG falls through to the CC check.
    if (head[0] !== NTAG_NXP_MANUFACTURER_CODE) return null;

    const ccMagic = head[NTAG_CC_OFFSET];
    if (ccMagic === 0x00) {
      throw new Error("Blank or unformatted NFC tag (no NDEF data)");
    }
    if (ccMagic !== 0xe1) {
      return null; // readable as Type 2 but no NDEF CC — let other paths try
    }

    const { data, written } = await this.assembleNtagImage(protocol, head);

    const records = parseNdefRecords(data.subarray(0, written), NTAG_CC_OFFSET);
    // An NDEF-formatted tag with an EMPTY message (our Erase writes the empty TLV
    // 03 00 FE at page 4 → zero records) is BLANK, not a foreign tag. Report it as
    // blank so the renderer's write-probe (ensureTagWritable) takes its blank-
    // bypass and a write to a freshly-erased tag proceeds without an overwrite
    // prompt / weight-update fail-closed (Codex #927). A non-empty record list
    // that just isn't OpenTag3D is the genuine "foreign NDEF" case below.
    if (records.length === 0) {
      throw new Error("Blank or unformatted NFC tag (no NDEF data)");
    }
    const decoded = decodeFromNdefRecords(records);
    if (!decoded) {
      throw new Error('No NDEF record with type "application/opentag3d" found');
    }
    // NTAG read-only is NOT surfaced: the Type-2 CC page is OTP (the read-only
    // nibble can be set but never cleared), so it isn't a meaningful reversible
    // state and we don't act on it (see setReadOnlyImpl / writeNtagImpl). Leaving
    // readOnly unset avoids a lock badge the user could never clear.
    return decoded;
  }

  /**
   * Read a tag, auto-detecting its type.
   *
   * The ACR1552U returns a UID for both ISO 14443 and ISO 15693 tags via
   * FF CA, so Get UID alone can't distinguish tag types. Instead we try each
   * transport in turn and fall through on failure:
   *   1. Bambu MIFARE Classic (ISO 14443-3A) — auth + block reads.
   *   2. NTAG / NFC-Forum Type 2 (ISO 14443A) — READ BINARY; OpenTag3D ships on
   *      NTAG213/215/216 (#864). Returns null when READ BINARY isn't supported
   *      (a 15693 tag), so we fall through; throws for a real Type-2 tag with
   *      blank/unrecognized content so its friendly message surfaces.
   *   3. ISO 15693 / NFC-V (SLIX2) — OpenPrintTag, or OpenTag3D on SLIX2.
   */
  async readTag(signal?: AbortSignal): Promise<DecodedOpenPrintTag> {
    return this.runExclusive(() => this.readTagImpl(), signal); // GH #903/#915
  }

  private async readTagImpl(): Promise<DecodedOpenPrintTag> {
    // 1. Try Bambu (MIFARE Classic) first
    try {
      return await this.withConnection(async (protocol) => {
        return await this.readBambuTag(protocol);
      });
    } catch {
      // Auth or read failed — not a Bambu tag, fall through.
    }

    // 2. Try NTAG (NFC-A / ISO 14443 Type 2). A fresh connection avoids a stale
    // reader state after the failed MIFARE auth. A null result means "not a
    // Type-2 tag" → fall through to 15693; a throw means a real Type-2 tag with
    // a content error and propagates (so e.g. "Blank or unformatted" surfaces).
    const ntag = await this.withConnection(async (protocol) => {
      return this.readNtagTag(protocol);
    });
    if (ntag) return ntag;

    // 3. Reconnect for ISO 15693 (OpenPrintTag / OpenTag3D-on-SLIX2).
    return this.withConnection(async (protocol) => {
      return this.readOpenPrintTag(protocol);
    });
  }

  /**
   * Write a tag, dispatching by `standard` and the chip detected in the field.
   * `payload` is the standard's NATIVE binary — OpenPrintTag CBOR (SLIX2) or the
   * OpenTag3D fixed-binary image (NTAG). The service wraps + lays it down per
   * transport. Throws TAG_TYPE_MISMATCH when the requested standard doesn't
   * match the chip present, so the wrong format can't be written.
   */
  async writeTag(
    payload: Uint8Array,
    opts: { standard?: WriteStandard; productUrl?: string } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    return this.runExclusive(() => this.writeTagImpl(payload, opts), signal); // GH #903/#915
  }

  private async writeTagImpl(
    payload: Uint8Array,
    opts: { standard?: WriteStandard; productUrl?: string } = {},
  ): Promise<void> {
    const standard: WriteStandard = opts.standard ?? "openprinttag";

    // Detect the chip in its own connection (a probe burst), then dispatch. A
    // fresh connection for the actual write avoids a stale reader state.
    const head = await this.withConnection((protocol) => this.detectType2Head(protocol));

    if (standard === "opentag3d") {
      if (!head) {
        throw new Error(
          "TAG_TYPE_MISMATCH: This is not an NTAG/Type-2 tag, but an OpenTag3D write needs one. " +
            "Place an NTAG (213/215/216) on the reader.",
        );
      }
      return this.writeNtagImpl(payload);
    }

    // standard === "openprinttag" — require SLIX2 (not an NTAG).
    if (head) {
      throw new Error(
        "TAG_TYPE_MISMATCH: This is an NTAG/Type-2 tag, but an OpenPrintTag write needs an ISO-15693 (SLIX2) tag. " +
          "Place a SLIX2 tag on the reader.",
      );
    }
    return this.writeSlix2Impl(payload, opts.productUrl);
  }

  /** EXISTING SLIX2 (OpenPrintTag) write — byte-for-byte unchanged from the
   *  original writeTagImpl body; only extracted into its own method so the
   *  dispatch above can pick it. */
  private async writeSlix2Impl(cborPayload: Uint8Array, productUrl?: string): Promise<void> {
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

  /**
   * OpenTag3D write (Layer 2/3): lay an OpenTag3D fixed-binary image down on an
   * NTAG via the Type-2 transport. `payload` is the raw OpenTag3D memory map; we
   * wrap it as one `application/opentag3d` media record inside an NDEF-message
   * TLV (mirrors the dev write CLI + wrapOpenTag3DType2).
   *
   * SAFETY INVARIANT: the ONLY pages written here are page 3 (the rewritable
   * Type-2 CC) and page 4 onward (user data). The NTAG static lock bytes
   * (page 2, bytes 2–3) and the dynamic lock bytes are NEVER touched — they are
   * OTP/permanent and writing them would brick the tag. Read-only is the
   * reversible CC byte-3 nibble only (setReadOnlyImpl).
   *
   * `head` is the detected pages-0–3 burst from detectType2Head (CC at byte 12).
   */
  private async writeNtagImpl(payload: Uint8Array): Promise<void> {
    // NOTE: await (not return) — the verify phase below MUST run after this.
    await this.withConnection(async (protocol) => {
      // Re-read pages 0–3 in THIS mutating connection (Codex P2 #927). The probe's
      // head came from a SEPARATE connection in writeTagImpl, so a tag swapped
      // after the probe would have the #437 guard + capacity applied to the
      // PREVIOUS tag while the page writes hit the new one. Deriving ccMagic +
      // capacity from a fresh in-connection read keeps check-and-write atomic; a
      // tag that's no longer an NTAG aborts here instead of being clobbered.
      const head = await this.detectType2Head(protocol);
      if (!head) {
        throw new Error(
          "TAG_TYPE_MISMATCH: The tag on the reader is no longer an NTAG/Type-2 tag. " +
            "Keep the tag still and try again.",
        );
      }
      const ccMagic = head[NTAG_CC_OFFSET];

      // GH #437 parity for NTAG (Codex P2 #927): refuse to overwrite a tag whose
      // page-3 CC byte is neither an NFC-Forum Type-2 CC (0xE1) nor blank (0x00).
      // The byte-0 NXP guard in detectType2Head only proves it's an NXP Type-2
      // chip — it could still be a proprietary / non-NDEF NTAG (inventory, access
      // badge, custom app) whose data we'd clobber by formatting over it. Only an
      // NDEF tag (0xE1 — overwritten on explicit/confirmed Write) or a genuinely
      // blank one (0x00) is ours to write. Mirrors writeSlix2Impl's guard.
      if (ccMagic !== 0xe1 && ccMagic !== 0x00) {
        throw new Error(
          "Tag refuses NFC-Forum write (page 3 CC is neither 0xE1 nor blank 0x00). " +
            "This looks like a non-NDEF formatted NTAG — remove and replace with a blank or NDEF-formatted tag.",
        );
      }

      // NTAG FAMILY CONFIRMATION + authoritative size (Codex P2 #927). GET_VERSION
      // succeeds on NTAG21x but NOT on MIFARE Classic — which shares the FF B0 read
      // APDU and can carry an NXP 0x04 UID, so the byte-0 guard alone can't exclude
      // a non-Bambu Classic card (a coincidental 0xE1/0x00 byte-12 would otherwise
      // reach the page writes below and clobber Classic blocks / access bits). Fail
      // CLOSED when GET_VERSION can't confirm: never mutate a card we can't prove is
      // an NTAG. GET_VERSION works on the ACR1552U in practice (a blank-NTAG write
      // already required it), so this is the rare edge case.
      const verSize = await this.getNtagNdefBytesViaGetVersion(protocol);
      if (verSize == null) {
        throw new Error(
          "NTAG_SIZE_UNKNOWN: Couldn't confirm an NTAG (213/215/216) on the reader — refusing to write. " +
            "The reader didn't return a recognized NTAG GET_VERSION response.",
        );
      }

      // NOTE: we deliberately do NOT pre-refuse on the Type-2 CC read-only nibble
      // (CC byte 3). On NTAG21x the CC page is OTP — a set bit can't be cleared
      // (hardware-confirmed), so it's not a reversible signal and honoring it would
      // permanently lock a tag out of our own write path. A GENUINELY locked NTAG
      // (its static lock bytes set, which WE never set) just fails the page write
      // below with an SW error. NTAG "set read-only" is unsupported for this reason.
      let ndefBytes: number;
      let needsFormat = false;
      if (ccMagic === 0xe1) {
        // Formatted: bound the payload by min(CC, verSize) via safeNtagNdefBytes so
        // a corrupt/inflated CC (a real 213 claiming 215/216) can't drive an
        // Extended TLV past the chip's user area into its lock/config pages (the
        // [3,255] page guard can't catch that, since config sits in that range on a
        // small chip).
        ndefBytes = this.safeNtagNdefBytes(head[NTAG_CC_OFFSET + 2], verSize);
      } else {
        // Blank NTAG (CC magic 0x00 — the guard above ruled out every other
        // non-0xE1 value): size from the verified GET_VERSION value; the fresh CC is
        // written below, AFTER the capacity check.
        ndefBytes = verSize;
        needsFormat = true; // CC written below — AFTER the capacity check (Codex #927)
      }

      // Build the NDEF-message TLV (0x03 … one media record … 0xFE terminator)
      // and capacity-check it BEFORE writing anything, so a too-large payload
      // can't leave a blank tag half-formatted (CC written, no NDEF) — a partial
      // mutation that detection/retries would then see as a malformed tag.
      const tlv = buildNdefMessageTlv(buildMediaNdefRecord(OPENTAG3D_MIME, payload));
      if (tlv.length > ndefBytes) {
        throw new Error(
          `TAG_TOO_SMALL: OpenTag3D data (${tlv.length} bytes) exceeds this NTAG's NDEF capacity ` +
            `(${ndefBytes} bytes). Use a larger NTAG (215/216).`,
        );
      }

      // Format a blank tag only now that the payload is known to fit.
      if (needsFormat) {
        await this.writeNtagPage(protocol, 3, Buffer.from(buildType2Cc(ndefBytes)));
      }

      // Write the TLV from page 4, 4 bytes per page (FF D6 UPDATE BINARY).
      const tlvBuf = Buffer.from(tlv);
      const numPages = Math.ceil(tlvBuf.length / 4);
      for (let i = 0; i < numPages; i++) {
        const page = 4 + i;
        const chunk = Buffer.alloc(4);
        tlvBuf.copy(chunk, 0, i * 4, Math.min((i + 1) * 4, tlvBuf.length));
        await this.writeNtagPage(protocol, page, chunk);

        // EEPROM programming delay between pages (matches the SLIX2 path).
        if (i < numPages - 1) {
          await new Promise((r) => setTimeout(r, 10));
        }

        this.emit("writeProgress", {
          block: i, total: numPages,
          percent: Math.round(((i + 1) / numPages) * 100),
        });
      }

    }, { resetAfter: true });

    // Verify in a FRESH connection (Codex #927 P1). The resetAfter above means
    // this connect RE-ACTIVATES the card, so the read-back can't return the
    // ACR1552U's stale pre-write READ BINARY buffer and falsely fail a write that
    // actually landed. Reading page 0–3 fresh also picks up the just-written CC
    // (no need to patch a stale detection head). A mismatch here is therefore a
    // REAL failure. (The per-page FF D6 SW=9000 already confirmed each write; this
    // byte-exact check guards against a valid-but-WRONG read-back.)
    await this.withConnection(async (protocol) => {
      const vhead = await this.readNtagBurst(protocol, 0);
      const { data: image, written } = await this.assembleNtagImage(protocol, vhead);
      const records = parseNdefRecords(image.subarray(0, written), NTAG_CC_OFFSET);
      const rec = records.find((r) => r.tnf === 0x02 && r.type === OPENTAG3D_MIME);
      if (!rec) {
        throw new Error("OpenTag3D verification read failed — the tag did not read back as OpenTag3D.");
      }
      if (rec.payload.length !== payload.length || rec.payload.some((b, i) => b !== payload[i])) {
        throw new Error(
          "OpenTag3D verification mismatch — the tag read back different bytes than were written. " +
            "The write may not have landed correctly; try again.",
        );
      }
    }, { resetAfter: true });
  }

  async formatTag(signal?: AbortSignal): Promise<void> {
    return this.runExclusive(() => this.formatTagImpl(), signal); // GH #903/#915
  }

  private async formatTagImpl(): Promise<void> {
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

    // OpenTag3D write (Layer 2/3): detect the chip and dispatch. NTAG → the
    // Type-2 erase below; SLIX2 (head === null) → the existing ISO-15693 erase.
    // This probe only picks the path; formatNtagImpl re-reads in its own mutating
    // connection so the guards apply to the tag actually present (Codex P2 #927).
    const head = await this.withConnection((protocol) => this.detectType2Head(protocol));
    if (head) {
      return this.formatNtagImpl();
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
   * OpenTag3D write (Layer 2/3): erase an NTAG (Type 2). Writes a fresh
   * read/write Type-2 CC to page 3 (which also CLEARS the reversible soft
   * read-only nibble — the escape hatch), an empty-NDEF TLV (03 00 FE 00) at
   * page 4, and zeroes the remaining user pages up to capacity.
   *
   * SAFETY INVARIANT: only page 3 (CC) and page 4+ (user data) are written. The
   * static lock bytes (page 2) and dynamic lock bytes are NEVER touched.
   *
   * Capacity: a formatted NTAG's existing CC byte-2 gives the size; a blank one
   * is sized via GET_VERSION (refused if unknown — never guess).
   */
  private async formatNtagImpl(): Promise<void> {
    return this.withConnection(async (protocol) => {
      // Re-read pages 0–3 in THIS mutating connection (Codex P2 #927): the probe's
      // head came from a separate connection in formatTagImpl, so a tag swapped
      // after the probe would apply the guards to the previous tag while the writes
      // hit the new one. A tag that's no longer an NTAG aborts here.
      const head = await this.detectType2Head(protocol);
      if (!head) {
        throw new Error(
          "TAG_TYPE_MISMATCH: The tag on the reader is no longer an NTAG/Type-2 tag. " +
            "Keep the tag still and try again.",
        );
      }
      const ccMagic = head[NTAG_CC_OFFSET];
      // GH #437 parity for NTAG (Codex P2 #927): refuse to reformat a tag whose
      // page-3 CC byte is neither an NFC-Forum Type-2 CC (0xE1) nor blank (0x00).
      // The byte-0 NXP guard only proves it's an NXP Type-2 chip — it could still
      // be a proprietary / non-NDEF NTAG whose data Erase would clobber by writing
      // a fresh CC + TLV over it. Mirrors the SLIX2 erase/write guard.
      if (ccMagic !== 0xe1 && ccMagic !== 0x00) {
        throw new Error(
          "Tag refuses NFC-Forum format (page 3 CC is neither 0xE1 nor blank 0x00). " +
            "This looks like a non-NDEF formatted NTAG — remove and replace with a blank or NDEF-formatted tag.",
        );
      }
      // NTAG FAMILY CONFIRMATION + authoritative size (Codex P2 #927). GET_VERSION
      // succeeds on NTAG21x but NOT on MIFARE Classic — which shares the FF B0 read
      // APDU and can carry an NXP 0x04 UID with a coincidental 0xE1/0x00 byte-12, so
      // the byte-0 guard alone can't exclude it. Fail CLOSED when GET_VERSION can't
      // confirm: never run the page 3/4 writes against a card we can't prove is an
      // NTAG (they'd clobber Classic blocks / access bits). Erase REFORMATS, so it
      // uses the verified size DIRECTLY (no min() with the existing CC) for both the
      // rewritten CC and the zero-fill — restoring a tag previously mis-formatted
      // small (a real 215/216 formatted as a 213, or a corrupt/zero MLEN) to its
      // true size, while still replacing a LYING inflated CC with the real value
      // (the size is GET_VERSION's, never the old CC's). GET_VERSION works on the
      // ACR1552U in practice, so this is the rare edge case.
      const verSize = await this.getNtagNdefBytesViaGetVersion(protocol);
      if (verSize == null) {
        throw new Error(
          "NTAG_SIZE_UNKNOWN: Couldn't confirm an NTAG (213/215/216) on the reader — refusing to erase. " +
            "The reader didn't return a recognized NTAG GET_VERSION response.",
        );
      }
      // Verified physical capacity drives BOTH the rewritten CC and the zero-fill.
      const wipeBytes = verSize;
      const ndefBytes = verSize; // size written into the CC

      // Fresh read/write CC to page 3 — clears any soft read-only nibble.
      await this.writeNtagPage(protocol, 3, Buffer.from(buildType2Cc(ndefBytes)));

      // Empty-NDEF-message TLV at page 4: 03 00 FE 00 (tag, len=0, terminator).
      await this.writeNtagPage(protocol, 4, Buffer.from([0x03, 0x00, 0xfe, 0x00]));

      // Zero the remaining user pages up to the SAFE wipe bound (page 5 onward).
      const lastUserPage = 4 + Math.ceil(wipeBytes / 4) - 1;
      const zeroes = Buffer.alloc(4);
      const totalPages = Math.max(0, lastUserPage - 5 + 1);
      for (let page = 5, n = 0; page <= lastUserPage; page++, n++) {
        try {
          await this.writeNtagPage(protocol, page, zeroes);
        } catch {
          break; // past writable user memory
        }
        if (page < lastUserPage) {
          await new Promise((r) => setTimeout(r, 10));
        }
        this.emit("writeProgress", {
          block: n,
          total: totalPages,
          percent: totalPages > 0 ? Math.round(((n + 1) / totalPages) * 100) : 100,
        });
      }
    }, { resetAfter: true });
  }

  /**
   * GH #583: set (or clear) the soft read-only flag on an OpenPrintTag by
   * flipping the NFC-Forum Type 5 CC byte-1 write-access bits and rewriting
   * block 0. Reversible — `setReadOnly(false)` clears it without touching the
   * tag's data, and Erase clears it too. A Bambu tag is already read-only and
   * a blank/foreign tag has no CC to lock, so both are refused with a typed
   * message the renderer maps to friendly copy.
   */
  async setReadOnly(readOnly: boolean, signal?: AbortSignal): Promise<void> {
    return this.runExclusive(() => this.setReadOnlyImpl(readOnly), signal); // GH #903/#915
  }

  private async setReadOnlyImpl(readOnly: boolean): Promise<void> {
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

    // Detect the chip and dispatch. NTAG read-only is NOT supported: the Type-2
    // CC page is OTP (the read-only nibble can be set but never cleared — so it
    // is irreversible and would permanently lock the tag out of our write path).
    // True NTAG read-only would need the static lock bytes, which are also OTP /
    // bricking and which we never write. So refuse for NTAG; SLIX2 (head === null)
    // takes the genuinely-reversible CC byte-1 path below.
    const head = await this.withConnection((protocol) => this.detectType2Head(protocol));
    if (head) {
      throw new Error(
        "NTAG_READONLY_UNSUPPORTED: Read-only isn't available for OpenTag3D/NTAG tags — " +
          "their capability container is one-time-programmable, so it can't be undone. " +
          "Read-only is supported on OpenPrintTag (SLIX2) tags only.",
      );
    }

    return this.withConnection(async (protocol) => {
      // Codex P2 on PR #585: a bare CC-magic check (0xE1/0xE2) isn't enough —
      // a foreign NFC-Forum Type 5 tag (a URL/contact tag with a 0xE1 CC) would
      // pass it and we'd flip ITS write-access bits, marking an unrelated tag
      // read-only. Fully parse the tag and confirm it carries an OpenPrintTag
      // record before touching block 0; only OpenPrintTags are ours to lock.
      //
      // #864: confirm the OpenPrintTag MIME record SPECIFICALLY — readOpenPrintTag
      // now decodes any registered codec (incl. OpenTag3D via the registry), so
      // checking it alone would let us flip the CC of a third-party OpenTag3D
      // SLIX2 tag (read-only this phase — never ours to lock).
      let records;
      try {
        records = parseNdefRecords(await this.readNfcVImage(protocol), 0);
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
      if (!records.some((r) => r.tnf === 0x02 && r.type === OPENPRINTTAG_MIME)) {
        throw new Error(
          "TAG_NOT_FORMATTED: This tag has no OpenPrintTag data to lock — write a filament to it first.",
        );
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


  /**
   * OpenTag3D write (Layer 3): non-mutating probe of the tag in the field for the
   * renderer — which standard to encode + whether it's locked. Bambu (MIFARE
   * auth) → NTAG (FF B0; CC magic 0xE1 ⇒ formatted opentag3d, 0x00 ⇒ blank ntag)
   * → SLIX2 (block 0 CC ⇒ openprinttag).
   */
  async detectTag(signal?: AbortSignal): Promise<TagDetection> {
    return this.runExclusive(() => this.detectTagImpl(), signal);
  }

  private async detectTagImpl(): Promise<TagDetection> {
    // 1. Bambu (MIFARE Classic) — its own connection (failed auth leaves a stale
    //    state for the next transport).
    let bambu = false;
    try {
      bambu = await this.withConnection((protocol) => this.isBambuTag(protocol));
    } catch {
      bambu = false;
    }
    if (bambu) {
      return { family: "bambu", standard: "bambu", formatted: true, readOnly: true, ndefCapacity: null };
    }

    // 2. NTAG (Type 2).
    const head = await this.withConnection((protocol) => this.detectType2Head(protocol));
    if (head) {
      const ccMagic = head[NTAG_CC_OFFSET];
      if (ccMagic === 0xe1) {
        // Parse the actual NDEF records (Codex P3 #927) — don't claim "opentag3d"
        // from the CC byte alone, which would misreport an EMPTY/erased tag (our
        // Erase writes 03 00 FE → 0 records) and a FOREIGN NDEF tag (URL/contact)
        // as existing OpenTag3D. Mirrors readNtagTag: 0 records ⇒ blank, an
        // opentag3d record ⇒ opentag3d, any other record(s) ⇒ foreign NDEF
        // (formatted but standard null). One connection so size + read-back agree.
        // Capacity reporting stays via safeNtagNdefBytes (Codex P1): GET_VERSION
        // when available (smaller of it and the CC) else the conservative NTAG213
        // extent, so the renderer's Core/Extended choice matches the write's bound.
        return await this.withConnection(async (protocol) => {
          const verSize = await this.getNtagNdefBytesViaGetVersion(protocol);
          const ndefCapacity = this.safeNtagNdefBytes(head[NTAG_CC_OFFSET + 2], verSize);
          let standard: TagDetection["standard"] = null;
          let formatted = false;
          try {
            const { data, written } = await this.assembleNtagImage(protocol, head);
            const records = parseNdefRecords(data.subarray(0, written), NTAG_CC_OFFSET);
            if (records.length > 0) {
              formatted = true; // carries an NDEF message…
              if (records.some((r) => r.tnf === 0x02 && r.type === OPENTAG3D_MIME)) {
                standard = "opentag3d"; // …and it's ours
              }
            }
            // 0 records ⇒ empty/erased ⇒ blank (formatted:false, standard:null)
          } catch {
            // Read-back failed — leave as blank/unknown rather than over-claiming.
          }
          return {
            family: "ntag",
            standard,
            formatted,
            readOnly: false, // NTAG read-only is unsupported (CC page is OTP) — never report it
            ndefCapacity,
          };
        });
      }
      // Readable as Type 2 but no NDEF CC (blank / non-NDEF) — a blank NTAG.
      // GET_VERSION it (best-effort) so the renderer can size the payload; null
      // when unsupported (renderer falls back to Extended; service refuses on write).
      const cap = await this.withConnection((p) => this.getNtagNdefBytesViaGetVersion(p));
      return { family: "ntag", standard: null, formatted: false, readOnly: false, ndefCapacity: cap };
    }

    // 3. SLIX2 (Type 5). Read block 0; an 0xE1/0xE2 CC ⇒ an OpenPrintTag-class
    //    formatted tag, else blank/unknown.
    try {
      return await this.withConnection(async (protocol) => {
        const block0 = await this.readBlock(protocol, 0);
        const ccMagic = block0[0];
        if (ccMagic !== 0xe1 && ccMagic !== 0xe2) {
          // No NFC-Forum Type-5 CC — blank/unknown SLIX2.
          return { family: "slix2" as const, standard: null, formatted: false, readOnly: false, ndefCapacity: null };
        }
        // Has a Type-5 CC — parse the actual NDEF records (Codex P3 #927) so a
        // blank-after-erase SLIX2 (CC + terminator, no NDEF message) or a
        // foreign/OpenTag3D record isn't mislabeled as OpenPrintTag from the CC
        // byte alone. Mirrors the NTAG branch + setReadOnlyImpl's record check.
        let standard: TagDetection["standard"] = null;
        let formatted = false;
        try {
          const records = parseNdefRecords(await this.readNfcVImage(protocol), 0);
          if (records.length > 0) {
            formatted = true; // carries an NDEF message…
            if (records.some((r) => r.tnf === 0x02 && r.type === OPENPRINTTAG_MIME)) {
              standard = "openprinttag"; // …and it's ours
            } else if (records.some((r) => r.tnf === 0x02 && r.type === OPENTAG3D_MIME)) {
              standard = "opentag3d"; // OpenTag3D-on-SLIX2 (read-only support, #864)
            }
          }
          // 0 records ⇒ empty/erased ⇒ blank (formatted:false, standard:null)
        } catch (err) {
          // An erased SLIX2's TLV area is just the FE terminator, so
          // parseNdefRecords THROWS "No NDEF TLV found before terminator" rather
          // than returning [] (NTAG erase writes 03 00 FE → []; SLIX2 erase writes
          // FE only). Treat the no-NDEF / blank signals as BLANK (Codex P3 #927) so
          // a freshly-erased SLIX2 reads as blank, not OpenPrintTag. Any OTHER error
          // is a genuine read glitch — fall back to the CC-only signal (it has a
          // Type-5 CC) rather than under-claiming a real tag as blank.
          const msg = err instanceof Error ? err.message : String(err);
          const blank = msg.includes("No NDEF") || msg.includes("Blank or unformatted");
          formatted = !blank;
          standard = blank ? null : "openprinttag";
        }
        return {
          family: "slix2" as const,
          standard,
          formatted,
          readOnly: isCcByteReadOnly(block0[1]),
          ndefCapacity: null, // SLIX2 payload is fixed-size; not needed
        };
      });
    } catch {
      return { family: "unknown", standard: null, formatted: false, readOnly: false, ndefCapacity: null };
    }
  }

  destroy(): void {
    for (const reader of this.readers.values()) {
      try { reader.close(); } catch { /* */ }
    }
    if (this.pcsc) { try { this.pcsc.close(); } catch { /* */ } }
  }
}
