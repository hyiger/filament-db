# API Reference

[< Back to README](../README.md)

> **Interactive docs**: Browse and test all endpoints in the [Swagger UI](/api-docs) — an interactive OpenAPI 3.0 explorer built into the app.

## Filaments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/filaments` | List all filaments. Query params: `search`, `type`, `vendor` |
| `POST` | `/api/filaments` | Create a new filament |
| `GET` | `/api/filaments/:id` | Get a single filament by ID (populates nozzles, calibrations, variants) |
| `PUT` | `/api/filaments/:id` | Update a filament by ID |
| `DELETE` | `/api/filaments/:id` | Soft-delete a filament (blocked if it has variants) |
| `GET` | `/api/filaments/export` | Download all filaments as a PrusaSlicer INI file |
| `GET` | `/api/filaments/export-csv` | Download all filaments as a CSV file |
| `GET` | `/api/filaments/export-xlsx` | Download all filaments as an XLSX spreadsheet |
| `POST` | `/api/filaments/import` | Upload an INI file to import filament profiles |
| `POST` | `/api/filaments/import-csv` | Upload a CSV file to import filaments |
| `POST` | `/api/filaments/import-xlsx` | Upload an XLSX file to import filaments |
| `GET` | `/api/filaments/match` | Match an NFC tag against existing filaments. Query params: `name`, `vendor`, `type` |
| `GET` | `/api/filaments/types` | List all distinct filament types |
| `GET` | `/api/filaments/vendors` | List all distinct vendor names |
| `GET` | `/api/filaments/parents` | List filaments that can be used as parents. Query params: `search`, `exclude` |
| `POST` | `/api/filaments/parse-ini` | Parse an INI file and return filament profiles without saving |
| `POST` | `/api/filaments/import-atlas` | Connect to a remote MongoDB Atlas database and import filaments |
| `GET` | `/api/filaments/:id/openprinttag` | Download OpenPrintTag binary for a filament |
| `GET` | `/api/filaments/:id/calibration` | Get calibration data for a filament and nozzle diameter |
| `GET` | `/api/filaments/:id/spool-check` | Check if a spool has enough filament for a print job |
| `POST` | `/api/filaments/:id` | Sync a filament preset back from PrusaSlicer |

