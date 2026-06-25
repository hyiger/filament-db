import { Platform } from 'react-native';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import { bytesToAscii, bytesToBase64 } from './base64';

/**
 * NFC reading for Phase 1 — OpenPrintTag only (ISO 15693 / NFC-V), which reads
 * on both iOS and Android. The tag is NDEF-wrapped CBOR; we read the NDEF
 * record, base64 its payload, and let `POST /api/nfc/decode` do the decoding.
 *
 * iOS reads via an ISO 15693 **tag** session (NFCTagReaderSession) +
 * getNdefMessage(), NOT NfcTech.Ndef. An NFCISO15693Tag conforms to NFCNDEFTag,
 * so a tag session can still read the NDEF — and it needs only the `TAG`
 * reader-format entitlement. Apple's iOS 26 SDK rejects the `NDEF` format value
 * at App Store submission (error 90778), so the app no longer ships it
 * (app.config.ts: includeNdefEntitlement: false → entitlement is `['TAG']`).
 * Android has no NFC entitlement and its Ndef tech reads the NDEF directly, so
 * it keeps using NfcTech.Ndef.
 *
 * Bambu (MIFARE Classic) is Phase 2 and Android-only — iPhone's Core NFC can't
 * read MIFARE Classic at all (see docs/mobile-app-plan.md §2).
 */

const OPT_MIME = 'application/vnd.openprinttag';
// #864: OpenTag3D records (a separate, fixed-binary standard) carry this MIME.
// On Android (NfcTech.Ndef) this reads OpenTag3D on both NTAG and SLIX2; on iOS
// the Iso15693IOS session below reads SLIX2 OpenTag3D (NTAG-on-iOS would need an
// NDEF tag session — a follow-up).
const OPT3D_MIME = 'application/opentag3d';

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
  /** Which NDEF format the record carried — forwarded as the decode endpoint's
   *  `tagType`. OpenPrintTag is CBOR; OpenTag3D is a fixed binary memory map. */
  tagType: 'openprinttag' | 'opentag3d';
  /** base64 of the NDEF record payload — the decode endpoint's `payload`. */
  payload: string;
}

/**
 * Read an OpenPrintTag and return its CBOR payload base64-encoded, ready to
 * POST to `/api/nfc/decode`. Always releases the NFC technology request, even
 * on error/cancel, so the reader doesn't stay locked.
 */
export async function readOpenPrintTag(): Promise<OpenPrintTagScan> {
  await ensureStarted();
  const isIOS = Platform.OS === 'ios';
  // iOS: ISO 15693 tag session → getNdefMessage() (TAG entitlement only).
  // Android: Ndef tech → getTag().ndefMessage (no entitlement). See file docblock.
  await NfcManager.requestTechnology(isIOS ? NfcTech.Iso15693IOS : NfcTech.Ndef);
  try {
    const event = isIOS
      ? await NfcManager.ndefHandler.getNdefMessage()
      : await NfcManager.getTag();
    const records = event?.ndefMessage ?? [];
    // nfc-manager types record `type`/`payload` as `string | number[]`; we only
    // handle the byte-array form (what a Type 5 / NDEF read yields).
    const hasPayload = (r: { payload?: unknown }) =>
      Array.isArray(r.payload) && r.payload.length > 0;
    // Prefer OpenPrintTag when both records coexist on one tag (mirrors the
    // server codec registry's preference). Then fall back to OpenTag3D (#864).
    const opt = records.find(
      (r) => Array.isArray(r.type) && bytesToAscii(r.type) === OPT_MIME && hasPayload(r),
    );
    if (opt && Array.isArray(opt.payload)) {
      return { tagType: 'openprinttag', payload: bytesToBase64(opt.payload) };
    }
    const ot3d = records.find(
      (r) => Array.isArray(r.type) && bytesToAscii(r.type) === OPT3D_MIME && hasPayload(r),
    );
    if (ot3d && Array.isArray(ot3d.payload)) {
      return { tagType: 'opentag3d', payload: bytesToBase64(ot3d.payload) };
    }
    throw new Error('No OpenPrintTag or OpenTag3D data on this tag.');
  } finally {
    await NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}
