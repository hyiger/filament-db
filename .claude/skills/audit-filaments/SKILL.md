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

Template-ness comes from the **listing's** `hasVariants`, not only from the loaded records: if a
template's sole variant fails its detail read, deriving topology from what loaded would reclassify
the parent as a standalone and invent missing-core and nozzle findings against it.

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
common and invisible. **The schema carries temperatures in FIVE places, and all five are checked**, because each
resolves and exports independently — a malformed value in any of them reaches a slicer preset while
the values beside it look perfectly sane:

1. top-level `temperatures` (including `nozzleFirstLayer`/`bedFirstLayer`, which export separately);
2. `temperatures.standby` — an *idle* temperature, legitimately far below the print window, so only
   its ceiling is meaningful;
3. `bedTypeTemps[]` per-plate overrides — `filamentToOrcaSlicerKeys` writes **both**
   `temperature` and `firstLayerTemperature` from this array into the preset, overriding otherwise
   valid base values;
4. `calibrations[]` overrides — `prusaSlicerBundle` writes `temperature`/`bed_temperature` and
   `orcaSlicerBundle` `nozzle_temperature`/`hot_plate_temp` straight from the entry;
5. `presets[].temperatures`.

The checker collects every temperature the record carries **first** and then checks them
uniformly. Three separate review rounds each found the next unchecked site, which is why it is
built this way: a new temperature-bearing field needs adding to one of those lists and nothing
else. Plus implausible absolute values, against a band that is **type-aware at the
bottom**: the general floor is 150 °C, but the bundled technical reference documents PCL 100 at
~120 °C and the orthotic Facilan Ortho at 130–170 °C, so a flat floor would call every valid
low-temperature grade an error. Widen `LOW_TEMP_TYPES` rather than lowering the floor for
everything if another such material arrives.

The scope refs need a **third read**. `calibrations[].printer` and `.bedType` are optional, and
their null is the *supported* generic state — but both detail reads populate them, and `populate`
yields null for a target that no longer exists, so a purged scope and a deliberate generic are
byte-identical in those two reads. The difference is not cosmetic:
`pickRepresentativeCalibration` takes the **first row with both refs null** as the export default,
so a purged printer silently promotes one machine's tuning into the single-preset Orca/Bambu export
for *every* machine. `GET /api/snapshot` is a plain `find().lean()` and is the only read carrying
the raw ObjectIds, so the checker fetches it once (~0.5 MB / 25 ms on the library under test, but it
is the whole database — fetch it once and keep only the ids). The pass walks the **snapshot's own
per-filament arrays**, never the resolved read: a variant inheriting `calibrations` carries the
template's array, so walking the resolved read would report the template's dangling ref once per
child at an index the child does not own. If that read fails, the report **says the category was
not checked** rather than rendering as clean, and a collection the snapshot does not *carry* is
distinguished from one that is *empty* — collapsing those would report every stored reference in
the library as dangling at once.

The consequence branches, because `pickRepresentativeCalibration`'s predicate is
`printer == null && bedType == null`: a dangling printer beside a **live** bed type fails it and
does **not** become the export default — it merely loses its printer scope. Two different
sentences, chosen from the other ref's state.

**Dates** are checked for *castability*, not format. Mongoose casts a string with `new Date(v)`
and raises `CastError` on an Invalid Date, so the mirror has to match **V8**, which accepts far
more than ISO 8601 — `"Jan 1 2020"`, `"2026-1-5"`, and even `"2020-02-30"`, which it rolls over to
March 1. Anything stricter would condemn a date the app stores happily, so the predicate reports
only the shapes V8 provably rejects and stays silent on the rest (pinned against node's own
`new Date` in `case_date_mirror`). Three sites, three different consequences: a spool's
`purchaseDate`/`openedDate` throws a **`RangeError` during render** (the SpoolCard seeds its inputs
with `new Date(v).toISOString()`, so the whole filament page fails to open); a `dryCycles[].date`
is schema-**required** and 400s the entire backup; a `usageHistory[].date` has a `Date.now`
default, so the loss is in **analytics**, which `continue`s past an invalid one — the grams vanish
from every total while the spool's own ledger still lists them.