### Spools

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/filaments/:id/spools` | Add a spool to a filament |
| `PUT` | `/api/filaments/:id/spools/:spoolId` | Update a spool's weight or label |
| `DELETE` | `/api/filaments/:id/spools/:spoolId` | Remove a spool from a filament |

### GET /api/filaments

Returns an array of filament documents. Supports optional query parameters:

- `search` -- filter by name (case-insensitive regex)
- `type` -- exact match on filament type (e.g., `PLA`, `PETG`)
- `vendor` -- exact match on vendor name

### POST /api/filaments

Create a new filament. Send a JSON body with at minimum `name`, `vendor`, and `type`. Validates `parentId` if provided (must exist and must not itself be a variant).

If `totalWeight` is provided but no `spools` array, an initial spool entry is automatically created from the weight value.

### GET /api/filaments/:id

Returns a single filament with `compatibleNozzles`, `calibrations.nozzle`, and `calibrations.printer` populated with full documents. Also includes:

- `_variants` -- array of child variant filaments (`_id`, `name`, `color`, `cost`)
- Inherited field resolution when the filament has a `parentId` -- fields not set on the variant are inherited from the parent, and an `_inherited` array lists which fields were inherited

### PUT /api/filaments/:id

Update a filament. Send a JSON body with the fields to update. Supports partial updates. Validates `parentId` changes (prevents circular references, nested inheritance, and self-reference).

### DELETE /api/filaments/:id

Soft-delete a filament by ID (sets `_deletedAt` timestamp). The filament is hidden from all queries but retained for sync propagation in hybrid mode. Returns `{ message: "Deleted" }`.

**Cannot delete a filament that has color variants.** Returns 400: `"Cannot delete a filament that has color variants. Delete the variants first."`.

### GET /api/filaments/export

Downloads all filaments as a PrusaSlicer-compatible INI file with one `[filament:Name]` section per filament. Uses the same generator as `GET /api/filaments/prusaslicer` — structured DB fields are mapped to PrusaSlicer INI keys and merged with the settings passthrough bag.

### POST /api/filaments/import

Upload a PrusaSlicer config bundle INI file via `multipart/form-data` with a `file` field. Parses all `[filament:...]` sections and upserts them into the database.

Returns:
```json
{
  "message": "Imported 27 filaments (25 new, 2 updated)",
  "total": 27,
  "created": 25,
  "updated": 2
}
```

### GET /api/filaments/match

Match an NFC tag's decoded data against existing filaments. Used internally by the NFC read workflow.

- `name` -- material name (exact match, case-insensitive)
- `vendor` -- brand name (substring match, case-insensitive)
- `type` -- material type (exact match, case-insensitive)

Returns:
```json
{
  "match": { "_id": "...", "name": "...", "vendor": "...", "type": "...", "color": "..." },
  "candidates": []
}
```

Matching priority: exact name match > vendor+type > vendor-only. If a single vendor+type match is found it is returned as the match. Otherwise, returns up to 5 candidates.

### GET /api/filaments/types

Returns an array of distinct filament type strings (e.g., `["ABS", "ASA", "PCTG", "PETG", "PLA"]`).

### GET /api/filaments/vendors

Returns a sorted array of distinct vendor name strings (e.g., `["Bambu Lab", "Polymaker", "Prusament"]`). Used by the vendor dropdown in the filament form.

### GET /api/filaments/parents

Returns filaments that can serve as parents for color variants, sorted by vendor then name. Supports optional query parameters:

- `search` -- filter by name (case-insensitive regex)
- `exclude` -- filament ID to exclude from results (e.g., the current filament being edited)

Returns an array of `{ _id, name, vendor, type, color }` objects.

### POST /api/filaments/parse-ini

Parse a PrusaSlicer INI config bundle and return the extracted filament profiles without saving them to the database. Upload via `multipart/form-data` with a `file` field. Returns `{ filaments: [...] }` with the same shape as the Filament model.

### POST /api/filaments/import-atlas

Connect to a remote MongoDB Atlas database and import filaments. This endpoint serves two purposes depending on the request body:

**List filaments** — send `{ uri }` to connect and retrieve all filaments from the remote database:
```json
{ "uri": "mongodb+srv://user:pass@cluster.mongodb.net/" }
```
Returns `{ filaments: [...] }` with projected fields: `_id`, `name`, `vendor`, `type`, `color`, `temperatures.nozzle`, `temperatures.bed`.

**Import filaments** — send `{ uri, filamentIds: [...] }` to import selected filaments into the local database:
```json
{ "uri": "mongodb+srv://user:pass@cluster.mongodb.net/", "filamentIds": ["id1", "id2"] }
```
Returns:
```json
{
  "message": "Imported 5 filaments (3 new, 2 updated)",
  "total": 5,
  "created": 3,
  "updated": 2
}
```

Existing filaments with the same name are updated; new filaments are created. Parent-variant relationships from the remote database are not preserved.

### GET /api/filaments/:id/calibration

Returns calibration data for a specific filament and nozzle diameter. The `{id}` parameter may be a URL-encoded preset name (e.g. `The%20K8%20PC`) or a MongoDB ObjectId. Variant filaments inherit calibrations from their parent.

Query parameters:
- `nozzle_diameter` (required) -- nozzle diameter in mm (e.g. `0.4`)
- `high_flow` (optional) -- `0` or `1`. When provided, only matches nozzles with the corresponding `highFlow` flag. Disambiguates standard vs high-flow nozzles at the same diameter.
- `bed_type` (optional) -- bed type name or ID. When provided, returns calibration values specific to that bed surface. Falls back to: bed-type-specific match → no-bed-type match → first diameter match.

Returns on success:
```json
{
  "filament": "Prusament PETG Prusa Galaxy Black",
  "nozzle": { "diameter": 0.4, "name": "Brass 0.4mm", "highFlow": false },
  "printer": "My MK4",
  "bedType": { "name": "Smooth PEI", "material": "PEI" },
  "calibration": {
    "pressureAdvance": 0.045,
    "maxVolumetricSpeed": 15,
    "extrusionMultiplier": 1.0,
    "retractLength": 0.6,
    "retractSpeed": 45,
    "retractLift": 0.2,
    "nozzleTemp": 240,
    "nozzleTempFirstLayer": 245,
    "bedTemp": 80,
    "bedTempFirstLayer": 85,
    "chamberTemp": null,
    "fanMinSpeed": null,
    "fanMaxSpeed": null,
    "fanBridgeSpeed": null
  }
}
```

Returns 400 if `nozzle_diameter` is missing. Returns 404 with an `available` array of `{ diameter, name }` objects if no calibration matches the requested diameter.

Used by PrusaSlicer Filament Edition to auto-adjust filament settings when the user switches printer presets.

### POST /api/filaments/:id

Sync a filament preset back from PrusaSlicer. The `{id}` parameter may be a URL-encoded preset name or a MongoDB ObjectId.

Query parameters:
- `nozzle_diameter` (optional) -- nozzle diameter in mm (e.g. `0.4`). When provided, calibration-related keys (`extrusion_multiplier`, `pressure_advance`, `filament_retract_length`, `filament_retract_speed`, `filament_retract_lift`) are written to the matching per-nozzle calibration entry instead of the settings bag.
- `high_flow` (optional) -- `0` or `1`. Used with `nozzle_diameter` to disambiguate standard vs high-flow nozzles at the same diameter.

Send a JSON body:
```json
{ "config": { "temperature": "215", "filament_density": "1.24", "my_custom_key": "value" } }
```

Recognised PrusaSlicer INI keys (`filament_type`, `filament_vendor`, `filament_colour`, `filament_diameter`, `filament_density`, `filament_cost`, `filament_spool_weight`, `filament_max_volumetric_speed`, `temperature`, `first_layer_temperature`, `bed_temperature`, `first_layer_bed_temperature`, `filament_shrinkage_compensation_xy`, `filament_shrinkage_compensation_z`, `filament_soluble`, `filament_abrasive`) are reverse-mapped to structured DB fields. All remaining keys are merged into the filament's `settings` passthrough bag.

Returns:
```json
{
  "message": "Synced 12 settings for \"Prusament PETG Prusa Galaxy Black\"",
  "filamentId": "64a1b2c3d4e5f6a7b8c9d0e1"
}
```

### GET /api/filaments/:id/spool-check

Checks whether any spool of this filament has enough remaining filament (by weight) for a print job. The `{id}` parameter may be a URL-encoded preset name or a MongoDB ObjectId.

Query parameters:
- `weight` (required) -- estimated filament weight in grams

Returns:
```json
{
  "ok": true,
  "filament": "Prusament PETG Prusa Galaxy Black",
  "requiredWeightG": 42.5,
  "requiredLengthM": 14.03,
  "spools": [
    {
      "id": "default",
      "label": "Default",
      "remainingWeightG": 864,
      "remainingLengthM": 285.12,
      "enough": true
    }
  ]
}
```

If no spool has enough filament, `ok` is `false` and a `warning` string is included describing the shortfall. If the filament has no spools or no spool weight data, returns `ok: true` (no data = no warning).

Returns 400 if `weight` is missing or invalid. Returns 404 if the filament is not found.

### GET /api/filaments/:id/openprinttag

Downloads the filament as an OpenPrintTag CBOR binary (`.bin` file). The binary can be written to an NFC-V (ISO 15693) tag or used with other OpenPrintTag-compatible tools.

### POST /api/filaments/:id/spools

Add a new spool to a filament. Send a JSON body:

```json
{ "label": "Spool #2", "totalWeight": 1236 }
```

Both fields are optional (`label` defaults to `""`, `totalWeight` defaults to `null`). Returns the updated filament document with the new spool in the `spools` array.

### PUT /api/filaments/:id/spools/:spoolId

Update a spool's weight or label. Send a JSON body with any combination of:

```json
{ "totalWeight": 850, "label": "Opened 2025-03-15" }
```

Returns the updated filament document.

### DELETE /api/filaments/:id/spools/:spoolId

Remove a spool from a filament. Returns the updated filament document.

---

## PrusaSlicer Config Bundle

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/filaments/prusaslicer` | Export filaments as a PrusaSlicer-compatible INI config bundle |
| `POST` | `/api/filaments/prusaslicer` | Import a PrusaSlicer INI config bundle |

