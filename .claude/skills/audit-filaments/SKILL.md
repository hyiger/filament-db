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

Run the checker, then triage. The script is mechanical; the judgement is yours.

```bash
python3 .claude/skills/audit-filaments/references/audit.py
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
common and invisible. Plus implausible absolute values.

**Missing core spec** — no effective nozzle temp, bed temp or density after inheritance. Templates
are exempt: an abstract product line legitimately carries none of it.

**Template violations (v1.70 #605).** A filament with variants is a template: colourless, no
inventory. Enforcement is forward-only, so legacy parents keep whatever they had. Inventory
stranded on a template is the serious case — its spools are invisible to the family's stats.

The remedy for **colour, colourName, spools or `totalWeight`** is the **Convert to template**
action on the parent (`POST /api/filaments/{id}/promote`), never a hand-written `PUT` — it moves
that state onto a new sibling variant rather than deleting it.

**`lowStockThreshold` is the exception, and prescribing promote for it is wrong.**
`parentPromotionState` computes `needed` from colour, colourName, spool count and `totalWeight`
only — a threshold is deliberately not in it, because a promotion that moves nothing is not worth
confirming. So a template whose *only* leftover is a threshold returns **400 `nothing_to_convert`**,
and pointing the user at promote sends them to an operation that cannot clear the finding. Clear
that one field explicitly instead:

```bash
curl -s -X PUT "$BASE/api/filaments/$TEMPLATE_ID" -H 'Content-Type: application/json' \
  -d '{"lowStockThreshold": null}'
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

**A template with no temperatures is fine.** So is a variant with no density. Neither is a finding.

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
restores inheritance.

## What NOT to fix automatically

A missing temperature, density or spool weight is missing *data*, not a broken value, and it needs
a real source. Do not fill it from a polymer handbook, a sibling filament or an average — hand it to
`add-filament`, whose whole discipline is where a number came from. A blank field is visibly
missing; a plausible invented one is not.

Report first, fix on request. Group by severity, name the records, and say plainly which findings
are latent and which are live.
