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

# Stripped from a template on write (v1.70 #605). Present on one = legacy shape.
TEMPLATE_STRIP = ["color", "colorName", "totalWeight", "lowStockThreshold"]

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

    def add(cat, msg):
        findings.setdefault(cat, []).append(msg)

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
                                f"is not on -> EXPORTS AS NON-ABRASIVE{src}")
            if soft:
                add("abrasive", f"{name}: abrasive ({why}) but permitted on unfit nozzle(s) {soft}{src}")
            if f.get("unassigned"):
                add("abrasive", f"{name}: abrasive ({why}) with no nozzle assignment at all{src}")

    # Template-ness is DERIVED from having variants — there is no schema flag.
    parents = {str(v["raw"]["parentId"]) for v in records.values() if v["raw"].get("parentId")}

    for fid, v in records.items():
        r, raw = v["res"], v["raw"]
        name = r.get("name", "?")
        temps = r.get("temperatures") or {}
        is_template = fid in parents
        all_spools = r.get("spools") or []
        live_spools = [s for s in all_spools if not s.get("retired")]

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
                add("inventory", f"{name}: {unit} but netFilamentWeight={net!r} -> no % bar")
            tare = r.get("spoolWeight")
            if tare is None:
                add("inventory", f"{name}: {unit} but no spoolWeight (tare) -> "
                                 f"computeRemaining returns null, nothing displays")

            if legacy_roll:
                gross = r.get("totalWeight")
                if tare is not None and gross < tare:
                    add("inventory", f"{name}: legacy gross {gross}g is below tare {tare}g -> negative remaining")
            else:
                missing_gross = 0
                for s in live_spools:
                    gross = s.get("totalWeight")
                    if gross is None:
                        # Schema-supported, but getRemainingPct skips such a spool
                        # and returns null outright when none is left countable.
                        missing_gross += 1
                        add("inventory", f"{name}: live spool {s.get('instanceId') or s.get('_id')} has no "
                                         f"totalWeight (gross) -> it contributes nothing to the bar")
                    elif tare is not None and gross < tare:
                        add("inventory", f"{name}: spool gross {gross}g is below tare {tare}g -> negative remaining")
                if missing_gross and missing_gross == len(live_spools):
                    add("inventory", f"{name}: every live spool is missing its gross weight -> "
                                     f"getRemainingPct returns null, no bar at all")

        # --- drying: the field is minutes, every datasheet says hours --------
        dry_t, dry_temp = r.get("dryingTime"), r.get("dryingTemperature")
        if isinstance(dry_t, (int, float)) and 0 < dry_t <= 24:
            add("drying-units", f"{name}: dryingTime={dry_t} at {dry_temp}C — the field is MINUTES; "
                                f"{dry_t} hours would be {int(dry_t * 60)}")

        # --- temperatures ----------------------------------------------------
        noz, lo, hi, bed = (temps.get("nozzle"), temps.get("nozzleRangeMin"),
                            temps.get("nozzleRangeMax"), temps.get("bed"))
        if lo is not None and hi is not None and lo > hi:
            add("temps", f"{name}: INVERTED nozzle range {lo}-{hi}")
        if noz is not None and lo is not None and noz < lo:
            add("temps", f"{name}: nozzle {noz} is BELOW its own range min {lo}")
        if noz is not None and hi is not None and noz > hi:
            add("temps", f"{name}: nozzle {noz} is ABOVE its own range max {hi}")
        if noz is not None and not 150 <= noz <= 450:
            add("temps", f"{name}: nozzle {noz}C outside the plausible FFF band")
        if bed is not None and not 0 <= bed <= 200:
            add("temps", f"{name}: bed {bed}C implausible")

        # --- physical --------------------------------------------------------
        dens = r.get("density")
        if dens is not None and not 0.7 <= dens <= 2.5:
            add("physical", f"{name}: density {dens} g/cm3 outside the plausible polymer range")
        dia = r.get("diameter")
        if dia is not None and not any(abs(dia - d) < 0.06 for d in (1.75, 2.85, 3.0)):
            add("physical", f"{name}: diameter {dia}mm is not a standard size")
        for fld in ("cost", "density", "spoolWeight", "netFilamentWeight", "dryingTime", "dryingTemperature"):
            val = r.get(fld)
            if isinstance(val, (int, float)) and val < 0:
                add("physical", f"{name}: {fld}={val} is negative")

        # --- missing core spec (EFFECTIVE — a template legitimately has none) -
        if not is_template:
            if noz is None:
                add("missing-core", f"{name}: no nozzle temperature")
            if bed is None:
                add("missing-core", f"{name}: no bed temperature")
            if dens is None:
                add("missing-core", f"{name}: no density")

        # --- colour ----------------------------------------------------------
        col = r.get("color")
        if col is not None and not HEX6.match(str(col)):
            add("colour", f"{name}: malformed color {col!r}")
        # #808080 is the legacy default the pre-v1.70 form stamped on everything,
        # but it is ALSO the correct hex for a filament that really is grey.
        cname = (r.get("colorName") or "").lower()
        if col == "#808080" and "grey" not in cname and "gray" not in cname:
            add("colour", f"{name}: colour is the legacy #808080 sentinel (colorName={r.get('colorName')!r})")

        # --- template violations (v1.70 #605) --------------------------------
        if is_template:
            for fld in TEMPLATE_STRIP:
                if raw.get(fld) not in (None, "", []):
                    add("template", f"{name} (TEMPLATE): still carries {fld}={raw.get(fld)!r}")
            if raw.get("spools"):
                add("template", f"{name} (TEMPLATE): holds {len(raw['spools'])} spool(s) — inventory belongs on a variant")

        # --- pinned inheritance ----------------------------------------------
        pid = str(raw["parentId"]) if raw.get("parentId") else None
        if pid and pid in records:
            parent_eff = records[pid]["res"]
            pname = parent_eff.get("name")
            for fld in PIN_CHECK_FIELDS:
                own, inherited = raw.get(fld), parent_eff.get(fld)
                if own is not None and inherited is not None and own == inherited:
                    add("pinned", f"{name}: stores {fld}={own}, identical to template {pname!r} -> pinned copy")
            own_t = raw.get("temperatures") or {}
            par_t = parent_eff.get("temperatures") or {}
            for sub in PIN_CHECK_TEMPS:
                own, inherited = own_t.get(sub), par_t.get(sub)
                if own is not None and inherited is not None and own == inherited:
                    add("pinned", f"{name}: stores temperatures.{sub}={own}, identical to template "
                                  f"{pname!r} -> pinned copy")

        # --- nozzle assignment (non-abrasive; abrasive is the app's job) ------
        if not is_template and not (r.get("compatibleNozzles") or []):
            add("nozzles", f"{name}: no compatibleNozzles")

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
    if args.json:
        out = {k: sorted(set(v)) for k, v in findings.items() if not wanted or k in wanted}
        print(json.dumps({"filaments": len(records), "templates": len(parents), "findings": out}, indent=2))
        return

    total = 0
    for key, title in CATEGORIES:
        rows = findings.get(key)
        if not rows or (wanted and key not in wanted):
            continue
        rows = sorted(set(rows))
        total += len(rows)
        print(f"\n### {title}  ({len(rows)})")
        for row in rows:
            print("  -", row)
    print(f"\n=== {total} findings across {len(records)} filaments "
          f"({len(parents)} templates) ===")


if __name__ == "__main__":
    main()
