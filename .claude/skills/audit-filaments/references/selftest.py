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

import os

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
        # TOP-LEVEL instanceId. The coverage guard below collects key NAMES, not
        # paths, so the spool's own `instanceId` made this read look covered while
        # no fuzz case ever substituted a hostile value at the top level.
        "instanceId": "ffeeddccbb",
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
        "shoreHardnessA": None, "shoreHardnessD": 80, "transmissionDistance": 3,
        # The real schema names (Filament.ts:204-212). The fixture used to carry
        # invented ones -- glassTransition / heatDeflection / shoreA / shoreD --
        # which exist nowhere in the model, so the four fields audit.py actually
        # reads were never fuzzed. Found by the table-driven coverage guard below.
        "glassTempTransition": 60, "heatDeflectionTemp": 55,
        "spoolType": "plastic", "inherits": "*PLA*", "notes": "vendor sheet",
        "compatibleNozzles": [{"_id": "n1", "name": "0.4 Brass", "_deletedAt": None}],
        "calibrations": [{
            "_id": "c1", "nozzle": {"_id": "n1", "name": "0.4 Brass"},
            "printer": {"_id": "p1", "name": "MK4S",
                        "installedNozzles": [{"_id": "n1", "name": "0.4 Brass"}]},
            "bedType": {"_id": "b1", "name": "Textured PEI"},
            "extrusionMultiplier": 0.98, "pressureAdvance": 0.04,
            "maxVolumetricSpeed": 12, "fanMinSpeed": 20, "fanMaxSpeed": 100,
            "chamberTemp": 0, "nozzleTemp": 210, "bedTemp": 60,
            "nozzleTempFirstLayer": 215, "bedTempFirstLayer": 65,
            "retractLength": 0.8, "retractSpeed": 35, "retractLift": 0.2,
            "fanBridgeSpeed": 100,
        }],
        "presets": [{"label": "draft", "extrusionMultiplier": 0.99,
                     "temperatures": {"nozzle": 205, "nozzleFirstLayer": 210,
                                      "bed": 60, "bedFirstLayer": 65}}],
        # openprinttag_slug is here so the PIN_EXEMPT_SETTINGS carve-out is
        # actually exercised by the pinned-inheritance fuzz, not just declared.
        "settings": {"filament_abrasive": "0", "compatible_printers_condition": "",
                     "openprinttag_slug": "prusament-pla", "openprinttag_uuid": "u-1"},
        "openprinttagSnapshot": {"density": 1.24},
        "tdsUrl": "https://example.com/pla-tds.pdf",
        "spools": [{
            "_id": "s1", "instanceId": "0011223344", "label": "12", "lotNumber": "L-42",
            "totalWeight": 950, "retired": False,
            # a REAL ObjectId shape: Mongoose's cast accepts 24 hex characters
            # and nothing else, so a bare "l1" here made the "valid" fixture
            # invalid — which is precisely what case_valid now catches.
            "locationId": "6a1a7bef677d648e9ba9cd8c",
            "purchaseDate": "2026-01-01", "openedDate": None,
            "usageHistory": [{"grams": 30, "debitedGrams": 30, "source": "job",
                              "date": "2026-02-01", "jobLabel": "bracket"}],
            "dryCycles": [{"tempC": 45, "durationMin": 240, "date": "2026-01-05",
                           "notes": "overnight"}],
            "photoDataUrl": "data:image/png;base64,iVBORw0KGgo=",
        }],
        "_deletedAt": None, "_purged": False,
        # set by resolveFilament on a variant; absent on standalones/templates
        "_inherited": [],
        # RESPONSE_METADATA — carried by the ?raw=true read. Present here so the
        # fuzz actually exercises the exclusion that keeps a child's malformed
        # value from being reported a second time against its template.
        "_parent": None, "_variants": [], "_strippedTemplateFields": [],
        # #1103: set by the detail route when the row has trashed children. A
        # carrying parent with ONLY trashed variants is not `is_template`, so it
        # needs its own check — and its own fuzz coverage.
        "_hasTrashedVariants": False,
    }
    r.update(over)
    return r


def rec(res=None, raw=None):
    res = res if res is not None else valid_res()
    raw = raw if raw is not None else copy.deepcopy(res)
    return {"res": res, "raw": raw}


def run(records, abrasive=(), failed_map=None, topology=None):
    # audit() returns (findings, parents, audited_ids). The third element exists
    # so main() cannot iterate records audit() discarded; callers here only need
    # the first two, so unpack defensively rather than pinning the arity.
    result = A.audit(records, abrasive, failed_map, topology)
    return result[0], result[1]


# --- 1. the valid record must audit cleanly and not crash -------------------
def case_valid():
    try:
        findings, parents = run({"a": rec()})
    except Exception:
        return bad("valid-record", "a VALID record raised:\n" + traceback.format_exc())
    if not isinstance(findings, dict):
        return bad("valid-record", f"expected dict findings, got {type(findings)}")
    # "did not raise" was the ONLY assertion here, which left the suite with no
    # general false-positive guard at all — a check mis-tuned to fire on healthy
    # data would have passed every case in this file.
    rows = [m for rows_ in findings.values() for _, m in rows_]
    if rows:
        return bad("valid-record", "a VALID record produced findings:\n    "
                                   + "\n    ".join(rows))
    ok("valid-record")

    # ...and again as a healthy TEMPLATE + VARIANT pair. The standalone fixture
    # can never enter the pinned / template / inheritance blocks, so a false
    # positive that only fires on a family would go unnoticed.
    t = valid_res(_id="t", name="Family", parentId=None, spools=[], color=None, colorName=None,
                  totalWeight=None, lowStockThreshold=None, instanceId="tttttttttt")
    k = valid_res(_id="k", name="Family — Blue", parentId="t", instanceId="kkkkkkkkkk")
    # A HEALTHY variant stores none of what it inherits — that is the whole
    # point of the model, and it is what the pinned-inheritance block exists to
    # push people toward. Build it by stripping every inheritable from the raw
    # read and declaring them inherited, exactly as resolveFilament reports.
    inh = list(A.PIN_CHECK_FIELDS) + list(A.PIN_CHECK_ARRAYS) + \
        [f"temperatures.{t2}" for t2 in A.PIN_CHECK_TEMPS]
    k["_inherited"] = inh
    kraw = copy.deepcopy(k)
    for f3 in A.PIN_CHECK_FIELDS:
        kraw.pop(f3, None)
    for f3 in A.PIN_CHECK_ARRAYS:
        kraw[f3] = []
    kraw["temperatures"] = {t2: v2 for t2, v2 in kraw["temperatures"].items()
                            if t2 not in A.PIN_CHECK_TEMPS}
    kraw["settings"] = {}                      # nothing pinned
    kraw["tdsUrl"] = None
    kraw["inherits"] = None
    # checked by its own pin rule, not via PIN_CHECK_ARRAYS
    kraw["compatibleNozzles"] = []
    k["_inherited"].append("compatibleNozzles")
    try:
        f2, _ = run({"t": rec(t, copy.deepcopy(t)), "k": {"res": k, "raw": kraw}},
                    topology={"t": True})
    except Exception:
        return bad("valid-family", "a VALID template/variant pair raised:\n"
                                   + traceback.format_exc())
    rows = [m for rows_ in f2.values() for _, m in rows_]
    if rows:
        return bad("valid-family", "a VALID template/variant pair produced findings:\n    "
                                   + "\n    ".join(rows))
    ok("valid-family")


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
    # WHICH SIDE holds the hostile value is a second dimension, and it was
    # missing: the value only ever went into the template, so every read the
    # pinned-inheritance and attribution blocks make against the VARIANT's own
    # document was fuzzed with nothing but the clean fixture.
    for first in ("variant", "template"):
        base = valid_res()
        for path in walk_paths(base):
            for hv in HOSTILE:
                for holder in ("template", "variant"):
                    combos += 1
                    tpl = valid_res(_id=tpl_id, name="ZZZ Template", hasVariants=True,
                                    color=None, colorName=None, totalWeight=None, spools=[])
                    var = valid_res(_id=var_id, name="AAA Variant", parentId=tpl_id)
                    try:
                        put(tpl if holder == "template" else var, path, hv)
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
# The literal-`.get("x")` scan below sees only HARD-CODED reads, and most of
# audit.py's reads are table-driven -- `container.get(f2)` over
# NUMERIC_BOUNDS.items(), `sp.get(_tf)` over NESTED_TEXT_MAXLEN, and so on. A
# field reachable only through a table was therefore invisible to the guard AND
# absent from the fixture, so nothing probed it: that is how the fixture came to
# carry four INVENTED names (glassTransition / heatDeflection / shoreA / shoreD)
# while the four real ones audit.py reads went unfuzzed for the life of the file.
#
# So every module-level table is classified, and an UNCLASSIFIED one fails the
# case. That is the part that keeps this from rotting: adding a table to audit.py
# without saying which kind it is breaks the suite instead of quietly shrinking
# the fuzz's reach again.
FIELD_TABLES = {          # string keys/elements are record FIELD names
    "ALWAYS_STORED_ROOTS", "CALIBRATION_BOUNDS", "PIN_EXEMPT_SETTINGS", "CONTAINER_SHAPES", "DICT_ELEMENT_ARRAYS", "DRY_CYCLE_BOUNDS",
    "LEDGER_TEXT_FIELDS", "NESTED_BOOL_FIELDS", "NESTED_CONTAINER_SHAPES",
    "NESTED_DICT_ELEMENT_ARRAYS", "NESTED_TEXT_FIELDS", "NESTED_TEXT_MAXLEN",
    "NUMERIC_BOUNDS", "NUMERIC_LEAF_NAMES", "OPAQUE_BAGS", "PIN_CHECK_ARRAYS",
    "PIN_CHECK_FIELDS", "PIN_CHECK_TEMPS", "PRESET_BOUNDS", "RANGE_BOUNDS",
    "REFERENCE_FIELDS", "REQUIRED_TEXT", "RESPONSE_METADATA", "SEMANTIC_BOUNDS_USAGE",
    "SPOOL_BOUNDS", "TEMPLATE_STRIP", "TEXT_FIELDS", "USAGE_BOUNDS",
}
PAIR_TABLES = {           # rows are (label, lowField, highField) -- skip element 0
    "ORDERED_PAIRS", "ORDERED_PAIRS_CAL", "ORDERED_PAIRS_TOP", "ORDERED_PAIRS_USAGE",
}
VALUE_TABLES = {          # strings are stored VALUES or output text, not field names
    "CATEGORIES", "LOW_TEMP_TYPES", "ORCA_PLATE_KEYS", "USAGE_SOURCES", "_URL_REMOVE",
}

