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
src/lib/            Core logic (openprinttag CBOR, NDEF, TDS extraction, INI parser, CSV parser, image compression, theme init script, spool validator, PrusaSlicer bundle, OpenPrintTag DB browser, safeRenderUrl, inventoryStats, externalUrlGuard)
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

- 868+ tests across 47+ files (unit + Mongoose model + Next.js route handlers). Exact counts drift on every PR — run `npm test` for the current numbers.
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

## v1.13 Features

- **Hybrid sync expansion**: bedtypes, printhistories, and sharedcatalogs now sync via the existing syncId / last-write-wins engine in `electron/sync-service.ts`. Sync order is nozzles → printers → locations → bedtypes → filaments → printhistories → sharedcatalogs. New cross-DB ref remaps: `calibrations[].bedType` (in the filament transform) and `printer.amsSlots[].filamentId` (post-filament-sync repair pass — printers sync before filaments to break the calibrations.printer ↔ amsSlots.filamentId reference cycle). **Limitation**: spool subdocuments don't have stable cross-side ids, so `printer.amsSlots[].spoolId` and `printhistory.usage[].spoolId` are cleared on cross-side remap. Per-filament gram totals still reconcile; per-spool attribution is dropped pending a separate spool-syncId migration.
- **Soft-delete tombstones for sync-safe deletion**: `PrintHistory` DELETE switched from `deleteOne` to `_deletedAt`-set so a delete on one peer propagates instead of getting resurrected by the other. The handler is idempotent — a retry / double-click / client-retry-after-timeout returns 404 instead of double-refunding spool weight (filters `findOne` on `_deletedAt: null`). `SharedCatalog` DELETE same treatment; the model gained `_deletedAt` + `syncId` fields and the slug index migrated from plain unique to partial-unique-on-non-deleted (auto-applied via `SharedCatalog.syncIndexes()` in the dbConnect migration block at `src/lib/mongodb.ts`). Per-migration retry tracking (`cached.migrations.{instanceIds, sharedCatalogIndexes}`) so a transient failure on one doesn't poison the cache.
- **External URL guard (Electron + render + storage)**: `electron/main.ts`'s `setWindowOpenHandler` parses URLs and only forwards `http(s)` to `shell.openExternal`; everything else (file:, javascript:, data:, custom protocols) is denied with a console warning. New `src/lib/safeRenderUrl.ts` exposes `isHttpUrl()` / `safeHttpUrl()` for client-side gating at every TDS / photo / product render site. `Filament.tdsUrl` has both a Mongoose validator and pre-update hooks (`updateOne`, `updateMany`, `findOneAndUpdate`) so non-http schemes can't slip in via the CSV-import path that doesn't pass `runValidators: true`.
- **TDS extractor SSRF redirect guard**: `src/lib/tdsExtractor.ts` switched from `redirect: "follow"` to manual hop-by-hop with a 5-redirect cap (`MAX_REDIRECTS`) and `assertExternalUrl` re-checked on every `Location` target. Mirrors the embed-check route's existing pattern, closing the gap where a public host could 30x-redirect to RFC1918 / loopback / cloud-metadata IPs.
- **Atlas read-only sync error UX (#143)**: `wrapSyncErrorMessage()` in `electron/sync-service.ts` detects the MongoDB driver's unauthorized shape (regex on `user is not allowed to do action` OR `code === 13`) and replaces the raw text with an actionable hint that names the DB, recommends a `readWrite` role, and points the user at Settings → Connection.
- **Filament list aggregation projection**: `GET /api/filaments` uses an aggregation pipeline that drops heavy spool subfields (`photoDataUrl`, `usageHistory`, `dryCycles`), keeps only `temperatures.nozzle` + `temperatures.bed`, and surfaces a `hasCalibrations` boolean computed from variant + parent (via `$lookup`, so inheriting variants are correctly counted as calibrated). The summary preserves `tdsUrl` (for FilamentForm vendor suggestions) and `spools[].label` (for the AMS slot picker). The "Missing calibration" quick filter on the list page now actually works (was a no-op before).
- **Inventory list helpers extracted + consistent on retired spools**: `getRemainingPct`, `getSpoolCount`, `getRemainingGrams` extracted from `src/app/page.tsx` into `src/lib/inventoryStats.ts` and now all three exclude retired spools (previously only the grams helper did, so a filament with one active + one retired spool would show "2 spools, 75% remaining" while the low-stock chip considered it nearly empty).

Note: SLIX2 NFC tags have write-protected block 79. The NDEF wrapper reserves the last 4 bytes (`usableMemory = tagMemorySize - 4`).
