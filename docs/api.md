# API Reference

[< Back to README](../README.md)

> **Interactive docs**: Browse and test the documented OpenAPI surface in the [Swagger UI](/api-docs) — an interactive OpenAPI 3.0 explorer built into the app. This Markdown reference also documents newer routes that may have more detailed prose than the generated Swagger view.

## Filaments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/filaments` | List all filaments. Query params: `search`, `type`, `vendor` |
| `POST` | `/api/filaments` | Create a new filament |
| `GET` | `/api/filaments/:id` | Get a single filament by ID (populates nozzles, calibrations, variants) |
| `PUT` | `/api/filaments/:id` | Update a filament by ID |
| `DELETE` | `/api/filaments/:id` | Soft-delete a filament (blocked if it has variants). Append `?permanent=true` to hard-delete from the trash. |
| `GET` | `/api/filaments/trash` | List soft-deleted filaments (powers the `/trash` UI) |
| `POST` | `/api/filaments/:id/restore` | Restore a soft-deleted filament from the trash (returns 409 on name collision) |
| `GET` | `/api/filaments/export` | Download all filaments as a PrusaSlicer INI file |
| `GET` | `/api/filaments/export-csv` | Download all filaments as a CSV file |
| `GET` | `/api/filaments/export-xlsx` | Download all filaments as an XLSX spreadsheet |
| `POST` | `/api/filaments/import` | Upload an INI file to import filament profiles |
| `POST` | `/api/filaments/import-csv` | Upload a CSV file to import filaments |
| `POST` | `/api/filaments/import-xlsx` | Upload an XLSX file to import filaments |
| `GET` | `/api/filaments/match` | Match an NFC tag or scanned label QR against existing filaments. Query params: `instanceId` (highest priority), `name`, `vendor`, `type` |
| `POST` | `/api/nfc/decode` | Decode raw NFC tag bytes (OpenPrintTag or Bambu) server-side and match the result against the DB. Backs the mobile scanner app |
| `GET` | `/api/filaments/types` | List all distinct filament types |
| `GET` | `/api/filaments/vendors` | List all distinct vendor names |
| `GET` | `/api/filaments/parents` | List filaments that can be used as parents. Query params: `search`, `exclude` |
| `POST` | `/api/filaments/parse-ini` | Parse an INI file and return filament profiles without saving |
| `POST` | `/api/filaments/import-atlas` | Connect to a remote MongoDB Atlas database and import filaments |
| `GET` | `/api/filaments/:id/openprinttag` | Download OpenPrintTag binary for a filament |
| `GET` | `/api/filaments/:id/openprinttag/check` | Diff a linked filament against the current OpenPrintTag material |
| `POST` | `/api/filaments/:id/openprinttag/sync` | Apply selected OpenPrintTag updates to a linked filament |
| `GET` | `/api/filaments/:id/calibration` | Get calibration data for a filament and nozzle diameter |
| `GET` | `/api/filaments/:id/spool-check` | Check if a spool has enough filament for a print job |
| `POST` | `/api/filaments/:id` | Sync a filament preset back from PrusaSlicer |
| `GET` | `/api/filaments/:id/prusaslicer` | Download one filament as a PrusaSlicer preset (`.ini`) |
| `GET` | `/api/filaments/:id/orcaslicer` | Download one filament as an OrcaSlicer preset (`.json`) |
| `GET` | `/api/filaments/:id/bambustudio` | Download one filament as a Bambu Studio preset (.json) |
| `POST` | `/api/filaments/:id/bambustudio` | Sync a Bambu Studio preset INTO this filament (pinned by id) |
| `POST` | `/api/filaments/bambustudio` | Import a Bambu Studio preset by name (upsert + auto-detect calibration) |
| `GET` | `/api/filaments/colors` | Distinct `(colorName, color)` pairs across non-deleted filaments (backs the color-name typeahead) |

### Spools

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/filaments/:id/spools` | Add a spool to a filament (optional explicit `instanceId`) |
| `PUT` | `/api/filaments/:id/spools/:spoolId` | Update a spool's weight/label/location, or its `instanceId` (`{ regenerate: true }` mints a fresh one) — #732 |
| `DELETE` | `/api/filaments/:id/spools/:spoolId` | Remove a spool from a filament |
| `GET` | `/api/spools/:spoolId` | Resolve a spool subdoc id to its (inheritance-resolved) owning filament + the spool — powers the mobile scanner's `?spool=<id>` deep links (v1.43) |

### GET /api/filaments

Returns an array of projected filament summaries (not the full documents — heavy spool subfields like `photoDataUrl`, `usageHistory`, and `dryCycles` are stripped to keep the list payload small). Supports optional query parameters:

- `search` -- filter by name (case-insensitive regex)
- `type` -- exact match on filament type (e.g., `PLA`, `PETG`)
- `vendor` -- exact match on vendor name

**Response shape per row** (matches `FilamentSummary` in `src/types/filament.ts` plus a few extras the list / form / picker need):

```json
{
  "_id": "…",
  "name": "Prusament PLA Galaxy Black",
  "vendor": "Prusament",
  "type": "PLA",
  "color": "#1a1a2e",
  "secondaryColors": [],
  "cost": 35,
  "density": 1.24,
  "parentId": null,
  "spoolWeight": 200,
  "netFilamentWeight": 1000,
  "totalWeight": null,
  "lowStockThreshold": 250,
  "tdsUrl": "https://example.com/tds.pdf",
  "temperatures": { "nozzle": 215, "bed": 60 },
  "hasCalibrations": true,
  "hasVariants": false,
  "optTags": [],
  "spools": [
    { "_id": "…", "instanceId": "2acc21072a", "label": "AMS slot 1", "totalWeight": 800, "retired": false, "locationId": "…" }
  ]
}
```

- `hasCalibrations` is `true` when the filament has at least one calibration, **or** when it's a variant whose parent has at least one (via aggregation `$lookup`). The "Missing calibration" quick filter on the list page reads this — variants that inherit from a parent are correctly counted as calibrated.
- `hasVariants` is `true` when the filament has at least one non-deleted variant (drives the parent cross-hatch/composite swatch); `optTags` (effective, parent-inherited) drives the finish indicator; `spools[].instanceId` is the per-spool id (#732) and `spools[].locationId` powers the inline move-to dropdown on the main list.
- `tdsUrl` is included so `FilamentForm`'s vendor-keyed TDS suggestions still work.
- `spools[].label` is included so `PrinterForm`'s AMS slot picker can render `s.label || s._id.slice(-4)`.
- `color` is **nullable** — coextruded multi-color filaments leave it null and put their colors in `secondaryColors`. `secondaryColors` is an ordered array of up to 5 `#RRGGBB` hex codes that mirrors OpenPrintTag's `secondary_color_0..4` keys (spec keys 20–24). Variants inherit `secondaryColors` array-fallback style: a variant either declares its own non-empty array or inherits the parent's entire array (same pattern as `optTags` / `bedTypeTemps`). Slicer-bound exports (PrusaSlicer / OrcaSlicer / Bambu Studio) drop secondaries silently — slicer presets are single-color formats.

