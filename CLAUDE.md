@AGENTS.md

# Filament DB

Next.js 16 + Electron desktop app for managing 3D printing filament profiles with NFC tag support.

## Commands

```bash
npm run dev              # Next.js dev server (localhost:3456)
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
- **NFC**: nfc-pcsc + @pokusew/pcsclite (native module, requires PC/SC headers on Linux). Reads OpenPrintTag (NFC-V/ISO 15693) and Bambu Lab MIFARE Classic (ISO 14443-3A) tags

## Project Layout

```
src/app/            App Router pages + API routes (incl. v1.11: dashboard, locations, analytics, share, compare)
src/app/api/        REST API (incl. v1.11: /locations, /print-history, /analytics, /share, /spools/import)
src/components/     React components (NfcProvider, Toast, dialogs, ThemeProvider, UpdateBanner, AppNav)
src/hooks/          Custom hooks (useNfc, useCurrency)
src/i18n/           Translations + provider (en, de)
src/lib/            Core logic (openprinttag CBOR, NDEF, TDS extraction, INI parser, CSV parser, image compression, theme init script, spool validator, PrusaSlicer bundle, OpenPrintTag DB browser)
src/models/         Mongoose schemas (Filament, Nozzle, Printer, BedType, Location, PrintHistory, SharedCatalog)
src/types/          TypeScript type defs (electron.d.ts, filament.ts)
electron/           Electron main process (main.ts, preload.ts, ndef.ts, bambu-tag.ts, auto-updater.ts)
tests/              Vitest tests — unit + Mongoose model + Next.js route (mirrors src structure)
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
- **Bambu NFC**: MIFARE Classic decoder in `electron/bambu-tag.ts`. HKDF-SHA256 key derivation from UID, binary block parser, maps to `DecodedOpenPrintTag`. Read-only (RSA-2048 signed tags)

## Internationalization (i18n)

- **Framework**: Custom React Context-based i18n (no external library), following the useCurrency pattern
- **Provider**: `src/i18n/TranslationProvider.tsx` — provides `t(key, params?)`, `locale`, `setLocale`
- **Locales**: `src/i18n/locales/en.json` (English), `src/i18n/locales/de.json` (German) — 737+ flat key-value pairs
- **Interpolation**: `{paramName}` tokens in translation strings, e.g. `t("sync.time.minutesAgo", { count: 5 })`
- **Fallback chain**: current locale → English → raw key
- **Persistence**: electron-store (desktop) or localStorage (web), key `filamentdb-locale`
- **Settings**: Language selector in Settings page (same toggle-button pattern as Currency)
- **Adding a language**: Create `src/i18n/locales/xx.json` with all keys, add entry to `LOCALES` array in `src/i18n/index.ts`

## Testing

- 635+ tests across 35+ files (unit + Mongoose model + Next.js route handlers)
- Coverage thresholds: 80% lines/statements, 90% functions, 75% branches (enforced on `src/lib/**` and `src/models/**`; `src/lib/compressImage.ts` is excluded because its main flow is DOM-only)
- Setup file: `tests/setup.ts` (mongodb-memory-server). **Caveat**: setup wipes `mongoose.models` between tests; route-level tests that use `.populate(...)` must re-register models in `beforeEach` by calling `mongoose.model(name, schema)` directly (see `tests/locations-route.test.ts` for the pattern).
- Tests run in CI on Node 20 and 22

## CI/CD

- **Tests**: Run on push to main and PRs (`test.yml`)
- **Releases**: Triggered by `v*` tags (`release.yml`). Builds macOS (x64+arm64), Windows (x64), Linux (x64+arm64). Uploads assets to GitHub release.
- **Docker**: Triggered by `v*` tags (`docker.yml`). Builds multi-arch (amd64+arm64) Docker image and pushes to GHCR.
- **Lint rule**: `react-hooks/set-state-in-effect` — don't call setState directly in useEffect body; use lazy initializers or callbacks

## Release Process

1. Update version in `package.json`
2. Commit and push to main
3. Tag with `git tag v<version>` and push tag
4. CI builds desktop installers and uploads to GitHub release
5. Apply release notes with `gh release edit`

## PrusaSlicer Integration

