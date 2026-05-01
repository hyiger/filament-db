# Testing

[< Back to README](../README.md)

## Overview

The project uses [Vitest](https://vitest.dev/) with [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) for in-memory database testing. Tests enforce coverage thresholds on all library and model files.

## Running Tests

```bash
# Run tests once
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

## Test Structure

Tests live under `tests/` and mirror the `src/` and `electron/` layout. Files cover:

- **Domain decoders/encoders** — OpenPrintTag CBOR, NDEF wrapping, Bambu Lab MIFARE, NFC roundtrip
- **Parsers and importers** — INI, CSV/XLSX, Prusament QR, TDS (with AI provider mocks), spool CSV import
- **Mongoose models** — Filament (incl. spools, variants, calibrations), Nozzle, Printer, BedType, Location, PrintHistory, SharedCatalog
- **Library helpers** — resolveFilament inheritance, PrusaSlicer/OrcaSlicer bundle export, OpenPrintTag browser scoring, theme init, image compression, spool body validation, currency
- **Next.js route handlers** — locations, print-history, share, snapshot, spools/import, sub-routes (spool dry-cycles / usage)
- **Electron** — sync-service URI parsing and (in PR #118) location sync round-trip via two in-memory MongoDB instances
- **Regression guards** — variant edit/clone inheritance round-trip (#106 / #111 / #115 / #113)

The exact file and test counts drift on every PR — run `npm test` for the current numbers (the verbose reporter prints them on success).

## Coverage Thresholds

The Vitest config (`vitest.config.ts`) enforces the following minimum thresholds for files in `src/lib/` and `src/models/`:

- **Statements**: 80%
- **Branches**: 75%
- **Functions**: 90%
- **Lines**: 80%

Tests will fail if coverage drops below these thresholds.

**Coverage scope**: Thresholds currently apply only to `src/lib/**` and `src/models/**`. API routes (`src/app/api/`), pages (`src/app/`), and Electron code (`electron/`) are not covered by the threshold gate.

## CI / GitHub Actions

### Test Workflow (`.github/workflows/test.yml`)

Runs automatically on:
- Push to `main`
- Pull requests targeting `main`

Tests run against Node.js 20 and 22. Coverage reports are uploaded as artifacts on the Node 22 run.

### Release Workflow (`.github/workflows/release.yml`)

Runs automatically on version tags (`v*`). Tests are run on all four build configurations (macOS, Windows, Linux x64, Linux arm64) before building the Electron installers. If tests fail, the build is skipped for that platform.

## Test Setup

The `tests/setup.ts` file manages the mongodb-memory-server lifecycle:
- **beforeAll**: Starts an in-memory MongoDB instance and connects Mongoose
- **afterEach**: Clears all collections and cached models between tests
- **afterAll**: Disconnects Mongoose and stops the in-memory server

No external MongoDB connection is needed to run tests.
