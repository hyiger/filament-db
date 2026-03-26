# Filament DB

A web application for managing 3D printing filament profiles. Import filament configurations from PrusaSlicer, store them in MongoDB Atlas, and manage them through a clean web interface. Export your filaments back to PrusaSlicer-compatible INI format at any time.

## Features

- **Import** filament profiles from PrusaSlicer config bundles (INI format) -- via CLI seed script or browser upload
- **Browse** filaments in a searchable, filterable, sortable table with color swatches
- **Filter** by filament type (PLA, PETG, ASA, etc.) and vendor
- **Sort** columns (name, vendor, type, nozzle temp, bed temp, cost) ascending/descending
- **View** detailed settings for each filament, including all PrusaSlicer parameters
- **Create** new filament profiles through the web UI
- **Edit** existing filament profiles with full control over temperatures, fan settings, retraction, shrinkage, extrusion multiplier, pressure advance, and more
- **Delete** filament profiles
- **Export** all filaments back to PrusaSlicer-compatible INI format
- **Nozzle management** -- define nozzles by diameter, type (Brass, Hardened Steel, Diamondback, etc.), high-flow, and hardened attributes
- **Per-nozzle calibration** -- store different extrusion multiplier, max volumetric speed, pressure advance, and retraction values for each compatible nozzle
- **Technical Data Sheets** -- link vendor TDS documents to filaments with inline preview pane; auto-suggest TDS URLs from other filaments by the same vendor

## Tech Stack

