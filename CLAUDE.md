@AGENTS.md

# Filament DB

Next.js 16 + Electron desktop app for managing 3D printing filament profiles with NFC tag support.

## Commands

```bash
npm run dev              # Next.js dev server (localhost:3000)
npm run build            # Production build
npm run lint             # ESLint
npm test                 # Vitest (single run)
npm run test:watch       # Vitest (watch mode)
npm run test:coverage    # Vitest with coverage
npm run electron:dev     # Electron + Next.js dev
npm run electron:build   # Full Electron build pipeline
```

## Architecture

- **Frontend**: Next.js App Router (TypeScript, React 19, Tailwind CSS)
- **Backend**: Next.js API routes under `src/app/api/`
- **Desktop**: Electron with esbuild-compiled main/preload (`electron/`)
- **Database**: Mongoose ODM with MongoDB Atlas (cloud), embedded MongoDB (offline), or hybrid mode
- **Tests**: Vitest with mongodb-memory-server; coverage enforced on `src/lib/` and `src/models/`
- **NFC**: nfc-pcsc + @pokusew/pcsclite (native module, requires PC/SC headers on Linux)

## Project Layout

```
src/app/            App Router pages + API routes
src/components/     React components (NfcProvider, Toast, dialogs)
src/hooks/          Custom hooks (useNfc, useCurrency)
src/lib/            Core logic (openprinttag CBOR, NDEF, TDS extraction, INI parser)
src/models/         Mongoose schemas (Filament, Nozzle, Printer)
src/types/          TypeScript type defs (electron.d.ts, filament.ts)
electron/           Electron main process (main.ts, preload.ts, ndef.ts)
tests/              Vitest tests (mirrors src structure)
scripts/            CLI tools (read-nfc-tag, seed import, backfill)
```

## Key Conventions

- **Path alias**: `@/` maps to `src/`
- **tsconfig excludes**: `node_modules`, `electron/`, `scripts/` (scripts use native modules unavailable in CI)
- **Standalone output**: Next.js builds in standalone mode for Electron bundling
- **Dark mode**: Use `dark:` Tailwind variants on all UI — app supports both light and dark themes
- **Electron config**: electron-store for desktop persistence (connection mode, AI keys, currency); localStorage fallback in web mode
- **IPC pattern**: `ipcMain.handle()` in `electron/main.ts`, exposed via `contextBridge` in `electron/preload.ts`, typed in `src/types/electron.d.ts`
- **OpenPrintTag**: CBOR encoder in `src/lib/openprinttag.ts`, NDEF wrapping in `electron/ndef.ts`. CBOR aux_region_offset must point to valid CBOR within the NDEF payload (Prusa app requirement)

## Testing

- 345 tests across 15 files
- Coverage thresholds: 80% lines/statements, 90% functions, 75% branches
- Setup file: `tests/setup.ts` (mongodb-memory-server)
- Tests run in CI on Node 20 and 22

## CI/CD

- **Tests**: Run on push to main and PRs (`test.yml`)
- **Releases**: Triggered by `v*` tags (`release.yml`). Builds macOS (x64+arm64), Windows (x64), Linux (x64+arm64). Uploads assets to GitHub release.
- **Lint rule**: `react-hooks/set-state-in-effect` — don't call setState directly in useEffect body; use lazy initializers or callbacks

## Release Process

1. Update version in `package.json`
2. Commit and push to main
3. Tag with `git tag v<version>` and push tag
4. CI builds desktop installers and uploads to GitHub release
5. Apply release notes with `gh release edit`

Note: SLIX2 NFC tags have write-protected block 79. The NDEF wrapper reserves the last 4 bytes (`usableMemory = tagMemorySize - 4`).
