#!/usr/bin/env python3
"""
Inheritance-aware validity audit of a Filament DB library.

Usage:
    python3 audit.py [--base http://localhost:3456] [--api-key KEY]
                     [--cache DIR] [--only CATEGORY,...] [--json]

Fetches every filament TWICE — resolved (what the app and the slicer see) and
`?raw=true` (what is actually stored) — because the single most common way to
produce a useless filament audit is to read stored documents and report every
inherited-and-therefore-null field as "missing". On a library with templates
that is most of the output, and it buries the real findings.

Abrasive findings are NOT computed here. They come from the app's own
`/api/abrasive-nozzles`, which is the authoritative implementation
(src/lib/abrasiveNozzleAudit.ts) and is unit-tested. Reimplementing it in this
script produced a strictly worse duplicate: it missed every abrasive OPT tag
except 4 (the real set is 0, 1, 4, 19-24, 31, 32), compared `filament_abrasive`
by identity so a legitimate per-extruder `['1','1']` read as "off", called a
setting-only record unrestricted when FilamentForm computes
`abrasive || optTags.includes(4)`, audited non-printable templates as stock, and
treated a soft-deleted nozzle reference as a safe assignment. Ask the app.

Exit status is 0 even when findings exist: this reports, it does not gate.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# resolveFilament's own INHERITABLE_FIELDS, minus three that every variant
# stores by construction and would therefore report as pinned every time:
# `vendor` and `type` are required by POST /api/filaments, and `diameter` is
# materialised by a schema default of 1.75.
PIN_CHECK_FIELDS = [
    "cost", "density", "maxVolumetricSpeed", "spoolWeight", "netFilamentWeight",
    "dryingTemperature", "dryingTime", "transmissionDistance", "glassTempTransition",
    "heatDeflectionTemp", "shoreHardnessA", "shoreHardnessD", "minPrintSpeed",
    "maxPrintSpeed", "spoolType", "tdsUrl", "inherits", "shrinkageXY", "shrinkageZ",
]

# `temperatures` is a subdocument resolved SUBFIELD BY SUBFIELD, so each one
# pins independently — a variant storing its template's nozzle temp stops
# tracking it exactly like a top-level field would.
PIN_CHECK_TEMPS = [
    "nozzle", "nozzleFirstLayer", "bed", "bedFirstLayer",
    "nozzleRangeMin", "nozzleRangeMax", "standby",
]

# `resolveFilament` inherits these arrays WHOLE when the variant's own is empty
# (GH #106/#477), so a variant storing a non-empty array equal to its template's
# is a pin exactly like a scalar. `compatibleNozzles` is handled separately
# because the resolved read populates it into objects while the raw read keeps
# bare ids.
PIN_CHECK_ARRAYS = ["optTags", "secondaryColors", "bedTypeTemps", "calibrations", "presets"]

# Stripped from a template on write (v1.70 #605). Present on one = legacy shape.
TEMPLATE_STRIP = ["color", "colorName", "totalWeight", "lowStockThreshold"]


def _strip_ids(value):
    """Compare array contents, not their subdocument identity."""
    if isinstance(value, list):
        return [_strip_ids(v) for v in value]
    if isinstance(value, dict):
        return {k: _strip_ids(v) for k, v in sorted(value.items()) if k not in ("_id", "id")}
    return value


def _json_equal(a, b):
    """Equality with JSON type semantics.

    Python treats True == 1 and False == 0, but the JavaScript shallow merge does
    not consider those values identical, so a numeric template value against a
    boolean variant value would be reported as a redundant pin and the user told
    to delete a deliberate override.
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_json_equal(a[k], b[k]) for k in a)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b          # JS has one number type: 1 and 1.0 are the same
    return type(a) is type(b) and a == b


def _nozzle_ids(value):
    out = []
    for entry in value or []:
        ref = entry.get("_id") if isinstance(entry, dict) else entry
        if ref is not None:
            out.append(str(ref))
    return sorted(out)

# Materials that legitimately print below the general FFF floor. The bundled
# technical reference documents PCL 100 at ~120 C and the orthotic Facilan Ortho
# at 130-170 C, with the polymer softening near 60 C — a flat 150 C floor would
# call every one of those a validity error.
LOW_TEMP_TYPES = ("PCL",)

