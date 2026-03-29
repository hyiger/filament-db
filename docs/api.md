# API Reference

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
| `POST` | `/api/filaments/import` | Upload an INI file to import filament profiles |
| `GET` | `/api/filaments/match` | Match an NFC tag against existing filaments. Query params: `name`, `vendor`, `type` |
| `GET` | `/api/filaments/types` | List all distinct filament types |
| `GET` | `/api/filaments/vendors` | List all distinct vendor names |
| `GET` | `/api/filaments/parents` | List filaments that can be used as parents. Query params: `search`, `exclude` |
| `POST` | `/api/filaments/parse-ini` | Parse an INI file and return filament profiles without saving |
| `POST` | `/api/filaments/import-atlas` | Connect to a remote MongoDB Atlas database and import filaments |
| `GET` | `/api/filaments/:id/openprinttag` | Download OpenPrintTag binary for a filament |

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

Downloads all filaments as a PrusaSlicer-compatible INI file. Filaments with calibrations are exported as separate sections with overrides merged into the base settings. Section names follow the pattern `[filament:Name PrinterName NozzleSize]` when printer-specific calibrations exist, `[filament:Name NozzleSize]` for default/any-printer calibrations, or `[filament:Name PrinterName NozzleSize PresetLabel]` when presets are defined.

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

## Setup

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/setup` | Test a MongoDB connection string |

### POST /api/setup

Tests a MongoDB Atlas connection. Send a JSON body:

```json
{
  "mongodbUri": "mongodb+srv://user:pass@cluster.mongodb.net/filament-db"
}
```

Returns `{ success: true, message: "Connection successful" }` on success, or a 400 error with the failure reason. Used by the desktop app's setup wizard to validate the connection before saving.
