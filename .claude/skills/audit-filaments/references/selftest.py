#!/usr/bin/env python3
"""Corpus for audit.py.

WHY THIS FILE EXISTS. Twenty-four review rounds on this script produced sixty-odd
findings, and the overwhelming majority were ONE defect wearing different field
names: a record arrives holding a value of the wrong SHAPE at some path -- a
string where a dict is expected, a dict where a list is -- and the audit either
raises (so a single corrupt record hides every finding for the whole library) or
reads past it silently (so the corruption is declared clean). Each round fixed
the path that round happened to name.

Fixing them one path at a time cannot converge: the script reads well over a
hundred paths, and every new check adds more. So the fuzz below does not enumerate
paths a human thought of -- it walks a realistic record, and at EVERY path it
finds, substitutes each hostile value in turn and asserts the audit still returns.
A path added next month is covered the day it is read, without anyone adding a case.

Both reads are fuzzed independently AND together, because `res` and `raw` are
separate documents: a sweep that normalises only `res` leaves every block that
consumes `raw` exposed, which is exactly how three separate rounds went.

Run: python3 selftest.py
"""
import copy
import itertools
import sys
import traceback

import audit as A

passed = failed = 0


def ok(name):
    global passed
    passed += 1


def bad(name, detail):
    global failed
    failed += 1
    print(f"FAIL [{name}] {detail}\n")


# --- a realistic, VALID record ----------------------------------------------
# Deliberately broad: the fuzz's reach is bounded by the paths present here, so
# a field missing from this fixture is a field the sweep never probes.
def valid_res(**over):
    r = {
        "_id": "aaaaaaaaaaaaaaaaaaaaaaa1", "name": "PLA Basic Red", "vendor": "Acme",
        "type": "PLA", "color": "#ff0000", "colorName": "Red",
        "density": 1.24, "diameter": 1.75, "cost": 20.0,
        "totalWeight": None, "netFilamentWeight": 1000, "spoolWeight": 200,
        "lowStockThreshold": 100, "parentId": None, "hasVariants": False,
        "optTags": [4], "secondaryColors": [],
        "temperatures": {"nozzle": 210, "bed": 60, "chamber": 0,
                         "nozzleFirstLayer": 215, "bedFirstLayer": 65,
                         "nozzleRangeMin": 190, "nozzleRangeMax": 230, "standby": 175},
        "bedTypeTemps": [{"bedType": "Textured PEI", "temperature": 60,
                          "firstLayerTemperature": 65}],
        "dryingTemperature": 45, "dryingTime": 240,
        "minPrintSpeed": 20, "maxPrintSpeed": 200,
        "maxVolumetricSpeed": 12, "shrinkageXY": 0.3, "shrinkageZ": 0.1,
        "shoreA": None, "shoreD": 80, "transmissionDistance": 3,
        "glassTransition": 60, "heatDeflection": 55,
        "compatibleNozzles": [{"_id": "n1", "name": "0.4 Brass", "_deletedAt": None}],
        "calibrations": [{
            "_id": "c1", "nozzle": {"_id": "n1", "name": "0.4 Brass"},
            "printer": {"_id": "p1", "name": "MK4S"}, "bedType": {"_id": "b1", "name": "Textured PEI"},
            "extrusionMultiplier": 0.98, "pressureAdvance": 0.04,
            "maxVolumetricSpeed": 12, "fanMinSpeed": 20, "fanMaxSpeed": 100,
            "chamberTemp": 0, "nozzleTemp": 210, "bedTemp": 60,
            "nozzleTempFirstLayer": 215, "bedTempFirstLayer": 65,
            "temperatures": {"nozzle": 210, "bed": 60},
        }],
        "presets": [{"label": "draft", "extrusionMultiplier": 0.99,
                     "temperatures": {"nozzle": 205, "nozzleFirstLayer": 210,
                                      "bed": 60, "bedFirstLayer": 65}}],
        "settings": {"filament_abrasive": "0", "compatible_printers_condition": ""},
        "openprinttagSnapshot": {"density": 1.24},
        "spools": [{
            "_id": "s1", "instanceId": "0011223344", "label": "12",
            "totalWeight": 950, "retired": False, "locationId": "l1",
            "purchaseDate": "2026-01-01", "openedDate": None,
            "usageHistory": [{"grams": 30, "debitedGrams": 30, "source": "job",
                              "date": "2026-02-01", "jobLabel": "bracket"}],
            "dryCycles": [{"tempC": 45, "durationMin": 240, "date": "2026-01-05"}],
        }],
        "_deletedAt": None, "_purged": False,
    }
    r.update(over)
    return r


