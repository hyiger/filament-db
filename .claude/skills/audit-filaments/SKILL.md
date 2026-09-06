---
name: audit-filaments
description: >
  Audit a Filament DB library for missing fields, invalid values and inconsistencies that the
  app cannot surface on its own — abrasive filaments that export as safe, spools whose remaining
  bar can never render, drying times entered in hours, temperatures outside their own declared
  range, templates still holding inventory, and variants that have silently stopped inheriting.
  Use this whenever the user asks to check, audit, validate, sanity-check or "find problems in"
  their filaments or inventory; when they ask what is missing or incomplete; before a bulk export
  to a slicer; and after a large import, a snapshot restore or a hybrid-sync merge.
---

# Auditing a Filament DB library

This is the **read-and-report** counterpart to `add-filament`. That skill puts one filament in
correctly; this one finds the ones that went in wrong — including the ones that went in wrong
years ago through a form that no longer exists.

Set these up first — the repair commands later in this skill all use `$BASE`, and it is empty
until you do. The script takes its own `--base`, which is internal to Python and creates no shell
variable, so a `curl "$BASE/api/..."` after an otherwise successful audit would be sent to a URL
with no host.

```bash
BASE="${FILAMENTDB_URL:-http://localhost:3456}"
BASE="${BASE%/}"                 # a trailing slash yields //api/... and a 308
AUTH=""
[ -n "${FILAMENTDB_API_KEY:-}" ] && AUTH="Authorization: Bearer $FILAMENTDB_API_KEY"
curl -s ${AUTH:+-H "$AUTH"} -o /dev/null -w '%{http_code}\n' "$BASE/api/filaments"
```

Expect `200`. A connection error means the app is not running — say so and stop rather than
auditing nothing. A `401` means the instance sets `FILAMENTDB_API_KEY`; export it and retry.
Pass `${AUTH:+-H "$AUTH"}` on every later call; the examples below omit it only to stay readable.

Then run the checker and triage. The script is mechanical; the judgement is yours.

```bash
python3 .claude/skills/audit-filaments/references/audit.py --base "$BASE"
```

Options: `--base` (default `http://localhost:3456`, or `$FILAMENTDB_URL`), `--api-key` (or
`$FILAMENTDB_API_KEY`), `--only <categories>`, `--json`, `--cache <dir>` to keep the fetched
records for follow-up analysis.

## Traps that make a naive audit worse than none

**Do not audit through `MONGODB_URI`.** `scripts/audit-filaments.ts` connects with the URI from
`.env.local`, which is frequently a *different database* from the one the running app is using —
a dev server and the packaged desktop app are hybrid-sync peers whose rows carry identical names
and completely disjoint `_id`s. An audit of the wrong peer reads plausibly and describes records
the user cannot see. Go through the app's REST API on port 3456; whatever database is behind it
is by definition the one the user is looking at.

**A blank field on a variant is usually correct.** This is the whole difficulty. A variant leaves
its inheritable fields null *on purpose* so `resolveFilament` reads them from its template at
request time — that live inheritance is the feature. The existing script reads stored documents
and reports every inherited field as "missing", which on a library with a dozen templates is most
of the output and buries everything real.

So the checker fetches each filament **twice**: `GET /api/filaments/{id}` (resolved — what the app
and the slicer actually see) and `?raw=true` (stored — what this row owns). Missing-ness is judged
on the resolved read, and ownership questions on the raw one. Keep that distinction if you extend
it.

## And do not re-derive abrasiveness

**The app already has an authoritative, unit-tested abrasive audit** —
`src/lib/abrasiveNozzleAudit.ts`, exposed as `GET /api/abrasive-nozzles`. The checker calls it and
reports what it says. Reimplementing it in the script produced a strictly worse duplicate that
was wrong in five separate ways, every one of them a false negative or a false alarm in the
highest-severity category:

- it recognised only `optTags` 4, where the real `ABRASIVE_OPT_TAGS` is `0, 1, 4, 19–24, 31, 32` —
  so an imported `type: "PLA", optTags: [31]` carbon-fibre record passed clean;
