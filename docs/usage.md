# Using the Application

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
- Compatible nozzles and per-nozzle calibration values (EM, max vol speed, PA, retraction)
- Technical Data Sheet -- click "View Technical Data Sheet" to open an inline preview, or "Open in new tab" for full-screen
- Inheritance information (base profile reference)
- All raw PrusaSlicer settings (click "Show all PrusaSlicer settings" to expand)

## Adding a New Filament

1. Click **"+ Add Filament"** in the top right
2. Optionally use the **"Populate from"** toolbar to pre-fill the form:
   - **Place an NFC tag** on the reader to auto-populate from OpenPrintTag data (desktop only)
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

## Sync Status (Desktop App — Hybrid Mode)

When running in hybrid mode, a sync status indicator appears next to the "Filament DB" title:

- **Green pill** ("Synced 2m ago") — last sync completed successfully
- **Blue pulsing pill** ("Syncing...") — sync is in progress
- **Amber pill** ("Offline") — Atlas is unreachable; the app is using local data
- **Red pill** ("Sync error") — last sync failed

Click the indicator to see details and a **"Sync Now"** button for manual sync. Automatic sync runs every 5 minutes when Atlas is reachable.

Sync uses **last-write-wins** conflict resolution: if the same filament was edited on both sides, the most recently updated version wins.

---

## Managing Nozzles

Click **"Manage Nozzles"** on the home page to view, create, edit, and delete nozzle profiles.

Each nozzle has:
- **Diameter** (0.25mm, 0.4mm, 0.6mm, etc.)
- **Type** (Brass, Hardened Steel, Stainless Steel, ObXidian, Diamondback, etc.)
- **High Flow** flag
- **Hardened** flag
- **Notes**

---

## Per-Nozzle Calibrations

When editing a filament, the **"Nozzle Calibrations"** section appears below the compatible nozzles checkboxes. For each selected nozzle, you can enter override values for:

- Extrusion Multiplier (EM)
- Max Volumetric Speed (mm³/s)
- Pressure Advance (PA)
- Retraction Length (mm)
- Retraction Speed (mm/s)
- Z Lift (mm)

Leave fields blank to use the filament's base defaults. When exporting to INI, filaments with calibrations generate one `[filament:Name NozzleSize]` section per nozzle with the overrides merged.

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

The desktop app supports reading and writing OpenPrintTag NFC-V tags. See the [NFC documentation](nfc.md) for hardware requirements and setup.

### Reading Tags

Place a tag on the reader -- the app auto-reads it and shows a dialog:

- **Match found**: Shows the matching filament with a link to view it
- **No match**: Shows the decoded data with an option to create a new filament (form pre-filled with tag data)

### Writing Tags

On any filament's detail page:

1. Place a tag on the reader (status turns green)
2. Click **"Write NFC"**
3. Wait for the write to complete (button shows "Written!" on success)

### Exporting OpenPrintTag Binary

Click **"Export OPT"** on any filament's detail page to download the binary as a `.bin` file for use with external NFC tools.