def rec(res=None, raw=None):
    res = res if res is not None else valid_res()
    raw = raw if raw is not None else copy.deepcopy(res)
    return {"res": res, "raw": raw}


def run(records, abrasive=(), failed_map=None, topology=None):
    return A.audit(records, abrasive, failed_map, topology)


# --- 1. the valid record must audit cleanly and not crash -------------------
def case_valid():
    try:
        findings, parents = run({"a": rec()})
    except Exception:
        return bad("valid-record", "a VALID record raised:\n" + traceback.format_exc())
    if not isinstance(findings, dict):
        return bad("valid-record", f"expected dict findings, got {type(findings)}")
    ok("valid-record")


# --- 2. THE CLASS: hostile shapes at every path, on both reads --------------
HOSTILE = [
    "oops",            # string where a container is expected
    "",                # empty string sentinel
    [],                # empty list
    {},                # empty dict
    0,                 # falsy number
    -1,                # negative
    True,              # bool (is also an int in Python)
    None,
    [None],            # list of junk
    [{"a": 1}],        # list of unexpected dicts
    {"a": 1},          # dict where a scalar/list is expected
    ["x", "y"],        # list of strings
    float("nan"),
    float("inf"),
    1e400,             # overflows to inf
    "9" * 300,         # absurd string
    [[]],              # nested container
    {"_id": {}},       # populated-ref-shaped junk
]