# Metal-filled composites are legitimately far denser than any unfilled polymer —
# copper- and bronze-filled PLA sit around 3-4 g/cm3 — and the schema permits any
# non-negative density. Applying an unfilled-polymer ceiling to them would report
# correct data as invalid and invite a "fix" that corrupts every weight-to-length
# calculation downstream.
# Evidence is the OPT tag ALONE. Name matching is not safe here: "Metallic Grey"
# and "Steel Blue" are pigments, and the app's own classifier requires the word
# "fill" after metal/steel/iron for exactly that reason. A bare name match would
# raise the ceiling to 12 for an ordinary filament and let a corrupt 4 g/cm3
# through — a false negative in place of a false positive, which is worse.
OPT_TAG_METAL_FILL = 20
DENSITY_CEILING = 2.5
DENSITY_CEILING_FILLED = 12.0
DENSITY_FLOOR = 0.7

# Bounds mirrored from the Filament schema. A value outside these cannot be
# written through the API, so a violation means the row arrived by a path that
# bypassed validation — a raw-driver sync copy, a snapshot restore, or a legacy
# write — and both slicer exporters serialise these straight into the preset.
# `density` and `diameter` are deliberately absent: they have richer,
# material-aware checks of their own and would otherwise be reported twice.
NUMERIC_BOUNDS = {
    "cost": (0, None), "maxVolumetricSpeed": (0, None), "lowStockThreshold": (0, None),
    "transmissionDistance": (0, None), "minPrintSpeed": (0, None), "maxPrintSpeed": (0, None),
    "spoolWeight": (0, None), "netFilamentWeight": (0, None), "totalWeight": (0, None),
    "glassTempTransition": (-50, 500), "heatDeflectionTemp": (-50, 500),
    "shoreHardnessA": (0, 100), "shoreHardnessD": (0, 100),
    "shrinkageXY": (0, 100), "shrinkageZ": (0, 100),
    "dryingTemperature": (0, 300), "dryingTime": (0, 10080),
}
# Calibration numerics OTHER than the temperatures, which the temperature pass
# already checks against the declared range and the type-aware band.
CALIBRATION_BOUNDS = {
    "extrusionMultiplier": (0, None), "maxVolumetricSpeed": (0, None),
    "pressureAdvance": (0, None), "retractLength": (0, None),
    "retractSpeed": (0, None), "retractLift": (0, None),
    "fanMinSpeed": (0, 100), "fanMaxSpeed": (0, 100), "fanBridgeSpeed": (0, 100),
}
CHAMBER_MAX = 300   # schema bound; PEEK runs an active chamber at 150-200 C

# Cross-field ORDERING. Each endpoint can satisfy its own bound while the pair is
# contradictory, so per-field bounds can never catch these — the nozzle range was
# checked from the start and the other two were not, which is the whole reason
# this is a table rather than three conditions.
ORDERED_PAIRS = [("nozzle range", "nozzleRangeMin", "nozzleRangeMax")]      # in `temperatures`
ORDERED_PAIRS_TOP = [("print speed", "minPrintSpeed", "maxPrintSpeed")]     # top level
ORDERED_PAIRS_CAL = [("fan speed", "fanMinSpeed", "fanMaxSpeed")]           # per calibration

# The declared nozzle-range ENDPOINTS are themselves schema-bounded and are
# exported verbatim (filamentToOrcaSlicerKeys writes nozzle_temperature_range_low
# / _high), so a range of -10..700 exports while containing a valid nozzle temp.
RANGE_BOUNDS = {"nozzleRangeMin": (0, 600), "nozzleRangeMax": (0, 600)}
PRESET_BOUNDS = {"extrusionMultiplier": (0, None)}
# Per-spool and ledger numerics. Not filament spec, but they are the same class
# of "written by a path that bypassed validation" evidence and analytics reads
# them. MAX_USAGE_GRAMS mirrors src/lib/capUsageHistory.ts.
SPOOL_BOUNDS = {"totalWeight": (0, None)}
DRY_CYCLE_BOUNDS = {"tempC": (0, 300), "durationMin": (0, None)}
USAGE_BOUNDS = {"grams": (0, 1_000_000)}
# `debitedGrams` is declared with NO min/max (src/models/Filament.ts), so a bad
# value is NOT a schema violation and must not be reported as one. It is still
# corrupt: the refund path states a genuine clamped debit can never exceed the
# entry's grams, and falls back to a full-grams refund when it does.
SEMANTIC_BOUNDS_USAGE = {"debitedGrams": (0, 1_000_000)}
ORDERED_PAIRS_USAGE = [("debited vs requested grams", "debitedGrams", "grams")]
LOW_TEMP_FLOOR = 60
NOZZLE_FLOOR = 150
NOZZLE_CEILING = 450

HEX6 = re.compile(r"#[0-9A-Fa-f]{6}\Z")

