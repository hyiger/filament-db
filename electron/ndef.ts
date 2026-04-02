/**
 * NDEF message construction and parsing for OpenPrintTag NFC-V tags.
 *
 * Tag memory layout (ISO 15693 / NFC Forum Type 5):
 *   [CC 4B] [NDEF TLV] [NDEF Record] [TLV Terminator 0xFE]
 *
 * CC = Capability Container:
 *   Byte 0: 0xE1 (magic)
 *   Byte 1: 0x40 (version 1.0, read/write access)
 *   Byte 2: memory size / 8
 *   Byte 3: 0x01 (supports Read Multiple Blocks for SLIX2)
 *
 * NDEF Record type: "application/vnd.openprinttag" (media type, TNF=0x02)
 */

const NDEF_MIME_TYPE = "application/vnd.openprinttag";
const NDEF_MIME_TYPE_BYTES = new TextEncoder().encode(NDEF_MIME_TYPE);

// URI prefix codes (NFC Forum RTD URI)
const URI_PREFIX: Record<number, string> = {
  0x00: "",
  0x01: "http://www.",
  0x02: "https://www.",
  0x03: "http://",
  0x04: "https://",
};

/**
 * Build an NDEF URI record (Well-Known type, TNF=0x01, type="U").
 * Uses NFC Forum URI prefix compression.
 */
function buildUriRecord(url: string, isFirst: boolean, isLast: boolean): Uint8Array {
  // Find the best matching prefix for compression
  let prefixCode = 0x00;
  let remainder = url;
  for (const [code, prefix] of Object.entries(URI_PREFIX)) {
    if (prefix && url.startsWith(prefix) && prefix.length > (URI_PREFIX[prefixCode]?.length ?? 0)) {
      prefixCode = Number(code);
      remainder = url.slice(prefix.length);
    }
  }

  const remainderBytes = new TextEncoder().encode(remainder);
  const payloadLen = 1 + remainderBytes.length; // prefix code byte + URI remainder
  const isShort = payloadLen <= 255;

  // Flags: MB, ME, CF=0, SR, IL=0, TNF=001 (Well-Known)
  let flags = 0x01; // TNF = Well-Known
  if (isFirst) flags |= 0x80; // MB
  if (isLast) flags |= 0x40; // ME
  if (isShort) flags |= 0x10; // SR

  const headerLen = 2 + (isShort ? 1 : 4); // flags + type_len + payload_len
  const record = new Uint8Array(headerLen + 1 + payloadLen); // +1 for type "U"
  let pos = 0;

  record[pos++] = flags;
  record[pos++] = 1; // TYPE_LENGTH = 1 ("U")
  if (isShort) {
    record[pos++] = payloadLen;
  } else {
    record[pos++] = (payloadLen >>> 24) & 0xff;
    record[pos++] = (payloadLen >>> 16) & 0xff;
    record[pos++] = (payloadLen >>> 8) & 0xff;
    record[pos++] = payloadLen & 0xff;
  }
  record[pos++] = 0x55; // TYPE = "U" (URI)
  record[pos++] = prefixCode;
  record.set(remainderBytes, pos);

  return record;
}

// ── NDEF wrapping (for writing to tag) ──────────────────────────────

/**
 * Wrap a CBOR payload into a complete NFC-V tag memory image.
 *
 * Produces an NDEF message with one or two records:
 *   1. (optional) URI record pointing to a product URL — required by some
 *      NFC readers (e.g. Prusa app) for compatibility.
 *   2. OpenPrintTag record with the CBOR payload.
 *
 * @param cborPayload - The OpenPrintTag CBOR binary (meta + main maps)
 * @param tagMemorySize - Total user memory in bytes (default 320 for SLIX2: 80 blocks × 4 bytes)
 * @param productUrl - Optional product URL for a leading URI NDEF record
 * @returns Complete tag memory image ready to be written block-by-block
 */
