# API Reference

## Filaments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/filaments` | List all filaments. Query params: `search`, `type`, `vendor` |
| `POST` | `/api/filaments` | Create a new filament |
| `GET` | `/api/filaments/:id` | Get a single filament by ID (populates nozzles and calibrations) |
| `PUT` | `/api/filaments/:id` | Update a filament by ID |
| `DELETE` | `/api/filaments/:id` | Delete a filament by ID |
| `GET` | `/api/filaments/export` | Download all filaments as a PrusaSlicer INI file |
| `POST` | `/api/filaments/import` | Upload an INI file to import filament profiles |

### GET /api/filaments

Returns an array of filament documents. Supports optional query parameters:

- `search` -- filter by name (case-insensitive regex)
- `type` -- exact match on filament type (e.g., `PLA`, `PETG`)
- `vendor` -- exact match on vendor name

### POST /api/filaments

Create a new filament. Send a JSON body with at minimum `name`, `vendor`, and `type`.

### GET /api/filaments/:id

Returns a single filament with `compatibleNozzles` and `calibrations.nozzle` populated with full nozzle documents.

### PUT /api/filaments/:id

Update a filament. Send a JSON body with the fields to update. Supports partial updates.

### DELETE /api/filaments/:id

Delete a filament by ID. Returns `{ message: "Deleted" }`.

### GET /api/filaments/export

Downloads all filaments as a PrusaSlicer-compatible INI file. Filaments with per-nozzle calibrations are exported as separate `[filament:Name NozzleSize]` sections with overrides merged into the base settings.

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

---

## Nozzles

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/nozzles` | List all nozzles. Query params: `diameter`, `type`, `highFlow` |
| `POST` | `/api/nozzles` | Create a new nozzle |
| `GET` | `/api/nozzles/:id` | Get a single nozzle by ID |
| `PUT` | `/api/nozzles/:id` | Update a nozzle by ID |
| `DELETE` | `/api/nozzles/:id` | Delete a nozzle by ID |

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

Delete a nozzle by ID. Returns `{ message: "Deleted" }`.

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