# See the check at the end of main(): this is the guard against a SILENT loss of
# fuzz reach, which the name-based coverage guard structurally cannot catch.
# EQUALITY, not a floor. A `>=` floor goes stale the moment the fixture grows —
# the suite passes without anyone updating it, and a later trim can then remove
# coverage while staying above the stale value, which is exactly the blind spot
# this guard exists to close. Every intentional fixture change updates this
# number.
FUZZ_COUNT = 16632

NOT_RECORD_FIELDS = {
    # /api/abrasive-nozzles payload
    "filamentName", "filamentId", "reasons", "inheritedFrom", "softNozzles",
    "flagMismatch", "unassigned", "findings", "error",
    # listing projection / internal plumbing
    "res", "raw", "hasCalibrations", "id",
    # /api/snapshot envelope, read only by the discovery fallback that runs when
    # the listing aggregation errors on a malformed container
    "collections", "filaments",
    # ref_index — the UNPOPULATED calibration scope refs, also from
    # /api/snapshot. Not record fields, and unreachable from the record
    # fixture, so they get a dedicated case instead of fuzz coverage:
    # case_calibration_scope_refs.
    "printers", "bedTypes", "cals", "locations",
    # process environment, read by main() not by the audit
    "FILAMENTDB_API_KEY", "FILAMENTDB_URL",
}


def case_fixture_covers_reads():
    import re
    # Resolved against THIS file, not the caller's cwd: `import audit` already
    # works from anywhere (Python puts the script's own directory on sys.path),
    # so a cwd-relative open was the one thing that made the suite pass from the
    # references directory and fail from the repo root the skill documents.
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "audit.py")).read()
    read_keys = set(re.findall(r'\.get\(\s*"([A-Za-z_][A-Za-z0-9_]*)"', src))

    # --- the table-driven half -------------------------------------------
    tables = {n: getattr(A, n) for n in dir(A)
              if n.isupper() and isinstance(getattr(A, n), (dict, tuple, list, set, frozenset))}
    unclassified = sorted(set(tables) - FIELD_TABLES - PAIR_TABLES - VALUE_TABLES)
    if unclassified:
        return bad("fixture-coverage",
                   "audit.py has module-level table(s) this guard cannot classify: "
                   + ", ".join(unclassified) +
                   "\n  Add each to FIELD_TABLES (its strings are record field names), "
                   "PAIR_TABLES ((label, lo, hi) rows) or VALUE_TABLES (stored values).")

    def strings(node, out):
        if isinstance(node, str):
            out.add(node)
        elif isinstance(node, dict):
            for k, v in node.items():
                strings(k, out); strings(v, out)
        elif isinstance(node, (list, tuple, set, frozenset)):
            for v in node:
                strings(v, out)

    for tname in FIELD_TABLES:
        strings(tables[tname], read_keys)
    for tname in PAIR_TABLES:
        for row in tables[tname]:
            strings(tuple(row)[1:], read_keys)

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
                     ("presets", "temperatures")]


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



# --- 9. an exemption must be scoped by PATH, not by field name ---------------
# `calibrations[].nozzle` legitimately holds a populated nozzle document, so a
# dict there is correct. Exempting the NAME rather than the path also exempted
# `temperatures.nozzle`, where a dict is a corrupt numeric field.
def case_nozzle_exemption_scope():
    r = valid_res()
    r["temperatures"]["nozzle"] = {}
    try:
        findings, _ = run({"a": rec(r, copy.deepcopy(r))})
    except Exception as e:
        return bad("nozzle-exemption-scope", f"raised: {type(e).__name__}: {e}")
    hit = any("temperatures.nozzle" in m for rows in findings.values() for _, m in rows)
    ok("nozzle-exemption-scope") if hit else bad(
        "nozzle-exemption-scope",
        "temperatures.nozzle={} produced no finding -> an object in a numeric "
        "temperature field audits clean")
    # …and the legitimate populated nozzle must STILL not be reported.
    r2 = valid_res()
    try:
        f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    except Exception as e:
        return bad("nozzle-exemption-keeps", f"raised: {type(e).__name__}: {e}")
    fp = [m for rows in f2.values() for _, m in rows if "calibrations[0].nozzle" in m]
    ok("nozzle-exemption-keeps") if not fp else bad(
        "nozzle-exemption-keeps", f"populated calibration nozzle wrongly flagged: {fp}")


# --- 10. malformed ELEMENTS of subdocument arrays ----------------------------
# The container check accepts a list of anything; every later pass then skips a
# non-dict quietly, so `spools: ["oops"]` audited clean while the app cannot
# compute inventory from that live spool.
def case_subdoc_elements_reported():
    for parent in ("spools", "calibrations", "presets", "bedTypeTemps"):
        for elem in ("oops", 1, None, []):
            r = valid_res()
            r[parent] = [elem]
            try:
                findings, _ = run({"a": rec(r, copy.deepcopy(r))})
            except Exception as e:
                bad(f"subdoc-element-{parent}", f"raised on {elem!r}: {type(e).__name__}: {e}")
                continue
            hit = any(parent in m and "not a subdocument" in m
                      for rows in findings.values() for _, m in rows)
            ok(f"subdoc-element-{parent}-{elem!r}") if hit else bad(
                f"subdoc-element-{parent}",
                f"{parent}=[{elem!r}] produced no malformed-element finding -> the "
                f"entry is skipped by every check and the record reads clean")


# --- 11. an UNREADABLE parent is not a MISSING one ---------------------------
# A false report of data loss against a healthy row is worse than a miss: it
# sends the user hunting a broken link that does not exist. The read failure is
# already reported separately.
def case_unreadable_parent_not_missing():
    tpl_id, var_id = "tpl9", "var9"
    var = valid_res(_id=var_id, name="Variant", parentId=tpl_id)
    records = {var_id: rec(var, copy.deepcopy(var))}
    # the parent is ACTIVE per the listing, but its detail read failed
    topology = {tpl_id: True, var_id: False}
    failed_map = {tpl_id: "HTTPError: 500"}
    try:
        findings, _ = run(records, failed_map=failed_map, topology=topology)
    except Exception as e:
        return bad("unreadable-parent", f"raised: {type(e).__name__}: {e}")
    msgs = [m for rows in findings.values() for _, m in rows]
    false_alarm = [m for m in msgs if "resolves to no active filament" in m]
    honest = [m for m in msgs if "could not be read" in m and "NOT audited" in m]
    if false_alarm:
        bad("unreadable-parent",
            f"reported a broken parent link for a parent that is active and merely "
            f"unreadable: {false_alarm}")
    elif not honest:
        bad("unreadable-parent",
            "neither the false alarm nor an honest 'inheritance not audited' finding "
            "was emitted -- the gap is silent")
    else:
        ok("unreadable-parent")
    # A genuinely ABSENT parent must still be reported.
    var2 = valid_res(_id="v2", name="Orphan", parentId="gone")
    f2, _ = run({"v2": rec(var2, copy.deepcopy(var2))}, topology={"v2": False})
    if any("resolves to no active filament" in m for rows in f2.values() for _, m in rows):
        ok("absent-parent-still-reported")
    else:
        bad("absent-parent-still-reported",
            "a genuinely missing parent is no longer reported -- the fix went too far")



