---
name: add-filament
description: >
  Add a filament or spool to the user's Filament DB through its REST API — creating it as a
  colour variant of an existing product line when one exists, enriching it from the vendor's
  own published data and from OpenPrintTag, and always registering the physical spool. Use
  this skill whenever the user wants to add, register, log, record, or enter a filament,
  spool, or roll: "I bought some Prusament PETG", "new spool of Overture PLA in cobalt",
  "add this filament", "just got a roll of PA6-CF", "put this on the shelf". Also use it when
  they want a new colour variant of a filament they already have, when they have scanned an
  NFC tag or QR code for something not yet in the database, and when they are entering
  several new spools at once.
---

# Adding a filament to Filament DB

The API is at `http://localhost:3456` by default (override with `FILAMENTDB_URL`). If the
instance sets `FILAMENTDB_API_KEY`, every request needs `Authorization: Bearer <key>` —
the gate has no same-origin exemption.

Start with `curl -s -o /dev/null -w "%{http_code}" $BASE/api/filaments`. A connection error
means the app is not running: say so and stop rather than guessing at the data.

The companion `3d-printing-knowledge-base` skill is the **read** path and is deliberately
read-only. This skill is the **write** path. Its sourcing discipline still applies here: a
processing parameter you did not retrieve from a real source does not go in the database.

## The one thing to understand before writing anything

A filament with variants is a **template**. It is an abstract product line: it carries the
shared spec (temperatures, drying, density, tare weight, net weight) and deliberately holds
**no colour and no inventory**. Each colour is a variant that stores its own colour and its
own spools, and leaves every shared field `null` so it resolves from the template at read
time.

That inheritance is live, not a copy. So the single most common way to damage this database
is to fill a variant's fields in with values copied from its parent — it looks identical on
screen, and then the template is edited a year later and the variant silently doesn't follow.

**Leave inheritable fields null on the variant. That is the feature, not an omission.**

What legitimately belongs on the variant: `name`, `color`, `colorName`, and its spools.
Everything else belongs on the template unless this colour genuinely differs.

## Workflow

### 1. Identify what is being added

You need vendor, product line, colour, and material type. Ask for whatever is missing rather
than inferring — "Prusament PETG orange" is three facts, "some orange PETG" is one.

If the user scanned a tag, the decoded payload gives you most of this already.

### 2. Find the family

```bash
curl -s "$BASE/api/filaments" | jq -r '.[] | "\(.name)\t\(.vendor)\t\(.type)\t\(.parentId // "root")\t\(.hasVariants)"'
```

Three cases, and they lead to different work:

**A template already exists** (`hasVariants: true`, name matches the product line) — create a
variant under it. This is the good case: the variant inherits everything and you only need
the colour.

**A single filament exists for this product line but has no variants** — adding a second
colour turns it into a template. The server gates this: your create returns **409
`parent_promotion_required`**. That is not an error, it is a confirmation request. Show the
user what will happen (the existing filament's colour and spools move onto a new sibling
variant, the parent becomes a colourless template) and repeat the identical request with
`"promoteParent": true` added. Never send that flag without asking — it restructures a second
record.

**Nothing exists** — create a standalone filament. Do not invent a template for a single
colour; the model derives template-ness from having variants, so it happens on its own when
the second colour arrives.

### 3. Gather the values, in strict source order

**Vendor first.** The manufacturer's own published figures beat everything else. Several
vendors publish exact hex codes, and usually a HueForge TD value beside them worth taking for
`transmissionDistance`. See `references/sources.md` for the ones already known to work and how
to extract them.

Do not conclude a vendor publishes nothing just because the product page is bare — the tables
are often a blog post or a linked spreadsheet away, and a mention of HueForge anywhere on the
site is a strong signal one exists. That search is worth the minute it costs: for one line it
corrected nine of ten colours that had come from OpenPrintTag.

**OpenPrintTag second**, and treat it as community data rather than truth. It is genuinely
useful for colour, and it is the linkage that lets the record pull future updates. But it is
measurably wrong sometimes: in one audit of 27 linked filaments, four of the vendor-published
colours disagreed with OPT and the user's existing values were the correct ones. If OPT and
the vendor disagree, the vendor wins and it is worth telling the user.

**Ask third.** If neither source has a number, ask. A plausible-looking invented temperature
is worse than a blank field, because a blank field is visibly missing.

Never carry a CSS colour name into the database as a placeholder. `#ff0000` for "red" and
`#FF00FF` for "magenta" are how the library fills up with values that look real and aren't.
If you don't have the vendor's hex, leave the colour for the user to supply.

### 4. Link to OpenPrintTag

Search the catalogue and link if there is a genuine match:

```bash
curl -s "$BASE/api/openprinttag" | jq '[.materials[] | select(.brandSlug=="...")]'
curl -s -X POST "$BASE/api/filaments/$ID/openprinttag/link" -H 'Content-Type: application/json' -d '{"slug":"..."}'
```

Two rules that matter:

