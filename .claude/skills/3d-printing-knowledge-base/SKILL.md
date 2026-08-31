---
name: 3d-printing-knowledge-base
description: Answer questions about the user's 3D printing filament library, calibration values, polymer properties, and printing parameters using their local knowledge base and the Filament DB REST API. Use this skill whenever the user asks about a specific filament, a calibration value (extrusion multiplier, pressure advance, shrinkage, max volumetric speed), nozzle or bed temperatures, drying schedules, spool inventory, polymer chemistry, or anything about their own materials and printers — even if they do not mention Filament DB, the wiki, or an API by name. Also use it before answering any question where a wrong number would ruin a print, and whenever adding new reference material to the knowledge base.
---

# 3D printing knowledge base

This project holds three kinds of material, and they are not equally
trustworthy. Almost every way this skill can fail is a failure to keep them
apart.

## Layout

```
3d-printing-kb/
├── filament-db.wiki/   "FDM Polymers: A Technical Reference" — a git clone of
│                       the published volume. Materials science, not app
│                       documentation. READ ONLY.
├── authored/       →   a symlink to filament-db.wiki/. One directory under two
│                       names; the paths cannot diverge. READ ONLY.
├── external/           Third-party material. The ONLY writable directory.
└── scripts/       →   a symlink to wherever THIS skill is installed, so the
                       `scripts/...` invocations below resolve from the KB root.
```

Point it at the copy you are actually running. In a project checkout that is
the repository's own `.claude/skills/`, not `~/.claude/skills/` — nothing
installs it there, so a home-directory link would simply dangle and every
`scripts/…` command below would fail:

```bash
# from the knowledge-base root, pointing at the project checkout:
ln -s /path/to/filament-db/.claude/skills/3d-printing-knowledge-base/scripts scripts
```

Or skip the link and invoke the scripts by their full path — the commands below
are written relative to the KB root only for readability.

Plus the live Filament DB REST API on `http://localhost:3456`.

## Source precedence

When two sources disagree, the higher one wins. Do not average them, reconcile
them, or present both as equally valid.

1. **Filament DB API** — authoritative for anything about a specific filament
   record: calibration values, spool inventory, stored temperatures.
2. **`authored/`** and **`filament-db.wiki/`** — the same document at two paths:
   "FDM Polymers: A Technical Reference". Authoritative for polymer behaviour,
   process guidance, and G-code semantics. It is accuracy-reviewed pass by pass,
   carries its own source ledger, and states the basis of every figure it
   publishes.
3. **`external/`** — background only. Never authoritative for anything.

These are two names for one directory — `authored/` is a symlink to
`filament-db.wiki/` — so they cannot diverge, and finding the same figure down
both paths is not corroboration. Reading through `authored/` also exposes the
repository's tooling (`Makefile`, `claims.json`, the check scripts, `hooks/`,
`tests/`): that machinery maintains the volume and is not reference content.

If a lower tier contradicts a higher one, follow the higher one and say the
conflict exists.

## The rule that governs everything

**Never state a value you did not just retrieve.**

These numbers drive real prints. A wrong extrusion multiplier wastes a spool and
an eight-hour print; a wrong nozzle temperature can clog a hotend. If a lookup
fails, say it failed. Do not fall back on a plausible-sounding value, a value
from earlier in the conversation, or a typical figure for the material. "I could
not reach the API" is a useful answer. A confident wrong number is not.

## Processing parameters have a restricted source list

Any number that would go into a slicer or a printer — nozzle temperature, bed
temperature, chamber temperature, drying temperature and time, extrusion
multiplier, pressure advance, shrinkage compensation, max volumetric speed, fan
speeds, retraction — may come **only** from the API or from the technical
reference (either path).

Never take one from `external/`, and never derive one from polymer chemistry.

Nor from a family band. The reference publishes envelopes across a whole family
*and* values for named grades, and they are different claims: a family band
brackets what an unbranded grade is likely to need, while the printable number
belongs to the spool in front of you. Quote the named grade where the volume
has one, and where it only has a band, say it is a band and that the spool's own
datasheet governs.