# --- 12. --only must never turn a typo into a clean bill of health -----------
# The worst failure this tool can have is silence that reads as safety.
# `--only abrasives` (plural) printed "0 findings" over a library with a real
# abrasive defect, indistinguishable from a genuinely clean run.
def case_only_flag_rejects_unknown():
    import contextlib, io as _io
    def run_main(argv):
        orig_load, orig_argv = A.load, sys.argv
        # load() returns (records, abrasive, failed, topology, degraded,
        # ref_index) — the last is the UNPOPULATED calibration refs from
        # /api/snapshot. None here means "not fetched", which the pass treats
        # as "nothing to cross-check" rather than as a failure.
        # the last is the discovery-fallback note.
        A.load = lambda *a, **k: ({"a": rec(valid_res(dryingTime=4))}, [], {}, {}, None, None)
        sys.argv = ["audit.py"] + argv
        out, err, code = _io.StringIO(), _io.StringIO(), 0
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                A.main()
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 1
        finally:
            A.load, sys.argv = orig_load, orig_argv
        return code, out.getvalue() + err.getvalue()

    code, txt = run_main(["--only", "drying-units"])
    if "dryingTime" in txt:
        ok("only-valid-key-works")
    else:
        bad("only-valid-key-works", f"a VALID --only key hid the finding:\n{txt[:300]}")

    for typo in ("abrasives", "temperatures", "nonsense", "ABRASIVE,bogus"):
        code, txt = run_main(["--only", typo])
        if code != 0 and "unknown categor" in txt:
            ok(f"only-rejects-{typo}")
        else:
            bad(f"only-rejects-{typo}",
                f"--only {typo} exited {code} and printed a clean-looking report -- a typo "
                f"renders a defective library as clean:\n{txt[:220]}")


# --- 13. messages must not state app behaviour that cannot occur -------------
# A finding the user cannot trust is worse than no finding. Both of these named
# a consequence the app does not have.
def case_messages_are_true():
    r = valid_res(spoolWeight=None)
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    msgs = [m for rows in f.values() for _, m in rows]
    if any("nothing displays" in m for m in msgs):
        bad("msg-null-tare", "still claims 'nothing displays' -- inventoryStats substitutes a "
                             "0 g tare and the gram figure still renders")
    elif any("no spoolWeight (tare)" in m and "counts the spool" in m for m in msgs):
        ok("msg-null-tare")
    else:
        # Negative-only, this passed with the whole missing-tare check deleted.
        bad("msg-null-tare", f"the missing-tare case produced no finding at all: {msgs}")

    r2 = valid_res()
    r2["spools"][0]["totalWeight"] = 150      # below the 200 g tare
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    msgs2 = [m for rows in f2.values() for _, m in rows]
    if any("negative remaining" in m for m in msgs2):
        bad("msg-below-tare", "still claims 'negative remaining' -- every remaining computation "
                              "clamps at 0")
    elif any("clamps" in m and "below tare" in m and "reads as EMPTY" in m for m in msgs2):
        ok("msg-below-tare")
    else:
        bad("msg-below-tare",
            f"a SINGLE weighed spool below its tare empties the filament — matching only the "
            f"message prefix let the two consequences be swapped undetected: {msgs2}")

    # ...and the multi-spool consequence, which the app genuinely computes
    # differently: the spool clamps to 0 but still adds a whole `net` to
    # getRemainingPct's denominator, so it DRAGS the bar down rather than
    # emptying the filament.
    r3 = valid_res()
    r3["spools"] = [dict(r3["spools"][0], _id="s1", instanceId="bad", totalWeight=50),
                    dict(r3["spools"][0], _id="s2", instanceId="ok", totalWeight=950)]
    f3, _ = run({"c": rec(r3, copy.deepcopy(r3))})
    msgs3 = [m for rows in f3.values() for _, m in rows if "below tare" in m]
    if msgs3 and "drags the whole filament" in msgs3[0] and "reads as EMPTY" not in msgs3[0]:
        ok("msg-below-tare-multi")
    else:
        bad("msg-below-tare-multi",
            f"with a healthy weighed sibling the filament does NOT read as empty and spool-check "
            f"does not refuse every job: {msgs3}")


# --- 14. tombstoned calibration refs ----------------------------------------
# null `printer`/`bedType` is the schema's supported generic state and must stay
# silent; a SOFT-DELETED one means the tuning is unreachable.
def case_calibration_ref_tombstones():
    for field in ("printer", "bedType"):
        r = valid_res()
        r["calibrations"][0][field] = {"_id": "x1", "name": "Gone", "_deletedAt": "2026-01-01"}
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        hit = any(f"soft-deleted {field}" in m for rows in f.values() for _, m in rows)
        ok(f"cal-tombstone-{field}") if hit else bad(
            f"cal-tombstone-{field}",
            f"a soft-deleted calibration {field} produced no finding -> the tuning is "
            f"unreachable and the audit says nothing")
        # null is legitimate and must stay silent
        r2 = valid_res()
        r2["calibrations"][0][field] = None
        f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
        fp = [m for rows in f2.values() for _, m in rows if field in m]
        ok(f"cal-null-{field}-silent") if not fp else bad(
            f"cal-null-{field}-silent",
            f"null {field} is the schema default (generic calibration) but was flagged: {fp}")



# --- 14b. calibration SCOPE refs, which populate() hides ---------------------
# Both detail reads populate `calibrations.printer`/`.bedType`, so a purged
# target arrives as null — identical to the supported generic state. The pass
# therefore reads the UNPOPULATED ids from /api/snapshot instead, and this case
# exists because the record fuzz cannot reach that input at all.
def case_calibration_scope_refs():
    def idx(cal, printers=("p1",), bedtypes=("b1",)):
        return {"printers": set(printers), "bedTypes": set(bedtypes),
                "cals": {"a": [cal]}}

    r = valid_res()
    base = {"res": r, "raw": copy.deepcopy(r)}

    # a stored id that resolves to no row -> reported
    for field, dead in (("printer", "p_gone"), ("bedType", "b_gone")):
        f, _, _ = A.audit({"a": base}, (), None, None, None, idx({field: dead}))
        hit = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
        ok(f"cal-scope-dangling-{field}") if hit else bad(
            f"cal-scope-dangling-{field}",
            f"a {field} id with no surviving row produced no finding -> populate() nulls it, "
            f"so pickRepresentativeCalibration promotes that tuning to every machine")

    # a LIVE id, and a genuine generic null, must both stay silent
    for label, cal in (("live", {"printer": "p1", "bedType": "b1"}),
                       ("generic-null", {"printer": None, "bedType": None}),
                       ("absent", {})):
        f, _, _ = A.audit({"a": base}, (), None, None, None, idx(cal))
        fp = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
        ok(f"cal-scope-{label}-silent") if not fp else bad(
            f"cal-scope-{label}-silent", f"a {label} calibration scope was flagged: {fp}")

    # a filament the run did not audit must not be reported on
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      {"printers": set(), "bedTypes": set(),
                       "cals": {"other": [{"printer": "p_gone"}]}})
    fp = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
    ok("cal-scope-unaudited-skipped") if not fp else bad(
        "cal-scope-unaudited-skipped", f"reported on a filament this run never audited: {fp}")

    # the CONSEQUENCE must follow pickRepresentativeCalibration's actual
    # predicate (printer == null && bedType == null), not be pasted on both ways
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      idx({"printer": "p_gone", "bedType": None}))
    both = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      idx({"printer": "p_gone", "bedType": "b1"}))
    one = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
    if (both and "EVERY machine" in both[0]) and (one and "EVERY machine" not in one[0]
                                                  and "loses its printer scope" in one[0]):
        ok("cal-scope-consequence-branches")
    else:
        bad("cal-scope-consequence-branches",
            "a dangling printer beside a LIVE bed type fails pickRepresentativeCalibration's "
            "`printer == null && bedType == null`, so it does NOT become the export default; "
            f"the two cases must not carry the same sentence.\n    both-null: {both}\n"
            f"    one-live: {one}")

    # an ABSENT collection is not an empty one — collapsing them would report
    # every stored reference in the library as dangling at once
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      {"printers": None, "bedTypes": {"b1"},
                       "cals": {"a": [{"printer": "p_whatever", "bedType": "b1"}]}})
    fp = [m for rows in f.values() for _, m in rows if "resolves to no printer" in m]
    ok("cal-scope-absent-collection") if not fp else bad(
        "cal-scope-absent-collection",
        f"the snapshot carried no printers collection, so no printer ref can be judged; "
        f"reporting one is a false claim: {fp}")

    # an OMITTED collection must say so too — distinguishing absent from empty
    # avoids a false positive, but staying silent about it makes an UNCHECKED
    # category look like a clean one, which is the worse failure
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      {"printers": None, "bedTypes": {"b1"},
                       "cals": {"a": [{"printer": "p1", "bedType": "b1"}]}})
    hit = [m for rows in f.values() for _, m in rows
           if "printer references were NOT checked" in m]
    ok("cal-scope-omitted-collection-visible") if hit else bad(
        "cal-scope-omitted-collection-visible",
        "the snapshot carried no `printers` collection, so every printer scope went unchecked "
        "and the report rendered as structurally clean")

    # a spool pointing at a SOFT-DELETED location is just as broken as one
    # pointing at a purged one — /api/spools/by-location joins with
    # `_deletedAt: null` — so the location set must be built from ACTIVE rows,
    # unlike the printer/bedType sets where a tombstone still populates
    rl = valid_res()
    rl["spools"][0]["locationId"] = "6a1a7bef677d648e9ba9cd99"   # real shape, no such row
    f, _, _ = A.audit({"a": rec(rl, copy.deepcopy(rl))}, (), None, None, None,
                      {"printers": set(), "bedTypes": set(), "locations": set(), "cals": {}})
    hit = [m for rows in f.values() for _, m in rows if "resolves to no Location row" in m]
    ok("location-dangling") if hit else bad(
        "location-dangling", "a spool pointing at a location that is gone renders in a second "
                             "'no location' group and drops out of every kind-filtered view")

    # ...and when the snapshot carried no locations at all, SAY so
    f, _, _ = A.audit({"a": rec(rl, copy.deepcopy(rl))}, (), None, None, None,
                      {"printers": set(), "bedTypes": set(), "cals": {}})
    hit = [m for rows in f.values() for _, m in rows
           if "location references were NOT checked" in m]
    ok("location-notchecked-visible") if hit else bad(
        "location-notchecked-visible",
        "with no locations collection every locationId went unexamined and the structural section "
        "read as clean")

    # a FAILED snapshot read must say so, not silently render as clean
    f, _, _ = A.audit({"a": base}, (), None, None, None, {"error": "HTTP 500"})
    hit = [m for rows in f.values() for _, m in rows if "were NOT checked" in m]
    ok("cal-scope-degraded-visible") if hit else bad(
        "cal-scope-degraded-visible",
        "the snapshot read failed and the audit reported nothing about it -> an unchecked "
        "category rendering as a clean one")


