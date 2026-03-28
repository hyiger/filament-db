# Filament DB

A desktop and web application for managing 3D printing filament profiles. Import filament configurations from PrusaSlicer, store them in MongoDB Atlas, and manage them through a clean interface. Available as an installable desktop app for macOS, Windows, and Linux, or run as a web app.

## Features

- **Desktop app** -- installable on macOS (.dmg), Windows (.exe), and Linux (.AppImage, .deb) including arm64 for Raspberry Pi
- **Import/Export** -- PrusaSlicer INI config bundles via browser upload or CLI
- **Browse** -- searchable, filterable, sortable table with color swatches and collapsible statistics summary (by type, vendor, color)
- **Full CRUD** -- create, view, edit, and delete filament profiles
- **Nozzle management** -- define nozzles by diameter, type, high-flow, and hardened attributes
- **Per-nozzle calibration** -- store different EM, max volumetric speed, pressure advance, and retraction values per nozzle
- **Technical Data Sheets** -- link vendor TDS documents with inline preview pane and auto-suggestions from same-vendor filaments
- **Advanced settings** -- temperatures, fan settings, shrinkage, retraction, pressure advance, abrasive/soluble flags, notes
- **Presets** -- named parameter variants per filament (e.g., shore hardness profiles with different temps and extrusion multiplier)
- **Color variants** -- clone a filament as a color variant; inherited settings resolve automatically from the parent
- **Spool tracking** -- track remaining filament by weight with computed length in meters from density and diameter
- **NFC tag read/write** -- read and write [OpenPrintTag](https://openprinttag.io/) NFC-V (ISO 15693) tags directly from the desktop app using an ACR1552U reader
- **OpenPrintTag export** -- download OpenPrintTag binary files for any filament

## Tech Stack

- [Electron](https://www.electronjs.org/) (desktop packaging)
- [Next.js](https://nextjs.org/) (App Router, TypeScript)
- [MongoDB Atlas](https://www.mongodb.com/atlas) (free tier)
- [Mongoose](https://mongoosejs.com/) ODM
- [Tailwind CSS](https://tailwindcss.com/)
- [Vitest](https://vitest.dev/) (coverage enforced on `src/lib/` and `src/models/`)

## Quick Start

### Desktop App (recommended)

Download the latest release for your platform from [GitHub Releases](https://github.com/hyiger/filament-db/releases). On first launch, the app will prompt you for your MongoDB Atlas connection string.

### From Source

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
npm install
cp .env.example .env.local   # then edit with your MongoDB Atlas connection string
npm run dev                   # web app at http://localhost:3000
npm run electron:dev          # or run as desktop app
```

See the [Setup Guide](docs/setup.md) for detailed instructions.

## Documentation

| Document | Description |
|----------|-------------|
| [Tutorial](docs/tutorial.md) | Step-by-step walkthrough of every feature, from first launch to NFC |
| [Setup Guide](docs/setup.md) | Installation, MongoDB Atlas setup, running as web or desktop app |
| [Desktop App](docs/desktop.md) | Electron desktop app: building, packaging, and releasing |
| [Importing & Exporting](docs/importing.md) | PrusaSlicer config export, web UI import, CLI seed script, INI export |
| [Usage Guide](docs/usage.md) | Browsing, filtering, sorting, editing filaments, nozzle management, calibrations, TDS links |
| [NFC Tags](docs/nfc.md) | Reading and writing OpenPrintTag NFC tags with the ACR1552U reader |
| [API Reference](docs/api.md) | REST API endpoints for filaments and nozzles |
| [Testing](docs/testing.md) | Running tests, coverage thresholds, CI/CD with GitHub Actions |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and solutions |

## Project Structure

```
filament-db/
├── docs/                    # Documentation (setup, usage, API, desktop, testing, troubleshooting)
├── electron/                # Electron main process + preload (bundled by esbuild)
├── scripts/                 # CLI tools (seed import, icon generator, filament merge)
├── src/
│   ├── app/
│   │   ├── api/filaments/   # Filament REST API (CRUD, import, export, match, types, vendors, parents)
│   │   ├── api/nozzles/     # Nozzle REST API (CRUD)
│   │   ├── api/setup/       # Connection test endpoint (for desktop setup wizard)
│   │   ├── setup/           # First-launch setup wizard
│   │   ├── filaments/       # Filament pages (list, detail, edit, new)
│   │   └── nozzles/         # Nozzle pages (list, edit, new)
│   ├── components/          # React components (NFC status, dialogs, providers)
│   ├── hooks/               # Custom hooks (useNfc)
│   ├── lib/                 # DB connection, INI parser, OpenPrintTag encoder/decoder
│   └── models/              # Mongoose schemas (Filament, Nozzle)
├── tests/                   # Vitest unit tests (204 tests)
├── .github/workflows/
│   ├── test.yml             # CI: tests on push/PR (Node 20 & 22)
│   └── release.yml          # CD: build desktop installers on version tags (4 platforms)
├── electron-builder.yml     # Electron packaging config (macOS, Windows, Linux x64/arm64)
└── vitest.config.ts         # Test config with coverage thresholds
```

## License

MIT
