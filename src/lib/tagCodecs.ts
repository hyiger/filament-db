/**
 * Pluggable NFC tag codec registry (#864).
 *
 * A "codec" decodes one NDEF-borne tag format (identified by its NDEF media-type
 * MIME) into the shared DecodedOpenPrintTag shape. The registry lets the read
 * paths — the Electron desktop reader AND the server /api/nfc/decode route —
 * dispatch by NDEF record MIME instead of hard-coding a single format, so:
 *   - SLIX2 and NTAG tags carrying an `application/opentag3d` record decode via
 *     the OpenTag3D codec;
 *   - existing `application/vnd.openprinttag` tags keep decoding via the OPT
 *     codec, unchanged;
 *   - a physical tag carrying BOTH records (the OpenTag3D spec explicitly allows
 *     this) resolves deterministically by registration order.
 *
 * Dispatch is per-NDEF-RECORD-MIME, NOT per-chip — OpenTag3D ships on both NFC-A
 * (NTAG) and NFC-V (SLIX2), and OpenPrintTag on NFC-V, so the chip family does
 * not determine the format. Bambu MIFARE Classic is NOT in this registry: it is
 * a non-NDEF, block-encrypted format handled separately, though it emits the
 * same DecodedOpenPrintTag output shape.
 *
 * DB-free + browser-safe so desktop, server, and tests share ONE decoder.
 */

import type { NdefRecord } from "./ndef";
import { decodeOpenPrintTagBinary, type DecodedOpenPrintTag } from "./openprinttag-decode";
import { decodeOpenTag3DTag } from "./opentag3d-decode";
import { OPENTAG3D_MIME } from "./opentag3d";

/** NDEF media-type of an OpenPrintTag (Prusa) record. */
export const OPENPRINTTAG_MIME = "application/vnd.openprinttag";

export interface TagCodec {
  id: "openprinttag" | "opentag3d";
  /** The NDEF media-type MIME (TNF=0x02) this codec owns. */
  ndefMime: string;
  /** Decode the record payload into the shared decoded shape. */
  decode: (payload: Uint8Array) => DecodedOpenPrintTag;
}

/**
 * Registration order = preference when a tag carries more than one recognized
 * record. OpenPrintTag is preferred (it is the format this app natively writes
 * and models most richly); OpenTag3D follows.
 */
export const TAG_CODECS: readonly TagCodec[] = [
  { id: "openprinttag", ndefMime: OPENPRINTTAG_MIME, decode: decodeOpenPrintTagBinary },
  { id: "opentag3d", ndefMime: OPENTAG3D_MIME, decode: decodeOpenTag3DTag },
];

/** The first registered codec whose MIME matches a present media (TNF=0x02) record. */
export function selectCodec(
  records: NdefRecord[],
): { codec: TagCodec; record: NdefRecord } | null {
  for (const codec of TAG_CODECS) {
    const record = records.find((r) => r.tnf === 0x02 && r.type === codec.ndefMime);
    if (record) return { codec, record };
  }
  return null;
}

/**
 * Decode the first recognized NDEF record from a parsed record set, or null when
 * none of the registered formats are present (a clean "unknown tag" signal, not
 * an error).
 */
export function decodeFromNdefRecords(records: NdefRecord[]): DecodedOpenPrintTag | null {
  const selected = selectCodec(records);
  return selected ? selected.codec.decode(selected.record.payload) : null;
}
