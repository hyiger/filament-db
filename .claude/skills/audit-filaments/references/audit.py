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

# Fields resolveFilament() inherits from a template when the variant leaves them
# null. A variant storing a value here that EQUALS the template's is a pinned
# copy: it looks identical today and silently stops tracking the template.
INHERITABLE = [
    "density", "dryingTemperature", "dryingTime", "spoolWeight",
    "netFilamentWeight", "maxVolumetricSpeed", "glassTempTransition",
    "heatDeflectionTemp", "shrinkageXY", "shrinkageZ",
]

# Stripped from a template on write (v1.70 #605). Present on one = legacy shape.
TEMPLATE_STRIP = ["color", "colorName", "totalWeight", "lowStockThreshold"]

# Type substrings implying an abrasive filler. Deliberately broad — a false
# positive costs one glance, a false negative costs a nozzle.
ABRASIVE_TYPE = re.compile(r"-(CF|GF)\b|CF\d|GF\d|glow|metal|stone|wood|carbon|glass", re.I)

HEX6 = re.compile(r"#[0-9A-Fa-f]{6}\Z")

CATEGORIES = [
    ("abrasive",     "ABRASIVE FLAG MISMATCH (exports wrong)"),
    ("inventory",    "INVENTORY / REMAINING-BAR BLOCKERS"),
    ("drying-units", "DRYING TIME UNIT ERRORS (the field is MINUTES)"),
    ("temps",        "TEMPERATURE VALIDITY"),
    ("physical",     "PHYSICAL VALUES"),
    ("missing-core", "MISSING CORE SPEC (effective, after inheritance)"),
    ("template",     "TEMPLATE HOLDING COLOUR / INVENTORY (v1.70)"),
    ("pinned",       "PINNED INHERITANCE (variant copies its template's value)"),
    ("nozzles",      "NOZZLE COMPATIBILITY"),
    ("colour",       "COLOUR"),
]


def fetch(url, api_key=None, timeout=30):
    req = urllib.request.Request(url)
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def load(base, api_key, cache_dir=None):
    """Return (records, nozzles). records[id] = {'res': resolved, 'raw': stored}."""
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

    try:
        nozzles = fetch(f"{base}/api/nozzles", api_key)
    except Exception:
        nozzles = []
    return records, nozzles


def audit(records):
    findings = {}

    def add(cat, msg):
        findings.setdefault(cat, []).append(msg)

    # Template-ness is DERIVED from having variants — there is no schema flag.
    parents = {str(v["raw"]["parentId"]) for v in records.values() if v["raw"].get("parentId")}

    for fid, v in records.items():
        r, raw = v["res"], v["raw"]
        name = r.get("name", "?")
        typ = r.get("type") or ""
        temps = r.get("temperatures") or {}
        tags = r.get("optTags") or []
        settings = r.get("settings") or {}
        is_template = fid in parents
        live_spools = [s for s in (r.get("spools") or []) if not s.get("retired")]

        # --- abrasive: the tag and the setting have DIFFERENT consumers -------
        abrasive_setting = settings.get("filament_abrasive")
        if 4 in tags and abrasive_setting != "1":
            add("abrasive", f"{name}: optTag 4 (abrasive) but settings.filament_abrasive="
                            f"{abrasive_setting!r} -> EXPORTS AS NON-ABRASIVE")
        if abrasive_setting == "1" and 4 not in tags:
            add("abrasive", f"{name}: filament_abrasive='1' but no optTag 4 -> the nozzle picker will not restrict it")
        if ABRASIVE_TYPE.search(typ) and 4 not in tags:
            add("abrasive", f"{name}: type {typ!r} implies an abrasive filler but no optTag 4")

        # --- inventory: what makes the remaining bar work --------------------
        if live_spools:
            if r.get("netFilamentWeight") is None:
                add("inventory", f"{name}: {len(live_spools)} live spool(s) but no netFilamentWeight -> no % bar")
            if r.get("spoolWeight") is None:
                add("inventory", f"{name}: {len(live_spools)} live spool(s) but no spoolWeight (tare) -> "
                                 f"computeRemaining returns null, nothing displays")
            tare = r.get("spoolWeight")
            for s in live_spools:
                gross = s.get("totalWeight")
                if tare is not None and gross is not None and gross < tare:
                    add("inventory", f"{name}: spool gross {gross}g is below tare {tare}g -> negative remaining")

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
        # but it is ALSO the correct hex for a filament that is actually grey.
        if col == "#808080" and "grey" not in (r.get("colorName") or "").lower() \
                and "gray" not in (r.get("colorName") or "").lower():
            add("colour", f"{name}: colour is the legacy #808080 sentinel (colorName="
                          f"{r.get('colorName')!r})")

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
            for fld in INHERITABLE:
                own, inherited = raw.get(fld), parent_eff.get(fld)
                if own is not None and inherited is not None and own == inherited:
                    add("pinned", f"{name}: stores {fld}={own}, identical to template "
                                  f"{parent_eff.get('name')!r} -> pinned copy, stops tracking")

        # --- nozzle compatibility --------------------------------------------
        compat = [n for n in (r.get("compatibleNozzles") or []) if isinstance(n, dict)]
        if not compat and not is_template:
            add("nozzles", f"{name}: no compatibleNozzles")
        if 4 in tags:
            soft = [n.get("name") for n in compat if not n.get("hardened")]
            if soft:
                add("nozzles", f"{name}: marked ABRASIVE but permitted on non-hardened {soft}")

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
    records, _nozzles = load(base, args.api_key, args.cache)
    findings, parents = audit(records)

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
