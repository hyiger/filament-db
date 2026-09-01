/**
 * Label-printer transport — re-export shim.
 *
 * The implementation moved to `src/lib/labelTransport.ts` so the Next.js
 * server can reach it too: `electron/` is in the root tsconfig's `exclude`
 * and is bundled only into the Electron main process, so `src/app/api/**`
 * could never import from here (GH #1195).
 *
 * This file stays as the main-process entry point so `electron/main.ts`,
 * the two CLIs and `tests/label-printer.test.ts` keep their import paths.
 * Same pattern as `electron/ndef.ts` → `src/lib/ndef.ts` and
 * `electron/bambu-tag.ts` → `src/lib/bambuTag.ts`.
 *
 * The transport has no Electron dependency — only `node:child_process`,
 * `node:fs/promises`, `node:os` and `node:path` — which is what makes it
 * safe to run inside the server process.
 */
export * from "../src/lib/labelTransport";
