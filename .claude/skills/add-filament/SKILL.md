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

Set these up first — every command below uses them, and `$BASE` is empty until you do:

```bash
BASE="${FILAMENTDB_URL:-http://localhost:3456}"
AUTH=(); [ -n "${FILAMENTDB_API_KEY:-}" ] && AUTH=(-H "Authorization: Bearer $FILAMENTDB_API_KEY")
curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}\n' "$BASE/api/filaments"
```

Expect `200`. A connection error means the app is not running: say so and stop rather than
guessing at the data. A `401` means the instance sets `FILAMENTDB_API_KEY` — the gate has no
same-origin exemption, so ask for the key and export it before retrying. A `403` is *not* that
gate, which only ever answers 401: look to the same-origin request guard or a reverse proxy,
and do not loop asking for a key that cannot help. Pass `"${AUTH[@]}"`
on every later call; the examples below omit it only to stay readable.

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
curl -s "$BASE/api/filaments" | jq -r '.[] | "\(._id)\t\(.name)\t\(.vendor)\t\(.type)\t\(.parentId // "root")\t\(.hasVariants)"'
```

Assign the `_id` of whatever you match — every later step addresses the family through it:

```bash
TEMPLATE_ID=<the _id from the row you matched, or its parentId if that row is a variant>
```

It becomes `parentId` on the create, and the target for filling in family weights, for the
post-promotion cleanup in step 5a, and for the OpenPrintTag relink. Set it here rather than
carrying the value in your head; a step that interpolates an unset variable builds a URL like
`/api/filaments//spools`, which fails in a way that does not name the cause.

`parentId` is `root` for a template and a standalone alike, so it cannot identify the record
for you.

**First, check whether this exact colour is already there.** The headline rule of this skill is
that a filament being added is always a new physical roll, and a roll of a colour already in the
library needs no new record at all — only a spool. Match on vendor + name + colour, across
variants as well as roots.

If it exists, that record is `$ID` and you are done with steps 3 to 6: go straight to step 7 and
register the spool. Creating anyway is not a harmless duplicate — the unique-name index returns
a 409 and the roll never gets recorded, or, if your generated name differs by a word, you
silently end up with two records for one colour and a promotion that should not have happened.

```bash
ID=<the _id of the matching colour>
# If that row is a VARIANT, the family is its PARENT, not itself.
TEMPLATE_ID=<its parentId, or its own _id when parentId is "root">
```

Getting that second line wrong is quiet and durable: step 7 fills in missing family weights on
`$TEMPLATE_ID`, so pointing it at the variant pins overrides on one colour while the template
and every other colour stay incomplete — and the bar those weights drive keeps reading empty
everywhere else.

Only when the colour is genuinely new do the three cases below apply:

**A template already exists** (`hasVariants: true`, name matches the product line) — create a
variant under it. This is the good case: the variant inherits everything and you only need
the colour.

**A single filament exists for this product line but has no variants** — adding a second
colour turns it into a template. The server gates this: your create returns **409
`parent_promotion_required`**. That is not an error, it is a confirmation request. Show the
user what will happen (the existing filament's colour and spools move onto a new sibling
variant, the parent becomes a colourless template) and repeat the identical request with
`"promoteParent": true` added. Never send that flag without asking — it restructures a second
record. When you take this path, **step 5a is not optional** — promotion strands the old
colour's tags, TD and OpenPrintTag link on the new template, where your new colour inherits
them.

Worth doing first: if that existing filament has a colour but no `colorName`, set one before
triggering the gate. The promoted variant is auto-named `"<parent> — <colorName>"`, falling
back to `"— Original"` when the field is blank, so one word turns a meaningless name into the
right one.

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

**When a vendor publishes a range, let the library pick the value.** A spec of "250–270 °C
nozzle, 80–100 °C bed" still needs one number in each field. Before reaching for the midpoint,
look for a same-material record with the same published range and see what the user actually
runs — in one case an existing PC with an identical 250–270 window was set to 260/100, which
is a far better answer than arithmetic because it reflects their hardware and habits. Store
the range in `nozzleRangeMin`/`Max` as well, so the guardrails survive.

**A record's own process values can expose a wrong vendor.** One filament filed under one
manufacturer turned out to carry temperatures, max volumetric speed and shrinkage that exactly
matched another maker's bench profile — the data identified the real product before anyone
noticed the label was wrong. When a vendor lookup keeps coming up empty, or the numbers feel
familiar, check them against the profiles you already have.

**Ask third.** If neither source has a number, ask. A plausible-looking invented temperature
is worse than a blank field, because a blank field is visibly missing.