**Link only colour-level records, never a template.** Every OPT entry is one colour, so
linking a product line pins one colour's provenance onto the whole family.

**The link route is safe; the import route is not.** `openprinttag/link` writes only the slug,
uuid and provenance snapshot — never a field value — so it cannot damage anything. By
contrast `POST /api/openprinttag/import` with a `parentId` *does* write values, and if the OPT
entry is well-populated it will pin its temperatures onto the variant as local overrides,
severing the inheritance you just set up. Import is only safe when the entry is a stub
(`completenessTier: "stub"`, colour and nothing else) — check before using it, or use link
plus your own values instead.

Match on brand **and** colour, not name similarity. Name-similarity scoring reliably proposes
`overture-petg-green` for "Overture PETG Grey" and matches product lines to whichever colour
happens to sort first.

### 5. Create the record

```bash
curl -s -X POST "$BASE/api/filaments" -H 'Content-Type: application/json' -d '{
  "name": "Prusament PETG Prusa Orange",
  "vendor": "Prusament",
  "type": "PETG",
  "color": "#EB5403",
  "colorName": "Prusa Orange",
  "parentId": "<template id, omit for a standalone>"
}'
```

`name`, `vendor`, and `type` are required. For a variant, send nothing else unless this
colour genuinely differs from the family.

Match the family's existing naming convention rather than imposing one — look at the siblings
first. Renaming later is disruptive because slicers key their presets on the filament name.

Use the vendor spelling the rest of the library uses for that brand, so filters and grouping
don't fragment across `3D Fuel` / `3D-Fuel`.

### 6. Weights, then the spool

Adding a filament always means a physical roll arrived, so the record is not finished until it
has a spool.

Three weights, and they are easy to confuse:

| Field | Lives on | Meaning |
|---|---|---|
| `spoolWeight` | template | tare — the empty spool |
| `netFilamentWeight` | template | nominal filament content, e.g. 1000 g |
| `totalWeight` | **spool** | gross weight of this roll right now, tare included |

The first two are shared product spec and belong on the template. Take them from an existing
variant or the template itself before asking — the family almost always already knows. Only
if the family has neither, ask the user to weigh the roll, and be specific about wanting the
gross weight with the spool on the scale.

The remaining-percentage bar needs `netFilamentWeight` as its denominator, so a family missing
it shows no bar at all. Worth filling in if you notice it absent.

```bash
curl -s -X POST "$BASE/api/filaments/$ID/spools?shape=spool" -H 'Content-Type: application/json' \
  -d '{"totalWeight": 1186, "label": "", "purchaseDate": "2026-08-29"}'
```

The server mints an `instanceId` for the spool — a durable identity that printed QR labels and
NFC tags resolve against. Let it generate one. Only pass an explicit `instanceId` when moving
a spool between records and preserving its printed identity, and note the uniqueness check
ignores trashed rows, so a colliding id may need the old record trashing first.

### 7. Verify against the resolved record

Read the record back **without** `?raw=true`. Raw shows stored values, where a variant's
inherited fields are `null` and look alarming; the plain read shows what the app and the
slicer actually see.

```bash
curl -s "$BASE/api/filaments/$ID" | jq '{name, color, temperatures, density, spools: [.spools[] | {instanceId, totalWeight}]}'
```

Confirm the temperatures resolved from the template, and that the spool exists. Then tell the
user what was inherited versus stored — that distinction is the thing they can't see and will
want to know.

## Traps worth knowing before you hit them

**Write temperatures as dotted paths.** `PUT /api/filaments/{id}` passes the body straight to
`findOneAndUpdate`, so a nested `{"temperatures": {"nozzle": 250}}` **replaces the whole
subdocument** and silently destroys `bed`, the range fields and the first-layer values. Send
`{"temperatures.nozzle": 250}` instead. The same applies to `settings.<key>`.

**Templates reject colour and inventory silently.** Writing `color`, `colorName`,
`totalWeight` or `lowStockThreshold` to a template strips those fields rather than erroring —
by design, so a slicer echoing stale values can't break the sync. If a colour you set doesn't
appear, check whether you wrote it to the template.

**`compatibleNozzles` and `calibrations` are whole-array fallback.** A variant with an empty
array inherits the template's; a non-empty one overrides completely. Set nozzle compatibility
on the template so every colour gets it.

**Nozzle compatibility has physical consequences.** Abrasive filaments — anything CF, GF,
metal-filled, glow, or flagged `filament_abrasive: "1"` — need hardened nozzles and will
destroy a brass or nitrided one. Foaming grades and some flexibles are incompatible with
high-flow nozzles. Follow whatever rule the user's existing records already express rather
than assuming.

**Dates are validated but Mongoose would roll them over.** `2026-02-30` becomes March 2nd if
it reaches the driver. The routes guard this, so a 400 on a date is real.

More detail on API shapes, error codes and vendor sources is in `references/`. Read
`references/api-contracts.md` when a call returns something unexpected, and
`references/sources.md` when you need a vendor's published figures.
