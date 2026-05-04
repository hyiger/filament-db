# Importing Filaments

[< Back to README](../README.md)

## Exporting Your Config Bundle from PrusaSlicer

1. Open **PrusaSlicer**
2. Go to **File > Export > Export Config Bundle...**
3. Save the file (e.g., `PrusaSlicer_config_bundle.ini`)
4. Note the file path -- you will use it in the next step

---

## Option 1: Web / Desktop UI (recommended)

1. Open Filament DB (desktop app or web at `http://localhost:3456`)
2. Open the **Import/Export** dropdown on the home page and click **"Import INI"**
3. Select your PrusaSlicer config bundle `.ini` file
4. Filaments are parsed and upserted into the database

---

## Option 2: CLI Seed Script

The seed script also auto-creates nozzle configurations from PrusaSlicer's `compatible_printers_condition` and links them to filaments.

### Default Path

By default, the script looks for the config bundle at `~/Downloads/PrusaSlicer_config_bundle.ini`.

```bash
npx tsx scripts/seed.ts
```

### Custom Path

Pass the file path as an argument:

#### macOS / Linux

```bash
npx tsx scripts/seed.ts /path/to/your/PrusaSlicer_config_bundle.ini
```

#### Windows

```powershell
npx tsx scripts/seed.ts C:\Users\YourName\Downloads\PrusaSlicer_config_bundle.ini
```

### Example Output

```
Reading INI file: /path/to/PrusaSlicer_config_bundle.ini
Parsed 27 filament profiles

Found 5 unique nozzle configurations:
  ✓ 0.4mm (0.4mm, standard)
  ✓ 0.4mm HF (0.4mm, high-flow)
  ✓ 0.6mm (0.6mm, standard)
  ...

Importing filaments:
  ✓ 3D-Fuel PCTG CF (Spectrum - PCTG) [0.4mm]
  ✓ Generic HIPS MultiMaterial (Generic - HIPS) [0.4mm, 0.6mm]
  ...

Seeded 27 filaments and 5 nozzles successfully!
```

Running the seed script again will update existing filaments (matched by name) without creating duplicates.

---

## Import from Technical Data Sheet (AI)

Extract filament properties automatically from a manufacturer's Technical Data Sheet using AI. Works with PDF and web page TDS URLs.

### Prerequisites

Configure an AI provider API key in **Settings > AI Features**. Supported providers:

