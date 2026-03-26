# Testing

## Overview

The project uses [Vitest](https://vitest.dev/) with [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) for in-memory database testing. Tests enforce 100% code coverage on all library and model files.

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
├── setup.ts              # Test setup (mongodb-memory-server lifecycle)
├── parseIni.test.ts      # INI parser tests (17 tests)
├── Filament.test.ts      # Filament model tests (11 tests)
├── Nozzle.test.ts        # Nozzle model tests (9 tests)
└── mongodb.test.ts       # DB connection tests (6 tests)
```

## Coverage Thresholds

The Vitest config (`vitest.config.ts`) enforces 100% thresholds for:
- Statements
- Branches
- Functions
- Lines

Tests will fail if coverage drops below 100% on any metric for files in `src/lib/` and `src/models/`.

## CI / GitHub Actions

A workflow at `.github/workflows/test.yml` runs tests automatically on:
- Push to `main`
- Pull requests targeting `main`

Tests run against Node.js 20 and 22. Coverage reports are uploaded as artifacts on the Node 22 run.

## Test Setup

The `tests/setup.ts` file manages the mongodb-memory-server lifecycle:
- **beforeAll**: Starts an in-memory MongoDB instance and connects Mongoose
- **afterEach**: Clears all collections and cached models between tests
- **afterAll**: Disconnects Mongoose and stops the in-memory server
