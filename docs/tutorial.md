# Getting Started with Filament DB

A step-by-step tutorial covering every feature of the app -- from first launch through NFC tag writing.

---

## Step 1: Install and Connect

### Desktop App (recommended)

1. Download the latest release from [GitHub Releases](https://github.com/hyiger/filament-db/releases):
   - **macOS**: `.dmg`
   - **Windows**: `.exe`
   - **Linux**: `.AppImage` or `.deb`
2. Open the app. On first launch the **Setup Wizard** appears.
3. Paste your **MongoDB Atlas connection string** into the URI field.
   - Don't have one? Click the Atlas link in the wizard, create a free cluster, then copy the connection string from **Connect > Drivers**.
   - The string looks like `mongodb+srv://user:pass@cluster0.abc123.mongodb.net/filament-db`
4. Click **Test Connection**. When the check passes, click **Save & Continue**.

### From Source (web app)

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
npm install
cp .env.example .env.local   # edit with your MongoDB Atlas URI
npm run dev                   # opens http://localhost:3000
```

---

## Step 2: Create Your First Nozzle

Before adding filaments you need at least one nozzle profile so you can assign per-nozzle calibrations later.

1. From the home page, click **Manage Nozzles** in the header.
2. Click **+ Add Nozzle**.
3. Fill in the form:
   - **Name** -- a short label, e.g. `0.4 Brass`
   - **Diameter** -- pick from the dropdown (0.25, 0.4, 0.5, 0.6, 0.8, 1.0)
   - **Type** -- Brass, Hardened Steel, Stainless Steel, Copper, Obsidian, Diamondback, etc.
   - **High Flow** -- check if this is a high-flow nozzle
   - **Hardened** -- check if it can print abrasive materials
   - **Notes** -- optional free-text
4. Click **Create Nozzle**.
5. Repeat for each nozzle you own. You can always add more later.

---

## Step 3: Add a Filament Manually

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

---

## Step 4: Import Filaments from PrusaSlicer

If you already have profiles in PrusaSlicer, bulk-import them instead of entering each one by hand.

### Export from PrusaSlicer

1. Open PrusaSlicer.
2. Go to **File > Export > Export Config Bundle**.
3. Save the `.ini` file (e.g. `PrusaSlicer_config_bundle.ini`).

### Import via the Web UI

1. On the home page, click **Import INI**.
2. Select the `.ini` file you exported.
3. A toast confirms how many filaments were imported: `Imported 42 filaments (38 new, 4 updated)`.

### Import via CLI (alternative)

```bash
# Default path (~/Downloads/PrusaSlicer_config_bundle.ini)
npx tsx scripts/seed.ts

# Custom path
npx tsx scripts/seed.ts /path/to/your_config.ini
```

The CLI also auto-creates nozzle profiles from `compatible_printers_condition` in the INI file.

---

## Step 5: Browse and Filter Your Library

The home page shows all filaments in a sortable table.

- **Search** -- type in the search box to filter by name
- **Filter by Type** -- use the type dropdown to show only PLA, PETG, ASA, etc.
- **Filter by Vendor** -- use the vendor dropdown to show only one manufacturer
- **Sort** -- click any column header (Name, Vendor, Type, Nozzle Temp, Bed Temp, Cost) to sort ascending or descending. The active sort shows a blue arrow.
- **Color swatches** -- each row shows the filament's color as a dot

### Parent/Variant Grouping

If you have color variants, parent filaments show a count badge (e.g. "5 colors"). Click the expand arrow to reveal variant rows, each showing their own color swatch and name. Click again to collapse.

---

## Step 6: View Filament Details

Click any filament name to open its detail page. You'll see:

- **Header** -- color swatch, name, vendor, type, and badges for "variant" or "3 colors"
- **Info cards** -- nozzle temp, bed temp, cost, density, diameter, max volumetric speed. Cards with a blue background and "(inherited)" label show values inherited from a parent filament.
- **Nozzle Calibrations** -- a table with per-nozzle values for EM, Max Vol Speed, PA, Retract Length, Retract Speed, and Z Lift. If no calibrations exist, compatible nozzles are shown as simple badges.
- **TDS preview** -- click "View Technical Data Sheet" to open an inline preview, or "Open in new tab" for full-screen.
- **PrusaSlicer settings** -- click "Show all PrusaSlicer settings" to expand every raw key-value pair.

### Variant navigation

- On a **parent** filament, a "Color Variants" section shows clickable cards for each variant (color dot + name + cost).
- On a **variant**, a blue banner says "Inherits settings from parent filament" with the count of inherited fields.

---

## Step 7: Edit a Filament

1. From the detail page, click **Edit** (blue button).
2. Change any fields. The form is identical to the create form, pre-filled with current values.
3. To add per-nozzle calibrations: check a nozzle under "Compatible Nozzles", then fill in the calibration fields that appear below it.
4. Click **Update Filament**.

You can also click the **Edit** button directly from the home page table row.

---

## Step 8: Create Color Variants

Variants share a parent's settings (temperatures, density, retraction, calibrations) and only store what's different: name, color, and cost.

1. Open a filament's detail page.
2. Click **+ Add Color** (amber button, only visible on parent filaments).
3. The "Add Color Variant" form opens with **vendor** and **type** pre-filled from the parent.
4. Enter the variant's **name**, pick its **color**, and optionally set a **cost**.
5. Leave other fields blank -- they inherit from the parent automatically.
6. Click **Create Filament**.

To turn an existing standalone filament into a variant:

1. Click **Edit** on the filament.
2. Under **Parent Filament**, search for and select the parent.
3. Click **Update Filament**.

---

## Step 9: Export to PrusaSlicer

1. On the home page, click **Export INI**.
2. A `.ini` file downloads containing all your filaments as `[filament:Name]` sections.
3. In PrusaSlicer, go to **File > Import > Import Config Bundle** and select the file.

**How calibrations export**: Filaments with per-nozzle calibrations generate one section per nozzle (e.g. `[filament:Prusament PLA 0.4mm]`) with overrides merged in. Pressure advance is written as `M572 S<value>` in `start_filament_gcode`.

---

## Step 10: Manage Nozzles

From the home page, click **Manage Nozzles**.

- **Edit** -- click Edit next to any nozzle to change its properties.
- **Delete** -- click Delete to remove a nozzle. If any filaments reference it, deletion is blocked and a message tells you how many filaments to update first.
- **Create** -- click + Add Nozzle to add a new one.

---

## Step 11: NFC Tags (Desktop App Only)

NFC features require the Electron desktop app plus hardware. Skip this section if you only use the web app.

### Hardware you need

| Item | Details |
|------|---------|
| **Reader** | ACS ACR1552U USB (~$40-50) |
| **Tags** | NXP ICODE SLIX2 (ISO 15693, 320 bytes) |
| **macOS driver** | Install [ifd-acsccid.bundle](https://www.acs.com.hk/en/drivers/) from ACS |

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
3. The app auto-reads the tag and shows a dialog:
   - **Match found** -- shows the matched filament with a **View Filament** link.
   - **No match** -- shows the decoded tag data (material, brand, temps, density, etc.) with a **Create New Filament** button that pre-fills the form with everything from the tag.
   - **Similar filaments** -- if no exact match but the vendor or type is close, candidates appear. Click **+ Variant** next to one to create the tag's filament as a color variant of an existing parent.
4. Click **Dismiss** to close the dialog.

### Writing a Tag

1. Navigate to any filament's detail page.
2. Place a blank SLIX2 tag on the reader (dot turns green).
3. Click **Write NFC** (purple button).
4. Wait ~2 seconds. The button shows **Written!** on success or **Write Failed** on error.

### Exporting an OpenPrintTag Binary

If you prefer using external NFC tools:

1. On any filament's detail page, click **Export OPT** (green button).
2. A `.bin` file downloads containing the NDEF-wrapped CBOR payload.
3. Write this file to a tag using your preferred NFC software.

---

## Step 12: Delete a Filament

1. On the home page, click **Delete** next to any filament.
2. Confirm the deletion in the popup.

**Note**: Parent filaments with color variants cannot be deleted. Delete the variants first.

---

## Quick Reference

| Action | Where |
|--------|-------|
| Add filament | Home > + Add Filament |
| Import from PrusaSlicer | Home > Import INI |
| Export to PrusaSlicer | Home > Export INI |
| View filament details | Home > click filament name |
| Edit filament | Detail page > Edit |
| Add color variant | Detail page > + Add Color |
| Manage nozzles | Home > Manage Nozzles |
| Write NFC tag | Detail page > Write NFC (desktop app) |
| Export NFC binary | Detail page > Export OPT |

---

## Troubleshooting

See the [Troubleshooting Guide](troubleshooting.md) for common issues and solutions.