# --- 14c. ref_index is EXTERNAL input, so fuzz it like one -------------------
# The record fuzz walks valid_res() and can never reach audit()'s ref_index
# argument, which is built from a /api/snapshot response — a partial, older or
# hostile one included. A crash there aborts the whole run and hides every
# finding, which is the one failure this checker must not have, so the shapes
# get their own sweep. This found four crash sites the first time it ran
# (`x in 42` raises rather than returning False).
def case_ref_index_hostile_shapes():
    hostile = [None, "", 0, [], {}, "oops", 42, True, {"x": 1}, ["a"], set(), 3.5,
               float("nan")]
    cals = [None, "oops", 42, [], [None], ["oops"], [42], [{"printer": "p"}],
            [{"printer": ["p"]}], [{"printer": {"_id": "p"}}], [{"bedType": 0}],
            [{"printer": True}], [{"printer": float("inf")}], {"not": "a list"},
            [{"printer": "p", "bedType": "b"}], [{}], [[{"printer": "p"}]]]
    rec_one = {"a": rec(valid_res())}
    sites, n = {}, 0
    for printers in hostile:
        for bedtypes in hostile[:8]:
            for cal in cals:
                for key in ("a", "missing", 42, None):
                    n += 1
                    try:
                        A.audit(rec_one, (), None, None, None,
                                {"printers": printers, "bedTypes": bedtypes,
                                 "cals": {key: cal}})
                    except Exception:
                        tb = traceback.format_exc().strip().splitlines()
                        sites[next((l.strip() for l in reversed(tb) if "audit.py" in l),
                                   tb[-1])] = tb[-1]
    for idx in hostile + [{"error": None}, {"error": []}, {"cals": None}, {"cals": "oops"},
                          {"cals": {"a": None}}, {"error": "x", "cals": {"a": [{}]}}]:
        n += 1
        try:
            A.audit(rec_one, (), None, None, None, idx)
        except Exception:
            tb = traceback.format_exc().strip().splitlines()
            sites[next((l.strip() for l in reversed(tb) if "audit.py" in l), tb[-1])] = tb[-1]
    if sites:
        bad("ref-index-hostile",
            f"{len(sites)} crash site(s) over {n} ref_index shapes — a crash here aborts the "
            f"whole audit:\n    " + "\n    ".join(f"{k}\n      {v}" for k, v in sites.items()))
    else:
        ok(f"ref-index-hostile ({n} shapes)")


# --- 14d. the Date mirror must never condemn a date the app accepts ----------
# Mongoose casts a string with `new Date(v)`, so the predicate has to mirror V8
# — which accepts far more than ISO 8601, INCLUDING "2020-02-30" (rolled over to
# Mar 1) and "2026-1-5". Anything stricter condemns a date the app stores
# happily. Ground truth below was taken from node's own `new Date` and is
# pinned here so a future "tightening" cannot silently start lying.
def case_date_mirror():
    accepted = ["2026-01-05", "2026-01-05T00:00:00.000Z", "2026-01-05T12:34:56+02:00",
                # TIME half — hour 24 is legal at exactly 24:00:00, and a -14:00
                # offset is real (Baker Island). Both verified against node.
                "2026-01-05T24:00:00Z", "2026-01-05T23:59:59Z", "2026-01-05T12:00",
                "2026-01-05T12:00:00-14:00", "2026-01-05T12:00:00.123456789Z",
                "2026-01-05 12:00", "2026-01-05t12:00:00z", "2026-01-05T09:05:05Z",
                "2026-1-5", "2026/01/05", "Jan 1 2020", "1 Jan 2020", "January 1, 2020",
                "2020", "2020-02-30", "2019-02-29", "2020-02-29", "9999-12-31",
                "  2026-01-05  ", "5/6/2020", "12345", "0", "2026-01-05 12:00",
                "Mon Jan 01 2020", "1970-01-01T00:00:00.000Z"]
    # `new Date(arr)` is exactly `new Date(String(arr))`, so an array has to be
    # coerced and judged as a string — "a non-empty array may well parse" was
    # only half true. Both directions pinned against node.
    accepted_arrays = [["2020-01-01"], [2020, 1, 1], [0], [["2020-01-01"]], ["  2020-01-01  "]]
    fp_arr = [v for v in accepted_arrays if A._bad_date(v)]
    ok("date-mirror-arrays-accepted") if not fp_arr else bad(
        "date-mirror-arrays-accepted", f"node accepts these arrays as dates: {fp_arr}")
    rejected_arrays = [["not-a-date"], [{}], [None], [[]], [True], [{"a": 1}], ["2020-13-01"]]
    fn_arr = [v for v in rejected_arrays if not A._bad_date(v)]
    ok("date-mirror-arrays-rejected") if not fn_arr else bad(
        "date-mirror-arrays-rejected",
        f"these stringify to an Invalid Date, so toISOString() throws and the cast fails: {fn_arr}")

    rejected = ["2020-13-01", "2020-00-10", "2020-01-32", "2020-01-00", "not-a-date",
                # a sane date prefix says NOTHING about the timestamp
                "2020-01-01T25:00:00Z", "2020-01-01T24:00:01Z", "2020-01-01T12:61:00Z",
                "2020-01-01T12:00:60Z", "2020-01-01T23:59:60Z", "2020-01-01T12:00:00+25:00",
                "", "   ", "0000-00-00", "null", "undefined", "NaN", "Invalid Date",
                "-", "T", "Z", "true", "false", "date", {}, []]
    fp = [v for v in accepted if A._bad_date(v)]
    fn = [v for v in rejected if not A._bad_date(v)]
    if fp:
        bad("date-mirror-no-false-positives",
            f"node's `new Date` ACCEPTS these, so the app stores them and Mongoose casts them "
            f"— condemning one tells the user to break working data: {fp}")
    else:
        ok("date-mirror-no-false-positives")
    if fn:
        bad("date-mirror-catches-the-certain",
            f"node's `new Date` REJECTS these, so Mongoose raises CastError and the audit says "
            f"nothing: {fn}")
    else:
        ok("date-mirror-catches-the-certain")
    # numbers cast to an instant — but only INSIDE the ECMAScript time value
    # range. Both boundaries verified against node.
    live = [v for v in (0, 1, 12345, -1, 1.5, True, False,
                        A.JS_MAX_TIME_VALUE, -A.JS_MAX_TIME_VALUE) if A._bad_date(v)]
    ok("date-mirror-numeric-silent") if not live else bad(
        "date-mirror-numeric-silent",
        f"`new Date(<number>)` inside +/-8.64e15 is a valid instant; reported anyway: {live}")
    dead = [v for v in (A.JS_MAX_TIME_VALUE + 1, -A.JS_MAX_TIME_VALUE - 1,
                        float("nan"), float("inf"), float("-inf")) if not A._bad_date(v)]
    ok("date-mirror-numeric-range") if not dead else bad(
        "date-mirror-numeric-range",
        f"outside +/-8.64e15 (and NaN/Inf) `new Date` is Invalid, so toISOString() throws and the "
        f"cast fails; not reported: {dead}")