- **Google Gemini** — free tier (15 RPM), get a key at [Google AI Studio](https://aistudio.google.com/apikey)
- **Anthropic Claude** — pay-per-use, get a key at [Anthropic Console](https://console.anthropic.com/settings/keys)
- **OpenAI ChatGPT** — pay-per-use, get a key at [OpenAI Platform](https://platform.openai.com/api-keys)

Alternatively, set an environment variable: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`.

### Usage

1. Click **"+ Add Filament"** on the home page
2. Click **"Import from TDS"** in the "Populate from" toolbar
3. Paste a TDS URL (e.g., `https://bambulab.com/filament-tds.pdf`)
4. Click **Extract** — the AI parses the document and returns structured data
5. The form auto-populates with extracted fields (name, vendor, type, temperatures, density, drying specs, Tg, HDT, shore hardness, print speeds, weights)
6. Review, adjust, and click **Create Filament**

---

## Prusament Spool Import

Prusament filament spools have a QR code that links to a detail page with specifications (material, color, temperatures, weight, manufacturing date, diameter tolerances, pricing).

1. Scan the QR code on the spool or find the spool ID printed on the label
2. Open the **Import/Export** dropdown on the home page and click **"Prusament QR"** (or click **"+ Prusament QR"** on a filament's spool tracker)
3. Enter the spool ID (e.g., `c6974284da`) or paste the full URL
4. Review the extracted data and choose:
   - **New filament** -- creates a fully-populated filament entry
   - **Add spool to existing** -- adds the spool to a matching filament
5. Click **Import**

This also works from a filament's detail page to add another spool of the same material.

---

## CSV / XLSX Import

1. Open the **Import/Export** dropdown on the home page and click **"Import File (INI / CSV / XLSX)"** — the app routes by extension (`.csv` → CSV importer, `.xlsx` → XLSX importer, `.ini` → PrusaSlicer bundle)
2. Select a file with a header row containing at minimum `Name`, `Vendor`, and `Type` columns (max 10 MB)
3. Additional supported columns: `Color`, `Color Name`, `Diameter`, `Cost`, `Density`, `Nozzle Temp`, `Bed Temp`, `Nozzle First Layer`, `Bed First Layer`, `Max Volumetric Speed`, `Spool Weight`, `Net Filament Weight`, `TDS URL`, `Instance ID`, `Drying Temp`, `Drying Time`, `Transmission Distance` (HueForge TD), `Glass Transition` / `Tg`, `Heat Deflection` / `HDT`, `Shore A`, `Shore D`, `Min Print Speed`, `Max Print Speed`, `Nozzle Range Min`, `Nozzle Range Max`, `Standby Temp`, `Spool Type`
4. Column names are matched case-insensitively with common aliases (e.g. "HueForge TD" maps to Transmission Distance, "Tg" maps to Glass Transition)
5. Only fields present in the file are updated — existing data for unmapped columns is preserved
6. Rows missing required fields (Name, Vendor, or Type) are skipped — the response includes a `skippedRows` array with row numbers and reasons

---

## Snapshot Restore

You can restore a previously exported snapshot to import core app data: filaments, nozzles, printers, bed types, locations, print history, and shared catalogs (including soft-deleted documents and tombstones).

1. Go to **Settings** and click **"Restore"** in the Database Snapshots section
2. Select a snapshot JSON file (exported via **"Backup"**)
3. All current snapshot-scoped data is replaced with the snapshot contents
4. The restore uses best-effort rollback — if any error occurs, the handler attempts to re-insert the previous data

---

## CSV / XLSX Export

Open the **Import/Export** dropdown on the home page and click **"Export CSV"** or **"Export XLSX"** to download all filaments. Exports include name, vendor, type, color, color name, temperatures (nozzle, bed, first layer, ranges, standby), cost, density, weights, instance ID, drying settings, transmission distance, glass transition (Tg), heat deflection (HDT), shore hardness (A/D), print speed ranges, and spool type.

---

## OpenPrintTag Community Database Import

Browse the [OpenPrintTag community database](https://github.com/OpenPrintTag/openprinttag-database) (thousands of FDM materials from many brands; the browser subtitle shows the live count from the upstream database) and selectively import filaments into your library.

1. From the home page, open the **Import/Export** dropdown and click **"Browse OpenPrintTag DB"**
2. The browser loads all FDM filaments from the OpenPrintTag database (SLA resins are filtered out)
3. Use the sidebar to filter by:
   - **Search** -- filter by name or brand
   - **Sort** -- by name, brand, type, or completeness score
   - **Data Quality** -- filter by Rich (green, 7-10 fields), Partial (yellow, 4-6 fields), or Stub (grey, 0-3 fields)
   - **Type** -- filter by material type (PLA, PETG, ABS, etc.)
   - **Brand** -- filter by manufacturer (searchable)
4. Click any material row to expand a detail panel showing:
   - **Identity** -- brand, type, color swatch, UUID
   - **Properties** -- density, temperatures (nozzle, bed, chamber, drying), hardness, transmission distance
   - **Data Quality & Links** -- completeness score bar, photo, product URL
5. Select materials using checkboxes (or **Select All** / **Clear Selection** in the toolbar)
6. Click **Import Selected (N)** to import the selected materials
7. Imported filaments are matched by name and vendor -- existing filaments are updated (only null fields are filled), new filaments are created

Stub entries (completeness score 0-3) are rendered at 50% opacity to indicate minimal data.

---

## PrusaSlicer Live Sync

If you are using [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer), filament presets sync automatically via REST API:

1. Build and run PrusaSlicer Filament Edition (see the fork's README for build instructions)
2. Start Filament DB (desktop app or web at `http://localhost:3456`)
3. In PrusaSlicer, filament presets from Filament DB appear in the filament dropdown on startup
4. Calibration values (EM, max volumetric speed, pressure advance, retraction) are applied dynamically when the printer/nozzle changes — they are fetched via `GET /api/filaments/:name/calibration`

PrusaSlicer Filament Edition fetches base presets from `GET /api/filaments/prusaslicer` on startup (one section per filament). Calibration overrides are requested separately per printer/nozzle context. You can also import a PrusaSlicer config bundle back into Filament DB via `POST /api/filaments/prusaslicer`.

---

## Exporting to PrusaSlicer INI

Open the **Import/Export** dropdown on the home page and click **"Export INI"** to download all filaments as a PrusaSlicer-compatible INI file. This file contains all stored settings for each filament and can be imported back into PrusaSlicer via **File > Import > Import Config Bundle...**

Each filament produces one `[filament:Name]` section. Calibration overrides are not included — they are applied dynamically via the calibration API.
