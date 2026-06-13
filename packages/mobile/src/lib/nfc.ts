import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import { bytesToAscii, bytesToBase64 } from './base64';

/**
 * NFC reading for Phase 1 — OpenPrintTag only (ISO 15693 / NFC-V), which reads
 * on both iOS and Android. The tag is NDEF-wrapped CBOR; we read the NDEF
 * record, base64 its payload, and let `POST /api/nfc/decode` do the decoding.
 *
 * Bambu (MIFARE Classic) is Phase 2 and Android-only — iPhone's Core NFC can't
 * read MIFARE Classic at all (see docs/mobile-app-plan.md §2).
 */

const OPT_MIME = 'application/vnd.openprinttag';

let started = false;
async function ensureStarted(): Promise<void> {
  if (started) return;
  await NfcManager.start();
  started = true;
}

/** True when this device has NFC hardware that is on. */
export async function isNfcAvailable(): Promise<boolean> {
  try {
    await ensureStarted();
    const supported = await NfcManager.isSupported();
    if (!supported) return false;
    return await NfcManager.isEnabled();
  } catch {
    return false;
  }
}

export interface OpenPrintTagScan {
  tagType: 'openprinttag';
  /** base64 of the NDEF record payload (CBOR) — the decode endpoint's `payload`. */
  payload: string;
}

/**
 * Read an OpenPrintTag and return its CBOR payload base64-encoded, ready to
 * POST to `/api/nfc/decode`. Always releases the NFC technology request, even
 * on error/cancel, so the reader doesn't stay locked.
 */
export async function readOpenPrintTag(): Promise<OpenPrintTagScan> {
  await ensureStarted();
  await NfcManager.requestTechnology(NfcTech.Ndef);
  try {
    const tag = await NfcManager.getTag();
    const records = tag?.ndefMessage ?? [];
    // nfc-manager types record `type`/`payload` as `string | number[]`; we only
    // handle the byte-array form (what a Type 5 / NDEF read yields).
    const opt = records.find(
      (r) => Array.isArray(r.type) && bytesToAscii(r.type) === OPT_MIME,
    );
    if (!opt || !Array.isArray(opt.payload) || opt.payload.length === 0) {
      throw new Error('No OpenPrintTag data on this tag.');
    }
    return { tagType: 'openprinttag', payload: bytesToBase64(opt.payload) };
  } finally {
    await NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}
