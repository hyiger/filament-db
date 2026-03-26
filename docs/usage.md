# Using the Application

## Browsing Filaments

The home page displays all filaments in a sortable table with columns for color, name, vendor, type, nozzle temperature, bed temperature, and cost.

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
2. Fill in the required fields (name, vendor, type)
3. Optionally set temperatures, cost, density, color, fan settings, retraction, shrinkage, pressure advance, and other properties
4. Select compatible nozzles and enter per-nozzle calibration overrides
5. Add a TDS link (suggestions from other filaments by the same vendor appear automatically)
6. Click **"Create Filament"**

## Editing a Filament

1. Click **"Edit"** next to any filament in the list, or click **"Edit"** on the detail page
2. Modify the fields you want to change
3. Click **"Update Filament"**

## Deleting a Filament

Click **"Delete"** next to any filament in the list. You will be prompted to confirm before deletion.

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