This is the most likely way to give a damaging answer, because the two look
similar and are not:

| Property | Typical source value | Family band (NOT a printable value — look the record up) |
|---|---|---|
| PA6 melting point | ~220 °C | nozzle 260–280 °C |
| PPS melting point | ~280 °C | PPS-CF nozzle 320–350 °C |
| PC glass transition | ~147 °C | nozzle 260–290 °C |

A melting point is not a nozzle temperature. A glass transition is not a bed
temperature. If `external/` is the only place a number appears, report that no
verified value exists rather than passing the chemistry figure along.

## Adding material to `external/`

New reference material goes in `external/` and nowhere else. Use the helper so
provenance is recorded correctly:

```bash
scripts/new-external.sh URL SLUG          # both required
# e.g. scripts/new-external.sh https://en.wikipedia.org/wiki/Polyphenylene_sulfide pps
```

It creates `external/<slug>.md` with the required front matter already filled
in. Write the body below it; leave the metadata block intact.

Every file in `external/` must carry:

```yaml
---
source:    "<url or citation>"
retrieved: <YYYY-MM-DD>
trust:     background
scope:     "<what this file may be used for>"
---
```

The two free-text fields are quoted and the two constrained ones are not — that
is what `new-external.sh` emits, and what `check-provenance.sh` accepts. An
unquoted citation containing a colon, a `#`, or a leading `[` is not the string
you meant, so prefer the generator over hand-writing this block.

A file in `external/` without front matter is untrusted — flag it to the user
rather than reading from it. `scripts/check-provenance.sh` audits the directory.

It also smells for processing parameters, since tier 4 must never carry them.
That half is a **heuristic** and says so: it matches phrases like "nozzle temp"
in the prose, so a citation whose filename happens to contain those words —
`.../pa6-cf-bed-temp-chart.pdf` — will trip it. When that happens and the text
really is a citation rather than a setting, say so in the file:

```
<!-- allow-param-smell: filename contains the words, not a processing value -->
```

The reason is required, and suppressed files are listed in the audit output, so
a file cannot opt out silently. Prefer the marker over rewording a citation:
the point is that the exception is visible to the next reader.

**Licensing.** Much external material is copyleft (Wikipedia is CC BY-SA).
Keeping it in `external/`, out of the published wiki, and attributed in front
matter is what keeps that manageable. Never copy external content into
`filament-db.wiki/` or `authored/`.

## Write scope

- `external/` — writable.
- `authored/`, `filament-db.wiki/` — read only, and the same directory: writing
  through either path writes to a live git clone of a published repo, dirtying
  the working tree and risking publication of third-party content.
- Never `git commit`, `git push`, or `git checkout` inside it, by either name.
  Refreshing it is the user's job (`git pull`).

If a request seems to need writing outside `external/`, describe the change and
let the user confirm first.

## Answering from files

State which tier an answer came from. "From the technical reference, §8.3 (PCTG
filament property envelope by brand)" and "from the Wikipedia article in
`external/`" carry very different weight, and the user needs to know which they
got. Cite the reference by its own section or table number rather than by which
of its two paths you happened to read.

Cite the specific file. Never blend an `authored/` figure and an `external/`
figure into one sentence without marking which is which.

---

# Filament DB API

## Preflight — do this first, every session

```bash
scripts/fdb.sh check
```

Expect `OK — API reachable`. If it errors:

- **Connection refused** — the app is not running. Tell the user to open the
  Filament DB Electron app, or run `npm run dev` in the repo. Stop; do not
  answer from memory.
- **HTTP 401** — this instance has `FILAMENTDB_API_KEY` set. That gate is
  enforced in `src/proxy.ts` across `/api/:path*` with no same-origin exemption,
  so it applies to every request including yours. Ask the user for the key and
  `export FILAMENTDB_API_KEY=...` before retrying.
