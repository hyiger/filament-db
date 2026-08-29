# Using the Application

[< Back to README](../README.md)

## Browsing Filaments

The home page displays all filaments in a sortable table with columns for color, name, vendor, type, nozzle temperature, bed temperature, cost, remaining spool percentage, and purchased / opened dates (each showing the earliest purchase or opened date across the filament's spools).

- **Statistics**: Click the summary line (e.g. "18 filaments · 8 types · 5 vendors") to expand a panel with bar charts by type and vendor, plus a color swatch grid
- **Search**: Type in the search box to filter filaments by name
- **Filter by Type**: Use the type dropdown to show only specific material types (PLA, PETG, ASA, etc.)
- **Filter by Vendor**: Use the vendor dropdown to show only filaments from a specific manufacturer
- **Sort**: Click any column header to sort ascending/descending. The active sort column is highlighted with a blue arrow
- **Hide out of stock**: By default, filaments with no active (non-retired) spools are hidden. When any are hidden, a **Show out of stock (N)** chip appears beside the quick filters to reveal them; click again to **Hide out of stock**. (The toggle only shows on the unfiltered "all" view — an active search/type/vendor/quick filter always shows every match in or out of stock.)
- **Quick-change spool location** *(#717)*: a filament row with spools shows a **×N** toggle in the remaining-stock cell. Expand it to list each spool with its current location and a **move-to** dropdown — change a spool's location inline without opening the filament's detail page. The move is saved straight to the spool (parents with their own spools get the same panel).

## Viewing Filament Details

Click any filament name in the table to see its full details:

- Temperature settings (nozzle, bed, chamber, first layer variants)
- Physical properties (cost, density, diameter)
- Performance settings (max volumetric speed, extrusion multiplier, pressure advance)
- Compatible nozzles and per-printer per-nozzle calibration values (EM, max vol speed, PA, retraction)
- Technical Data Sheet -- click "View Technical Data Sheet" to open an inline preview, or "Open in new tab" for full-screen
- Inheritance information (base profile reference)
- A **Technical reference** panel — the chapter of the FDM Polymers technical reference matching the filament's material type (self-hides when the type maps to no chapter)

## Adding a New Filament

1. Click **"+ Add Filament"** in the top right
2. Optionally use the **"Populate from"** toolbar to pre-fill the form:
   - **Place an NFC tag** on the reader to auto-populate from OpenPrintTag data (desktop only)
   - **Import from TDS** to extract properties from a Technical Data Sheet URL using AI (requires API key — see [AI Settings](#ai-settings))
   - **Prusament QR** to fetch specs from a Prusament spool QR code
   - **Load from INI** to pick a profile from a PrusaSlicer config bundle
   - **Duplicate Existing** to copy identity fields from another filament and inherit its settings as a variant. (On a filament's detail page, a dedicated **"Create variant"** button is also available on root filaments — quicker path when you already know which filament should be the parent.)
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

There are two ways to delete:

- **From the filament list** — tick the checkbox(es) next to one or more rows. A red selection bar appears above the table with **"Delete {count}"**; click it and confirm.
- **From the detail page** — click the red **Delete** button in the top-right action row (added in v1.29). It sends the same soft-delete, and is faster when the filament is already open.

Deletion is **soft** — filaments move to the **trash** rather than disappearing for good. The selection bar includes a small "open trash" link so the destination is visible right when you delete.

Parent filaments that still have color variants are blocked from deletion — remove or reparent the variants first.

### Restoring or permanently deleting from the trash

Visit `/trash` (also reachable from **Settings → Trash**). Each row shows when the filament was deleted, plus two actions:

- **Restore** — un-deletes the filament and brings it back into the regular list. If you've created a new active filament with the same name in the meantime, restore is refused with a 409 explaining the conflict — rename one of them first. Restoring a *variant* whose parent picked up a color or spools while it was in the trash asks to convert that parent to a template first (see [Filament Templates](#filament-templates-v170)).
- **Delete forever** — hard-deletes from MongoDB. Cannot be undone. The button's only available on filaments already in the trash; an active filament has to be soft-deleted first as a safety step.

The trash page also has an **Empty trash** action that permanently deletes everything in one go (variants are purged before parents to satisfy the no-orphan-refs constraint).

---

## Filament Templates *(v1.70)*

A filament that has color variants is a **template** — the product line rather than a roll. The template carries what the whole family shares (temperatures, drying, density, the empty-spool and net filament weights, secondary colors, tags); each color variant carries what is per-color and per-roll: its color and color name, its spools, its total weight, and its low-stock threshold. A filament with no variants is unaffected and behaves exactly as before.

Being a template isn't a setting you turn on — a filament is a template for exactly as long as it has at least one variant that isn't in the trash.

### Converting a parent when its first variant appears

Nothing is restructured behind your back. When an action would give a filament its **first** variant while that filament still carries its own color, color name, spools, or total weight, the app stops and asks:

> **Convert parent to template?**
>
> This is the first variant of "Prusament PLA", which becomes a template: its color and 2 spool(s) move to a new variant named "Prusament PLA — Galaxy Black".

Confirm with **Convert and create** and the app creates that variant, moves the parent's color, color name, spools, total weight and low-stock threshold onto it, and leaves the parent colorless and inventory-free. Cancel and nothing at all is written — no filament is created, no data is touched.

The same confirmation guards three entry points, with the wording matched to the action:

- **"Create variant"** or **Duplicate** on the detail page, and `/filaments/new` with a parent picked — *"This is the first variant of…"*, **Convert and create**
- **Edit → Parent Filament** on an existing filament — *"Saving makes this filament the first variant of…"*, **Convert and save**
- **Import as variant** in the OpenPrintTag browser (select one material, pick a **Parent filament** instead of "No parent (standalone)", and the import button switches to that label) — same wording as the create flow

**Restore** from the trash is deliberately *not* one of them: restoring a variant whose parent still carries its own color or spools is refused outright, with a message pointing at **Convert to template** on the parent — convert once for the whole family, then restore. See [Restoring or permanently deleting from the trash](#restoring-or-permanently-deleting-from-the-trash).

The new variant is named `<parent name> — <color name>`, or `<parent name> — Original` when the parent had no color name (with a ` (2)` / ` (3)` suffix if that name is already taken). Everything that pointed at the moved spools follows them: print history entries, printer AMS slot assignments, and already-printed QR labels — scanning an old label resolves the spool's current owner and takes you there.

### Converting a legacy parent by hand

Parents created before v1.70 keep their own color and spools until you say otherwise. Open one and the **Spool Tracker** section shows an amber note — *"This template still carries its own color or spools from before it became a template."* — next to a **Convert to template** button. The button only appears when there's actually something to move. It confirms with:

> **Convert to template?**
>
> Move this filament's own color and 2 spool(s) to a new variant? The template itself keeps no color and no spools.

On success a toast reads *"Converted — color and spools moved to a new variant"* and the page reloads its data. If a conversion is interrupted (app quit, power loss) nothing is lost — the button is still there, and retrying finishes the interrupted move rather than creating a second copy.

### What a template will and won't do

- **Spools live on the variants.** The Spool Tracker section on a template is replaced by *"Templates don't hold inventory — spools live on the color variants."* — there's no **+ Add Spool** button. Every path that would add a *new* spool to a template refuses with *"This filament is a template (it has color variants) and cannot hold spools — add the spool to one of its variants instead."*: the Add Spool button, the Prusament QR import, and the bulk spool CSV import (which fails just those rows). Spools already sitting on a legacy parent aren't lost, but they're no longer managed here — the tracker on the template's own page is that one line and nothing else. They still count toward the filament list's spool and remaining totals, and they stay editable from the list's inline spool panel (location) and from **Spool Inventory** (weight, location, retire). **Convert to template** moves them onto a variant for good.
- **The edit form hides the Color and Color Name fields** on a template: *"Templates are colorless — each color variant carries its own color and color name."* The multi-color (secondary colors) editor stays, because those are inherited by the whole family.
- **The Spool Weight section keeps the spec pair and hides the inventory inputs.** Net filament weight and empty spool weight remain — *"Templates don't hold inventory — spools and total weight live on the color variants. The empty-spool and net-filament weights set here are shared spec values every variant inherits."* Setting the net filament weight once on the template is what gives every color variant a remaining-percentage bar. Initial weight and low-stock threshold are hidden.
- **Imports and slicer syncs skip four fields** on a template — color, color name, total weight, low-stock threshold — instead of failing. PrusaSlicer / OrcaSlicer / Bambu Studio sync-backs, INI bundles, CSV / XLSX, Atlas and OpenPrintTag imports apply everything else and report what they skipped in the result notes.
- **OpenPrintTag "Check for updates" never offers the color** on a template, so one link on the parent updates every property of the whole family without repainting it.
- **Deletion is still blocked** while a filament has variants — remove or re-parent the variants first.

### Clearing a color

Empty the hex field and save: the filament is left with no color at all, and editing it again keeps it that way. A cleared color renders as a hatched placeholder reading **"No color set — click to pick one"** — click it to pick a color back.

---

## Multi-Color Filaments *(v1.33)*

Some filaments carry more than one color in a single strand — tri-color silks (coextruded), gradient/rainbow rolls (gradual color change), and dual-tone materials. Filament DB models these natively, mirroring the OpenPrintTag spec.

### Editing colors

Open a filament and scroll to the **Colors** section of the form. Each filament has:

- **Arrangement** — one of:
  - **Solid** — a single color (the default for most filaments)
  - **Coextruded** — multiple colors sit side-by-side across the strand (constant along the length)
  - **Gradient** — color changes along the length as filament feeds (color-change / rainbow)
- **Primary color** — the single main color. May be left blank for coextruded filaments where no one slot is "the" primary.
- **Secondary colors (0–5)** — up to five additional color slots, in display order. Use the **+ Add color** / × buttons to add and remove slots.

A live preview swatch beside the editor shows what the filament will render as in the list — stripes for coextruded, smooth gradient for gradient, plain fill for solid. Picking "Coextruded" automatically clears the primary so the secondary slots define the entire stripe set; switching back to "Solid" or "Gradient" restores a primary slot.

### Display rules

- **List and detail swatches** render the full color arrangement. Filaments with at least one secondary color also show a small color-count badge.
- **Variants** inherit `secondaryColors` from their parent the same way they inherit other array fields (`optTags`, `bedTypeTemps`) — a variant either declares its own non-empty array, or inherits the parent's entire array. Setting a variant's array to empty `[]` does NOT clear; it falls through to the parent. To override and show as single-color, give it at least one secondary slot or a different `optTags` arrangement.

### NFC and OpenPrintTag

Filament DB's NFC reader/writer encodes the full color arrangement to OpenPrintTag fields (`primary_color`, `secondary_color_0..4`, and the `coextruded` / `gradual_color_change` tags). When you scan a multi-color OpenPrintTag tag, the form prefills every slot in the right order. Bambu's MIFARE tag format only carries a single color, so reading a Bambu tag populates the primary only.

### Slicer export caveat

PrusaSlicer, OrcaSlicer, and Bambu Studio presets are single-color formats — there's no key for multiple colors. When you export a multi-color filament to a slicer preset:

- The **primary color** is exported.
- If the primary is blank (coextruded), the **first secondary color** is exported in its place.
- If both are blank (a freshly-created coextruded filament with no secondaries yet), `filament_colour` is omitted entirely and the slicer uses its own default — Filament DB will not invent a color you didn't pick.
- **Secondary colors beyond the primary are silently dropped.**

The "Export for slicer" disclosure on a multi-color filament's detail page shows an amber notice making this trade-off explicit before download.

### CSV import/export

The filament CSV export includes a **Secondary Colors** column with comma-separated hex codes (e.g. `#FF0000,#00FF00,#0000FF`). The importer recognises the same column on re-import: it parses up to 5 hex codes, drops malformed entries, and preserves a null primary when the row's `Color` cell is empty and `Secondary Colors` is populated (coextruded round-trip).

---

## Bulk Import / Export

Two ways to reach the bulk-data actions:

- **Filament list → "Import / Export" dropdown** in the action row. Convenient when you're already managing filaments.
- **Settings → Import / Export** (or `/import-export` directly). Same actions presented as labeled tiles, useful for discovery and bookmarking.

Both surfaces cover:

- **Import filaments** — Prusament QR scan, Atlas import, OpenPrintTag browse, file upload (CSV / XLSX / PrusaSlicer INI). Full database snapshots restore from Settings → Backup & Data.
- **Import spools** — bulk CSV with one row per spool
- **Export filaments** — PrusaSlicer INI bundle, CSV, or XLSX
- **Export spools** — CSV inventory with location and lot number

A separate **Snapshot** workflow on the Settings page handles full database backup / restore (filaments + nozzles + printers + bed types + locations + print history + shared catalogs in a single JSON file).

---

## Importing from MongoDB Atlas

You can import filaments from another Filament DB instance hosted on MongoDB Atlas:

1. Open the **Import/Export** dropdown on the home page and click **"Import from Atlas"**
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

Go to **Settings → UI Settings** and use the **Language** toggle to switch between English and German. The setting is persisted in the desktop app's config (or localStorage in the web app) and takes effect immediately across all pages.

---

## Date Format *(v1.65)*

Go to **Settings → UI Settings** and pick a **Date format** to control how every date in the app is rendered:

- **System** — follow your device/OS region setting (the default)
- **ISO** — `YYYY-MM-DD`
- **US** — `MM/DD/YYYY`
- **European** — `DD/MM/YYYY`
- **Custom** — your own pattern built from `YYYY` / `YY` (year), `MM` / `M` (month), and `DD` / `D` (day) tokens (e.g. `DD-MM-YY`); other characters are kept as separators

A live preview shows today's date in the chosen format. Like Language, the setting persists in the desktop app's config (or localStorage in the web app).

---

## Number Format *(v1.66)*

Also under **Settings → UI Settings**, the **Number format** control sets the digit grouping and decimal separator for all displayed numbers — weights, counts, and prices (currency values included):

- **System** — follow your device region (the default)
- **US / UK** — `1,234,567.89`
- **European** — `1.234.567,89`
- **Space** — `1 234 567,89`
- **None** — no grouping (`1234567.89`)
- **Custom** — pick your own thousands and decimal characters (single non-digit characters, and they must differ)

A live preview shows a sample value in the chosen format. Machine-readable output (CSV / XLSX and slicer exports) is not affected — only what's displayed in the UI.

---

## Currency

The **Currency** control at the top of **Settings → UI Settings** picks the currency used for cost and price display. Click one of the built-in currencies, or **add a custom one** with your own code, symbol, and name (custom entries can be removed again with their × button).

---

## Managing Nozzles

Go to **Settings** and click **Nozzles** to view, create, edit, and delete nozzle profiles.

Each nozzle has:
- **Diameter** (0.25mm, 0.4mm, 0.6mm, etc.)
- **Type** (Brass, Hardened Steel, Stainless Steel, ObXidian, Diamondback, etc.)
- **High Flow** flag
- **Hardened** flag
- **Installed in** -- the single printer this physical nozzle is currently installed in, chosen from a radio list (or **Not installed in a printer**). A nozzle can only be in one printer at a time; picking a printer here moves it off any printer it was previously on.
- **Notes**

---

## Managing Bed Types

Go to **Settings** and click **Bed Types** to view, create, edit, and delete bed type profiles.

Each bed type has:
- **Name** (e.g., "Smooth PEI", "Textured PEI", "G10/FR4")
- **Material** -- the surface material (PEI, Textured PEI, Spring Steel, Glass, G10/FR4, BuildTak, PEX, Polypropylene, Other)
- **Notes**

Bed types are used in calibrations to store per-printer per-nozzle per-bed-type override values. They cannot be deleted while they are referenced by any filament calibration, installed on any printer, or named in any filament's per-bed-type temperature table — the error message names what's blocking the delete.

---

## Managing Printers

Go to **Settings** and click **Printers** to view, create, edit, and delete printer profiles.

Each printer has:
- **Manufacturer** (e.g. Prusa, Bambu Lab)
- **Model** (e.g. Core One, X1C)
- **Name** -- auto-generated from manufacturer + model, but editable
- **Installed Nozzles** -- the nozzles physically installed in this printer. A printer can hold several (e.g. a toolchanger or multi-head machine), but each physical nozzle can only be installed in one printer at a time.
- **Multi-material slots (AMS / MMU)** -- optional; define one slot per AMS/MMU position so you can track which spool is loaded where (see [Printer Slot Assignment](#printer-slot-assignment-v121))
- **Notes**

Printers cannot be deleted if they are referenced by any filament calibrations. The error message tells you how many filaments reference the printer.

---

## Data Health *(v1.77)*

**Settings → Data health** surfaces name conflicts the automatic cleanup can't repair on its own: pairs of rows (filaments, nozzles, printers, bed types, locations) whose names differ only by invisible edge whitespace — `"Drybox 1"` vs `"Drybox 1 "` — usually left behind by old imports or raw database writes. The page lists every such conflict with the whitespace made visible, shows what still references each row, and offers the two safe resolutions:

- **Delete** — only available when nothing references the row (a plain duplicate).
- **Rename** — frees the canonical spelling without touching a single reference.

A healthy database shows an empty list. In hybrid mode the page scans the database the app is connected to; since v1.78 (#1164) conflicts found on the **remote** database during sync also appear here in a read-only "on the remote" section, and the header's sync pill carries a conflict count linking straight to the page.

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

Leave fields blank to use the filament's base defaults. Top-level filament temperatures remain as manufacturer-recommended defaults. How calibrations reach the INI export depends on how many distinct nozzles a filament is calibrated for. A filament with zero or one nozzle calibration produces a single `[filament:Name]` section with its base settings, and calibration overrides are not embedded — PrusaSlicer Filament Edition fetches them dynamically via `GET /api/filaments/{id}/calibration` when you switch printer or nozzle. A filament calibrated for **two or more distinct nozzles** instead exports one preset per nozzle, name-suffixed with the nozzle (e.g. `PLA 0.4 Brass`), each with that nozzle's filament-scoped calibration values baked in (pressure advance stays dynamic via the calibration API).

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

Filament DB is a neutral multi-standard reader. The desktop app supports reading and writing **OpenPrintTag** (NFC-V / ISO 15693, SLIX2) tags, reading and writing **OpenTag3D** (NFC-A / ISO 14443 Type 2, NTAG213/215/216) tags, and reading **Bambu Lab** MIFARE Classic spool tags. See the [NFC documentation](nfc.md) for hardware requirements and setup.

### Reading Tags

Place a tag on the reader -- the app auto-detects the tag type (OpenPrintTag, OpenTag3D, or Bambu Lab) and reads it. A dialog appears showing:

- **Match found**: Shows the matching filament with a link to view it
- **No match**: Shows the decoded data with an option to create a new filament (form pre-filled with tag data)
- **OpenTag3D tags**: Displays an OpenTag3D provenance badge plus the OpenTag3D-only extra fields
- **Bambu Lab spools**: Displays a "read-only" badge since Bambu tags cannot be written; also shows production date and filament length

### Writing Tags

On any filament's detail page:

1. Place a tag on the reader (status turns green)
2. Click **"Write NFC"**
3. Wait for the write to complete (button shows "Written!" on success)

### Erasing / Formatting Tags

On **Settings → Devices**, the **NFC Tools** card lets you erase a tag:

1. Place a tag on the reader (status turns green)
2. Click **"Erase Tag"** and confirm
3. The tag is wiped — blank CC header, terminator, and zeroed memory

### Exporting OpenPrintTag Binary

Click **"Export OPT"** on any filament's detail page to download the binary as a `.bin` file for use with external NFC tools.

---

## AI-Powered TDS Import

Extract filament properties automatically from a manufacturer's Technical Data Sheet using AI. Supports PDF and web page TDS URLs.

### Setup

1. Go to **Settings → AI**
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
| Google Gemini | gemini-3.1-flash (auto-discovers a served flash model if this is ever retired) | 15 requests/minute | Native |
| Anthropic Claude | claude-sonnet-4-20250514 | Pay-per-use | Native |
| OpenAI ChatGPT | gpt-4o-mini | Pay-per-use | Text extraction |

### AI Settings

On **Settings → AI**:

- **Provider selector** — click a provider button to switch between Gemini, Claude, and ChatGPT
- **API key** — masked input field with show/hide toggle
- **Save Key** — validates the key against the selected provider before saving
- **Remove Key** — clears the stored key
- **Status indicator** — green dot when configured, gray when not

In the desktop app, the API key is stored in the locally persisted config file. In the web app, set the key via the Settings page or use environment variables (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`).

---

## Spool Tracking

Each filament can track multiple physical spools with individual weights. Filaments that have color variants are [templates](#filament-templates-v170) and don't hold inventory — add rolls to the color variants instead.

### Adding Spools

On a filament's detail page, the **Spool Tracker** section always renders (as of v1.30.3 / #380). When there are no spools and no weight metadata configured yet, the section shows a short "No spools yet" hint above the **"+ Add Spool"** button — click it to add a new spool entry with an optional label and weight. On a template the section shows only "Templates don't hold inventory — spools live on the color variants." instead.

If you number your rolls, the **Next #** button beside the label field fills it with the next number: the highest all-digit spool label anywhere in the database plus one (or `1` when nothing numeric exists). It counts retired spools and spools on trashed filaments **on purpose** — a roll number written on a physical spool must never be handed out twice, so the suggestion skips past anything already used, even if the app no longer shows it. Labels that aren't purely digits ("Opened 2025-03-15", "A12", "1.5") are ignored rather than half-parsed; leading zeros are stripped, so "0042" counts as 42. Nothing is reserved — it's a suggestion written into a normal editable field, two people clicking it at once get the same number, and typing over it is expected. If the lookup fails you get a *"Couldn't fetch the next spool number — enter it manually."* toast and the field is left alone.

### Managing Spools

Each spool row shows:
- **Label** -- editable text (e.g., "Opened 2025-03-15" or a Prusament spool ID)
- **Total Weight** -- weight in grams (including the empty spool)
- **Delete** button to remove the spool entry

The tracker aggregates stats across all spools, showing total remaining weight and computed length (from density and diameter).

### Migrating from Single Weight

If a filament has a `totalWeight` value but no spools array, a **"Track multiple spools"** button converts the single weight into a spool entry.

### Spool Check (PrusaSlicer Integration)

When using PrusaSlicer Filament Edition, a spool check runs automatically after slicing. PrusaSlicer queries the Filament DB API with the estimated print weight and compares it to the remaining filament on each spool. If no spool has enough material, a warning notification appears in PrusaSlicer.

The check requires that the filament has a **spool weight** (empty spool) set and at least one spool with a **total weight** (current scale reading). If no weight data is available, the check is silently skipped.

---

## Prusament Spool Import

Prusament filament spools have a QR code linking to a detail page with full specifications.

1. Open the **Import/Export** dropdown on the home page and click **"Prusament QR"**, or click **"+ Prusament QR"** on a filament's spool tracker
2. Enter the spool ID (e.g., `c6974284da`) or paste the full URL
3. Review the extracted data (material, color, temperatures, weights, pricing, diameter tolerances)
4. Choose **"New filament"** to create a fully-populated entry, or **"Add spool to existing"** to add the spool to a matching filament
5. Click **Import**

This also works from a filament's detail page to add another spool of the same material.

---

## CSV and XLSX Import/Export

### Exporting

Open the **Import/Export** dropdown on the home page and click, under **Export**, **"CSV"** or **"Excel (XLSX)"** to download all filaments in the chosen format. The export includes name, vendor, type, color, color name, temperatures (nozzle, bed, first layer, ranges, standby), cost, density, weights, instance ID, drying temperature/time, transmission distance, glass transition (Tg), heat deflection (HDT), shore hardness (A/D), print speed ranges, and spool type.

XLSX exports include styled headers, color-coded cells, auto-filter, and a frozen header row.

### Importing

Open the **Import/Export** dropdown on the home page and click **"Import File (INI / CSV / XLSX)"** to upload a file (max 10 MB). The app routes by extension: `.ini` → PrusaSlicer bundle import, `.csv` → CSV importer, `.xlsx` → XLSX importer. The file must have a header row with at minimum `Name`, `Vendor`, and `Type` columns. Additional columns are mapped by header name (case-insensitive), including glass transition (Tg), heat deflection (HDT), shore hardness (A/D), print speed ranges, nozzle temp ranges, standby temp, color name, and spool type. Only fields present in the file are updated — existing data for unmapped columns is preserved. Rows missing required fields are reported with row numbers and reasons.

---

## Snapshot Backup & Restore

### Exporting a Snapshot

Go to **Settings → Backup & Data** and click **"Download Snapshot"** to download a JSON snapshot of core app data. The snapshot includes filaments, nozzles, printers, bed types, locations, print history, and shared catalogs (including soft-deleted documents and tombstones) with references and timestamps preserved.

### Restoring a Snapshot

Go to **Settings → Backup & Data** and click **"Restore from Snapshot"**. Select a previously exported snapshot file. This replaces all current data with the snapshot contents. The restore uses best-effort rollback — if any part fails, the handler attempts to re-insert the previous data from an in-memory backup.

---

## Instance IDs

Each filament has a unique instance identifier (5-byte hex string, e.g. `2acc21072a`), auto-generated on creation. This matches Prusament's `brand_specific_instance_id` format. Instance IDs are visible on the filament detail page next to the vendor/type and are included in CSV/XLSX exports.

As of v1.48–v1.50 (#732), **each spool also has its own instance ID** — the durable per-roll identity that NFC tags carry, QR labels encode, and the spool CSV round-trips, resolved first by tag/QR matching ahead of the filament-level id. A spool's ID is shown and editable on the filament detail page (the "Spool ID" field — enter your own, e.g. a Prusament roll ID, or regenerate it) and shown read-only on the Inventory page and the main list. The filament-level ID is kept as a fallback for older tags.

---

## Label Printer (Desktop App Only) *(v1.34)*

Print a 24mm-tape spool label directly from the filament detail page to a **Brother PT-P710BT** (P-touch CUBE). The label carries a QR code (optional) and configurable text. This is the spool-label printer; 4×6 drybox labels go to a separate device with its own setting — see [Dry-Box Labels](#dry-box-labels-knaon-y813bt-v169). Two QR payload modes you can pick per print:

- **Instance ID** — a 5-byte hex identifier (e.g. `2acc21072a`). As of #732 this encodes the **selected spool's** instance ID (the spool picker chooses which; it defaults to the first non-retired spool). It encodes the **filament-level** ID instead when you pick the picker's **"Filament only"** option (available even when the filament has spools, for printing a legacy filament-level QR) or when the filament has no spools. It matches what an NFC tag carries and is resolved by the in-app NFC reader and the slicer integration; a phone camera just shows the raw hex with nothing to act on, so use this for the NFC/slicer ecosystem rather than phone scanning.
- **Deep-link URL** — a full URL to the filament's detail page (e.g. `https://your-instance.lan/filaments/<id>`). Scanned by **any phone** it opens the page directly — no app required. This is the phone-scannable option. For a filament with **multiple spools**, a spool picker appears so the QR can target a specific spool (`…/filaments/<id>?spool=<spoolId>`); scanning it opens the filament with that spool highlighted. *(Spool targeting, v1.35.)*

Your last choice is remembered as the default for the next print.

> **Connect over USB, not Bluetooth.** Brother's Bluetooth on the PT-P710BT is iOS/Android only; on the desktop the printer connects over **USB**, where it appears as a standard USB printer. Use a USB-C **data** cable (not a charge-only cable). The app prints through your operating system's print system — CUPS on macOS/Linux, the print spooler on Windows. *(Reworked in v1.34.9; earlier builds used an unsupported, flaky Bluetooth-serial path.)*

### One-time setup

1. **Connect the printer via USB** and power it on. On macOS/Linux it's reachable through CUPS automatically; on Windows, install it as a normal printer if your OS prompts.
2. **Open the desktop app → Settings → Devices** and find the **Label printer** card. Any printers already set up as system queues are listed automatically. If your PT-P710BT was just connected and isn't a configured queue yet, click **Scan for USB printers** (or **Refresh**) to detect it — **on macOS this may ask for your administrator password**, because listing USB print devices is an admin operation. The PT-P710BT shows up with a green **PT-Touch** badge (on macOS/Linux it appears as a `usb://Brother/PT-P710BT…` device). Select it.
3. **(Optional) Public URL for QR-mode labels**: if you want to print labels with deep-link URLs that scan correctly from your phone, also set the **Public base URL** field. URL mode in the desktop app needs a non-localhost address because the renderer's `window.location.origin` is `http://localhost:3456` — unscannable from any other device. Examples: `https://filament-db.lan`, `https://my-instance.example.com`. Loopback addresses, query strings, and URL fragments are rejected with a descriptive error. Leave blank to disable URL mode in the desktop app — the instance-ID mode still works without it.
4. **Test print**: click **Test print** to send a short label using your saved format. Confirm the QR scans and the text is crisp before you start printing real labels.

### Customizing the label

The **Label format** card on **Settings → Devices** controls what every label looks like, with a live preview rendered against a sample filament:

- **QR code** — place it on the **left**, **right**, or turn it **off** for a text-only label.
- **Text fields** — choose a preset (*Name only*, *Vendor + Type*, *Vendor over Type*, *Type + Color*) or toggle individual fields (name, vendor, type, color). Multiple fields stack as separate lines (e.g. vendor over type).
- **Font** — Sans, Serif, Monospace, or Condensed, plus a size (the renderer auto-fits the print head).
- **Orientation** — horizontal or vertical text.
- **Invert** — white text on a black background. The QR stays dark-on-light on its own tile so it still scans.

The format is **global** — it applies to every label you print (and to the web `.bin` download). The print dialog still lets you choose the QR *payload* (filament instance ID vs deep-link URL) per print. There's intentionally no "remaining amount" field: a printed value goes stale the moment it prints, so scan the QR for the live number instead.

### Printing labels

From any filament's detail page → **Export ▾** → **Print label**. The dialog renders a live preview at the printer's native dot density (pixelated CSS so what you see is what prints) using your saved format. Choose the QR payload (filament instance ID / deep link) — and, for a multi-spool filament in deep-link mode, which spool the QR points to — then click **Print**.

If you're running in the **web app instead of Electron**, the Print button downloads a `.bin` file containing the encoded byte stream — useful for inspection. Decode it locally with `npm run label:sim -- --in <file>` to see what would have printed (the `--` separator is required — without it npm eats the `--in` flag but still forwards the path, so the script sees a bare argument and dies with `Unknown arg: <path>`).

### Troubleshooting

- **No printer listed** in Settings → Devices: make sure the printer is connected with a USB **data** cable (charge-only cables power the printer but won't enumerate it) and powered on, then click **Scan for USB printers**. On macOS the scan may prompt for your administrator password (it's the OS authorizing the device query — opening Settings itself no longer prompts, as of the #771 fix). On Linux you may need to add the printer in your system print settings first.
- **Upgrading from a pre-v1.34.9 build**: if you'd previously selected a Bluetooth/serial device, re-select your printer in Settings → Devices. The app detects the old serial-style setting and asks you to pick again rather than failing cryptically.
- **Label prints mirrored** (text backwards, QR reversed): fixed in v1.34.9 — update to the latest version.
- **Nothing printed even though it "succeeded"**: the PT-P710BT auto-powers-off when idle. Wake it (press its power button), confirm tape is loaded, and print again.

---

## Dry-Box Labels (KNAON Y813BT) *(v1.69)*

A second, entirely independent label printer prints a 4×6 **dry-box label** — a sticker for the outside of a drybox that names the box, lists what's in it, and records when the desiccant was last changed. It has nothing to do with the Brother spool labels above; you can own one printer, both, or neither. The Settings card says as much: *"Prints 4×6 dry-box labels over TSPL. Independent of the Brother spool-label printer — the two never print the same thing."*

Printing is desktop-only. In the web app the Print button becomes **Download .prn**, and that file is a real print job rather than an inspection artefact — send it with `lp -o raw -d <queue> <file>.prn`.

### One-time setup

1. **Connect the Y813BT over USB** and power it on.
2. **Settings → Devices** → the **Dry-box label printer (KNAON Y813BT)** card, below the Brother one. Printers already installed as system queues are listed when the card loads. If yours isn't there, click **Scan for USB printers** (or **Refresh**) — *"Scanning for USB printers may ask for your administrator password (macOS)."* Matching devices get a green **Y813BT** badge. Select yours.
3. **Test print** sends a small known-good label ("FILAMENT DB" / "TSPL test print OK" plus a barcode) and confirms with *"Test label sent — check the printer."*
4. **Set the Public base URL** on the **Brother** label-printer card just above — there's one URL and both printers share it. Without it the QR encodes `localhost`, which no phone can open; the print dialog warns about that but still prints, and reprinting later is cheap.

If the selected printer is later unplugged or its queue removed, the card shows an amber banner — *"The selected printer is no longer available:"* — naming the path, with a **Clear selection** link. Both printer cards have it.

### Recording humidity and desiccant

On the **Locations** page, edit (or create) the location and set its **Kind** to **Drybox** — the print action only appears for dryboxes, since the label's wording is dry-box specific. Two optional fields feed the label: **Humidity (%RH)** and **Desiccant changed** (see [Locations](#locations-v111)).

### Printing a label

Two entry points, both limited to drybox locations:

- **Locations** (`/locations`) — a **Print label** action on every drybox row. This is the one that works for a brand-new or freshly emptied box.
- **Spool Inventory** (`/inventory`) — a 🖨 button on a drybox group's header, shown while you're grouping by location. (Inventory builds its groups from spools, so an empty box doesn't appear there at all.)

Either opens the **Print dry-box label** dialog, subtitled *"4×6 label for {name} — {N} spool(s) on the manifest"*. It shows *"Loading the box's contents…"* while it fetches the box's **full, unfiltered** contents — a search or filter left active on the Inventory page does not shrink what gets printed — then renders an exact preview built from the same document the printer receives. Retired spools are never on the label.

### What's on the label

- The **box name** in large type inside a border (long names are shortened), and beneath it `FILAMENT DRY BOX`, plus `14% RH` when the location has a humidity value.
- A **QR code** in the top-right corner.
- `CONTENTS  (as of <date>)` followed by one line per non-retired spool — the spool's own label when it has one, otherwise vendor + filament name + material. As many rows as fit; if the box holds more, the last line reads `+N more` so the label never claims to be a complete list. An empty box prints `(empty)`.
- `DESICCANT CHANGED <date>` — or `not recorded` — and the reminder *"Replace every 90 days or when indicator turns pink"*.
- A **Code 128 barcode** of the box name along the bottom (dropped automatically when the name is too long to print a scannable one; the QR still identifies the box).

The contents list is a point-in-time snapshot, which is why it's dated. The QR is the live answer.

### Scanning the label

The QR opens `/inventory?location=<id>` — your Spool Inventory, switched to grouping by location, with that box's group expanded, scrolled to, and briefly highlighted. If the box has no active spools any more (or the location was deleted) you get a short message rather than a page that appears to do nothing: *"That label's box has no active spools right now (or the location was removed) — nothing to show."*

### Non-English label text

The label always prints in plain ASCII. That's a hardware limit, not a preference: the Y813BT cuts a text line short at the first non-ASCII character, so accented text would be silently truncated mid-word. Filament DB transliterates instead — `Grün` prints as `Grun`, `Straße` as `Strasse`, `°` as `deg`, `€` as `EUR`. The QR link is unaffected.

### Bring-up CLI

`npm run label:tspl -- --demo --printer <queue>` renders a sample dry-box label through the real pipeline and prints it; `--file <path.prn>` sends a raw TSPL job instead (validating its line framing first). Without `--printer` it writes the byte stream to `--out` (default `/tmp/label.prn`) and echoes the decoded job text. As with `label:sim`, the `--` separator is required so npm passes the flags through.

---

## OpenPrintTag Community Database Browser

Browse the [OpenPrintTag community database](https://github.com/OpenPrintTag/openprinttag-database) directly from Filament DB to discover and import thousands of FDM filaments from many brands. The browser subtitle shows the live count fetched from the upstream database (it grows as the community contributes more entries).

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

1. Select materials using checkboxes (or use **Select All** / **Deselect all** in the toolbar)
2. Click **"Import Selected (N)"** to import
3. Materials are matched by name and vendor:
   - **New materials** are created with all available fields
   - **Existing materials** are updated conservatively -- only null/empty fields are filled, preserving your existing calibration data

### Checking for Community Updates *(v1.36)*

The OpenPrintTag database is revised over time as the community adds data. A filament you imported keeps a link back to its source material, so you can pull later improvements without re-importing the whole catalog.

On the detail page of any OpenPrintTag-imported filament, a teal **"Check for updates"** button appears next to **Edit**. Click it to compare your filament against the current upstream material. The dialog lists every field that differs:

- **Safe changes** (a field you never filled in, or one still matching what OpenPrintTag last provided) are **pre-checked** -- they're ready to adopt.
- **Edited fields** -- where your local value differs from what OpenPrintTag last provided -- are marked **"edited"** and left **unchecked**, so applying updates won't quietly overwrite a value you set yourself. You can still tick one to take the OpenPrintTag value.

Tick the changes you want and click **"Apply"**. Only identity stays put -- name, vendor, and type are never changed by a sync, and neither is diameter. Your spools, calibrations, and usage history are untouched.

If the dialog says the filament is **up to date**, there's nothing new upstream. If it says the material is **no longer in the database**, the entry was renamed or removed on the OpenPrintTag side.

**Removing or changing the link** *(v1.77, #1150)*: the same dialog carries **Change link…** and **Remove link** buttons — both also available when the linked material has vanished from the OpenPrintTag database, which used to be a dead end. **Remove link** never touches your values: only the link and its update tracking are removed, and you can re-link at any time. **Change link…** re-opens the material picker so update tracking is rebuilt against the new material while your edited fields stay yours.

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

- **Export**: Open the **Import/Export** dropdown on the home page and click, under **Export**, **"INI (PrusaSlicer)"** to download all filaments as a PrusaSlicer-compatible config bundle
- **Import**: In PrusaSlicer, go to **File > Import > Import Config Bundle** to load the exported file
- **Re-import**: Open the **Import/Export** dropdown and click **"Import File (INI / CSV / XLSX)"** to import a PrusaSlicer config bundle back into Filament DB

---

## API Documentation

Go to **Settings** and click **"API Documentation"** to open the interactive Swagger UI at `/api-docs`. This provides a browsable, testable interface for the documented OpenAPI surface, while [the API reference](api.md) includes additional prose for newer routes and behavior details. The underlying OpenAPI 3.0 spec is available at `/api/openapi` (dynamically versioned from `package.json`).

---

## Dashboard *(v1.11)*

The **Dashboard** page at `/dashboard` is the home of your inventory at a glance:

- **Totals** — filament count, spool count, grams on hand, plus printer / nozzle / bed-type counts
- **Low-stock warnings** — any filament whose aggregate remaining is under its per-filament `lowStockThreshold`. Clicking a row jumps to the filament detail.
- **Needs drying** — spools whose most recent dry cycle is older than 30 days (configurable in settings later), grouped by filament type
- **Recent print history** — the most recently logged print jobs, with a **View all →** link to the [History page](#print-history-browser-v179) and a **Log print job** button *(v1.79, #1167)* that opens an in-app dialog — job label, printer, date, notes, and one or more filament/spool/grams rows — posting through the same `/api/print-history` machinery the slicer integrations use, so spool debits and validation behave identically. Templates are excluded from the filament picker, and a row whose filament has no active spool says so before you submit (the job is then recorded without debiting inventory).

Low-stock thresholds are set per filament on the edit page under **Stock settings → Low-stock threshold (g)**. A filament with no threshold is never flagged.

## Locations *(v1.11)*

The **Locations** page at `/locations` lets you describe where your physical spools live — dryboxes, shelves, cabinets, AMS units, and so on. Each location has:

- **Name** (unique) and optional **kind** — free-form label used to group locations in pickers (`drybox`, `shelf`, `cabinet`, `printer`, etc.)
- **Humidity %RH** — optional, user-updated. *"Optional. Typically used for dryboxes — update manually after checking the hygrometer."*
- **Desiccant changed** *(v1.69)* — optional date. *"Optional. Typically used for dryboxes — set it when you swap or regenerate the beads."*
- **Notes** — free-form.

Humidity and the desiccant date both print on a [dry-box label](#dry-box-labels-knaon-y813bt-v169); locations whose kind is **Drybox** also get a **Print label** action in the list.

Once you've created at least one location, the spool detail panel gains a **Location** dropdown. Assign spools there and the list view stats show spool counts and total grams per location.

**Delete protection:** the UI refuses to delete a location that's still referenced by any spool. Reassign those spools first, or retire them, and the delete will succeed.

## Printer Slot Assignment *(v1.21)*

Separate from its **Location** (its storage "home"), a spool can be assigned to a **printer slot** — the AMS / MMU position it is currently loaded in for printing. When a printer has multi-material slots defined, the spool detail panel shows a **Printer slot** picker directly below the Location dropdown.

- Pick a `Printer · Slot` entry to assign the spool; a badge then shows where it's loaded, with a **Clear** button to remove it.
- A spool occupies at most one slot at a time — assigning it to a new slot automatically clears it from the previous one.
- Retired spools can be cleared from a slot but not newly assigned (they're out of inventory).

**Hybrid mode caveat:** printer-slot assignments are stored on the printer and are **not** synced between databases in hybrid mode — they may be cleared on the next sync cycle. The feature is fully reliable in cloud-only or offline-only setups.

## Spool Photos, Retirement & Dry Cycles *(v1.11)*

Each spool now has three additional ledgers accessible from its detail panel:

- **Photo** — upload a JPEG/PNG (SVG is rejected for security). The file is downsampled to 1200px and compressed client-side to ~200KB before being stored inline on the spool subdocument, so there's no file-upload endpoint.
- **Retired** — toggle to remove a spool from inventory totals, the PrusaSlicer spool-check endpoint, and the main spool list. History is preserved. As of v1.30.3 (#381), setting a spool's remaining weight to **0** triggers a prompt offering to also mark it retired in the same write — the canonical "I finished this spool" moment, one click instead of two.
- **Dry cycles** — log each drying session with optional temperature (°C), duration (minutes), and notes. The dashboard's "needs drying" warning reads from this log.
- **Usage history** — each manual weight decrement (or slicer-driven print job) appends an entry tagged with its source (`manual`, `slicer`, `job`, `nfc`).

## Bulk Spool CSV Import *(v1.11)*

Click **Import → Spools from CSV** on the main list. Paste your CSV or upload a file with these columns:

- **Required:** `filament`, `totalWeight`
- **Optional:** `vendor` (disambiguates duplicate filament names), `label`, `lotNumber`, `purchaseDate` (YYYY-MM-DD), `openedDate`, `location` (auto-created if not found)

The importer reports per-row success / failure, so a handful of typos won't abort the whole paste. Rows are capped at 10,000 per request.

## Print History *(v1.11)*

When a print job is recorded — by a slicer posting to `/api/print-history`, or in-app via the dashboard's **Log print job** dialog *(v1.79)* — two things happen:

1. A `PrintHistory` document is created — the canonical record of what ran, on which printer, how many grams of each filament.
2. Each referenced spool's `totalWeight` is decremented and a `usageHistory` entry is appended tagged `source: "job"`.

These writes run inside a MongoDB transaction when the deployment supports it (Atlas replicas, hybrid mode) so a mid-write failure can't leave inventory out of sync with the history ledger.

## Print History Browser *(v1.79)*

The **History** page at `/history` (in the top nav, between Analytics and Share) browses everything the ledgers above record, in two deliberately separate tabs:

- **Print jobs** — the `PrintHistory` records: search by job label *within the loaded window* (see the caveat below), filter by printer (including trashed printers whose jobs remain), expand a job for its per-filament breakdown with deep links to each filament, and **Delete** a job with refund — the debited grams are returned to the spools the job drew from, up to each spool's capacity (grams debited from a since-deleted filament or spool stay deducted).
- **Spool usage ledger** — a cross-spool search over every spool's `usageHistory` entries (backed by `GET /api/spools/usage-search`): search by entry label, filter by source (`manual`, `slicer`, `job`, `nfc`). It defaults to **manual** entries — the ones that exist nowhere else — because job- and slicer-tagged entries are projections of PrintHistory rows already shown on the Print jobs tab; a merged list would double-show every print. This is the first surface where a *manual* entry's job label can be recalled across spools.

Completeness caveats, both surfaced on the page itself:

- **Print jobs** loads only the newest 200 jobs ("Showing the most recent 200 jobs." appears once that limit is hit), and the label search filters *that* window rather than querying the server — so a matching older job won't appear. The printer filter *is* server-side, so narrowing to the printer that ran the job re-queries and brings its newest 200 into reach.
- **Spool usage ledger** is bounded twice over. By *storage*: each spool keeps at most 1,000 usage entries, with the oldest manual entries dropped first, so very old entries may be absent entirely. And by *result window*: the page requests 200 entries, and the search runs server-side but sorts newest-first before applying that limit — so a query matching more than 200 entries shows the newest 200 and silently omits older matches. Narrow by source (or by a more specific label) to bring older entries into the window.

## Usage Analytics *(v1.11)*

The **Analytics** page at `/analytics` draws from PrintHistory records plus any manual per-spool usage entries (the ones you logged directly on the spool UI without going through the print-history endpoint).

- **Window**: 7, 30, 90, or 365 days
- **Totals**: grams, estimated cost, jobs (`+N manual` is shown under the jobs counter when at least one manual per-spool entry contributed to the totals — distinguishes inventory drained via PrintHistory jobs from inventory drained via direct spool-UI logs)
- **Usage by day**: bar chart, one bar per day. A **Detailed** toggle beside the heading ("Break each bar down by filament") stacks each bar by filament, painting every segment in that filament's own color with the largest at the bottom, and adds a legend under the chart — the top 10 filaments by grams in the window, with `+N more` for the rest. Off by default and remembered per browser. Segment grams always add up to the day total the plain bar shows.
- **Breakdown**: by filament, by vendor, by printer

Manual job entries don't show up twice: entries tagged `source: "job"` or `"slicer"` are owned by a PrintHistory row and already counted in the primary aggregation. Only `source: "manual"` entries (true direct-edit logs) are added from the fallback pass.

## Sharing a Catalog *(v1.11)*

The **Share** page at `/share` lets you publish a static snapshot of selected filaments under a short slug. Use case: you want a friend to install the exact same PLA+PETG loadout you're running.

1. Select the filaments you want to share (multi-select). Since v1.34.1 the picker has search-as-you-type (matches name, vendor, type, or color), material-type filter chips, and a "show selected only" toggle so finding the right rows on a large catalog stays manageable. The chrome only appears once you have ≥12 filaments — small catalogs get the bare list.
2. Give the catalog a title + optional description, and optional expiry date
3. Click **Publish** — the server collects every nozzle / printer / bed-type referenced by those filaments and denormalises everything into the payload, so the recipient gets a complete, consistent set

**Public view** (`/share/{slug}`) — anyone with the link can browse the catalog, selectively import filaments into their own instance, and see a view counter that increments atomically. Published catalogs are static: later edits to the source filaments do not change what subsequent viewers download.

**Unpublishing** is a soft-delete: the slug returns 404 to the public immediately, but the row stays in the collection so peer sync can carry the unpublish across as a tombstone (without it, the other peer would push the still-active copy back on the next sync cycle). Slugs from unpublished catalogs can be reused by future republishes.

**Importing** on the destination side rehydrates referenced entities first (nozzles, printers, bed-types), then creates the filaments with the correct local IDs. Same-named records on the destination are reused rather than duplicated; calibrations pointing at unresolvable references are dropped rather than saved dangling.

## Filament Comparison *(v1.11)*

The **Compare** page at `/compare` takes up to 8 filaments (picked in its built-in picker, or passed via the `?ids=` query string) and renders a side-by-side table of temperatures, cost, density, diameter, calibrations, and current remaining weight. Useful when deciding which of several similar filaments to use for a job. Since v1.34.1 the picker has the same search-as-you-type, material-type filter chips, and "show selected only" toggle as `/share` (only appearing at ≥12 filaments) so picking 4–8 rows out of a large catalog stays quick.

## Spool Inventory *(v1.32)*

The **Inventory** page at `/inventory` is the same data as the filament list, viewed through the opposite lens — instead of "every filament, with its spools listed under it", you see "every location, with the filaments stored there listed under it". Use it when you want to audit a shelf or drybox at a glance, or when you need to update common per-spool details (label, remaining grams, move-to, retire) on several spools at once without bouncing through each filament's detail page.

What you see:

- **Header stats** — total spool count, location count, active grams on hand
- **Filter row** — search by filament name / label / lot number (client-side), filter by location kind (shelf, drybox, printer, …), filter by filament type or vendor, "include retired" toggle (off by default — retired spools are out of inventory)
- **Collapsible group per location** — each group's summary chip shows spool count and total grams; a drybox group's header also carries a 🖨 button that prints a [dry-box label](#dry-box-labels-knaon-y813bt-v169). A synthetic **"No location"** group catches any spool whose `locationId` is null and is intentionally sorted to the END of the list so you spot stragglers as "needs attention" rather than mistaking them for primary inventory.
- **Per-spool row** — color swatch, filament name, type, vendor, label, **inline weight editor** (click the gram value to edit, Enter to save, Esc to cancel), remaining-percent bar, last dry date, **move-to** dropdown for the spool's location, **retire/unretire** toggle (retire shows a confirm to make the inventory-removal explicit).

All edits go through the same `PUT /api/filaments/{id}/spools/{spoolId}` endpoint the filament detail page uses, so semantics — retire-on-zero prompts, weight validation, sync behaviour — are identical to the SpoolCard.

## System Theme *(v1.11)*

**Settings → UI Settings → Theme**: choose **Light**, **Dark**, or **System**. System mode follows the OS `prefers-color-scheme` media query. An inline init script runs before React mounts so the first paint is already the correct theme — no dark-mode flicker on cold load.

## Auto-Update (Desktop) *(v1.11)*

A thin banner at the top of the app announces when a new version is available, downloads it in the background on request, and prompts for a restart-and-install when ready. All strings are localized — the native install confirmation dialog uses the renderer's current locale.

On macOS, release builds are Developer ID-signed **and** notarized (since v1.39.1), so they open without a Gatekeeper warning and auto-update normally — no `xattr -cr` needed. (The first launch after a notarized download can be slow as macOS verifies it; that's expected, not a hang.) Use `xattr -cr` only as a fallback for an *unsigned* DMG you built yourself. The banner also surfaces a **View release** button if you'd rather download the DMG manually.

## Share on Local Network (Desktop) *(v1.45)*

Settings → **Share on local network** lets other devices on your LAN reach this desktop instance's built-in server. It's **off by default** — when off, the embedded server binds to localhost only and nothing outside the machine can connect.

Turn it on and the server re-binds to `0.0.0.0` (all interfaces), and the settings panel shows the LAN URL to point another device at (e.g. `http://192.168.1.50:3456`). This is what the mobile scanner app connects to.

**Securing a shared instance**: set the `FILAMENTDB_API_KEY` environment variable on the desktop host (or server) to put a bearer-token gate in front of every `/api/*` request — clients must then send a matching API key. Leaving it unset (the default) leaves the API unauthenticated, which is fine for a trusted home network but not for an exposed one. Note the gate is all-or-nothing and **disables the browser web UI** (which doesn't send the key), so it's for non-browser clients (the mobile app, slicers, scripts); for browser-UI access on a LAN, use loopback + the desktop app or an authenticating reverse proxy — see [Securing a network-exposed instance](setup.md#securing-a-network-exposed-instance).

## Find on Your Network — mDNS Auto-Discovery *(v1.47)*

While **Share on local network** is enabled, the desktop app advertises itself over mDNS / Bonjour (`_filamentdb._tcp`), so clients can find it without typing an IP. The mobile scanner app's **Find on your network** button scans for the advertisement and offers the instance to connect to. Advertising stops as soon as you turn LAN sharing back off.

## Mobile Scanner App

A lightweight iOS / Android companion app ships in [`packages/mobile/`](../packages/mobile/README.md). It's a thin "remote control" for your Filament DB server — the business logic stays on the server; the app forwards scans and edits to the REST API and renders the responses (plus a small idempotent offline write queue that survives an app restart).

What it does:

- **Connect** to a Filament DB server by manual URL **or** mDNS auto-discovery (see above), with an optional API key stored in the device keychain
- **Scan** a spool's QR label (a label deep link or bare instance ID) or an **OpenPrintTag** NFC tag (raw bytes decoded + matched server-side); NFC is gated behind the `EXPO_PUBLIC_ENABLE_NFC` build flag (so a free Apple ID can ship a QR-only build)
- **Create a filament** from a scan, and follow **spool deep links** (`?spool=`)
- **Update a spool**: set remaining weight, move it between locations, retire / un-retire, and log usage or dry cycles

Bambu Lab MIFARE Classic tags are Android-only — iPhone's Core NFC can't read them. See [`packages/mobile/README.md`](../packages/mobile/README.md) for build and setup instructions.