For the full document (calibrations array, presets, settings, full spool subdocs), call `GET /api/filaments/:id`.

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

Soft-delete a filament by ID (sets `_deletedAt` timestamp). The filament is hidden from all queries but retained for sync propagation in hybrid mode and recovery via the trash workflow. Returns `{ message: "Deleted" }`.

**Cannot delete a filament that has color variants.** Returns 400: `"Cannot delete a filament that has color variants. Delete the variants first."`.

#### Permanent delete: `DELETE /api/filaments/:id?permanent=true`

Append `?permanent=true` to mark a filament as permanently purged. **Only allowed when the filament is already soft-deleted** (i.e. it lives in the trash). Returns `{ message: "Permanently deleted" }`.

This sets `_purged: true` on the document rather than physically removing the row. The hybrid sync engine (`electron/sync-service.ts`) pairs documents across peers by `syncId` and treats "missing on one side, present on the other" as a fresh insert from the other side — a `deleteOne` would therefore get resurrected from the trashed peer on the next sync. The `_purged` tombstone propagates across peers, hides the row from every UI surface (including the trash listing and restore route), and stays in place so the row never reappears. Tombstones are small and not garbage-collected today.

Refusal cases:
- `400` — filament is not in the trash. Soft-delete it first.
- `400` — the filament is itself a parent and non-purged trashed variants still reference it. Permanently delete those variants first to avoid dangling refs.
- `400` — filament is already purged (idempotent).

### GET /api/filaments/trash

Returns soft-deleted filaments sorted newest first, with a lightweight projection: `_id`, `name`, `vendor`, `type`, `color`, `cost`, `parentId`, `_deletedAt`. Powers the `/trash` UI page. **Excludes** `_purged: true` tombstones — those are kept on disk only for sync propagation and never reappear in any user surface.

```json
[
  {
    "_id": "67abc...",
    "name": "PLA Galaxy Black",
    "vendor": "Prusa",
    "type": "PLA",
    "color": "#1a1a1a",
    "cost": 31.99,
    "parentId": null,
    "_deletedAt": "2026-05-09T18:24:11.123Z"
  }
]
```

### POST /api/filaments/:id/restore

Un-soft-delete a filament — clears `_deletedAt` so the filament reappears in the regular list. Returns `{ message: "Restored", _id: "67abc..." }`.

Refusal:
- `404` — the filament is not in the trash (already active or not found).
- `409` — another active filament has reused the trashed one's name. The partial unique index on `name` only covers non-deleted documents, so restoring would otherwise crash with a Mongo duplicate-key error. Rename one of them first.

```json
{
  "error": "Cannot restore: another active filament named \"PLA Galaxy Black\" already exists. Rename one of them first."
}
```

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

Match an NFC tag's decoded data or a scanned Brother label-printer QR against existing filaments. Used internally by the NFC read workflow and by anything that scans an instance-ID QR back into the app.

- `instanceId` -- exact instance-ID match (highest-confidence; checked first). As of #732 this resolves against **per-spool** `spools[].instanceId` first (exact-case then case-insensitive), returning the matched spool in `matchedSpool`, then falls back to the **filament-level** `instanceId` (transitional). Same value carried on NFC tags and printed by the label-printer dialog's instance-ID QR mode. A case-only collision (legacy data with both `ABC` and `abc` stored) returns both as `candidates` instead of an arbitrary pick. Max length 128; the value is escaped before the case-insensitive regex so regex-special characters in stored IDs are matched literally.
- `name` -- material name (exact match, case-insensitive)
- `vendor` -- brand name (substring match, case-insensitive)
- `type` -- material type (exact match, case-insensitive)

The parameters are checked in priority order: per-spool `instanceId` → filament-level `instanceId` → `name` → `vendor`+`type` → `vendor` only. If `instanceId` misses, the route falls through to the next branch when the relevant params are also supplied, so a label scan against a since-deleted filament can still surface suggestions instead of 404ing.

Returns (`matchedSpool` is the spool whose `instanceId` matched, or `null` when the hit was filament-level or heuristic):
```json
{
  "match": { "_id": "...", "name": "...", "vendor": "...", "type": "...", "color": "..." },
  "matchedSpool": { "_id": "...", "instanceId": "...", "label": "..." },
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

### GET /api/filaments/:id/openprinttag/check

Compares a filament that was imported from the OpenPrintTag community database against the **current** upstream material and returns a field-level changelist. Read-only — nothing is mutated. The link is the `settings.openprinttag_slug` stamped at import time.

Responses:
- `{ "linked": false }` — the filament has no OpenPrintTag slug.
- `{ "linked": true, "found": false, "slug": "…" }` — the slug is no longer in the OpenPrintTag database (renamed/removed upstream).
- `{ "linked": true, "found": true, "slug": "…", "materialName": "…", "changes": [...] }` — an empty `changes` array means the row is already up to date.

Each `changes[]` entry is `{ field, labelKey, current, incoming, kind }`. `kind` is `"adopt"` (the field was unset, still held the gray `#808080` sentinel, or matched the value OpenPrintTag last wrote — safe to take) or `"conflict"` (the local value diverges from what OpenPrintTag last wrote, i.e. you edited it — surfaced but not auto-applied). Only the managed fields are compared (color, secondary colors, density, the OPT-carried temperatures, drying temp/time, Shore D, transmission distance, tags); identity fields (name/vendor/type) and diameter are never re-synced.