- **Config bundle API**: `GET /api/filaments/prusaslicer` exports filaments as PrusaSlicer INI bundle; `POST` imports bundles back
- **Calibration API**: `GET /api/filaments/{id}/calibration?nozzle_diameter=0.4&high_flow=0|1` returns per-nozzle calibration data (extrusion multiplier, pressure advance, max volumetric speed, retraction); used by PrusaSlicer to auto-adjust filament settings when the user switches printer presets. Optional `high_flow` param disambiguates standard vs high-flow nozzles at the same diameter.
- **Spool check API**: `GET /api/filaments/{id}/spool-check?weight=42.5` checks whether any spool has enough remaining filament (by weight in grams) for a print job. PrusaSlicer calls this after slicing to warn if insufficient filament.
- **Sync with calibration context**: `POST /api/filaments/{id}?nozzle_diameter=0.4&high_flow=0|1` accepts optional query params so PrusaSlicer can write calibration-related keys (EM, PA, retraction) to the correct per-nozzle calibration entry
- **Field mapping**: `src/lib/prusaSlicerBundle.ts` maps structured DB fields → PrusaSlicer INI keys, merges with `settings` bag
- **Nil handling**: Structured DB fields that are null must NOT emit `nil` in the INI output — PrusaSlicer interprets nil as "reset to zero" for numeric fields. Only settings bag nil values (meaning "inherit from parent") are preserved.
- **PrusaSlicer Filament Edition**: [hyiger/PrusaSlicer](https://github.com/hyiger/PrusaSlicer) has a `FilamentDB` module that fetches presets on startup via the REST API, syncs changes back with per-nozzle calibration context
- **Port**: All modes (dev, desktop, Docker) use port **3456** (hardcoded in `electron/main.ts`, `next dev -p 3456` for dev). PrusaSlicer defaults to `http://localhost:3456`.

## OpenPrintTag Database Browser

- **Page**: `/openprinttag` — browse the OpenPrintTag community database (11k+ materials)
- **API**: `GET /api/openprinttag` fetches GitHub tarball, parses YAML, filters to FFF, caches 1 hour
- **Import**: `POST /api/openprinttag/import` with `{ slugs: [...] }` — upserts by name
- **Completeness scoring**: 0–10 scale (color, density, print temps, bed temps, drying temp, hardness, TD, chamber, photos, url)
- **Tiers**: rich (7–10 green), partial (4–6 yellow), stub (0–3 grey/dimmed)

## v1.11 Features

- **Locations**: `src/models/Location.ts` + `src/app/api/locations`. Spools reference `locationId`. Delete is refused while any spool still references the location.
- **Print history**: `src/models/PrintHistory.ts` + `src/app/api/print-history`. Top-level job ledger. POST does two-pass validation (fetch all filaments → validate existence → mutate + save) wrapped in a Mongoose transaction when available, with a sequential-saves fallback for standalone mongod. Spool `usageHistory` entries it writes are tagged `source: "job"`.
- **Analytics**: `src/app/api/analytics`. Aggregates from PrintHistory plus `spool.usageHistory` entries with `source === "manual"` (direct-edit entries only, to avoid double-counting job entries).
- **Shared catalogs**: `src/models/SharedCatalog.ts` + `src/app/api/share`. Publishes a static snapshot of filaments + referenced nozzles/printers/bed-types under an auto-generated slug. Public GET uses `findOneAndUpdate($inc)` for atomic view counting.
- **Dashboard / Compare / Analytics pages**: `/dashboard`, `/compare`, `/analytics` under `src/app/`.
- **System theme**: `src/components/ThemeProvider.tsx` + `src/lib/themeInitScript.ts`. The init script runs inline before React mounts to avoid light-flash on dark-mode cold loads.
- **Auto-update**: `electron/auto-updater.ts`. IPC handlers registered unconditionally so the renderer can always call `update-get-status`; mutating actions short-circuit to `{ ok: false, error: "dev-mode" }` when `!app.isPackaged`. The install dialog accepts an optional `strings` IPC argument so the OS-native dialog honours the user's current locale (renderer owns the i18n catalog).
- **Spool bulk CSV import**: `src/app/api/spools/import`. Row limit 10,000 (enforced inside `parseCsv`, throws `CsvRowLimitExceededError`). Auto-creates locations by name.
- **Spool validation**: `src/lib/validateSpoolBody.ts`. `photoDataUrl` MIME allow-list is narrow (JPEG/PNG/GIF/WebP/AVIF/HEIC) — SVG is explicitly rejected because `<script>` inside SVG can execute in some rendering contexts.

Note: SLIX2 NFC tags have write-protected block 79. The NDEF wrapper reserves the last 4 bytes (`usableMemory = tagMemorySize - 4`).