### GET /api/filaments/prusaslicer

Exports all filaments as a PrusaSlicer-compatible INI config bundle with one `[filament:Name]` section per filament. Structured DB fields (temperatures, density, cost, max volumetric speed, shrinkage) are mapped to their PrusaSlicer INI equivalents and merged with the `settings` passthrough bag. Calibration overrides (extrusion multiplier, pressure advance, retraction, max volumetric speed) are NOT baked into the bundle — they are applied dynamically by PrusaSlicer Filament Edition via `GET /api/filaments/:name/calibration` when the printer/nozzle context changes.

Query parameters:
- `type` -- filter by filament type (e.g. `PLA`, `PETG`)
- `vendor` -- filter by vendor name
- `ids` -- comma-separated list of filament IDs

Returns `text/plain` INI content.

### POST /api/filaments/prusaslicer

Import a PrusaSlicer INI config bundle. Send the INI text as the raw request body (e.g. `Content-Type: text/plain`).

Returns:
```json
{
  "created": 12,
  "updated": 3,
  "filaments": ["Prusament PLA Galaxy Black", "Prusament PETG Orange", "..."]
}
```

`filaments` is an array of the preset names that were imported.

---

## OpenPrintTag Database

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/openprinttag` | Browse the OpenPrintTag community database (FDM filaments only) |
| `POST` | `/api/openprinttag/import` | Import selected materials into Filament DB |

### GET /api/openprinttag

Fetches the [OpenPrintTag community database](https://github.com/OpenPrintTag/openprinttag-database) from GitHub, parses all material YAML files, filters to FFF (FDM) filaments, and returns them with completeness scores. Results are cached for 1 hour.

Query parameters:
- `refresh=true` -- force re-fetch from GitHub (clears cache)

Returns:
```json
{
  "brands": [
    { "slug": "prusament", "name": "Prusament", "materialCount": 42 }
  ],
  "materials": [
    {
      "slug": "prusament-pla-prusa-galaxy-black",
      "uuid": "1aaca54a-...",
      "brandSlug": "prusament",
      "brandName": "Prusament",
      "name": "PLA Prusa Galaxy Black",
      "type": "PLA",
      "color": "#3d3e3d",
      "density": 1.24,
      "nozzleTempMin": 205,
      "nozzleTempMax": 225,
      "completenessScore": 8,
      "completenessTier": "rich"
    }
  ],
  "cachedAt": "2026-04-02T...",
  "totalFFF": 11194,
  "totalSLA": 171
}
```

Completeness scoring (0–10): color, density, print temps, bed temps, drying temp, hardness, transmission distance, chamber temp, photos, product URL. Tiers: rich (7–10), partial (4–6), stub (0–3).

### POST /api/openprinttag/import

Import selected OpenPrintTag materials into Filament DB. Send a JSON body:

```json
{ "slugs": ["prusament-pla-prusa-galaxy-black", "polymaker-fiberon-pa6-cf20-black"] }
```

Materials are mapped to the Filament DB schema (type, vendor, temperatures, density, hardness, transmission distance, drying specs, OPT tags) and upserted by name. If a filament with the same name already exists under a different vendor, the import is skipped with an informative error (the unique index is on `name` alone).

Returns:
```json
{
  "message": "Imported 2 filaments (2 new)",
  "total": 2,
  "created": 2,
  "updated": 0
}
```

---

## Prusament

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/prusament` | Scrape a Prusament spool page by spool ID |
| `POST` | `/api/prusament/import` | Import a scraped spool as a filament |

