/**
 * Dependency-free byte helpers for NFC payloads. React Native has no `Buffer`
 * and no reliable global `btoa`, so the NFC layer base64-encodes raw tag bytes
 * here before POSTing them to `/api/nfc/decode`.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode a byte array (e.g. an NDEF record payload) as standard base64. */
export function bytesToBase64(bytes: ArrayLike<number>): string {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i] & 0xff;
    const b1 = i + 1 < n ? bytes[i + 1] & 0xff : 0;
    const b2 = i + 2 < n ? bytes[i + 2] & 0xff : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < n ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < n ? B64[b2 & 0x3f] : '=';
  }
  return out;
}

/** Decode a byte array as Latin-1/ASCII text (used to read an NDEF record type). */
export function bytesToAscii(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
  return s;
}
