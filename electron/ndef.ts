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

// ── NDEF wrapping (for writing to tag) ──────────────────────────────

/**
 * Wrap a CBOR payload into a complete NFC-V tag memory image.
 *
 * @param cborPayload - The OpenPrintTag CBOR binary (meta + main maps)
 * @param tagMemorySize - Total user memory in bytes (default 320 for SLIX2: 80 blocks × 4 bytes)
 * @returns Complete tag memory image ready to be written block-by-block
 */
export function wrapNdefForTag(
  cborPayload: Uint8Array,
  tagMemorySize: number = 320,
): Uint8Array {
  // Build the NDEF record
  const typeLen = NDEF_MIME_TYPE_BYTES.length; // 28
  const payloadLen = cborPayload.length;

  // NDEF record header:
  //   Byte 0: flags (MB=1, ME=1, CF=0, SR=?, IL=0, TNF=010)
  //   Byte 1: TYPE_LENGTH
  //   Byte 2-5 or Byte 2: PAYLOAD_LENGTH (4 bytes if !SR, 1 byte if SR)
  //   Then: TYPE, PAYLOAD
  const isShortRecord = payloadLen <= 255;
  const ndefRecordHeaderLen = 2 + (isShortRecord ? 1 : 4); // flags + type_len + payload_len
  const ndefRecordLen = ndefRecordHeaderLen + typeLen + payloadLen;

  // Build NDEF record
  const ndefRecord = new Uint8Array(ndefRecordLen);
  let pos = 0;

  // Flags: MB=1, ME=1, CF=0, SR=?, IL=0, TNF=010
  ndefRecord[pos++] = isShortRecord ? 0xd2 : 0xc2;
  // TYPE_LENGTH
  ndefRecord[pos++] = typeLen;
  // PAYLOAD_LENGTH
  if (isShortRecord) {
    ndefRecord[pos++] = payloadLen;
  } else {
    ndefRecord[pos++] = (payloadLen >>> 24) & 0xff;
    ndefRecord[pos++] = (payloadLen >>> 16) & 0xff;
    ndefRecord[pos++] = (payloadLen >>> 8) & 0xff;
    ndefRecord[pos++] = payloadLen & 0xff;
  }
  // TYPE
  ndefRecord.set(NDEF_MIME_TYPE_BYTES, pos);
  pos += typeLen;
  // PAYLOAD
  ndefRecord.set(cborPayload, pos);

  // TLV: tag=0x03, length, value=ndefRecord
  const ndefMessageLen = ndefRecordLen;
  const useLongTlv = ndefMessageLen >= 255;
  const tlvHeaderLen = useLongTlv ? 4 : 2; // tag + (FF + 2-byte len) or (1-byte len)

  // CC (4 bytes) + TLV header + NDEF message + terminator (1 byte)
  const totalLen = 4 + tlvHeaderLen + ndefMessageLen + 1;

  if (totalLen > tagMemorySize) {
    throw new Error(
      `Payload too large for tag: ${totalLen} bytes needed, ${tagMemorySize} available`,
    );
  }

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

  // NDEF record
  tagMemory.set(ndefRecord, offset);
  offset += ndefRecordLen;

  // TLV terminator
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
