# Using the Application

[< Back to README](../README.md)

## Browsing Filaments

The home page displays all filaments in a sortable table with columns for color, name, vendor, type, nozzle temperature, bed temperature, cost, and remaining spool percentage.

- **Statistics**: Click the summary line (e.g. "18 filaments · 8 types · 5 vendors") to expand a panel with bar charts by type and vendor, plus a color swatch grid
- **Search**: Type in the search box to filter filaments by name
- **Filter by Type**: Use the type dropdown to show only specific material types (PLA, PETG, ASA, etc.)
- **Filter by Vendor**: Use the vendor dropdown to show only filaments from a specific manufacturer
- **Sort**: Click any column header to sort ascending/descending. The active sort column is highlighted with a blue arrow

## Viewing Filament Details

Click any filament name in the table to see its full details:

- Temperature settings (nozzle, bed, chamber, first layer variants)
- Physical properties (cost, density, diameter)
- Performance settings (max volumetric speed, extrusion multiplier, pressure advance)
- Compatible nozzles and per-printer per-nozzle calibration values (EM, max vol speed, PA, retraction)
- Technical Data Sheet -- click "View Technical Data Sheet" to open an inline preview, or "Open in new tab" for full-screen
- Inheritance information (base profile reference)
- All raw PrusaSlicer settings (click "Show all PrusaSlicer settings" to expand)

## Adding a New Filament

