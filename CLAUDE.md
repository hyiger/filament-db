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
src/app/            App Router pages + API routes (incl. v1.11: dashboard, locations, analytics, share, compare; v1.32: /inventory)
src/app/api/        REST API (incl. v1.11: /locations, /print-history, /analytics, /share, /spools/import; v1.21: /spools/[spoolId]/assignment; v1.22: /filaments/{id}/{prusaslicer,orcaslicer,bambustudio} single-filament slicer exports; v1.32: /spools/by-location)
src/components/     React components (NfcProvider, Toast, dialogs incl. ConfirmDialog/UnsavedChangesDialog/ImportAtlasDialog/PrusamentImportDialog/SpoolCsvImportDialog/NfcReadDialog, ThemeProvider, UpdateBanner, AppNav, AppHeader, SyncStatusIndicator, FilamentSwatch, FinishChip, CollapsibleSection, FormToc, QuickFilterChips, CopyButton, ClientProviders)
src/hooks/          Custom hooks (useNfc, useCurrency)
src/i18n/           Translations + provider (en, de)
src/lib/            Core logic (openprinttag CBOR + decode + DB browser, NDEF, TDS extraction, INI parser, CSV parser + writer, image compression, theme init script, spool validator, PrusaSlicer + OrcaSlicer + single-filament slicer bundles, safeRenderUrl, inventoryStats, externalUrlGuard, mongoUriGuard, apiErrorHandler, customCurrency, cssNamedColors, filamentFinish, exportFilaments, exportSpools, importFilaments, resolveFilament, sortFilamentList, prusament, spoolSlots, nozzleConflicts, scanBus, scanMatchHandler, slicerSettings, requestGuard, tdsExtractor)
src/models/         Mongoose schemas (Filament, Nozzle, Printer, BedType, Location, PrintHistory, SharedCatalog)
src/types/          TypeScript type defs (electron.d.ts, filament.ts)
electron/           Electron main process (main.ts, preload.ts, ndef.ts, bambu-tag.ts, auto-updater.ts, nfc-service.ts, sync-service.ts, local-mongo.ts, ipc-security.ts)
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
- **Locales**: `src/i18n/locales/en.json` (English), `src/i18n/locales/de.json` (German) — ~1250 flat key-value pairs (count drifts on every PR — `jq 'keys|length' src/i18n/locales/en.json` for current)
- **Interpolation**: `{paramName}` tokens in translation strings, e.g. `t("sync.time.minutesAgo", { count: 5 })`
- **Fallback chain**: current locale → English → raw key
- **Persistence**: electron-store (desktop) or localStorage (web), key `filamentdb-locale`
- **Settings**: Language selector in Settings page (same toggle-button pattern as Currency)
- **Adding a language**: Create `src/i18n/locales/xx.json` with all keys, add entry to `LOCALES` array in `src/i18n/index.ts`

## Testing

- ~1450 tests across ~90 files (unit + Mongoose model + Next.js route handlers). Exact counts drift on every PR — run `npm test` for the current numbers.
- Coverage thresholds: 80% lines/statements, 90% functions, 75% branches (enforced on `src/lib/**` and `src/models/**`; `src/lib/compressImage.ts` is excluded because its main flow is DOM-only)
- Setup file: `tests/setup.ts` (mongodb-memory-server). **Caveat**: setup wipes `mongoose.models` between tests; route-level tests that use `.populate(...)` must re-register models in `beforeEach` by calling `mongoose.model(name, schema)` directly (see `tests/locations-route.test.ts` for the pattern).
- Tests run in CI on Node 20 and 22

## CI/CD

- **Tests**: Run on push to main and PRs (`test.yml`)
- **Releases**: Triggered by `v*` tags (`release.yml`). Builds macOS (x64+arm64), Windows (x64), Linux (x64+arm64). Uploads assets to GitHub release.
- **Docker**: Triggered by `v*` tags (`docker.yml`). Builds multi-arch (amd64+arm64) Docker image and pushes to GHCR.
- **Lint rule**: `react-hooks/set-state-in-effect` — don't call setState directly in useEffect body; use lazy initializers or callbacks

## Release Process

1. Update version in **three** places (the release CI uses package-lock for `npm ci`, OpenAPI reports the API version in `/api-docs`):
   - `package.json` (top-level `version`)
   - `package-lock.json` (two occurrences: top-level `version` and `packages[""].version`)
   - `public/openapi.json` (`info.version`)
2. Commit and push to main with a `Bump version to <x.y.z>` message
3. Tag with `git tag v<version>` and push the tag
4. CI builds desktop installers and uploads to a draft GitHub release. The release is auto-published when uploads finish; **assets ≠ source of truth for "release done"** — wait for the workflow run, not just the release-created event
5. Apply release notes with `gh release edit v<version> --notes-file …`. CI doesn't overwrite the body when it publishes, so a single edit (any time after the draft is created) suffices