- it compared `filament_abrasive` by identity, so a legitimate per-extruder `['1','1']` from an
  Orca/Bambu round trip read as "off" (the app collapses it with `settingFlagScalar`, GH #678);
- it called a setting-only record unrestricted, when `FilamentForm` computes
  `isAbrasive = form.abrasive || form.optTags.includes(4)`;
- it audited templates, which are not printable stock and whose values every child may override;
- it accepted a **soft-deleted** nozzle as a safe assignment, where the app treats a reference
  missing from the active catalogue as unsafe, because a dangling ref is not evidence of hardness.

Ask the app. If the endpoint is unreachable the checker says so loudly rather than printing an
empty category, because "no abrasive findings" and "abrasive was never checked" must not look
alike.

Why this category matters at all: `optTags` 4 and `settings.filament_abrasive` are read by
*different consumers*. The nozzle picker honours the tag; the **exporter reads only the setting**,
and that is the value a firmware `M862.1` check sees. The usual cause of divergence is benign —
FilamentForm writes the setting from its own checkbox, so saving a record tagged some other way
stamps `'0'`, an *active assertion that a carbon-filled filament is not abrasive*.

## What else it checks, worst first

**Inventory blockers.** `computeRemaining` returns null the moment `spoolWeight` is null, before it
ever reaches the percentage, and the bar divides by `netFilamentWeight`. A live spool on a filament
missing either one tracks a gross number and nothing else — the record looks complete, the bar is
simply blank, and no error was ever raised. Three subtleties, each of which the app's own maths
enforces and a naive check misses:

- `getRemainingPct` rejects a **non-positive** denominator, not just a null one, so a schema-valid
  `netFilamentWeight: 0` blocks the bar exactly like a missing one.
- A spool with **no gross weight** is skipped by that function's `validCount`, and when no spool is
  left countable it returns null outright. So audit the missing gross explicitly, and say so
  louder when it is *every* live spool.
- A **legacy roll** carries its stock on the top-level `totalWeight` with no `spools[]` at all, and
  the app counts that as one tracked spool (`getSpoolCount`, and `getRemainingPct`'s second
  branch). Gate the whole category on "live spools **or** a legacy roll", or you skip precisely
  the pre-migration records this skill exists to find. Branch selection keys off `spools` being
  non-empty at all — retired included — which is what the app does.

Also catches a gross weight below its own tare, in both shapes.

**Drying time in hours.** `dryingTime` is **minutes** and no vendor datasheet uses minutes — they
all say hours. The schema cap is 10080, so `4` is accepted silently and reads as four minutes of
drying on a hygroscopic filament. Anything ≤ 24 with a drying temperature set is almost certainly
an hours figure.

**Temperatures.** The schema rejects an *inverted* range (min > max, GH #574) but nothing catches
the everyday value falling outside its own declared range — a nozzle temp above its range max is
common and invisible. Plus implausible absolute values, against a band that is **type-aware at the
bottom**: the general floor is 150 °C, but the bundled technical reference documents PCL 100 at
~120 °C and the orthotic Facilan Ortho at 130–170 °C, so a flat floor would call every valid
low-temperature grade an error. Widen `LOW_TEMP_TYPES` rather than lowering the floor for
everything if another such material arrives.

**Missing core spec** — no effective nozzle temp, bed temp or density after inheritance. Templates
are exempt: an abstract product line legitimately carries none of it.

**Physical values** — density against a **material-aware** band. The unfilled-polymer ceiling is
2.5 g/cm³, but copper- and bronze-filled PLA legitimately sit around 3–4, so anything carrying the
metal-fill tag (20) or a metal word in its type or name gets a much higher ceiling. The schema
itself permits any non-negative density; prompting someone to "correct" a valid one would corrupt
every weight-to-length calculation that reads it.

**Template violations (v1.70 #605).** A filament with variants is a template: colourless, no
inventory. Enforcement is forward-only, so legacy parents keep whatever they had. Inventory
stranded on a template is the serious case — its spools are invisible to the family's stats.

The remedy for **colour, colourName, spools or `totalWeight`** is the **Convert to template**
action on the parent (`POST /api/filaments/{id}/promote`), never a hand-written `PUT` — it moves
that state onto a new sibling variant rather than deleting it.

**Whether promote works is a question about the WHOLE template, not about the field in front of
you** — and getting that backwards destroys data. `parentPromotionState` computes `needed` as: a
non-empty `color` (**not** trimmed), a `colorName` non-empty **after trimming**, a spool count, or
`totalWeight`. When that gate passes, `performParentPromotion` moves colour, colourName, spools,
`totalWeight` **and `lowStockThreshold`** onto the new variant. So on a template carrying a colour
*and* a threshold, promote handles both — and telling the user to null the threshold first would
throw away a value promotion would have preserved.

Only when the gate does **not** pass does anything need a manual write, and then the leftovers can
only be:

- **`lowStockThreshold`** — deliberately outside the gate, because a promotion that moves nothing
  is not worth confirming.
- **A whitespace-only `colorName`** — trimmed to empty by that check. Reachable when a standalone
  with a blank-looking name gains its first variant. Note the asymmetry: a whitespace-only
  *`color`* is **not** trimmed, so it does satisfy the gate.

The checker tags every template row with whichever applies, computed from the parent's full state:

```bash
# only when the audit says promote returns 400 nothing_to_convert
curl -s -X PUT "$BASE/api/filaments/$TEMPLATE_ID" -H 'Content-Type: application/json' \
  -d '{"lowStockThreshold": null}'      # or {"colorName": null}
```

An explicit `null` passes the template strip (which only drops non-null values), which is exactly
how a legacy template gets cleaned up.

**Pinned inheritance.** A variant storing a value byte-identical to its template's is a copy that
looks right today and stops following the template the day it is edited. Latent, never urgent, and
worth reporting as such rather than alarming about it. The field list is `resolveFilament`'s own
`INHERITABLE_FIELDS`, **every `temperatures.*` subfield** — that subdocument resolves subfield by
subfield, so a variant storing its template's nozzle temp pins exactly like a top-level field —
**the six whole-array fields** (`optTags`, `secondaryColors`, `bedTypeTemps`, `calibrations`,
`presets`, `compatibleNozzles`), which inherit only while the variant's own array is *empty*, so a
non-empty copy of the template's array is a pin too — and **`settings`**, which is shallow-merged
`{...parent, ...variant}`, so each duplicated key overrides that key alone.

Settings pins are reported **per variant with a count, not per key**, and that is a deliberate
granularity choice rather than laziness: a slicer round trip echoes the whole bag back, so a real
library produces hundreds of matching keys — 341 across 32 variants on the one this was built
against — and per-key rows would bury every other category in the report.
Three inheritable fields are deliberately excluded because every variant stores them by
construction and they would report as pinned every time: `vendor` and `type` are required by
`POST /api/filaments`, and `diameter` is materialised by a schema default of 1.75.

**Structural integrity** — a variant whose `parentId` resolves to no active filament. The listing
returns only active rows, so an absent parent means missing, soft-deleted or purged, and such a row
can pass every other check while the detail page and every slicer export resolve *none* of its
inherited values. Reachable through an import, a snapshot restore or a sync merge.

**Nozzle assignment** — a non-template filament with no `compatibleNozzles` at all. Anything
abrasive-related is left to the app's audit above, which also knows that the INDX nozzle is
nitrocarburized, i.e. surface-treated only, and "not a substitute for a hardened nozzle on
fibre-filled or metal-filled grades".

**Colour** — malformed hex, and the legacy `#808080` sentinel the pre-v1.70 form stamped on
everything.

## False positives, learned by hitting them

**`#808080` on a filament whose colorName is "Grey" is correct**, not a sentinel — grey filament is
that colour. The checker exempts it; do not "fix" one by hand either.

**A flag mismatch is not always an imminent nozzle death.** A CF grade whose `compatibleNozzles`
already lists only hardened nozzles is safe to print today; what is broken is the value it
*exports* to the slicer. Say which of the two you mean.

**A template with no temperatures is fine**, and so is a variant with no *stored* density —
it resolves one from its template. Say "stored" and not just "no density": the checker judges
`missing-core` on the **effective** read, so a non-template whose density is absent *after*
inheritance is a real finding and must not be waved away as inheritance.

## Fixing what you find

**Everything nested needs a dotted path.** `PUT /api/filaments/{id}` hands the body to
`findOneAndUpdate` essentially verbatim, so `{"settings": {...}}` **replaces the entire settings
bag** — on a Prusament record that is 87 keys of slicer configuration destroyed to change one flag.
Likewise `{"temperatures": {...}}` wipes `bed` and the range fields.

```bash
# right
curl -s -X PUT "$BASE/api/filaments/$ID" -H 'Content-Type: application/json' \
  -d '{"settings.filament_abrasive": "1"}'
curl -s -X PUT "$BASE/api/filaments/$ID" -H 'Content-Type: application/json' \
  -d '{"temperatures.nozzleRangeMax": 260}'
```

Verify a settings write by re-reading and counting the keys, not just checking the one you set.

**Which direction to fix a tag/setting mismatch.** Setting `filament_abrasive: "1"` to match an
existing tag 4 is the conservative repair: it preserves the intent the user already expressed and
fails safe (the slicer demands a hardened nozzle). Removing the tag is the permissive direction and
needs the user's agreement. Where the polymer itself is not classically abrasive — POM, an unfilled
tribological grade — say so rather than assuming the tag was right; the user may have tagged it for
a reason you cannot see, or in error.

**Clear a pinned field to `null`**, do not try to match the template's value. Explicit null is what
restores inheritance — for a scalar, a temperature subfield, or a whole array (send `[]`).

**A pinned `settings` key is the exception, and `null` does not fix it.** The bag is shallow-merged
`{...parent, ...variant}`, so a key set to null is still *present* on the variant and keeps
overriding — with null — every value the template will ever hold. Nor can you `$unset` it: the PUT
route rejects any body with a `$`-prefixed key. The only repair is to read the raw bag, delete the
key, and write the whole bag back:

```bash
BAG=$(curl -s "$BASE/api/filaments/$ID?raw=true" | jq -c '.settings | del(.filament_abrasive)')
curl -s -X PUT "$BASE/api/filaments/$ID" -H 'Content-Type: application/json' \
  -d "{\"settings\": $BAG}"
```

This is the one place the whole-bag write documented as dangerous above is the *correct* operation
— it is the only way to remove a key. It is a read-modify-write, so do it when nothing else is
syncing that record, and check the key count before and after.

## What NOT to fix automatically

A missing temperature, density or spool weight is missing *data*, not a broken value, and it needs
a real source. Do not fill it from a polymer handbook, a sibling filament or an average — hand it to
`add-filament`, whose whole discipline is where a number came from. A blank field is visibly
missing; a plausible invented one is not.

Report first, fix on request. Group by severity, name the records, and say plainly which findings
are latent and which are live.