### GET /api/prusament

Fetches a Prusament spool detail page (from the QR code on the spool) and extracts the embedded spool data. Query parameter:

- `spoolId` -- the spool identifier (e.g., `c6974284da`) or the full URL

Returns:
```json
{
  "spoolId": "c6974284da",
  "productName": "Prusament PETG Prusa Galaxy Black 1kg - v1",
  "material": "PETG",
  "colorName": "Prusa Galaxy Black",
  "colorHex": "#292929",
  "diameter": 1.75,
  "diameterAvg": 1.748,
  "diameterStdDev": 2.5183,
  "ovality": 0.971,
  "netWeight": 1050,
  "spoolWeight": 186,
  "totalWeight": 1236,
  "lengthMeters": 345,
  "nozzleTempMin": 240,
  "nozzleTempMax": 260,
  "bedTempMin": 70,
  "bedTempMax": 90,
  "manufactureDate": "2025-01-05 08:21:40",
  "country": "CZ",
  "goodsId": 4715,
  "priceUsd": 29.99,
  "priceEur": 29.99,
  "photoUrl": "https://...",
  "pageUrl": "https://prusament.com/spool/?spoolId=c6974284da"
}
```

### POST /api/prusament/import

Imports a scraped Prusament spool into the database. Send a JSON body:

```json
{
  "spool": { "...scraped data from GET /api/prusament..." },
  "action": "create",
  "filamentId": null
}
```