Never carry a CSS colour name into the database as a placeholder. `#ff0000` for "red" and
`#FF00FF` for "magenta" are how the library fills up with values that look real and aren't.
If you don't have the vendor's hex, leave the colour for the user to supply.

### 4. Find the OpenPrintTag match (but don't link yet)

Search the catalogue now, so anything it offers can inform the create — but the link itself
needs the new record's id, so it happens in step 6, after the create.

```bash
curl -s "$BASE/api/openprinttag" -o /tmp/opt.json      # ~14k entries, several MB
jq '[.materials[] | select(.brandSlug=="...")]' /tmp/opt.json
```

Match on brand **and** colour, not name similarity. Name-similarity scoring reliably proposes
`overture-petg-green` for "Overture PETG Grey" and matches product lines to whichever colour
happens to sort first.

**Link only colour-level records, never a template.** Every OPT entry is one colour, so
linking a product line pins one colour's provenance onto the whole family — and a later
check/sync can then write managed fields onto the template that every unoverridden variant
inherits.

**The link route is safe on a colour record; the import route is not.** `openprinttag/link`
writes only the slug, uuid and provenance snapshot, never a field value. By contrast
`POST /api/openprinttag/import` with a `parentId` *does* write values, and anything that
differs from the parent survives pruning and becomes a local override, severing the
inheritance you just set up.

Do not use `completenessTier` as the safety check. "stub" covers every score from 0 to 3, so a
stub can still carry density and print temperatures. **Inspect the mapped fields themselves** —
if anything beyond colour is populated, prefer link plus your own values over import.

### 5. Create the record

Capture the new `_id` — the link, the spool and the verification all need it.

A **variant** carries only what is its own. No temperatures — sending a range that merely
equals the family's still pins it as an override that stops following later template edits,
which is the central rule of this skill breaking in its own worked example:

```bash
PAYLOAD='{"name":"Prusament PETG Prusa Orange","vendor":"Prusament","type":"PETG",
  "color":"#EB5403","colorName":"Prusa Orange","transmissionDistance":6.2,
  "parentId":"'"$TEMPLATE_ID"'"}'
```

A **standalone** has no template to inherit from, so the shared spec goes here — nested on
create, and note the weights, which nothing else will supply:

```bash
PAYLOAD='{"name":"PRILINE PC-CF","vendor":"PRILINE","type":"PC-CF",
  "color":"#000000","colorName":"Black",
  "temperatures":{"nozzle":260,"nozzleRangeMin":250,"nozzleRangeMax":270,"bed":100},
  "spoolWeight":147,"netFilamentWeight":1000,"dryingTemperature":90,"dryingTime":480}'
```

```bash
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/filaments" \
  -H 'Content-Type: application/json' -d "$PAYLOAD")
CODE=$(printf '%s' "$RESP" | tail -n1); BODY=$(printf '%s' "$RESP" | sed '$d')
```

Check `$CODE` before going further. **201** — take the id with
`ID=$(printf '%s' "$BODY" | jq -r '.filament._id // ._id')`. **409** — `$BODY` carries either
the promotion gate (confirm, then retry with `promoteParent: true`, then run step 5a) or a
name collision.
Anything else is a validation error naming its field. Extracting the id first instead turns a
409 into the string `null` and every later call targets `/null`, silently, while the parent
state you needed for the confirmation is gone.

`name`, `vendor`, and `type` are required. For a variant, send nothing else unless this
colour genuinely differs from the family.

**`optTags` is the exception that catches people out.** If this colour has a property its
siblings do not — glow, transparent, translucent, silk, sparkle, a colour-changing pigment —
it needs its own array, and it will not get one by accident: an omitted `optTags` inherits the
family's, and the OpenPrintTag link in step 6 writes no field values at all. A glow colour
added to an ordinary line and left with no tags is not marked abrasive, so nothing stops it
being offered on a soft nozzle. Glow, metal-fill and stone-fill pigments are abrasive; include
`4` alongside the appearance tag when the pigment is what makes it so.

Send **its own tags plus a copy of the family's effective tags**, for the same reason the
promotion cleanup does (step 5a): the array replaces rather than merges, so anything you leave
out is gone for this colour. A glow colour joining a PLA line tagged `[33]` hygroscopic is
`[24, 4, 33]`, not `[24, 4]` — read the family's effective tags off the template first.

When the colour is unremarkable, omit `optTags` entirely and let it inherit. An array that
merely repeats the family's pins a copy that stops tracking the template.

Two shapes that are easy to get wrong. **The nozzle range lives under `temperatures`** — a
top-level `nozzleRangeMin` is silently dropped by the schema, and on a later `PUT` it needs the
dotted `temperatures.nozzleRangeMin` form. And **if the vendor table gave you a TD, put it in
`transmissionDistance` here**, or the value you went to the trouble of finding is discarded
while the hex is kept.