**Missing core spec** — no effective nozzle temp, bed temp or density after inheritance. Templates
are exempt: an abstract product line legitimately carries none of it.

**Physical values** — every numeric field against the **schema's own bounds**, mirrored in
`NUMERIC_BOUNDS` and `CALIBRATION_BOUNDS`. A value outside them cannot be written through the API,
so a violation proves the row arrived by a path that bypassed validation (the settings bag's
own limits — 400 keys and 20,000 characters per value, from `validateSettingsBag` — are mirrored
the same way, measured as **JavaScript would**: `JSON.stringify(value ?? null)` counted in UTF-16
code units, so quotes, escapes and the surrogate pairs of an emoji all count exactly as they do in
the app) — a raw-driver sync copy,
a snapshot restore, or a legacy write — and both exporters serialise these straight into the
preset. That covers the non-temperature calibration overrides too (`extrusionMultiplier`, the three
fan speeds, retraction, pressure advance) and the top-level `maxVolumetricSpeed`, which
`prusaSlicerBundle` and `orcaSlicerBundle` both write as `filament_max_volumetric_speed`.

Density additionally gets a **material-aware** band.

**Schema constraints that are not numeric bounds** get the same treatment, with a sharper
consequence: `POST /api/snapshot` validates *every* document before it writes anything and 400s the
**whole file** on the first failure, so one offending row anywhere makes the user's backup
un-restorable — and they find out at restore time. Three are mirrored: the 200-character
`maxlength` on `spools[].label` / `lotNumber` (measured in **UTF-16 code units**, as `maxlength`
counts them — an emoji costs two, so a 150-character Python string can be a 300-unit JS string),
the schema-**required** `spools[].dryCycles[].date`, and `tdsUrl`.

`tdsUrl` is mirrored against `new URL()`, not against `startsWith("http")`, and it is checked on the
**stored** read because the field is inheritable — judged on the resolved read, one bad URL on a
template would be reported once per colour variant, each naming a document the user cannot fix it
on. The mirror reproduces what WHATWG actually does: leading/trailing C0-and-space are stripped and
interior tabs/newlines deleted (`" https://x.com "` and a line-wrapped paste are **valid**), the
scheme is case-insensitive, and for a special scheme every leading `/` and `\` after the colon is
authority framing — so `http:/x.com` and `http:///x.com` parse fine while a bare `http:` does not.
It deliberately **under-reports**: a host that parses structurally but fails IDNA, IPv6 or port
validation is left alone. That direction is chosen on purpose — a false positive here tells the
user to "fix" a vendor link that already works. Verified against node's own `new URL` over 6,000
generated inputs: zero disagreements in the reporting direction.

**Say which authority a finding rests on.** Most bounds mirror the schema, so a violation proves
the row bypassed API validation — but `debitedGrams` is declared with no min/max at all, so calling
a bad value there a "schema bound" violation would be a false claim about how it got there. It is
reported separately, as implausible-but-acceptable-to-the-API. Keep that distinction when adding a
check: the remedy differs, because one shape means "something wrote past validation" and the other
means "validation would not have stopped this".

**Before changing the checker, run its suite** — from anywhere:

```bash
python3 .claude/skills/audit-filaments/references/selftest.py
```

It walks a realistic record and substitutes hostile values at *every* path it finds, across the
resolved read, the stored read and both at once — thousands of combinations — asserting the audit
still returns. That shape exists because the alternative did not converge: review kept naming one
more path where a wrong-typed value either aborted the run (so a single corrupt record hides every
finding for the whole library) or was read past in silence, and the script reads well over a
hundred paths. Fuzzing every path covers the next one the day it is added, with nobody writing a
case for it.

**Every module-level table in `audit.py` must be classified in the selftest**, in one of
`FIELD_TABLES` / `PAIR_TABLES` / `VALUE_TABLES`; an unclassified one fails the suite by name. That
rule exists because the coverage guard originally scanned only literal `.get("x")` calls while most
of the checker's reads are **table-driven** (`container.get(f2)` over `NUMERIC_BOUNDS.items()`), so
a field reachable only through a table was invisible to the guard *and* absent from the fixture —
nothing probed it. That is how the fixture came to carry four invented names (`glassTransition`,
`heatDeflection`, `shoreA`, `shoreD`) while the four real fields the checker reads went unfuzzed for
the life of the file. Classifying is the cheap part; the failure-on-unclassified is what stops the
fuzz's reach from silently shrinking again.