### POST /api/filaments/:id/openprinttag/sync

Applies the user-accepted subset of OpenPrintTag updates to a linked filament. Same-origin guarded. Send a JSON body:

```json
{ "fields": ["density", "temperatures.nozzle"] }
```

Only field keys from the managed set are accepted — an unknown key returns 400 rather than being silently dropped. The provenance snapshot (`openprinttagSnapshot`) is refreshed to the full current OpenPrintTag offer on every sync, regardless of which fields were applied, so a later check can still tell "OpenPrintTag changed it" from "you changed it" for the fields you declined.

Responses:
- `{ "applied": ["density", "temperatures.nozzle"], "filament": { … } }` — the fields written + the fresh document.
- `400` — malformed body, an unknown field, a field OpenPrintTag isn't currently offering (re-run the check), or the filament is not OpenPrintTag-linked.
- `404` — the slug is no longer in the OpenPrintTag database.

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

Each emitted section also includes `compatible_printers = ` and `compatible_printers_condition = ` (both empty) by default, which PrusaSlicer treats as "no restriction" — the synced filament shows up in every printer's dropdown, and the scan-stream auto-select works regardless of which printer profile is active. If a user pinned a specific restriction via a previous round-trip import (the keys arrive non-empty in the settings bag), the export preserves that restriction.

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

## OrcaSlicer Profiles

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/filaments/orcaslicer` | Export all filaments as OrcaSlicer-compatible JSON profiles (bundle) |
| `GET` | `/api/filaments/:id/orcaslicer` | Export a single filament as an OrcaSlicer preset (`.json`) |
| `POST` | `/api/filaments/:name-or-id/orcaslicer` | Sync filament settings back from OrcaSlicer |

### GET /api/filaments/orcaslicer

Exports filaments as an array of OrcaSlicer-compatible JSON profiles. Structured DB fields map to OrcaSlicer keys (e.g. `nozzle_temperature`, `hot_plate_temp`, `filament_flow_ratio`) with values wrapped in single-element arrays per OrcaSlicer's multi-extruder convention. Parent/variant inheritance is resolved before export.

Query parameters:
- `type` -- filter by filament type (e.g. `PLA`, `PETG`)
- `vendor` -- filter by vendor name
- `ids` -- comma-separated list of filament IDs

Returns `application/json`: an array of OrcaSlicer profile objects.

### POST /api/filaments/:name-or-id/orcaslicer

Sync filament settings back from OrcaSlicer. The path segment is the URL-encoded filament name OR a 24-char hex ObjectId; the route tries name first and falls back to id.

Request body is a JSON object with any combination of OrcaSlicer keys. Recognised structured keys (`type`, `vendor`, `color`, `density`, `cost`, `diameter`, `maxVolumetricSpeed`, `temperatures`) are written to the corresponding DB fields; any other top-level keys are merged into the `settings` passthrough bag so they round-trip cleanly on the next export.

Returns:
```json
{
  "success": true,
  "filament": "Prusament PLA Galaxy Black",
  "updated": ["temperatures", "density", "settings"],
  "settingsAdded": ["filament_start_gcode"]
}
```

## Bambu Studio Profiles

Bambu Studio is a fork of OrcaSlicer and the two share the filament-preset `.json` schema. Export reuses the OrcaSlicer generator with a single Bambu-specific tweak (`from: "User"` so Bambu Studio files the preset under the user's custom filaments). Import inverts that mapping and adds auto-detect of the printer/nozzle pair from `printer_settings_id`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/filaments/:id/bambustudio` | Download one filament as a Bambu Studio preset (`.json`) |
| `POST` | `/api/filaments/:id/bambustudio` | Sync a Bambu Studio preset INTO this specific filament (pinned by id) |
| `POST` | `/api/filaments/bambustudio`     | Import a Bambu Studio preset by name (upsert) |

### GET /api/filaments/:id/bambustudio

Downloads a single filament as a Bambu Studio filament-preset `.json`. Variants are resolved against their parent before serialisation. No `inherits` base preset is set — the server can't know which system presets the user has installed, so the exported preset is standalone (imports fine via Bambu Studio's custom-filament import; the user just doesn't get system-preset inheritance).

### POST /api/filaments/:id/bambustudio

Sync a Bambu Studio preset INTO the filament identified by `:id`. The parsed `name` from the file is ignored — pinning is by id, so renaming the preset in Bambu Studio doesn't break the link to the app's record. Body is either `multipart/form-data` (file upload, 10 MB cap) or `application/json` with the Bambu profile.

Spool subdocuments, `usageHistory`, and `dryCycles` are NEVER touched on a sync — that's strictly inventory state and isn't in the Bambu file.

### POST /api/filaments/bambustudio