export function wrapNdefForTag(
  cborPayload: Uint8Array,
  tagMemorySize: number = 320,
  productUrl?: string,
): Uint8Array {
  const hasUri = !!productUrl;

  // Calculate overhead to determine how much space we can give the OPT payload.
  // The Prusa app expects the aux_region_offset (in the CBOR meta map) to point
  // to valid CBOR *within* the NDEF record payload. To achieve this, we pad the
  // CBOR payload with zeros and place the TLV terminator at the very end of
  // tag memory, filling the OPT record payload to use all remaining space.
  //
  // Reserve the last block (4 bytes) since SLIX2 block 79 is often write-protected.
  const usableMemory = tagMemorySize - 4;

  const typeLen = NDEF_MIME_TYPE_BYTES.length; // 28

  // Build the URI record first (if any) so we know its size
  let uriRecord: Uint8Array | null = null;
  if (hasUri) {
    uriRecord = buildUriRecord(productUrl!, true, false); // MB=1, ME=0
  }

  // Calculate fixed overhead:
  //   CC (4) + TLV header (2 or 4) + URI record (variable) +
  //   OPT record header (2 + payload_len_bytes) + OPT type (28) + terminator (1)
  const uriLen = uriRecord?.length ?? 0;

  // We need to figure out OPT payload size, but it depends on whether SR (short record)
  // is used, which depends on the payload size. Iterate to find the right fit.
  // Start by assuming the CBOR fills all remaining space.
  // Try SR=1 first (payload <= 255), then fall back to SR=0.
  let paddedPayloadLen: number;
  let isShortRecord: boolean;

  // With SR=1: overhead = 4 + tlv_header + uriLen + 3 (flags+typelen+payloadlen) + 28 + 1
  const overheadSR1_shortTlv = 4 + 2 + uriLen + 3 + typeLen + 1;
  const overheadSR1_longTlv = 4 + 4 + uriLen + 3 + typeLen + 1;

  // With SR=0: overhead = 4 + tlv_header + uriLen + 6 (flags+typelen+4B payloadlen) + 28 + 1
  const overheadSR0_longTlv = 4 + 4 + uriLen + 6 + typeLen + 1;

  // Try SR=1 with short TLV first
  let candidatePayload = usableMemory - overheadSR1_shortTlv;
  const candidateNdefLen = uriLen + 3 + typeLen + candidatePayload;

  if (candidatePayload <= 255 && candidateNdefLen < 255) {
    // SR=1, short TLV works
    paddedPayloadLen = candidatePayload;
    isShortRecord = true;
  } else {
    // Try SR=1 with long TLV
    candidatePayload = usableMemory - overheadSR1_longTlv;
    if (candidatePayload <= 255) {
      paddedPayloadLen = candidatePayload;
      isShortRecord = true;
    } else {
      // SR=0, long TLV
      paddedPayloadLen = usableMemory - overheadSR0_longTlv;
      isShortRecord = false;
    }
  }

  // Ensure the padded payload is at least as large as the actual CBOR data
  if (paddedPayloadLen < cborPayload.length) {
    throw new Error(
      `Payload too large for tag: ${cborPayload.length} CBOR bytes but only ${paddedPayloadLen} available`,
    );
  }

  // Build the padded CBOR payload (original data + zero padding)
  const paddedCbor = new Uint8Array(paddedPayloadLen);
  paddedCbor.set(cborPayload, 0);
  // Remaining bytes are already zero-filled

  // Build OPT NDEF record
  const ndefRecordHeaderLen = 2 + (isShortRecord ? 1 : 4);
  const ndefRecordLen = ndefRecordHeaderLen + typeLen + paddedPayloadLen;
  const ndefRecord = new Uint8Array(ndefRecordLen);
  let pos = 0;

  // Flags: MB=? (1 if no URI, 0 if URI precedes), ME=1, CF=0, SR=?, IL=0, TNF=010
  let optFlags = 0x42; // ME=1, TNF=010
  if (!hasUri) optFlags |= 0x80; // MB=1 (this is the first and only record)
  if (isShortRecord) optFlags |= 0x10; // SR=1
  ndefRecord[pos++] = optFlags;
  // TYPE_LENGTH
  ndefRecord[pos++] = typeLen;
  // PAYLOAD_LENGTH
  if (isShortRecord) {
    ndefRecord[pos++] = paddedPayloadLen;
  } else {
    ndefRecord[pos++] = (paddedPayloadLen >>> 24) & 0xff;
    ndefRecord[pos++] = (paddedPayloadLen >>> 16) & 0xff;
    ndefRecord[pos++] = (paddedPayloadLen >>> 8) & 0xff;
    ndefRecord[pos++] = paddedPayloadLen & 0xff;
  }
  // TYPE
  ndefRecord.set(NDEF_MIME_TYPE_BYTES, pos);
  pos += typeLen;
  // PAYLOAD (padded CBOR)
  ndefRecord.set(paddedCbor, pos);

  // Build the full NDEF message (URI record + OPT record, or just OPT record)
  let ndefMessage: Uint8Array;
  if (uriRecord) {
    ndefMessage = new Uint8Array(uriRecord.length + ndefRecordLen);
    ndefMessage.set(uriRecord, 0);
    ndefMessage.set(ndefRecord, uriRecord.length);
  } else {
    ndefMessage = ndefRecord;
  }

  // TLV: tag=0x03, length, value=ndefMessage
  const ndefMessageLen = ndefMessage.length;
  const useLongTlv = ndefMessageLen >= 255;

  // Allocate full tag memory (zero-filled)
  const tagMemory = new Uint8Array(tagMemorySize);
  let offset = 0;

  // CC
  tagMemory[offset++] = 0xe1; // magic
  tagMemory[offset++] = 0x40; // version 1.0, read/write
  tagMemory[offset++] = Math.floor(tagMemorySize / 8); // MLEN
  tagMemory[offset++] = 0x01; // Read Multiple Blocks supported

  // NDEF TLV
  tagMemory[offset++] = 0x03; // NDEF Message TLV tag
  if (useLongTlv) {
    tagMemory[offset++] = 0xff;
    tagMemory[offset++] = (ndefMessageLen >> 8) & 0xff;
    tagMemory[offset++] = ndefMessageLen & 0xff;
  } else {
    tagMemory[offset++] = ndefMessageLen;
  }

  // NDEF message (URI record + OPT record with padded payload)
  tagMemory.set(ndefMessage, offset);
  offset += ndefMessageLen;

  // TLV terminator at the very end of tag memory (after the padded NDEF message)
  tagMemory[offset++] = 0xfe;

  return tagMemory;
}