# --- 14e. per-record state must not leak between records ---------------------
# The text sweep BUILDS `coerced_*` in one loop and the colour checks READ them
# in a LATER one, so a bare loop-local left the FINAL record's state standing in
# for every record: one non-string `color` on the last row silently disabled the
# malformed-colour check for the whole library. Every case in this suite bar
# these ran ONE record, which is exactly why it survived — so the assertion has
# to be multi-record and order-sensitive.
def case_no_cross_record_leak():
    first = valid_res(_id="a", name="First", color="red")          # malformed STRING
    last = valid_res(_id="b", name="Last", color={"hex": "#fff"})  # non-string -> coerced
    f, _ = run({"a": rec(first, copy.deepcopy(first)), "b": rec(last, copy.deepcopy(last))})
    rows = [m for rows_ in f.values() for _, m in rows_]
    if any("First: malformed color" in m for m in rows):
        ok("no-leak-malformed-colour")
    else:
        bad("no-leak-malformed-colour",
            "a non-string `color` on the LAST record suppressed the malformed-colour finding on "
            "an EARLIER one — per-record coercion state is leaking through a loop-local")

    grey = valid_res(_id="c", name="Grey One", color="#808080", colorName=None)
    last2 = valid_res(_id="d", name="Last", colorName=["x"])
    f, _ = run({"c": rec(grey, copy.deepcopy(grey)), "d": rec(last2, copy.deepcopy(last2))})
    rows = [m for rows_ in f.values() for _, m in rows_]
    if any("Grey One" in m and "808080" in m for m in rows):
        ok("no-leak-colour-sentinel")
    else:
        bad("no-leak-colour-sentinel",
            "a non-string `colorName` on the LAST record suppressed the #808080 sentinel finding "
            "on an EARLIER one — same loop-local leak")


# --- 14f. one field, five shapes, five different consequences ----------------
# `presets[].label` is the clearest instance of the rule that keeps being broken
# here: shapes that fail DIFFERENTLY must not share a sentence. React renders a
# number child happily and Mongoose casts it through the String path, so the
# page-crash claim belongs only to the shapes that actually throw.
def case_preset_label_shapes():
    want = {
        "throws": [{"x": 1}, ["a", {"b": 2}]],       # React invalid-child error
        "REQUIRED": [None, ""],                       # schema violation -> backup refused
        "casts it to a string": [5, True],            # off-type, harmless
        "EMPTY name": ["   "],                        # valid, but invisible
    }
    for phrase, values in want.items():
        for val in values:
            r = valid_res()
            r["presets"][0]["label"] = val
            f, _ = run({"a": rec(r, copy.deepcopy(r))})
            rows = [m for rows_ in f.values() for _, m in rows_ if "presets[0].label" in m]
            if not rows:
                bad(f"preset-label-{phrase[:12]}", f"label={val!r} produced no finding at all")
            elif not any(phrase in m for m in rows):
                bad(f"preset-label-{phrase[:12]}",
                    f"label={val!r} must be described with {phrase!r}; got: {rows}")
            else:
                ok(f"preset-label-{type(val).__name__}-{str(val)[:6]}")
    r = valid_res()
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    fp = [m for rows_ in f.values() for _, m in rows_ if "presets[0].label" in m]
    ok("preset-label-valid-silent") if not fp else bad(
        "preset-label-valid-silent", f"a normal label was flagged: {fp}")


# --- 14g. a document-derived identifier must not carry itself into the report -
# Every row for a spool embeds its id, and that id comes from the API — nothing
# the app enforces bounds it on the way in. A 4 KB instanceId would otherwise
# reproduce itself, in full, in every row about that spool.
def case_identifier_is_bounded():
    r = valid_res()
    r["spools"][0]["instanceId"] = "x" * 4000
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_ if "instanceId" in m]
    if not rows:
        return bad("identifier-bounded", "an over-long instanceId produced no finding at all")
    worst = max(len(m) for m in rows)
    ok("identifier-bounded") if worst < 600 else bad(
        "identifier-bounded",
        f"a 4000-character instanceId produced a {worst}-character row — a document-derived "
        f"identifier is carrying itself verbatim through the report")


# --- 14h. the density FLOOR has an exemption, like the temperature floor -----
# The app's own bundled reference documents LW-PLA at 0.40-0.48 g/cm3 fully
# foamed, so a flat 0.7 floor condemned a documented material — and the
# metal-fill hint pasted onto the below-floor case told the user to add optTag
# 20, which does not move the floor AND marks the filament abrasive.
def case_density_floor_exempts_foaming():
    for typ, dens in [("LW-PLA", 0.43), ("LW PLA", 0.45), ("LWPLA", 0.40),
                      ("PLA Foaming", 0.44), ("LW-ASA", 0.48)]:
        r = valid_res(type=typ, density=dens, optTags=[])
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        fp = [m for rows in f.values() for _, m in rows if "outside the plausible" in m]
        if fp:
            bad("density-floor-foaming",
                f"{typ} at {dens} g/cm3 is what the bundled reference documents; flagged: {fp}")
            return
    ok("density-floor-foaming")
    # ...and an impossible value still reports, against the foaming floor
    r = valid_res(type="LW-PLA", density=0.05, optTags=[])
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    hit = [m for rows in f.values() for _, m in rows if "outside the plausible" in m]
    ok("density-floor-still-bounded") if hit else bad(
        "density-floor-still-bounded", "0.05 g/cm3 is impossible for any grade and was not reported")

    # the metal-fill hint belongs to the CEILING only
    r = valid_res(type="PLA", density=0.43, optTags=[])
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    low = [m for rows in f.values() for _, m in rows if "outside the plausible" in m]
    if low and "add optTag 20" in low[0] and "Do NOT add optTag 20" not in low[0]:
        bad("density-floor-hint",
            "the below-floor row tells the user to add optTag 20 — it does not move the floor and "
            "it puts the filament in ABRASIVE_OPT_TAGS, so the audit's own abrasive category then "
            "fires on a soft foaming PLA")
    else:
        ok("density-floor-hint")


# --- 14i. a promotion moves the #732 carry-over id WITH the roll -------------
# The carry-over exemption keys on the spool living on the filament whose id it
# copied. promoteParent moves spools to a new variant with `instanceId`
# preserved while the parent keeps its own — so the audit's OWN prescribed
# remedy ("Convert to template") used to manufacture a false shadow finding on
# the next run, with the consequence backwards.
def case_promotion_carryover_exempt():
    carry = "aabbccddee"
    for label, top in (("exact", carry), ("case twin", carry.upper())):
        par = valid_res(_id="p", name="PLA Family", instanceId=top, spools=[], color=None,
                        colorName=None, totalWeight=None, lowStockThreshold=None)
        var = valid_res(_id="v", name="PLA Family — Original", parentId="p",
                        instanceId="ffffffffff")
        var["spools"] = [dict(var["spools"][0], instanceId=carry)]
        f, _ = run({"p": rec(par, copy.deepcopy(par)), "v": rec(var, copy.deepcopy(var))},
                   topology={"p": True})
        fp = [m for rows in f.values() for _, m in rows if carry.lower() in m.lower()]
        if fp:
            bad(f"promotion-carryover-{label}",
                f"a promoted carry-over id is the INTENDED state — the label resolves to the "
                f"variant now holding the roll — but was reported: {fp}")
        else:
            ok(f"promotion-carryover-{label}")

    # a genuinely FOREIGN family must still report, both exactly and by case
    for label, top in (("exact", carry), ("case twin", carry.upper())):
        oth = valid_res(_id="o", name="Unrelated", instanceId=top)
        v2 = valid_res(_id="v2", name="Other — Blue", instanceId="gggggggggg")
        v2["spools"] = [dict(v2["spools"][0], instanceId=carry)]
        f, _ = run({"o": rec(oth, copy.deepcopy(oth)), "v2": rec(v2, copy.deepcopy(v2))})
        hit = [m for rows in f.values() for _, m in rows if carry.lower() in m.lower()]
        ok(f"foreign-shadow-{label}") if hit else bad(
            f"foreign-shadow-{label}",
            "the kinship exemption is over-broad — an unrelated filament's id is genuinely "
            "shadowed and must still report")