def walk_paths(node, prefix=()):
    """Every addressable path in the fixture, containers included."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield prefix + (k,)
            yield from walk_paths(v, prefix + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield prefix + (i,)
            yield from walk_paths(v, prefix + (i,))


def put(doc, path, value):
    cur = doc
    for step in path[:-1]:
        cur = cur[step]
    cur[path[-1]] = value
    return doc


def fuzz_shapes(report_all=True):
    """For every path x every hostile value x {res, raw, both}: must not raise.

    The contract asserted is deliberately weak -- audit() returns rather than
    raising. It is NOT that a finding is emitted. Demanding a finding per path
    would encode this fixture's shape into the corpus and break on every legit
    change; not raising is the property that actually matters, because one raise
    aborts the audit of the entire library.

    Crashes are COLLECTED, not fatal on first hit, and reported grouped by
    (path, exception). Stopping at the first one is what turns a single class of
    defect into twenty review rounds -- the whole point here is to see the class
    at once.
    """
    global failed
    base = valid_res()
    paths = list(walk_paths(base))
    combos = 0
    crashes = {}
    for path in paths:
        for hv in HOSTILE:
            for where in ("res", "raw", "both"):
                combos += 1
                res, raw = valid_res(), valid_res()
                if where in ("res", "both"):
                    try: put(res, path, hv)
                    except Exception: continue
                if where in ("raw", "both"):
                    try: put(raw, path, hv)
                    except Exception: continue
                try:
                    findings, _ = run({"a": {"res": res, "raw": raw}})
                    if not isinstance(findings, dict):
                        crashes.setdefault((".".join(map(str, path)), "non-dict findings"), []).append((hv, where))
                except Exception as e:
                    key = (".".join(map(str, path)), f"{type(e).__name__}: {e}")
                    crashes.setdefault(key, []).append((hv, where))
    if crashes:
        failed += 1
        print(f"FAIL [fuzz] audit RAISED on {len(crashes)} distinct (path, error) pairs "
              f"-- each one lets a single corrupt record hide every finding for the whole library:")
        for (path, err), hits in sorted(crashes.items()):
            vals = ", ".join(sorted({repr(h[0])[:18] for h in hits}))[:80]
            wheres = "/".join(sorted({h[1] for h in hits}))
            print(f"  {path:<44} {err[:62]}")
            print(f"  {'':<44} on {vals}  [{wheres}]")
        print()
    else:
        ok("fuzz")
    return combos, len(crashes)


# --- 3. top-level container itself malformed --------------------------------
def case_record_containers():
    for name, v in [
        ("res-not-dict", {"res": "oops", "raw": valid_res()}),
        ("raw-not-dict", {"res": valid_res(), "raw": "oops"}),
        ("res-none", {"res": None, "raw": valid_res()}),
        ("raw-none", {"res": valid_res(), "raw": None}),
        ("res-list", {"res": [], "raw": valid_res()}),
        ("both-junk", {"res": 7, "raw": 7}),
    ]:
        try:
            findings, _ = run({"a": v})
            if not isinstance(findings, dict):
                bad(name, "non-dict findings"); continue
            ok(name)
        except Exception as e:
            bad(name, f"audit raised: {type(e).__name__}: {e}")


# --- 4. malformed abrasive / failed / topology inputs -----------------------
def case_side_inputs():
    r = {"a": rec()}
    for name, kw in [
        ("abrasive-str", {"abrasive": "oops"}),
        ("abrasive-list-junk", {"abrasive": ["oops", None, 3]}),
        ("abrasive-none", {"abrasive": None}),
        ("abrasive-error", {"abrasive": {"error": "boom"}}),
        ("failed-junk", {"failed_map": {"x": None}}),
        ("topology-junk", {"topology": "oops"}),
    ]:
        try:
            findings, _ = run(r, **kw)
            if not isinstance(findings, dict):
                bad(name, "non-dict findings"); continue
            ok(name)
        except Exception as e:
            bad(name, f"audit raised: {type(e).__name__}: {e}")



# --- 5. CROSS-RECORD: a variant reads its template ---------------------------
# The single-record fuzz above cannot see this class at all, and that blind spot
# was real: shape normalisation ran per record inside the audit loop, so a
# variant sorting BEFORE its template reached a template whose containers had not
# been swept and aborted the entire run. Any check that reads a second record has
# the same exposure, so the pair is fuzzed in both orderings.
def fuzz_cross_record():
    global failed
    crashes = {}
    combos = 0
    tpl_id, var_id = "tpl0000000000000000001", "var0000000000000000001"
    # INSERTION order is what matters -- audit() iterates records.items(), and a
    # plain dict yields insertion order. An earlier version of this harness built
    # the template first in both cases, so the variant never ran ahead of it and
    # the fuzz reported clean against code that provably crashed.
    for first in ("variant", "template"):
        base = valid_res()
        for path in walk_paths(base):
            for hv in HOSTILE:
                combos += 1
                tpl = valid_res(_id=tpl_id, name="ZZZ Template", hasVariants=True,
                                color=None, colorName=None, totalWeight=None, spools=[])
                var = valid_res(_id=var_id, name="AAA Variant", parentId=tpl_id)
                try:
                    put(tpl, path, hv)
                except Exception:
                    continue
                tp = {"res": tpl, "raw": copy.deepcopy(tpl)}
                vr = {"res": var, "raw": copy.deepcopy(var)}
                recs = {var_id: vr, tpl_id: tp} if first == "variant" else {tpl_id: tp, var_id: vr}
                try:
                    findings, _ = run(recs)
                    if not isinstance(findings, dict):
                        crashes.setdefault((".".join(map(str, path)), "non-dict findings"), 0)
                except Exception as e:
                    key = (".".join(map(str, path)), f"{type(e).__name__}: {e}")
                    crashes[key] = crashes.get(key, 0) + 1
    if crashes:
        failed += 1
        print(f"FAIL [fuzz-cross-record] audit RAISED on {len(crashes)} distinct (path, error) "
              f"pairs when a TEMPLATE held the malformed value:")
        for (path, err), n in sorted(crashes.items()):
            print(f"  {path:<44} {err[:64]}  (x{n})")
        print()
    else:
        ok("fuzz-cross-record")
    return combos, len(crashes)


# --- 6. array ELEMENTS, not just containers ----------------------------------
# A container check accepts a list of anything. optTags is the case that bites:
# the encoder and the app's abrasive Set both take numbers only, so a string
# "31" is dropped from the tag encoding AND misses the carbon-fibre wear check.
def case_opt_tag_elements():
    for name, tags, want_finding in [
        ("optTags-string-31", ["31"], True),
        ("optTags-negative", [-1], True),
        ("optTags-float", [1.5], True),
        ("optTags-bool", [True], True),
        ("optTags-none", [None], True),
        ("optTags-above-32bit", [4294967296], True),   # encoder truncates above 0xffffffff
        ("optTags-at-ceiling", [4294967295], False),
        ("optTags-valid", [4, 31], False),
    ]:
        r = valid_res(optTags=tags)
        try:
            findings, _ = run({"a": rec(r, copy.deepcopy(r))})
        except Exception as e:
            bad(name, f"audit raised: {type(e).__name__}: {e}"); continue
        hit = any("optTags contains non-encodable" in m
                  for rows in findings.values() for _, m in rows)
        if hit == want_finding:
            ok(name)
        else:
            bad(name, f"expected finding={want_finding}, got {hit} for optTags={tags!r}")



# --- 7. FIXTURE COVERAGE: the fuzz only reaches paths the fixture has ---------
# The reach of every fuzz above is bounded by valid_res(). A field the script
# reads but the fixture omits is a field nothing probes -- and that is not
# theoretical: `presets[].temperatures` was absent, so a malformed container
# there went unreported until a reviewer found it by reading the code.
#
# So the fixture is checked against the script: every key audit.py reads with a
# literal .get("...") must exist somewhere in the fixture, or be listed as
# deliberately-not-a-record-field. A new .get on a record field fails here until
# the fixture carries it, which is what keeps the fuzz's coverage from silently
# shrinking as the script grows.
NOT_RECORD_FIELDS = {
    # /api/abrasive-nozzles payload
    "filamentName", "filamentId", "reasons", "inheritedFrom", "softNozzles",
    "flagMismatch", "unassigned", "findings", "error",
    # listing projection / internal plumbing
    "res", "raw", "hasCalibrations", "id",
    # process environment, read by main() not by the audit
    "FILAMENTDB_API_KEY", "FILAMENTDB_URL",
}


def case_fixture_covers_reads():
    import re
    src = io.open("audit.py").read() if False else open("audit.py").read()
    read_keys = set(re.findall(r'\.get\(\s*"([A-Za-z_][A-Za-z0-9_]*)"', src))
    have = set()

    def collect(node):
        if isinstance(node, dict):
            for k, v in node.items():
                have.add(k); collect(v)
        elif isinstance(node, list):
            for v in node:
                collect(v)

    collect(valid_res())
    missing = sorted(read_keys - have - NOT_RECORD_FIELDS)
    if missing:
        bad("fixture-coverage",
            "audit.py reads these keys, but the fixture has no such path, so NO fuzz "
            "case ever probes them:\n    " + ", ".join(missing) +
            "\n  Add them to valid_res(), or to NOT_RECORD_FIELDS if they are not "
            "record fields.")
    else:
        ok("fixture-coverage")



# --- 8. nested containers must be REPORTED, not merely survived --------------
# The fuzz's contract is deliberately weak: it asserts audit() returns. That
# catches the crash half of the shape class and is blind to the other half --
# a malformed container that is skipped in silence, leaving the record declared
# clean. `presets[].temperatures: "oops"` was exactly that: no crash, no finding.
# So every nested container gets a positive assertion that the defect is named.
# Listed HERE, not read from A.NESTED_CONTAINER_SHAPES. Sourcing a test's own
# case list from the table under test makes it vacuous the moment that table is
# emptied -- and untestable against any version that predates it, which is
# exactly how this case first appeared to pass against the broken code.
NESTED_CONTAINERS = [("spools", "usageHistory"), ("spools", "dryCycles"),
                     ("presets", "temperatures"), ("calibrations", "temperatures")]


def case_nested_containers_reported():
    for parent, sf in NESTED_CONTAINERS:
        if True:
            for hv in ("oops", 1, [1]):
                r = valid_res()
                lst = r.get(parent) or []
                if not lst or not isinstance(lst[0], dict):
                    bad(f"nested-{parent}.{sf}",
                        f"fixture has no {parent}[0] dict to corrupt — the case cannot run")
                    break
                if isinstance(hv, type(lst[0].get(sf))) and lst[0].get(sf) is not None:
                    continue  # not actually malformed for this field
                lst[0][sf] = hv
                try:
                    findings, _ = run({"a": rec(r, copy.deepcopy(r))})
                except Exception as e:
                    bad(f"nested-{parent}.{sf}", f"raised on {hv!r}: {type(e).__name__}: {e}")
                    continue
                # Match the SEMANTIC claim (this subfield is malformed), not the
                # parent key literal: an earlier version keyed on "spools" while
                # the message said "spool <id>", so it reported a pre-existing,
                # correctly-reported case as a regression.
                hit = any(sf in m and "malformed" in m
                          for rows in findings.values() for _, m in rows)
                if hit:
                    ok(f"nested-{parent}.{sf}-{hv!r}")
                else:
                    bad(f"nested-{parent}.{sf}",
                        f"{parent}[0].{sf}={hv!r} produced NO finding -> a malformed "
                        f"container was silently declared clean")


if __name__ == "__main__":
    case_valid()
    case_record_containers()
    case_side_inputs()
    case_fixture_covers_reads()
    case_opt_tag_elements()
    case_nested_containers_reported()
    n, ncrash = fuzz_shapes()
    n2, ncrash2 = fuzz_cross_record()
    n += n2; ncrash += ncrash2
    print(f"\n{passed} passed, {failed} failed   (fuzz: {n} combinations, {ncrash} distinct crash sites)")
    sys.exit(1 if failed else 0)
