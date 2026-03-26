# Importing Filaments

## Exporting Your Config Bundle from PrusaSlicer

1. Open **PrusaSlicer**
2. Go to **File > Export > Export Config Bundle...**
3. Save the file (e.g., `PrusaSlicer_config_bundle.ini`)
4. Note the file path -- you will use it in the next step

---

## Option 1: Web / Desktop UI (recommended)

1. Open Filament DB (desktop app or web at `http://localhost:3000`)
2. Click **"Import INI"** in the top right of the home page
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

## Exporting to PrusaSlicer INI

Click **"Export INI"** in the top right to download all filaments as a PrusaSlicer-compatible INI file. This file contains all stored settings for each filament and can be imported back into PrusaSlicer via **File > Import > Import Config Bundle...**

Filaments with per-nozzle calibrations are exported as separate sections (e.g., `[filament:Generic HIPS MultiMaterial 0.4mm]` and `[filament:Generic HIPS MultiMaterial 0.6mm]`).