// ── NDEF parsing (for reading from tag) ─────────────────────────────

/**
 * Parse raw tag memory and extract the OpenPrintTag CBOR payload.
 *
 * @param raw - Raw tag memory bytes (from reading all blocks)
 * @returns The CBOR payload (meta + main maps)
 * @throws If no valid NDEF record with OpenPrintTag MIME type is found
 */
export function parseNdefFromTag(raw: Uint8Array): Uint8Array {
  if (raw.length < 8) {
    throw new Error("Tag data too short");
  }

  // Validate CC
  if (raw[0] !== 0xe1) {
    throw new Error(`Invalid CC magic byte: 0x${raw[0].toString(16)}`);
  }

  let offset = 4; // skip CC

  // Find NDEF TLV (tag 0x03)
  while (offset < raw.length - 1) {
    const tlvTag = raw[offset++];

    if (tlvTag === 0xfe) {
      // Terminator
      throw new Error("No NDEF TLV found before terminator");
    }

    if (tlvTag === 0x00) {
      // NULL TLV, skip
      continue;
    }

    // Parse TLV length
    let tlvLen: number;
    if (offset >= raw.length) {
      throw new Error("Tag data truncated: no TLV length byte");
    }
    if (raw[offset] === 0xff) {
      // 3-byte length format
      offset++;
      if (offset + 2 > raw.length) {
        throw new Error("Tag data truncated: incomplete 3-byte TLV length");
      }
      tlvLen = (raw[offset] << 8) | raw[offset + 1];
      offset += 2;
    } else {
      tlvLen = raw[offset++];
    }

    if (offset + tlvLen > raw.length) {
      throw new Error(`Tag data truncated: TLV claims ${tlvLen} bytes but only ${raw.length - offset} remain`);
    }

    if (tlvTag === 0x03) {
      // Found NDEF Message TLV — parse the NDEF record inside
      return parseNdefRecord(raw, offset, tlvLen);
    }

    // Skip unknown TLV
    offset += tlvLen;
  }

  throw new Error("No NDEF TLV found in tag data");
}

/**
 * Parse an NDEF record and extract the payload.
 * Searches for the OpenPrintTag MIME type record.
 */
function parseNdefRecord(
  data: Uint8Array,
  offset: number,
  messageLen: number,
): Uint8Array {
  const messageEnd = offset + messageLen;

  while (offset < messageEnd) {
    if (offset + 2 > data.length) {
      throw new Error("NDEF record truncated: not enough bytes for record header");
    }

    const flags = data[offset++];
    const tnf = flags & 0x07;
    const isShortRecord = (flags & 0x10) !== 0;
    const hasIdLength = (flags & 0x08) !== 0;

    const typeLength = data[offset++];

    let payloadLength: number;
    if (isShortRecord) {
      if (offset >= data.length) throw new Error("NDEF record truncated: missing payload length");
      payloadLength = data[offset++];
    } else {
      if (offset + 4 > data.length) throw new Error("NDEF record truncated: incomplete payload length");
      payloadLength =
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3];
      offset += 4;
    }

    let idLength = 0;
    if (hasIdLength) {
      if (offset >= data.length) throw new Error("NDEF record truncated: missing ID length");
      idLength = data[offset++];
    }

    if (offset + typeLength + idLength + payloadLength > data.length) {
      throw new Error("NDEF record truncated: type + id + payload exceeds available data");
    }

    // Read type
    const typeBytes = data.slice(offset, offset + typeLength);
    offset += typeLength;

    // Skip ID
    offset += idLength;

    // Read payload
    const payload = data.slice(offset, offset + payloadLength);
    offset += payloadLength;

    // Check if this is the OpenPrintTag record (TNF=0x02, media type)
    if (tnf === 0x02) {
      const typeStr = new TextDecoder().decode(typeBytes);
      if (typeStr === NDEF_MIME_TYPE) {
        return payload;
      }
    }

    // If ME (Message End) bit is set, stop
    if (flags & 0x40) break;
  }

  throw new Error(
    `No NDEF record with type "${NDEF_MIME_TYPE}" found`,
  );
}
