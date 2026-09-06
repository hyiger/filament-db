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

## Two traps that make a naive audit worse than none

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

## What it checks, worst first

**Abrasive flag mismatch — the only category with physical consequences.** `optTags` id 4 and
`settings.filament_abrasive` are read by *different consumers*: the app's nozzle picker honours the
tag, while the **exporter reads only the setting**, and that is the value a firmware `M862.1` check
sees. They diverge silently, and the common cause is benign — the FilamentForm writes the setting
from its own checkbox, so saving a record that was tagged some other way stamps `'0'`, an *active
assertion that a carbon-filled filament is not abrasive*. Treat `tag 4 + setting '0'` as the top
finding in any report.

**Inventory blockers.** `computeRemaining` returns null the moment `spoolWeight` is null, before it
ever reaches the percentage, and the bar divides by `netFilamentWeight`. A live spool on a filament
missing either one tracks a gross number and nothing else — the record looks complete, the bar is
simply blank, and no error was ever raised. Also catches a spool whose gross weight is below its
own tare.

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
stranded on a template is the serious case — its spools are invisible to the family's stats. The
remedy is the **Convert to template** action on the parent (`POST /api/filaments/{id}/promote`),
never a hand-written `PUT`.

**Pinned inheritance.** A variant storing a value byte-identical to its template's is a copy that
looks right today and stops following the template the day it is edited. Latent, never urgent, and
worth reporting as such rather than alarming about it.

**Nozzle compatibility** — an abrasive-tagged filament permitted on a nozzle whose `hardened` flag
is false. Note the INDX nozzle is nitrocarburized, i.e. surface-treated only; its own record says it
is "not a substitute for a hardened nozzle on fibre-filled or metal-filled grades".

**Colour** — malformed hex, and the legacy `#808080` sentinel the pre-v1.70 form stamped on
everything.

## False positives, learned by hitting them

**`#808080` on a filament whose colorName is "Grey" is correct**, not a sentinel — grey filament is
that colour. The checker exempts it; do not "fix" one by hand either.

**A CF/GF filament without tag 4 may carry no exposure at all** if its `compatibleNozzles` already
lists only hardened nozzles. Check before escalating: the finding is about metadata consistency,
not an imminent nozzle death.

**Wood-fill is a judgement call.** The type heuristic flags it as abrasive; wood fill is mildly
abrasive at most, and the user may reasonably have decided it does not warrant the tag.

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