Match the family's existing naming convention rather than imposing one — look at the siblings
first. Renaming later is disruptive because slicers key their presets on the filament name.

Use the vendor spelling the rest of the library uses for that brand, so filters and grouping
don't fragment across `3D Fuel` / `3D-Fuel`.

**Keep nozzle references out of the name.** A filament is a material; a preset is a material
*plus* a nozzle. `HF0.4` and `0.6` are meaningful on a slicer preset and wrong on a filament,
which has no nozzle of its own — so `CHCKX PCTG HF0.4` is really `CHCKX PCTG`.

**The `type` feeds a reference-chapter resolver, so it is not free text in practice.** Record
the fill (`PC-CF`, not `PC`, for a carbon-filled polycarbonate) but drop the loading
percentage (`PPS-CF`, not `PPS-CF10`) — the resolver strips a `-CF`/`-GF` suffix to find the
base chemistry, and the rest of the library follows that convention. What it cannot do is
invent: a tidier-looking `PLA-Wood` matches nothing and silently hides the reference panel,
where the existing `Woodfill` resolves to the PLA chapter. Reuse a type the library already
uses, and if a genuinely new one is needed, check it still resolves.

### 5a. Only if you retried with `promoteParent: true`

Promotion copies colour and inventory onto the generated original variant and **nothing else**.
Anything colour-specific the old standalone was carrying stays behind on the new template,
where the resolver hands it to every sibling that doesn't override it — including the one you
just created. So the colour you added can silently inherit the *previous* colour's tags, its
transmission distance, and its OpenPrintTag link.

This is an inspection, not a ritual. Read the template back and act only on what is actually
there; on a standalone that carried none of it, this step reads once and does nothing.

```bash
# the sibling promotion generated — the template's other child
ORIG_ID=$(curl -s "$BASE/api/filaments/$TEMPLATE_ID" \
  | jq -r --arg new "$ID" '._variants[]? | select(._id != $new) | ._id' | head -1)
# what the template is actually holding (?raw=true — unresolved, so this is its OWN state)
curl -s "$BASE/api/filaments/$TEMPLATE_ID?raw=true" \
  | jq '{optTags, transmissionDistance, slug: .settings.openprinttag_slug}'
```

Use `?raw=true` for the template. A resolved read cannot answer this question, and `_variants`
entries report *effective* values — before cleanup both children echo the template's tags,
which is how you can tell the tags are stranded rather than genuinely shared.

Then, for whatever that read showed, writing the variant first so an interrupted run
over-specifies rather than loses:

- **`transmissionDistance`** — an unconditional move. TD is per-colour optics; no two colours
  share one. `PUT` the value onto `$ORIG_ID`, then `null` on the template.
- **`optTags`** — the array does not merge. `resolveFilament` uses whole-array fallback: a
  variant with a non-empty array **replaces** the template's rather than adding to it. So this
  is not a move, it is a split plus a copy.

  Ask of each tag: *does it describe this colour, or the product line?* That is a question
  about the family, not a fixed list of ids — and it applies to every tag, including the
  material ones. `0`/`31` fibre, `33` hygroscopic, `9` flexible and `5` food-safe come from the
  base polymer, so in practice they are always the line. `4` abrasive usually is too, but not
  when the abrasive thing is the *pigment*: one glow colour in an otherwise ordinary line is
  abrasive on its own account, and leaving `4` on the template marks every plain sibling
  abrasive and restricts them all to hardened nozzles. The appearance tags — `2` transparent,
  `3` translucent, `16` matte, `17` silk, `22` sparkle, `23` phosphorescent, `24` glow, `25`
  colour-changing, `27` gradient, `28` dual/`29` triple-colour — are usually the colour, but
  not always: in a **Matte PLA** or **Silk PLA** line the finish is the product, shared by
  every colour in it, and stripping it off the template makes each new sibling render wrong.
  The family name and the sibling colours tell you which you are looking at.

  Then: the template keeps **every line tag**, and the variant gets **its colour-specific tags
  plus a copy of every line tag**. Its own array is what it resolves to, so anything left out
  is simply gone for that colour. From `[2, 4]` on a normal line that is template `[4]`,
  variant `[2, 4]` — not variant `[2]`, which would strip the abrasive marker off the original
  colour and hide it from the nozzle-safety check in Settings → Data health. On a matte line
  holding `[16, 4]`, both stay: template `[16, 4]`, variant `[16, 4]`.

  **When you cannot tell, ask.** There is no safe default here, which is why this is a question
  and not a lookup: guess "line" and a `2` transparent stays on the template, so the next opaque
  colour added renders see-through; guess "colour" and a shared `16` matte leaves the template,
  so the next colour renders flat-less. Both are the same contamination in opposite directions,
  and both are silent. One question to the user settles it — name the tag and the family and ask
  whether every colour in the line shares it.
