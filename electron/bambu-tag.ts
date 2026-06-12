/**
 * Bambu Lab MIFARE Classic NFC tag decoder.
 *
 * The implementation moved to `src/lib/bambuTag.ts` (GH: mobile-scanner Phase
 * 0) so a Next.js API route — `POST /api/nfc/decode` — can import it; the
 * route tsconfig excludes `electron/`. This shim re-exports it so the Electron
 * main process (`nfc-service.ts`) and the existing tests keep importing from
 * `./bambu-tag` unchanged. The module uses Node `crypto` (`hkdfSync`) +
 * `Buffer`, both available in the Electron main and the Next.js Node runtime.
 */
export * from "../src/lib/bambuTag";