CATEGORIES = [
    ("abrasive",     "ABRASIVE / NOZZLE SAFETY (from the app's own audit)"),
    ("inventory",    "INVENTORY / REMAINING-BAR BLOCKERS"),
    ("drying-units", "DRYING TIME UNIT ERRORS (the field is MINUTES)"),
    ("temps",        "TEMPERATURE VALIDITY"),
    ("physical",     "PHYSICAL VALUES"),
    ("missing-core", "MISSING CORE SPEC (effective, after inheritance)"),
    ("template",     "TEMPLATE HOLDING COLOUR / INVENTORY (v1.70)"),
    ("pinned",       "PINNED INHERITANCE (variant copies its template's value)"),
    ("structure",    "STRUCTURAL INTEGRITY"),
    ("nozzles",      "NOZZLE ASSIGNMENT"),
    ("colour",       "COLOUR"),
]


def fetch(url, api_key=None, timeout=30):
    req = urllib.request.Request(url)
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def load(base, api_key, cache_dir=None):
    """Return (records, abrasive_findings). records[id] = {'res':…, 'raw':…}."""
    try:
        listing = fetch(f"{base}/api/filaments", api_key)
    except urllib.error.HTTPError as e:
        sys.exit(f"lookup failed: HTTP {e.code}. 401 = this instance sets FILAMENTDB_API_KEY; pass --api-key.")
    except Exception as e:
        sys.exit(f"lookup failed: {e}. Is the app running at {base}?")

    if not isinstance(listing, list):
        sys.exit("unexpected /api/filaments response shape")
    ids = [f["_id"] for f in listing]
    if not ids:
        sys.exit("no filaments returned — refusing to report a clean audit of an empty read")

    def one(i):
        res = fetch(f"{base}/api/filaments/{i}", api_key)
        raw = fetch(f"{base}/api/filaments/{i}?raw=true", api_key)
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
            json.dump(res, open(os.path.join(cache_dir, f"{i}.resolved.json"), "w"))
            json.dump(raw, open(os.path.join(cache_dir, f"{i}.raw.json"), "w"))
        return i, {"res": res, "raw": raw}

    with ThreadPoolExecutor(max_workers=8) as pool:
        records = dict(pool.map(one, ids))

    # The authoritative abrasive audit. A failure here must be visible, not
    # silently rendered as "no abrasive problems".
    try:
        abrasive = fetch(f"{base}/api/abrasive-nozzles", api_key).get("findings", [])
    except Exception as e:
        abrasive = {"error": str(e)}
    return records, abrasive


