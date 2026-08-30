# Filament DB API contracts for the add path

Base `http://localhost:3456` unless `FILAMENTDB_URL` says otherwise. Add
`Authorization: Bearer $FILAMENTDB_API_KEY` when that variable is set.

Mutating routes carry a same-origin guard that rejects browser cross-origin requests. `curl`
sends neither `Origin` nor `Sec-Fetch-Site`, so it passes — a 403 from `curl` means something
else is wrong.

## Reads used while adding

| Call | Purpose |
|---|---|
| `GET /api/filaments` | List. Carries `hasVariants`, `parentId`, `hasCalibrations`. Temperatures are already resolved. |
| `GET /api/filaments/{id}` | **Resolved** record — what the app and slicer see. Use this to verify. |
| `GET /api/filaments/{id}?raw=true` | **Stored** record. Inherited fields read `null`. Use to check what a record actually owns; carries `_parent` and `_variants`. |
| `GET /api/filaments/colors` | Distinct `{name, hex}` pairs already in use — good for matching an existing colour convention. |
| `GET /api/openprinttag` | Whole OPT catalogue (~14k entries, several MB, cached an hour). Fetch to a file and filter locally rather than into context. |
| `GET /api/nozzles`, `/api/printers`, `/api/bed-types` | Reference data for compatibility. |
| `GET /api/spools/next-label` | `{next, max}` — suggested next numeric roll label. Suggestion only; reserves nothing. |

`_inherited` appears **only on the resolved read** — `?raw=true` skips `resolveFilament`, so
it never produces that field. It is the quickest way to confirm a variant is inheriting rather
than storing its own copies, but you have to ask for the resolved shape to get it.

## Creating a filament

`POST /api/filaments` — required `name`, `vendor`, `type`.

```json
{ "name": "Overture PETG Cobalt", "vendor": "Overture", "type": "PETG",
  "color": "#0e21ae", "colorName": "Cobalt", "parentId": "<template id>" }
```

Responses:

- **201** created.
- **400** validation. The message names the field.
- **409 duplicate name.** Names are unique among non-deleted rows, so a trashed record can
  hold the name you want; check the trash before renaming around it.
- **409 `parent_promotion_required`.** This create would produce the first variant of a parent
  that still holds a colour or inventory. Body carries the parent's state. Confirm with the
  user, then repeat the identical request plus `"promoteParent": true`. The server then moves
  the parent's colour, colourName, weight and spools onto a new sibling variant and clears the
  parent. Declining writes nothing.

## Creating a spool

`POST /api/filaments/{id}/spools` — needs at least one meaningful field; `totalWeight` is the
natural one. An empty body is refused so a stray call can't mint a phantom 0 g spool.

```json
{ "totalWeight": 1186, "label": "", "purchaseDate": "2026-08-29", "locationId": null }
```

`totalWeight` is **gross** — filament plus spool. Append `?shape=spool` to get just the created
spool back instead of the whole filament document with every sibling's photo blob.

**409 "That spool ID is already used"** when passing an explicit `instanceId`. Uniqueness is
checked against other spools' ids and other filaments' top-level ids, filtered to
non-deleted rows — so trashing the holder frees the id.

A template refuses spools with **400 `template_no_spools`**: inventory belongs on variants.

## Updating

`PUT /api/filaments/{id}`. The body goes to `findOneAndUpdate` essentially verbatim, which
drives two rules:

**Dotted paths for anything nested.** `{"temperatures.nozzle": 250}`, not
`{"temperatures": {...}}` — the nested form replaces the entire subdocument and wipes the
siblings. Same for `settings.<key>`. Settings are a flat bag; nested paths are rejected.

**Explicit `null` clears a field.** That is how you make a variant inherit again — clear its
own value rather than trying to match the parent's.

Writing `color`, `colorName`, `totalWeight` or `lowStockThreshold` to a **template** strips
them silently and reports `_strippedTemplateFields` in the response. An explicit `null` does
pass through, which is how a legacy template gets cleaned up.

## OpenPrintTag

`POST /api/filaments/{id}/openprinttag/link` with `{"slug": "..."}` — writes only
`settings.openprinttag_slug`, `openprinttag_uuid`, and the `openprinttagSnapshot`, never a
field value. Safe on a **standalone or a variant**; not on a template. An OPT entry is one
colour, so linking a product line attaches that colour's provenance to the whole family, and a
later check/sync can then write managed fields such as `transmissionDistance` and `optTags`
onto the template, which every unoverridden variant inherits. `DELETE` on the same route removes the linkage.

`GET /api/filaments/{id}/openprinttag/check` — diffs the record against upstream. Fields
matching the snapshot classify as `adopt`; fields the user has changed classify as `conflict`
and are not auto-applied. A clean result (`changes: []`) means the link is healthy.

`POST /api/openprinttag/import` with `{"slugs":["..."], "parentId":"..."}` **does write field
values**. It prunes values equal to the parent's effective value, so anything that
differs survives and becomes a local override, severing inheritance. **Do not gate this on
`completenessTier`** — "stub" spans scores 0 to 3, so a stub can still carry density and print
temperatures. Inspect the mapped fields themselves and prefer link-plus-your-own-values
whenever anything beyond colour is populated. Single slug only in variant mode; a name
collision returns 409 without mutating anything.

## Deleting

`DELETE /api/filaments/{id}` soft-deletes to the trash. `?permanent=true` purges, and requires
the record to already be in the trash. Purges leave a `_purged` tombstone that propagates as
permanently-deleted to sync peers.

Referential guards refuse deletes rather than leaving dangling refs: a nozzle referenced by any
filament's ticks **or calibrations** cannot be deleted, and the check counts trashed filaments
(only `_purged` ones are ignored). The error names the count.

## Error shapes worth recognising

| Status / code | Meaning |
|---|---|
| 409 `parent_promotion_required` | Confirm, then retry with `promoteParent: true`. |
| 409 `parent_must_be_template_first` | A trash restore would create a first variant. Not retryable — the user converts the parent via `POST /api/filaments/{id}/promote`. |
| 409 `name_taken` / duplicate key | Name collision among live rows. |
| 400 `template_no_spools` | Inventory attempted on a template. |
| 400 invalid shape | `?shape=` given something other than `spool`. |