# --- 14j. a MALFORMED value is never a MISSING one ---------------------------
# num() answers None for both, so every check that branches on a num() result
# has to test the underlying field before claiming absence — otherwise it
# contradicts the numeric sweep that just named the off-type value, and can
# stack a second "every spool is missing its gross weight" on top.
def case_malformed_is_not_missing():
    r = valid_res()
    r["spools"][0]["totalWeight"] = "oops"
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_]
    contradictions = [m for m in rows
                      if "has no totalWeight" in m or "missing its gross weight" in m]
    named = [m for m in rows if "not a number" in m]
    if contradictions:
        bad("malformed-gross-not-missing",
            f"a malformed gross weight was reported as ABSENT, contradicting the numeric "
            f"sweep's own row: {contradictions}")
    elif not named:
        bad("malformed-gross-not-missing", "a malformed gross weight produced no finding at all")
    else:
        ok("malformed-gross-not-missing")
    r2 = valid_res()
    del r2["spools"][0]["totalWeight"]
    f, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    hit = [m for rows_ in f.values() for _, m in rows_ if "has no totalWeight" in m]
    ok("absent-gross-still-reported") if hit else bad(
        "absent-gross-still-reported", "a genuinely absent gross weight stopped being reported")


# --- 14k. identity and date fields the schema declares but nothing checked ---
def case_identity_and_dates():
    r = valid_res(instanceId=None)
    r["spools"] = []
    r["totalWeight"] = 800
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    hit = [m for rows_ in f.values() for _, m in rows_ if "no filament-level instanceId" in m]
    if hit and "422" in hit[0]:
        ok("top-instanceid-absent")
    else:
        bad("top-instanceid-absent",
            "a spool-less filament with no instanceId leaves selectSpoolForWrite with no id at "
            f"all, so openprinttag answers 422; got: {hit}")
    # The instanceId CONTRACT — two ceilings, and the lower one is silent.
    # `selectSpoolForWrite` hands whichever id it picks to the OpenPrintTag
    # encoder as `spoolUid`, and that field OMITS anything past 16 characters
    # (GH #952: truncating would read back as a different id), so both the spool
    # id and the filament-level fallback need the same three checks.
    for holder in ("spool", "filament"):
        for val, needle in ((("a" * 17), "16-character OpenPrintTag"),
                            (("a" * 129), "128-character contract"),
                            ("has space!", "allowed charset"),
                            # trimmed for the CHECK but stored with the spaces:
                            # every scan path trims before querying while the
                            # writers encode it as stored, so no tier can match
                            ("  abc  ", "surrounding whitespace")):
            rr = valid_res()
            if holder == "spool":
                rr["spools"][0]["instanceId"] = val
            else:
                rr["instanceId"] = val
                rr["spools"] = []
            f, _ = run({"a": rec(rr, copy.deepcopy(rr))})
            got = [m for rows in f.values() for _, m in rows
                   if "instanceId" in m and needle in m]
            ok(f"idcontract-{holder}-{needle[:12]}") if got else bad(
                f"idcontract-{holder}-{needle[:12]}",
                f"a {holder}-level id of {val[:6]}... violates {needle} and must be reported — "
                f"the id is present and looks fine, so nothing else catches it")
        # ...and a normal id stays silent on BOTH
        rr = valid_res()
        if holder == "filament":
            rr["spools"] = []
        f, _ = run({"a": rec(rr, copy.deepcopy(rr))})
        fp = [m for rows in f.values() for _, m in rows
              if "instanceId" in m and "characters" in m]
        ok(f"idcontract-{holder}-normal-silent") if not fp else bad(
            f"idcontract-{holder}-normal-silent", f"a normal 10-hex id was flagged: {fp}")

    r2 = valid_res()
    r2["spools"][0]["createdAt"] = "not-a-date"
    f, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    hit = [m for rows_ in f.values() for _, m in rows_ if "createdAt" in m]
    ok("spool-createdat-castable") if hit else bad(
        "spool-createdat-castable",
        "`spools[].createdAt` is a declared schema Date; an uncastable value fails the restore")
    if hit and "RangeError" in hit[0]:
        bad("spool-createdat-consequence",
            "createdAt has no render site — it must not inherit the SpoolCard's RangeError "
            "consequence from purchaseDate/openedDate")
    else:
        ok("spool-createdat-consequence")


# --- 14l. _inh_blame's ATTRIBUTION branches, positively ----------------------
# Both value-bearing branches of _inh_blame — "INHERITED from template" and
# "MIXED" — could be deleted outright and the suite still reported green: every
# existing assertion only checks that a row is ABSENT on the variant, never that
# the row the template gets carries the attribution the reader needs. These
# assert the text itself, on the same template/variant pair.
def case_inh_blame_attribution():
    def family(res_over, inherited, raw_over=None):
        t = valid_res(_id="t", name="Prusament PLA", parentId=None, spools=[], color=None,
                      colorName=None, totalWeight=None, lowStockThreshold=None)
        k = valid_res(_id="k", name="Prusament PLA — Blue", parentId="t", **res_over)
        k["_inherited"] = inherited
        kraw = copy.deepcopy(k)
        for f2 in inherited:
            kraw.pop(f2, None)
        if raw_over:
            kraw.update(raw_over)
        return {"t": rec(t, copy.deepcopy(t)), "k": {"res": k, "raw": kraw}}

    def rows_for(recs, needle):
        f, _ = run(recs, topology={"t": True})
        return [m for rows in f.values() for _, m in rows if needle in m]

    # 1. ALL roots inherited -> the single-owner sentence. Uses the saturation
    #    row, which goes through _inh_blame; the bounds rows go through the
    #    separate `_blame` helper and would not have exercised this at all.
    sat = {"netFilamentWeight": 1000, "spoolWeight": 200,
           "spools": [dict(valid_res()["spools"][0], totalWeight=1400)]}
    got = rows_for(family(sat, ["netFilamentWeight", "spoolWeight"]), "SATURATE")
    if got and "INHERITED from template 'Prusament PLA'" in got[0]:
        ok("inh-blame-single-owner")
    else:
        bad("inh-blame-single-owner",
            f"an inherited value must name the template that owns it, or the reader edits the one "
            f"document that cannot fix it; got: {got}")

    # 2. MIXED ownership -> both sides named
    got = rows_for(family({"minPrintSpeed": 500, "maxPrintSpeed": 200}, ["maxPrintSpeed"]),
                   "INVERTED print speed")
    if got and "MIXED:" in got[0] and "maxPrintSpeed" in got[0] and "minPrintSpeed" in got[0]:
        ok("inh-blame-mixed")
    else:
        bad("inh-blame-mixed",
            f"a local value against an inherited one has two different repairs and the row must "
            f"name both sides; got: {got}")

    # 3. an inherited whole-array root attributes through bounds_check
    cal = copy.deepcopy(valid_res()["calibrations"])
    cal[0]["extrusionMultiplier"] = -1
    got = rows_for(family({"calibrations": cal}, ["calibrations"], {"calibrations": []}),
                   "extrusionMultiplier=-1")
    if got and "INHERITED from template" in got[0]:
        ok("inh-blame-array-root")
    else:
        bad("inh-blame-array-root",
            f"an inherited calibrations array must attribute to the template; got: {got}")

    # 4. an EMPTY stored array is the inherit sentinel, not local ownership —
    #    it must never force the MIXED branch on the ordinary variant shape
    got = rows_for(family({"density": 3.0, "optTags": []}, ["density"], {"optTags": []}),
                   "density 3.0")
    if got and "MIXED:" in got[0]:
        bad("inh-blame-empty-array-not-owned",
            f"an empty stored array is resolveFilament's INHERIT sentinel; calling it "
            f"'stored here' gives the default variant shape a false MIXED clause: {got}")
    else:
        ok("inh-blame-empty-array-not-owned")


