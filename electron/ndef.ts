/**
 * NDEF codec for OpenPrintTag NFC-V tags.
 *
 * The implementation lives in `src/lib/ndef.ts` so the `POST /api/nfc/decode`
 * route can import it (the route tsconfig excludes `electron/`); this shim
 * keeps existing `./ndef` imports unchanged.
 */
export * from "../src/lib/ndef";