- [Next.js](https://nextjs.org/) (App Router, TypeScript)
- [MongoDB Atlas](https://www.mongodb.com/atlas) (free tier)
- [Mongoose](https://mongoosejs.com/) ODM
- [Tailwind CSS](https://tailwindcss.com/)
- [Vitest](https://vitest.dev/) (testing, 100% coverage)

---

## Prerequisites

- **Node.js** v18 or later
- **npm** (included with Node.js)
- **Git**
- A **MongoDB Atlas** account (free tier works)

### Installing Node.js

#### macOS

Using Homebrew (recommended):

```bash
brew install node
```

Or download the installer from https://nodejs.org/

#### Linux (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### Linux (Fedora/RHEL)

```bash
sudo dnf install nodejs
```

#### Windows

Download and run the installer from https://nodejs.org/ (LTS version recommended).

Or using winget:

```powershell
winget install OpenJS.NodeJS.LTS
```

Or using Chocolatey:

```powershell
choco install nodejs-lts
```

After installing, verify on any platform:

```bash
node --version
npm --version
```

---

## Setting Up MongoDB Atlas (Free Tier)

1. Go to https://www.mongodb.com/cloud/atlas/register and create a free account.

2. **Create a cluster:**
   - Click **"Build a Database"**
   - Select **M0 Free** tier
   - Choose a cloud provider and region close to you
   - Name your cluster (e.g., `Filaments`)
   - Click **"Create Deployment"**

3. **Create a database user:**
   - In the setup wizard, enter a username and password
   - Click **"Create Database User"**
   - Save these credentials -- you will need them for the connection string

4. **Configure network access:**
   - In the setup wizard (or under **Security > Network Access**), click **"Add IP Address"**
   - For development, click **"Allow Access from Anywhere"** (adds `0.0.0.0/0`)
   - For production, add only your server's IP address
   - Click **"Confirm"**

5. **Get your connection string:**
   - Click **"Connect"** on your cluster
   - Select **"Drivers"**
   - Copy the connection string. It looks like:
     ```
     mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?appName=<appName>
     ```
   - Replace `<username>` and `<password>` with the credentials from step 3

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/filament-db.git
cd filament-db
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create a `.env.local` file in the project root with your MongoDB connection string.

#### macOS / Linux

```bash
cp .env.example .env.local
```

Or create it manually:

```bash
echo 'MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/filament-db?appName=Filaments' > .env.local
```

#### Windows (PowerShell)

```powershell
Copy-Item .env.example .env.local
```

Or create it manually:

```powershell
"MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/filament-db?appName=Filaments" | Out-File -Encoding utf8 .env.local
```

Then edit `.env.local` and replace the placeholder connection string with the one from your MongoDB Atlas dashboard:

```
MONGODB_URI=mongodb+srv://youruser:yourpassword@yourcluster.mongodb.net/filament-db?appName=Filaments
```

> **Note:** If your password contains special characters (`@`, `#`, `%`, etc.), you must URL-encode them. For example, `p@ssword` becomes `p%40ssword`.

---

## Exporting Your Config Bundle from PrusaSlicer

1. Open **PrusaSlicer**
2. Go to **File > Export > Export Config Bundle...**
3. Save the file (e.g., `PrusaSlicer_config_bundle.ini`)
4. Note the file path -- you will use it in the next step

---

## Importing Filaments

### Option 1: Web UI (recommended)

1. Start the application (`npm run dev`)
2. Click **"Import INI"** in the top right of the home page
3. Select your PrusaSlicer config bundle `.ini` file
4. Filaments are parsed and upserted into the database

### Option 2: CLI Seed Script

The seed script also auto-creates nozzle configurations from PrusaSlicer's `compatible_printers_condition` and links them to filaments.

#### Default Path

By default, the script looks for the config bundle at `~/Downloads/PrusaSlicer_config_bundle.ini`.

```bash
npx tsx scripts/seed.ts
```

#### Custom Path

Pass the file path as an argument:

##### macOS / Linux

```bash
npx tsx scripts/seed.ts /path/to/your/PrusaSlicer_config_bundle.ini
```

##### Windows

```powershell
npx tsx scripts/seed.ts C:\Users\YourName\Downloads\PrusaSlicer_config_bundle.ini
```

The script will output each nozzle and filament as it is imported:

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

## Running the Application

### Development Mode

```bash
npm run dev
```

Open http://localhost:3000 in your browser.

### Production Build

```bash
npm run build
npm start
```

The production server also runs on port 3000 by default. Use the `-p` flag to change it:

```bash
npm start -- -p 8080
```

---

## Running Tests

The project uses [Vitest](https://vitest.dev/) with [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) for in-memory database testing. Tests enforce 100% code coverage.

```bash
# Run tests once
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

A GitHub Actions workflow (`.github/workflows/test.yml`) runs tests automatically on push and pull requests to `main`, testing against Node.js 20 and 22.

---

## Using the Application

### Browsing Filaments

The home page displays all filaments in a sortable table with columns for color, name, vendor, type, nozzle temperature, bed temperature, and cost.

- **Search**: Type in the search box to filter filaments by name
- **Filter by Type**: Use the type dropdown to show only specific material types (PLA, PETG, ASA, etc.)
- **Filter by Vendor**: Use the vendor dropdown to show only filaments from a specific manufacturer
- **Sort**: Click any column header to sort ascending/descending. The active sort column is highlighted with a blue arrow

### Viewing Filament Details

Click any filament name in the table to see its full details:

- Temperature settings (nozzle, bed, chamber, first layer variants)
- Physical properties (cost, density, diameter)
- Performance settings (max volumetric speed, extrusion multiplier, pressure advance)
- Compatible nozzles and per-nozzle calibration values (EM, max vol speed, PA, retraction)
- Technical Data Sheet -- click "View Technical Data Sheet" to open an inline preview, or "Open in new tab" for full-screen
- Inheritance information (base profile reference)
- All raw PrusaSlicer settings (click "Show all PrusaSlicer settings" to expand)

### Adding a New Filament

1. Click **"+ Add Filament"** in the top right
2. Fill in the required fields (name, vendor, type)
3. Optionally set temperatures, cost, density, color, fan settings, retraction, shrinkage, pressure advance, and other properties
4. Select compatible nozzles and enter per-nozzle calibration overrides
5. Add a TDS link (suggestions from other filaments by the same vendor appear automatically)
6. Click **"Create Filament"**

### Editing a Filament

1. Click **"Edit"** next to any filament in the list, or click **"Edit"** on the detail page
2. Modify the fields you want to change
3. Click **"Update Filament"**

### Deleting a Filament

Click **"Delete"** next to any filament in the list. You will be prompted to confirm before deletion.

### Managing Nozzles

Click **"Manage Nozzles"** on the home page to view, create, edit, and delete nozzle profiles.

Each nozzle has:
- **Diameter** (0.25mm, 0.4mm, 0.6mm, etc.)
- **Type** (Brass, Hardened Steel, Stainless Steel, ObXidian, Diamondback, etc.)
- **High Flow** flag
- **Hardened** flag
- **Notes**

### Per-Nozzle Calibrations

When editing a filament, the **"Nozzle Calibrations"** section appears below the compatible nozzles checkboxes. For each selected nozzle, you can enter override values for:

- Extrusion Multiplier (EM)
- Max Volumetric Speed (mm³/s)
- Pressure Advance (PA)
- Retraction Length (mm)
- Retraction Speed (mm/s)
- Z Lift (mm)

Leave fields blank to use the filament's base defaults. When exporting to INI, filaments with calibrations generate one `[filament:Name NozzleSize]` section per nozzle with the overrides merged.

### Exporting to PrusaSlicer INI

Click **"Export INI"** in the top right to download all filaments as a PrusaSlicer-compatible INI file. This file contains all stored settings for each filament and can be imported back into PrusaSlicer via **File > Import > Import Config Bundle...**

Filaments with per-nozzle calibrations are exported as separate sections (e.g., `[filament:Generic HIPS MultiMaterial 0.4mm]` and `[filament:Generic HIPS MultiMaterial 0.6mm]`).

---

## Project Structure

```
filament-db/
├── .env.local                          # MongoDB connection string (not committed)
├── .env.example                        # Template for .env.local
├── .github/
│   └── workflows/
│       └── test.yml                    # CI: run tests on push/PR
├── scripts/
│   └── seed.ts                         # INI parser + DB seeder (with nozzle extraction)
├── src/
│   ├── app/
│   │   ├── layout.tsx                  # Root layout
│   │   ├── page.tsx                    # Home page (filament list, sortable)
│   │   ├── globals.css                 # Global styles
│   │   ├── api/
│   │   │   ├── filaments/
│   │   │   │   ├── route.ts            # GET (list/filter), POST (create)
│   │   │   │   ├── [id]/route.ts       # GET (with nozzle populate), PUT, DELETE
│   │   │   │   ├── export/route.ts     # GET (download INI, per-nozzle sections)
│   │   │   │   └── import/route.ts     # POST (upload INI file)
│   │   │   └── nozzles/
│   │   │       ├── route.ts            # GET (list), POST (create)
│   │   │       └── [id]/route.ts       # GET, PUT, DELETE
│   │   ├── filaments/
│   │   │   ├── FilamentForm.tsx        # Shared create/edit form (temps, fans, retraction, calibrations, TDS)
│   │   │   ├── new/page.tsx            # Create new filament page
│   │   │   └── [id]/
│   │   │       ├── page.tsx            # Detail page (calibrations table, TDS preview)
│   │   │       └── edit/page.tsx       # Edit filament page
│   │   └── nozzles/
│   │       ├── page.tsx                # Nozzle list page
│   │       ├── NozzleForm.tsx          # Shared nozzle create/edit form
│   │       ├── new/page.tsx            # Create new nozzle page
│   │       └── [id]/
│   │           └── edit/page.tsx       # Edit nozzle page
│   ├── lib/
│   │   ├── mongodb.ts                  # Cached Mongoose connection
│   │   └── parseIni.ts                 # INI filament section parser
│   └── models/
│       ├── Filament.ts                 # Filament schema (temps, calibrations, TDS, settings)
│       └── Nozzle.ts                   # Nozzle schema (diameter, type, highFlow, hardened)
├── tests/
│   ├── setup.ts                        # Test setup (mongodb-memory-server)
│   ├── parseIni.test.ts                # INI parser tests
│   ├── Filament.test.ts                # Filament model tests
│   ├── Nozzle.test.ts                  # Nozzle model tests
│   └── mongodb.test.ts                 # DB connection tests
├── vitest.config.ts                    # Vitest config (100% coverage thresholds)
├── package.json
├── tsconfig.json
└── tailwind.config.ts
```

---

## API Reference

### Filaments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/filaments` | List all filaments. Query params: `search`, `type`, `vendor` |
| `POST` | `/api/filaments` | Create a new filament |
| `GET` | `/api/filaments/:id` | Get a single filament by ID (populates nozzles and calibrations) |
| `PUT` | `/api/filaments/:id` | Update a filament by ID |
| `DELETE` | `/api/filaments/:id` | Delete a filament by ID |
| `GET` | `/api/filaments/export` | Download all filaments as a PrusaSlicer INI file |
| `POST` | `/api/filaments/import` | Upload an INI file to import filament profiles |

### Nozzles

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/nozzles` | List all nozzles. Query params: `diameter`, `type`, `highFlow` |
| `POST` | `/api/nozzles` | Create a new nozzle |
| `GET` | `/api/nozzles/:id` | Get a single nozzle by ID |
| `PUT` | `/api/nozzles/:id` | Update a nozzle by ID |
| `DELETE` | `/api/nozzles/:id` | Delete a nozzle by ID |

---

## Troubleshooting

### "MongoServerError: bad auth" when running seed script

Your MongoDB Atlas username or password is incorrect. Double-check the credentials in `.env.local`. If your password contains special characters (`@`, `#`, `%`, etc.), URL-encode them.

### "MongoNetworkError: connection timed out"

Your IP address is not whitelisted in MongoDB Atlas. Go to **Security > Network Access** in the Atlas dashboard and add your current IP address.

### Seed script says "0 filament profiles parsed"

The INI file might not contain custom filament profiles, or the file path is incorrect. Verify the file contains `[filament:...]` sections by opening it in a text editor.

### Port 3000 already in use

Another process is using port 3000. Either stop that process or run on a different port:

```bash
npm run dev -- -p 3001
```

### Tests fail with "MongoMemoryServer" error

The first run may need to download the MongoDB binary. Ensure you have internet access and try again. On CI, the binary is cached after the first run.

---

## License

MIT
