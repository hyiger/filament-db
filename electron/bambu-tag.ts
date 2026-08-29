/**
 * Bambu Lab MIFARE Classic NFC tag decoder.
 *
 * The implementation lives in `src/lib/bambuTag.ts` so the `POST
 * /api/nfc/decode` route can import it (the route tsconfig excludes
 * `electron/`); this shim keeps existing `./bambu-tag` imports unchanged.
 */
export * from "../src/lib/bambuTag";