**`action: "create"`** -- Creates a new filament named `"Prusament {material} {colorName}"` with all specs populated (temperatures, density, weights, spool). If a filament with that name already exists, the spool is added to it instead.

**`action: "add-spool"`** -- Adds the spool to an existing filament specified by `filamentId`.

Returns:
```json
{
  "action": "create",
  "filament": { "...full filament document..." },
  "message": "Created \"Prusament PETG Prusa Galaxy Black\" with spool c6974284da"
}
```

---

## Nozzles

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/nozzles` | List all nozzles. Query params: `diameter`, `type`, `highFlow` |
| `POST` | `/api/nozzles` | Create a new nozzle |
| `GET` | `/api/nozzles/:id` | Get a single nozzle by ID |
| `PUT` | `/api/nozzles/:id` | Update a nozzle by ID |
| `DELETE` | `/api/nozzles/:id` | Soft-delete a nozzle (blocked if referenced by filaments) |

### GET /api/nozzles

Returns an array of nozzle documents sorted by diameter then type. Supports optional query parameters:

- `diameter` -- filter by diameter (e.g., `0.4`)
- `type` -- filter by nozzle type (e.g., `Brass`)
- `highFlow` -- filter by high-flow flag (`true` or `false`)

### POST /api/nozzles

Create a new nozzle. Required fields: `name`, `diameter`, `type`.

### PUT /api/nozzles/:id

Update a nozzle. Send a JSON body with the fields to update.

### DELETE /api/nozzles/:id

Soft-delete a nozzle by ID (sets `_deletedAt` timestamp). Cannot delete a nozzle that is referenced by filaments or installed on any printer. Returns `{ message: "Deleted" }`.

---

## Printers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/printers` | List all printers. Query params: `manufacturer` |
| `POST` | `/api/printers` | Create a new printer |
| `GET` | `/api/printers/:id` | Get a single printer by ID (populates installed nozzles) |
| `PUT` | `/api/printers/:id` | Update a printer by ID |
| `DELETE` | `/api/printers/:id` | Soft-delete a printer (blocked if referenced by calibrations) |

### GET /api/printers

Returns an array of printer documents sorted by manufacturer then name, with `installedNozzles` populated. Supports optional query parameters:

- `manufacturer` -- filter by manufacturer name

### POST /api/printers

Create a new printer. Required fields: `name`, `manufacturer`, `printerModel`.

### GET /api/printers/:id

Returns a single printer with `installedNozzles` populated with full nozzle documents.

### PUT /api/printers/:id

Update a printer. Send a JSON body with the fields to update.

### DELETE /api/printers/:id

Soft-delete a printer by ID (sets `_deletedAt` timestamp). Cannot delete a printer that is referenced by filament calibrations. Returns `{ message: "Deleted" }`.

---

## Bed Types

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/bed-types` | List all bed types. Query params: `material` |
| `POST` | `/api/bed-types` | Create a new bed type |
| `GET` | `/api/bed-types/:id` | Get a single bed type by ID |
| `PUT` | `/api/bed-types/:id` | Update a bed type by ID |
| `DELETE` | `/api/bed-types/:id` | Soft-delete a bed type (blocked if referenced by filament calibrations) |

### GET /api/bed-types

Returns an array of bed type documents sorted by name. Supports optional query parameters:

- `material` -- filter by material (e.g., `PEI`, `Glass`)

### POST /api/bed-types

Create a new bed type. Required fields: `name`, `material`.

### PUT /api/bed-types/:id

Update a bed type. Send a JSON body with the fields to update.

### DELETE /api/bed-types/:id

Soft-delete a bed type by ID (sets `_deletedAt` timestamp). Cannot delete a bed type that is referenced by filament calibrations. Returns `{ message: "Deleted" }`.

---

## TDS Extraction (AI)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tds` | Check if an AI API key is configured |
| `PUT` | `/api/tds` | Save an AI API key (with provider selection) |
| `DELETE` | `/api/tds` | Remove the stored AI API key |
| `POST` | `/api/tds` | Extract filament data from a TDS URL |

### GET /api/tds

Returns whether an AI API key is configured and which provider is active.

```json
{ "configured": true, "provider": "gemini" }
```

### PUT /api/tds

Save and validate an AI API key. Send a JSON body:

```json
{ "apiKey": "your-api-key", "provider": "gemini" }
```

