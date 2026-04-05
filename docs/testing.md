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

```
tests/
├── setup.ts                    # Test setup (mongodb-memory-server lifecycle)
├── openprinttag.test.ts        # OpenPrintTag encoder tests (120 tests)
├── openprinttag-decode.test.ts # OpenPrintTag decoder tests (36 tests)
├── ndef.test.ts                # NDEF wrap/parse + format/erase tests (25 tests)
├── nfc-roundtrip.test.ts       # NFC encode→decode roundtrip tests (6 tests)
├── resolveFilament.test.ts     # Parent/variant resolution + spool inheritance + hasVariants tests (25 tests)
├── parseIni.test.ts            # INI parser tests (18 tests)
├── prusament.test.ts           # Prusament spool data extraction tests (8 tests)
├── tdsExtractor.test.ts        # TDS AI extraction tests — Gemini/Claude/OpenAI providers, file uploads (14 tests)
├── apiErrorHandler.test.ts     # API error handler utility tests (10 tests)
├── Filament.test.ts            # Filament model + spool CRUD + soft-delete + instanceId + variant tests (27 tests)
├── Printer.test.ts             # Printer model + unique constraints + soft-delete tests (12 tests)
├── Nozzle.test.ts              # Nozzle model tests (9 tests)
├── mongodb.test.ts             # DB connection + migration tests (10 tests)
├── importFilaments.test.ts     # CSV/XLSX import mapping + upsert + skip report tests (18 tests)
├── exportFilaments.test.ts     # CSV/XLSX export column mapping tests (11 tests)
├── prusaSlicerBundle.test.ts   # PrusaSlicer INI bundle generation tests (17 tests)
└── openprinttagBrowser.test.ts # OpenPrintTag database browser + completeness scoring tests (36 tests)
```

**Total: 430+ tests across 17 test files**

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