1. Click **"+ Add Filament"** in the top right
2. Optionally use the **"Populate from"** toolbar to pre-fill the form:
   - **Place an NFC tag** on the reader to auto-populate from OpenPrintTag data (desktop only)
   - **Import from TDS** to extract properties from a Technical Data Sheet URL using AI (requires API key — see [AI Settings](#ai-settings))
   - **Prusament QR** to fetch specs from a Prusament spool QR code
   - **Load from INI** to pick a profile from a PrusaSlicer config bundle
   - **Clone Existing** to copy all settings from another filament in your library
3. Fill in the required fields (name, vendor, type)
4. Optionally set temperatures, cost, density, color, fan settings, retraction, shrinkage, pressure advance, and other properties
5. Select compatible nozzles and enter per-nozzle calibration overrides
6. Add a TDS link (suggestions from other filaments by the same vendor appear automatically)
7. Click **"Create Filament"**

## Editing a Filament

1. Click **"Edit"** next to any filament in the list, or click **"Edit"** on the detail page
2. Modify the fields you want to change
3. Click **"Update Filament"**

## Deleting a Filament

Click **"Delete"** next to any filament in the list. You will be prompted to confirm before deletion.

---

## Importing from MongoDB Atlas

You can import filaments from another Filament DB instance hosted on MongoDB Atlas:

1. Click **"Import from Atlas"** on the home page
2. Enter the MongoDB Atlas connection string (e.g., `mongodb+srv://user:pass@cluster.mongodb.net/`)
3. Click **"Connect"** — the app will retrieve all filaments from the remote database
4. Select which filaments to import (all are selected by default). Use **"Select All"** / **"Deselect All"** to toggle
5. Click **"Import"** then **"Confirm Import"**
6. Existing filaments with the same name will be updated; new filaments will be created

Parent-variant relationships from the remote database are not preserved — all imported filaments are standalone.

---

## Connection Status Indicator

A status pill appears next to the "Filament DB" title on the home page, showing the current connection state:

### Web App

| Indicator | Meaning |
|-----------|---------|
| 🟢 **Connected** | Browser has network connectivity |
| 🔴 **Offline** | No network connection |

### Desktop App — Atlas Mode

| Indicator | Meaning |
|-----------|---------|
| 🟢 **Connected** | Atlas is reachable (verified by periodic ping) |
| 🟡 **No Connection** | Atlas is unreachable; using local fallback if Atlas was unreachable on startup |

### Desktop App — Hybrid Mode

| Indicator | Meaning |
|-----------|---------|
| 🟢 **Synced 2m ago** | Last sync completed successfully |
| 🔵 **Syncing...** | Sync in progress (pulsing dot) |
| 🟡 **Offline** | No network; using local data, will sync when reconnected |
| 🔴 **Sync error** | Last sync attempt failed |

Click the pill to open a tooltip with mode, network status, last sync timestamp, error details, and a **"Sync Now"** button for manual sync. Automatic sync runs every 5 minutes when Atlas is reachable.

Synced collections: filaments (with embedded spools), nozzles, printers, locations, bedtypes, printhistories, sharedcatalogs. Sync uses **last-write-wins** conflict resolution: if the same filament was edited on both sides, the most recently updated version wins (per-document, based on `updatedAt` timestamp). Soft-deletes propagate via `_deletedAt`.

### Desktop App — Offline Mode

| Indicator | Meaning |
|-----------|---------|
| ⚪ **Local** | All data stored locally (always shown) |

---

## Language

Go to **Settings** and use the **Language** toggle to switch between English and German. The setting is persisted in the desktop app's config (or localStorage in the web app) and takes effect immediately across all pages.

---

## Managing Nozzles

Go to **Settings** and click **Nozzles** to view, create, edit, and delete nozzle profiles.

Each nozzle has:
- **Diameter** (0.25mm, 0.4mm, 0.6mm, etc.)
- **Type** (Brass, Hardened Steel, Stainless Steel, ObXidian, Diamondback, etc.)
- **High Flow** flag
- **Hardened** flag
- **Notes**

---

## Managing Bed Types

Go to **Settings** and click **Bed Types** to view, create, edit, and delete bed type profiles.

Each bed type has:
- **Name** (e.g., "Smooth PEI", "Textured PEI", "G10/FR4")
- **Material** -- the surface material (PEI, Textured PEI, Spring Steel, Glass, G10/FR4, BuildTak, PEX, Polypropylene, Other)
- **Notes**

Bed types are used in calibrations to store per-printer per-nozzle per-bed-type override values. They cannot be deleted if they are referenced by any filament calibrations.

---

## Managing Printers

Go to **Settings** and click **Printers** to view, create, edit, and delete printer profiles.

Each printer has:
- **Manufacturer** (e.g. Prusa, Bambu Lab)
- **Model** (e.g. Core One, X1C)
- **Name** -- auto-generated from manufacturer + model, but editable
- **Installed Nozzles** -- select which nozzles are available on this printer
- **Notes**

Printers cannot be deleted if they are referenced by any filament calibrations. The error message tells you how many filaments reference the printer.

---

## Calibrations

When editing a filament, the **"Calibrations"** section appears below the compatible nozzles checkboxes. For each selected nozzle, you can enter override values for:

**Calibration fields:**
- Extrusion Multiplier (EM)
- Max Volumetric Speed (mm³/s)
- Pressure Advance (PA)
- Retraction Length (mm)
- Retraction Speed (mm/s)
- Z Lift (mm)

**Temperature overrides** (per calibration entry):
- Nozzle Temp / Nozzle First Layer Temp
- Bed Temp / Bed First Layer Temp
- Chamber Temp

**Fan settings** (per calibration entry):
- Min Fan Speed (%)
- Max Fan Speed (%)
- Bridge Fan Speed (%)

### Per-Printer Calibrations

If you have defined printers, **printer tabs** appear above the calibration fields. Each tab represents a printer (plus a "Default (any printer)" tab for values that apply to all printers).

- **Default tab** -- calibration values that apply when no printer-specific override exists
- **Printer tabs** -- calibration values specific to that printer. Placeholder values show the default calibration value so you can see what you're overriding.

### Per-Bed-Type Calibrations

If you have defined bed types, a **bed type selector** appears within each nozzle section. Select a bed type (or "Any bed" for the default) to enter calibration values specific to that bed surface.

This lets you store different temperatures, PA, EM, and retraction values for the same filament on different printer + nozzle + bed type combinations (e.g., smooth PEI on a Prusa Core One vs. textured PEI on a Bambu H2D).

Leave fields blank to use the filament's base defaults. Top-level filament temperatures remain as manufacturer-recommended defaults. The INI export uses a single-section-per-filament architecture: each filament produces one `[filament:Name]` section with its base settings. Calibration overrides are not embedded in the INI — PrusaSlicer Filament Edition fetches them dynamically via `GET /api/filaments/{id}/calibration` when you switch printer or nozzle.

---

## Technical Data Sheets

Each filament can have a TDS (Technical Data Sheet) link. On the edit form:

- Enter the URL in the **"TDS Link"** field
- If the field is empty, suggestion buttons appear from other filaments by the same vendor -- click one to auto-fill the URL

On the detail page:

- Click **"View Technical Data Sheet"** to open an inline preview pane
- Click **"Open in new tab"** to view the full document in a new browser tab

---

## NFC Tags (Desktop App Only)

The desktop app supports reading and writing OpenPrintTag NFC-V tags and reading Bambu Lab MIFARE Classic spool tags. See the [NFC documentation](nfc.md) for hardware requirements and setup.

### Reading Tags

Place a tag on the reader -- the app auto-detects the tag type (OpenPrintTag or Bambu Lab) and reads it. A dialog appears showing:

- **Match found**: Shows the matching filament with a link to view it
- **No match**: Shows the decoded data with an option to create a new filament (form pre-filled with tag data)
- **Bambu Lab spools**: Displays a "read-only" badge since Bambu tags cannot be written; also shows production date and filament length

### Writing Tags

On any filament's detail page:

1. Place a tag on the reader (status turns green)
2. Click **"Write NFC"**
3. Wait for the write to complete (button shows "Written!" on success)

### Erasing / Formatting Tags

On the **Settings** page, the NFC Tools section lets you erase a tag:

1. Place a tag on the reader (status turns green)
2. Click **"Erase Tag"** and confirm
3. The tag is wiped — blank CC header, terminator, and zeroed memory

### Exporting OpenPrintTag Binary

Click **"Export OPT"** on any filament's detail page to download the binary as a `.bin` file for use with external NFC tools.

---

## AI-Powered TDS Import

Extract filament properties automatically from a manufacturer's Technical Data Sheet using AI. Supports PDF and web page TDS URLs.

### Setup

1. Go to **Settings** and scroll to the **AI Features** section
2. Select your preferred AI provider: **Google Gemini**, **Anthropic Claude**, or **OpenAI ChatGPT**
3. Get a free API key from your chosen provider (links are provided in the settings page)
4. Paste the key and click **Save Key** — the key is validated before saving

### Using TDS Import

1. Click **"+ Add Filament"** on the home page
2. In the **"Populate from"** toolbar, click **"Import from TDS"** (purple button)
3. Paste the URL of a filament's Technical Data Sheet
4. Click **"Extract"** — the AI analyzes the document and extracts properties
5. The form auto-populates with extracted data (temperatures, density, drying specs, Tg, HDT, shore hardness, print speeds, etc.)
6. Review and adjust any fields, then click **"Create Filament"**

The TDS URL is also saved to the filament's `tdsUrl` field for future reference.

### Supported Providers

| Provider | Model | Free Tier | PDF Support |
|----------|-------|-----------|-------------|
| Google Gemini | gemini-2.0-flash | 15 requests/minute | Native |
| Anthropic Claude | claude-sonnet-4-20250514 | Pay-per-use | Native |
| OpenAI ChatGPT | gpt-4o-mini | Pay-per-use | Text extraction |

### AI Settings

On the **Settings** page under **AI Features**:

- **Provider selector** — click a provider button to switch between Gemini, Claude, and ChatGPT
- **API key** — masked input field with show/hide toggle
- **Save Key** — validates the key against the selected provider before saving
- **Remove Key** — clears the stored key
- **Status indicator** — green dot when configured, gray when not

In the desktop app, the API key is stored in the locally persisted config file. In the web app, set the key via the Settings page or use environment variables (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`).

---

## Spool Tracking

Each filament can track multiple physical spools with individual weights.

### Adding Spools

On a filament's detail page, the **Spool Tracker** section appears when weight data exists. Click **"+ Add Spool"** to add a new spool entry with an optional label and weight.

### Managing Spools

Each spool row shows:
- **Label** -- editable text (e.g., "Opened 2025-03-15" or a Prusament spool ID)
- **Total Weight** -- weight in grams (including the empty spool)
- **Delete** button to remove the spool entry

The tracker aggregates stats across all spools, showing total remaining weight and computed length (from density and diameter).

### Migrating from Single Weight

If a filament has a `totalWeight` value but no spools array, a **"Migrate to spool tracking"** button converts the single weight into a spool entry.

### Spool Check (PrusaSlicer Integration)

When using PrusaSlicer Filament Edition, a spool check runs automatically after slicing. PrusaSlicer queries the Filament DB API with the estimated print weight and compares it to the remaining filament on each spool. If no spool has enough material, a warning notification appears in PrusaSlicer.

The check requires that the filament has a **spool weight** (empty spool) set and at least one spool with a **total weight** (current scale reading). If no weight data is available, the check is silently skipped.

---

## Prusament Spool Import

Prusament filament spools have a QR code linking to a detail page with full specifications.

1. Click **"Prusament QR"** on the home page, or **"+ Prusament QR"** on a filament's spool tracker
2. Enter the spool ID (e.g., `c6974284da`) or paste the full URL
3. Review the extracted data (material, color, temperatures, weights, pricing, diameter tolerances)
4. Choose **"New filament"** to create a fully-populated entry, or **"Add spool to existing"** to add the spool to a matching filament
5. Click **Import**

This also works from a filament's detail page to add another spool of the same material.

---

## CSV and XLSX Import/Export

### Exporting

Click **"Export CSV"** or **"Export XLSX"** on the home page to download all filaments in the chosen format. The export includes name, vendor, type, color, color name, temperatures (nozzle, bed, first layer, ranges, standby), cost, density, weights, instance ID, drying temperature/time, transmission distance, glass transition (Tg), heat deflection (HDT), shore hardness (A/D), print speed ranges, and spool type.

XLSX exports include styled headers, color-coded cells, auto-filter, and a frozen header row.

### Importing

Click **"Import CSV"** or **"Import XLSX"** on the home page to upload a file (max 10 MB). The file must have a header row with at minimum `Name`, `Vendor`, and `Type` columns. Additional columns are mapped by header name (case-insensitive), including glass transition (Tg), heat deflection (HDT), shore hardness (A/D), print speed ranges, nozzle temp ranges, standby temp, color name, and spool type. Only fields present in the file are updated — existing data for unmapped columns is preserved. Rows missing required fields are reported with row numbers and reasons.

---

## Snapshot Backup & Restore

### Exporting a Snapshot

Go to **Settings** and click **"Backup"** in the Database Snapshots section to download a JSON snapshot of the entire database. The snapshot includes all filaments, nozzles, and printers (including soft-deleted documents) with all references and timestamps preserved.

### Restoring a Snapshot

Go to **Settings** and click **"Restore"** in the Database Snapshots section. Select a previously exported snapshot file. This replaces all current data with the snapshot contents. The restore uses best-effort rollback — if any part fails, the handler attempts to re-insert the previous data from an in-memory backup.

---

## Instance IDs

Each filament has a unique instance identifier (5-byte hex string, e.g. `2acc21072a`), auto-generated on creation. This matches Prusament's `brand_specific_instance_id` format and is written to NFC tags. Instance IDs are visible on the filament detail page next to the vendor/type and are included in CSV/XLSX exports.

---

## OpenPrintTag Community Database Browser

Browse the [OpenPrintTag community database](https://github.com/OpenPrintTag/openprinttag-database) directly from Filament DB to discover and import filaments from 97 brands.

### Accessing the Browser

From the home page, open the **Import/Export** dropdown and click **"Browse OpenPrintTag DB"** (teal dot). The browser fetches the entire database from GitHub on first load (~3 MB, cached for 1 hour).

### Browsing and Filtering

The browser shows only FDM filaments (SLA resins are filtered out). Use the sidebar controls to narrow results:

- **Search** -- filter by filament name or brand
- **Sort** -- by name, brand, type, or completeness score
- **Data Quality** -- filter by completeness tier:
  - 🟢 **Rich** (7-10 fields) -- well-documented materials
  - 🟡 **Partial** (4-6 fields) -- moderately complete
  - ⚪ **Stub** (0-3 fields) -- minimal data, rendered at 50% opacity
- **Type** -- filter by material type (PLA, PETG, ABS, TPU, etc.)
- **Brand** -- filter by manufacturer (searchable list with material counts)

### Viewing Material Details

Click any material row to expand a detail panel with three columns:

- **Identity** -- brand, slug, type abbreviation, color swatch, UUID
- **Properties** -- density, nozzle temp range, bed temp range, chamber temp, drying temp/time, shore hardness, transmission distance
- **Data Quality & Links** -- completeness score bar (out of 10), photo preview, product URL, tags

### Importing Materials

1. Select materials using checkboxes (or use **Select All** / **Clear Selection** in the toolbar)
2. Click **"Import Selected (N)"** to import
3. Materials are matched by name and vendor:
   - **New materials** are created with all available fields
   - **Existing materials** are updated conservatively -- only null/empty fields are filled, preserving your existing calibration data

---

## PrusaSlicer Integration

### Live Sync (PrusaSlicer Filament Edition)

If you use [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer), filament presets load automatically from Filament DB on startup:

1. Start Filament DB (desktop app or web at `http://localhost:3456`)
2. Launch PrusaSlicer Filament Edition
3. Your filament presets appear in the filament dropdown; calibration values (EM, max volumetric speed, pressure advance, retraction) are applied dynamically when you switch printer/nozzle

### Spool Check (Insufficient Filament Warning)

PrusaSlicer Filament Edition can check after slicing whether the selected spool has enough filament for the print. It calls `GET /api/filaments/{name}/spool-check?weight=XX` with the estimated filament weight in grams. If no spool has enough remaining filament, PrusaSlicer displays a warning with the shortfall amount. This requires spool tracking to be set up with current weights (see [Spool Tracking](#spool-tracking)).

### Manual INI Export/Import

Even without the fork, you can manually sync:

- **Export**: Click **"Export INI"** on the home page to download all filaments as a PrusaSlicer-compatible config bundle
- **Import**: In PrusaSlicer, go to **File > Import > Import Config Bundle** to load the exported file
- **Re-import**: Click **"Import INI"** to import a PrusaSlicer config bundle back into Filament DB

---

## API Documentation

Go to **Settings** and click **"API Documentation"** to open the interactive Swagger UI at `/api-docs`. This provides a browsable, testable interface for all REST API endpoints with full request/response schemas. The underlying OpenAPI 3.0 spec is available at `/api/openapi` (dynamically versioned from `package.json`).

---

## Dashboard *(v1.11)*

The **Dashboard** page at `/dashboard` is the home of your inventory at a glance:

- **Totals** — filament count, spool count, grams on hand, total cost on hand
- **Low-stock warnings** — any filament whose aggregate remaining is under its per-filament `lowStockThreshold`. Clicking a row jumps to the filament detail.
- **Needs drying** — spools whose most recent dry cycle is older than 30 days (configurable in settings later), grouped by filament type
- **Quick links** — shortcut buttons to the filament list, analytics, locations, and share views

Low-stock thresholds are set per filament on the edit page under **Stock settings → Low-stock threshold (g)**. A filament with no threshold is never flagged.

## Locations *(v1.11)*

The **Locations** page at `/locations` lets you describe where your physical spools live — dryboxes, shelves, cabinets, AMS units, and so on. Each location has:

- **Name** (unique) and optional **kind** — free-form label used to group locations in pickers (`drybox`, `shelf`, `cabinet`, `printer`, etc.)
- **Humidity %RH** — optional, user-updated. Useful for tracking conditions inside a drybox.
- **Notes** — free-form.

Once you've created at least one location, the spool detail panel gains a **Location** dropdown. Assign spools there and the list view stats show spool counts and total grams per location.

**Delete protection:** the UI refuses to delete a location that's still referenced by any spool. Reassign those spools first, or retire them, and the delete will succeed.

## Spool Photos, Retirement & Dry Cycles *(v1.11)*

Each spool now has three additional ledgers accessible from its detail panel:

- **Photo** — upload a JPEG/PNG (SVG is rejected for security). The file is downsampled to 1200px and compressed client-side to ~200KB before being stored inline on the spool subdocument, so there's no file-upload endpoint.
- **Retired** — toggle to remove a spool from inventory totals, the PrusaSlicer spool-check endpoint, and the main spool list. History is preserved.
- **Dry cycles** — log each drying session with optional temperature (°C), duration (minutes), and notes. The dashboard's "needs drying" warning reads from this log.
- **Usage history** — each manual weight decrement (or slicer-driven print job) appends an entry tagged with its source (`manual`, `slicer`, `job`, `nfc`).

## Bulk Spool CSV Import *(v1.11)*

Click **Import → Spools from CSV** on the main list. Paste your CSV or upload a file with these columns:

- **Required:** `filament`, `totalWeight`
- **Optional:** `vendor` (disambiguates duplicate filament names), `label`, `lotNumber`, `purchaseDate` (YYYY-MM-DD), `openedDate`, `location` (auto-created if not found)

The importer reports per-row success / failure, so a handful of typos won't abort the whole paste. Rows are capped at 10,000 per request.

## Print History *(v1.11)*

When a slicer (or a user) posts a print job to `/api/print-history`, two things happen:

1. A `PrintHistory` document is created — the canonical record of what ran, on which printer, how many grams of each filament.
2. Each referenced spool's `totalWeight` is decremented and a `usageHistory` entry is appended tagged `source: "job"`.

These writes run inside a MongoDB transaction when the deployment supports it (Atlas replicas, hybrid mode) so a mid-write failure can't leave inventory out of sync with the history ledger.

## Usage Analytics *(v1.11)*

The **Analytics** page at `/analytics` draws from PrintHistory records plus any manual per-spool usage entries (the ones you logged directly on the spool UI without going through the print-history endpoint).

- **Window**: 7, 30, 90, or 365 days
- **Totals**: grams, estimated cost, jobs
- **Usage by day**: bar chart
- **Breakdown**: by filament, by vendor, by printer

Manual job entries don't show up twice: entries tagged `source: "job"` or `"slicer"` are owned by a PrintHistory row and already counted in the primary aggregation. Only `source: "manual"` entries (true direct-edit logs) are added from the fallback pass.

## Sharing a Catalog *(v1.11)*

The **Share** page at `/share` lets you publish a static snapshot of selected filaments under a short slug. Use case: you want a friend to install the exact same PLA+PETG loadout you're running.

1. Select the filaments you want to share (multi-select)
2. Give the catalog a title + optional description, and optional expiry date
3. Click **Publish** — the server collects every nozzle / printer / bed-type referenced by those filaments and denormalises everything into the payload, so the recipient gets a complete, consistent set

**Public view** (`/share/{slug}`) — anyone with the link can browse the catalog, selectively import filaments into their own instance, and see a view counter that increments atomically. Published catalogs are static: later edits to the source filaments do not change what subsequent viewers download.

**Unpublishing** is a soft-delete: the slug returns 404 to the public immediately, but the row stays in the collection so peer sync can carry the unpublish across as a tombstone (without it, the other peer would push the still-active copy back on the next sync cycle). Slugs from unpublished catalogs can be reused by future republishes.

**Importing** on the destination side rehydrates referenced entities first (nozzles, printers, bed-types), then creates the filaments with the correct local IDs. Same-named records on the destination are reused rather than duplicated; calibrations pointing at unresolvable references are dropped rather than saved dangling.

## Filament Comparison *(v1.11)*

The **Compare** page at `/compare` takes up to N filaments (pass via query string, or add from the filament list) and renders a side-by-side table of temperatures, cost, density, diameter, calibrations, and current remaining weight. Useful when deciding which of several similar filaments to use for a job.

## System Theme *(v1.11)*

Settings → **Theme**: choose **Light**, **Dark**, or **System**. System mode follows the OS `prefers-color-scheme` media query. An inline init script runs before React mounts so the first paint is already the correct theme — no dark-mode flicker on cold load.

## Auto-Update (Desktop) *(v1.11)*

A thin banner at the top of the app announces when a new version is available, downloads it in the background on request, and prompts for a restart-and-install when ready. All strings are localized — the native install confirmation dialog uses the renderer's current locale.

On macOS, unsigned builds cannot auto-install through Gatekeeper. The banner surfaces a **View release** button as a fallback so you can download the DMG manually.