# --- 14m. the abrasive category, which nothing exercised ---------------------
# The whole /api/abrasive-nozzles consumption loop — all three emit branches —
# never executed under this suite, in the category where a miss means a ruined
# nozzle. Five regressions could ship silently, including the deliberate rule
# that `inheritedFrom` must NOT be pasted onto a flag-only row.
def case_abrasive_payload():
    r = valid_res(_id="a", name="CF PLA")
    payload = [
        {"filamentId": "a", "filamentName": "CF PLA", "reasons": ["tagged"],
         "flagMismatch": True, "softNozzles": [], "unassigned": False,
         "inheritedFrom": "Some Template"},
        {"filamentId": "b", "filamentName": "GF PA", "reasons": ["filled"],
         "flagMismatch": False, "softNozzles": [{"name": "0.4 Brass"}], "unassigned": False,
         "inheritedFrom": "GF PA Template"},
        {"filamentId": "c", "filamentName": "Metal PLA", "reasons": ["tagged"],
         "flagMismatch": False, "softNozzles": [], "unassigned": True,
         "inheritedFrom": "Metal Template"},
    ]
    f, _ = run({"a": rec(r, copy.deepcopy(r))}, abrasive=payload)
    rows = [m for _, m in f.get("abrasive", [])]

    flag = [m for m in rows if "EXPORTS AS NON-ABRASIVE" in m]
    soft = [m for m in rows if "unfit nozzle" in m]
    unas = [m for m in rows if "no nozzle assignment" in m]
    for label, got in (("flagMismatch", flag), ("softNozzles", soft), ("unassigned", unas)):
        ok(f"abrasive-{label}") if got else bad(
            f"abrasive-{label}", f"the {label} branch emitted nothing; rows were {rows}")

    # The route populates `inheritedFrom` only for NOZZLE-scoped findings; on a
    # flag-only row the inherited nozzle set is already correct, so pasting it
    # would send the user to edit something healthy.
    if flag and "inherited from" in flag[0]:
        bad("abrasive-flag-no-inherited-hint",
            "the nozzle-scoped 'inherited from' hint was pasted onto a FLAG-ONLY row — it points "
            "the fix at the template when filament_abrasive may be this variant's own bag entry")
    else:
        ok("abrasive-flag-no-inherited-hint")
    if soft and "inherited from" in soft[0]:
        ok("abrasive-soft-keeps-hint")
    else:
        bad("abrasive-soft-keeps-hint",
            "a nozzle-scoped row must keep the hint that says WHERE the nozzles come from")

    # a malformed payload entry must be reported, never skipped in silence
    f, _ = run({"a": rec(r, copy.deepcopy(r))}, abrasive=["oops", 42])
    rows = [m for _, m in f.get("abrasive", [])]
    ok("abrasive-malformed-entry") if len(rows) >= 2 else bad(
        "abrasive-malformed-entry",
        f"a non-dict entry in the abrasive payload must be reported as NOT CHECKED; got {rows}")

    # and a payload that is not a list at all (the route returned an error body)
    f, _ = run({"a": rec(r, copy.deepcopy(r))}, abrasive={"error": "HTTP 500"})
    rows = [m for _, m in f.get("abrasive", [])]
    ok("abrasive-error-payload") if rows else bad(
        "abrasive-error-payload",
        "an abrasive payload that failed to load rendered as 'no abrasive problems'")


# --- 14n. add_shape dedups identical rows, NOT different ones ----------------
# Only the "collapse to one row" half was asserted, so regressing the key to
# (cat, ident) — dropping the message — would silently discard the stored-read
# row whenever the two reads carry DIFFERENT malformed values.
def case_shape_dedup_keeps_distinct():
    res = valid_res(type=5)
    raw = valid_res(type=["x"])
    f, _ = run({"c": {"res": res, "raw": raw}})
    rows = [m for rows_ in f.values() for _, m in rows_ if ": type is" in m]
    has_res = any("is int" in m and "(resolved)" in m for m in rows)
    has_raw = any("is list" in m and "(stored)" in m for m in rows)
    if has_res and has_raw:
        ok("shape-dedup-keeps-distinct")
    else:
        bad("shape-dedup-keeps-distinct",
            f"two DIFFERENT malformed values at the same path are two defects and must both "
            f"report; got: {rows}")


# --- 14o. the cross-record spool-identity block ------------------------------
# Three of its five reports never executed under this suite and the other two
# only incidentally — mutation testing showed all five could be deleted while
# the suite stayed green. Every one of them is about a printed QR or a written
# NFC tag resolving to the wrong roll, so they are worth asserting by hand.
def case_instance_id_shadows():
    def two(a_over, b_over, topo=None):
        a = valid_res(_id="fa", name="Alpha", **a_over)
        b = valid_res(_id="fb", name="Beta", **b_over)
        return run({"fa": rec(a, copy.deepcopy(a)), "fb": rec(b, copy.deepcopy(b))},
                   topology=topo)

    def spools(*ids):
        base = valid_res()["spools"][0]
        return [dict(base, _id=f"s{i}", instanceId=v) for i, v in enumerate(ids)]

    # (a) the SAME spool id on two different filaments -> no match at all
    f, _ = two({"instanceId": "aaaaaaaaa1", "spools": spools("dupdupdup0")},
               {"instanceId": "aaaaaaaaa2", "spools": spools("dupdupdup0")})
    rows = [m for rows_ in f.values() for _, m in rows_ if "different filaments" in m]
    ok("shadow-cross-filament") if rows else bad(
        "shadow-cross-filament",
        "one spool id on two filaments makes matchFilament return NO match with both as "
        "candidates — every label holding it stops resolving")

    # (b) the same id twice on ONE filament -> resolves, but to an arbitrary roll
    f, _ = two({"instanceId": "aaaaaaaaa1", "spools": spools("twicetwice", "twicetwice")},
               {"instanceId": "aaaaaaaaa2"})
    rows = [m for rows_ in f.values() for _, m in rows_ if "its own spools" in m]
    ok("shadow-same-filament") if rows else bad(
        "shadow-same-filament",
        "two spools sharing an id still resolve the filament, but WHICH roll is array order — a "
        "weight update can land on the wrong spool")

    # (c) a spool id equal to ANOTHER filament's top-level id
    f, _ = two({"instanceId": "shadowed01"},
               {"instanceId": "bbbbbbbbb2", "spools": spools("shadowed01")})
    rows = [m for rows_ in f.values() for _, m in rows_ if "FILAMENT-level instanceId" in m]
    ok("shadow-top-level") if rows else bad(
        "shadow-top-level",
        "the spool tier runs first, so a label carrying that filament's own id resolves to the "
        "spool owner instead")

    # (d) ...and the same, differing only by CASE — matchFilament runs its
    #     case-insensitive SPOOL tier before the exact filament tier
    f, _ = two({"instanceId": "SHADOWED01"},
               {"instanceId": "bbbbbbbbb2", "spools": spools("shadowed01")})
    rows = [m for rows_ in f.values() for _, m in rows_ if "only by CASE" in m]
    ok("shadow-case-twin") if rows else bad(
        "shadow-case-twin",
        "a case-only twin shadows a filament id just as completely as an exact duplicate")

    # (e) two filaments sharing a TOP-LEVEL id -> findOne picks arbitrarily
    f, _ = two({"instanceId": "sametopid0"}, {"instanceId": "sametopid0"})
    rows = [m for rows_ in f.values() for _, m in rows_ if "filament-level instanceId" in m]
    if rows and "findOne" in rows[0]:
        ok("shadow-duplicate-top")
    else:
        bad("shadow-duplicate-top",
            f"that tier is a findOne, so the scan resolves SILENTLY to an arbitrary row and "
            f"reports it as a confident match — 'ambiguous' would be the benign outcome: {rows}")

    # NEGATIVE: a spool id equal to ITS OWN filament's is the #732 carry-over
    f, _ = two({"instanceId": "carryover1", "spools": spools("carryover1")},
               {"instanceId": "bbbbbbbbb2"})
    fp = [m for rows_ in f.values() for _, m in rows_ if "carryover1" in m]
    ok("shadow-carryover-silent") if not fp else bad(
        "shadow-carryover-silent",
        f"the #732 Phase 1 carry-over is legitimate — exactly what isSpoolInstanceIdTaken's "
        f"ownFilamentId excludes: {fp}")