Coverage here is **verified, not assumed** — an earlier revision claimed the table covered every
exported numeric "by construction" and it did not, twice. Re-check it after any schema change:

```bash
# every `<field>: { type: Number` leaf in the model, against the checker's tables
python3 - <<'EOF'
import re, importlib.util
schema = set(re.findall(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{\s*type:\s*Number',
                        open('src/models/Filament.ts', encoding='utf-8').read(), re.M))
spec = importlib.util.spec_from_file_location("a", ".claude/skills/audit-filaments/references/audit.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
covered = set()
for t in ("NUMERIC_BOUNDS","RANGE_BOUNDS","PRESET_BOUNDS","SPOOL_BOUNDS",
          "DRY_CYCLE_BOUNDS","USAGE_BOUNDS","CALIBRATION_BOUNDS",
          "SEMANTIC_BOUNDS_USAGE"):   # checked, just not against a schema bound
    covered |= set(getattr(m, t))
covered |= {"nozzle","nozzleFirstLayer","bed","bedFirstLayer","standby","temperature",
            "firstLayerTemperature","nozzleTemp","nozzleTempFirstLayer","bedTemp",
            "bedTempFirstLayer","chamberTemp","density","diameter"}
print("UNCOVERED:", sorted(schema - covered) or "none")
EOF
```

At the time of writing that reports **45 of 45 covered**. Re-run it after moving a field between tables, not only after a schema change — omitting one table makes the guard report a permanent false gap. The unfilled-polymer ceiling is
2.5 g/cm³, but copper- and bronze-filled PLA legitimately sit around 3–4, so a filament carrying
the metal-fill tag (**20**) gets a much higher one. The schema permits any non-negative density;
prompting someone to "correct" a valid one would corrupt every weight-to-length calculation that
reads it.

The tag is the *only* evidence used, and that is deliberate. Matching metal words in the name
looks equivalent and is not: "Metallic Grey" and "Steel Blue" are pigments, which is exactly why
the app's own `FILLED_RE` requires the word *fill* after metal/steel/iron. A bare name match would
raise the ceiling for an ordinary filament and let a corrupt 4 g/cm³ through — trading a false
positive for a false negative, which is the worse direction. A genuinely metal-filled record that
trips the check should get tag 20, which the finding says, and which also corrects its abrasive
classification.

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

**Structural integrity** — a calibration whose nozzle is gone (`populate` yields `null` for a
purged nozzle, or an object still carrying `_deletedAt` for a soft-deleted one; neither can be
diameter-matched by the dynamic calibration route, and the Prusa bundle drops the row from its
per-nozzle fan-out, so valid tuning silently becomes unreachable) — a calibration whose
**printer or bed-type scope** is gone — and a broken parent link, in
three shapes: a `parentId` that resolves to no
active filament (the listing returns only active rows, so it is missing, soft-deleted or purged),
one pointing at *itself*, and one pointing at another **variant**. All three pass every other check
while resolving nothing: the write API forbids nested inheritance and `resolveFilament` walks
exactly one immediate parent, so a grandparent's values never reach the row however complete they
look. Reachable through an import, a snapshot restore or a sync merge — none of them through the
API.

**Cross-field ordering** — each endpoint of a pair can satisfy its own bound while the pair is
contradictory, so the bounds table can never catch these. Four are checked from one
`ORDERED_PAIRS*` table, including a usage entry's `debitedGrams` against its `grams`: the refund
path states that a genuine clamped debit can never exceed the entry's grams and falls back to a
full-grams refund when it does, so an inverted pair is known-corrupt refund provenance. The other
three: the nozzle range, `minPrintSpeed`/`maxPrintSpeed`, and a
calibration's `fanMinSpeed`/`fanMaxSpeed` — which `prusaSlicerBundle` exports directly as
`min_fan_speed`/`max_fan_speed`, so an inverted pair becomes a contradictory cooling profile.

**Nozzle assignment** — a non-template filament with no usable `compatibleNozzles`. Note that a
soft-deleted nozzle still populates as a **truthy object carrying `_deletedAt`**, so a non-empty
array is not evidence of an assignment: the checker separates live from stale entries and reports
"effectively unassigned" when none survive. Same trap as the calibration-nozzle check above. Anything
abrasive-related is left to the app's audit above, which also knows that the INDX nozzle is
nitrocarburized, i.e. surface-treated only, and "not a substitute for a hardened nozzle on
fibre-filled or metal-filled grades".

**Colour** — malformed hex on the primary, the legacy `#808080` sentinel the pre-v1.70 form
stamped on everything, and **every `secondaryColors` entry plus the array's 5-entry cap**. Those
are observable, not cosmetic: the OpenPrintTag encoder silently skips an invalid entry and
truncates extras, and a slicer export can use the first secondary when the primary is null.

**Malformed shapes and types are reported once, centrally.** Two sweeps run **first, before any
derived value** — a `spools` holding a string would otherwise be iterated character by character
before the sweep could report it — and the shape sweep runs on **both** reads, because
`resolveFilament` normalises some containers, so a variant's corrupt *stored* value can be invisible
in the resolved response. Coerce only after reporting: silently cleaning the raw value is how a
malformed bag came to be declared clean.

The two sweeps: `CONTAINER_SHAPES` reports any container that is not the type the schema declares
(a string in `temperatures` crashes every `.get()` below it) and treats it as empty, and
`malformed_numerics` walks the whole record reporting any schema-numeric leaf, **at any depth**,
holding a non-number. The individual passes then skip quietly rather than each needing a reporting
branch — four consecutive review rounds found the next unreported site before it was done this way.

Two exclusions are load-bearing. `settings` and `openprinttagSnapshot` are **opaque bags** whose
keys collide with schema numeric names by coincidence: a slicer `temperature = 240` is legitimately
the *string* `"240"`, and descending into that bag produced 30+ false positives the first time this
sweep met a real library. And `calibrations[].nozzle` shares its name with the numeric
`temperatures.nozzle` while holding a populated nozzle document, so a dict there is correct.

**A malformed value is reported, not fatal — and neither is an unreadable record.** Both are the
same hazard: one corrupt row killing the run. A raw-driver sync, a restore or a legacy write can
leave a *string* in a numeric field, and `0.7 <= "oops"` raises `TypeError`, so every direct
comparison goes through a `num()` helper that yields `None` for a non-number while the bad value is
reported separately — by `bounds_check` for anything in a bounds table, including nested
containers, so a malformed `presets[0].extrusionMultiplier` is named rather than quietly skipped.
Do not "simplify" those back to bare comparisons, and remember `num()` returns `None`, so a guard
that then compares the result still raises.

**A record that cannot be read is reported, not fatal.** One row that vanished between the listing
and the detail read, or whose GET route 500s, used to abort the whole run before anything was
rendered — one bad row hiding every other row's defects. Each failure now becomes a `structure`
finding naming the id, and the audit continues; only an all-failed read exits, rather than
reporting a clean library.

## When the finding is right but the obvious fix is wrong

Several checks flag a genuine inconsistency whose natural remedy would *damage* correct data. This
is the failure mode to watch for hardest, because the finding reads as authoritative and the fix
looks obvious:

- **A high-flow calibration above the declared range** — widen `nozzleRangeMax` to what is actually
  run; do not lower a tuned calibration.
- **A density above the unfilled ceiling** — if the filament really is metal-filled, add optTag 20;
  do not "correct" a valid 3.9 g/cm³ down to 2.5, which would corrupt every weight-to-length
  calculation reading it.
- **A low nozzle temperature on PCL** — a valid low-temperature grade, not an error.
- **`glassTempTransition` below the schema's −50 floor** — POM and other low-Tg materials are
  commonly cited near −60 °C, so a value like that is likely *correct data against a bound that is
  too tight*. It does prove the row was written by a path that bypassed validation, which is worth
  knowing; it does not mean the number is wrong. Widening the schema bound is the real fix, and
  editing the value to satisfy the audit is the one thing not to do.

The shared shape: the audit knows what the schema and the app accept, not what the material is.
When those disagree, say so and let the owner decide rather than prescribing a write.

## False positives, learned by hitting them

**Per-record state must not outlive its record.** The text sweep builds its "what did I coerce"
sets in one loop and the colour checks read them in a *later* one, so a bare loop-local left the
**final** record's state standing in for every record — one non-string `color` on the last row
silently disabled the malformed-colour check for the whole library. It is keyed by record id now,
and `case_no_cross_record_leak` pins it. Worth internalising rather than just fixing: every other
case in the suite runs ONE record, which is precisely why this survived. A new check that carries
state between the loops needs a multi-record, order-sensitive assertion.

**Two active records can share a name.** Hybrid sync, a restore, or a legacy database whose
unique-name index could not be built all produce it, and every finding identifies its filament by
name. The checker therefore dedupes on `(record id, message)` and appends the id to **every**
finding on a record whose name is not unique — not merely where two messages happen to be
identical, which is the rare case: duplicates usually carry *different* defects, so message-level
disambiguation would almost never fire and the report could not say which row to repair.

Names are compared **trimmed**, because `X` and `X ` are distinct raw keys that render identically.
That pair is a documented unresolved state rather than a hypothetical — the #1116 trim migration
deliberately refuses to merge a whitespace twin and Data health surfaces it instead — so it is
exactly where the reader needs the id. Do not "tidy" any of this back into a text-level dedupe.

**`bedTypeTemps[].bedType` is free text and has no closed vocabulary.** `Filament.ts` says so
explicitly, and its own example — `"Textured PEI"` — is *PrusaSlicer's* name, not one of the five
keys `BED_TYPE_KEY_MAP` indexes; `bedTypeTempRefFilter` separately matches this field against
user-created **BedType names**. So an "expected one of […]" row would condemn every surface the user
legitimately named, and an earlier revision of this checker did exactly that. Only a **case or
whitespace twin** of a canonical Orca key is reported (`"hot plate"` vs `"Hot Plate"`): no
vocabulary explains that, and a rename certainly fixes it. Everything else is left alone.

**One consequence sentence does not fit four fields.** The four spool text fields are checked
together but fail differently, and pasting one sentence across them sent the reader looking for a
crash that cannot happen: `instanceId` is an identity key that is never a React child (a non-string
there makes both type-strict match tiers miss, so a printed QR resolves to nothing); `photoDataUrl`
goes to an `<img src>`, which **coerces** rather than throwing; and `label`/`lotNumber` throw only
when the value is an *object* — React renders a number or a flat array child happily, so a numeric
label breaks nothing visible but is skipped by `computeNextSpoolLabel`'s `typeof raw !== "string"`,
letting the Next # button hand the same roll number out twice.

**A missing value and a malformed one are different findings.** `num()` returns `None` for both,
so a `density: "oops"` used to produce a "no density" row *on top of* the malformed-value row the
numeric sweep had already emitted — and because density, nozzle temp and bed temp are all
inheritable, the template got the accurate row while every child got the misleading one. The
missing-core checks test the underlying **field** for absence, not the parsed number.

**`#808080` on a filament whose colorName is "Grey" is correct**, not a sentinel — grey filament is
that colour. The checker exempts it; do not "fix" one by hand either.

**Array pins ignore only each element's own generated id.** A calibration's `nozzle`, `printer`
and `bedType` are *populated references* whose `_id` **is** their identity — stripping those made
two calibrations pointing at different nozzles compare equal, and the documented repair (clear the
variant's array) would then switch the variant onto the template's targets. Comparing arrays is not
the same as comparing them structurally.

**A high-flow calibration above the declared range is usually deliberate.** A tungsten-carbide or
other high-flow nozzle needs more heat than the material's published window, so a calibration at
270 °C against a declared 230–260 is a real inconsistency but rarely an error. The repair is almost
always to widen `nozzleRangeMax` to match what is actually being run — not to lower the calibration,
which would change a tuned profile. Report it as "the export sends X while the record claims Y" and
let the owner decide.

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
