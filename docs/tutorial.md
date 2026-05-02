# Getting Started with Filament DB

[< Back to README](../README.md)

A step-by-step tutorial covering every feature of the app -- from first launch through NFC tag writing.

---

## Step 1: Install and Choose a Connection Mode

### Desktop App (recommended)

1. Download the latest release from [GitHub Releases](https://github.com/hyiger/filament-db/releases):
   - **macOS**: `.dmg`
   - **Windows**: `.exe`
   - **Linux**: `.AppImage` or `.deb`
2. Open the app. On first launch the **Setup Wizard** appears with three connection mode options:

| Mode | Description | Needs Atlas? | Needs Internet? |
|------|-------------|:------------:|:---------------:|
| **MongoDB Atlas (Cloud)** | All data in the cloud. If Atlas is unreachable on startup, automatically falls back to a local database. | Yes | Yes (with fallback) |
| **Hybrid (Local + Cloud Sync)** | Data stored locally, synced to Atlas when connected. *Recommended.* | Yes | No (works offline) |
| **Local Only (Offline)** | Everything stored on this computer. No account needed. | No | No |

3. **For Atlas or Hybrid**: paste your MongoDB Atlas connection string and click **Connect**. The app validates it before saving.
   - Don't have one? Click the Atlas link in the wizard, create a free cluster, then copy the connection string from **Connect > Drivers**. See the [Setup Guide](setup.md#setting-up-mongodb-atlas-free-tier) for details.
   - The string looks like `mongodb+srv://user:pass@cluster0.abc123.mongodb.net/filament-db`
4. **For Offline**: click **Local Only**, then **Start Offline**. No connection string needed.

### From Source (web app)

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
npm install
cp .env.example .env.local   # edit with your MongoDB Atlas URI
npm run dev                   # opens http://localhost:3456
```

> **Note:** The web app always requires a `MONGODB_URI` in `.env.local`. Offline and hybrid modes are desktop-app-only features.
>
> **Port:** Source/dev and the desktop app use port **3456**. Docker exposes container port **3000** and is normally mapped to host port **3456** with `-p 3456:3000`.

---

## Step 2: Understand the App Shell

A persistent top bar runs along every page with the app name on the left and quick links to **Filaments**, **Dashboard**, **Compare**, **Analytics**, **Share**, and **Settings**. On narrow screens (phones) the links collapse into a hamburger menu. The active page is highlighted.

Beside the **Filament DB** title on the home page is a small **connection status pill** that shows your current connection state at a glance:

### Web App

| Indicator | Meaning |
|-----------|---------|
| 🟢 **Connected** | Browser has network connectivity |
| 🔴 **Offline** | No network connection detected |

### Desktop App — Atlas Mode

| Indicator | Meaning |
|-----------|---------|
| 🟢 **Connected** | Atlas is reachable (verified by periodic ping) |
| 🟡 **No Connection** | Atlas is unreachable; if Atlas was unreachable on startup, the app is using a local fallback database |

### Desktop App — Hybrid Mode

| Indicator | Meaning |
|-----------|---------|
| 🟢 **Synced 2m ago** | Last sync completed successfully (relative time updates automatically) |
| 🔵 **Syncing...** | Sync in progress (pulsing dot) |
| 🟡 **Offline** | No network; app is using local data and will sync when reconnected |
| 🔴 **Sync error** | Last sync attempt failed |

**Click the pill** to open a tooltip with:
- Current connection mode
- Network status (Online / Offline)
- Last sync timestamp
- Error details (if any)
- **Sync Now** button for manual sync (disabled when offline)

### Desktop App — Offline Mode

| Indicator | Meaning |
|-----------|---------|
| ⚪ **Local** | All data stored locally (always shown) |

---

## Step 3: Set Up Your Printers

If you have multiple printers (e.g. a Prusa Core One and a Bambu H2D), define them now so you can store per-printer calibrations later. If you only have one printer or want to skip this, jump to Step 4.

1. Go to **Settings** (link in the top navigation bar), then click **Printers**.
2. Click **+ Add Printer**.
3. Fill in:
   - **Manufacturer** -- e.g. `Prusa`
   - **Model** -- e.g. `Core One`
   - The **Name** auto-generates as `Prusa Core One` (editable)
4. Under **Installed Nozzles**, check the nozzles available on this printer (you can come back to this after creating nozzles in Step 4).
5. Click **Create Printer**.
6. Repeat for each printer you own.

---

## Step 4: Create Your First Nozzle

Before adding filaments you need at least one nozzle profile so you can assign per-nozzle calibrations later.

1. Go to **Settings** (link in the top navigation bar), then click **Nozzles**.
2. Click **+ Add Nozzle**.
3. Fill in the form:
   - **Name** -- a short label, e.g. `0.4 Brass`
   - **Diameter** -- type a value or pick from the dropdown (0.1 to 2.0mm)
   - **Type** -- Brass, Hardened Steel, Stainless Steel, Copper, ObXidian, Diamondback, etc.
   - **High Flow** -- check if this is a high-flow nozzle
   - **Hardened** -- check if it can print abrasive materials
   - **Notes** -- optional free-text
4. Click **Create Nozzle**.
5. Repeat for each nozzle you own. You can always add more later.

---

## Step 5: Add a Filament

### Option A: Add Manually

1. From the home page, click **+ Add Filament**.
2. Fill in the required fields:
   - **Name** -- e.g. `Prusament PLA Galaxy Black`
   - **Vendor** -- e.g. `Prusa`
   - **Type** -- pick from the dropdown or type a custom type. Common types: PLA, PETG, PCTG, ABS, ASA, PA, PC, TPU.
3. Set the **color** using the color picker.
4. Fill in temperatures:
   - **Nozzle / Nozzle 1st Layer** -- e.g. `215 / 220`
   - **Bed / Bed 1st Layer** -- e.g. `60 / 65`
   - **Chamber** -- leave blank for open-air materials
5. Fill in optional properties:
   - **Cost** ($/kg), **Density** (g/cm3), **Diameter** (mm, defaults to 1.75)
   - **Max Volumetric Speed**, **Extrusion Multiplier**, **Pressure Advance**
   - **Shrinkage** XY/Z, **Fan** speeds, **Retraction** settings
   - **Abrasive** / **Soluble** flags
6. Under **Compatible Nozzles**, check each nozzle you've tested this filament with.
7. Under **TDS Link**, paste a URL to the vendor's Technical Data Sheet. If you've already added filaments from the same vendor, suggestion buttons appear -- click one to auto-fill.
8. Click **Create Filament**.

### Option B: Populate from an Existing Source

On the **Add New Filament** page, the **"Populate from"** toolbar offers four buttons plus an automatic NFC path:

- **Prusament QR** -- enter a spool ID or URL from a Prusament QR code to fetch full specs.
- **Import from TDS** -- paste a Technical Data Sheet URL and the AI extracts temperatures, density, drying specs, Tg, HDT, shore hardness, and more. Requires an AI API key configured in Settings (see [Step 5b](#step-5b-import-from-a-technical-data-sheet)).
- **Load from INI** -- upload a PrusaSlicer `.ini` config bundle. If it contains one filament profile, the form fills automatically. If multiple profiles are found, a picker dialog lets you choose which one.
- **Clone Existing** -- search your library and select a filament. Only identification fields (name with " (copy)" suffix, color, vendor, type) carry over; everything else inherits live from the parent so the new variant tracks the parent's calibrations going forward.
- **NFC Tag** (desktop only, no button — automatic) -- with a reader connected, place a tagged spool on it. The form auto-populates with material, vendor, temps, density, and color from the OpenPrintTag data.

After populating, review and adjust any fields before clicking **Create Filament**.

### Step 5b: Import from a Technical Data Sheet

If you have a link to a manufacturer's Technical Data Sheet (PDF or web page), the app can use AI to extract filament properties automatically.

**First-time setup (once):**

1. Go to **Settings** (link in the top navigation bar, or navigate to `/settings`).
2. Scroll to **AI Features**.
3. Choose a provider: **Google Gemini** (free tier), **Anthropic Claude**, or **OpenAI ChatGPT**.
4. Click the provider link to get an API key (Gemini is free, Claude and OpenAI are pay-per-use).
5. Paste the key and click **Save Key**. A green dot confirms it's configured.

**Importing from TDS:**

1. On the **Add New Filament** page, click **"Import from TDS"** (purple button in the toolbar).
2. Paste the TDS URL (e.g., `https://bambulab.com/filament/pla-basic-tds.pdf`).
3. Click **Extract**. The AI reads the document and extracts all available properties.
4. The form auto-populates with extracted data. A toast shows how many fields were extracted (e.g., "Extracted 12 fields from TDS").
5. The TDS URL is also saved to the filament's TDS Link field.
6. Review, adjust if needed, and click **Create Filament**.

---

## Step 6: Import Filaments in Bulk

### From PrusaSlicer

If you already have profiles in PrusaSlicer, bulk-import them instead of entering each one by hand.

1. In PrusaSlicer, go to **File > Export > Export Config Bundle** and save the `.ini` file.
2. On the Filament DB home page, open the **Import/Export** dropdown and click **Import INI**.
3. Select the `.ini` file.
4. A toast confirms how many filaments were imported: `Imported 42 filaments (38 new, 4 updated)`.

### From Another Filament DB (Atlas Import)

You can import filaments from another Filament DB instance hosted on MongoDB Atlas:

1. On the home page, open the **Import/Export** dropdown and click **Import from Atlas**.
2. Enter the MongoDB Atlas connection string for the remote database.
3. Click **Connect** -- the app retrieves all filaments from the remote database.
4. A list appears with checkboxes for each filament. Parent/variant hierarchy is indicated with indentation and arrow markers. Use **Select All** / **Deselect All** to toggle.
5. Click **Import X Filaments**, then **Confirm Import**.
6. Existing filaments with the same name are updated; new filaments are created. Parent-variant relationships from the remote database are not preserved.

### From a Prusament Spool QR Code

Prusament spools have a QR code linking to a detail page with full specifications (material, color, temperatures, weight, diameter tolerances, pricing).

1. On the home page, open the **Import/Export** dropdown and click **Prusament QR**.
2. Enter the spool ID (e.g., `c6974284da`) or paste the full URL from the QR code.
3. The app fetches and displays the spool data -- material, color swatch, temperatures, weights, pricing.
4. Choose **"New filament"** to create a fully-populated filament entry, or **"Add spool to existing"** to add the spool to a matching filament in your library.
5. Click **Import**.

You can also click **"+ Prusament QR"** on a filament's detail page (in the Spool Tracker section) to add another spool of the same material.

### From CSV or XLSX

1. On the home page, open the **Import/Export** dropdown and click **Import CSV** or **Import XLSX**.
2. Select a file with a header row containing at minimum `Name`, `Vendor`, and `Type` columns.
3. A toast confirms how many filaments were imported. Only fields present in the file are updated — existing data for unmapped columns is preserved.

### From a Snapshot Backup

1. Go to **Settings** and click **"Restore"** in the Database Snapshots section.
2. Select a previously exported snapshot JSON file.
3. All current snapshot-scoped data is replaced with the snapshot contents (best-effort rollback on failure).

### Via CLI (alternative)

```bash
# Default path (~/Downloads/PrusaSlicer_config_bundle.ini)
npx tsx scripts/seed.ts

# Custom path
npx tsx scripts/seed.ts /path/to/your_config.ini
```

The CLI also auto-creates nozzle profiles from `compatible_printers_condition` in the INI file.

---

## Step 7: Browse and Filter Your Library

The home page shows all filaments in a sortable table.

- **Search** -- type in the search box to filter by name
- **Filter by Type** -- use the type dropdown to show only PLA, PETG, ASA, etc.
- **Filter by Vendor** -- use the vendor dropdown to show only one manufacturer
- **Sort** -- click any column header (Name, Vendor, Type, Nozzle Temp, Bed Temp, Cost) to sort ascending or descending. The active sort shows a blue arrow.
- **Color swatches** -- each row shows the filament's color as a dot
- **Statistics** -- click the summary line (e.g. "18 filaments · 8 types · 5 vendors") to expand bar charts by type and vendor, plus a color swatch grid

### Parent/Variant Grouping

If you have color variants, parent filaments show a count badge (e.g. "5 colors"). Click the expand arrow to reveal variant rows, each showing their own color swatch and name. Click again to collapse.

---

## Step 8: View Filament Details

Click any filament name to open its detail page. You'll see:

- **Header** -- color swatch, name, vendor, type, and badges for "variant" or "3 colors"
- **Info cards** -- nozzle temp, bed temp, cost, density, diameter, max volumetric speed. Cards with a blue background and "(inherited)" label show values inherited from a parent filament.
- **Calibrations** -- tables grouped by printer (when multiple printers have data) showing per-nozzle values for EM, Max Vol Speed, PA, Retract Length, Retract Speed, and Z Lift. If no calibrations exist, compatible nozzles are shown as simple badges.
- **TDS preview** -- click "View Technical Data Sheet" to open an inline preview, or "Open in new tab" for full-screen. Many vendor sites (Shopify, Wix, etc.) refuse to be embedded in another page; for those URLs the preview pane shows an explanatory panel with an **Open data sheet ↗** button instead of a blank iframe.
- **PrusaSlicer settings** -- click "Show all PrusaSlicer settings" to expand every raw key-value pair.

### Variant navigation

- On a **parent** filament, a "Color Variants" section shows clickable cards for each variant (color dot + name + cost).
- On a **variant**, a blue banner says "Inherits settings from parent filament" with the count of inherited fields.

---

## Step 9: Edit a Filament

1. From the detail page, click **Edit** (blue button).
2. Change any fields. The form is identical to the create form, pre-filled with current values.
3. To add calibrations: check a nozzle under "Compatible Nozzles", then fill in the calibration fields that appear below. If you have printers defined, use the printer tabs to enter printer-specific values.
4. Click **Update Filament**.

You can also click the **Edit** button directly from the home page table row.

---

## Step 10: Create Color Variants

Variants share a parent's settings (temperatures, density, retraction, calibrations) and only store what's different: name, color, and cost.

1. Open a filament's detail page.
2. Click **Clone** (amber button — visible only on parent filaments, not on existing variants).
3. The form opens with the parent's **name** (suffixed with " (copy)"), **color**, **colorName**, **vendor**, and **type** pre-filled. All other fields are blank — they inherit live from the parent.
4. Edit the **name**, pick a new **color**, and optionally adjust **colorName**.
5. Click **Create Filament**. The new filament is registered as a variant of the parent and any future edits to the parent's calibrations / temperatures / settings will flow through automatically.

To turn an existing standalone filament into a variant:

1. Click **Edit** on the filament.
2. Under **Parent Filament**, search for and select the parent.
3. Click **Update Filament**.

---

## Step 11: Export to PrusaSlicer

1. On the home page, open the **Import/Export** dropdown and click **Export INI**.
2. A `.ini` file downloads containing all your filaments as `[filament:Name]` sections — one section per filament.
3. In PrusaSlicer, go to **File > Import > Import Config Bundle** and select the file.

Calibration overrides (extrusion multiplier, pressure advance, retraction, max volumetric speed) are not included in the exported INI — they are applied dynamically by PrusaSlicer Filament Edition via the calibration API when the printer/nozzle context changes.

---

## Step 12: Manage Nozzles and Printers

### Nozzles

Go to **Settings** and click **Nozzles**.

- **Edit** -- click Edit next to any nozzle to change its properties.
- **Delete** -- click Delete to remove a nozzle. If any filaments reference it, deletion is blocked and a message tells you how many filaments to update first.
- **Create** -- click + Add Nozzle to add a new one.

### Printers

Go to **Settings** and click **Printers**.

- **Edit** -- click Edit next to any printer to change its properties or update installed nozzles.
- **Delete** -- click Delete to remove a printer. If any filament calibrations reference it, deletion is blocked.
- **Create** -- click + Add Printer to add a new one.

### Bed Types

Go to **Settings** and click **Bed Types**.

- **Create** -- click + Add Bed Type to define a bed surface (e.g., "Smooth PEI", "Textured PEI", "G10/FR4").
- **Edit** -- click Edit next to any bed type to change its name, material, or notes.
- **Delete** -- click Delete to remove a bed type. If any filament calibrations reference it, deletion is blocked.

Once bed types are defined, the calibration section in the filament form shows a bed type selector so you can store per-bed-type overrides for temperatures, fan settings, and calibration values.

---

## Step 13: NFC Tags (Desktop App Only)

NFC features require the Electron desktop app plus hardware. Skip this section if you only use the web app.

### Hardware you need

| Item | Details |
|------|---------|
| **Reader** | ACS ACR1552U USB (~$40-50) |
| **OpenPrintTag tags** | NXP ICODE SLIX2 (ISO 15693, 320 bytes) — read/write |
| **Bambu Lab spools** | MIFARE Classic tags on Bambu filament spools — read-only (auto-detected) |
| **macOS driver** | Install [ifd-acsccid.bundle](https://www.acs.com.hk/en/drivers/) from ACS |
| **Linux / RPi driver** | `sudo apt install pcscd libpcsclite-dev` (standard `ccid` driver) |
| **Windows driver** | None needed — built-in Microsoft CCID driver works |

### NFC Status Indicator

A small colored dot appears in the header:

| Color | Meaning |
|-------|---------|
| Gray | No reader detected -- check USB connection |
| Yellow | Reader connected, waiting for a tag |
| Green | Tag detected on the reader |

### Reading a Tag

1. Plug in the ACR1552U. The status dot turns **yellow**.
2. Place a tagged spool on the reader. The dot turns **green**.
3. The app auto-detects the tag type (OpenPrintTag or Bambu Lab) and reads it. A dialog appears:
   - **Match found** -- shows the matched filament with a **View Filament** link.
   - **No match** -- shows the decoded tag data (material, brand, temps, density, etc.) with a **Create New Filament** button that pre-fills the form with everything from the tag.
   - **Similar filaments** -- if no exact match but the vendor or type is close, candidates appear. Click **+ Variant** next to one to create the tag's filament as a color variant of an existing parent.
   - **Bambu Lab spools** -- shows a "read-only" badge with production date and filament length. The create/import flow works the same — only writing back is disabled.
4. Click **Dismiss** to close the dialog.

### Writing a Tag

1. Navigate to any filament's detail page.
2. Place a blank SLIX2 tag on the reader (dot turns green).
3. Click **Write NFC** (purple button).
4. Wait ~2 seconds. The button shows **Written!** on success or **Write Failed** on error.

### Erasing a Tag

1. Go to **Settings** (link in the top navigation bar).
2. Scroll to the **NFC Tools** section — it shows the reader/tag status.
3. Place a tag on the reader (status turns green).
4. Click **Erase Tag** (red button).
5. Confirm the action. The app zeroes all memory blocks and writes a blank header.
6. The tag is now blank and ready to be rewritten.

If you remove the tag before confirming, the confirmation prompt closes automatically.

### Exporting an OpenPrintTag Binary

If you prefer using external NFC tools:

1. On any filament's detail page, click **Export OPT** (green button).
2. A `.bin` file downloads containing the NDEF-wrapped CBOR payload.
3. Write this file to a tag using your preferred NFC software.

---

## Step 14: Sync and Offline Workflow (Desktop App — Hybrid Mode)

If you chose **Hybrid** mode during setup, your data lives locally and syncs to Atlas automatically. Here's how it works day-to-day:

### Automatic Sync

- The app syncs with Atlas every **5 minutes** when connected.
- Changes made locally are pushed to Atlas; changes made remotely (e.g., from the web app or another device) are pulled down.
- **Synced collections**: filaments (with embedded spools), nozzles, printers, locations, bedtypes, printhistories, sharedcatalogs.
- The sync status pill next to "Filament DB" shows the current state — see [Step 2](#step-2-understand-the-connection-status-indicator).

### Working Offline

- If you lose internet, the app continues working normally against the local database.
- The status pill turns amber ("Offline").
- When connectivity returns, the next sync cycle picks up all changes from both sides.

### Manual Sync

- Click the status pill to open the tooltip, then click **Sync Now** to trigger an immediate sync.

### Conflict Resolution

If the same filament was edited on both sides since the last sync, the version with the most recent `updatedAt` timestamp wins (**last-write-wins**). This is per-document, not per-field.

### Atlas Fallback (Atlas Mode)

Even in pure **Atlas mode**, if Atlas is unreachable when the app starts, it automatically starts a local database and shows an amber "Offline — using local data" pill. Once Atlas becomes reachable again, a sync reconciles both sides.

---

## Step 15: Track Spools

Each filament can track multiple physical spools with individual weights.

1. On a filament's detail page, scroll to the **Spool Tracker** section.
2. Click **"+ Add Spool"** to add a new spool with an optional label and weight.
3. Each spool shows its label, total weight, and a delete button.
4. The tracker aggregates stats across all spools (total weight, computed length from density and diameter).

If a filament has a single `totalWeight` but no spools yet, click **"Migrate to spool tracking"** to convert it.

---

## Step 16: Browse the OpenPrintTag Community Database

Discover filaments from 100+ brands (10,000+ FDM materials) in the [OpenPrintTag community database](https://github.com/OpenPrintTag/openprinttag-database) and selectively import them into your library. The page shows live counts in its subtitle.

1. From the home page, open the **Import/Export** dropdown and click **"Browse OpenPrintTag DB"**.
2. The browser loads all FDM filaments (11,000+ materials; SLA resins are filtered out automatically).
3. Materials are color-coded by data completeness:
   - 🟢 **Rich** (7-10 fields) -- green progress bar, fully opaque
   - 🟡 **Partial** (4-6 fields) -- yellow progress bar, fully opaque
   - ⚪ **Stub** (0-3 fields) -- grey progress bar, 50% opacity
4. Use the **sidebar filters** to narrow results:
   - **Search** by name or brand
   - **Sort** by name, brand, type, or completeness
   - Filter by **Data Quality** tier, **Type**, or **Brand**
5. **Click any row** to expand a detail panel showing identity, properties (density, temps, hardness, transmission distance), and data quality with links.
6. **Select materials** using checkboxes, then click **"Import Selected"**.
7. Imported filaments are matched by name and vendor — existing entries are updated (only null fields are filled), new entries are created.

---

## Step 17: PrusaSlicer Integration

### Live Sync with PrusaSlicer Filament Edition

If you use [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer):

1. Start Filament DB (desktop app or web)
2. Launch PrusaSlicer Filament Edition — it fetches filament presets from Filament DB automatically
3. Your filaments appear in the filament dropdown; calibration values (EM, max volumetric speed, PA, retraction) are applied dynamically when you switch printer/nozzle
4. Edit filaments in Filament DB, restart PrusaSlicer, and the updated values appear automatically

> **Port:** Filament DB dev/desktop runs on port **3456**. Docker uses container port **3000** and is normally mapped to host port **3456**. PrusaSlicer defaults to `http://localhost:3456`.

### Manual Export/Import

Without the fork, sync manually:

1. Open the **Import/Export** dropdown on the home page and click **"Export INI"** to download a PrusaSlicer-compatible config bundle
2. In PrusaSlicer, go to **File > Import > Import Config Bundle** to load it
3. To re-import from PrusaSlicer, export a config bundle and use **Import/Export > "Import INI"** in Filament DB

---

## Step 18: Delete a Filament

1. On the home page, tick the checkbox at the start of any filament row (or the header checkbox to select every row).
2. A red bulk-action bar appears above the table showing the number selected.
3. Click **Delete N** in that bar and confirm.

**Note**: Parent filaments with color variants cannot be deleted — delete the variants first. Failed deletions surface in a per-row error toast and the rest of the batch still completes.

In hybrid mode, deletions are synced to Atlas on the next sync cycle. Deleted filaments are soft-deleted internally (marked with a timestamp) so the deletion propagates correctly across devices.

---

## Step 19: Set Up Locations *(v1.11)*

Before you reach for the spool tracker, it's worth describing where your physical spools live:

1. Navigate to **Locations** (top nav) → `/locations`
2. Click **+ Add Location**
3. Give it a name (e.g. `Drybox #1`), pick a **kind** (shelf / drybox / cabinet / printer), and optionally record the humidity
4. Repeat for every physical container you want to track

Once you have at least one location, every spool you add (or edit) gains a **Location** dropdown. The Locations list view shows live inventory counts — number of spools and total grams on hand per location — so you can tell at a glance which drybox is almost empty.

## Step 20: Configure Low-Stock Thresholds *(v1.11)*

1. Edit any filament
2. Under **Stock settings**, set **Low-stock threshold (g)** — e.g. `250` to be warned when under 250g remains across all spools
3. Save

The dashboard surfaces every filament under its threshold in the **Low stock** list. A small chip on the main filament list marks them too. Filaments without a threshold are never flagged.

## Step 21: Log Print Jobs, Watch Analytics *(v1.11)*

Each time you run a print, log it either from your slicer (via `/api/print-history`) or manually on the spool detail page (**Log usage** → enter grams). The app:

- Decrements the spool's weight
- Appends a `usageHistory` entry
- Updates the **Analytics** dashboard

Open **Analytics** (`/analytics`) to see consumption over the last 7 / 30 / 90 / 365 days, broken down by filament, vendor, and printer. Manual spool-edit entries and slicer-driven jobs show up in the same view without double-counting.

## Step 22: Log Dry Cycles *(v1.11)*

If you dry your filament before printing, log each cycle on the spool detail panel:

1. Open the spool
2. Click **+ Log dry cycle**
3. Record temperature, duration, and any notes

The dashboard's **Needs drying** list surfaces spools whose last cycle is older than 30 days.

## Step 23: Share a Catalog *(v1.11)*

Want to send a friend your exact PLA + PETG setup?

1. Navigate to **Share** (`/share`)
2. Click **+ New shared catalog**
3. Pick filaments (multi-select), set a title, optional description, optional expiry
4. Click **Publish** — you get back a short URL

Recipients who open the URL see a read-only list. They can multi-select and click **Import selected** to pull the filaments (plus referenced nozzles/printers/bed-types) into their own instance. Same-named records on the destination are reused, so nothing gets duplicated.

**Unpublish** is a soft-delete: the slug returns 404 to anyone holding the link immediately, but the row stays in the collection so peer sync carries the unpublish across (without it, the other peer would push the still-active copy back). Slugs can be reused by future republishes.

## Step 24: Compare Filaments *(v1.11)*

On the filament list, tick the checkbox next to 2–4 rows and click **Compare**. The `/compare` page lays them out side-by-side — temperatures, cost, density, calibrations, and remaining weight — so you can pick the right one for a job.

## Step 25: Bulk Import Spools from a Spreadsheet *(v1.11)*

1. Export your inventory from a spreadsheet with columns: `filament, totalWeight` (required) plus optional `vendor, label, lotNumber, purchaseDate, openedDate, location`
2. On the filament list, click **Import → Spools from CSV**
3. Paste the CSV or upload the file
4. Review the per-row results — any typos are flagged with the row number so you can fix and retry

Missing locations are auto-created, so you don't need to seed locations in advance.

---

## Quick Reference

| Action | Where |
|--------|-------|
| Add filament | Home > + Add Filament |
| Populate from NFC / TDS / INI / Clone | Add Filament > Populate from toolbar |
| Import from TDS | Add Filament > Import from TDS |
| Configure AI provider | Settings > AI Features |
| Import from PrusaSlicer | Home > Import/Export > Import INI |
| Import from CSV/XLSX | Home > Import/Export > Import CSV / Import XLSX |
| Import Prusament spool | Home > Import/Export > Prusament QR |
| Import from Atlas | Home > Import/Export > Import from Atlas |
| Browse OpenPrintTag DB | Home > Import/Export > Browse OpenPrintTag DB |
| Restore from snapshot | Settings > Database Snapshots > Restore |
| Export to PrusaSlicer | Home > Import/Export > Export INI |
| Export to CSV/XLSX | Home > Import/Export > Export CSV / Export XLSX |
| Backup database | Settings > Database Snapshots > Backup |
| View filament details | Home > click filament name |
| Edit filament | Detail page > Edit |
| Add color variant | Detail page > + Add Color |
| Manage nozzles | Settings > Nozzles |
| Manage printers | Settings > Printers |
| Browse API docs | Settings > API Documentation (or navigate to `/api-docs`) |
| Write NFC tag | Detail page > Write NFC (desktop app) |
| Erase NFC tag | Settings > NFC Tools > Erase Tag (desktop app) |
| Export NFC binary | Detail page > Export OPT |
| Track spools | Detail page > Spool Tracker > + Add Spool |
| Assign spool to a location | Spool detail > Location dropdown |
| Log manual spool usage | Spool detail > Log usage |
| Log a dry cycle | Spool detail > + Log dry cycle |
| View usage analytics | Top nav > Analytics |
| Set low-stock threshold | Filament edit > Stock settings |
| Compare filaments | List > select rows > Compare |
| Publish a shared catalog | Top nav > Share > + New |
| Import spools from CSV | Home > Import > Spools from CSV |
| Switch theme | Settings > Theme |
| Manual sync | Click status pill > Sync Now (desktop hybrid mode) |
| Check connection status | Status pill next to "Filament DB" title |

---

## Troubleshooting

See the [Troubleshooting Guide](troubleshooting.md) for common issues and solutions.