# --- 14p. the heuristic checks, and their NEGATIVES --------------------------
# Every row here is a judgement call, so each needs a paired case proving it
# stays silent on the data it must not condemn. Table-driven so a new heuristic
# is one line, and so the negative is impossible to forget.
def case_heuristics_and_negatives():
    def fire(over, needle, spool_over=None):
        r = valid_res(**over)
        if spool_over:
            r["spools"][0].update(spool_over)
        f, _ = run({"h": rec(r, copy.deepcopy(r))})
        return [m for rows in f.values() for _, m in rows if needle in m]

    POSITIVE = [
        ("drying hours-for-minutes", {"dryingTime": 4, "dryingTemperature": 45}, "MINUTES"),
        ("diameter off-standard",    {"diameter": 2.0}, "not a standard size"),
        ("secondaryColors past cap", {"secondaryColors": ["#111111"] * 6}, "past the OpenPrintTag"),
        ("bad secondary hex",        {"secondaryColors": ["nope"]}, "is not #RRGGBB"),
        ("bedType case twin",        {"bedTypeTemps": [{"bedType": "hot plate",
                                                        "temperature": 60,
                                                        "firstLayerTemperature": 65}]},
                                     "only by case/whitespace"),
        # chamberTemp lives on the CALIBRATION, not on `temperatures` — the
        # top-level `chamber` is bounded by NUMERIC_BOUNDS instead.
        ("calibration chamberTemp",  {"calibrations": [dict(valid_res()["calibrations"][0],
                                                            chamberTemp=400)]}, "chamberTemp"),
    ]
    for label, over, needle in POSITIVE:
        ok(f"heuristic+{label}") if fire(over, needle) else bad(
            f"heuristic+{label}", f"{label}: expected a row containing {needle!r}")

    NEGATIVE = [
        ("drying minutes are fine",   {"dryingTime": 240, "dryingTemperature": 45}, "MINUTES"),
        ("drying with no temp",       {"dryingTime": 4, "dryingTemperature": None}, "MINUTES"),
        ("1.75 / 2.85 / 3.0",         {"diameter": 2.85}, "not a standard size"),
        ("exactly 5 secondaries",     {"secondaryColors": ["#111111"] * 5},
                                      "past the OpenPrintTag"),
        ("free-text bed surface",     {"bedTypeTemps": [{"bedType": "Textured PEI",
                                                         "temperature": 60,
                                                         "firstLayerTemperature": 65}]},
                                      "only by case/whitespace"),
        ("canonical plate key",       {"bedTypeTemps": [{"bedType": "Hot Plate",
                                                         "temperature": 60,
                                                         "firstLayerTemperature": 65}]},
                                      "only by case/whitespace"),
    ]
    for label, over, needle in NEGATIVE:
        fp = fire(over, needle)
        ok(f"heuristic-{label}") if not fp else bad(
            f"heuristic-{label}", f"{label}: must stay silent, got {fp}")


# --- 14q. unreachable calibrations, from BOTH sides --------------------------
# A template owning calibrations with no ticks was invisible twice over: the
# template by the `not is_template` guard, and the inheriting child by counting
# its STORED (empty) array. v1.70 keeps calibrations on the template as shared
# spec, so this is the normal place for them to live.
def case_unreachable_calibrations():
    cal = valid_res()["calibrations"]

    def family(ticks, kid_inherits):
        t = valid_res(_id="t", name="Family", parentId=None, spools=[], color=None,
                      colorName=None, totalWeight=None, lowStockThreshold=None,
                      compatibleNozzles=ticks, calibrations=copy.deepcopy(cal))
        k = valid_res(_id="k", name="Family — Blue", parentId="t",
                      compatibleNozzles=ticks, calibrations=copy.deepcopy(cal))
        k["_inherited"] = ["calibrations", "compatibleNozzles"] if kid_inherits else []
        kraw = copy.deepcopy(k)
        if kid_inherits:
            kraw["calibrations"] = []
            kraw["compatibleNozzles"] = []
        f, _ = run({"t": rec(t, copy.deepcopy(t)), "k": {"res": k, "raw": kraw}},
                   topology={"t": True})
        return [m for rows in f.values() for _, m in rows if "no compatibleNozzles" in m]

    got = family([], True)
    if len(got) == 1 and got[0].startswith("Family:"):
        ok("unreachable-cals-template")
    else:
        bad("unreachable-cals-template",
            f"a template owning calibrations with no ticks makes every row unreachable in ITS "
            f"form and in every inheriting variant's — expected exactly one row, on the "
            f"template; got {got}")

    ok("unreachable-cals-healthy") if not family(valid_res()["compatibleNozzles"], True) else bad(
        "unreachable-cals-healthy", "a ticked template must stay silent")

    got = family([], False)
    ok("unreachable-cals-variant-owned") if any(m.startswith("Family — Blue") for m in got) else bad(
        "unreachable-cals-variant-owned",
        f"a variant storing its OWN calibrations with no ticks must be reported on the variant: "
        f"{got}")


# --- 15. an inherited defect belongs to the template -------------------------
# A variant that inherits a field stores nothing for it, so telling its owner the
# value "was written by a path that bypassed validation" is false and points the
# repair at the wrong document. On an 8-colour line one bad template value
# otherwise yields 9 rows, 8 of them un-actionable.
def case_inherited_defect_attributed():
    tpl_id, var_id = "tplA", "varA"
    tpl = valid_res(_id=tpl_id, name="Prusament PLA", color=None, colorName=None,
                    totalWeight=None, spools=[], lowStockThreshold=None, shrinkageXY=250)
    var = valid_res(_id=var_id, name="Galaxy Black", parentId=tpl_id, shrinkageXY=None)
    vres = copy.deepcopy(var); vres["shrinkageXY"] = 250; vres["_inherited"] = ["shrinkageXY"]
    recs = {tpl_id: {"res": tpl, "raw": copy.deepcopy(tpl)},
            var_id: {"res": vres, "raw": var}}
    try:
        findings, _ = run(recs)
    except Exception as e:
        return bad("inherited-attribution", f"raised: {type(e).__name__}: {e}")
    rows = [m for rows_ in findings.values() for _, m in rows_ if "shrinkageXY" in m]
    tpl_rows = [m for m in rows if m.startswith("Prusament PLA")]
    var_rows = [m for m in rows if m.startswith("Galaxy Black")]
    if not tpl_rows:
        return bad("inherited-attribution", "the TEMPLATE that stores the bad value was not "
                                            f"reported at all: {rows}")
    if any("bypassed validation" in m for m in var_rows):
        return bad("inherited-attribution",
                   "the variant is told its own write bypassed validation, but it stores "
                   f"nothing for this field: {var_rows}")
    if var_rows and not any("INHERITED from template" in m for m in var_rows):
        return bad("inherited-attribution",
                   f"the variant row names no template to fix: {var_rows}")
    ok("inherited-attribution")


# --- 16. one defect, one row ------------------------------------------------
# For a standalone the two reads are the same document, so sweeping both emitted
# every shape finding twice and doubled the noise in the commonest case.
def case_no_duplicate_shape_rows():
    r = valid_res(type=5, spools=["oops"], settings="junk")
    findings, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in findings.values() for _, m in rows_]
    if len(rows) == 3:
        ok("no-duplicate-shape-rows")
    else:
        bad("no-duplicate-shape-rows",
            f"3 defects on a standalone produced {len(rows)} rows:\n    "
            + "\n    ".join(rows))
    # a VARIANT whose two reads genuinely differ must still report both
    raw2 = valid_res(type=5)
    res2 = valid_res(type="PLA")        # resolved is fine, stored is corrupt
    f2, _ = run({"b": {"res": res2, "raw": raw2}})
    if any("(stored)" in m for rows_ in f2.values() for _, m in rows_):
        ok("differing-reads-still-both-reported")
    else:
        bad("differing-reads-still-both-reported",
            "a corrupt STORED value with a clean resolved one was not reported -- the "
            "dedup suppressed a real finding")


if __name__ == "__main__":
    case_valid()
    case_record_containers()
    case_side_inputs()
    case_fixture_covers_reads()
    case_opt_tag_elements()
    case_nested_containers_reported()
    case_nozzle_exemption_scope()
    case_subdoc_elements_reported()
    case_unreadable_parent_not_missing()
    case_only_flag_rejects_unknown()
    case_messages_are_true()
    case_calibration_ref_tombstones()
    case_calibration_scope_refs()
    case_ref_index_hostile_shapes()
    case_date_mirror()
    case_no_cross_record_leak()
    case_preset_label_shapes()
    case_identifier_is_bounded()
    case_density_floor_exempts_foaming()
    case_promotion_carryover_exempt()
    case_malformed_is_not_missing()
    case_identity_and_dates()
    case_inh_blame_attribution()
    case_abrasive_payload()
    case_shape_dedup_keeps_distinct()
    case_instance_id_shadows()
    case_heuristics_and_negatives()
    case_unreachable_calibrations()
    case_inherited_defect_attributed()
    case_no_duplicate_shape_rows()
    n, ncrash = fuzz_shapes()
    n2, ncrash2 = fuzz_cross_record()
    n += n2; ncrash += ncrash2
    # A COMMITTED FLOOR on the combination count. The fixture-coverage guard
    # matches key NAMES at any depth rather than paths, so it cannot see a
    # fixture TRIM: deleting a nested field whose name also appears elsewhere
    # leaves it green while the fuzz quietly loses that path. The count is the
    # one number that always moves when reach is lost. Raise it deliberately
    # when the fixture grows; never lower it to make a run pass.
    if n != FUZZ_COUNT:
        bad("fuzz-reach",
            f"the fuzz explored {n} combinations, not the committed {FUZZ_COUNT}. "
            f"{'Coverage was LOST' if n < FUZZ_COUNT else 'Coverage grew'} — the name-based "
            f"guard above cannot see either, because it matches key NAMES at any depth rather "
            f"than paths. Update FUZZ_COUNT deliberately if the change is intended; a >= floor "
            f"would go stale after any growth and let a later trim slip back under it.")
    print(f"\n{passed} passed, {failed} failed   (fuzz: {n} combinations, {ncrash} distinct crash sites)")
    sys.exit(1 if failed else 0)