Supported providers: `gemini` (Google Gemini), `claude` (Anthropic Claude), `openai` (OpenAI ChatGPT).

The key is validated against the provider's API before saving. Returns `{ success: true }` on success or 401 if the key is invalid.

### DELETE /api/tds

Removes the stored API key and resets the provider to the default (Gemini).

### POST /api/tds

Extract filament properties from a Technical Data Sheet using AI. Accepts two input modes:

**URL-based** -- Send a JSON body:
```json
{ "url": "https://example.com/filament-tds.pdf", "apiKey": "optional-key", "provider": "gemini" }
```

- `url` (required) -- URL to a TDS document (PDF or web page)
- `apiKey` (optional) -- API key to use. Falls back to environment variable (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`) or the stored key from PUT.
- `provider` (optional) -- AI provider to use. Falls back to the stored provider.

**File upload** -- Upload via `multipart/form-data` with a `file` field (max 10 MB). PDF and plain-text files are supported. Additional form fields `apiKey` and `provider` are also accepted.

```
POST /api/tds
Content-Type: multipart/form-data

file=<PDF or text file>
apiKey=<optional>
provider=<optional>
```

Returns:
```json
{
  "success": true,
  "fieldsExtracted": 12,
  "data": {
    "name": "SuperPLA Pro",
    "vendor": "ExampleBrand",
    "type": "PLA",
    "density": 1.24,
    "diameter": 1.75,
    "temperatures": {
      "nozzle": 215,
      "nozzleRangeMin": 200,
      "nozzleRangeMax": 230,
      "bed": 60
    },
    "dryingTemperature": 55,
    "dryingTime": 4,
    "glassTempTransition": 60,
    "heatDeflectionTemp": 52
  }
}
```

Extracted fields include: name, vendor, type, density, diameter, temperatures (nozzle, bed, ranges), drying temperature/time, glass transition (Tg), heat deflection (HDT), shore hardness (A/D), volumetric speed, print speed ranges, and weights. Fields not found in the TDS are omitted from the response.

---

## Setup

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/setup` | Test a MongoDB connection string |

---

## Snapshot

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/snapshot` | Export the entire database as a JSON snapshot |
| `POST` | `/api/snapshot` | Restore the database from a JSON snapshot |
| `DELETE` | `/api/snapshot/delete` | Permanently delete all data from all collections |

### GET /api/snapshot

Downloads a JSON snapshot of the entire database, including all filaments, nozzles, printers, and bed types (including soft-deleted documents). The snapshot preserves `_id` values, timestamps, and references so it can be restored exactly.

Returns a JSON file with `Content-Disposition: attachment` header.

### POST /api/snapshot

Restore the database from a previously exported snapshot. This is a destructive operation: all existing data is replaced with the snapshot contents.

Upload via `multipart/form-data` with a `file` field containing the snapshot JSON, or send the JSON directly as the request body.

The restore uses **best-effort rollback**: if any part of the restore fails, the handler attempts to re-insert the previous data from an in-memory backup. Concurrent restore requests are rejected with 409. Note: the restore is not truly atomic — concurrent readers may observe partial state during the delete/insert window, and if rollback itself fails the database may be left incomplete. For safety, take a backup before restoring.

Returns:
```json
{
  "message": "Snapshot restored successfully",
  "restored": { "filaments": 42, "nozzles": 5, "printers": 2 }
}
```

### DELETE /api/snapshot/delete

Permanently deletes all documents from all three collections (filaments, nozzles, printers). Returns the count of deleted documents per collection.

---

## CSV / XLSX Import & Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/filaments/export-csv` | Download all filaments as a CSV file |
| `GET` | `/api/filaments/export-xlsx` | Download all filaments as an XLSX spreadsheet |
| `POST` | `/api/filaments/import-csv` | Import filaments from a CSV file |
| `POST` | `/api/filaments/import-xlsx` | Import filaments from an XLSX file |

### GET /api/filaments/export-csv

Downloads all filaments as a CSV file with columns for name, vendor, type, color, color name, diameter, temperatures (nozzle, bed, first layer, ranges, standby), cost, density, weights, instance ID, drying temperature/time, transmission distance, glass transition (Tg), heat deflection (HDT), shore hardness (A/D), print speed ranges, and spool type.

### GET /api/filaments/export-xlsx

Downloads all filaments as a styled XLSX spreadsheet with auto-filter, frozen header row, color-coded cells, and the same columns as CSV export.

### POST /api/filaments/import-csv

Upload a CSV file via `multipart/form-data` with a `file` field (max 10 MB). The CSV must have a header row with `Name`, `Vendor`, and `Type` columns at minimum. Additional columns are mapped by header name (case-insensitive), including: `Color`, `Color Name`, `Diameter`, `Cost`, `Density`, `Nozzle Temp`, `Bed Temp`, `Nozzle First Layer`, `Bed First Layer`, `Max Volumetric Speed`, `Spool Weight`, `Net Filament Weight`, `TDS URL`, `Instance ID`, `Drying Temp`, `Drying Time`, `Transmission Distance` / `HueForge TD`, `Glass Transition` / `Tg`, `Heat Deflection` / `HDT`, `Shore A`, `Shore D`, `Min Print Speed`, `Max Print Speed`, `Nozzle Range Min`, `Nozzle Range Max`, `Standby Temp`, `Spool Type`. Only fields present in the CSV are updated — existing data for unmapped columns is preserved.

### POST /api/filaments/import-xlsx

Upload an XLSX file via `multipart/form-data` with a `file` field (max 10 MB). Same column mapping and behavior as CSV import.

Both return:
```json
{
  "message": "Imported 10 filaments (8 new, 1 updated, 1 skipped)",
  "total": 10,
  "created": 8,
  "updated": 1,
  "skipped": 1,
  "skippedRows": [
    { "row": 5, "name": "Partial Entry", "reason": "Missing required field(s): vendor" }
  ]
}
```

---

## Setup

### POST /api/setup

Tests a MongoDB Atlas connection. Send a JSON body:

```json
{
  "mongodbUri": "mongodb+srv://user:pass@cluster.mongodb.net/filament-db"
}
```

Returns `{ success: true, message: "Connection successful" }` on success, or a 400 error with the failure reason. Used by the desktop app's setup wizard to validate the connection before saving.

---

## Locations (v1.11)

Locations are where physical spools live — dryboxes, shelves, cabinets, AMS units. Each spool may optionally reference a single location.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`    | `/api/locations`        | List all non-deleted locations (sorted by name). Query params: `kind`, `stats=true` (attach spoolCount + totalGrams per location) |
| `POST`   | `/api/locations`        | Create a location. Returns 409 on duplicate name. |
| `GET`    | `/api/locations/:id`    | Fetch a single location |
| `PUT`    | `/api/locations/:id`    | Update mutable fields |
| `DELETE` | `/api/locations/:id`    | Soft-delete. Returns 400 if any spool still references this location — reassign those spools first. |

### Location document shape

```json
{
  "_id": "…",
  "name": "Drybox #1",
  "kind": "drybox",          // free-form: "drybox", "shelf", "cabinet", "printer"
  "humidity": 35,             // optional %RH (0–100), user-updated
  "notes": "Kept in the garage"
}
```

### GET /api/locations?stats=true

When stats are requested the response is enriched with live inventory counts, computed via a single aggregation over `Filament.spools`:

```json
[
  { "_id": "…", "name": "Drybox #1", "kind": "drybox", "spoolCount": 3, "totalGrams": 2450 }
]
```

Retired spools (`spool.retired === true`) are excluded from the counts.

---

## Print History (v1.11)

Per-job ledger of print runs. Decrements spool weights, appends spool-level usageHistory entries tagged `source: "job"`, and keeps a top-level record for analytics.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/print-history` | List print jobs (desc by `startedAt`). Query: `filamentId`, `printerId`, `limit` (default 100, max 1000) |
| `POST` | `/api/print-history` | Record a print job (see body below) |

### POST /api/print-history

```json
{
  "jobLabel": "benchy.3mf",
  "printerId": "optional-printer-id",
  "startedAt": "2026-04-22T10:00:00Z",
  "source": "prusaslicer",
  "notes": "optional free-form",
  "usage": [
    { "filamentId": "…", "spoolId": "optional", "grams": 42 },
    { "filamentId": "…", "grams": 8 }
  ]
}
```

Validations:
- `jobLabel` is required, max 200 chars.
- `usage` must have 1–100 entries, each with a valid `filamentId` and non-negative `grams`.
- `notes` is truncated to 2000 chars.
- `source` must be one of `manual | prusaslicer | orcaslicer | bambu | other`; unknown values default to `manual`.

Every referenced filament is fetched and validated **before** any mutation. If any one is missing the whole request aborts with 404 and no spool weights are touched. The writes run inside a MongoDB transaction when the deployment supports it (Atlas always does), and fall back to sequential saves on standalone mongod.

Response: the created `PrintHistory` document, `201`.

---

## Analytics (v1.11)

Aggregates PrintHistory rows plus any manual per-spool usageHistory entries (the ones users logged directly on the spool UI without going through `/api/print-history`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/analytics?days=30` | Usage analytics for the last N days (7–365, default 30) |

### Response

```json
{
  "since": "2026-03-23T00:00:00Z",
  "days": 30,
  "totals": { "grams": 3240, "cost": 82.50, "jobs": 17 },
  "usageByDay": [{ "date": "2026-03-23", "grams": 0 }, …],
  "byFilament":  [{ "_id": "…", "name": "PLA Black", "vendor": "Vendor A", "cost": 25, "grams": 1200 }, …],
  "byVendor":    [{ "vendor": "Vendor A", "grams": 2100 }, …],
  "byPrinter":   [{ "_id": "…", "name": "Core One", "grams": 1900 }, …]
}
```

`usageHistory` entries are only pulled in when `source === "manual"`. Entries with `source: "job"` or `"slicer"` are owned by a PrintHistory row and already counted in the primary aggregation — including them here would double-count the same grams.

---

## Share (v1.11)

Publishes a static snapshot of selected filaments with their referenced nozzles/printers/bed types, served under a short slug so another user (or another machine) can import the set.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`    | `/api/share`            | List catalogs you've published (newest first) |
| `POST`   | `/api/share`            | Publish a new catalog |
| `GET`    | `/api/share/:slug`      | Public fetch. Atomically increments `viewCount`. Returns 410 when expired. |
| `DELETE` | `/api/share/:slug`      | Unpublish |

### POST /api/share

```json
{
  "title": "My favourite PLAs",
  "description": "Optional markdown-ish summary",
  "filamentIds": ["…", "…"],
  "expiresAt": "2026-12-31T00:00:00Z"
}
```

Validations:
- `title` is required, max 200 chars. `description` max 5000 chars.
- `filamentIds` must have 1–500 entries.

The server collects every nozzle / printer / bedType referenced by the selected filaments and denormalises all of them into the catalog payload. Later edits to the source filaments do not change what subsequent viewers download — the snapshot is static.

### GET /api/share/:slug

Response includes `viewCount` (incremented atomically via `$inc`) and the full denormalised payload. Use this as the source of truth for importing on the destination side.

---

## Spool Usage & Dry Cycles (v1.11)

Per-spool ledger endpoints. Used by the spool detail UI to log direct weight consumption and dry-box cycles.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/filaments/:id/spools/:spoolId/usage`       | Log grams used on this spool. Decrements `totalWeight` (clamped at 0) and appends a `usageHistory` entry tagged `source: "manual"`. |
| `POST` | `/api/filaments/:id/spools/:spoolId/dry-cycles`  | Log a drying cycle. All fields optional; `date` defaults to now. |

### POST .../usage

```json
{ "grams": 120, "jobLabel": "optional", "date": "optional ISO string" }
```

`grams` must be > 0. `jobLabel` max 200 chars.

### POST .../dry-cycles

```json
{ "date": "optional ISO", "tempC": 65, "durationMin": 240, "notes": "pre-print dry" }
```

All fields optional. Unspecified numeric fields are stored as `null`.

---

## Bulk Spool Import (CSV) (v1.11)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/spools/import` | Bulk-create spools from CSV |

Accepts either:
- `Content-Type: text/csv` with the raw CSV body
- `Content-Type: application/json` with `{ "csv": "…" }`

### Required columns

- `filament` — matched to `Filament.name`; `vendor` disambiguates duplicates
- `totalWeight` — non-negative grams

### Optional columns

- `vendor`, `label`, `lotNumber`, `purchaseDate` (ISO), `openedDate`, `location` (name — auto-created if it doesn't already exist)

Each row is processed independently; per-row errors are reported in the response without aborting the batch:

```json
{
  "imported": 12,
  "failed": 2,
  "results": [
    { "row": 2, "ok": true, "filament": "PLA Black" },
    { "row": 3, "ok": false, "error": "No filament named \"Unknown\"" }
  ]
}
```

A single request is capped at 10,000 rows by `parseCsv`; beyond that the request is rejected with 400.