- **The OpenPrintTag link** — cannot be moved with a `PUT`; it is three fields, one of them
  server-owned. Follow the route sequence in `references/sources.md`, and keep its ordering:
  read the template's existing slug *before* the `DELETE`, because that slug belongs to the
  original colour and the one you looked up in step 4 belongs to the new one.

### 6. Link the OpenPrintTag match

Now that `$ID` exists, attach the slug chosen in step 4. Skip this entirely if the record is a
template, or if nothing matched.

```bash
curl -s -X POST "$BASE/api/filaments/$ID/openprinttag/link" \
  -H 'Content-Type: application/json' -d '{"slug":"3d-fuel-pro-pctg-natural"}'
```

A healthy link answers `{"linked": true, "found": true, "changes": []}` on
`GET /api/filaments/$ID/openprinttag/check`. Any `changes` entry means the record and OPT
disagree on a field — expected when you took a vendor value over OPT's, and worth saying so
rather than silently adopting either.

### 7. Weights, then the spool

Adding a filament always means a physical roll arrived, so the record is not finished until it
has a spool.

Three weights, and they are easy to confuse:

| Field | Lives on | Meaning |
|---|---|---|
| `spoolWeight` | template | tare — the empty spool |
| `netFilamentWeight` | template | nominal filament content, e.g. 1000 g |
| `totalWeight` | **spool** | gross weight of this roll right now, tare included |

The first two are shared product spec and belong on the template. Take them from an existing
variant or the template itself before asking — the family almost always already knows.

`totalWeight` is different and the family can never supply it: tare and nominal capacity
describe the product, not how much filament is on *this* roll today. So ask for it separately,
every time, and be specific about wanting the gross weight with the spool on the scale. The
one shortcut is an unopened roll, where tare plus nominal net is a fair starting figure — say
that you are assuming it rather than presenting it as measured.

Skipping this is the most likely way to finish with a spool that tracks nothing: the record
looks complete, the percentage bar is blank, and no error was ever raised.

**If the family is missing either one, gather it and write it before creating the spool** —
noticing it is absent is not enough, and one out of two is not enough either: without the tare
there is no display at all, and without a positive net the percentage stays blank while only
grams show. The remaining-percentage bar divides by `netFilamentWeight`, and
remaining grams subtract `spoolWeight`, so a spool added to a family with both null tracks a
gross number and nothing else. On a standalone, put them in the create payload. On an existing
family, PUT them onto the template first, so every colour inherits them:

```bash
curl -s -X PUT "$BASE/api/filaments/$TEMPLATE_ID" -H 'Content-Type: application/json' \
  -d '{"spoolWeight": 147, "netFilamentWeight": 1000}'
```

The net is usually on the packaging or the listing; the tare almost never is, so expect to ask
for a weighed empty spool — and do ask, because **net alone is not enough**. `computeRemaining`
returns null the moment `spoolWeight` is null, before it reaches the percentage, so a roll with
a net but no tare displays nothing at all. Store a known net anyway so it is not lost, but say
plainly that the display stays blank until the tare arrives.

```bash
curl -s -X POST "$BASE/api/filaments/$ID/spools?shape=spool" -H 'Content-Type: application/json' \
  -d '{"totalWeight": 1186, "label": ""}'
```

`purchaseDate` is optional and deliberately absent above: only send it when the user gives a
date, or when they say the roll arrived today and you derive today's. A copied example date
silently backdates every roll added afterwards.

The server mints an `instanceId` for the spool — a durable identity that printed QR labels and
NFC tags resolve against. Let it generate one. Only pass an explicit `instanceId` when moving
a spool between records and preserving its printed identity, and note the uniqueness check
ignores trashed rows, so a colliding id may need the old record trashing first.

### 8. Verify against the resolved record

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

**Name uniqueness is case-sensitive here, and the filesystem may not be.** The unique index on
`name` declares no collation, so it is a byte comparison — `SunLu PP` and `SUNLU PP` are two
distinct filaments and neither create will complain. That becomes destructive the moment names
reach a filesystem: on macOS, writing a preset for one lands on the file of the other, keeping
the original filename and silently replacing its contents. So when adopting a vendor's
capitalisation, compare names case-INsensitively against what already exists, and expect a
file count that comes up one short to mean exactly this.

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