def audit(records, abrasive):
    findings = {}

    def add(cat, msg, fid=None):
        # Keyed on (record id, message), not text alone: hybrid sync, a restore or
        # a legacy database can leave two ACTIVE records sharing a name, and every
        # message identifies a filament by name. Deduping on text would collapse
        # two real defects into one row and hide the second record entirely.
        findings.setdefault(cat, []).append((fid, msg))

    # Filaments the authoritative audit already reported as having no nozzle
    # assignment. The generic check below must not restate the same defect.
    abrasive_unassigned = set()

    # --- abrasive: report what the app determined, do not re-derive ----------
    if isinstance(abrasive, dict) and "error" in abrasive:
        add("abrasive", f"COULD NOT REACH /api/abrasive-nozzles ({abrasive['error']}) — "
                        f"abrasive safety was NOT checked")
    else:
        for f in abrasive:
            name = f.get("filamentName", "?")
            why = ", ".join(f.get("reasons") or []) or "abrasive"
            src = f" (inherited from {f['inheritedFrom']})" if f.get("inheritedFrom") else ""
            soft = [n.get("name") for n in (f.get("softNozzles") or [])]
            if f.get("flagMismatch"):
                add("abrasive", f"{name}: material reads abrasive ({why}) but settings.filament_abrasive "
                                f"is not on -> EXPORTS AS NON-ABRASIVE{src}", str(f.get("filamentId")))
            if soft:
                add("abrasive", f"{name}: abrasive ({why}) but permitted on unfit nozzle(s) {soft}{src}",
                    str(f.get("filamentId")))
            if f.get("unassigned"):
                abrasive_unassigned.add(str(f.get("filamentId")))
                add("abrasive", f"{name}: abrasive ({why}) with no nozzle assignment at all{src}",
                    str(f.get("filamentId")))

    # Template-ness is DERIVED from having variants — there is no schema flag.
    # Restricted to ids that are actually present: an active variant can point at
    # a missing or soft-deleted parent, and counting that absent id would report a
    # template that does not exist (the structural check below reports the
    # dangling link itself).
    parents = {str(v["raw"]["parentId"]) for v in records.values()
               if v["raw"].get("parentId") and str(v["raw"]["parentId"]) in records}

    for fid, v in records.items():
        r, raw = v["res"], v["raw"]
        name = r.get("name", "?")
        temps = r.get("temperatures") or {}
        is_template = fid in parents
        all_spools = r.get("spools") or []
        live_spools = [s for s in all_spools if not s.get("retired")]

        # --- settings bag shape ----------------------------------------------
        # `settings` is Mixed, so a legacy row can hold a string or an array.
        # Checked for EVERY record, not just variants: resolveFilament spreads a
        # parent's bag into each child's effective settings, so a malformed one on
        # a template reaches every colour in the family and its slicer exports,
        # and a standalone never enters the pin block at all.
        own_settings = raw.get("settings")
        if own_settings is not None and not isinstance(own_settings, dict):
            where = " (TEMPLATE — this spreads into every variant's effective settings " \
                    "and their slicer exports)" if is_template else ""
            add("physical", f"{name}: settings is {type(own_settings).__name__}, not an object -> "
                            f"malformed bag{where}", fid)

        # --- inventory: what makes the remaining bar work --------------------
        # A pre-migration record carries its stock on the TOP-LEVEL totalWeight
        # with no spools[] subdocument, and the app counts that as one tracked
        # spool (getSpoolCount, and getRemainingPct's second branch). Auditing
        # only spools[] would skip exactly the legacy records this skill exists
        # to find. Note the branch selection keys off spools being non-empty at
        # ALL, retired included — matching getRemainingPct.
        legacy_roll = not all_spools and r.get("totalWeight") is not None
        if live_spools or legacy_roll:
            unit = "legacy top-level roll" if legacy_roll else f"{len(live_spools)} live spool(s)"
            net = r.get("netFilamentWeight")
            # getRemainingPct rejects a non-positive denominator, not just null.
            if net is None or net <= 0:
                add("inventory", f"{name}: {unit} but netFilamentWeight={net!r} -> no % bar", fid)
            tare = r.get("spoolWeight")
            if tare is None:
                add("inventory", f"{name}: {unit} but no spoolWeight (tare) -> "
                                 f"computeRemaining returns null, nothing displays", fid)

            if legacy_roll:
                gross = r.get("totalWeight")
                if tare is not None and gross < tare:
                    add("inventory", f"{name}: legacy gross {gross}g is below tare {tare}g -> negative remaining", fid)
            else:
                missing_gross = 0
                for s in live_spools:
                    gross = s.get("totalWeight")
                    if gross is None:
                        # Schema-supported, but getRemainingPct skips such a spool
                        # and returns null outright when none is left countable.
                        missing_gross += 1
                        add("inventory", f"{name}: live spool {s.get('instanceId') or s.get('_id')} has no "
                                         f"totalWeight (gross) -> it contributes nothing to the bar", fid)
                    elif tare is not None and gross < tare:
                        add("inventory", f"{name}: spool gross {gross}g is below tare {tare}g -> negative remaining", fid)
                if missing_gross and missing_gross == len(live_spools):
                    add("inventory", f"{name}: every live spool is missing its gross weight -> "
                                     f"getRemainingPct returns null, no bar at all", fid)

        # --- drying: the field is minutes, every datasheet says hours --------
        dry_t, dry_temp = r.get("dryingTime"), r.get("dryingTemperature")
        # Gated on a drying TEMPERATURE being present: without it, a small value
        # may be a deliberate duration rather than an hours-for-minutes slip, and
        # this is the documented heuristic.
        if isinstance(dry_t, (int, float)) and 0 < dry_t <= 24 and dry_temp is not None:
            add("drying-units", f"{name}: dryingTime={dry_t} at {dry_temp}C — the field is MINUTES; "
                                f"{dry_t} hours would be {int(dry_t * 60)}", fid)

        # --- temperatures ----------------------------------------------------
        # The schema carries temperatures in FIVE places, and every one of them
        # resolves and exports independently: the top-level `temperatures`,
        # per-plate `bedTypeTemps`, per-calibration overrides, per-preset blocks,
        # and the standby value. Checking only the first two let malformed data
        # reach a slicer preset while the values beside it looked valid — three
        # separate review rounds each found the next unchecked site. So collect
        # every temperature the record carries FIRST, then check them uniformly;
        # a new temperature-bearing field needs adding to one of these lists and
        # nothing else.
        noz, lo, hi, bed = (temps.get("nozzle"), temps.get("nozzleRangeMin"),
                            temps.get("nozzleRangeMax"), temps.get("bed"))
        nfl, bfl = temps.get("nozzleFirstLayer"), temps.get("bedFirstLayer")
        def ordering_check(container, pairs, cat, where=""):
            if not isinstance(container, dict):
                return
            for label, f_lo, f_hi in pairs:
                a, b = container.get(f_lo), container.get(f_hi)
                if isinstance(a, (int, float)) and isinstance(b, (int, float)) and a > b:
                    add(cat, f"{name}: {where}INVERTED {label} — {f_lo}={a} is above {f_hi}={b}", fid)

        ordering_check(temps, ORDERED_PAIRS, "temps")
        ordering_check(r, ORDERED_PAIRS_TOP, "physical")

        nozzle_like = [("nozzle", noz), ("nozzleFirstLayer", nfl)]
        bed_like = [("bed", bed), ("bedFirstLayer", bfl)]

        for idx, cal in enumerate(r.get("calibrations") or []):
            if not isinstance(cal, dict):
                continue
            nz = cal.get("nozzle")
            noz_name = nz.get("name") if isinstance(nz, dict) else None
            where = f"calibration[{idx}]" + (f" ({noz_name})" if noz_name else "")
            # populate() returns null for a PURGED nozzle and an object still
            # carrying _deletedAt for a soft-deleted one. Neither can be
            # diameter-matched by the dynamic calibration route, and the Prusa
            # bundle drops such a row from its per-nozzle fan-out, so valid
            # tuning silently becomes unreachable.
            if nz is None:
                add("structure", f"{name}: calibration[{idx}] references a nozzle that no longer "
                                 f"exists -> the tuning is unreachable", fid)
            elif isinstance(nz, dict) and nz.get("_deletedAt"):
                add("structure", f"{name}: calibration[{idx}] references soft-deleted nozzle "
                                 f"{noz_name!r} -> the tuning is unreachable", fid)
            ordering_check(cal, ORDERED_PAIRS_CAL, "physical", f"{where} ")
            nozzle_like += [(f"{where} nozzleTemp", cal.get("nozzleTemp")),
                            (f"{where} nozzleTempFirstLayer", cal.get("nozzleTempFirstLayer"))]
            bed_like += [(f"{where} bedTemp", cal.get("bedTemp")),
                         (f"{where} bedTempFirstLayer", cal.get("bedTempFirstLayer"))]
            chamber = cal.get("chamberTemp")
            if chamber is not None and not 0 <= chamber <= CHAMBER_MAX:
                add("temps", f"{name}: {where} chamberTemp {chamber}C outside 0-{CHAMBER_MAX}C", fid)

        # Per-plate overrides: filamentToOrcaSlicerKeys writes BOTH temperature
        # and firstLayerTemperature from this array into the exported preset,
        # overriding the otherwise-valid base values.
        for bt in (r.get("bedTypeTemps") or []):
            if not isinstance(bt, dict):
                continue
            plate = bt.get("bedType") or "?"
            bed_like += [(f"bedTypeTemps[{plate}] temperature", bt.get("temperature")),
                         (f"bedTypeTemps[{plate}] firstLayerTemperature", bt.get("firstLayerTemperature"))]

        for idx, pre in enumerate(r.get("presets") or []):
            if not isinstance(pre, dict):
                continue
            label = pre.get("label") or idx
            pt = pre.get("temperatures") or {}
            if not isinstance(pt, dict):
                continue
            nozzle_like += [(f"preset[{label}] nozzle", pt.get("nozzle")),
                            (f"preset[{label}] nozzleFirstLayer", pt.get("nozzleFirstLayer"))]
            bed_like += [(f"preset[{label}] bed", pt.get("bed")),
                         (f"preset[{label}] bedFirstLayer", pt.get("bedFirstLayer"))]

        typ_upper = (r.get("type") or "").upper()
        floor = LOW_TEMP_FLOOR if any(t in typ_upper for t in LOW_TEMP_TYPES) else NOZZLE_FLOOR
        for label, val in nozzle_like:
            if val is None:
                continue
            if lo is not None and val < lo:
                add("temps", f"{name}: {label} {val} is BELOW the declared range min {lo}", fid)
            if hi is not None and val > hi:
                add("temps", f"{name}: {label} {val} is ABOVE the declared range max {hi}", fid)
            if not floor <= val <= NOZZLE_CEILING:
                add("temps", f"{name}: {label} {val}C outside the plausible band for "
                             f"{r.get('type') or '?'} ({floor}-{NOZZLE_CEILING}C)", fid)
        for label, val in bed_like:
            if val is not None and not 0 <= val <= 200:
                add("temps", f"{name}: {label} {val}C implausible", fid)
        # Standby is an IDLE temperature, legitimately far below the print window,
        # so only its ceiling is meaningful.
        standby = temps.get("standby")
        if standby is not None and not 0 <= standby <= NOZZLE_CEILING:
            add("temps", f"{name}: standby {standby}C implausible", fid)

        # --- physical --------------------------------------------------------
        dens = r.get("density")
        metal_filled = OPT_TAG_METAL_FILL in (r.get("optTags") or [])
        ceiling = DENSITY_CEILING_FILLED if metal_filled else DENSITY_CEILING
        if dens is not None and not DENSITY_FLOOR <= dens <= ceiling:
            kind = "metal-filled" if metal_filled else "unfilled polymer"
            hint = ("" if metal_filled else
                    " — if this really is metal-filled, add optTag 20 (METAL_FILL), which also "
                    "corrects its abrasive classification")
            add("physical", f"{name}: density {dens} g/cm3 outside the plausible {kind} range "
                            f"({DENSITY_FLOOR}-{ceiling}){hint}", fid)
        dia = r.get("diameter")
        if dia is not None and not any(abs(dia - d) < 0.06 for d in (1.75, 2.85, 3.0)):
            add("physical", f"{name}: diameter {dia}mm is not a standard size", fid)
        def bounds_check(container, table, where=""):
            if not isinstance(container, dict):
                return
            for f2, (bmin, bmax) in table.items():
                val = container.get(f2)
                if not isinstance(val, (int, float)) or isinstance(val, bool):
                    continue
                if (bmin is not None and val < bmin) or (bmax is not None and val > bmax):
                    rng = f"{bmin}-{bmax}" if bmax is not None else f">= {bmin}"
                    add("physical", f"{name}: {where}{f2}={val} outside the schema bound ({rng}) -> "
                                    f"written by a path that bypassed validation", fid)

        bounds_check(r, NUMERIC_BOUNDS)
        bounds_check(temps, RANGE_BOUNDS)
        for idx, pre in enumerate(r.get("presets") or []):
            if isinstance(pre, dict):
                bounds_check(pre, PRESET_BOUNDS, f"preset[{pre.get('label') or idx}] ")
        for sp in (r.get("spools") or []):
            if not isinstance(sp, dict):
                continue
            tag = sp.get("instanceId") or sp.get("_id")
            bounds_check(sp, SPOOL_BOUNDS, f"spool {tag} ")
            for dc in (sp.get("dryCycles") or []):
                bounds_check(dc, DRY_CYCLE_BOUNDS, f"spool {tag} dryCycle ")
            for ue in (sp.get("usageHistory") or []):
                bounds_check(ue, USAGE_BOUNDS, f"spool {tag} usage ")
                # Same shape, different provenance — say which, because "outside
                # the schema bound" would be a false claim for this field.
                if isinstance(ue, dict):
                    for f2, (bmin, bmax) in SEMANTIC_BOUNDS_USAGE.items():
                        val = ue.get(f2)
                        if isinstance(val, (int, float)) and not isinstance(val, bool) \
                                and not (bmin <= val <= bmax):
                            add("physical", f"{name}: spool {tag} usage {f2}={val} is implausible "
                                            f"(no schema bound on this field, so the API would "
                                            f"accept it)", fid)
                ordering_check(ue, ORDERED_PAIRS_USAGE, "physical", f"spool {tag} usage ")
        for idx, cal in enumerate(r.get("calibrations") or []):
            if not isinstance(cal, dict):
                continue
            nz = cal.get("nozzle")
            noz_name = nz.get("name") if isinstance(nz, dict) else None
            where = f"calibration[{idx}]" + (f" ({noz_name})" if noz_name else "")
            for fld, (bmin, bmax) in CALIBRATION_BOUNDS.items():
                val = cal.get(fld)
                if not isinstance(val, (int, float)) or isinstance(val, bool):
                    continue
                if (bmin is not None and val < bmin) or (bmax is not None and val > bmax):
                    rng = f"{bmin}-{bmax}" if bmax is not None else f">= {bmin}"
                    add("physical", f"{name}: {where} {fld}={val} outside the schema bound ({rng}) -> "
                                    f"exported to the slicer as-is", fid)

        # --- missing core spec (EFFECTIVE — a template legitimately has none) -
        if not is_template:
            if noz is None:
                add("missing-core", f"{name}: no nozzle temperature", fid)
            if bed is None:
                add("missing-core", f"{name}: no bed temperature", fid)
            if dens is None:
                add("missing-core", f"{name}: no density", fid)

        # --- colour ----------------------------------------------------------
        col = r.get("color")
        if col is not None and not HEX6.match(str(col)):
            add("colour", f"{name}: malformed color {col!r}", fid)
        # #808080 is the legacy default the pre-v1.70 form stamped on everything,
        # but it is ALSO the correct hex for a filament that really is grey.
        cname = (r.get("colorName") or "").lower()
        if col == "#808080" and "grey" not in cname and "gray" not in cname:
            add("colour", f"{name}: colour is the legacy #808080 sentinel (colorName={r.get('colorName')!r})", fid)

        # --- template violations (v1.70 #605) --------------------------------
        if is_template:
            # Promotion is a WHOLE-TEMPLATE operation, not a per-field one. Its
            # gate is parentPromotionState.needed — a non-empty `color` (NOT
            # trimmed), a `colorName` non-empty AFTER trimming, a spool count, or
            # totalWeight. When that is satisfied, performParentPromotion MOVES
            # colour, colourName, spools, totalWeight AND lowStockThreshold onto
            # the new variant. So the repair must be chosen from the parent's full
            # state: deciding per field would tell the user to null a threshold
            # that promotion would have preserved, destroying it.
            colour = raw.get("color")
            cname = raw.get("colorName")
            promote_runs = (
                (isinstance(colour, str) and colour != "")
                or (isinstance(cname, str) and cname.strip() != "")
                or bool(raw.get("spools"))
                or raw.get("totalWeight") is not None
            )
            for fld in TEMPLATE_STRIP:
                val = raw.get(fld)
                if val in (None, "", []):
                    continue
                how = ("Convert to template — moves this onto a new variant" if promote_runs
                       else f'promote returns 400 nothing_to_convert here — PUT {{"{fld}": null}}')
                add("template", f"{name} (TEMPLATE): still carries {fld}={val!r} [{how}]", fid)
            if raw.get("spools"):
                add("template", f"{name} (TEMPLATE): holds {len(raw['spools'])} spool(s) — inventory belongs on a variant", fid)

        # --- pinned inheritance ----------------------------------------------
        pid = str(raw["parentId"]) if raw.get("parentId") else None
        parent_ok = False
        if pid:
            if pid == fid:
                add("structure", f"{name}: parentId points at itself -> nothing can inherit", fid)
            elif pid not in records:
                # The listing only returns ACTIVE filaments, so an absent parent is
                # missing, soft-deleted or purged. Such a row can pass every other
                # check while the detail page and every slicer export resolve NONE
                # of its inherited values — silently skipping it hides a breakage.
                add("structure", f"{name}: parentId {pid} resolves to no active filament -> "
                                 f"nothing inherits, every inherited field reads as empty", fid)
            elif records[pid]["raw"].get("parentId"):
                # The write API forbids nested inheritance and resolveFilament
                # resolves exactly one immediate parent, so the grandparent's
                # values never reach this row however complete they look.
                add("structure", f"{name}: parent {records[pid]['res'].get('name')!r} is itself a "
                                 f"variant (nested inheritance) -> only one level resolves, so the "
                                 f"grandparent's values never reach this row", fid)
            else:
                parent_ok = True
        if parent_ok:
            parent_eff = records[pid]["res"]
            pname = parent_eff.get("name")
            for fld in PIN_CHECK_FIELDS:
                own, inherited = raw.get(fld), parent_eff.get(fld)
                # resolveFilament reads `variantVal != null && variantVal !== ""`,
                # so an empty string is an inheritance sentinel, not an override —
                # two empty strings are not a pin and a later template edit still
                # propagates.
                if own == "" or own is None or inherited is None:
                    continue
                if _json_equal(own, inherited):
                    add("pinned", f"{name}: stores {fld}={own}, identical to template {pname!r} -> pinned copy", fid)
            own_t = raw.get("temperatures") or {}
            par_t = parent_eff.get("temperatures") or {}
            for sub in PIN_CHECK_TEMPS:
                own, inherited = own_t.get(sub), par_t.get(sub)
                if own is not None and inherited is not None and _json_equal(own, inherited):
                    add("pinned", f"{name}: stores temperatures.{sub}={own}, identical to template "
                                  f"{pname!r} -> pinned copy", fid)
            # Whole-array inheritance: a NON-EMPTY variant array overrides, so one
            # equal to the template's is a pin. An empty one correctly inherits.
            for fld in PIN_CHECK_ARRAYS:
                own = raw.get(fld) or []
                inherited = parent_eff.get(fld) or []
                if own and _json_equal(_strip_ids(own), _strip_ids(inherited)):
                    add("pinned", f"{name}: stores its own {fld} ({len(own)} entr"
                                  f"{'y' if len(own) == 1 else 'ies'}) identical to template "
                                  f"{pname!r} -> pinned copy", fid)
            own_nz = _nozzle_ids(raw.get("compatibleNozzles"))
            if own_nz and own_nz == _nozzle_ids(parent_eff.get("compatibleNozzles")):
                add("pinned", f"{name}: stores its own compatibleNozzles ({len(own_nz)}) identical to "
                              f"template {pname!r} -> pinned copy", fid)

            # `settings` is SHALLOW-MERGED ({...parent, ...variant}), so a key
            # the variant stores overrides that key alone and stops tracking it.
            # Reported per VARIANT rather than per key on purpose: a slicer
            # round trip echoes the whole bag back, so a real library yields
            # hundreds of matching keys (341 across 32 variants on the library
            # this was built against) and per-key rows would bury every other
            # category.
            own_set = raw.get("settings") or {}
            par_set = parent_eff.get("settings") or {}
            # A malformed bag on either side is already reported by the shape
            # check above; here it only needs to not crash. Calling .items() on a
            # legacy string or array would abort the whole audit with an
            # AttributeError and report nothing at all.
            if not isinstance(own_set, dict):
                own_set = {}
            if not isinstance(par_set, dict):
                par_set = {}
            dup = sorted(k for k, val in own_set.items()
                         if k in par_set and _json_equal(par_set[k], val))
            if dup:
                shown = ", ".join(dup[:4]) + (f", +{len(dup) - 4} more" if len(dup) > 4 else "")
                add("pinned", f"{name}: stores {len(dup)} of {len(own_set)} settings key(s) identical to "
                              f"template {pname!r} ({shown}) -> pinned copies", fid)

        # --- nozzle assignment (non-abrasive; abrasive is the app's job) ------
        # An abrasive filament with no assignment is already reported, with far
        # better remediation, by /api/abrasive-nozzles. Restating it here would
        # contradict this script's own division of labour and double-count.
        if not is_template and fid not in abrasive_unassigned:
            compat = r.get("compatibleNozzles") or []
            # A soft-deleted nozzle still populates as a truthy object carrying
            # _deletedAt, so a non-empty array is not evidence of a usable
            # assignment — the same trap the calibration check above closes.
            stale = [n.get("name") or n.get("_id") for n in compat
                     if isinstance(n, dict) and n.get("_deletedAt")]
            live = [n for n in compat if isinstance(n, dict) and not n.get("_deletedAt")]
            if not compat:
                add("nozzles", f"{name}: no compatibleNozzles", fid)
            elif not live:
                add("nozzles", f"{name}: every compatibleNozzles entry is soft-deleted ({stale}) -> "
                               f"effectively unassigned", fid)
            elif stale:
                add("nozzles", f"{name}: compatibleNozzles includes soft-deleted {stale} -> stale "
                               f"reference that cannot be used", fid)

    return findings, parents


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("FILAMENTDB_URL", "http://localhost:3456"))
    ap.add_argument("--api-key", default=os.environ.get("FILAMENTDB_API_KEY"))
    ap.add_argument("--cache", help="directory to save the fetched records into")
    ap.add_argument("--only", help="comma-separated category keys to report")
    ap.add_argument("--json", action="store_true", help="emit findings as JSON")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    records, abrasive = load(base, args.api_key, args.cache)
    findings, parents = audit(records, abrasive)

    wanted = set(args.only.split(",")) if args.only else None

    # Records whose NAME is shared with another active record. Keyed on the name
    # rather than on an identical message: two duplicates usually have DIFFERENT
    # defects, so every message would be unique and no id would be appended —
    # leaving the report unable to say which of the two to repair.
    by_name = {}
    for rid, rec in records.items():
        by_name.setdefault(rec["res"].get("name"), []).append(rid)
    ambiguous = {rid for ids in by_name.values() if len(ids) > 1 for rid in ids}

    def render(rows):
        """Dedupe by (record id, message); append the id where the name is not unique.

        Two ACTIVE records can share a name — hybrid sync, a restore, or a legacy
        database whose unique-name index could not be built — and every message
        names its filament. Deduping on text alone would hide the second record.
        """
        uniq = sorted(set(rows), key=lambda t: (t[1], t[0] or ""))
        return [f"{msg}  [{fid}]" if fid in ambiguous else msg for fid, msg in uniq]

    if args.json:
        out = {k: render(v) for k, v in findings.items() if not wanted or k in wanted}
        print(json.dumps({"filaments": len(records), "templates": len(parents), "findings": out}, indent=2))
        return

    total = 0
    for key, title in CATEGORIES:
        raw_rows = findings.get(key)
        if not raw_rows or (wanted and key not in wanted):
            continue
        rows = render(raw_rows)
        total += len(rows)
        print(f"\n### {title}  ({len(rows)})")
        for row in rows:
            print("  -", row)
    print(f"\n=== {total} findings across {len(records)} filaments "
          f"({len(parents)} templates) ===")


if __name__ == "__main__":
    main()