### Release-process gotchas
- **CSP fixes affect TWO files.** The web CSP lives in `next.config.ts`; the Electron renderer applies its OWN CSP from `electron/main.ts:~1080` and the renderer doesn't merge them — the value set in Electron's `onHeadersReceived` REPLACES whatever Next sent. Any `script-src` / `frame-src` / new-directive change has to land in both. (v1.25.0 shipped with the web CSP gated for dev `'unsafe-eval'` but the Electron CSP unchanged; required a v1.25.1 patch. v1.30.3 fixed an `img-src 'https:'` asymmetry from #371.) The one intentional asymmetry is `connect-src`: Electron adds `ws://localhost:* http://localhost:*` for the embedded Next server; everything else must stay in lockstep.
- **Dev vs packaged in Electron is `app.isPackaged`, not `NODE_ENV`.** `NODE_ENV` isn't reliably set when Electron launches the main process; gate Electron-specific dev-only behaviour on `app.isPackaged ? prod : dev`.
- **The Windows ARM64 release job runs the full Vitest suite under x64 emulation, which makes `mongodb-memory-server`'s 10s startup timeout flaky** (`tests/compressImage.test.ts` was a victim on v1.25.0). When the job fails on that timeout specifically, a re-run usually passes; if it becomes a pattern, bump the `mongodb-memory-server` start timeout in `tests/setup.ts` or skip the affected test on the cross runner.
- **macOS installs from an older app cache the bundle ID, not the binary.** A `.dmg` in Downloads doesn't replace `/Applications/Filament DB.app` until you drag it over. Verify with `defaults read /Applications/Filament\ DB.app/Contents/Info.plist CFBundleShortVersionString`.

## PrusaSlicer Integration

- **Config bundle API**: `GET /api/filaments/prusaslicer` exports filaments as PrusaSlicer INI bundle; `POST` imports bundles back
- **Calibration API**: `GET /api/filaments/{id}/calibration?nozzle_diameter=0.4&high_flow=0|1` returns per-nozzle calibration data (extrusion multiplier, pressure advance, max volumetric speed, retraction); used by PrusaSlicer to auto-adjust filament settings when the user switches printer presets. Optional `high_flow` param disambiguates standard vs high-flow nozzles at the same diameter.
- **Spool check API**: `GET /api/filaments/{id}/spool-check?weight=42.5` checks whether any spool has enough remaining filament (by weight in grams) for a print job. PrusaSlicer calls this after slicing to warn if insufficient filament.
- **Sync with calibration context**: `POST /api/filaments/{id}?nozzle_diameter=0.4&high_flow=0|1` accepts optional query params so PrusaSlicer can write calibration-related keys (EM, PA, retraction) to the correct per-nozzle calibration entry
- **Field mapping**: `src/lib/prusaSlicerBundle.ts` maps structured DB fields → PrusaSlicer INI keys, merges with `settings` bag
- **Nil handling**: Structured DB fields that are null must NOT emit `nil` in the INI output — PrusaSlicer interprets nil as "reset to zero" for numeric fields. Only settings bag nil values (meaning "inherit from parent") are preserved.
- **compatible_printers default**: `filamentToSlicerKeys` emits `compatible_printers = ` and `compatible_printers_condition = ` (both empty) by default, which PrusaSlicer treats as "no restriction" — synced filaments show up in every printer's dropdown and the scan-stream auto-select works regardless of active printer. Without this default PrusaSlicer treats the filaments as "compatible with no printer" and filters them out of every active printer's filament list. Gated on the settings bag not already pinning a restriction, so a user-set `compatible_printers` from a round-trip import survives the next export (PR #235).
- **PrusaSlicer Filament Edition**: [hyiger/PrusaSlicer](https://github.com/hyiger/PrusaSlicer) has a `FilamentDB` module that fetches presets on startup via the REST API, syncs changes back with per-nozzle calibration context
- **NFC scan → preset select (SSE)**: `GET /api/scan/stream` is a long-lived Server-Sent Events endpoint that emits each NFC tag read (after the renderer matches it against the DB) as a `scan` event. Event payload: `{ timestamp, filament, candidates, decoded }` — `filament` is the matched DB row or null; PrusaSlicer keys presets by name so the consumer reads `filament.name` and calls its own "select filament for current extruder" path. The renderer pushes via `POST /api/scan/publish`; the in-process bus lives in `src/lib/scanBus.ts` (Node EventEmitter on `globalThis`). On connect the most recent scan is replayed once as a `replay` event so a slicer opened just after a tag read still picks it up; suppress with `?replay=0`. Heartbeats (`: hb`) every 25s keep proxies from idling the connection out. **In-process means one Filament DB instance, not one physical machine** — subscribers can be anywhere reachable over HTTP (a Pi running Filament DB can drive PrusaSlicer on a Mac across the LAN). What pins to a single machine is the publisher: NFC reads are emitted from the Electron renderer's `NfcProvider`, so the reader must be plugged into whichever box runs the Electron app. A headless Docker / web-only deploy has no `NfcProvider` and never publishes. A horizontally-scaled multi-process deployment would need an external broker behind the bus.
- **Port**: Dev and desktop use port **3456** (`next dev -p 3456`, Electron startup). Docker exposes the app on container port **3000** and is normally mapped with `-p 3456:3000`. PrusaSlicer defaults to `http://localhost:3456`.

## OrcaSlicer Integration

- **Config bundle API**: `GET /api/filaments/orcaslicer` exports filaments as an OrcaSlicer bundle; `POST /api/filaments/{id}/orcaslicer` syncs a single preset back. Mirrors the PrusaSlicer shape — the field mapping in `src/lib/orcaSlicerBundle.ts` differs in key names but the round-trip + nil-handling rules are the same.
- **Calibration context**: same per-nozzle / high-flow query-param convention as PrusaSlicer. The OrcaSlicer fork uses the same FilamentDB module shape, so both slicers can share calibration history on the same filament.

## Bambu Studio Integration

- **Format**: Bambu Studio forks OrcaSlicer; the filament-preset `.json` schema is identical save the Bambu-specific `from: "User"` marker (so the slicer files it under user presets). Export reuses `generateOrcaSlicerProfiles` in `src/lib/orcaSlicerBundle.ts` and stamps `from`. Import inverts the same mapping.
- **Export**: `GET /api/filaments/{id}/bambustudio` emits a single preset (`.json`). Surface in the detail page's "Export for slicer" disclosure as one of the three menu entries.
- **Import — per-id sync** (PR #387): `POST /api/filaments/{id}/bambustudio` syncs a Bambu preset INTO the filament identified by id. The parsed `name`/`filament_settings_id` is ignored — pinning is by id, so a renamed preset still updates the right record. Powers the "Sync from Bambu Studio" button on the filament detail page.
- **Import — bulk** (PR #387): `POST /api/filaments/bambustudio` upserts by name (`filament_settings_id` preferred). Three-phase atomic pattern (active → resurrect-trashed → create-with-E11000-race-recovery) mirroring `src/app/api/filaments/import/route.ts`. Powers the "Bambu Studio (.json)" tile on `/import-export`.
- **Parser**: `src/lib/bambuStudioImport.ts` is DB-free (fast unit tests); the applier helper `src/lib/bambuStudioApply.ts` carries the printer/nozzle resolution + the shared `prepareBambuUpdate` builder that both routes call per-phase.
- **Calibration auto-detect**: parses `printer_settings_id` (`"Vendor Model 0.4 nozzle"` format), matches a Printer doc whose name OR `manufacturer + printerModel` contains the model hint (case-insensitive `String.contains`), and picks the unique installed nozzle at the parsed diameter. Falls back to the global nozzle catalog only when there's exactly one nozzle at that diameter app-wide. Ambiguous matches (>1 printer, >1 nozzle) punt to `calibrationUnresolved: true` so the response can prompt the user — the top-level `maxVolumetricSpeed` still applies in the unresolved path. `hasAnyHint` is computed so that a profile carrying ONLY `filament_max_volumetric_speed` doesn't trigger the unresolved warning (the value lands on the top-level field; nothing is lost).
- **Round-trip safety**: structured fields are pulled out by name; calibration-relevant keys (flow ratio, pressure advance, retraction, fan speeds) are pulled into `calibrationHints`; everything else rides in the `settings` passthrough bag so `export → re-import` is lossless even for Bambu/Orca keys the app doesn't model. Spool subdocuments, `usageHistory`, and `dryCycles` are NEVER touched by an import — inventory state is local and not in the slicer file.
- **Tests**: `tests/bambuStudioImport.test.ts` (parser, DB-free) and `tests/bambustudio-route.test.ts` (routes, mongodb-memory-server). The parser test file includes a calibration round-trip via `calibrationToOrcaSlicerKeys` → re-parse, pinning every field exporter and parser agree on — added after Codex flagged retraction + fan key drift between the two sides during PR review.

## OpenPrintTag Database Browser

- **Page**: `/openprinttag` — browse the OpenPrintTag community database (~11k FFF materials at time of writing — count grows; the `/api/openprinttag` response carries `totalFFF` for the live number)
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
- **Spool validation**: `src/lib/validateSpoolBody.ts`. `photoDataUrl` MIME allow-list is narrow (JPEG/PNG/GIF/WebP/AVIF/HEIC/HEIF) — SVG is explicitly rejected because `<script>` inside SVG can execute in some rendering contexts. `purchaseDate` / `openedDate` strings are parsed to verify they form a real date (GH #372 — pre-fix accepted any string).

## v1.13 Features

- **Hybrid sync expansion**: bedtypes, printhistories, and sharedcatalogs now sync via the existing syncId / last-write-wins engine in `electron/sync-service.ts`. Sync order is nozzles → printers → locations → bedtypes → filaments → printhistories → sharedcatalogs. New cross-DB ref remaps: `calibrations[].bedType` (in the filament transform) and `printer.amsSlots[].filamentId` (post-filament-sync repair pass — printers sync before filaments to break the calibrations.printer ↔ amsSlots.filamentId reference cycle). **Limitation**: spool subdocuments don't have stable cross-side ids, so `printer.amsSlots[].spoolId` and `printhistory.usage[].spoolId` are cleared on cross-side remap. Per-filament gram totals still reconcile; per-spool attribution is dropped pending a separate spool-syncId migration.
- **Soft-delete tombstones for sync-safe deletion**: `PrintHistory` DELETE switched from `deleteOne` to `_deletedAt`-set so a delete on one peer propagates instead of getting resurrected by the other. The handler is idempotent — a retry / double-click / client-retry-after-timeout returns 404 instead of double-refunding spool weight (filters `findOne` on `_deletedAt: null`). `SharedCatalog` DELETE same treatment; the model gained `_deletedAt` + `syncId` fields and the slug index migrated from plain unique to partial-unique-on-non-deleted (auto-applied via `SharedCatalog.syncIndexes()` in the dbConnect migration block at `src/lib/mongodb.ts`). Per-migration retry tracking (`cached.migrations.{instanceIds, sharedCatalogIndexes}`) so a transient failure on one doesn't poison the cache.
- **External URL guard (Electron + render + storage)**: `electron/main.ts`'s `setWindowOpenHandler` parses URLs and only forwards `http(s)` to `shell.openExternal`; everything else (file:, javascript:, data:, custom protocols) is denied with a console warning. New `src/lib/safeRenderUrl.ts` exposes `isHttpUrl()` / `safeHttpUrl()` for client-side gating at every TDS / photo / product render site. `Filament.tdsUrl` has both a Mongoose validator and pre-update hooks (`updateOne`, `updateMany`, `findOneAndUpdate`) so non-http schemes can't slip in via the CSV-import path that doesn't pass `runValidators: true`.
- **TDS extractor SSRF redirect guard**: `src/lib/tdsExtractor.ts` switched from `redirect: "follow"` to manual hop-by-hop with a 5-redirect cap (`MAX_REDIRECTS`) and `assertExternalUrl` re-checked on every `Location` target. Mirrors the embed-check route's existing pattern, closing the gap where a public host could 30x-redirect to RFC1918 / loopback / cloud-metadata IPs.
- **Atlas read-only sync error UX (#143)**: `wrapSyncErrorMessage()` in `electron/sync-service.ts` detects the MongoDB driver's unauthorized shape (regex on `user is not allowed to do action` OR `code === 13`) and replaces the raw text with an actionable hint that names the DB, recommends a `readWrite` role, and points the user at Settings → Connection.
- **Filament list aggregation projection**: `GET /api/filaments` uses an aggregation pipeline that drops heavy spool subfields (`photoDataUrl`, `usageHistory`, `dryCycles`), keeps only `temperatures.nozzle` + `temperatures.bed`, and surfaces a `hasCalibrations` boolean computed from variant + parent (via `$lookup`, so inheriting variants are correctly counted as calibrated). The summary preserves `tdsUrl` (for FilamentForm vendor suggestions) and `spools[].label` (for the AMS slot picker). The "Missing calibration" quick filter on the list page now actually works (was a no-op before).
- **Inventory list helpers extracted + consistent on retired spools**: `getRemainingPct`, `getSpoolCount`, `getRemainingGrams` extracted from `src/app/page.tsx` into `src/lib/inventoryStats.ts` and now all three exclude retired spools (previously only the grams helper did, so a filament with one active + one retired spool would show "2 spools, 75% remaining" while the low-stock chip considered it nearly empty).

## v1.14 Features

- **`asar`-bundled standalone server window-show safety net (#176/#179)**: Electron used to wait for the embedded Next.js server's first paint before showing the window. On slow Windows hosts that paint never fires inside the splash timeout and users see a "white window" forever. The main process now resolves on whichever happens first — `did-finish-load` or a hard 8-second timeout — and a hotfix in 1.14.3 reverted asar packaging for the embedded server because it broke `process.cwd()`-relative file reads.
- **Anti-FOUC theme bootstrap (#205/#209)**: `src/lib/themeInitScript.ts` runs as a `<script>` element injected by `ThemeProvider`. The earlier inline-string form tripped React's "script tag in component" warning when streamed via RSC; the current form passes both the warning check and CSP nonce gating (still pending — see #225).
- **Analytics "+N manual" hint (#204/#208)**: When `usage.length === 0` but `spool.usageHistory[].source === "manual"` entries cover the totals, the analytics page now surfaces a "+N manual" annotation instead of looking like the totals came from nowhere.
- **Phantom-spool POST guard (#203/#207)**: `POST /api/filaments/{id}/spools` with an empty body no longer creates a phantom 0g spool. Validates `totalWeight` shape and refuses with 400 if absent.

## v1.15 Features

- **Filament trash workflow (#213)**: `DELETE /api/filaments/{id}` soft-deletes (sets `_deletedAt`). New endpoints `GET /api/filaments/trash` and `POST /api/filaments/{id}/restore`. Permanent delete via `DELETE /api/filaments/{id}?permanent=true` — requires the doc to already be in the trash (the active → trash → purge gating is enforced server-side, not just in the UI). Parent-with-trashed-variants refusal at both delete steps.
- **`_purged` tombstone for sync-safe permanent delete (Codex P1 #213)**: hard-delete on one peer would get resurrected by the hybrid-sync engine on the next cycle. Permanent-delete now sets `_purged: true` instead of removing the row; the sync engine treats `_purged` as a one-way propagation signal so both sides converge to the same gone-forever state. **Security note (#222)**: `_purged` must be stripped from all client-writable bodies — see the strip block in `src/app/api/filaments/{,/[id]}/route.ts`.
- **Partial-unique-on-non-deleted index on `name`** in `Filament` (and parallel updates to `Nozzle`, `Printer`, `BedType`, `Location`, `SharedCatalog`). A new active filament can reuse the name of a trashed one; restore refuses with 409 if the original name now conflicts with another active row.
- **`/trash` and `/import-export` pages**: top-level UI surfaces for the workflows above, reachable from Settings.
- **Snapshot schema v4**: `GET /api/snapshot` and `POST /api/snapshot/restore` carry trash + tombstone state so backup/restore round-trips don't lose the trash.

## v1.16 Features

- **FilamentForm collapsible sections + sticky TOC sidebar (#214)**: the long Edit Filament form (~2300 lines, 12 fieldsets) now chunks into collapsible sections via `src/components/CollapsibleSection.tsx`, with a `src/components/FormToc.tsx` sidebar that scroll-spies the active section. Required identity fields (name, vendor, type, parent) stay always-visible at the top. Per-section open/closed state persists in `localStorage`. An imperative helper `expandAndScrollToSection(id)` is exported for "open the offending section + scroll" on validation error.
- **Audit sweep #1 (PR #221, covers #215-#220)**: npm `overrides` to force-patch postcss past Next's nested copy; `npm start` repointed at `node .next/standalone/server.js` (incompatible with `next start` under standalone output); OpenAPI gained trash + restore + `?permanent=true` documentation; required form labels associated via `id` + `htmlFor`; Vitest's Vite dynamic-import warnings + Mongoose `new: true|false` deprecation warnings cleaned up; new CI `smoke` workflow job (mongo:7 service + standalone build + curl checks against `/`, `/dashboard`, `/api-docs`, `/api/openapi`, `/api/filaments`).
- **Audit sweep #2 (this branch, covers #222-#228)**: P1 security fix for the `_purged` client-writable gadget (#222); variant-inheritance resolution in `/spool-check`, `/analytics`, and the restore handler (#223); print-history concurrency with optimistic concurrency control + sequential-fallback rollback (#224); `/api/openprinttag` cold-fetch retry + CSP header (#225); coverage for the previously-untested transaction branch + tdsExtractor error paths + row-limit route-level translation (#227); polish bucket (#228).

## v1.21 Features

- **Spool printer-slot assignment (#242)**: a spool can be assigned to a printer AMS/MMU slot directly from the spool card, distinct from its Location — Location is the spool's semi-permanent "home", the slot is its transient position while loaded in a printer. `src/lib/spoolSlots.ts` is the enforcement point: `findSpoolSlot` (reverse lookup over `Printer.amsSlots[].spoolId`), `assignSpoolToSlot` (clears the spool from every slot, then sets the target — a spool occupies at most one slot, and bad data with a spool in two slots self-heals), `clearSpoolsFromOtherPrinters` (post-save reconciliation wired into the printer PUT/POST so the one-slot invariant holds no matter which form wrote it). New endpoint `GET/PUT/DELETE /api/spools/[spoolId]/assignment` writes only `Printer.amsSlots[].spoolId`, never the spool's `locationId`; PUT rejects retired spools (out of inventory, not loadable). The spool DELETE handler also clears the slot so a deleted spool can't linger. Legacy printer documents predating the `amsSlots` field come back from lean queries without it — all iteration sites guard the missing array. **Hybrid-sync limitation**: `amsSlots[].spoolId` is wiped on cross-side sync remap (spool subdocuments have no stable cross-side id), so slot assignments are reliable only in single-database deployments — the spool card surfaces this caveat.

## v1.22 Features

- **Single-filament slicer export (PR #247)**: per-filament export endpoints `GET /api/filaments/{id}/{prusaslicer,orcaslicer,bambustudio}` emit one preset rather than a full bundle. Surface in the detail page's "Export for slicer" disclosure as three menu items (PrusaSlicer .ini / OrcaSlicer .json / Bambu Studio .json). Field mapping lives in `src/lib/singleFilamentExport.ts`; mirrors the bulk-export shape per slicer so the slicer-side import path is identical.

## v1.23 Features

- **Bed types on printers (PR #248)**: printers gained an `installedBedTypes: BedType[]` array — shared-catalog model so the same printer can carry multiple bed surfaces (Textured PEI + Smooth PEI etc.). Bed-type DELETE refuses while any printer references it (mirrors the location-delete guard). The calibration form's bed-type picker now filters to bed types installed on the selected printer.

## v1.24 Features

- **Security hardening sweep (#252-#261, P0 audit cycle)**: trusted-origin guard `assertSameOriginRequest` for destructive admin routes (snapshot export·restore·wipe, Atlas import, MongoDB connection-test); SSRF caps + DNS-resolved IP allowlist on every outbound fetch (`src/lib/externalUrlGuard.ts`) with the dispatcher's DNS cache bounded; mass-assignment protections on PUT handlers; snapshot restore validation rejects bad rows; response-size caps on external fetches (embed-check / TDS / prusament / OpenPrintTag tarball). SRV target validation for `mongodb+srv://` URIs (`src/lib/mongoUriGuard.ts`).
- **AMS slot cleanup on filament delete (#333)**: clear AMS slots BEFORE the delete write so cleanup stays retryable; previously a partial-delete left dangling `amsSlots[].spoolId` refs.
- **SpoolCard label revert (#263)**: sibling-spool updates no longer trample an in-progress label edit on the active card.

## v1.25 Features

- **API validation + semantics + dev CSP sweep (#337-#344)**: numeric field validators on Filament/Nozzle (negative cost/density/diameter rejected with 400 instead of corrupting downstream math); import endpoints return 400 not 500 for bad bodies (#338); PUT/GET on `/api/print-history/[id]` (#340); multipart/form-data branch in `/api/spools/import` (#339); `unsafe-eval` gated to packaged builds via `app.isPackaged` (#344) — dev builds keep it because Next.js Turbopack relies on it.
- **Frontend a11y + UX polish (#342-#349, #351)**: focus traps, dialog accessible names, confirm-modal keyboard support, empty states, URL filter sharing, Add Spool affordance on filaments with no spool metadata.
- **Print-history field caps (#350)**: notes / jobLabel length capped on PUT so a misbehaving client can't push unbounded strings.

## v1.26 Features

- **Parent/variant visual model (#101)**: parents-of-variants render with a hatched cross-hatched swatch via `<FilamentSwatch isParent>`. New "+ Create variant" CTA on the filament detail page (gated on `!isVariant` — no variants-of-variants by design). Parent values surface as placeholders on the new-variant form so the user can see what they'll inherit (display-only — submit handler reads from `form.*` only so blank inputs stay blank on the variant doc and continue tracking the parent dynamically via `resolveFilament()`). **A filament is only a parent if it has variants** — no explicit flag, derived from variant count. See "Multi-color parent indicator + Create-variant flow" section.

## v1.27 Features

- **Finish indicator on swatch + name chip**: `<FilamentSwatch>` gains a `finish?` prop driving CSS overlays (matte / silk / sparkle / glow / translucent / transparent). `<FinishChip>` mirrors the finish as a small chip beside the name. Source of truth: `src/lib/filamentFinish.ts`'s `deriveFinish(optTags)` — priority order `transparent > translucent > sparkle > silk > glow > matte`. Parents are finish-agnostic. `optTags` rides the list aggregation + per-parent variant projection. See "Finish indicator on the swatch + name chip" section.
- **Smart Filament Workflow guide**: end-user-facing Markdown + PDF guide explaining the NFC scan → preset select → calibration loop. Lives in `docs/`.
- **optTags inheritance fixes**: list + variants-subquery projections now inherit `optTags` from parent so a variant without explicit tags renders the same finish as its parent.

## v1.28 Features

- **Color name → hex typeahead**: `FilamentForm`'s "Color Name" input is a combobox with two suggestion sources — previously-used color names from the DB (`GET /api/filaments/colors` runs `$group` over non-deleted filaments) and the 148 CSS Color Module Level 4 named colors plus synonyms. Picking a suggestion sets both `colorName` and `color` hex. Helpers in `src/lib/cssNamedColors.ts`: `lookupCssNamedColor(name)`, `filterColorSuggestions(...)`. See "Color-name typeahead → hex" section.
- **NFC prefill fixes**: tag-present state routed through a ref in the NFC prefill effect (was triggering stale closures); prefill on `/filaments/new` clears when no tag is on the reader.
- **Test infra**: bumped `mongodb-memory-server` `launchTimeout` to 60s for the Windows-ARM64 x64-emulation CI runner that was flaky at 10s.

## v1.29 Features

- **Delete filament button on detail page**: top-of-detail-page Delete button that uses the soft-delete trash workflow (#213) — sends DELETE to `/api/filaments/{id}` which sets `_deletedAt`. Mirrors the trash-then-restore-or-purge flow.
- **Parents excluded from inventory aggregates**: list-level "remaining grams / spool count" totals skip parents since their spools (if any) are tracked separately on their variants. Quick-filter visible-row counts now align with chip counts.
- **Calibration prune + filter fixes**: stale printer-specific calibrations pruned on save (PR #358 P2); calibration printer tabs filtered to printers that own a compatible nozzle; fail-open behavior when the nozzle catalog is temporarily unavailable so legitimate edits aren't blocked by transient DB issues.
- **Parent-fallback enrichment in filtered views**: variants in filtered list views keep their parent-resolved values (was silently null-ing inherited fields under some filter combos).
- **NFC phantom-tag recovery**: `clearPhantomPresence` no longer blanket-clears `readerPresent`; auto-read connect failure now clears the phantom `tagPresent` flag (continuation of GH #230).
- **Duplicate-key error surface**: PUT handlers on entity routes (Nozzle, Printer, BedType, Location) now surface duplicate-key errors as 409 with the conflicting field named, instead of 500 with raw mongo text.

## v1.30 Features

- **Trusted-origin (CSRF) guard sweep (#360/#368)**: extended `assertSameOriginRequest` from the destructive admin routes covered by #252 to **every** mutating route — POST/PUT/DELETE/PATCH on filaments, nozzles, printers, locations, bed-types, print-history, spools, share, scan/publish, prusament/import, openprinttag/import, tds, and the import-* endpoints. See "Trusted-origin (CSRF) guard sweep" section.
- **Hybrid sync per-collection error isolation (#369)**: each `syncCollection` runs through a `trySync(name, deps, fn)` wrapper in `electron/sync-service.ts`. A single collection failure no longer aborts the whole cycle; dependent collections cascade-skip with prerequisite-named errors (e.g. nozzle failure → printers/filaments/printhistories skipped with "skipped — prerequisite 'nozzles' failed"). New `SyncStatus.state: "partial"` (renderer shows amber pill) for partial-success cycles. `status.error` groups errors by message so the auth-error case shows the wrapped readWrite hint once with all affected collections rather than collapsing to a name list. Post-sync repair passes (`repairFilamentParentIds`, `repairPrinterAmsSlots`, `repairDanglingSpoolLocations`) are gated on their prerequisites and wrapped in best-effort try/catch.
- **Spool ingestion hardening (#370, #372, #373)**: `POST /api/spools/import` wraps each row's `save()` in its own try/catch so a `VersionError` from a concurrent writer reports per-row instead of 500-ing the batch. `purchaseDate` / `openedDate` strings on both JSON-body API and CSV importer now go through `isValidIsoDateString` in `src/lib/validateSpoolBody.ts` — rejects ISO-shaped-but-impossible dates (Feb 29 in non-leap years, Feb 30, Apr 31, month 0/13, day 0/32). Date validation runs BEFORE `resolveLocationId` so a failed-date row doesn't leave an orphan auto-created Location. `isValidIsoDateString` uses `setUTCFullYear` not `Date.UTC` so years 0000-0099 round-trip correctly (no 2-digit-year remap to 1900s). `photoDataUrl` allow-list error message + this doc now mention HEIF consistently (was always in the regex, missing from copy).
- **CSP img-src alignment (#371)**: Electron renderer CSP now mirrors web CSP's `img-src 'self' data: blob: https:` — `https:` was missing on the Electron side, leaving external HTTPS image references silently broken only in the desktop build. The `connect-src` localhost addition remains the one intentional asymmetry.
- **Clone button on variants (#377)**: v0.3.0 leftover gate removed. The new-page clone handler at `src/app/filaments/new/page.tsx:~190` already supported variants (`filament.parentId || filament._id` — cloning a variant produces a sibling under the same parent; cloning a root produces a variant of it). Only the UI gate on the detail page was hiding the Clone button on variant pages. The "Create variant" CTA next to Clone keeps its `!isVariant` gate (variants-of-variants stay banned).
- **Parent/variant relationship in exports (#378)**: filament CSV/XLSX exports (`EXPORT_COLUMNS` in `src/lib/exportFilaments.ts`) and spool CSV export (`SPOOL_EXPORT_COLUMNS` in `src/lib/exportSpools.ts`) now include `Parent` (parent filament's name when this row is a variant) and `Variant Count` (>0 only for parents) columns. Slicer-bound exports (PrusaSlicer/OrcaSlicer/Bambu Studio) intentionally stay flat — slicers have no concept of variants. Re-import side landed in v1.30.4 (#386, see below).
- **Parent column on filament re-import (v1.30.4, #379 / PR #386)**: shared filament importer (`src/lib/importFilaments.ts`, used by `/api/filaments/import-csv` and `/import-xlsx`) recognises the `Parent` column from the #378 export. Honoured on create/resurrect only — silently ignored on update because re-parenting via re-import is a surprising UX. Validation: parent must be active and not itself a variant; self-references rejected; failures land in `skippedRows` with a named reason. Two-pass driver (no-parent rows first, variant rows second) lets a single CSV carry both parent and variant rows regardless of row order; an extracted `trimmedParentName` helper is shared between the router and `processRow` so a whitespace-only `Parent` cell can't drift between the two views (Codex P2 follow-up). `Variant Count` is read-only and ignored.
- **Spool Tracker empty state (#380)**: filament detail page always renders the Spool Tracker section. Pre-fix, a freshly-created filament with no spools AND no weight metadata hid the entire section including the Add Spool button — a regression of #346 which covered "no spools but has weights". New `detail.spool.emptyHint` i18n key surfaces a short "No spools yet — add one to start tracking..." message above the CTA when there's nothing to track yet.
- **Retire prompt on zero weight (#381)**: when the user sets a spool's remaining weight to 0 on the detail page and the spool isn't already retired, prompt to also mark it retired in the same write. Retiring preserves history (purchase/opened dates, dry cycles, usage log, location, photo) but excludes from inventory totals via `inventoryStats.ts`. Prompt is skipped when the caller explicitly passed `retired` (the SpoolCard's own retire toggle path), when prior weight was already 0 (no real transition), or when the spool was already retired.

## v1.31 Features

- **Bambu Studio filament-preset importer (#387)**: completes the round-trip — the export route at `GET /api/filaments/{id}/bambustudio` (v1.22) now has two import companions. `POST /api/filaments/{id}/bambustudio` syncs a Bambu `.json` INTO an existing filament (pinned by id, ignores the parsed name) and powers the **Sync from Bambu Studio** button on the filament detail page. `POST /api/filaments/bambustudio` upserts by name (`filament_settings_id` preferred) using the same three-phase active → resurrect-trashed → create-with-E11000-race-recovery pattern as `/api/filaments/import`; powers the **Bambu Studio (.json)** tile on `/import-export`. Parser (`src/lib/bambuStudioImport.ts`) inverts `filamentToOrcaSlicerKeys`; applier (`src/lib/bambuStudioApply.ts`) carries the printer/nozzle resolution + a shared `prepareBambuUpdate` builder both routes call per-phase. Calibration auto-detects from `printer_settings_id` (`"Vendor Model 0.4 nozzle"` format) — matches a Printer by name/model contains, picks the unique installed nozzle at the parsed diameter, falls back to the global nozzle catalog only when there's exactly one nozzle app-wide at that diameter; ambiguous matches punt to `calibrationUnresolved: true` rather than guessing. `maxVolumetricSpeed`-only profiles don't trigger the unresolved warning because that value also lands on the top-level filament field. Spool subdocs, `usageHistory`, and `dryCycles` are never touched on import. See "Bambu Studio Integration" section above.

## v1.32 Features

- **Spool Inventory page (#389 / PR #391)**: companion lens to the filament list — same data, opposite grouping. The filament list groups spools UNDER their filament; `/inventory` groups filaments under their LOCATION so a user can audit a shelf or drybox at a glance and update common per-spool fields without bouncing through each filament's detail page. Powered by a single-shot aggregation at `GET /api/spools/by-location` (`src/app/api/spools/by-location/route.ts`) that pulls `spools[]` out of the filament collection, groups by `spools[].locationId`, joins the Location doc, and self-`$lookup`s on `parentId` to surface parent `spoolWeight` / `netFilamentWeight` so variant inheritance works without a second fetch. Query params: `kind` (location kind filter), `type`, `vendor`, `includeRetired=1` (default excluded — retired spools are out of inventory). Spools whose `locationId` is null land in a synthetic "no location" group sorted to the END so they read as "needs attention" rather than a primary inventory bucket. The page (`src/app/inventory/page.tsx`) renders a three-stat header (total spools / locations / active grams), filter row, collapsible groups, and per-spool rows with inline weight editing, move-to dropdown, and retire/unretire toggle — all going through the existing `PUT /api/filaments/{id}/spools/{spoolId}` endpoint (no new mutation route). 37 new i18n keys under `inventory.*` (+ `common.inventory` nav label), EN/DE parity preserved. Nav link sits between Dashboard and Compare in `AppHeader`.
- **Clone → "Duplicate" rename, "Create variant" tooltip (#388 / PR #390)**: the filament detail page exposes two buttons that produce structurally identical outcomes — a new variant under the same parent. The actual difference is which fields get pre-filled on the new-filament form (`?cloneId=` → name + color + colorName + vendor + type; `?parentId=` → vendor + type only). Pre-fix, both buttons read "Clone …" / "Create variant …" with tooltips that didn't explain the distinction. Renamed the action-bar button + page title + new-page picker from "Clone" → "Duplicate" everywhere (consistent terminology across surfaces) and tightened the tooltip on each button to contrast SAME color (Duplicate) vs. DIFFERENT color (Create variant). i18n-only change — no behavior, no tests pinned the literal "Clone" string. en.json + de.json stay in parity at their pre-change counts (the rename rewrote 10 keys; no net add).
- **CI dependency hygiene (#392)**: high-severity advisory [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) hit `tmp <0.2.6` and broke every PR's `npm audit --audit-level=moderate` step. Added `"tmp": "^0.2.6"` to the `overrides` block in `package.json` (same pattern as the existing `postcss` override) so both transitive paths (`exceljs → tmp` and `electron-builder → app-builder-lib → @malept/flatpak-bundler → tmp-promise → tmp`) resolve to a patched version.

## Color-name typeahead → hex

`FilamentForm`'s "Color Name" input is a combobox: typing populates a dropdown of suggestions, picking one sets BOTH the color name and the hex color picker. Two suggestion sources, in priority order:

- **From your filaments** — the user's previously-saved `(colorName, color)` pairs, served by a new `GET /api/filaments/colors` endpoint that runs `$group` over non-deleted filaments. Multiple filaments with the same name+hex collapse to one row; different hexes under the same name (e.g. three brands of "Galaxy Black" with slightly different shades) stay separate so the user can pick the right shade.
- **Standard colors** — the 148 CSS Color Module Level 4 named colors plus the gray/grey + cyan/aqua + fuchsia/magenta + slategray/slategrey synonyms. `src/lib/cssNamedColors.ts` is the source of truth.

Lookup helpers in `src/lib/cssNamedColors.ts`:
- `lookupCssNamedColor(name)` — case- and whitespace-insensitive. Returns the canonical uppercase hex (`#000080` for any of `navy`, `Navy`, `  NAVY  `) or `null`.
- `filterColorSuggestions(dbSuggestions, query, maxResults?)` — substring-matches the query against both sources, dedupes by `(lowercase name, uppercase hex)` (DB wins ties), and orders DB entries above CSS entries. Exported because the combobox can't unit-test through it.

Commit-on-write rules in the combobox:
- **Click / Enter on a dropdown row** sets both `colorName` and `color`.
- **Tab-out / blur with an exact CSS named-color match** updates the hex even without opening the dropdown — covers users who already know "navy" and just want to type it.
- **DB-side blur lookup is intentionally NOT auto-applied** — the same name can have multiple legitimate hexes in the DB; the user has to pick which one they meant via the dropdown.
- **Plain typing never overwrites the hex** — only an explicit commit (click/Enter/exact-CSS-on-blur) changes the color picker, so the user's free-text "I'm naming this whatever I want" path stays uninterrupted.

Translation keys: `form.colorName.section.db` ("From your filaments" / "Aus deinen Filamenten") and `form.colorName.section.css` ("Standard colors" / "Standardfarben") in both `en.json` and `de.json`.

## Finish indicator on the swatch + name chip

When two filaments share the same color but a different finish (the canonical case: white plain / matte / silk), the inventory list, detail page header, and the color-variants list under a parent now distinguish them visually:

- **`<FilamentSwatch>` finish texture**: a new `finish?: "matte" | "silk" | "sparkle" | "glow" | "translucent" | "transparent" | null` prop drives a CSS overlay on top of the color. Matte = flat fill (no highlight), silk = soft sheen gradient, sparkle = four small dots whose color flips based on the underlying fill's luminance, glow = soft yellow inner halo, translucent/transparent = real alpha (55% / 25%) over a checkered backdrop (the universal "see-through" signal). All five non-alpha treatments compose with `data-finish="..."` for QA snapshots.
- **`<FinishChip>`** renders the same finish as a small uppercase chip beside the filament name. Per-finish color palette (silk = blue, sparkle = amber, glow = yellow, translucent = cyan, transparent = slate, matte = gray) and reuses the existing chip styling vocabulary.
- **Source of truth**: `src/lib/filamentFinish.ts`'s `deriveFinish(optTags)` maps optTag IDs to a single canonical finish string. Priority order when a filament carries multiple finish-relevant tags: `transparent > translucent > sparkle > silk > glow > matte`. Parents are finish-agnostic — finishes are only derived for variants and standalones; `<FilamentSwatch isParent>` short-circuits to the cross-hatched fill regardless.
- **Data plumbing**: `optTags` rides the list aggregation (`GET /api/filaments`) and the per-parent variant projection in `GET /api/filaments/{id}` (`.select("name color cost optTags")`) so neither the list page nor the detail-page color-variants list need a follow-up fetch. `FilamentSummary` and `FilamentVariant` types gain `optTags?: number[]`.
- **Translations**: new keys `swatch.finish.matte`/`silk`/`sparkle`/`glow`/`translucent`/`transparent` in both `en.json` and `de.json`. Kept distinct from the existing `form.tag.*` keys so chip text can diverge from form-checkbox labels without coupling them.

## Multi-color parent indicator + Create-variant flow

- **Multi-color parent swatch (auto-detected)**: a filament that currently has ≥1 non-deleted variant is treated as a "parent of color variants" and renders with a neutral cross-hatched swatch instead of a solid color. **A filament is never a parent unless it actually has variants** — there is no schema flag; parenthood is derived from the variant count. Rendering is centralised in `src/components/FilamentSwatch.tsx` (`<FilamentSwatch color={...} isParent={...} />`), used by the inventory list (`src/app/page.tsx`), the detail page header (`src/app/filaments/[id]/page.tsx`), the variant chips in the parent's color-variants list, and the new-filament form's parent picker chip + dropdown rows (`src/app/filaments/FilamentForm.tsx`).
- **`hasVariants` boolean on the list APIs**: `GET /api/filaments` extends the existing aggregation with a second `$lookup` (probe-style — capped at 1 doc — joining `_id → parentId` on non-deleted rows) and exposes `hasVariants: boolean` next to the existing `hasCalibrations`. `GET /api/filaments/parents` does the equivalent with a single `Filament.distinct("parentId", ...)` call so each parent option in the picker can render the cross-hatched swatch when it has variants and a solid one when it doesn't.
- **"Create variant" CTA on the filament detail page**: a `bg-fuchsia-600` button next to the existing Clone, gated on `!isVariant`, links to `/filaments/new?parentId=<id>`. The existing `?parentId=` flow already creates a variant, so this is a discoverability fix rather than a new server path. Translation keys: `detail.createVariant`, `detail.createVariant.title` (both `en.json` and `de.json`).
- **Parent values as placeholders in the new-filament form**: when `/filaments/new` is opened with `?parentId=`, the page now fetches the parent with `?raw=true` and passes the full doc on `initialData._parent`. `FilamentForm` exposes an inline `parentPh(path)` helper that returns the parent's stringified value (or `undefined`) and threads it into every inheritable scalar input's `placeholder` — cost, density, diameter, the seven `temperatures.*`, min/max print speed, drying temp/time, shore A/D, glass-temp, heat-deflection, transmission distance, shrinkage XY/Z, tdsUrl, etc. **Placeholders are display-only and must NOT be auto-copied into form state** — the submit handler at `src/app/filaments/FilamentForm.tsx` builds the body from `form.*` only, so a blank input stays blank on the variant doc and continues to track the parent dynamically via `resolveFilament()` at read time (GH #106). The existing variant-banner at the top of the form fires for both edit AND new flows now that `_parent` is populated either way.

## Trusted-origin (CSRF) guard sweep

`assertSameOriginRequest` (`src/lib/requestGuard.ts`) was originally added in GH #252 for snapshot export·restore·wipe + the MongoDB connection test + the Atlas import (the obviously destructive admin handlers). GH #360 extended it to every other mutating API route — POST/PUT/DELETE/PATCH on filaments, nozzles, printers, locations, bed-types, print-history, spools and assignments, share + share/[slug], scan/publish, prusament/import, openprinttag/import, tds, and all the import-* endpoints. Same pattern at the top of each handler:

```ts
const guard = assertSameOriginRequest(request);
if (guard) return guard;
```

The guard rejects browser cross-origin (`Sec-Fetch-Site: cross-site` / `same-site`, or an `Origin` whose authority doesn't match `Host`) with 403, and lets non-browser clients (curl, PrusaSlicer / OrcaSlicer integrations) pass — they send neither header. **One stub left unguarded on purpose**: `POST /api/filaments/orcaslicer` is a 501 placeholder for the not-yet-implemented bulk OrcaSlicer importer; no destructive op runs and the handler takes no `request` argument. When bulk import lands, add the guard then.

Regression coverage in `tests/destructive-route-guard.test.ts` pins a representative sample (filaments / nozzles / locations / share / scan-publish / spools-import / print-history) so a future contributor can't quietly drop the guard from a new route. The Codex audit issue #360 has the full inventory.

Note: SLIX2 NFC tags have write-protected block 79. The NDEF wrapper reserves the last 4 bytes (`usableMemory = tagMemorySize - 4`).

Note: PC/SC's `SCARD_STATE_PRESENT` bit can fire spuriously (driver-dependent — observed on ACS readers, especially the ACR1552U on macOS). The reader-status handler in `electron/nfc-service.ts` skips the FIRST event per reader to dodge the documented plug-in phantom (GH #230), but a later event with `SCARD_STATE_CHANGED` toggled can still set `tagPresent: true` without a real tag in the field. The recovery path: the auto-read in `electron/main.ts` fires on the present→true transition; if `connect()` exhausts its retries with `"Cannot connect to tag"`, we treat the present bit as phantom and call `NfcService.clearPhantomPresence()` to reset `tagPresent: false` in the service state. `clearPhantomPresence` ONLY touches the service-level `tagPresent` flag — it does NOT wipe the per-reader `readerPresent` map, because in multi-reader setups another reader may legitimately have a real tag whose presence event we already recorded. Without the corrective `tagPresent` clear, the renderer pill stays at "Tag detected" indefinitely and survives unplug+replug.