- **HTTP 403** — not this app. Its gate answers 401 and only 401, so a 403 came
  from something in front of it (a proxy, a gateway, an allow-list) and an API
  key cannot resolve it. Report the status; do not ask for a key.

## Inheritance — the thing that silently gives wrong answers

A parent filament is a **template**. A variant that inherits a value stores
`null` as the inherit sentinel, and the real value is resolved at read time from
the parent by `resolveFilament`.

So a raw collection read of a variant shows `null` for a field whose effective
value sits on its parent. That does not look like an error. It looks like
missing data.

- Use the **single-record route** (`/api/filaments/{id}`, via `fdb.sh detail`)
  for any calibration question. It goes through the app's resolution logic.
- Treat `null` from the **list** endpoint as "unknown, look it up properly",
  never as "not set".
- If a field is genuinely absent after a single-record fetch, say so rather than
  substituting a default.

## Commands

| Command | Use for |
|---|---|
| `fdb.sh check` | Preflight. Always first. |
| `fdb.sh list` | Overview — name, material, brand, spool count. |
| `fdb.sh find <text>` | Locate a filament by partial name. Returns ids. |
| `fdb.sh detail <name>` | Full resolved record — the unprojected route, so project it. **Use for calibration.** Exact name wins, else a unique substring. |
| `fdb.sh schema` | Actual field names on a real record. |
| `fdb.sh get <path>` | Any other endpoint. |

Prefer these over hand-written curl and jq — the script already handles auth,
connection failure, non-JSON responses, and the several shapes the list endpoint
can return.

**Do not guess field names.** The schema has evolved across many releases.
Run `fdb.sh schema` once and work from what it reports. A guessed name yields
`null`, and `null` here is indistinguishable from an inherit sentinel.

**Do not guess endpoint paths.** A 404 means the route does not exist on this
version. Ask the user rather than trying variations. Known routes include
`/api/filaments`, `/api/filaments/{id}`, `/api/filaments/match`,
`/api/spools/by-location`, `/api/spools/{spoolId}`, `/api/print-history`,
`/api/analytics`, and per-slicer exports at
`/api/filaments/{id}/{prusaslicer,orcaslicer,bambustudio}` — those return `.ini`
/`.json` FILES, not an API envelope, so `fdb.sh` refuses them as non-JSON and
names the Content-Type when it does. Fetch one directly if you actually want it.

## Context discipline

It is the SINGLE-RECORD route that is expensive, not the list. `GET
/api/filaments` is a projection — 19 fields, no `settings`, no `usageHistory`,
no `dryCycles`, no photos. `GET /api/filaments/{id}` is the unprojected one: 51
fields including the `settings` passthrough bag and every spool's photo, which
is why `fdb.sh detail` is the command to be careful with, even though it is
also the one you must use for calibration.

Never pipe a raw response into your reasoning context. `fdb.sh list` and
`fdb.sh find` already project down. When you need a detail record, project at
the boundary:

```bash
scripts/fdb.sh get /api/filaments/ID | jq '{name, temperatures, shrinkageXY}'
```

## Read-only

Do not `POST`, `PUT`, `PATCH`, or `DELETE` against the API, and do not run the
slicer sync routes — those mutate stored records. Describe the change and let
the user confirm.

## Ambiguity

If a name matches more than one filament, `fdb.sh detail` refuses and reports
how many matched. That refusal is deliberate. Show the candidates from
`fdb.sh find` and ask which was meant. Never pick one because it seems most
likely — calibration values are per filament *and* per nozzle, and neighbouring
records often differ only in nozzle size.

## Answer format

For a calibration lookup, report:

1. The exact filament record name matched.
2. The values retrieved, unchanged — do not round, reformat, or normalise units.
3. Nozzle or printer context, when the record carries it.
4. Any field that came back empty, stated as empty.

Preserve significant figures exactly. An extrusion multiplier of `0.898` is not
`0.9`.