Bulk import. Matches by `filament_settings_id` (preferred — that's what the slicer treats as the preset name) or top-level `name`. Three-phase atomic upsert:

1. Update an existing ACTIVE row with that name.
2. Resurrect a TRASHED (non-purged) row with that name — clears `_deletedAt` in the same atomic write. Without this step, a profile whose name matches a trashed filament would create a duplicate that strands the trashed record.
3. Create new. If a concurrent identical import wins the race (E11000 on the unique-name index), the route re-fetches the racing winner and merges into it — concurrent identical imports are idempotent.

Required fields on create: `filament_type` and `filament_vendor`.

### Calibration auto-detect (both POST routes)

Bambu calibration values (flow ratio, pressure advance, retraction, fan speeds) live IN the filament preset. The route parses `printer_settings_id` (format roughly `"Vendor Model 0.4 nozzle"`), looks up a Printer whose name or `manufacturer + printerModel` matches, and picks the unique installed nozzle at that diameter. When the match succeeds, a `calibrations[]` row is added/updated tagged with `(printer, nozzle)`. When it fails (no printer matches, >1 printer matches, or >1 nozzle at that diameter on the matched printer), the response carries `calibrationUnresolved: true` so the UI can prompt the user to attach manually — the top-level `maxVolumetricSpeed` still lands.

Response:
```json
{
  "created": false,
  "updated": true,
  "filamentId": "...",
  "name": "Generic PLA",
  "calibrationApplied": true,
  "calibrationContext": {
    "printerId": "...",
    "printerName": "Bambu Lab P1S",
    "nozzleId": "...",
    "nozzleDiameter": 0.4
  },
  "settingsAdded": ["overhang_fan_speed", "filament_z_hop"]
}
```

- `updated` -- top-level fields modified on the filament document.
- `settingsAdded` -- unknown keys that were preserved in the `settings` bag.

404 if the filament name / id doesn't resolve; 400 if the body isn't valid JSON.

---

## Scan Stream

Push live NFC tag reads into a long-lived stream so slicers can subscribe and auto-select the matching filament preset. The renderer publishes each scan after it decodes a tag and matches it against the DB; consumers (the PrusaSlicer / OrcaSlicer FilamentDB module, or any other client) subscribe via Server-Sent Events.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/scan/stream` | Subscribe to NFC scans as Server-Sent Events |
| `POST` | `/api/scan/publish` | Publish a decoded scan to subscribers (used by the renderer) |

### GET /api/scan/stream

Server-Sent Events endpoint. The response stays open; each NFC tag read emits one record. Event types:

| `event:` value | When sent | Notes |
|----------------|-----------|-------|
| `replay` | Once, on connect | The most recently published scan, replayed so a slicer opened just after a tag read still picks it up. Skipped if no scan has happened yet this process lifetime. |
| `scan` | Per tag read | A freshly decoded + matched tag. |

Query parameters:
- `replay` -- set to `0` to suppress the on-connect replay (only the prelude + future `scan` events are sent).

Each `data:` payload is the same JSON shape:

```json
{
  "timestamp": 1700000000000,
  "filament": {
    "_id": "65f00000000000000000abcd",
    "name": "Prusament PLA Galaxy Black",
    "vendor": "Prusament",
    "type": "PLA",
    "color": "#000000"
  },
  "candidates": [],
  "decoded": {
    "materialName": "Prusament PLA Galaxy Black",
    "brandName": "Prusament",
    "materialType": "PLA",
    "color": "#000000",
    "spoolUid": "2acc21072a",
    "tagSource": "openprinttag"
  }
}
```

Field notes:
- `filament` is the matched DB row, or `null` when no row matches. Slicers key presets by name and should switch on `filament.name` when non-null.
- `candidates` is a short list of plausible alternatives (vendor + type, then vendor-only) when there is no exact match; empty otherwise.
- `decoded` carries a subset of the tag fields useful to consumers; `tagSource` is `"openprinttag"` or `"bambu"`.

Response headers:
- `content-type: text/event-stream; charset=utf-8`
- `cache-control: no-cache, no-transform`
- `x-accel-buffering: no` (defeats response buffering by nginx-style proxies)

The stream sends a `retry: 5000` prelude (EventSource clients reconnect after 5s on a drop) and a `: hb` heartbeat comment every 25 seconds so idle proxies don't drop the connection. Consumers using libcurl-style HTTP clients must implement their own reconnect loop.

The bus is in-process (Node `EventEmitter` on `globalThis`). "In-process" here means **one Filament DB instance, not one physical machine** — subscribers can be anywhere reachable over HTTP (a Pi running Filament DB can drive PrusaSlicer on a Mac across the LAN; the slicer just connects to `http://<filament-db-host>:3456/api/scan/stream`). What pins to a single machine is the publisher: NFC reads come from the Electron renderer's `NfcProvider`, so the reader must be plugged into whichever box runs the Electron app — a headless Docker / web-only deploy has no `NfcProvider` and never publishes. A horizontally-scaled multi-process deployment would need an external broker behind the bus.

A few network-deploy notes if you go cross-machine: the API is unauthenticated by default (single-user trust model — see the README warning), so be deliberate about which network port 3456 is exposed on. For exposed deployments you can set `FILAMENTDB_API_KEY`, after which every `/api` request — including this SSE stream and the slicer integrations — must send `Authorization: Bearer <key>`; it's a no-op when unset. The Electron-bundled Next.js binds based on the `HOSTNAME` env var; if cross-machine subscribers can't connect, try `HOSTNAME=0.0.0.0`. And because `replay` events carry stale scans across slicer restarts, consumers should filter on `timestamp` if a multi-hour-old tag shouldn't be re-applied.

### POST /api/scan/publish

Used by the renderer's `NfcProvider` to push a scan after the existing `/api/filaments/match` step. Public clients normally don't need to call this directly; it's documented for completeness and for testing the SSE path without a physical reader.

Request body:

```json
{
  "filament": {
    "_id": "65f00000000000000000abcd",
    "name": "Prusament PLA Galaxy Black",
    "vendor": "Prusament",
    "type": "PLA",
    "color": "#000000"
  },
  "candidates": [],
  "decoded": {
    "materialName": "Prusament PLA Galaxy Black",
    "brandName": "Prusament",
    "materialType": "PLA",
    "color": "#000000",
    "spoolUid": "2acc21072a",
    "tagSource": "openprinttag"
  }
}
```

- `filament` -- the matched DB row, or `null` if no row matched.
- `candidates` -- optional array of plausible alternatives in the same shape as `filament`.
- `decoded` -- subset of the decoded tag fields. Unknown `tagSource` values are dropped.

The body is validated against an allow-list — unknown fields are stripped before the event is published, so a malformed POST cannot pollute the replay cache.

Returns `202 Accepted`:

```json
{
  "ok": true,
  "event": { /* the published scan, including the server-assigned timestamp */ }
}
```

400 if the body isn't valid JSON, isn't an object, or contains neither a filament match nor any decoded fields (nothing for a consumer to act on).

---

## NFC Tag Decode

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/nfc/decode` | Decode raw NFC tag bytes server-side and match against the DB |

### POST /api/nfc/decode

Decodes raw NFC tag bytes into a `DecodedOpenPrintTag` and attaches a DB match in one round trip. The mobile scanner app reads the tag bytes on-device, POSTs them here, and renders the result — the decode logic (OpenPrintTag CBOR, Bambu MIFARE Classic with its UID-derived HKDF key) is intricate and, for Bambu, depends on Node crypto that won't run in React Native, so it lives on the server. Keeping it here also means one tested code path shared with the desktop reader instead of a client decoder that drifts.

Like `GET /api/filaments/match`, this route is intentionally **not** behind `assertSameOriginRequest` — it performs no mutation (decode + read-only lookup) and is meant to be reached by the cross-origin mobile app. When `FILAMENTDB_API_KEY` is set, `src/proxy.ts` requires every `/api` caller (this route included) to present `Authorization: Bearer <key>`; that key, not a same-origin check, is what gates off-device access.

Send a JSON body. `tagType` selects the decoder; the byte fields are base64:

```json
{
  "tagType": "openprinttag",
  "payload": "…base64…",
  "tagMemory": "…base64…",
  "blocks": { "1": "…base64…", "2": "…base64…" }
}
```

- `tagType` (required) — `"openprinttag"` or `"bambu"`.
- **OpenPrintTag (ISO 15693 / NFC-V)** — supply **one** of:
  - `payload` — base64 of the NDEF record payload (CBOR). Preferred; iOS Core NFC hands back already-parsed NDEF records.
  - `tagMemory` — base64 of the raw tag memory; the route runs `parseNdefFromTag` to extract the payload.
- **Bambu (MIFARE Classic / ISO 14443-3A)** — `blocks`: an object mapping the absolute MIFARE block number (`0`–`63`, as a string key) to the base64 of that 16-byte plaintext block. At least one readable block is required, and the dump must carry at least one identity block (variant/material id or filament type) — an empty or identity-less block map is rejected as an undecodable read rather than returned as a fabricated all-zero tag.

Matching mirrors the NFC read workflow: the decoded `spoolUid` is tried as an `instanceId` first (an OpenPrintTag written by Filament DB stores the filament's `instanceId` in its `spool_uid` field), then it falls through to `name` → `vendor`+`type` exactly like `GET /api/filaments/match`. Decoded strings are bounded to 128 chars before they feed the regex queries.

Returns `200`:

```json
{
  "decoded": {
    "materialName": "Prusament PLA Galaxy Black",
    "brandName": "Prusament",
    "materialType": "PLA",
    "color": "#000000",
    "spoolUid": "2acc21072a",
    "tagSource": "openprinttag"
  },
  "match": { "_id": "…", "name": "…", "vendor": "…", "type": "…", "color": "…" },
  "matchedSpool": { "_id": "…", "instanceId": "…", "label": "…" },
  "candidates": [],
  "matchedBy": "instanceId"
}
```

- `decoded` — the full `DecodedOpenPrintTag`.
- `match` — the matched DB row, or `null` when nothing matches.
- `matchedSpool` — the spool whose `instanceId` matched the tag (#732), or `null` when the hit was filament-level or heuristic.
- `candidates` — plausible alternatives (vendor+type, then vendor-only) when there's no confident match; empty otherwise.
- `matchedBy` — `"instanceId"` when the tag's `spool_uid` matched a **per-spool** `spools[].instanceId` (`matchedSpool` is set) OR the filament-level `instanceId` (a confident "this exact physical tag is in the DB"), `"heuristic"` when the match came from the weaker name / vendor+type tiers (the scanner should offer "create new" alongside opening the heuristic match), or `null` when there's no match.

Errors:
- `400` — invalid JSON, body not an object, missing byte fields for the chosen `tagType`, or undecodable / wrong-format bytes (`"Could not decode tag"` with the underlying reason).
- `413` — request body larger than the 64 KB ceiling (checked against both the `Content-Length` header and the buffered byte length, so a chunked body can't slip past).
- `415` — `tagType` is neither `"openprinttag"` nor `"bambu"`.

---

## OpenPrintTag Database

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/openprinttag` | Browse the OpenPrintTag community database (FDM filaments only) |
| `POST` | `/api/openprinttag` | Force-refresh the cache and re-fetch from GitHub (same-origin guarded) |
| `POST` | `/api/openprinttag/import` | Import selected materials into Filament DB |

### GET /api/openprinttag

Fetches the [OpenPrintTag community database](https://github.com/OpenPrintTag/openprinttag-database) from GitHub, parses all material YAML files, filters to FFF (FDM) filaments, and returns them with completeness scores. Results are cached for 1 hour.

To force a refresh, POST to the same path — the old `GET ?refresh=true` trigger was removed (a cache-busting side effect on a GET violated REST semantics; GH #427).

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
| `POST` | `/api/nozzles/:id/clone` | Clone a nozzle into a new physical-instance row |

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

### POST /api/nozzles/:id/clone

Clone an existing nozzle into a new row. The clone copies every spec field (diameter, type, high-flow, hardened, notes) under a `Name #N` suffix, with a fresh `_id`. Used by the printer form's move-or-clone conflict resolution when a physical nozzle is already installed in another printer. The clone is **not** auto-attached to any printer — the caller assigns it. Returns the new nozzle with `201`.

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
| `DELETE` | `/api/bed-types/:id` | Soft-delete a bed type (blocked if referenced by a filament calibration, installed on a printer, or named in a filament's per-bed-type temperatures) |

### GET /api/bed-types

Returns an array of bed type documents sorted by name. Supports optional query parameters:

- `material` -- filter by material (e.g., `PEI`, `Glass`)

### POST /api/bed-types

Create a new bed type. Required fields: `name`, `material`.

### PUT /api/bed-types/:id

Update a bed type. Send a JSON body with the fields to update.

### DELETE /api/bed-types/:id

Soft-delete a bed type by ID (sets `_deletedAt` timestamp). Returns `400` when the bed type is still in use — by any active filament's `calibrations[].bedType`, by any printer's `installedBedTypes`, or by name in any active filament's per-bed-type temperature table (`bedTypeTemps[].bedType`); the error message names what's blocking the delete. On success returns `{ message: "Deleted" }`.

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

**SSRF / redirect handling**: the URL fetcher uses the shared `assertExternalUrl` guard (no `file:` / `gopher:` schemes; rejects loopback / RFC1918 / link-local / cloud-metadata IPs). Redirects are followed manually with the same guard re-applied on every hop, capped at 5 redirects — so a public host cannot 30x-redirect into private space (matches the `embed-check` route's pattern). The `tdsUrl` field on `Filament` is also schema-validated to http(s) on both create and every update path.

---

## Setup

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/setup` | Test a MongoDB connection string |

---

## Snapshot

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/snapshot` | Export core app data as a JSON snapshot |
| `POST` | `/api/snapshot` | Restore the database from a JSON snapshot |
| `DELETE` | `/api/snapshot/delete` | Permanently delete all local app data |

### GET /api/snapshot

Downloads a JSON snapshot of core app data: filaments, nozzles, printers, bed types, locations, print history, and shared catalogs (including soft-deleted documents and tombstones). The snapshot preserves `_id` values, timestamps, and references so it can be restored exactly. Snapshot schema version is `4` as of v1.14.0; older v1/v2/v3 snapshots still restore (missing collections come back as empty).

Returns a JSON file with `Content-Disposition: attachment` header.

### POST /api/snapshot

Restore the database from a previously exported snapshot. This is a destructive operation: all existing snapshot-scoped data is replaced with the snapshot contents.

Upload via `multipart/form-data` with a `file` field containing the snapshot JSON, or send the JSON directly as the request body.

The restore uses **best-effort rollback**: if any part of the restore fails, the handler attempts to re-insert the previous data from an in-memory backup. Concurrent restore requests are rejected with 409. Note: the restore is not truly atomic — concurrent readers may observe partial state during the delete/insert window, and if rollback itself fails the database may be left incomplete. For safety, take a backup before restoring.

Returns:
```json
{
  "message": "Snapshot restored successfully",
  "restored": {
    "filaments": 42,
    "nozzles": 5,
    "printers": 2,
    "bedTypes": 3,
    "locations": 4,
    "printHistory": 12,
    "sharedCatalogs": 1
  }
}
```

### DELETE /api/snapshot/delete

Permanently deletes all documents from filaments, nozzles, printers, bed types, locations, print history, and shared catalogs. Returns the count of deleted documents per collection.

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
| `GET`    | `/api/print-history`      | List print jobs (desc by `startedAt`). Query: `filamentId`, `printerId`, `limit` (default 100, max 1000) |
| `POST`   | `/api/print-history`      | Record a print job (see body below) |
| `GET`    | `/api/print-history/{id}` | Fetch one print job with the same populated fields as the list (printer name + per-usage filament name/vendor/type/color). Tombstoned rows return 404 |
| `PUT`    | `/api/print-history/{id}` | Update job metadata only. Accepts five fields: `jobLabel` (trimmed, capped 200), `notes` (truncated to 2000), `source` (enum), `printerId` (or `null`), `startedAt`. **Unknown keys are rejected with 400** (a stray `_purged` or legacy `durationSeconds` doesn't slip through). Usage rows + spool gram totals are NOT mutable here — refund + re-record via DELETE + POST to change a usage |
| `DELETE` | `/api/print-history/{id}` | Undo a print job — refund the spool weight, remove the matching `usageHistory` entries, soft-delete the row |

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

Each spool `usageHistory` entry the POST writes is stamped with `jobId` set to the new PrintHistory `_id`, so a later `DELETE` can match the exact entries to refund.

Response: the created `PrintHistory` document, `201`.

### DELETE /api/print-history/{id}

Undo a job: for every `usage` entry on the record, find the matching spool, refund its `totalWeight` by the recorded grams, and remove the corresponding `usageHistory` entry. Then **soft-delete** the `PrintHistory` document by setting `_deletedAt` (instead of a hard `deleteOne`) so peer sync can propagate the delete via the tombstone — a hard delete would let the other peer push the row back on the next sync cycle.

Refund matching is by `usageHistory.jobId === entry._id` — unambiguous, so a manual usage log that happens to share `(grams, date)` with the job is **not** affected. Legacy entries written before `jobId` existed (pre-v1.12.7) fall back to a `(grams, date, source)` match that's still scoped to `source: "job" | "slicer"`, so manual logs survive that path too.

**Idempotent**: a retry / double-click / client retry after timeout returns `404` instead of refunding spool weight again. The lookup filters on `_deletedAt: null`, so once the row is tombstoned the second call short-circuits before touching anything.

Returns `200 { "message": "Deleted and refunded" }` on first success, `404` on any subsequent call (or if no PrintHistory with that id ever existed).

Best-effort: if a referenced spool has since been deleted (or the filament soft-deleted), that entry is silently skipped — the rest of the refunds still apply and the PrintHistory document is still tombstoned.

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
  "totals": { "grams": 3240, "cost": 82.50, "jobs": 17, "manualEntries": 2 },
  "usageByDay": [{ "date": "2026-03-23", "grams": 0 }, …],
  "byFilament":  [{ "_id": "…", "name": "PLA Black", "vendor": "Vendor A", "cost": 25, "grams": 1200 }, …],
  "byVendor":    [{ "vendor": "Vendor A", "grams": 2100 }, …],
  "byPrinter":   [{ "_id": "…", "name": "Core One", "grams": 1900 }, …]
}
```

`usageHistory` entries are only pulled in when `source === "manual"`. Entries with `source: "job"` or `"slicer"` are owned by a PrintHistory row and already counted in the primary aggregation — including them here would double-count the same grams.

`totals.manualEntries` (added GH #204) counts the manual `usageHistory` rows that contributed to the window — distinguishes inventory drained via PrintHistory jobs from inventory drained via direct spool-UI logs. The renderer surfaces this as a `+N manual` hint under the **Print jobs** stat box when > 0, so a fresh DB with only manual logs no longer shows `0 g · $0 · 0 jobs` despite having recorded usage.

---

## Share (v1.11)

Publishes a static snapshot of selected filaments with their referenced nozzles/printers/bed types, served under a short slug so another user (or another machine) can import the set.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`    | `/api/share`            | List catalogs you've published (newest first; soft-deleted catalogs are hidden) |
| `POST`   | `/api/share`            | Publish a new catalog |
| `GET`    | `/api/share/:slug`      | Public fetch. Atomically increments `viewCount`. Returns 404 when soft-deleted, 410 when expired. |
| `DELETE` | `/api/share/:slug`      | Unpublish (soft-delete) |

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

Response includes `viewCount` (incremented atomically via `$inc`) and the full denormalised payload. Use this as the source of truth for importing on the destination side. The query filters on `_deletedAt: null`, so unpublished slugs return 404.

### DELETE /api/share/:slug

Soft-deletes the catalog by setting `_deletedAt` (instead of `deleteOne`). The slug returns 404 from the public GET immediately. The row remains in the collection so peer sync can carry the unpublish across as a tombstone — a hard delete would let the other peer push the still-active copy back on the next cycle.

The slug index is **partial-unique on `_deletedAt: null`** (auto-migrated from the legacy plain-unique index by `SharedCatalog.syncIndexes()` in the dbConnect migration block), so a slug used by a tombstoned row can be reused by a future republish without tripping E11000.

Returns `200 { "message": "Unpublished" }` on first success, `404` on any subsequent call.

#### SharedCatalog schema additions (v1.13)

The model gained two fields to support sync-safe deletion:

- `_deletedAt: Date | null` — soft-delete tombstone, default `null`. Filtered out by GET endpoints.
- `syncId: string | null` — unique-sparse stable cross-DB identifier, auto-assigned by the sync engine.

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

Accepts any of:
- `Content-Type: text/csv` with the raw CSV body
- `Content-Type: application/json` with `{ "csv": "…" }`
- `Content-Type: multipart/form-data` with the CSV as a `file` field

### Required columns

- `filament` — matched to `Filament.name`; `vendor` disambiguates duplicates
- `totalWeight` — non-negative grams

### Optional columns

- `vendor`, `label`, `lotNumber`, `purchaseDate` (ISO), `openedDate`, `location` (name — auto-created if it doesn't already exist)
- `spoolId` — when it matches an existing spool's subdoc `_id`, that spool is **updated in place** instead of a new one being appended, so an export → re-import round-trip is idempotent (GH #159).
- `instanceId` — the per-spool instance ID (#732). Honored **on CREATE only** (validated for charset/length and uniqueness-checked against other spools, other filaments' top-level ids, and other rows in the same CSV; auto-generated when absent). On the UPDATE path (a matching `spoolId`) the column is informational and the spool keeps its id.

Each row is processed independently; per-row errors are reported in the response without aborting the batch. `created`/`updated` break down the successes (`imported` = their sum) and each ok row carries its `action`:

```json
{
  "imported": 12,
  "created": 9,
  "updated": 3,
  "failed": 2,
  "results": [
    { "row": 2, "ok": true, "action": "created", "filament": "PLA Black" },
    { "row": 3, "ok": false, "error": "No filament named \"Unknown\"" }
  ]
}
```

A single request is capped at 10,000 rows by `parseCsv`; beyond that the request is rejected with 400.

### GET /api/spools/export-csv

Mirror of `GET /api/filaments/export-csv` for spool inventory. Streams every spool from every active filament as a single CSV with one row per spool. Round-trippable leading columns (`filament`, `vendor`, `label`, `totalWeight`, `lotNumber`, `purchaseDate`, `openedDate`, `location`) match `POST /api/spools/import`; trailing context columns include `type`, `color`, `spoolWeight`, `netFilamentWeight`, `retired`, `dryCyclesCount`, `lastDriedAt`, `usedGrams`, `createdAt`, the per-spool `instanceId` (#732), `filamentId`, `spoolId`, and `Parent` / `Variant Count`. Only **soft-deleted filaments** are excluded; **retired spools ARE included** and carry `retired: true`. Suitable for round-tripping through `POST /api/spools/import` when migrating between instances.

Response headers: `Content-Type: text/csv` and `Content-Disposition: attachment; filename="spools.csv"`.

---

## Spool Printer-Slot Assignment

Tracks which printer AMS/MMU slot a spool currently occupies. This is **distinct from** the spool's Location (`locationId`): the Location is the spool's semi-permanent storage "home"; the slot is its transient position while loaded in a printer. A spool can occupy at most one slot at a time.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/spools/:spoolId/assignment` | Get the spool's current printer-slot assignment |
| `PUT` | `/api/spools/:spoolId/assignment` | Assign the spool to a printer slot |
| `DELETE` | `/api/spools/:spoolId/assignment` | Clear the spool from any slot |

These endpoints write only `Printer.amsSlots[].spoolId`; they never modify the spool's `locationId`.

### GET /api/spools/:spoolId/assignment

Returns `{ "assignment": … }`, where `assignment` is `null` when the spool is in no slot, otherwise the printer + slot holding it:

```json
{
  "assignment": {
    "printerId": "…",
    "printerName": "Bambu Labs H2D",
    "slotId": "…",
    "slotName": "AMS Slot 1",
    "filamentId": "…"
  }
}
```

### PUT /api/spools/:spoolId/assignment

Body: `{ "printerId": "…", "slotId": "…" }`. Assigns the spool to that slot, first clearing it from any other slot it occupied — a spool is one physical object. Returns the fresh `{ "assignment": … }`.

- `400` — malformed body, or the spool is retired (retired spools cannot be loaded into a printer)
- `404` — the spool, printer, or slot does not exist

### DELETE /api/spools/:spoolId/assignment

Clears the spool from whatever slot it is in. Idempotent — returns `{ "assignment": null }` even when the spool was already unassigned.

> **Hybrid-sync limitation:** `Printer.amsSlots[].spoolId` is cleared on cross-side sync remap (spool subdocuments have no stable cross-side id). Slot assignments are reliable only in single-database (cloud-only or offline-only) deployments.

---

## Internal helper endpoints

These endpoints back specific pages in the first-party UI. Shapes are tuned for those pages and may change without notice across minor releases — external consumers should use the documented public APIs above instead.

### GET /api/dashboard (v1.11)

Aggregate summary for the dashboard page — counts, total remaining grams, low-stock filaments, spools due for a dry cycle, and the 10 most recent print-history entries — computed server-side in a single round trip.

Returns:
```json
{
  "counts": {
    "filaments": 48,
    "nozzles": 3,
    "printers": 2,
    "bedTypes": 4,
    "spools": 62,
    "retiredSpools": 5
  },
  "totalGrams": 38250,
  "lowStock": [
    { "_id": "…", "name": "PETG Black", "vendor": "…", "color": "#000", "remainingGrams": 120, "threshold": 500 }
  ],
  "dryDue": [
    { "filamentId": "…", "filamentName": "Nylon X", "spoolId": "…", "spoolLabel": "Spool #2", "lastDried": "2025-12-01T…" }
  ],
  "recentPrintHistory": [
    { "_id": "…", "jobLabel": "Benchy", "printerName": "MK4", "startedAt": "…", "source": "manual", "totalGrams": 12.4 }
  ]
}
```

`dryDue` is capped at 20 entries and only includes spools where the filament has a `dryingTemperature` set AND no dry cycle in the last 30 days.

### GET /api/filaments/compare?ids=a,b,c (v1.11)

Fetch multiple filaments for the comparison view in one round trip. `ids` is a comma-separated list (minimum 1, maximum 8). Returns filaments in the same order as the `ids` list, with `compatibleNozzles` and `calibrations.{nozzle,printer,bedType}` populated so the UI can render names directly.

`400` if `ids` is missing, empty, or over 8.

### GET /api/spools/by-location (v1.32)

Backs the **Inventory** page (`/inventory`). Single-shot aggregation over the filament collection's `spools[]` subdocuments, grouped by `spools[].locationId`. A self-`$lookup` on `parentId` surfaces the parent's `spoolWeight` / `netFilamentWeight` so the client can compute remaining-percent on a variant row without a second fetch.

Query parameters:

| Param | Description |
|-------|-------------|
| `kind` | Filter to a single location kind (`shelf`, `drybox`, `printer`, …). |
| `type` | Filter to a single filament type (`PLA`, `PETG`, …). |
| `vendor` | Filter to a single vendor (exact match). |
| `includeRetired` | `1` to include retired spools (default: excluded — they're out of inventory). |

A synthetic group with `locationId: null` carries any spool whose `locationId` is unset. The aggregation sorts it to the END of the response so the page surfaces it as a "needs attention" trailer rather than as the first bucket.

Response shape:

```json
{
  "groups": [
    {
      "locationId": "…",
      "location": { "_id": "…", "name": "Drybox A", "kind": "drybox", "humidity": 20, "notes": "" },
      "spools": [
        {
          "_id": "…",
          "label": "",
          "totalWeight": 850,
          "lotNumber": null,
          "purchaseDate": "2026-03-12T00:00:00.000Z",
          "openedDate": null,
          "retired": false,
          "photoDataUrl": null,
          "dryCycleCount": 2,
          "lastDryAt": "2026-05-10T14:22:00.000Z",
          "filamentId": "…",
          "filamentName": "Galaxy Black PLA",
          "filamentVendor": "Sunlu",
          "filamentType": "PLA",
          "filamentColor": "#000000",
          "spoolWeight": null,
          "netFilamentWeight": null,
          "parentSpoolWeight": 250,
          "parentNetFilamentWeight": 1000
        }
      ],
      "count": 1,
      "totalGrams": 850
    }
  ],
  "totalSpools": 1
}
```

`totalSpools` is the sum of each group's `count` so the page header can show one number without re-summing on the client.

Soft-deleted filaments and their spools are excluded from the aggregation regardless of `includeRetired`.

### GET /api/embed-check?url=…

Probe whether a remote URL can be rendered inside an `<iframe>`. Used by the filament detail page to gracefully fall back to "open in new tab" when the source site sets `X-Frame-Options: DENY|SAMEORIGIN` or a restrictive `Content-Security-Policy: frame-ancestors`.

The URL goes through the shared SSRF guard (loopback / RFC1918 / cloud metadata IPs blocked, http(s) only). Redirects are followed manually with the same guard re-applied on every hop, so a public host that 30x-redirects into private space is rejected. Capped at 5 redirects and an 8-second timeout.

Response shape:
```json
{ "embeddable": true, "contentType": "text/html; charset=utf-8" }
```
or:
```json
{ "embeddable": false, "reason": "X-Frame-Options: deny", "contentType": "text/html" }
```

Network failures collapse to `{ embeddable: false, reason: <message> }` rather than a 5xx — the UI shows the same fallback either way.

### GET /api/openapi

Returns the OpenAPI 3.0 spec document used by the in-app Swagger UI. Version is injected dynamically from `package.json` so external consumers can verify the spec matches the running build.
