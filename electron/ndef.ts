/**
 * NDEF codec for OpenPrintTag NFC-V tags.
 *
 * The implementation moved to `src/lib/ndef.ts` (GH: mobile-scanner Phase 0)
 * so a Next.js API route — `POST /api/nfc/decode` — can import it; the route
 * tsconfig excludes `electron/`. This shim re-exports it so the Electron main
 * process (`nfc-service.ts`), the CLI scripts, and the existing tests keep
 * importing from `./ndef` unchanged. The module is pure TypeScript (no Node
 * native deps), so it runs in both the Electron main and the server runtime.
 */
export * from "../src/lib/ndef";
