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

import json
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
        # REAL ObjectId shapes: `compatibleNozzles` is an ObjectId array and the
        # orphan check compares the calibration's nozzle id against it, so "n1"
        # made the "valid" fixture invalid — caught by case_valid, again.
        "compatibleNozzles": [{"_id": "6a1a7bed677d648e9ba9cc01", "name": "0.4 Brass", "_deletedAt": None}],
        "calibrations": [{
            "_id": "6a1a7bf0677d648e9ba9cd11",
            "nozzle": {"_id": "6a1a7bed677d648e9ba9cc01", "name": "0.4 Brass"},
            "printer": {"_id": "6a1a7bee677d648e9ba9cc02", "name": "MK4S",
                        "installedNozzles": [{"_id": "6a1a7bed677d648e9ba9cc01", "name": "0.4 Brass"}]},
            "bedType": {"_id": "6a1a7bef677d648e9ba9cc03", "name": "Textured PEI"},
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
        # server-owned String paths, swept for shape like any other
        "syncId": "sync-0001", "promotedByToken": None,
        # the v1.70 promotion marker — `at` is a required Date inside it
        "promotionInFlight": {"token": "tok-1", "at": "2026-02-01T00:00:00Z"},
        "tdsUrl": "https://example.com/pla-tds.pdf",
        "spools": [{
            # embedded docs get an implicit ObjectId `_id`, so these must be
            # real 24-hex shapes (case_valid caught the old "s1"/"c1")
            "_id": "6a1a7bf0677d648e9ba9cd10", "instanceId": "0011223344",
            "label": "12", "lotNumber": "L-42",
            "totalWeight": 950, "retired": False,
            # a REAL ObjectId shape: Mongoose's cast accepts 24 hex characters
            # and nothing else, so a bare "l1" here made the "valid" fixture
            # invalid — which is precisely what case_valid now catches.
            "locationId": "6a1a7bef677d648e9ba9cd8c",
            "purchaseDate": "2026-01-01", "openedDate": None,
            "usageHistory": [{"grams": 30, "debitedGrams": 30, "source": "job",
                              "date": "2026-02-01", "jobLabel": "bracket",
                              # a declared ObjectId ref, so a real 24-hex shape
                              "jobId": "6a1a7bef677d648e9ba9cd77"}],
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
    t = valid_res(_id="6a1a7c00677d648e9ba9d001", name="Family", parentId=None, spools=[], color=None, colorName=None,
                  totalWeight=None, lowStockThreshold=None, instanceId="tttttttttt")
    k = valid_res(_id="6a1a7c00677d648e9ba9d002", name="Family — Blue", parentId="6a1a7c00677d648e9ba9d001", instanceId="kkkkkkkkkk")
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
        f2, _ = run({"6a1a7c00677d648e9ba9d001": rec(t, copy.deepcopy(t)), "6a1a7c00677d648e9ba9d002": {"res": k, "raw": kraw}},
                    topology={"6a1a7c00677d648e9ba9d001": True})
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
    "ALWAYS_STORED_ROOTS", "BOOL_FIELDS", "CALIBRATION_BOUNDS", "PIN_EXEMPT_SETTINGS", "CONTAINER_SHAPES", "DICT_ELEMENT_ARRAYS", "DRY_CYCLE_BOUNDS",
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
    "BOOL_CASTABLE", "CATEGORIES", "LOW_TEMP_TYPES", "ORCA_PLATE_KEYS", "USAGE_SOURCES", "_URL_REMOVE",
}

# See the check at the end of main(): this is the guard against a SILENT loss of
# fuzz reach, which the name-based coverage guard structurally cannot catch.
# EQUALITY, not a floor. A `>=` floor goes stale the moment the fixture grows —
# the suite passes without anyone updating it, and a later trim can then remove
# coverage while staying above the stale value, which is exactly the blind spot
# this guard exists to close. Every intentional fixture change updates this
# number.
FUZZ_COUNT = 17388

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
    var2 = valid_res(_id="v2", name="Orphan", parentId="6a1a7c00677d648e9ba9d0ff")
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
    # REAL 24-hex ids. Toy ids like "p1" are values Mongoose cannot cast at all,
    # so with the cast mirror wired in they classify as MALFORMED, not dangling
    # -- a different finding with a different fix. The fixture has to carry ids
    # the app could actually have stored, or it tests the wrong branch.
    _P_LIVE = "507f1f77bcf86cd799439011"
    _B_LIVE = "507f1f77bcf86cd799439012"
    _P_GONE = "507f1f77bcf86cd799439013"
    _B_GONE = "507f1f77bcf86cd799439014"

    def idx(cal, printers=(_P_LIVE,), bedtypes=(_B_LIVE,)):
        return {"printers": set(printers), "bedTypes": set(bedtypes),
                "cals": {"a": [cal]}}

    r = valid_res()
    base = {"res": r, "raw": copy.deepcopy(r)}

    # a stored id that resolves to no row -> reported
    for field, dead in (("printer", _P_GONE), ("bedType", _B_GONE)):
        f, _, _ = A.audit({"a": base}, (), None, None, None, idx({field: dead}))
        hit = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
        ok(f"cal-scope-dangling-{field}") if hit else bad(
            f"cal-scope-dangling-{field}",
            f"a {field} id with no surviving row produced no finding -> populate() nulls it, "
            f"so pickRepresentativeCalibration promotes that tuning to every machine")

    # a LIVE id, and a genuine generic null, must both stay silent
    for label, cal in (("live", {"printer": _P_LIVE, "bedType": _B_LIVE}),
                       ("generic-null", {"printer": None, "bedType": None}),
                       ("absent", {})):
        f, _, _ = A.audit({"a": base}, (), None, None, None, idx(cal))
        fp = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
        ok(f"cal-scope-{label}-silent") if not fp else bad(
            f"cal-scope-{label}-silent", f"a {label} calibration scope was flagged: {fp}")

    # a filament the run did not audit must not be reported on
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      {"printers": set(), "bedTypes": set(),
                       "cals": {"other": [{"printer": _P_GONE}]}})
    fp = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
    ok("cal-scope-unaudited-skipped") if not fp else bad(
        "cal-scope-unaudited-skipped", f"reported on a filament this run never audited: {fp}")

    # the CONSEQUENCE must follow pickRepresentativeCalibration's actual
    # predicate (printer == null && bedType == null), not be pasted on both ways
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      idx({"printer": _P_GONE, "bedType": None}))
    both = [m for rows in f.values() for _, m in rows if "resolves to no" in m]
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      idx({"printer": _P_GONE, "bedType": _B_LIVE}))
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
                      {"printers": None, "bedTypes": {_B_LIVE},
                       "cals": {"a": [{"printer": _P_GONE, "bedType": _B_LIVE}]}})
    fp = [m for rows in f.values() for _, m in rows if "resolves to no printer" in m]
    ok("cal-scope-absent-collection") if not fp else bad(
        "cal-scope-absent-collection",
        f"the snapshot carried no printers collection, so no printer ref can be judged; "
        f"reporting one is a false claim: {fp}")

    # an OMITTED collection must say so too — distinguishing absent from empty
    # avoids a false positive, but staying silent about it makes an UNCHECKED
    # category look like a clean one, which is the worse failure
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      {"printers": None, "bedTypes": {_B_LIVE},
                       "cals": {"a": [{"printer": _P_LIVE, "bedType": _B_LIVE}]}})
    hit = [m for rows in f.values() for _, m in rows
           if "printer references were NOT checked" in m]
    ok("cal-scope-omitted-collection-visible") if hit else bad(
        "cal-scope-omitted-collection-visible",
        "the snapshot carried no `printers` collection, so every printer scope went unchecked "
        "and the report rendered as structurally clean")

    # a MALFORMED scope ref in the snapshot: unpopulated there, so a dict or
    # array cannot be a joined document — it is an uncastable value that both
    # detail reads render as null, so nothing else can see it
    # CASING: BSON accepts either and ObjectId.toString() is always lowercase,
    # so an uppercase stored ref resolves to the SAME row. Reporting it as
    # dangling tells the user to restore a row that was never deleted.
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      idx({"printer": _P_LIVE.upper(), "bedType": _B_LIVE.upper()}))
    fp = [m for rows in f.values() for _, m in rows
          if "resolves to no" in m or "cannot cast" in m]
    ok("cal-scope-uppercase-id-resolves") if not fp else bad(
        "cal-scope-uppercase-id-resolves",
        f"an uppercase 24-hex ref casts to the same canonical id, so it is LIVE: {fp}")

    # a CASTABLE container is NOT malformed: ["<hex>"] and {"_id": "<hex>"} both
    # cast, so they get the ordinary dangling lookup on the id they resolve to
    for _ok_ref in ([_P_LIVE], {"_id": _P_LIVE}, [[_P_LIVE]]):
        f, _, _ = A.audit({"a": base}, (), None, None, None,
                          idx({"printer": _ok_ref, "bedType": _B_LIVE}))
        fp = [m for rows in f.values() for _, m in rows
              if "cannot cast" in m or "resolves to no" in m]
        if fp:
            bad("cal-scope-castable-container",
                f"Mongoose casts {_ok_ref!r} to {_P_LIVE}, which is LIVE, so calling it "
                f"malformed or dangling is a false positive: {fp}")
            break
    else:
        ok("cal-scope-castable-container")
    # ...and a non-hex string is malformed, not dangling: the cast refuses it,
    # so the fix is to repair the value, not to restore a deleted row
    f, _, _ = A.audit({"a": base}, (), None, None, None,
                      idx({"printer": "p1", "bedType": _B_LIVE}))
    _m = [m for rows in f.values() for _, m in rows if "cannot cast" in m]
    ok("cal-scope-noncastable-is-malformed") if _m else bad(
        "cal-scope-noncastable-is-malformed",
        "a non-hex printer ref cannot be cast at all, so it must read as malformed "
        "rather than as an id whose row was deleted")

    for bad_ref in ({}, [], {"_id": "x"}):
        f, _, _ = A.audit({"a": base}, (), None, None, None,
                          {"printers": {_P_LIVE}, "bedTypes": {_B_LIVE}, "locations": set(),
                           "cals": {"a": [{"printer": bad_ref, "bedType": None}]}})
        hit = [m for rows in f.values() for _, m in rows if "calibration[0] stores" in m]
        if not hit:
            bad("cal-scope-malformed", f"a {type(bad_ref).__name__} scope ref was treated as an "
                                       f"unset generic scope; it fails the ObjectId cast")
            break
    else:
        ok("cal-scope-malformed")

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
                # hour 24 is legal ONLY at exactly 24:00:00 — an all-zero
                # fraction still qualifies, a non-zero one does not
                "2026-01-05T24:00:00.0Z", "2026-01-05T24:00:00.000Z", "2026-01-05T12:00:00.5Z",
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
                "2020-01-01T24:00:00.1Z", "2020-01-01T24:00:00.001Z",
                # ISO 8601 allows a comma fraction; V8 does not, in any form
                "2020-01-01T12:00:00,5Z", "2020-01-01T12:00:00,000Z",
                "2020-01-01T24:00:00,0Z", "2020-01-01T12:00:00,123+02:00",
                # once a `T` follows the ISO date V8 commits to the SPEC parser,
                # so an unreadable time -- or a tail after it that is not `Z` or an
                # offset -- is provably invalid. (A bare "2020-01-01junk" is NOT:
                # the legacy parser takes that one. See the under-report note below.)
                "2020-01-01T", "2020-01-01T12", "2020-01-01T12:", "2020-01-01T1:00:00Z",
                "2020-01-01T:00:00Z", "2020-01-01Tnonsense", "2020-01-01TT",
                "2020-01-01T12:00:00.", "2020-01-01T12:00:00.Z", "2020-01-01T12:00:00+",
                "2020-01-01T12:00:00+2:00", "2020-01-01T12:00:00+02", "2020-01-01Tjunk12",
                "2020-01-01T12junk", "2020-01-01T12:00junk", "2020-01-01T12:00:00Zjunk",
                "2020-01-01T 12:00", "2020-01-01T12 :00",
                "2020-01-01t", "2020-01-01t12:", "2020-01-01t1:00:00Z",
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
    # PADDING. V8's SPEC parser does not trim, and its LEGACY parser refuses the
    # T shape -- so a padded T-form is Invalid while a padded legacy form is
    # fine. Measured over every trim character x every T form: 126/126.
    NBSP, IDEO, BOM, THIN = "\u00a0", "\u3000", "\ufeff", "\u2009"
    padded_t_invalid = ["2020-01-01T00:00:00Z ", " 2020-01-01T00:00:00Z",
                        "2020-01-01T00:00:00Z" + NBSP, IDEO + "2020-01-01T00:00Z",
                        "2020-01-01T00:00:00Z" + BOM, THIN + "2020-01-01t00:00:00z",
                        "2020-01-01 T00:00:00Z", "2020-01-01T 00:00:00Z"]
    miss = [v for v in padded_t_invalid if not A._bad_date(v)]
    ok("date-mirror-padded-t-invalid") if not miss else bad(
        "date-mirror-padded-t-invalid",
        f"V8 rejects a T-shaped ISO string with ANY adjacent whitespace: {miss}")
    padded_legacy_valid = ["  2026-01-05  ", " 2020-01-01 ", "2020-01-01" + NBSP,
                           IDEO + "Jan 1 2020", "2020-01-01 00:00:00 ",
                           "2020-01-01 00:00:00" + BOM]
    wrong = [v for v in padded_legacy_valid if A._bad_date(v)]
    ok("date-mirror-padded-legacy-valid") if not wrong else bad(
        "date-mirror-padded-legacy-valid",
        f"the LEGACY parser trims, so these are real dates the app stores: {wrong}")

    # NON-ASCII DIGITS. V8's grammar is ASCII-only, so an ISO-SHAPED string
    # carrying one is Invalid -- but the legacy parser swallows a junk tail, and
    # reads an arabic-indic day in a legacy date, so neither of those may be
    # condemned. Both directions measured.
    AR1, FW1, DEV1 = "\u0661", "\uff11", "\u0967"
    uni_invalid = ["2020-01-0" + AR1, "2020-01-0" + AR1 + "T00:00:00Z",
                   "202" + FW1 + "-01-01", "2020-0" + DEV1 + "-01",
                   "2020-01-01T00:00:00+" + FW1 + "0:00",
                   "2020-01-01T00:00:0" + AR1 + "Z"]
    miss = [v for v in uni_invalid if not A._bad_date(v)]
    ok("date-mirror-nonascii-digits-invalid") if not miss else bad(
        "date-mirror-nonascii-digits-invalid",
        f"V8's date grammar accepts ASCII 0-9 only, so these are Invalid: {miss}")
    uni_valid = ["2020-01-01junk" + AR1, "Jan " + AR1 + " 2020",
                 "12345junk" + FW1, "2020/01/01junk" + DEV1]
    wrong = [v for v in uni_valid if A._bad_date(v)]
    ok("date-mirror-nonascii-digits-valid") if not wrong else bad(
        "date-mirror-nonascii-digits-valid",
        f"the legacy parser swallows a junk tail and reads a non-ASCII day, so "
        f"node ACCEPTS these -- condemning one is a false positive: {wrong}")

    # POISON. "rejected wherever it appears" was measurably wrong and cost 13
    # false positives: the legacy parser tolerates all three, as a separator and
    # in a trailing junk tail. Only the spec path refuses them.
    NEL, LS, PS = "\u0085", "\u2028", "\u2029"
    poison_valid = ["2020-01-01junk" + NEL, "2020-01-01junk" + LS + "junk",
                    "Jan" + NEL + " 1 2020", "Jan 1 2020" + NEL,
                    "12345junk" + PS]
    wrong = [v for v in poison_valid if A._bad_date(v)]
    ok("date-mirror-poison-legacy-valid") if not wrong else bad(
        "date-mirror-poison-legacy-valid",
        f"V8's LEGACY parser tolerates these, so the app stores them and the "
        f"cast succeeds -- condemning one is a false positive: {wrong}")
    poison_invalid = ["2020-01-01" + NEL, "2020-01-01T00:00:00Z" + NEL,
                      "2020-01-01T" + NEL + "00:00:00Z", NEL + "2020-01-01"]
    miss = [v for v in poison_invalid if not A._bad_date(v)]
    ok("date-mirror-poison-spec-invalid") if not miss else bad(
        "date-mirror-poison-spec-invalid",
        f"on the SPEC path the poison is fatal: {miss}")

    # DOCUMENTED UNDER-REPORT, pinned so it is not "fixed" into a false positive:
    # without a `T`, V8 falls back to its legacy parser, which accepts all of
    # these. There is no safe rule that condemns "not-a-date1" while sparing
    # them, so the audit stays silent on that whole shape.
    legacy = [v for v in ("2020-01-01junk", "Jan 1 2020", "5/6/2020", "12345",
                          "Mon Jan 01 2020 junk") if A._bad_date(v)]
    ok("date-mirror-legacy-parser-silent") if not legacy else bad(
        "date-mirror-legacy-parser-silent",
        f"V8's legacy parser ACCEPTS these, so they are stored and cast fine: {legacy}")

    # MONGOOSE, not bare V8, is the mirror here: every call site's consequence
    # is "cannot be cast to a Date -> POST /api/snapshot refuses the file", and
    # castDate is STRICTER than `new Date`. A boolean is the clearest case --
    # `new Date(true)` is a real instant, but castDate asserts on the type
    # before it ever gets there. Measured against mongoose 9.7.4.
    cast_rejects = [True, False, "1700000000000000000", "8640000000000001", "1e400"]
    miss = [v for v in cast_rejects if not A._bad_date(v)]
    ok("date-mirror-mongoose-cast-rejects") if not miss else bad(
        "date-mirror-mongoose-cast-rejects",
        f"Mongoose's castDate rejects these outright, so the restore fails: {miss}")
    # ...and the numeric strings it reads as YEARS must stay silent
    years = [v for v in ("12345", "20000", "275760", " 42 ") if A._bad_date(v)]
    ok("date-mirror-numeric-string-years") if not years else bad(
        "date-mirror-numeric-string-years",
        f"castDate's milliseconds branch needs Number(v) >= 275761, so these are "
        f"read as YEARS and cast fine -- condemning one is a false positive: {years}")

    # numbers cast to an instant — but only INSIDE the ECMAScript time value
    # range. Both boundaries verified against node.
    live = [v for v in (0, 1, 12345, -1, 1.5,
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


# --- 14d-bis. a JS mirror may not use a Unicode-aware character class --------
# Python's `\d` matches every Unicode decimal digit and `\w`/`\s` are just as
# wide, while the ECMAScript grammars these regexes mirror are ASCII-only. A
# `\d` in a mirror therefore reads a digit V8 cannot, and the mirror agrees with
# a parse that never happened -- measured at 213/213 for the date grammar. This
# is a SOURCE-LEVEL guard rather than another table of examples, because the
# failure is silent and shapeless: it needs one exotic digit in one field to
# appear, and no finite example list would have caught it. Exactly one regex is
# exempt, by name, and it exists to DETECT that shape.
_UNICODE_CLASS_EXEMPT = {"_UNI_ISO_DATE_RE"}


def case_ascii_only_mirror_regexes():
    import re as _re
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "audit.py"), encoding="utf-8").read()
    offenders = []
    for m in _re.finditer(r"^(_[A-Z0-9_]+)\s*=\s*_?re\.compile\(\s*r?(\"|')(.*?)\2",
                          src, _re.M | _re.S):
        name, body = m.group(1), m.group(3)
        if name in _UNICODE_CLASS_EXEMPT:
            continue
        hits = sorted({c for c in ("\\d", "\\w", "\\s") if c in body})
        if hits:
            offenders.append(f"{name} uses {', '.join(hits)}")
    if offenders:
        bad("ascii-only-mirror-regexes",
            "a Unicode-aware class in a regex that mirrors an ASCII-only "
            "ECMAScript grammar reads digits V8 cannot: " + "; ".join(offenders))
    else:
        ok("ascii-only-mirror-regexes")
    # and the exemption must still exist, or the guard is vacuous
    if all(n not in src for n in _UNICODE_CLASS_EXEMPT):
        bad("ascii-only-mirror-exemption-live",
            "the exempt regex is gone, so this guard no longer proves anything")
    else:
        ok("ascii-only-mirror-exemption-live")



# --- 14d-ter. the Mongoose cast mirrors, pinned to a MEASURED truth table ----
# These four helpers answer "would Mongoose accept this value on this path",
# and every consequence the audit prints about a refused snapshot rests on
# them. The tables below were produced by running the repo's OWN mongoose
# (9.7.4) over each shape -- not by reading the docs, and not by reasoning
# about it. Two of them were WRONG in the shipped script and condemned data
# that casts perfectly: `{_id: "<hex>"}` (a populated ref) and `["<hex>"]`
# both cast to an ObjectId, and `{_id: "<str>"}` casts to a String.
_OID = "507f1f77bcf86cd799439011"


def case_mongoose_cast_mirrors():
    oid_accept = [None, _OID, _OID.upper(), [_OID], [[_OID]],
                  {"_id": _OID}, {"_id": _OID, "name": "PLA"},
                  {"_id": [_OID]}]
    oid_reject = ["", "abc", "abcdefghijkl", _OID[:23], _OID + "a", 0, 1, True,
                  [], ["not-hex"], [_OID, _OID], {}, {"_id": "abc"},
                  {"_id": None}, {"_id": ""}, {"_id": 0}, {"_id": 1}, {"a": 1},
                  [{"_id": _OID}], {"_id": {"_id": _OID}}]
    wrong = [v for v in oid_accept if not A._castable_objectid(v)]
    ok("cast-objectid-accepts") if not wrong else bad(
        "cast-objectid-accepts",
        f"Mongoose's ObjectId cast ACCEPTS these (a populated ref and a "
        f"single-element array included), so condemning one is a false "
        f"positive: {wrong}")
    wrong = [v for v in oid_reject if A._castable_objectid(v)]
    ok("cast-objectid-rejects") if not wrong else bad(
        "cast-objectid-rejects",
        f"Mongoose's ObjectId cast REJECTS these, so the restore really does "
        f"fail and the audit must say so: {wrong}")

    str_accept = [None, "", "x", 0, 1.5, True, {"_id": "L-42"}]
    str_reject = [[], ["L-42"], [1, 2], {}, {"a": 1}, {"_id": None}, {"_id": 1}]
    wrong = [v for v in str_accept if not A._castable_string(v)]
    ok("cast-string-accepts") if not wrong else bad(
        "cast-string-accepts",
        f"castString reads `value._id` BEFORE rejecting objects, so these cast "
        f"cleanly: {wrong}")
    wrong = [v for v in str_reject if A._castable_string(v)]
    ok("cast-string-rejects") if not wrong else bad(
        "cast-string-rejects", f"castString REJECTS these: {wrong}")

    # ToNumber, because getRemainingPct coerces rather than giving up
    for _v, _want in (("", 0.0), ("210", 210.0), (True, 1.0), (False, 0.0),
                      ([], 0.0), (["5"], 5.0), (None, 0.0), (7, 7.0)):
        if A._js_to_number(_v) != _want:
            bad("cast-tonumber", f"ToNumber({_v!r}) should be {_want}, got "
                                 f"{A._js_to_number(_v)!r}")
            break
    else:
        ok("cast-tonumber")
    _nan = [v for v in ([1, 2], {}, "abc", "1_0", "NaN") if A._js_to_number(v) is not None]
    ok("cast-tonumber-nan") if not _nan else bad(
        "cast-tonumber-nan", f"Number() gives NaN for these: {_nan}")
    # ...and Number() is not float(): these four are exactly where they differ
    for _v, _want in (("0x10", 16.0), ("Infinity", float("inf")), (" 42 ", 42.0)):
        if A._js_string_to_number(_v) != _want:
            bad("cast-tonumber-vs-float",
                f"Number({_v!r}) is {_want}, not float()'s answer")
            break
    else:
        ok("cast-tonumber-vs-float")


# --- 14d-quater. a case-insensitive mirror may not use FULL case folding -----
# `str.casefold()` is full Unicode folding (multi-character: ss<->ß, ff<->ﬀ,
# st<->ﬅ). Every case-insensitive gate it mirrors is strictly narrower -- JS
# `toLowerCase` is 1:1, and MongoDB's `$options:"i"` is PCRE2 SIMPLE folding.
# So casefold manufactures "differ only by CASE" collisions between ids the app
# treats as unrelated, and tells the user a working printed label is broken.
# Python's `.lower()` and JS `toLowerCase()` were compared over every one of the
# 1,460 case-changing code points and agree on ALL of them, so `.lower()` is the
# exact mirror. This is a SOURCE guard for the same reason the regex one is: the
# failure needs one exotic character in one id to appear.
def case_no_full_case_folding():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "audit.py"), encoding="utf-8").read()
    hits = [ln for ln in src.splitlines() if ".casefold()" in ln]
    if hits:
        bad("no-full-case-folding",
            "casefold() is FULL Unicode folding; every gate it mirrors (JS "
            "toLowerCase, Mongo $options:'i') is simple folding, so it invents "
            "collisions. Use .lower(): " + " | ".join(h.strip()[:70] for h in hits))
    else:
        ok("no-full-case-folding")
    pairs = [("WEISS", "WEI\u00df"), ("ss42", "\u00df42"), ("stra\u00dfe", "strasse"),
             ("\u03c3", "\u03c2"), ("AFFE", "A\ufb00e"), ("ROLL-FI", "ROLL-\ufb01")]
    collide = [(a, b) for a, b in pairs if a.lower() == b.lower()]
    ok("no-full-case-folding-pairs") if not collide else bad(
        "no-full-case-folding-pairs",
        f"these are NOT case variants of each other to JS or to Mongo, so "
        f"grouping them produces a false 'differ only by CASE' row: {collide}")



# --- 14d-quinquies. a cast decision must go through the ONE mirror ----------
# The two cast mirrors were introduced and then wired into only the call sites
# a sweep had named, which left SEVEN others still asking `isinstance(x, str)
# and OBJECTID_RE.match(x)` or `isinstance(x, (dict, list))` and reaching the
# opposite verdict on the same value. That is not a semantics bug -- it is a
# WIRING bug, and it is the reliably recurring one: every partial rewiring
# produces another round of "you missed these". So it gets a guard rather than
# another list of sites.
#
#   * OBJECTID_RE.match may appear ONLY inside `_objectid_str`
#   * `isinstance(x, (dict, list))` may not appear in code at all -- a CAST
#     decision belongs in the mirror, and a structural test should name the one
#     type it means
def case_cast_decisions_go_through_the_mirror():
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "audit.py"), encoding="utf-8").read()
    lines = src.splitlines()

    start = next((i for i, ln in enumerate(lines)
                  if ln.startswith("def _objectid_str(")), None)
    if start is None:
        bad("cast-mirror-resolver-exists",
            "_objectid_str is gone, so this guard proves nothing")
        return
    ok("cast-mirror-resolver-exists")
    end = next((i for i in range(start + 1, len(lines))
                if lines[i] and not lines[i][0].isspace()), len(lines))

    stray = [(i + 1, ln.strip()) for i, ln in enumerate(lines)
             if "OBJECTID_RE.match" in ln and not (start <= i < end)
             and not ln.lstrip().startswith("#")]
    if stray:
        bad("cast-objectid-single-site",
            "an ObjectId cast decision outside _objectid_str will disagree with "
            "the mirror on a populated ref or a single-element array: "
            + "; ".join(f"L{n} {t[:60]}" for n, t in stray))
    else:
        ok("cast-objectid-single-site")

    container = [(i + 1, ln.strip()) for i, ln in enumerate(lines)
                 if "(dict, list)" in ln.replace(" ", "").replace(
                     "(dict,list)", "(dict, list)")
                 and "isinstance" in ln and not ln.lstrip().startswith("#")]
    if container:
        bad("cast-string-no-container-test",
            "judging a String cast by container type calls a populated ref "
            "unrestorable and lets an array through; use _castable_string: "
            + "; ".join(f"L{n} {t[:60]}" for n, t in container))
    else:
        ok("cast-string-no-container-test")

    # and the resolver must agree with the castability predicate, always
    _OID2 = "507f1f77bcf86cd799439011"
    for _v in (None, _OID2, [_OID2], [[_OID2]], {"_id": _OID2}, "", "abc", [],
               [_OID2, _OID2], {}, {"_id": None}, 0, True, ["not-hex"]):
        if A._castable_objectid(_v) != (_v is None or A._objectid_str(_v) is not None):
            bad("cast-resolver-agrees",
                f"_castable_objectid and _objectid_str disagree on {_v!r}")
            break
    else:
        ok("cast-resolver-agrees")



# --- 14d-sexies. the mirrors, DIFFERENTIAL-TESTED against real Mongoose -----
# Everything above pins the mirrors against tables a human wrote down, and a
# table only covers the cases whoever wrote it thought of. That is exactly how
# this file accumulated its false positives: `{_id: "<hex>"}` casts, an
# uppercase ObjectId canonicalizes, `token: 42` casts, `""` is a valid Number
# -- each one obvious in hindsight and absent from every hand-written list.
#
# So the mirrors are now tested against the REFERENCE IMPLEMENTATION: the
# repo's own mongoose, driven by references/cast_oracle.mjs over a GENERATED
# corpus. The audit itself keeps its Python mirror -- it has to run standalone
# against a deployment with no repo and no node_modules -- but a divergence
# between the mirror and the real thing is now a build failure rather than
# something a reviewer has to happen to notice.
#
# Skips loudly (never silently) when node or mongoose is unavailable.
_ORACLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cast_oracle.mjs")
_OID_H = "507f1f77bcf86cd799439011"


def _cast_corpus():
    """Shapes crossed with types, generated rather than enumerated by hand."""
    scalars = [None, "", " ", "x", "abc", _OID_H, _OID_H.upper(), _OID_H[:23],
               _OID_H + "a", "abcdefghijkl", "0", "1", "12345", "20000",
               "1e5", "1_0", "0x10", "Infinity", "NaN", " 42 ", "true",
               "false", "yes", "no", "2020-01-01", "2020-01-01T00:00:00Z",
               "2020-01-01T00:00:00Z ", "2020-13-01", "1700000000000000000",
               0, 1, -1, 1.5, True, False]
    containers = []
    for inner in (_OID_H, _OID_H.upper(), "abc", "", None, 1, True):
        containers += [[inner], [[inner]], [inner, inner], {"_id": inner},
                       {"_id": inner, "name": "x"}, {"a": inner}]
    containers += [[], {}]
    return scalars + containers


def _ask_oracle(items):
    import subprocess
    try:
        r = subprocess.run(["node", _ORACLE], input=json.dumps(items),
                           capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        payload = json.loads(r.stdout)
    except ValueError:
        return None
    if not isinstance(payload.get("verdicts"), list):
        return None
    return payload


def case_cast_mirrors_match_real_mongoose():
    if not os.path.exists(_ORACLE):
        bad("cast-oracle-present", "references/cast_oracle.mjs is missing, so the "
                                   "mirrors are no longer differential-tested")
        return
    corpus = _cast_corpus()
    # (schema type, python predicate, values to skip and why)
    checks = [
        ("ObjectId", lambda v: A._castable_objectid(v), ()),
        ("String", lambda v: A._castable_string(v), ()),
        # `""` and None never reach _bad_date -- every call site guards
        # `not in (None, "")` because castDate maps both to null.
        ("Date", lambda v: not A._bad_date(v), (None, "")),
        ("Boolean", lambda v: A._bool_castable(v), (None,)),
        # Number was ABSENT from this list while the oracle already implemented
        # it, so the generated corpus was never evaluated as a Number and a
        # divergence there could pass -- the exact truth-table gap this case
        # exists to close, reproduced inside the closing mechanism.
        ("Number", lambda v: A._castable_number(v), ()),
    ]
    items, meta = [], []
    for tname, _pred, skip in checks:
        for v in corpus:
            if any(v is s or (type(v) is type(s) and v == s) for s in skip):
                continue
            items.append({"type": tname, "value": v})
            meta.append((tname, v, _pred))
    payload = _ask_oracle(items)
    if payload is not None and len(payload["verdicts"]) != len(items):
        # `zip()` stops at the shorter side, so a truncated or empty array would
        # mark the oracle reachable and let BOTH assertions pass having checked
        # nothing. A guard that quietly stops guarding is worse than no guard.
        bad("cast-oracle-complete",
            f"the oracle returned {len(payload['verdicts'])} verdicts for "
            f"{len(items)} shapes, so the differential check would silently skip "
            f"the remainder; refusing to report a partial run as a pass")
        return
    if payload is None:
        # NOT a silent pass: an unchecked mirror must look unchecked.
        bad("cast-oracle-reachable",
            "could not run cast_oracle.mjs (node or mongoose unavailable), so "
            "the cast mirrors went UNVERIFIED against the real implementation; "
            "run `npm ci` in the repo root, or run the suite from a checkout")
        return
    ok("cast-oracle-reachable")
    ok(f"cast-oracle-complete ({len(items)} shapes answered)")
    # The two directions are NOT equally bad and must not be reported together.
    # A false positive tells the user to break working data; an under-report
    # merely stays quiet. So every false positive is fatal, while an
    # under-report is fatal only when it is a NEW one -- the single documented
    # gap is pinned by RULE below, so the silent surface cannot grow unnoticed
    # and a future narrowing of it shows up as a prompt to update this.
    def _known_legacy_gap(tname, v):
        """V8's legacy parser accepts "2020-01-01junk", "Jan 1 2020", "5/6/2020"
        and "12345", so no safe rule condemns a digit-bearing NON-ISO string --
        see `date-mirror-legacy-parser-silent`. Arrays coerce to a string and
        land in the same gap."""
        if tname != "Date":
            return False
        text = (v if isinstance(v, str)
                else A._js_array_string(v) if isinstance(v, list) else None)
        if text is None:
            return False
        t = A._js_trim(text)
        return (bool(t) and any(c.isascii() and c.isdigit() for c in t)
                and not A._ISO_DATE_RE.match(t))

    false_pos, under, expected = [], [], 0
    for (tname, v, pred), verdict in zip(meta, payload["verdicts"]):
        got, want = bool(pred(v)), bool(verdict.get("ok"))
        if got == want:
            continue
        if not got and want:
            false_pos.append(f"{tname}({v!r}): the mirror REJECTS it but mongoose "
                             f"{payload['mongoose']} casts it to "
                             f"{verdict.get('cast')!r}")
        elif _known_legacy_gap(tname, v):
            expected += 1
        else:
            under.append(f"{tname}({v!r}): mongoose rejects it "
                         f"({str(verdict.get('error'))[:60]}) and the mirror is silent")
    if false_pos:
        bad("cast-mirrors-no-false-positives",
            f"{len(false_pos)} of {len(meta)} shapes are condemned by the mirror and "
            f"accepted by the real cast -- each one tells the user to 'fix' data "
            f"the app stores happily:\n      " + "\n      ".join(false_pos[:10]))
    else:
        ok(f"cast-mirrors-no-false-positives ({len(meta)} shapes vs mongoose "
           f"{payload['mongoose']})")
    if under:
        bad("cast-mirrors-no-new-under-reports",
            f"{len(under)} shape(s) the real cast rejects are NOT covered by the one "
            f"documented gap (a digit-bearing non-ISO date string), so the audit "
            f"silently passes data that breaks a restore:\n      "
            + "\n      ".join(under[:10]))
    else:
        ok(f"cast-mirrors-no-new-under-reports ({expected} in the documented "
           f"legacy-parser gap)")


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
        par = valid_res(_id="6a1a7c00677d648e9ba9d003", name="PLA Family", instanceId=top, spools=[], color=None,
                        colorName=None, totalWeight=None, lowStockThreshold=None)
        var = valid_res(_id="6a1a7c00677d648e9ba9d007", name="PLA Family — Original", parentId="6a1a7c00677d648e9ba9d003",
                        instanceId="ffffffffff")
        var["spools"] = [dict(var["spools"][0], instanceId=carry)]
        f, _ = run({"6a1a7c00677d648e9ba9d003": rec(par, copy.deepcopy(par)), "6a1a7c00677d648e9ba9d007": rec(var, copy.deepcopy(var))},
                   topology={"6a1a7c00677d648e9ba9d003": True})
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
    # The two LENGTH ceilings are consumer bounds and apply to both ids; the
    # CHARSET rule is validateSpoolInstanceId, which governs spools[].instanceId
    # ONLY. The top-level id is server-owned with no validator, and match's
    # boundedParam trims only the ends — so an internal space there round-trips
    # and reporting it was a false positive (this assertion used to demand it).
    for holder in ("spool", "filament"):
        checks = [(("a" * 17), "16-character OpenPrintTag"),
                  (("a" * 129), "128-character bound"),
                  # trimmed for the CHECK but stored with the spaces: every scan
                  # path trims before querying while the writers encode it as
                  # stored, so no tier can match
                  ("  abc  ", "surrounding whitespace")]
        if holder == "spool":
            checks.append(("has space!", "allowed charset"))
        for val, needle in checks:
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
        # both ceilings are JS lengths, so they count UTF-16 CODE UNITS —
        # ten emoji are len() 10 in Python and .length 20 in the encoder
        ra = valid_res()
        astral = "\U0001F600" * 10
        if holder == "spool":
            ra["spools"][0]["instanceId"] = astral
        else:
            ra["instanceId"] = astral
            ra["spools"] = []
        f, _ = run({"a": rec(ra, copy.deepcopy(ra))})
        # For a SPOOL id an emoji breaks the charset rule first, and that row is
        # the right one (its remedy — replace the id — fixes both). The UTF-16
        # measurement is what the FILAMENT-level id depends on, since it has no
        # charset rule to catch it.
        needle = "UTF-16 units" if holder == "filament" else "allowed charset"
        hit = [m for rows in f.values() for _, m in rows if needle in m]
        ok(f"idcontract-{holder}-astral") if hit else bad(
            f"idcontract-{holder}-astral",
            f"the OpenPrintTag field and boundedParam both measure JS length, so an astral "
            f"character costs two — Python len() undercounts and lets an over-long id through "
            f"(expected {needle!r})")

        # ...and the charset rule must NOT reach the filament-level id
        if holder == "filament":
            rf = valid_res(instanceId="abc def")
            rf["spools"] = []
            f, _ = run({"a": rec(rf, copy.deepcopy(rf))})
            fp = [m for rows in f.values() for _, m in rows if "allowed charset" in m]
            ok("idcontract-filament-charset-exempt") if not fp else bad(
                "idcontract-filament-charset-exempt",
                f"validateSpoolInstanceId governs spools[].instanceId only; the top-level id has "
                f"no charset constraint and match preserves internal whitespace: {fp}")

        # ...and a normal id stays silent on BOTH
        rr = valid_res()
        if holder == "filament":
            rr["spools"] = []
        f, _ = run({"a": rec(rr, copy.deepcopy(rr))})
        fp = [m for rows in f.values() for _, m in rows
              if "instanceId" in m and "characters" in m]
        ok(f"idcontract-{holder}-normal-silent") if not fp else bad(
            f"idcontract-{holder}-normal-silent", f"a normal 10-hex id was flagged: {fp}")

    # a declared ObjectId ref inside the usage ledger
    rj = valid_res()
    rj["spools"][0]["usageHistory"][0]["jobId"] = "not-an-object-id"
    f, _ = run({"a": rec(rj, copy.deepcopy(rj))})
    hit = [m for rows in f.values() for _, m in rows if "jobId" in m]
    ok("usage-jobid-castable") if hit else bad(
        "usage-jobid-castable",
        "`usageHistory[].jobId` is an ObjectId ref; an uncastable value fails the restore and the "
        "print-job DELETE matches refunds on it")

    # a non-string top-level instanceId must produce ONE diagnosis, not two —
    # the text sweep coerces it to "" in place, and an unguarded absence test
    # then contradicts the row that was just emitted
    ri = valid_res(instanceId={"$oid": "x"})
    ri["spools"] = []
    f, _ = run({"a": rec(ri, copy.deepcopy(ri))})
    both = [m for rows in f.values() for _, m in rows if "no filament-level instanceId" in m]
    ok("instanceid-one-diagnosis") if not both else bad(
        "instanceid-one-diagnosis",
        f"a MALFORMED id was also reported as ABSENT — two contradictory rows for one value: "
        f"{both}")

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
        t = valid_res(_id="6a1a7c00677d648e9ba9d001", name="Prusament PLA", parentId=None, spools=[], color=None,
                      colorName=None, totalWeight=None, lowStockThreshold=None)
        k = valid_res(_id="6a1a7c00677d648e9ba9d002", name="Prusament PLA — Blue", parentId="6a1a7c00677d648e9ba9d001", **res_over)
        k["_inherited"] = inherited
        kraw = copy.deepcopy(k)
        for f2 in inherited:
            kraw.pop(f2, None)
        if raw_over:
            kraw.update(raw_over)
        return {"6a1a7c00677d648e9ba9d001": rec(t, copy.deepcopy(t)), "6a1a7c00677d648e9ba9d002": {"res": k, "raw": kraw}}

    def rows_for(recs, needle):
        f, _ = run(recs, topology={"6a1a7c00677d648e9ba9d001": True})
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

    # (f) two spool ids differing only by CASE — matchFilament's spool tier is
    #     exact-then-folded, so both scans land in the same folded tier
    f, _ = two({"instanceId": "aaaaaaaaa1", "spools": spools("abcdefabcd")},
               {"instanceId": "aaaaaaaaa2", "spools": spools("ABCDEFABCD")})
    rows = [m for rows_ in f.values() for _, m in rows_ if "differ only by CASE" in m]
    ok("shadow-spool-case-twins") if rows else bad(
        "shadow-spool-case-twins",
        "two spools whose ids differ only by case collide in the case-insensitive spool tier "
        "exactly as an exact duplicate does, and an exact-key map sees neither")
    # ...and within ONE filament
    f, _ = two({"instanceId": "aaaaaaaaa1", "spools": spools("abcdefabcd", "ABCDEFABCD")},
               {"instanceId": "aaaaaaaaa2"})
    rows = [m for rows_ in f.values() for _, m in rows_ if "differ only by CASE" in m]
    ok("shadow-spool-case-twins-same") if rows else bad(
        "shadow-spool-case-twins-same",
        "within one filament the folded tier reports whichever roll comes first by array order")
    # NEGATIVE: distinct ids must stay silent
    f, _ = two({"instanceId": "aaaaaaaaa1", "spools": spools("abcdefabcd", "0011223399")},
               {"instanceId": "aaaaaaaaa2"})
    fp = [m for rows_ in f.values() for _, m in rows_ if "differ only by CASE" in m]
    ok("shadow-spool-case-negative") if not fp else bad(
        "shadow-spool-case-negative", f"genuinely distinct ids were flagged: {fp}")

    # (g) two FILAMENT-level ids differing only by case — the folded filament
    #     fallback returns both as candidates and matches nothing
    f, _ = two({"instanceId": "abcdefabcd"}, {"instanceId": "ABCDEFABCD"})
    rows = [m for rows_ in f.values() for _, m in rows_
            if "filament-level instanceIds" in m and "differ only by CASE" in m]
    ok("shadow-filament-case-twins") if rows else bad(
        "shadow-filament-case-twins",
        "matchFilament's filament fallback is exact-then-folded, so two case-only twins resolve "
        "NO match at all — top_ci existed but was only consulted for spool shadows")
    f, _ = two({"instanceId": "abcdefabcd"}, {"instanceId": "0011223399"})
    fp = [m for rows_ in f.values() for _, m in rows_ if "filament-level instanceIds" in m]
    ok("shadow-filament-case-negative") if not fp else bad(
        "shadow-filament-case-negative", f"genuinely distinct ids were flagged: {fp}")

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
    """isCalibrationRowReachable's inputs are BOTH stored: the edit form fetches
    `?raw=true` and seeds its grid and its tick list from that response. So the
    orphan predicate is a stored-document question, and it is PER ROW — an empty
    tick list is only the degenerate case where every row fails it."""
    nz = valid_res()["compatibleNozzles"]
    cal = valid_res()["calibrations"]
    other = [{"_id": "n9", "name": "0.6 Hardened", "_deletedAt": None}]

    def fam(t_over, k_res, k_raw, inh):
        t = valid_res(_id="6a1a7c00677d648e9ba9d001", name="Family", parentId=None, spools=[], color=None,
                      colorName=None, totalWeight=None, lowStockThreshold=None, **t_over)
        k = valid_res(_id="6a1a7c00677d648e9ba9d002", name="Family — Blue", parentId="6a1a7c00677d648e9ba9d001", **k_res)
        k["_inherited"] = inh
        kraw = copy.deepcopy(k)
        kraw.update(k_raw)
        f, _ = run({"6a1a7c00677d648e9ba9d001": rec(t, copy.deepcopy(t)), "6a1a7c00677d648e9ba9d002": {"res": k, "raw": kraw}},
                   topology={"6a1a7c00677d648e9ba9d001": True})
        return [m for rows in f.values() for _, m in rows
                if "no compatibleNozzles" in m or "does not tick" in m]

    # a variant that INHERITS ticks but stores its OWN calibrations: the form
    # never sees the inherited ticks, so every stored row is orphaned
    got = fam({"compatibleNozzles": nz, "calibrations": []},
              {"compatibleNozzles": nz, "calibrations": copy.deepcopy(cal)},
              {"compatibleNozzles": [], "calibrations": copy.deepcopy(cal)},
              ["compatibleNozzles"])
    ok("orphan-variant-owns-cals") if any(m.startswith("Family — Blue") for m in got) else bad(
        "orphan-variant-owns-cals",
        f"the edit form reads ?raw=true, so inherited ticks do NOT satisfy the gate: {got}")

    # a calibration on a nozzle that is simply not ticked — the non-degenerate
    # half of the predicate, which bambuStudioApply's global fallback produces
    got = fam({"compatibleNozzles": other, "calibrations": copy.deepcopy(cal)},
              {"compatibleNozzles": other, "calibrations": []},
              {"calibrations": []}, ["compatibleNozzles", "calibrations"])
    if any("does not tick" in m and "0.4 Brass" in m for m in got):
        ok("orphan-untickled-nozzle")
    else:
        bad("orphan-untickled-nozzle",
            f"a calibration whose nozzle is not in the tick list is orphaned even when the list "
            f"is non-empty, and the row must name that nozzle: {got}")

    # template owns them, variant inherits both -> ONE row, on the template
    got = fam({"compatibleNozzles": [], "calibrations": copy.deepcopy(cal)},
              {"compatibleNozzles": [], "calibrations": copy.deepcopy(cal)},
              {"compatibleNozzles": [], "calibrations": []}, ["calibrations"])
    if len(got) == 1 and got[0].startswith("Family:"):
        ok("orphan-template-once")
    else:
        bad("orphan-template-once",
            f"expected exactly one row, on the template that stores them; got {got}")

    # healthy: the ticks cover the calibration
    got = fam({"compatibleNozzles": nz, "calibrations": copy.deepcopy(cal)},
              {"compatibleNozzles": nz, "calibrations": []},
              {"calibrations": [], "compatibleNozzles": []},
              ["compatibleNozzles", "calibrations"])
    ok("orphan-healthy-silent") if not got else bad(
        "orphan-healthy-silent", f"a ticked calibration must stay silent: {got}")


# --- 14r. JS truthiness, and the direction of the carry-over -----------------
def case_js_truthiness_and_direction():
    # `if (spool.retired) continue` — `{}` and `[]` are TRUTHY in JS and falsy
    # in Python, so a Python truth test counted an excluded spool as live and
    # emitted inventory rows for stock the app does not count.
    for v in ({}, [], True):
        r = valid_res(netFilamentWeight=None, spoolWeight=None)
        r["spools"] = [dict(r["spools"][0], retired=v)]
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in f.values() for _, m in rows_ if "no % bar" in m]
        if rows:
            bad("js-truthy-retired",
                f"retired={v!r} is TRUTHY in JS, so the app excludes this spool from every "
                f"inventory helper; the audit must not report on it: {rows}")
            break
    else:
        for v in (False, 0, ""):
            r = valid_res(netFilamentWeight=None, spoolWeight=None)
            r["spools"] = [dict(r["spools"][0], retired=v)]
            f, _ = run({"a": rec(r, copy.deepcopy(r))})
            if not [m for rows_ in f.values() for _, m in rows_ if "no % bar" in m]:
                bad("js-truthy-retired",
                    f"retired={v!r} is FALSY in JS, so the spool is live and its missing "
                    f"inventory inputs must still be reported")
                break
        else:
            ok("js-truthy-retired")

    # Only ONE direction is the #732 carry-over: a CHILD-owned spool matching
    # its PARENT's top-level id. The reverse is a genuine shadow, and promoting
    # would not give the existing variant its identity back.
    def pair(t_over, k_over):
        t = valid_res(_id="6a1a7c00677d648e9ba9d001", name="Tmpl", color=None, colorName=None, totalWeight=None,
                      lowStockThreshold=None, **t_over)
        k = valid_res(_id="6a1a7c00677d648e9ba9d002", name="Tmpl — Blue", parentId="6a1a7c00677d648e9ba9d001", **k_over)
        f, _ = run({"6a1a7c00677d648e9ba9d001": rec(t, copy.deepcopy(t)), "6a1a7c00677d648e9ba9d002": rec(k, copy.deepcopy(k))},
                   topology={"6a1a7c00677d648e9ba9d001": True})
        return [m for rows_ in f.values() for _, m in rows_ if "carry" in m or "FILAMENT-level" in m]

    base_sp = valid_res()["spools"][0]
    legit = pair({"instanceId": "carryover1", "spools": []},
                 {"instanceId": "ffffffffff",
                  "spools": [dict(base_sp, instanceId="carryover1")]})
    ok("carryover-child-owned-silent") if not legit else bad(
        "carryover-child-owned-silent",
        f"a child-owned spool matching its parent's top-level id is what promoteParent "
        f"produces: {legit}")

    shadow = pair({"instanceId": "tttttttttt",
                   "spools": [dict(base_sp, instanceId="variantid1")]},
                  {"instanceId": "variantid1", "spools": []})
    ok("carryover-reverse-reported") if shadow else bad(
        "carryover-reverse-reported",
        "a TEMPLATE-owned spool matching a VARIANT's top-level id is a real shadow — "
        "matchFilament finds the template's spool first, so scanning the variant's own id "
        "resolves to the template, and promoting would not fix it")


# --- 14s. String.trim() is not str.strip() -----------------------------------
# ECMAScript's TrimString removes WhiteSpace + LineTerminator. Python's strip()
# ALSO removes U+0085 and U+001C..U+001F, which JS keeps, and does NOT remove
# U+FEFF, which JS trims. Both scan routes call .trim(), so using Python's set
# reported an id ending in U+0085 as unmatchable when the exact match succeeds.
def case_js_trim_mirror():
    NEL, FS, ZWNBSP, NBSP = chr(0x85), chr(0x1C), chr(0xFEFF), chr(0xA0)
    # JS KEEPS these, so an id carrying them is matchable and must stay silent
    for tail in (NEL, FS, chr(0x1F)):
        r = valid_res(instanceId="abcdef" + tail)
        r["spools"] = []
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        fp = [m for rows in f.values() for _, m in rows if "surrounding whitespace" in m]
        if fp:
            bad("js-trim-keeps",
                f"JS String.trim() does NOT remove U+{ord(tail):04X}, so the writer and both scan "
                f"routes keep it and the exact match succeeds: {fp}")
            break
    else:
        ok("js-trim-keeps")
    # JS DOES trim these, so an id carrying them really is unmatchable
    for tail in (" ", NBSP, ZWNBSP, chr(0x2003)):
        r = valid_res(instanceId="abcdef" + tail)
        r["spools"] = []
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        hit = [m for rows in f.values() for _, m in rows if "surrounding whitespace" in m]
        if not hit:
            bad("js-trim-removes",
                f"JS String.trim() DOES remove U+{ord(tail):04X}, so the scan routes strip it "
                f"while the writers encode it as stored — no tier can match")
            break
    else:
        ok("js-trim-removes")


# --- 14t. every String path the SCHEMA declares must be swept ----------------
# `spoolType`, then `syncId` — each arrived as its own review round, which is a
# drip with no end: the schema decides how many there are, so derive the list
# from the schema and fail when one is uncovered. This is the string half of
# what the numeric-coverage script in SKILL.md does for Number paths.
#
# Exemptions must state WHY, because "it has its own check" and "we forgot" look
# identical from here.
# Same treatment for `type: Date`, and for the same reason: `createdAt`,
# `usageHistory[].date`, `dryCycles[].date`, then `promotionInFlight.at` each
# arrived as its own round. An uncastable Date fails the restore exactly like an
# uncastable String, so the schema — not the review — decides the inventory.
# ObjectId and Boolean complete the set. Between these and the Number script in
# SKILL.md, EVERY declared type on the schema is now inventoried from the schema
# rather than from whatever the last review happened to notice — which is the
# whole point: a per-field patch guarantees the next per-field finding.
OBJECTID_SWEEP_EXEMPT = {
    # populated in BOTH detail reads, so their stored shape is unreachable from
    # the two documents in hand; checked instead by the calibration-scope pass
    # against the UNPOPULATED /api/snapshot (printer, bedType) and by the
    # dangling-nozzle rows (nozzle).
    "printer", "nozzle", "bedType",
}
BOOL_SWEEP_EXEMPT = set()

DATE_SWEEP_EXEMPT = {
    # A row carrying a non-null `_deletedAt` is outside the audited set BY
    # CONSTRUCTION: the listing filters `_deletedAt: null`, and the snapshot
    # fallback filters it too, so such a row is never fetched and the audit
    # cannot see the bad value in the first place.
    "_deletedAt",
}

TEXT_SWEEP_EXEMPT = {
    # richer check of its own (_bad_tds_url + a non-string branch); adding it to
    # TEXT_FIELDS would coerce the value to "" before that check ran
    "tdsUrl",
}


def _schema_paths_of_type(ts_type):
    """Every `type: <ts_type>` path in FilamentSchema, at any depth, as dotted
    names. Derived from the schema so the inventory cannot go stale."""
    import re as _re
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "..", "..", "..", "src", "models", "Filament.ts")
    if not os.path.exists(path):
        return None
    lines = open(path).read().splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if "FilamentSchema = new Schema" in l)
        end = next(i for i in range(start, len(lines)) if "timestamps: true" in lines[i])
    except StopIteration:
        return None
    stack, out = [], []
    for l in lines[start:end]:
        ind = len(l) - len(l.lstrip())
        m = _re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*):", l)
        if not m:
            continue
        while stack and stack[-1][1] >= ind:
            stack.pop()
        if _re.search(r"type:\s*%s\b" % ts_type, l):
            out.append(".".join([k for k, _ in stack] + [m.group(1)]))
        elif _re.search(r"[\[{]\s*$", l):
            stack.append((m.group(1), ind))
    return out


def case_schema_date_paths_covered():
    """Every declared Date path must be reachable by the castability sweep."""
    declared = _schema_paths_of_type("Date")
    if declared is None:
        return ok("schema-date-paths (schema not locatable — skipped)")
    import re as _re2
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "audit.py")).read()
    missing = []
    for p in declared:
        leaf = p.split(".")[-1]
        if leaf in DATE_SWEEP_EXEMPT or p in DATE_SWEEP_EXEMPT:
            continue
        # the sweep reaches a path either by naming the leaf in a date loop or
        # by reading it explicitly
        if not _re2.search(r'"%s"' % _re2.escape(leaf), src):
            missing.append(p)
    if missing:
        bad("schema-date-paths",
            "the Filament schema declares these Date paths that the castability sweep never "
            "names: " + ", ".join(missing) + ".\n  An uncastable value there makes POST "
            "/api/snapshot refuse the ENTIRE backup file. Add it to a date loop, or to "
            "DATE_SWEEP_EXEMPT with the reason.")
    else:
        ok("schema-date-paths (%d declared, %d exempt)" % (len(declared), len(DATE_SWEEP_EXEMPT)))


def _covered_by_source(paths, exempt, label, why):
    """Shared shape for the derived per-type guards: every declared path must be
    NAMED somewhere in audit.py, or exempt with a stated reason."""
    import re as _r
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "audit.py")).read()
    missing = [p for p in paths
               if p.split(".")[-1] not in exempt and p not in exempt
               and not _r.search(r'"%s"' % _r.escape(p.split(".")[-1]), src)]
    if missing:
        bad(label, "the Filament schema declares these %s paths the audit never names: %s.\n  %s"
                   % (label.split("-")[1], ", ".join(missing), why))
    else:
        ok("%s (%d declared, %d exempt)" % (label, len(paths), len(exempt)))


# An explicit registry, NOT a source scan. The first version of these guards
# asked "is this leaf named anywhere in audit.py", which is far too loose:
# `_purged` is named by the discovery filter, so emptying BOOL_FIELDS entirely
# left the guard green. A registry has to be updated deliberately, which is the
# behaviour the FUZZ_COUNT guard already earns its keep with.
OBJECTID_CHECKED = {
    "parentId": "shape-checked before the parent-link block",
    "compatibleNozzles": "per-element check in the nozzle-assignment block",
    "spools.locationId": "three-tier check (shape / castable / resolves)",
    "spools.usageHistory.jobId": "shape-checked in the usage loop",
}


def case_schema_objectid_paths_covered():
    paths = _schema_paths_of_type(r"Schema\.Types\.ObjectId")
    if paths is None:
        return ok("schema-objectid-paths (schema not locatable — skipped)")
    missing = [p for p in paths
               if p not in OBJECTID_CHECKED and p.split(".")[-1] not in OBJECTID_SWEEP_EXEMPT]
    if missing:
        bad("schema-objectid-paths",
            "the Filament schema declares these ObjectId paths that no registered check covers: "
            + ", ".join(missing) + ".\n  An uncastable ObjectId makes POST /api/snapshot refuse "
            "the ENTIRE backup file. Add a check and register it in OBJECTID_CHECKED, or exempt "
            "it in OBJECTID_SWEEP_EXEMPT with the reason.")
    else:
        ok("schema-objectid-paths (%d declared, %d checked, %d exempt)"
           % (len(paths), len(OBJECTID_CHECKED), len(OBJECTID_SWEEP_EXEMPT)))


def case_schema_boolean_paths_covered():
    paths = _schema_paths_of_type("Boolean")
    if paths is None:
        return ok("schema-boolean-paths (schema not locatable — skipped)")
    swept = set(A.BOOL_FIELDS)
    for parent, fields in A.NESTED_BOOL_FIELDS.items():
        swept |= {"%s.%s" % (parent, f) for f in fields}
    missing = [p for p in paths if p not in swept and p not in BOOL_SWEEP_EXEMPT]
    if missing:
        bad("schema-boolean-paths",
            "the Filament schema declares these Boolean paths that the boolean sweep does not "
            "carry: " + ", ".join(missing) + ".\n  Mongoose's Boolean cast refuses a non-boolean, "
            "so the whole restore fails. Add them to BOOL_FIELDS / NESTED_BOOL_FIELDS, or to "
            "BOOL_SWEEP_EXEMPT with the reason.")
    else:
        ok("schema-boolean-paths (%d declared, all swept)" % len(paths))


def case_schema_string_paths_covered():
    import re as _re
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "..", "..", "..", "src", "models", "Filament.ts"))
    lines = src.read().splitlines()
    src.close()
    try:
        start = next(i for i, l in enumerate(lines) if "FilamentSchema = new Schema" in l)
        end = next(i for i in range(start, len(lines)) if "timestamps: true" in lines[i])
    except StopIteration:
        return ok("schema-string-paths (schema not locatable — skipped)")

    entries, cur, key = {}, [], None
    for l in lines[start:end]:
        m = _re.match(r"^    ([A-Za-z_][A-Za-z0-9_]*):", l)
        if m:
            if key:
                entries[key] = "\n".join(cur)
            key, cur = m.group(1), [l]
        elif key:
            cur.append(l)
    if key:
        entries[key] = "\n".join(cur)

    declared = set()
    for k, v in entries.items():
        rows = v.splitlines()
        if _re.search(r":\s*\[", rows[0]):        # arrays / subdoc arrays
            continue
        if _re.search(r"type:\s*String\b", rows[0]) or (
                len(rows) > 1 and _re.match(r"^      type: String", rows[1])):
            declared.add(k)

    missing = sorted(declared - set(A.TEXT_FIELDS) - TEXT_SWEEP_EXEMPT)
    if missing:
        bad("schema-string-paths",
            "the Filament schema declares these top-level String paths that the scalar sweep "
            "does not cover: " + ", ".join(missing) + ".\n  A non-string there fails Mongoose's "
            "cast and POST /api/snapshot refuses the ENTIRE backup file. Add them to TEXT_FIELDS, "
            "or to TEXT_SWEEP_EXEMPT with the reason.")
    else:
        ok("schema-string-paths (%d declared, %d swept, %d exempt)"
           % (len(declared), len(declared) - len(TEXT_SWEEP_EXEMPT), len(TEXT_SWEEP_EXEMPT)))


# --- 14u. ObjectId shapes, everywhere they are declared or implicit ----------
def case_objectid_contract():
    # Python's `$` matches before a trailing newline, so the 24-character
    # contract has to anchor with \Z — Mongoose rejects "<24 hex>\n".
    r = valid_res()
    r["spools"][0]["locationId"] = "6a1a7bef677d648e9ba9cd8c" + chr(10)
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    hit = [m for rows in f.values() for _, m in rows if "locationId" in m]
    ok("objectid-anchored") if hit else bad(
        "objectid-anchored",
        "24 hex + a trailing newline is 25 characters and Mongoose rejects it; Python's `$` "
        "matches before that newline, so the regex must use \\Z")

    # every EMBEDDED subdocument gets an implicit ObjectId `_id`, at any depth
    checks = [
        ("spools", lambda d: d["spools"][0].__setitem__("_id", "s1")),
        ("calibrations", lambda d: d["calibrations"][0].__setitem__("_id", "c1")),
        ("presets", lambda d: d["presets"][0].__setitem__("_id", "p1")),
        ("usageHistory", lambda d: d["spools"][0]["usageHistory"][0].__setitem__("_id", "u1")),
        ("dryCycles", lambda d: d["spools"][0]["dryCycles"][0].__setitem__("_id", "d1")),
    ]
    for label, mut in checks:
        rr = valid_res()
        mut(rr)
        f, _ = run({"a": rec(rr, copy.deepcopy(rr))})
        if not [m for rows in f.values() for _, m in rows if "._id=" in m]:
            bad("objectid-subdoc-ids",
                f"a malformed `_id` on an embedded {label} document cannot be cast, so the whole "
                f"restore fails — and nothing else in the file looks at a subdocument's own id")
            break
    else:
        ok("objectid-subdoc-ids")

    # a falsey non-null parentId is NOT absence — it is an uncastable ObjectId,
    # and treating it as absent skipped every parent-link check as well
    for v in (0, False, [], "t"):
        rp = valid_res(parentId=v)
        f, _ = run({"a": rec(rp, copy.deepcopy(rp))})
        if not [m for rows in f.values() for _, m in rows if "parentId" in m]:
            bad("objectid-parentid-shape",
                f"parentId={v!r} is non-null and uncastable, so the backup is refused — and "
                f"truthiness treated it as absent, so the row read as a clean standalone")
            break
    else:
        ok("objectid-parentid-shape")

    # `_purged` is a top-level Boolean the nested sweep never reached
    for v in ({}, "yes", 1):
        rb = valid_res(_purged=v)
        f, _ = run({"a": rec(rb, copy.deepcopy(rb))})
        if not [m for rows in f.values() for _, m in rows if "_purged" in m]:
            bad("boolean-purged-shape",
                f"_purged={v!r} fails Mongoose's Boolean cast; the listing and detail routes "
                f"filter on `_deletedAt`, so the row is still served and still audited")
            break
    else:
        ok("boolean-purged-shape")

    # the promotion marker requires BOTH members
    for marker in ({"token": "x"}, {"at": "2026-01-01T00:00:00Z"}, {}, "oops",
                   # present but UNCASTABLE — neither empty nor caught by any
                   # nested sweep, so only an explicit shape test sees it
                   {"token": {}, "at": "2026-01-01T00:00:00Z"},
                   {"token": [1, 2], "at": "2026-01-01T00:00:00Z"}):
        rr = valid_res(promotionInFlight=marker)
        f, _ = run({"a": rec(rr, copy.deepcopy(rr))})
        if not [m for rows in f.values() for _, m in rows if "promotionInFlight" in m]:
            bad("promotion-marker-members",
                f"promotionInFlight={marker!r} fails the embedded schema (both members are "
                f"required), so POST /api/snapshot refuses the whole backup")
            break
    else:
        rr = valid_res(promotionInFlight={"token": "x", "at": "2026-01-01T00:00:00Z"})
        f, _ = run({"a": rec(rr, copy.deepcopy(rr))})
        fp = [m for rows in f.values() for _, m in rows if "promotionInFlight" in m]
        ok("promotion-marker-members") if not fp else bad(
            "promotion-marker-members", f"a complete, valid marker was flagged: {fp}")
    # `token` is a String path, so Mongoose CASTS a number or a boolean onto it
    # ("42", "true") and the marker validates. The old `isinstance(_ptok, str)`
    # test called that unrestorable -- a false positive, measured against
    # mongoose 9.7.4. A populated-ref shape casts through `_id` for the same
    # reason; only a value the cast refuses is a real finding.
    for _cast_ok in ({"token": 42, "at": "2026-01-01T00:00:00Z"},
                     {"token": True, "at": "2026-01-01T00:00:00Z"},
                     {"token": {"_id": "x"}, "at": "2026-01-01T00:00:00Z"}):
        rr = valid_res(promotionInFlight=_cast_ok)
        f, _ = run({"a": rec(rr, copy.deepcopy(rr))})
        fp = [m for rows in f.values() for _, m in rows
              if "promotionInFlight" in m and "not a string" in m]
        if fp:
            bad("promotion-marker-castable-token",
                f"Mongoose casts {_cast_ok['token']!r} onto the String path, so the marker "
                f"validates and the backup restores: {fp}")
            break
    else:
        ok("promotion-marker-castable-token")


# --- 14v. every JS-mirroring trim site, and the Boolean cast's real set ------
# `_js_trim` has now been applied at four separate sites across three rounds,
# each time because the previous fix covered only the site under review. These
# pin the ones that mirror an app operation, so the next omission fails here.
def case_js_mirror_sites():
    NEL, ZWNBSP = chr(0x85), chr(0xFEFF)

    # _bad_date: V8 KEEPS U+0085, so "2020-01-01"+NEL is an Invalid Date that
    # Python's strip would have reduced to a valid ISO date
    ok("mirror-date-trim") if A._bad_date("2020-01-01" + NEL) else bad(
        "mirror-date-trim",
        "V8 keeps U+0085, so this is an Invalid Date — Python's strip() would accept it")
    if A._bad_date("2020-01-01"):
        bad("mirror-date-trim-negative", "a plain ISO date must stay valid")
    else:
        ok("mirror-date-trim-negative")

    # duplicate-name grouping (main()'s `by_name`, which the id-suffix keys off):
    # JS trimming collapses "X" and "X"+U+FEFF into ONE bucket, which is what
    # makes their findings carry record ids. Asserted on the property directly,
    # because the suffixing itself lives in main()'s render(), not in audit().
    if A._js_trim("X" + ZWNBSP) == A._js_trim("X") == "X":
        ok("mirror-name-grouping")
    else:
        bad("mirror-name-grouping",
            "two names JS trimming makes identical must land in the SAME by_name bucket, or "
            "their findings render indistinguishably with no ids attached")

    # Mongoose's Boolean cast accepts far more than `true`/`false`
    castable = [v for v in (0, 1, "true", "false", "yes", "1", "0") if not A._bool_castable(v)]
    ok("mirror-bool-castable") if not castable else bad(
        "mirror-bool-castable", f"Mongoose's Boolean cast ACCEPTS these: {castable} — claiming the "
                                f"restore fails would be a false alarm")
    uncastable = [v for v in ({}, [], 2, "maybe") if A._bool_castable(v)]
    ok("mirror-bool-uncastable") if not uncastable else bad(
        "mirror-bool-uncastable", f"Mongoose REJECTS these: {uncastable}")


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

# --- 15. POSITIVE assertions for emit sites nothing pinned ------------------
# A mutation sweep deleted each of the 122 emit sites in turn: 59 of them could
# be removed with this suite still green, so nearly half the audit's output had
# nothing proving it fires at all -- a check could rot, or be deleted outright,
# and the only signal would be a report that quietly stopped mentioning it.
# Each case below makes one site emit and asserts its message appears; each was
# verified by deleting that site and confirming THIS suite goes red.
# --- 17. the "this was NOT checked" reports ----------------------------------
# Every report below exists for one reason: to stop an UNCHECKED audit from
# rendering as a CLEAN one. That is the worst possible outcome for a checker --
# the user reads a green report and ships an abrasive filament onto a brass
# nozzle. Mutation testing showed all of them could be deleted with this suite
# still green, because the only cases that reached them asserted "did not raise"
# and never looked at what came back.
def case_pin_discovery_degraded_reported():
    fid = "6a1a7c00677d648e9ba9d001"
    note = "listing returned 3 of 40 filaments (HTTP 502 on page 2)"
    try:
        f, _, _ = A.audit({fid: rec()}, (), None, None, note, None)
    except Exception as e:
        return bad("degraded-reported", f"audit raised: {type(e).__name__}: {e}")
    rows = [m for rows_ in f.values() for _, m in rows_]
    hit = [m for m in rows if "DISCOVERY DEGRADED" in m]
    if not hit:
        return bad("degraded-reported",
                   "discovery could only enumerate PART of the library and the audit said "
                   "nothing about it -> every filament that was never fetched renders as "
                   "clean, so the report claims a coverage it does not have.\n"
                   f"    rows were: {rows}")
    if note not in hit[0]:
        return bad("degraded-reported",
                   "the row must carry WHAT degraded, or the user cannot tell which read to "
                   f"retry: {hit[0]!r}")
    ok("degraded-reported")

    # ...and a clean discovery must stay silent, or the banner is noise that
    # trains the user to ignore it
    f, _, _ = A.audit({fid: rec()}, (), None, None, None, None)
    fp = [m for rows_ in f.values() for _, m in rows_ if "DISCOVERY DEGRADED" in m]
    ok("degraded-clean-silent") if not fp else bad(
        "degraded-clean-silent", f"nothing degraded, yet the banner fired: {fp}")


def case_pin_unreadable_filament_reported():
    fid = "6a1a7c00677d648e9ba9d001"
    dead = "6a1a7c00677d648e9ba9d0ff"
    try:
        f, _, _ = A.audit({fid: rec()}, (), {dead: "HTTP 500"}, None, None, None)
    except Exception as e:
        return bad("unreadable-filament-reported", f"audit raised: {type(e).__name__}: {e}")
    rows = [(rid, m) for rows_ in f.values() for rid, m in rows_]
    hit = [(rid, m) for rid, m in rows if "could NOT be read" in m]
    if not hit:
        return bad("unreadable-filament-reported",
                   "a filament whose detail read FAILED was dropped in silence -> it is "
                   "absent from the report exactly like a filament with no problems, so a "
                   "defect in it is indistinguishable from a clean bill of health.\n"
                   f"    rows were: {[m for _, m in rows]}")
    if not any(dead in m and "HTTP 500" in m for _, m in hit):
        return bad("unreadable-filament-reported",
                   "the row must name WHICH filament and WHY the read failed, or it is not "
                   f"actionable: {[m for _, m in hit]}")
    if not any(rid == dead for rid, _ in hit):
        return bad("unreadable-filament-reported",
                   "the finding must carry the failed filament's id so the render can link "
                   f"to it: {hit}")
    ok("unreadable-filament-reported")


def case_pin_abrasive_payload_not_a_list():
    fid = "6a1a7c00677d648e9ba9d001"
    r = valid_res(_id=fid, name="CF PA")
    # NOT {"error": ...} -- that shape has its own report. These two reach the
    # "the route answered, but with something that is not a findings list"
    # branch: an older build's body, or a proxy page served with a 200.
    for label, payload, shown in (("string-body", "oops", "str"),
                                  ("dict-without-error", {"nozzles": []}, "dict")):
        try:
            f, _ = run({fid: rec(r, copy.deepcopy(r))}, abrasive=payload)
        except Exception as e:
            bad(f"abrasive-not-a-list-{label}", f"audit raised: {type(e).__name__}: {e}")
            continue
        rows = [m for rows_ in f.values() for _, m in rows_]
        hit = [m for m in rows if "not a list -> abrasive safety was NOT checked" in m]
        if not hit:
            bad(f"abrasive-not-a-list-{label}",
                "/api/abrasive-nozzles answered with a body this script cannot read, and the "
                "audit said nothing -> the abrasive section renders EMPTY, which reads as "
                "'no abrasive problems' while nothing was examined at all.\n"
                f"    rows were: {rows}")
            continue
        if shown not in hit[0]:
            bad(f"abrasive-not-a-list-{label}",
                f"the row must name what came back instead, or the user cannot diagnose the "
                f"endpoint: {hit[0]!r}")
            continue
        ok(f"abrasive-not-a-list-{label}")


def case_pin_abrasive_unassigned_suppresses_generic_nozzle_rows():
    # /api/abrasive-nozzles is AUTHORITATIVE for abrasive filaments, and it
    # reports "no nozzle assignment" with far better remediation than this
    # script can. The generic nozzle-assignment checks therefore skip the ids it
    # already named. Drop that bookkeeping and the same physical defect renders
    # TWICE with two different fixes attached, which is exactly the contradiction
    # the division of labour exists to prevent.
    fid = "6a1a7c00677d648e9ba9d001"
    noz = "6a1a7bed677d648e9ba9cc01"
    payload = [{"filamentId": fid, "filamentName": "CF PA", "reasons": ["carbon fibre"],
                "flagMismatch": False, "softNozzles": [], "unassigned": True}]

    def build(compat):
        r = valid_res(_id=fid, name="CF PA")
        r["compatibleNozzles"] = compat
        return {fid: rec(r, copy.deepcopy(r))}

    for label, compat, generic in (
        ("stale-ticks",
         [{"_id": noz, "name": "0.4 Brass", "_deletedAt": "2026-01-01T00:00:00Z"}],
         "effectively unassigned"),
        ("no-ticks", [], "no compatibleNozzles, but 1 calibration(s) are stored"),
    ):
        # The generic check must genuinely REACH this fixture. Without this the
        # suppression assertion below is vacuous and would pass against a
        # fixture that could never have produced the row in the first place.
        try:
            f, _ = run(build(compat))
        except Exception as e:
            bad(f"abrasive-unassigned-{label}", f"audit raised: {type(e).__name__}: {e}")
            continue
        control = [m for rows_ in f.values() for _, m in rows_ if generic in m]
        if not control:
            bad(f"abrasive-unassigned-{label}-reachable",
                f"the fixture never produced the generic row {generic!r} even with no "
                f"abrasive payload, so the suppression check below proves nothing; rows "
                f"were: {[m for rows_ in f.values() for _, m in rows_]}")
            continue

        f, _ = run(build(compat), abrasive=payload)
        rows = [m for rows_ in f.values() for _, m in rows_]
        if not any("no nozzle assignment at all" in m for m in rows):
            bad(f"abrasive-unassigned-{label}",
                f"the authoritative abrasive row vanished, so this case cannot tell "
                f"suppression from a broken payload; rows were: {rows}")
            continue
        dup = [m for m in rows if generic in m]
        if dup:
            bad(f"abrasive-unassigned-{label}",
                "/api/abrasive-nozzles already reported this filament as having NO nozzle "
                "assignment, and the generic check restated it -> one physical defect "
                "renders as two findings in two sections with two different remediations.\n"
                f"    duplicate: {dup}")
            continue
        ok(f"abrasive-unassigned-{label}")


def case_pin_unusable_pair_reported():
    # Each record is TWO reads (resolved + ?raw=true). If either is not a
    # document the record is dropped from the audit entirely -- so it MUST be
    # reported, or a filament silently leaves the run and its absence from the
    # findings reads as "this one is fine".
    for label, pair, shown in (
        ("res-not-a-document", {"res": "HTTP 500 body", "raw": valid_res()}, "str/dict"),
        ("raw-missing", {"res": valid_res(), "raw": None}, "dict/NoneType"),
    ):
        fid = "6a1a7c00677d648e9ba9d001"
        try:
            f, _, _ = A.audit({fid: pair}, (), None, None, None, None)
        except Exception as e:
            bad(f"unusable-pair-{label}", f"audit raised: {type(e).__name__}: {e}")
            continue
        rows = [(rid, m) for rows_ in f.values() for rid, m in rows_]
        hit = [(rid, m) for rid, m in rows
               if "not two documents -> it was NOT audited" in m]
        if not hit:
            bad(f"unusable-pair-{label}",
                "one of the record's two reads was not a document, so the record was "
                "DROPPED before any check ran -- and nothing said so. An unaudited "
                "filament is then indistinguishable from a clean one.\n"
                f"    rows were: {[m for _, m in rows]}")
            continue
        if not any(shown in m for _, m in hit):
            bad(f"unusable-pair-{label}",
                f"the row must name which read was wrong and what it was, or the user "
                f"cannot tell a failed HTTP read from a shape bug: {[m for _, m in hit]}")
            continue
        if not any(rid == fid for rid, _ in hit):
            bad(f"unusable-pair-{label}",
                f"the finding must carry the record id it dropped: {hit}")
            continue
        ok(f"unusable-pair-{label}")


def case_pin_required_text_missing_reported():
    # name/vendor/type are schema-REQUIRED. A stored document missing one was
    # written by a path that bypassed Mongoose validation, and it fails the
    # required validator on the next save -- which is what makes a whole
    # snapshot restore refuse. Invisible on a variant, whose resolved read
    # inherits vendor/type from the template and looks complete.
    fid = "6a1a7c00677d648e9ba9d001"
    for field in sorted(A.REQUIRED_TEXT):
        for label, mutate in (("absent", "pop"), ("null", "none")):
            r = valid_res(_id=fid)
            if mutate == "pop":
                r.pop(field, None)
            else:
                r[field] = None
            raw = copy.deepcopy(r)
            try:
                f, _, _ = A.audit({fid: {"res": r, "raw": raw}}, (), None, None, None, None)
            except Exception as e:
                bad(f"required-text-{field}-{label}",
                    f"audit raised: {type(e).__name__}: {e}")
                continue
            rows = [m for rows_ in f.values() for _, m in rows_]
            want = f"{field} is missing but the schema requires it"
            if any(want in m for m in rows):
                ok(f"required-text-{field}-{label}")
            else:
                bad(f"required-text-{field}-{label}",
                    f"the stored document carries no {field}, which the schema declares "
                    f"required -> the row was written by a path that bypassed validation and "
                    f"will fail the next save (and take a whole snapshot restore down with "
                    f"it), and the audit did not mention it.\n    rows were: {rows}")

# --- 17. schema-REQUIRED text that is PRESENT but blank ----------------------
# The absence branch (`None`) says "is missing"; this is the other half, where
# the field EXISTS and is empty. Both are rows Mongoose's required validator
# would refuse, so they can only arrive by a raw-driver sync, a hybrid-sync copy
# or a restore — and on a variant the RESOLVED read hides them completely,
# because resolveFilament treats "" as the inherit sentinel and substitutes the
# template's value. Judged on the STORED read for exactly that reason.
def case_pin_required_text_present_but_empty():
    # `vendor` is required WITHOUT trim, so only the exact empty string violates.
    r = valid_res(vendor="")
    try:
        findings, _ = run({"a": rec(r, copy.deepcopy(r))})
    except Exception as e:
        return bad("required-text-empty-vendor", f"raised: {type(e).__name__}: {e}")
    hit = any("vendor is the empty string but the schema requires it" in m
              for rows in findings.values() for _, m in rows)
    ok("required-text-empty-vendor") if hit else bad(
        "required-text-empty-vendor",
        'vendor="" produced no finding -> a row the required validator would refuse '
        "audits clean, and it stays invisible until POST /api/snapshot refuses the "
        "ENTIRE backup file")

    # `name` is `{required, trim}`, so Mongoose trims BEFORE the required check.
    # U+FEFF is the case Python's own str.strip() cannot see: the stored name
    # looks non-empty here and is trimmed to "" by Mongoose, so the record fails
    # its own required validator on the next write.
    r2 = valid_res(name="﻿")
    try:
        f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    except Exception as e:
        return bad("required-text-blank-name", f"raised: {type(e).__name__}: {e}")
    hit2 = any("name is empty after trimming but the schema requires it" in m
               for rows in f2.values() for _, m in rows)
    ok("required-text-blank-name") if hit2 else bad(
        "required-text-blank-name",
        "a name of only U+FEFF produced no finding -> Mongoose trims it away and the "
        "required validator then refuses the row, so the whole restore fails with "
        "nothing in the report pointing at this filament")


# --- 18. NESTED text fields on a spool --------------------------------------
# One level below the top-level text sweep. Each of these has a real render or
# search site, so the consequence differs per field — which is the whole reason
# the site interpolates _nested_text_consequence instead of one fixed sentence.
# Without a positive assertion the entire per-field table could be deleted and
# every one of these would audit clean.
def case_pin_nested_spool_text_shape():
    for field, value, phrase in (
            # /inventory's search does `(s.lotNumber || "").toLowerCase()`
            ("lotNumber", 42, "lotNumber is int"),
            # straight into an <img src>, which coerces rather than throwing
            ("photoDataUrl", 7, "photoDataUrl is int"),
            # computeNextSpoolLabel skips non-string labels, so the roll number
            # can be handed out twice
            ("label", 12, "label is int"),
    ):
        r = valid_res()
        r["spools"][0][field] = value
        try:
            findings, _ = run({"a": rec(r, copy.deepcopy(r))})
        except Exception as e:
            bad(f"nested-spool-text-{field}", f"raised on {value!r}: {type(e).__name__}: {e}")
            continue
        hit = any(phrase in m and "not a string" in m
                  for rows in findings.values() for _, m in rows)
        ok(f"nested-spool-text-{field}") if hit else bad(
            f"nested-spool-text-{field}",
            f"spools[0].{field}={value!r} produced no finding -> a value the schema "
            f"declares as a string is off-type and the record reads clean, while the "
            f"page or search that consumes it breaks with nothing to explain why")


# --- 19. a spool's `retired` flag that is not a boolean ----------------------
# Read by TRUTHINESS everywhere (`if (spool.retired) continue`), so any non-empty
# string, {} or [] removes the roll from the spool count, the gram total and the
# % bar. The inventory checks then deliberately AGREE with the app and stay
# silent about that spool (case_js_truthiness_and_direction pins that silence),
# so this report is the only thing that says the stock vanished.
def case_pin_spool_retired_not_boolean():
    for value in ("false", {}, 1):
        r = valid_res()
        r["spools"][0]["retired"] = value
        try:
            findings, _ = run({"a": rec(r, copy.deepcopy(r))})
        except Exception as e:
            bad("nested-bool-retired", f"raised on {value!r}: {type(e).__name__}: {e}")
            continue
        hit = any("retired is" in m and "not a boolean" in m
                  for rows in findings.values() for _, m in rows)
        ok(f"nested-bool-retired-{value!r}") if hit else bad(
            "nested-bool-retired",
            f"spools[0].retired={value!r} produced no finding -> the app tests it by "
            f"truthiness and the inventory checks stay silent to match, so a roll that "
            f"has silently left the count, the gram total and the % bar is reported "
            f"nowhere at all")


# --- 20. ELEMENTS of the spool ledgers must be subdocuments -------------------
# NESTED_CONTAINER_SHAPES only checks that `usageHistory`/`dryCycles` are lists,
# so a list of scalars passes it, and every later pass returns quietly on a
# non-dict — while exportSpools reads `u.grams` and `c.date` straight off these
# entries. The top-level element check (spools/calibrations/presets/bedTypeTemps)
# never reaches one level down, so without this the whole nested-element sweep
# could go and the record would still audit clean.
def case_pin_ledger_elements_are_subdocuments():
    for sub, elem in (("usageHistory", "oops"), ("usageHistory", 7),
                      ("dryCycles", None), ("dryCycles", ["x"])):
        r = valid_res()
        r["spools"][0][sub] = [elem]
        try:
            findings, _ = run({"a": rec(r, copy.deepcopy(r))})
        except Exception as e:
            bad(f"ledger-element-{sub}", f"raised on {elem!r}: {type(e).__name__}: {e}")
            continue
        hit = any(f"{sub}[0] is" in m and "not a subdocument" in m
                  for rows in findings.values() for _, m in rows)
        ok(f"ledger-element-{sub}-{elem!r}") if hit else bad(
            f"ledger-element-{sub}",
            f"spools[0].{sub}=[{elem!r}] produced no finding -> the entry is skipped by "
            f"every check and the record reads clean, while the export and the analytics "
            f"totals read fields straight off it")


# --- 21. text INSIDE the ledger entries -------------------------------------
# `jobLabel` and `notes` are the deepest text the audit reads, and the site
# chooses one of three consequences by VALUE shape — React-child crash, refused
# String cast, or merely off-type. Assert one of each, so neither the site nor
# the branch that picks its wording can be dropped silently.
def case_pin_ledger_text_shape():
    for sub, field, value, phrase in (
            # a plain object reaching React: the usage disclosure throws
            ("usageHistory", "jobLabel", {"a": 1},
             "the usage disclosure renders it as a React child"),
            # a list: Mongoose's String cast always refuses it
            ("dryCycles", "notes", ["a"],
             "refuses the ENTIRE backup file"),
            # a number: castable and never rendered, so merely off-type — the
            # honest wording, which a single fixed sentence would get wrong
            ("dryCycles", "notes", 42,
             "the stored value simply is not the declared type"),
    ):
        r = valid_res()
        r["spools"][0][sub][0][field] = value
        try:
            findings, _ = run({"a": rec(r, copy.deepcopy(r))})
        except Exception as e:
            bad(f"ledger-text-{sub}.{field}",
                f"raised on {value!r}: {type(e).__name__}: {e}")
            continue
        rows = [m for rows_ in findings.values() for _, m in rows_]
        hit = any(f"{sub}[0].{field} is" in m and "not a string" in m and phrase in m
                  for m in rows)
        ok(f"ledger-text-{sub}.{field}-{value!r}") if hit else bad(
            f"ledger-text-{sub}.{field}",
            f"spools[0].{sub}[0].{field}={value!r} produced no finding naming "
            f"{phrase!r} -> the deepest text the audit reads is off-type and the record "
            f"is declared clean:\n    " + "\n    ".join(rows))


# --- 22. the listing's topology is what keeps an ONLY-CHILD template a template
# Template-ness is DERIVED from having variants, and it is derived from the
# records in hand — so a template whose ONLY variant failed its detail read has
# no child to derive it from and is reclassified as a standalone. Every template
# check is then skipped in exactly the case where the family is already half
# unreadable. The listing carries `hasVariants` independently, so it is trusted.
def case_pin_listing_topology_keeps_template():
    tpl_id, var_id = "6a1a7c00677d648e9ba9d101", "6a1a7c00677d648e9ba9d102"

    def records():
        t = valid_res(_id=tpl_id, name="Prusament PLA", parentId=None,
                      instanceId="tttttttttt")
        return {tpl_id: rec(t, copy.deepcopy(t))}

    # The listing says this row HAS variants; its only child could not be read.
    try:
        findings, parents = run(records(), failed_map={var_id: "HTTPError: 500"},
                                topology={tpl_id: True, var_id: False})
    except Exception as e:
        return bad("topology-template", f"raised: {type(e).__name__}: {e}")
    rows = [m for rows_ in findings.values() for _, m in rows_]
    hit = any("(TEMPLATE): holds 1 spool(s) — inventory belongs on a variant" in m
              for m in rows)
    if hit:
        ok("topology-template")
    else:
        bad("topology-template",
            "a template whose only variant failed its detail read was audited as an "
            "ordinary standalone -> every template check is skipped (the v1.70 #605 "
            "inventory-on-a-template rows above all), and the missing-core checks it "
            "is legitimately exempt from can fire instead:\n    " + "\n    ".join(rows))
    if tpl_id not in parents:
        bad("topology-template-parents",
            "the listing flagged this row as having variants, but it is absent from the "
            "returned parent set -> nothing downstream can treat it as a template")
    else:
        ok("topology-template-parents")

    # …and the flag must be READ, not assumed: a listing row that has NO
    # variants is a standalone, and inventory on it is perfectly normal.
    try:
        f2, _ = run(records(), topology={tpl_id: False})
    except Exception as e:
        return bad("topology-standalone", f"raised: {type(e).__name__}: {e}")
    false_alarm = [m for rows_ in f2.values() for _, m in rows_ if "(TEMPLATE)" in m]
    ok("topology-standalone") if not false_alarm else bad(
        "topology-standalone",
        f"a row the listing says has NO variants was reported as a template, so the "
        f"report demands a promotion the app would refuse: {false_alarm}")

# --- 17. the settings bag's SIZE limits, each pinned to its own consequence --
# validateSettingsBag enforces a key COUNT and a per-value LENGTH, and the two
# fail differently: an over-count bloats every detail read while an over-long
# value is refused outright. Both were emitted with nothing asserting they fire,
# so either could be deleted whole and the suite stayed green.
def case_pin_settings_bag_key_count():
    r = valid_res()
    r["settings"] = {f"filament_key_{i}": "v" for i in range(A.MAX_SETTINGS_KEYS + 1)}
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    needle = (f"settings holds {A.MAX_SETTINGS_KEYS + 1} keys, past the "
              f"{A.MAX_SETTINGS_KEYS}-key limit validateSettingsBag enforces")
    if not [m for rows in f.values() for _, m in rows if needle in m]:
        return bad("settings-key-count",
                   f"a bag of {A.MAX_SETTINGS_KEYS + 1} keys is past the limit "
                   f"validateSettingsBag enforces, so the row cannot be saved from the form "
                   f"again and it bloats every detail read and export — nothing was reported")
    # ...and a bag exactly AT the limit is legal, so it must stay silent.
    r2 = valid_res()
    r2["settings"] = {f"filament_key_{i}": "v" for i in range(A.MAX_SETTINGS_KEYS)}
    f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows in f2.values() for _, m in rows if "-key limit" in m]
    ok("settings-key-count") if not fp else bad(
        "settings-key-count", f"a bag AT the limit is accepted by the app: {fp}")


def case_pin_settings_value_length_limit():
    r = valid_res()
    r["settings"] = {"start_filament_gcode": "G" * (A.MAX_SETTING_VALUE_LENGTH + 1)}
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    tail = f"UTF-16 units, past the {A.MAX_SETTING_VALUE_LENGTH}-character limit"
    if not [m for rows in f.values() for _, m in rows
            if tail in m and "settings.start_filament_gcode is" in m]:
        return bad("settings-value-length",
                   f"a {A.MAX_SETTING_VALUE_LENGTH + 1}-character bag value serialises past the "
                   f"{A.MAX_SETTING_VALUE_LENGTH}-character limit, so every later save of this "
                   f"filament is refused — nothing was reported")
    # The limit counts UTF-16 CODE UNITS. Half as many astral characters is the
    # same JS length and must still report; a Python len() would call it legal.
    r2 = valid_res()
    r2["settings"] = {"start_filament_gcode": "\U0001F600" * (A.MAX_SETTING_VALUE_LENGTH // 2)}
    f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    if not [m for rows in f2.values() for _, m in rows if tail in m]:
        return bad("settings-value-length",
                   f"{A.MAX_SETTING_VALUE_LENGTH // 2} astral characters are "
                   f"{A.MAX_SETTING_VALUE_LENGTH} UTF-16 units to JavaScript, so the app refuses "
                   f"the value; measuring Python characters calls it half the size and clean")
    # a value comfortably under the limit is legal and must stay silent
    r3 = valid_res()
    r3["settings"] = {"start_filament_gcode": "G" * (A.MAX_SETTING_VALUE_LENGTH - 2)}
    f3, _ = run({"a": rec(r3, copy.deepcopy(r3))})
    fp = [m for rows in f3.values() for _, m in rows if "UTF-16 units" in m]
    ok("settings-value-length") if not fp else bad(
        "settings-value-length", f"a value at the limit is accepted by the app: {fp}")


# --- 17b. a NESTED value in the flat bag ships as coerced garbage ------------
# validateSettingsBag checks object-ness, the key count and the length -- never
# the value's SHAPE -- so a dict or a nested list is written happily and then
# String()-coerced by every exporter. The two shapes ship DIFFERENTLY, which is
# why the message names which one: an object becomes the literal
# "[object Object]" while a nested array is comma-joined, leaving nothing to grep
# for. Both were emitted from one site nothing asserted.
def case_pin_settings_nested_value_shapes():
    r = valid_res()
    r["settings"] = {"filament_custom_gcode": {"nested": 1}}
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_
            if "settings.filament_custom_gcode is a dict, but the bag holds scalars" in m]
    if not rows:
        return bad("settings-nested-value",
                   "an OBJECT in the flat settings bag exports as the literal '[object Object]' "
                   "into both the INI bundle and the Orca JSON, silently losing the value the "
                   "bag exists to round-trip — nothing was reported")
    if not any("ships as the literal '[object Object]'" in m for m in rows):
        return bad("settings-nested-value",
                   f"the row must name the object consequence so the reader knows what to grep "
                   f"the export for: {rows}")
    # a nested ARRAY does NOT produce "[object Object]" -- it comma-joins, and a
    # re-import reads the join back as one scalar containing commas
    r2 = valid_res()
    r2["settings"] = {"filament_retract_length": [[0.8, 0.9]]}
    f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    rows2 = [m for rows_ in f2.values() for _, m in rows_
             if "settings.filament_retract_length is a list, but the bag holds scalars" in m]
    if not rows2:
        return bad("settings-nested-value",
                   "a NESTED array in the settings bag is String()-coerced by every exporter "
                   "and re-imported as one comma-bearing scalar — nothing was reported")
    if not any("comma-JOINED" in m for m in rows2):
        return bad("settings-nested-value",
                   f"the nested-array row must not claim the '[object Object]' consequence, "
                   f"which only an object produces: {rows2}")
    # a FLAT array of scalars is the supported #678 shape and must stay silent
    r3 = valid_res()
    r3["settings"] = {"filament_retract_length": ["0.8", "0.9"]}
    f3, _ = run({"a": rec(r3, copy.deepcopy(r3))})
    fp = [m for rows_ in f3.values() for _, m in rows_ if "the bag holds scalars" in m]
    ok("settings-nested-value") if not fp else bad(
        "settings-nested-value",
        f"an array of scalars is the supported shape since #678 and round-trips: {fp}")


# --- 17c. the #1066 printer pin, in BOTH of the shapes the bag can hold ------
# PrusaSlicer evaluates compatible_printers/_condition as a hard VISIBILITY
# filter, so a preset duplicated from another printer's profile carries that
# printer's pin in and the synced preset then appears on NO other machine, with
# nothing in the slicer to say why. Nothing asserted the audit reports it.
def case_pin_compatible_printers_pin_reported():
    for key, value, shown in (
            ("compatible_printers_condition", "printer_model=~/(MK4S|MK4)/",
             "printer_model=~/(MK4S|MK4)/"),
            # a LIST is the supported coStrings shape and imposes the same hard
            # whitelist; a string-only test called the multi-printer pin healthy
            ("compatible_printers", ["MK4S", "XL"], "MK4S, XL")):
        r = valid_res()
        r["settings"] = {key: value}
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in f.values() for _, m in rows_
                if f"settings.{key} pins {shown!r}" in m]
        if not rows:
            return bad("compatible-printers-pin",
                       f"settings.{key}={value!r} hides the exported preset on every printer "
                       f"that fails it, with no in-app cause and no slicer error — nothing "
                       f"was reported")
        if not any("hard visibility filter, so the exported preset is HIDDEN" in m
                   for m in rows):
            return bad("compatible-printers-pin",
                       f"the row must state the consequence, or it reads as a harmless "
                       f"settings note: {rows}")
    # An empty / whitespace-only pin is "no restriction" -- the app's own way of
    # clearing it -- and a list of blanks is the same thing. Neither may report.
    for blank in ("", "   ", ["", "  ", None]):
        r2 = valid_res()
        r2["settings"] = {"compatible_printers": blank}
        f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
        fp = [m for rows_ in f2.values() for _, m in rows_ if "visibility filter" in m]
        if fp:
            return bad("compatible-printers-pin",
                       f"{blank!r} is the cleared state (an explicit empty string is how the "
                       f"form clears the pin), so reporting it sends the user to un-set "
                       f"nothing: {fp}")
    ok("compatible-printers-pin")


# --- 17d. the two inventory inputs are named SEPARATELY ----------------------
# Both rows end in "no % bar", so a test that greps that phrase is satisfied by
# EITHER of them: the netFilamentWeight site could be deleted whole and the
# spoolWeight row alone kept the suite green. They are different repairs -- one
# is the bar's denominator, the other its subtrahend -- so each is pinned by the
# field it names.
def case_pin_net_filament_weight_missing():
    for label, r in (("live spool", valid_res(netFilamentWeight=None)),
                     # `<= 0` is as unusable a denominator as absent
                     ("zero net", valid_res(netFilamentWeight=0)),
                     # a pre-migration roll carries its stock top-level, with no
                     # spools[] at all -- exactly the record this skill exists for
                     ("legacy roll", valid_res(netFilamentWeight=None, spools=[],
                                               totalWeight=800))):
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in f.values() for _, m in rows_
                if "but netFilamentWeight=" in m and "-> no % bar" in m]
        if not rows:
            return bad("net-filament-weight-missing",
                       f"[{label}] netFilamentWeight is the DENOMINATOR of getRemainingPct, so "
                       f"without it the remaining bar can never render for stock the app is "
                       f"tracking — nothing named the field")
        if any("no spoolWeight (tare)" in m for m in rows):
            return bad("net-filament-weight-missing",
                       f"[{label}] the tare is present; naming it sends the repair at the wrong "
                       f"field: {rows}")
    # a record with BOTH inputs must stay silent
    f2, _ = run({"a": rec()})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "netFilamentWeight=" in m]
    ok("net-filament-weight-missing") if not fp else bad(
        "net-filament-weight-missing", f"a fully weighed filament was flagged: {fp}")


# --- 17e. one malformed number, one row -------------------------------------
# The numeric sweep walks BOTH reads, and for a standalone the two are the same
# document -- so without the (path, value) dedup every malformed number is
# reported twice, once "(resolved)" and once "(stored)", doubling the noise in
# the commonest case. The dedup must not go the other way either: two GENUINELY
# different values at one path are two defects.
def case_pin_numeric_sweep_dedupes_identical_reads():
    r = valid_res(cost="oops")
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_
            if "cost is str ('oops'), not a number" in m]
    if len(rows) != 1:
        return bad("numeric-sweep-dedup",
                   f"one malformed `cost` present identically in both reads produced "
                   f"{len(rows)} rows; a standalone's two reads are the same document, so "
                   f"every such defect would be reported twice:\n    " + "\n    ".join(rows))
    # ...and a variant whose reads genuinely DIFFER still reports both, because
    # resolveFilament reads a stored "" as an inheritance sentinel and shows the
    # template's number: only the stored read reveals it.
    f2, _ = run({"a": {"res": valid_res(cost="oops"), "raw": valid_res(cost="bad")}})
    rows2 = [m for rows_ in f2.values() for _, m in rows_ if "cost is str" in m]
    if len(rows2) != 2:
        return bad("numeric-sweep-dedup",
                   f"two DIFFERENT malformed values at one path are two defects, and the "
                   f"stored one is the only evidence of a variant's own bad value; got "
                   f"{len(rows2)} row(s): {rows2}")
    ok("numeric-sweep-dedup")

# --- 14z. emit sites a mutation sweep proved nothing pinned ------------------
# Each `add(...)` below could be DELETED from audit.py outright and this suite
# still ran green: nothing anywhere demonstrated that the check fires at all.
# So each case asserts the MESSAGE a reader has to act on -- a distinctive
# substring, never a count, so an unrelated new finding cannot satisfy it -- and
# pairs it with the negative that keeps the check from later being "fixed" into
# firing on healthy data.


def case_pin_legacy_roll_gross_below_tare():
    """A pre-spools[] roll whose gross weight sits under its own tare."""
    # An empty spools[] plus a top-level totalWeight IS the legacy shape
    # (getRemainingPct's second branch), so such a row never enters the
    # per-spool loop -- with this site gone the entire legacy population goes
    # unaudited for the defect, and nothing else in the corpus notices.
    r = valid_res(spools=[], totalWeight=100, spoolWeight=200, netFilamentWeight=1000)
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_]
    hit = [m for m in rows if "legacy gross 100g is below tare 200g" in m]
    if not hit:
        bad("pin-legacy-gross-below-tare",
            "a legacy roll whose 100g gross sits under its 200g tare clamps to 0 -- it reads as "
            "EMPTY everywhere and spool-check refuses every job, with nothing on screen to say "
            f"why. Got: {rows}")
    elif "spool-check refuses every job" not in hit[0]:
        bad("pin-legacy-gross-below-tare",
            f"the row must name the consequence the user acts on, not just the numbers: {hit[0]}")
    else:
        ok("pin-legacy-gross-below-tare")
    # ...and a roll merely FINISHED -- a few grams under the tare -- is not a
    # defect. The tolerance is the whole thing keeping this row off every
    # used-up spool in the library.
    r2 = valid_res(spools=[], totalWeight=190, spoolWeight=200, netFilamentWeight=1000)
    f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "below tare" in m]
    ok("pin-legacy-gross-below-tare-tolerance") if not fp else bad(
        "pin-legacy-gross-below-tare-tolerance",
        f"a 10g shortfall is inside BELOW_TARE_TOLERANCE_G; reporting it would flag every "
        f"nearly-empty roll and bury the real ones: {fp}")



def case_pin_every_live_spool_lacks_gross():
    """The AGGREGATE row: no live spool carries a gross, so there is no bar."""
    # The per-spool "has no totalWeight" row says the spool contributes nothing.
    # This one says something strictly worse and separately actionable --
    # getRemainingPct returns null outright, so the filament has NO bar at all
    # -- and it is emitted only when every live spool is weightless.
    r = valid_res()
    del r["spools"][0]["totalWeight"]
    s2 = copy.deepcopy(r["spools"][0])
    s2["_id"] = "6a1a7bf0677d648e9ba9cd20"
    s2["instanceId"] = "0011223355"
    s2["label"] = "13"
    r["spools"].append(s2)
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_]
    hit = [m for m in rows if "every live spool is missing its gross weight" in m]
    if not hit:
        bad("pin-every-live-spool-lacks-gross",
            "with no live spool carrying a gross weight getRemainingPct returns null and the "
            f"filament shows no bar at all -- that has to be said once, for the filament: {rows}")
    elif "no bar at all" not in hit[0]:
        bad("pin-every-live-spool-lacks-gross",
            f"the aggregate row must name the null bar, which is what distinguishes it from the "
            f"per-spool rows: {hit[0]}")
    else:
        ok("pin-every-live-spool-lacks-gross")
    # ...and ONE weighed sibling is enough for a bar to render, so the aggregate
    # must stay silent there while the per-spool row still fires.
    r2 = valid_res()
    del r2["spools"][0]["totalWeight"]
    s3 = copy.deepcopy(r2["spools"][0])
    s3["_id"] = "6a1a7bf0677d648e9ba9cd20"
    s3["instanceId"] = "0011223355"
    s3["label"] = "13"
    s3["totalWeight"] = 950
    r2["spools"].append(s3)
    f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    rows2 = [m for rows_ in f2.values() for _, m in rows_]
    fp = [m for m in rows2 if "every live spool is missing its gross weight" in m]
    per_spool = [m for m in rows2 if "has no totalWeight" in m]
    if fp:
        bad("pin-every-live-spool-lacks-gross-scope",
            f"a weighed sibling still renders a bar, so the filament-wide row is a false "
            f"statement here: {fp}")
    elif not per_spool:
        bad("pin-every-live-spool-lacks-gross-scope",
            "the weightless spool still contributes nothing and must keep its own row")
    else:
        ok("pin-every-live-spool-lacks-gross-scope")



def case_pin_promotion_marker_at_uncastable():
    """`promotionInFlight.at` is a REQUIRED Date inside the v1.70 marker."""
    # The marker's members are reached by an explicit shape test and nothing
    # else: the nested date sweeps walk spools, not this embedded path. An
    # uncastable value here fails Mongoose's cast, so POST /api/snapshot refuses
    # the whole backup -- and the existing marker cases only ever exercise a
    # MISSING or non-string member, never a present-but-uncastable `at`.
    for at in ("not-a-date", True, {}):
        r = valid_res(promotionInFlight={"token": "tok-1", "at": at})
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        hit = [m for rows_ in f.values() for _, m in rows_
               if "promotionInFlight.at=" in m and "cannot be cast to a Date" in m]
        if not hit:
            bad("pin-promotion-at-uncastable",
                f"promotionInFlight.at={at!r} is a required Date that Mongoose's cast refuses, so "
                f"POST /api/snapshot refuses the ENTIRE backup file -- and the marker also drives "
                f"the promotion resume path")
            break
        if "refuses the ENTIRE backup file" not in hit[0]:
            bad("pin-promotion-at-uncastable",
                f"the row must name the whole-backup consequence: {hit[0]}")
            break
    else:
        ok("pin-promotion-at-uncastable")
    # ...and an epoch-millisecond number is a perfectly castable Date: reporting
    # it would condemn a marker the app restores happily.
    r2 = valid_res(promotionInFlight={"token": "tok-1", "at": 1738368000000})
    f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "promotionInFlight.at=" in m]
    ok("pin-promotion-at-castable-number") if not fp else bad(
        "pin-promotion-at-castable-number",
        f"`new Date(1738368000000)` is valid and Mongoose stores it, so this is a false "
        f"positive: {fp}")



def case_pin_top_level_timestamps_uncastable():
    """`createdAt` / `updatedAt` on the FILAMENT, not on a spool."""
    # `timestamps: true` makes both real Date paths on the parent document. The
    # only other date-cast rows in the corpus are the SPOOL's, which carry a
    # "spool <tag>" prefix -- so the assertion below pins the filament-level
    # form specifically, and the `timestamps: true` clause is what tells the
    # reader the field is schema-declared rather than stray import junk.
    for field in ("createdAt", "updatedAt"):
        r = valid_res(**{field: "not-a-date"})
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        hit = [m for rows_ in f.values() for _, m in rows_
               if f": {field}='not-a-date' cannot be cast to a Date" in m]
        if not hit:
            bad("pin-top-level-timestamp-uncastable",
                f"the filament's own {field} is a declared Date path; an uncastable value there "
                f"makes POST /api/snapshot refuse the ENTIRE backup file, and no spool-level "
                f"check can see it")
            break
        if "timestamps: true" not in hit[0]:
            bad("pin-top-level-timestamp-uncastable",
                f"the row must say the path is schema-declared through `timestamps: true`, or the "
                f"reader cannot tell it from a stray key: {hit[0]}")
            break
    else:
        ok("pin-top-level-timestamp-uncastable")
    # ...and real timestamps must stay silent on both.
    r2 = valid_res(createdAt="2026-02-01T00:00:00Z", updatedAt="2026-02-02T00:00:00Z")
    f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "cannot be cast to a Date" in m]
    ok("pin-top-level-timestamp-valid-silent") if not fp else bad(
        "pin-top-level-timestamp-valid-silent",
        f"ordinary ISO timestamps were condemned: {fp}")



def case_pin_tds_url_not_a_string():
    """tdsUrl holding a non-string at all."""
    # `_bad_tds_url` judges URL GRAMMAR and answers False for a non-string, and
    # tdsUrl is exempt from the text sweep (TEXT_SWEEP_EXEMPT above) precisely
    # so this branch can run -- so with this site gone the shape has NO check
    # anywhere and audits clean.
    r = valid_res(tdsUrl={"a": 1})
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_]
    hit = [m for m in rows if "tdsUrl is dict" in m and "not a string" in m]
    if not hit:
        bad("pin-tds-not-a-string",
            f"a plain object in tdsUrl renders no TDS link (safeHttpUrl gets a non-string) and "
            f"Mongoose's String cast refuses it outright, so the backup fails: {rows}")
    elif "String cast refuses it outright" not in hit[0]:
        bad("pin-tds-not-a-string",
            f"a value whose only toString is Object.prototype's is the DEFINITE cast failure and "
            f"the row must say so: {hit[0]}")
    else:
        ok("pin-tds-not-a-string")
    # the other half of the same row: a value that DOES cast through its own
    # toString still faces the http(s) validator, and the message has to make
    # that weaker claim rather than promising an outright refusal.
    r2 = valid_res(tdsUrl={"_id": "x"})
    f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
    hit2 = [m for rows_ in f2.values() for _, m in rows_ if "tdsUrl is dict" in m]
    if not hit2:
        bad("pin-tds-not-a-string-castable",
            "a populated-ref shape is still not a string, so the detail page renders no link")
    elif "casts it through its own toString" not in hit2[0]:
        bad("pin-tds-not-a-string-castable",
            f"a populated-ref shape casts to its id string and then meets the URL validator -- "
            f"claiming an outright cast refusal would be a false statement: {hit2[0]}")
    else:
        ok("pin-tds-not-a-string-castable")



def case_pin_tds_url_not_http():
    """tdsUrl that IS a string but is not an http(s) URL."""
    # The model runs `new URL(v)` with an http(s) protocol check, so a stored
    # value like this makes POST /api/snapshot refuse the whole backup -- and
    # the detail page silently renders no link, which is the symptom a user
    # actually reports.
    for v in ("ftp://example.com/pla-tds.pdf", "example.com/pla-tds.pdf", "http://"):
        r = valid_res(tdsUrl=v)
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        hit = [m for rows_ in f.values() for _, m in rows_
               if "is not a valid http(s) URL" in m]
        if not hit:
            bad("pin-tds-not-http",
                f"tdsUrl={v!r} fails the model's isValidTdsUrl, so POST /api/snapshot refuses the "
                f"ENTIRE backup file and the detail page renders no link")
            break
        if "the model's validator rejects it" not in hit[0]:
            bad("pin-tds-not-http", f"the row must name the validator as the cause: {hit[0]}")
            break
    else:
        ok("pin-tds-not-http")
    # ...and the shapes `new URL` accepts must stay silent: telling a user to
    # "fix" a link that already works is worse than saying nothing.
    for v in ("http:/example.com/x.pdf", "HTTPS://example.com/x.pdf",
              "  https://example.com/x.pdf  ", "", None):
        r2 = valid_res(tdsUrl=v)
        f2, _ = run({"a": rec(r2, copy.deepcopy(r2))})
        fp = [m for rows_ in f2.values() for _, m in rows_ if "tdsUrl" in m]
        if fp:
            bad("pin-tds-not-http-no-false-positive",
                f"`new URL` accepts {v!r} (special-scheme slash framing, a case-insensitive "
                f"scheme, C0-and-space trimming) and the schema allows null/\"\": {fp}")
            break
    else:
        ok("pin-tds-not-http-no-false-positive")

# --- 14aa. calibration NOZZLE ref integrity: purged, and tombstoned ---------
# `nozzle` is the one calibration ref the schema REQUIRES, so unlike printer /
# bedType a null there is never the supported generic state -- it is a target
# that no longer resolves. The two dead states fail DIFFERENTLY, and the pass
# walks the STORED array on purpose, so all three facts need pinning.
def case_pin_calibration_nozzle_purged():
    # A permanently deleted nozzle populates as null. /calibration cannot
    # diameter-match the row and the Prusa fan-out drops it either way -- but
    # pickRepresentativeCalibration never looks at the nozzle, so with BOTH
    # scope refs null the row is still baked into the single-preset Orca/Bambu
    # export. Same defect, opposite blast radius; the row has to say which.
    for label, generic, phrase in (
        ("scoped", False, "the tuning is genuinely unreachable"),
        ("generic", True, "still BAKED into the single-preset Orca/Bambu export"),
    ):
        r = valid_res()
        r["calibrations"][0]["nozzle"] = None
        if generic:
            r["calibrations"][0]["printer"] = None
            r["calibrations"][0]["bedType"] = None
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in f.values() for _, m in rows_
                if "calibration[0] references a nozzle that no longer exists" in m]
        if not rows:
            bad(f"cal-nozzle-purged-{label}",
                "a calibration whose REQUIRED nozzle ref resolves to null produced no finding "
                "-> /calibration cannot diameter-match the row and the fan-out drops it, so "
                "tuning the user entered is silently not applied and the audit says nothing")
        elif not any(phrase in m for m in rows):
            bad(f"cal-nozzle-purged-{label}",
                f"the {label} case must be described with {phrase!r} -- the two states differ in "
                f"whether the row still reaches the Orca/Bambu export; got: {rows}")
        else:
            ok(f"cal-nozzle-purged-{label}")

    # The ref pass reads the STORED array. A variant that inherits
    # `calibrations` carries the template's array verbatim, so driving this off
    # the resolved read would name one defect once per inheriting child, at an
    # index that child does not store.
    res = valid_res()
    raw = copy.deepcopy(res)
    res["calibrations"][0]["nozzle"] = None
    f2, _ = run({"a": {"res": res, "raw": raw}})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "no longer exists" in m]
    ok("cal-nozzle-purged-stored-keyed") if not fp else bad(
        "cal-nozzle-purged-stored-keyed",
        f"the ref check must be keyed to the document that STORES the array, or an inherited "
        f"calibrations array is re-reported against every variant: {fp}")


def case_pin_calibration_nozzle_tombstoned():
    # NOT the purged consequence. A soft-deleted nozzle populates as a FULL
    # document that still carries its diameter, and neither consumer filters
    # tombstones -- so the tuning is still SERVED and still EXPORTED. What is
    # lost is the ability to edit it: the row falls out of the FilamentForm grid
    # into the orphan list. Saying "unreachable" here would be a false alarm.
    r = valid_res()
    r["calibrations"][0]["nozzle"] = {"_id": "6a1a7bed677d648e9ba9cc01", "name": "0.4 Brass",
                                      "_deletedAt": "2026-01-01T00:00:00.000Z"}
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_
            if "calibration[0] references soft-deleted nozzle" in m]
    if not rows:
        bad("cal-nozzle-tombstoned",
            "a calibration on a soft-deleted nozzle produced no finding -> the row still ships "
            "to every slicer while the user has no way to correct it, and the audit is silent")
    elif not any("'0.4 Brass'" in m for m in rows):
        bad("cal-nozzle-tombstoned",
            f"the row must NAME the tombstoned nozzle -- it is gone from the active catalogue, "
            f"so the name is the only handle the user has on it; got: {rows}")
    elif not any("still serve this tuning" in m for m in rows):
        bad("cal-nozzle-tombstoned",
            f"a tombstoned nozzle still populates with its diameter and neither consumer filters "
            f"it, so the row must say the tuning is still SERVED, not unreachable; got: {rows}")
    else:
        ok("cal-nozzle-tombstoned")

    # a LIVE nozzle is the normal state and must stay silent
    r2 = valid_res()
    r2["calibrations"][0]["nozzle"] = {"_id": "6a1a7bed677d648e9ba9cc01", "name": "0.4 Brass",
                                       "_deletedAt": None}
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "soft-deleted nozzle" in m]
    ok("cal-nozzle-live-silent") if not fp else bad(
        "cal-nozzle-live-silent", f"a live nozzle assignment was flagged as tombstoned: {fp}")


# --- 14ab. a bedTypeTemps row with no usable plate key ----------------------
# `bedType` is schema-required AND is the index into BED_TYPE_KEY_MAP, so a
# missing / blank / off-type key drops that plate's BOTH temperatures out of the
# exported preset with nothing in the UI to show for it.
def case_pin_bed_type_temps_unusable_key():
    for label, mutate in (
        ("missing", lambda bt: bt.pop("bedType", None)),
        ("blank", lambda bt: bt.__setitem__("bedType", "   ")),
        ("non-string", lambda bt: bt.__setitem__("bedType", 5)),
    ):
        r = valid_res()
        mutate(r["bedTypeTemps"][0])
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in f.values() for _, m in rows_
                if "bedTypeTemps[0] has no usable bedType" in m]
        if not rows:
            bad(f"bedtypetemps-unusable-{label}",
                f"a {label} bedType key produced no finding -> the Orca export indexes on that "
                f"exact string, so this plate's temperature AND firstLayerTemperature are "
                f"silently dropped from the preset")
        elif not any("silently dropped" in m for m in rows):
            bad(f"bedtypetemps-unusable-{label}",
                f"the row must state that the temperatures are dropped from the export; "
                f"got: {rows}")
        else:
            ok(f"bedtypetemps-unusable-{label}")

    # `bedType` is deliberately FREE TEXT (it is matched against user-created
    # BedType names), so an unrecognised but non-blank surface must stay silent
    # -- an "expected one of [...]" row would condemn every legitimate plate.
    r2 = valid_res()
    r2["bedTypeTemps"][0]["bedType"] = "Smooth PEI Sheet"
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "bedTypeTemps[0]" in m]
    ok("bedtypetemps-free-text-silent") if not fp else bad(
        "bedtypetemps-free-text-silent",
        f"a legitimate user-named bed surface was flagged: {fp}")


# --- 14ac. a preset label Mongoose cannot cast ------------------------------
# The label branches are a LADDER and each rung has a different consequence. A
# list of STRINGS is the only shape that reaches the cast rung: React flattens
# and renders it (so it is not the crash case), while Mongoose's String cast
# rejects every array outright (so it is not the harmless off-type case either).
def case_pin_preset_label_uncastable_list():
    r = valid_res()
    r["presets"][0]["label"] = ["draft", "fast"]
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in f.values() for _, m in rows_ if "presets[0].label" in m]
    if not rows:
        bad("preset-label-uncastable-list",
            "a list label produced no finding at all -> Mongoose refuses to cast it, so POST "
            "/api/snapshot rejects the ENTIRE backup file and the user finds out at restore time")
    elif not any("Mongoose's String cast refuses it" in m for m in rows):
        bad("preset-label-uncastable-list",
            f"a list label must be described as a CAST FAILURE that refuses the whole backup, "
            f"not as the harmless 'casts it to a string on the next write' case; got: {rows}")
    elif not any("list" in m for m in rows):
        bad("preset-label-uncastable-list",
            f"the row must name the stored type so the user can find it; got: {rows}")
    else:
        ok("preset-label-uncastable-list")


# --- 14ad. temperatures judged against the filament's own declared range -----
# nozzleRangeMin / nozzleRangeMax are exported verbatim
# (nozzle_temperature_range_low/_high), so a value outside them contradicts the
# same preset it ships in. EVERY temperature site feeds the one comparison list,
# which is the whole reason it is a list -- so pin all three.
def case_pin_nozzle_temp_below_declared_min():
    for label, mutate, want in (
        ("top-level", lambda r: r["temperatures"].__setitem__("nozzle", 170),
         "nozzle 170 is BELOW the declared range min 190"),
        ("calibration", lambda r: r["calibrations"][0].__setitem__("nozzleTemp", 175),
         "nozzleTemp 175 is BELOW the declared range min 190"),
        ("preset", lambda r: r["presets"][0]["temperatures"].__setitem__("nozzle", 175),
         "preset[draft] nozzle 175 is BELOW the declared range min 190"),
    ):
        r = valid_res()
        mutate(r)
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in f.values() for _, m in rows_ if want in m]
        ok(f"nozzle-below-range-{label}") if rows else bad(
            f"nozzle-below-range-{label}",
            f"a {label} nozzle temperature under the filament's OWN declared minimum produced no "
            f"row saying so -> the preset exports the range beside a value that contradicts it, "
            f"and nothing in the app compares the two. Expected {want!r}; got: "
            + str([m for rows_ in f.values() for _, m in rows_]))

    # the bound is INCLUSIVE: a value sitting exactly on the declared minimum is
    # in range, and flagging it would fire on every correctly-entered filament
    r2 = valid_res()
    r2["temperatures"]["nozzle"] = r2["temperatures"]["nozzleRangeMin"]
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "BELOW the declared range" in m]
    ok("nozzle-below-range-inclusive") if not fp else bad(
        "nozzle-below-range-inclusive",
        f"a temperature exactly ON the declared minimum is in range: {fp}")


def case_pin_nozzle_temp_above_declared_max():
    for label, mutate, want in (
        ("top-level", lambda r: r["temperatures"].__setitem__("nozzle", 250),
         "nozzle 250 is ABOVE the declared range max 230"),
        ("calibration", lambda r: r["calibrations"][0].__setitem__("nozzleTemp", 245),
         "nozzleTemp 245 is ABOVE the declared range max 230"),
        ("preset", lambda r: r["presets"][0]["temperatures"].__setitem__("nozzle", 245),
         "preset[draft] nozzle 245 is ABOVE the declared range max 230"),
    ):
        r = valid_res()
        mutate(r)
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in f.values() for _, m in rows_ if want in m]
        ok(f"nozzle-above-range-{label}") if rows else bad(
            f"nozzle-above-range-{label}",
            f"a {label} nozzle temperature over the filament's OWN declared maximum produced no "
            f"row saying so -> the slicer is handed a temperature the same preset declares out "
            f"of range. Expected {want!r}; got: "
            + str([m for rows_ in f.values() for _, m in rows_]))

    r2 = valid_res()
    r2["temperatures"]["nozzle"] = r2["temperatures"]["nozzleRangeMax"]
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows_ in f2.values() for _, m in rows_ if "ABOVE the declared range" in m]
    ok("nozzle-above-range-inclusive") if not fp else bad(
        "nozzle-above-range-inclusive",
        f"a temperature exactly ON the declared maximum is in range: {fp}")

# --- 17. the temperature PLAUSIBILITY BANDS, positively ---------------------
# Three sibling checks judge a temperature against nothing but itself: the
# nozzle band, the bed band and the standby ceiling. Every existing assertion
# about temperatures targets the DECLARED-RANGE comparison, so all three could be
# deleted outright and the suite stayed green — and they are the only checks that
# survive a row whose declared range is absent, or so wide it asserts nothing.
def case_pin_nozzle_plausible_band():
    # BOTH ends of the band, because they fail differently: a value under the
    # floor is a unit mix-up or a stale import, a value over the ceiling is a
    # value no hotend in the app's world reaches. The range comparison cannot
    # substitute for either — here the range is satisfied and the value is still
    # impossible.
    for label, over in (("below-floor", {"nozzle": 100, "nozzleRangeMin": 60}),
                        ("above-ceiling", {"nozzle": 520, "nozzleRangeMax": 560})):
        r = valid_res()
        r["temperatures"] = dict(r["temperatures"], **over)
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        band = [m for rows in f.values() for _, m in rows if "plausible band" in m]
        want = f"nozzle {over['nozzle']}C outside the plausible band for PLA"
        if any(want in m and "150-450C" in m for m in band):
            ok(f"nozzle-band-{label}")
        else:
            bad(f"nozzle-band-{label}",
                f"a nozzle temperature of {over['nozzle']}C satisfies its own declared range, so "
                f"the range comparison stays silent — only the type band catches it, and it is "
                f"what the filament exports to every slicer: {band}")
    # The band is chosen BY TYPE, and the message must say so: the floor it
    # reports is the reason the row fired, so a reader who disagrees with the
    # band has to be able to see which one was applied.
    r = valid_res()
    r["temperatures"] = dict(r["temperatures"], nozzle=100, nozzleRangeMin=60)
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    band = [m for rows in f.values() for _, m in rows if "plausible band" in m]
    if any("chosen from this row's own type" in m for m in band):
        ok("nozzle-band-names-its-source")
    else:
        bad("nozzle-band-names-its-source",
            f"the band is derived from `type`, which is stored on every row and can never be "
            f"inherited — the message states it as CONTEXT so the reader can judge the bound, and "
            f"without it the row reads as an unexplained number: {band}")
    # ...and the low-temperature exemption really exempts: a PCL printed at 100C
    # is correct, and a band that fired here would condemn the whole material.
    r2 = valid_res(type="PCL", presets=[], calibrations=[])
    r2["temperatures"] = dict(r2["temperatures"], nozzle=100, nozzleFirstLayer=100,
                              nozzleRangeMin=60, nozzleRangeMax=120, standby=80)
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows in f2.values() for _, m in rows if "plausible band" in m]
    ok("nozzle-band-low-temp-exempt") if not fp else bad(
        "nozzle-band-low-temp-exempt",
        f"LOW_TEMP_TYPES lowers the floor to {A.LOW_TEMP_FLOOR}C precisely so a PCL is not "
        f"reported for printing at its real temperature: {fp}")


def case_pin_bed_temperature_implausible():
    r = valid_res()
    r["temperatures"]["bed"] = 250
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    hit = [m for rows in f.values() for _, m in rows if "bed 250C implausible" in m]
    ok("bed-band-base") if hit else bad(
        "bed-band-base",
        "a bed temperature of 250C exceeds every heated bed the app models and is exported to "
        "the slicer verbatim; nothing else in the audit judges a bed value on its own")
    # The same check has to reach the PER-PLATE overrides, because
    # filamentToOrcaSlicerKeys writes those OVER the base value — an implausible
    # plate temperature is the one that actually reaches the printer.
    r2 = valid_res()
    r2["bedTypeTemps"][0]["temperature"] = 300
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    hit2 = [m for rows in f2.values() for _, m in rows
            if "bedTypeTemps" in m and "300C implausible" in m]
    ok("bed-band-per-plate") if hit2 else bad(
        "bed-band-per-plate",
        "a per-plate override overrides the base bed temperature in the Orca/Bambu export, so a "
        "band that only judges `temperatures.bed` passes the value that is actually used")
    # ...and a hot-but-real bed (PC/PA territory) must stay silent.
    r3 = valid_res()
    r3["temperatures"]["bed"] = 120
    f3, _ = run({"c": rec(r3, copy.deepcopy(r3))})
    fp = [m for rows in f3.values() for _, m in rows if "implausible" in m]
    ok("bed-band-no-false-positive") if not fp else bad(
        "bed-band-no-false-positive",
        f"120C is an ordinary engineering-polymer bed and must not be reported: {fp}")


def case_pin_standby_ceiling():
    for label, val in (("hot", 600), ("negative", -5)):
        r = valid_res()
        r["temperatures"]["standby"] = val
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        hit = [m for rows in f.values() for _, m in rows
               if f"standby {val}C implausible" in m]
        ok(f"standby-band-{label}") if hit else bad(
            f"standby-band-{label}",
            f"`temperatures.standby` is judged by nothing else — it is not in the nozzle band's "
            f"list and has no declared range — so a stored {val} reaches the slicer unreported")
    # Only the CEILING is meaningful: standby is an idle temperature and sits
    # legitimately far below the print window, so a low value must stay silent
    # or every correctly-configured filament reports.
    r2 = valid_res()
    r2["temperatures"]["standby"] = 40
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows in f2.values() for _, m in rows if "standby" in m]
    ok("standby-floor-is-zero") if not fp else bad(
        "standby-floor-is-zero",
        f"a 40C standby is a normal idle temperature, not a defect: {fp}")


# --- 18. per-spool identity and refs, positively ----------------------------
def case_pin_spool_missing_instance_id():
    # Both spellings of ABSENT, because they arrive from different paths: a raw
    # sync copy drops the key entirely, a form/import round-trip writes "".
    for label, over in (("null", None), ("empty", "")):
        r = valid_res()
        r["spools"][0]["instanceId"] = over
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        hit = [m for rows in f.values() for _, m in rows if "has no instanceId" in m]
        if any("selectSpoolForWrite" in m for m in hit):
            ok(f"spool-instanceid-absent-{label}")
        else:
            bad(f"spool-instanceid-absent-{label}",
                f"an absent spool instanceId passes the shape sweep (it is not the wrong TYPE) "
                f"and the cross-record identity pass (which indexes non-empty strings only), so "
                f"with this row gone nothing reports the spool that can no longer be tagged: "
                f"{hit}")
        # ...and it must be ONE diagnosis: the contract checks below it judge a
        # PRESENT id, so a row claiming the id is also malformed would contradict
        # the row just emitted.
        other = [m for rows in f.values() for _, m in rows
                 if "instanceId" in m and "has no instanceId" not in m]
        ok(f"spool-instanceid-one-diagnosis-{label}") if not other else bad(
            f"spool-instanceid-one-diagnosis-{label}",
            f"an ABSENT id was also reported against the present-id contract: {other}")


def case_pin_spool_location_ref_uncastable():
    # The shape a raw sync or an extended-JSON restore actually produces: the
    # whole joined Location, its `_id` still wrapped. `locationId` is never
    # populated by either detail read, so this cannot be a legitimate join.
    r = valid_res()
    r["spools"][0]["locationId"] = {"_id": {"$oid": "6a1a7bef677d648e9ba9cd8c"},
                                    "name": "Dry box"}
    f, _ = run({"a": rec(r, copy.deepcopy(r))})
    hit = [m for rows in f.values() for _, m in rows if "never populated" in m]
    if any("dict" in m and "refuses the ENTIRE backup file" in m for m in hit):
        ok("spool-location-uncastable")
    else:
        bad("spool-location-uncastable",
            f"a non-string `locationId` Mongoose cannot cast fails POST /api/snapshot for the "
            f"WHOLE library, and the dangling-ref branch below cannot see it (it tests strings "
            f"only), so with this row gone the backup simply refuses with no explanation: {hit}")
    # A POPULATED-ref shape whose `_id` is a real id casts CLEANLY (Mongoose reads
    # `value._id` first), so it must NOT be reported — that is the false positive
    # this branch is bounded to avoid.
    r2 = valid_res()
    r2["spools"][0]["locationId"] = {"_id": "6a1a7bef677d648e9ba9cd8c", "name": "Dry box"}
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    fp = [m for rows in f2.values() for _, m in rows if "locationId" in m]
    ok("spool-location-castable-silent") if not fp else bad(
        "spool-location-castable-silent",
        f"Mongoose's ObjectId cast reads `value._id` before rejecting objects, so this restores "
        f"and must stay silent: {fp}")


def case_pin_spool_text_maxlength():
    for fld in A.NESTED_TEXT_MAXLEN["spools"]:
        r = valid_res()
        r["spools"][0][fld] = "L" * (A.MAX_SPOOL_TEXT_LENGTH + 1)
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        hit = [m for rows in f.values() for _, m in rows
               if f"{fld} is {A.MAX_SPOOL_TEXT_LENGTH + 1} UTF-16 units" in m]
        if any(f"{A.MAX_SPOOL_TEXT_LENGTH}-character maxlength" in m for m in hit):
            ok(f"spool-text-maxlength-{fld}")
        else:
            bad(f"spool-text-maxlength-{fld}",
                f"`spools[].{fld}` carries a schema maxlength, and POST /api/snapshot validates "
                f"every document before writing — one over-long value 400s the ENTIRE backup, and "
                f"nothing else in the audit measures a nested string: {hit}")
    # `maxlength` counts UTF-16 code units, so 101 astral characters are 202 to
    # the validator and 101 to Python's len() — measuring in Python would let a
    # backup-breaking value through.
    r2 = valid_res()
    r2["spools"][0]["label"] = "\U0001F600" * 101
    f2, _ = run({"b": rec(r2, copy.deepcopy(r2))})
    hit2 = [m for rows in f2.values() for _, m in rows if "label is 202 UTF-16 units" in m]
    ok("spool-text-maxlength-astral") if hit2 else bad(
        "spool-text-maxlength-astral",
        "101 emoji are 202 UTF-16 units to Mongoose's maxlength and 101 to Python — a len()-based "
        "measurement declares this row clean and the backup still refuses")
    # ...and exactly at the bound is legal, so it must stay silent.
    r3 = valid_res()
    r3["spools"][0]["lotNumber"] = "L" * A.MAX_SPOOL_TEXT_LENGTH
    f3, _ = run({"c": rec(r3, copy.deepcopy(r3))})
    fp = [m for rows in f3.values() for _, m in rows if "UTF-16 units" in m]
    ok("spool-text-maxlength-boundary") if not fp else bad(
        "spool-text-maxlength-boundary",
        f"`maxlength: {A.MAX_SPOOL_TEXT_LENGTH}` ACCEPTS exactly {A.MAX_SPOOL_TEXT_LENGTH}: {fp}")

# --- 17. the spool dry-cycle ledger: `date` is REQUIRED and has NO default ---
# Every other date under a spool is optional or defaulted, so this is the one
# nested date whose plain ABSENCE is fatal. Nothing else in the file looks at
# it: a dry cycle renders from `tempC`/`durationMin`, so the row reads as
# complete on the spool card and the defect only surfaces when the user takes a
# backup -- where it refuses the WHOLE file, not this row.
def case_pin_dry_cycle_date_required():
    def rows_for(cycle):
        rr = valid_res()
        rr["spools"][0]["dryCycles"] = [cycle]
        f, _ = run({rr["_id"]: rec(rr, copy.deepcopy(rr))})
        return [m for rows_ in f.values() for _, m in rows_]

    # Absent and "" are the SAME defect and must both be reported: Mongoose's
    # castDate maps "" to null, and null then fails the required validator.
    for label, cycle in (
            ("absent", {"tempC": 45, "durationMin": 240, "notes": "overnight"}),
            ("empty-string", {"tempC": 45, "durationMin": 240, "date": "",
                              "notes": "overnight"})):
        hits = [m for m in rows_for(cycle) if "dryCycle has no date" in m]
        if not hits:
            return bad("pin-dry-cycle-date-required",
                       f"a dry cycle with an {label} date was reported as CLEAN -- the schema "
                       f"REQUIRES it, so POST /api/snapshot refuses the entire backup file and "
                       f"nothing tells the user which row did it")
        if not any("spool 0011223344" in m for m in hits):
            return bad("pin-dry-cycle-date-required",
                       f"the row does not name the spool it belongs to, so the user cannot find "
                       f"the offending cycle on a filament with several spools: {hits}")
    ok("pin-dry-cycle-date-required")


# --- 17b. ...and a PRESENT dry-cycle date Mongoose cannot cast ---------------
# Presence alone is not the property: a value the cast REFUSES fails the restore
# identically, and the row looks populated to every other check in the file.
def case_pin_dry_cycle_date_castable():
    def rows_for(dv):
        rr = valid_res()
        rr["spools"][0]["dryCycles"] = [{"tempC": 45, "durationMin": 240, "date": dv,
                                         "notes": "overnight"}]
        f, _ = run({rr["_id"]: rec(rr, copy.deepcopy(rr))})
        return [m for rows_ in f.values() for _, m in rows_]

    hits = [m for m in rows_for("not-a-date")
            if "dryCycle date='not-a-date' cannot be cast to a Date" in m]
    if not hits:
        return bad("pin-dry-cycle-date-castable",
                   "an uncastable dry-cycle date was reported as clean -- `date` is REQUIRED on "
                   "the dry-cycle subdocument, so POST /api/snapshot refuses the whole backup "
                   "file on it while the spool card still renders the cycle as complete")
    if not any("refuses the ENTIRE backup file" in m for m in hits):
        return bad("pin-dry-cycle-date-castable",
                   f"the row does not state the consequence that makes it worth acting on: "
                   f"{hits}")
    # ...and it must stay SILENT on a date V8 accepts. castDate rolls
    # "2026-02-30" over to March 2nd, so condemning it would be a false alarm on
    # a value the app stores happily -- the one thing this script must never do.
    fp = [m for m in rows_for("2026-02-30") if "dryCycle date=" in m]
    if fp:
        return bad("pin-dry-cycle-date-castable",
                   f"`new Date('2026-02-30')` is VALID in V8 (it rolls over), so this backup "
                   f"restores fine and the row is a false alarm: {fp}")
    ok("pin-dry-cycle-date-castable")


# --- 17c. a usage entry's `source` must be one of the schema's enum values ---
# Not a cast error and not a restore failure: `source` decides whether analytics
# counts the entry AT ALL (it filters on exact "manual"), so a typo, an omission
# or an explicit null silently removes real usage from the manual usage and cost
# totals while the spool's own ledger still lists it.
def case_pin_usage_source_enum():
    def rows_for(entry):
        rr = valid_res()
        rr["spools"][0]["usageHistory"] = [entry]
        f, _ = run({rr["_id"]: rec(rr, copy.deepcopy(rr))})
        return [m for rows_ in f.values() for _, m in rows_]

    base = {"grams": 30, "debitedGrams": 30, "date": "2026-02-01", "jobLabel": "bracket"}
    for shown, entry in (
            ("'manuel'", dict(base, source="manuel")),   # a typo casts perfectly
            ("absent", dict(base)),                      # legacy row, predates the field
            ("None", dict(base, source=None))):          # written past the default
        want = f"usage source={shown} is not one of"
        if not [m for m in rows_for(entry) if want in m]:
            return bad("pin-usage-source-enum",
                       f"a usage entry with source={shown} was reported as clean -- analytics "
                       f"counts only exact 'manual', so those grams and their cost drop out of "
                       f"the totals with the entry still visible on the spool")
    # Every value the schema DOES declare must stay silent, or the report buries
    # the real rows under one for every healthy entry in the library.
    for src in sorted(A.USAGE_SOURCES):
        fp = [m for m in rows_for(dict(base, source=src)) if "usage source=" in m]
        if fp:
            return bad("pin-usage-source-enum",
                       f"source={src!r} is in the schema's own enum and must not be reported: "
                       f"{fp}")
    ok("pin-usage-source-enum")


# --- 17d. a usage entry's own `date`, with the consequence that is TRUE ------
# `date` is DEFAULTED, so a restore fills a missing one in and the loss is in
# ANALYTICS, which builds `new Date(u.date)` and skips the entry on NaN. The
# consequence DEPENDS on `source` -- analytics counts only "manual", so telling
# the owner of a job entry its grams are missing from every total would send
# them hunting a shortfall that is not there.
def case_pin_usage_entry_date():
    def rows_for(entry):
        rr = valid_res()
        rr["spools"][0]["usageHistory"] = [entry]
        f, _ = run({rr["_id"]: rec(rr, copy.deepcopy(rr))})
        return [m for rows_ in f.values() for _, m in rows_]

    base = {"grams": 30, "debitedGrams": 30, "jobLabel": "bracket"}
    for label, entry, what, cons in (
            ("manual/uncastable",
             dict(base, source="manual", date="not-a-date"),
             "usage entry date='not-a-date' cannot be cast to a Date",
             "missing from every total"),
            ("job/absent",
             dict(base, source="job", jobId="6a1a7bef677d648e9ba9cd77"),
             "usage entry has no date",
             "through their PrintHistory row"),
            ("nfc/uncastable",
             dict(base, source="nfc", date={}),
             "usage entry date={} cannot be cast to a Date",
             "never in the totals")):
        hits = [m for m in rows_for(entry) if what in m]
        if not hits:
            return bad("pin-usage-entry-date",
                       f"[{label}] a ledger entry whose date analytics cannot read was reported "
                       f"as clean -- the spool's own usage list still shows the grams, so the "
                       f"mismatch against the totals has no visible cause")
        if not any(cons in m for m in hits):
            return bad("pin-usage-entry-date",
                       f"[{label}] the row states the wrong consequence for source="
                       f"{entry.get('source')!r}, which points the reader at a shortfall that "
                       f"does not exist: {hits}")
    ok("pin-usage-entry-date")


# --- 17e. a usage entry with no `grams` -------------------------------------
# `grams` is schema-REQUIRED, and the numeric bounds sweep skips a None -- so
# nothing else in the file sees this. Export and analytics both read the missing
# value as zero, which is exactly why it is invisible: the entry still renders,
# it just stops contributing.
def case_pin_usage_entry_grams_required():
    def rows_for(entry):
        rr = valid_res()
        rr["spools"][0]["usageHistory"] = [entry]
        f, _ = run({rr["_id"]: rec(rr, copy.deepcopy(rr))})
        return [m for rows_ in f.values() for _, m in rows_]

    base = {"source": "manual", "date": "2026-02-01", "jobLabel": "bracket"}
    for label, entry in (("an absent", dict(base)),
                         ("an explicitly null", dict(base, grams=None))):
        if not [m for m in rows_for(entry) if "usage entry has no grams" in m]:
            return bad("pin-usage-entry-grams-required",
                       f"a usage entry with {label} grams was reported as clean -- export and "
                       f"analytics read it as zero, so the entry silently vanishes from the "
                       f"usage totals while still appearing in the spool's ledger")
    # 0 is a RECORDED value, not an absence: the check tests `is None`, and a
    # falsy test would invent a defect on a legitimate zero-gram entry.
    fp = [m for m in rows_for(dict(base, grams=0)) if "has no grams" in m]
    ok("pin-usage-entry-grams-required") if not fp else bad(
        "pin-usage-entry-grams-required",
        f"grams=0 is a real stored value, not an absence: {fp}")


# --- 17f. `debitedGrams` is bounded SEMANTICALLY, not by the schema ----------
# The model declares no min/max on it, so an implausible value is NOT a schema
# violation and the row must not claim one -- but it is still corrupt, and the
# API would accept it, so no other surface in the app will ever show it.
def case_pin_usage_debited_grams_semantic_bound():
    def rows_for(entry):
        rr = valid_res()
        rr["spools"][0]["usageHistory"] = [entry]
        f, _ = run({rr["_id"]: rec(rr, copy.deepcopy(rr))})
        return [m for rows_ in f.values() for _, m in rows_]

    base = {"grams": 30, "source": "manual", "date": "2026-02-01", "jobLabel": "bracket"}
    for val in (-5, 5000000):
        hits = [m for m in rows_for(dict(base, debitedGrams=val))
                if f"usage debitedGrams={val} is implausible" in m]
        if not hits:
            return bad("pin-usage-debited-grams-semantic-bound",
                       f"debitedGrams={val} was reported as clean -- there is no schema bound on "
                       f"this field, so the API accepts it and nothing else in the app will ever "
                       f"surface it")
        if not any("no schema bound on this field" in m for m in hits):
            return bad("pin-usage-debited-grams-semantic-bound",
                       f"the row must say the bound is SEMANTIC, or it claims a schema violation "
                       f"the model does not declare: {hits}")
    # The bound is INCLUSIVE -- a value sitting exactly at the cap is not corrupt
    # and reporting it would be a false alarm on the largest legitimate entry.
    fp = [m for m in rows_for({"grams": 1000000, "debitedGrams": 1000000, "source": "manual",
                               "date": "2026-02-01", "jobLabel": "bracket"})
          if "debitedGrams" in m]
    ok("pin-usage-debited-grams-semantic-bound") if not fp else bad(
        "pin-usage-debited-grams-semantic-bound",
        f"1,000,000 g is the cap itself and lies inside the bound: {fp}")

# --- 30. missing core spec: the three EFFECTIVE-absence rows ----------------
# The block guarded by `if not is_template:` emits one row per absent core
# field, and a mutation sweep deleted each of the three add() calls with the
# suite still green -- nothing proved any of them fires. They are pinned one
# per function so a deletion names exactly which field stopped reporting.
#
# All three also carry the `_where_to_set` suffix on a VARIANT, which is the
# only part of the row that tells the reader the repair belongs on the TEMPLATE
# (one write for the whole colour family) rather than here. The template itself
# is exempt -- a template legitimately declares no print temperature -- so each
# case asserts that the TEMPLATE's own fid is NOT reported, which would fail if
# a future edit dropped the `is_template` guard and started dumping a spurious
# row on every product line.
_MC_TID = "6a1a7c00677d648e9ba9d011"

_MC_VID = "6a1a7c00677d648e9ba9d012"



def _mc_standalone(mutate):
    """A lone filament missing exactly one core field."""
    r = valid_res(_id="6a1a7c00677d648e9ba9d010", instanceId="1111111111")
    mutate(r)
    return {"6a1a7c00677d648e9ba9d010": rec(r, copy.deepcopy(r))}



def _mc_family(mutate):
    """A template + one variant, BOTH missing the same core field.

    Missing on both sides is the shape the emit site describes: nothing is
    inherited, so `_inh_blame` cannot attribute it and the row has to say
    where to set it outright.
    """
    t = valid_res(_id=_MC_TID, name="Prusament PLA", parentId=None, spools=[],
                  color=None, colorName=None, totalWeight=None,
                  lowStockThreshold=None, instanceId="tttttttttt")
    mutate(t)
    k = valid_res(_id=_MC_VID, name="Prusament PLA — Blue", parentId=_MC_TID,
                  instanceId="kkkkkkkkkk")
    mutate(k)
    return {_MC_TID: rec(t, copy.deepcopy(t)), _MC_VID: rec(k, copy.deepcopy(k))}



def _mc_rows(records, needle, topology=None):
    f, _ = run(records, topology=topology)
    return [(fid, m) for rows in f.values() for fid, m in rows if needle in m]



def _drop_temp(key):
    def mutate(doc):
        doc["temperatures"] = {k: v for k, v in doc["temperatures"].items() if k != key}
    return mutate



def _pin_missing_core(label, needle, mutate, consequence):
    """Shared body for the three missing-core sites."""
    got = _mc_rows(_mc_standalone(mutate), needle)
    if not got:
        bad(f"missing-core-{label}", consequence)
    else:
        ok(f"missing-core-{label}")

    # on a VARIANT the row must name the template as the place to set it
    fam = _mc_rows(_mc_family(mutate), needle, topology={_MC_TID: True})
    on_variant = [m for fid, m in fam if fid == _MC_VID]
    on_template = [m for fid, m in fam if fid == _MC_TID]
    if not on_variant:
        bad(f"missing-core-{label}-variant",
            f"a VARIANT whose template also lacks this field was not reported, so the gap is "
            f"invisible on the only row that can print with it; expected {needle!r}")
    elif "inheritable" not in on_variant[0] or "Prusament PLA" not in on_variant[0]:
        bad(f"missing-core-{label}-variant",
            f"the row must name the TEMPLATE as the place to set an inheritable field -- setting "
            f"it on the variant pins the value off the template for that colour only; got: "
            f"{on_variant}")
    else:
        ok(f"missing-core-{label}-variant")
    if on_template:
        bad(f"missing-core-{label}-template-exempt",
            f"a TEMPLATE legitimately declares no core spec of its own, and reporting it sends "
            f"the user to edit the one row where the field is not required; got: {on_template}")
    else:
        ok(f"missing-core-{label}-template-exempt")



def case_pin_missing_nozzle_temperature():
    _pin_missing_core(
        "nozzle", "no nozzle temperature", _drop_temp("nozzle"),
        "a filament with no effective nozzle temperature produced no finding -- it exports to "
        "every slicer with no print temperature, and the user discovers it at the print head")



def case_pin_missing_bed_temperature():
    _pin_missing_core(
        "bed", "no bed temperature", _drop_temp("bed"),
        "a filament with no effective bed temperature produced no finding -- the slicer preset "
        "carries no bed temperature and the first layer has nothing to stick to")



def case_pin_missing_density():
    def drop_density(doc):
        doc["density"] = None

    _pin_missing_core(
        "density", "no density", drop_density,
        "a filament with no effective density produced no finding -- every gram/length and "
        "remaining-weight calculation that divides by it is silently wrong or absent")


# --- 31. a carrier whose variants are ALL TRASHED ---------------------------
# `is_template` is derived from LIVE children, so this row audits as an ordinary
# standalone and every template check below it is skipped -- while each of its
# trashed variants answers 409 parent_must_be_template_first on restore (#1103).
# Nothing else in the report says the family is stuck, so if this add() goes the
# user is left with an unrestorable family and a clean bill of health.



# --- 31. a carrier whose variants are ALL TRASHED ---------------------------
# `is_template` is derived from LIVE children, so this row audits as an ordinary
# standalone and every template check below it is skipped -- while each of its
# trashed variants answers 409 parent_must_be_template_first on restore (#1103).
# Nothing else in the report says the family is stuck, so if this add() goes the
# user is left with an unrestorable family and a clean bill of health.
def case_pin_trashed_variant_family_is_stuck():
    fid = "6a1a7c00677d648e9ba9d013"
    r = valid_res(_id=fid, name="Legacy Family", instanceId="2222222222",
                  _hasTrashedVariants=True)          # spools + colour from the fixture
    got = _mc_rows({fid: rec(r, copy.deepcopy(r))}, "has TRASHED variants and still carries")
    if not got:
        return bad("trashed-variant-family-stuck",
                   "a parent whose only variants are TRASHED, still carrying promotable state, "
                   "produced no finding -- it is not `is_template` so every template check is "
                   "skipped, and restore answers 409 parent_must_be_template_first for every one "
                   "of those variants with nothing in the report explaining why")
    msg = got[0][1]
    if "1 spool(s)" not in msg:
        bad("trashed-variant-family-carried",
            f"the row must name WHAT the parent carries -- that is the list the user has to clear "
            f"or promote -- and the spool count is the part promotion preserves; got: {msg}")
    elif "parent_must_be_template_first" not in msg:
        bad("trashed-variant-family-consequence",
            f"the row must name the 409 the user will actually hit on restore, or it reads as "
            f"cosmetic tidiness; got: {msg}")
    else:
        ok("trashed-variant-family-stuck")

    # a LIVE parent takes the ordinary template rows instead, not this one
    tid, vid = "6a1a7c00677d648e9ba9d014", "6a1a7c00677d648e9ba9d015"
    t = valid_res(_id=tid, name="Live Family", instanceId="3333333333",
                  _hasTrashedVariants=True)
    v = valid_res(_id=vid, name="Live Family — Blue", parentId=tid, instanceId="4444444444")
    dup = _mc_rows({tid: rec(t, copy.deepcopy(t)), vid: rec(v, copy.deepcopy(v))},
                   "has TRASHED variants and still carries")
    ok("trashed-variant-live-parent-exempt") if not dup else bad(
        "trashed-variant-live-parent-exempt",
        f"a parent with LIVE variants is already reported by the template block; adding this row "
        f"on top double-reports the same state with a different remedy: {dup}")


# --- 32. a row that is BOTH a variant and a parent ---------------------------
# No API path produces this shape, so it arrives by raw sync copy / restore /
# direct DB edit -- and it silently disables the app's own repair for every
# other template row on the same filament (`/promote` refuses with 400
# not_a_template). Without this add() the reader is handed remedies that cannot
# run, with no indication why.



# --- 32. a row that is BOTH a variant and a parent ---------------------------
# No API path produces this shape, so it arrives by raw sync copy / restore /
# direct DB edit -- and it silently disables the app's own repair for every
# other template row on the same filament (`/promote` refuses with 400
# not_a_template). Without this add() the reader is handed remedies that cannot
# run, with no indication why.
def case_pin_nested_template_shape():
    gid, tid, vid = ("6a1a7c00677d648e9ba9d016", "6a1a7c00677d648e9ba9d017",
                     "6a1a7c00677d648e9ba9d018")
    g = valid_res(_id=gid, name="Grandparent", parentId=None, spools=[], color=None,
                  colorName=None, totalWeight=None, lowStockThreshold=None,
                  instanceId="5555555555")
    mid = valid_res(_id=tid, name="Mid", parentId=gid, spools=[], color=None,
                    colorName=None, totalWeight=None, lowStockThreshold=None,
                    instanceId="6666666666")
    leaf = valid_res(_id=vid, name="Leaf", parentId=tid, instanceId="7777777777")
    got = _mc_rows({gid: rec(g, copy.deepcopy(g)), tid: rec(mid, copy.deepcopy(mid)),
                    vid: rec(leaf, copy.deepcopy(leaf))},
                   "also carries parentId")
    if not got:
        return bad("nested-template-shape",
                   "a row that is BOTH a variant and a parent produced no finding -- it is a shape "
                   "createVariantGated refuses and no API path can produce, and it makes "
                   "/promote answer 400 not_a_template so every other remedy in this report is "
                   "unavailable on that filament")
    fid, msg = got[0]
    if fid != tid:
        bad("nested-template-attribution",
            f"the row must be attributed to the middle row that holds the bad parentId, not to "
            f"{fid} -- that is the document the user has to PUT; got: {msg}")
    elif "Grandparent" not in msg:
        bad("nested-template-names-grandparent",
            f"the row must name the grandparent, because unlinking is the repair and the user has "
            f"to copy down anything this row was inheriting from it first; got: {msg}")
    elif "not_a_template" not in msg:
        bad("nested-template-names-refusal",
            f"the row must say /promote refuses this shape, or the reader tries the remedy the "
            f"rows below prescribe and gets an unexplained 400; got: {msg}")
    else:
        ok("nested-template-shape")

    # an ordinary template must NOT collect this row
    t2, v2 = "6a1a7c00677d648e9ba9d019", "6a1a7c00677d648e9ba9d01a"
    a = valid_res(_id=t2, name="Flat", parentId=None, spools=[], color=None, colorName=None,
                  totalWeight=None, lowStockThreshold=None, instanceId="8888888888")
    b = valid_res(_id=v2, name="Flat — Blue", parentId=t2, instanceId="9999999999")
    fp = _mc_rows({t2: rec(a, copy.deepcopy(a)), v2: rec(b, copy.deepcopy(b))},
                  "also carries parentId")
    ok("nested-template-flat-exempt") if not fp else bad(
        "nested-template-flat-exempt",
        f"a normal template has no parentId and must not be accused of the nested shape -- the "
        f"row tells the user to PUT parentId:null on a row that has none: {fp}")


# --- 33. a template still carrying a TEMPLATE_STRIP field --------------------
# The v1.70 model says a template holds no colour and no inventory, and this is
# the row that reports the leftovers. Its REMEDY is chosen from the parent's
# whole state, and getting that wrong destroys data -- prescribing a null where
# promotion would have MOVED the value onto a variant. So both branches of the
# choice are pinned through the one emit site.



# --- 33. a template still carrying a TEMPLATE_STRIP field --------------------
# The v1.70 model says a template holds no colour and no inventory, and this is
# the row that reports the leftovers. Its REMEDY is chosen from the parent's
# whole state, and getting that wrong destroys data -- prescribing a null where
# promotion would have MOVED the value onto a variant. So both branches of the
# choice are pinned through the one emit site.
def case_pin_template_still_carries_field():
    tid, vid = "6a1a7c00677d648e9ba9d01b", "6a1a7c00677d648e9ba9d01c"

    def family(**over):
        # a CLEAN template: none of TEMPLATE_STRIP, no spools. `over` then puts
        # back exactly one leftover, so each assertion below is isolated.
        base = {"_id": tid, "name": "Family", "parentId": None, "spools": [],
                "color": None, "colorName": None, "totalWeight": None,
                "lowStockThreshold": None, "instanceId": "aaaaaaaaa1"}
        base.update(over)
        t = valid_res(**base)
        v = valid_res(_id=vid, name="Family — Blue", parentId=tid, instanceId="bbbbbbbbb1")
        return {tid: rec(t, copy.deepcopy(t)), vid: rec(v, copy.deepcopy(v))}

    # 1. promote_runs is TRUE (a stored colour) -> the remedy must be promotion,
    #    which MOVES the value onto a new variant.
    got = _mc_rows(family(color="#ff0000"), "still carries color=")
    if not got:
        bad("template-carries-colour",
            "a TEMPLATE still holding its own colour produced no finding -- v1.70 says a template "
            "is colourless, and the leftover renders as the product line's colour across the app")
    elif "Convert to template" not in got[0][1]:
        bad("template-carries-colour-remedy",
            f"with promotable state present the remedy is promotion, which MOVES the value onto a "
            f"new variant; prescribing anything else here loses it: {got[0][1]}")
    else:
        ok("template-carries-colour")

    # 2. promote_runs is FALSE (lowStockThreshold alone is not a promotion
    #    trigger) -> promotion would move nothing, so the null IS the remedy.
    got = _mc_rows(family(lowStockThreshold=100), "still carries lowStockThreshold=")
    if not got:
        bad("template-carries-threshold",
            "a TEMPLATE still holding a low-stock threshold produced no finding -- it alarms "
            "forever against an empty template while the variants holding the rolls have none")
    elif "nothing_to_convert" not in got[0][1]:
        bad("template-carries-threshold-remedy",
            f"a threshold alone does not satisfy parentPromotionState, so /promote answers 400 "
            f"nothing_to_convert and the row must say so rather than sending the user in a "
            f"circle: {got[0][1]}")
    else:
        ok("template-carries-threshold")

    # a template carrying NOTHING must stay silent
    fp = _mc_rows(family(), "(TEMPLATE): still carries")
    ok("template-carries-clean-exempt") if not fp else bad(
        "template-carries-clean-exempt",
        f"a clean template carries none of TEMPLATE_STRIP and must produce no row: {fp}")

# --- 17. the template / inheritance-shape block, pinned positively -----------
# Every emit site below survived a delete-the-statement sweep with the suite
# green: nothing proved they fire at all. They are the block that answers "is
# this row still a legal member of a v1.70 family?", and each one reports a
# state the app itself cannot repair once it is wrong, so a silent check here is
# the worst kind — the report reads clean and the family stays broken.
#
# The helpers build a HEALTHY template/variant pair (the same construction
# case_valid uses for `valid-family`, hoisted so a pin can be introduced one
# field at a time). A healthy variant STORES nothing it inherits, so any single
# re-added value is the only pin in the fixture and the assertion below can be
# exact rather than a count.
_PIN_INHERITED = (list(A.PIN_CHECK_FIELDS) + list(A.PIN_CHECK_ARRAYS)
                  + [f"temperatures.{s}" for s in A.PIN_CHECK_TEMPS]
                  + ["compatibleNozzles"])



def _pin_strip_inheritables(raw):
    """Turn a copy of a resolved read into the STORED read of a healthy variant.

    resolveFilament's sentinel is `null`/`""` for scalars and an EMPTY array for
    the whole-array fields, so "inherits it" means "does not store it" — which is
    exactly what the pinned block reports the absence of.
    """
    for f in A.PIN_CHECK_FIELDS:
        raw.pop(f, None)
    for f in A.PIN_CHECK_ARRAYS:
        raw[f] = []
    raw["temperatures"] = {k: v for k, v in raw["temperatures"].items()
                           if k not in A.PIN_CHECK_TEMPS}
    raw["settings"] = {}
    raw["tdsUrl"] = None
    raw["inherits"] = None
    raw["compatibleNozzles"] = []
    return raw



_PIN_TPL = "6a1a7c11677d648e9ba9e001"

_PIN_VAR = "6a1a7c11677d648e9ba9e002"



def _pin_family(pin=None):
    """A clean template + fully-inheriting variant; `pin(res, raw)` adds ONE pin."""
    tpl = valid_res(_id=_PIN_TPL, name="PLA Family", parentId=None, spools=[],
                    color=None, colorName=None, totalWeight=None,
                    lowStockThreshold=None, instanceId="tttttttttt")
    var = valid_res(_id=_PIN_VAR, name="PLA Family — Blue", parentId=_PIN_TPL,
                    instanceId="kkkkkkkkkk")
    var["_inherited"] = list(_PIN_INHERITED)
    vraw = _pin_strip_inheritables(copy.deepcopy(var))
    if pin:
        pin(var, vraw)
    return ({_PIN_TPL: rec(tpl, copy.deepcopy(tpl)),
             _PIN_VAR: {"res": var, "raw": vraw}},
            {_PIN_TPL: True})



def _pin_rows(records, topology=None):
    findings, _ = run(records, topology=topology)
    return [(fid, m) for rows_ in findings.values() for fid, m in rows_]


# --- 17a. a TEMPLATE still holding physical rolls ---------------------------
# The one row in the template block whose remedy cannot be guessed: POST
# .../spools onto a template is refused (template_no_spools) and a PUT carrying
# `spools: []` is ACCEPTED and DELETES the rolls, so the obvious "clear it" move
# destroys inventory. Only /promote relocates them, `_id` and `instanceId`
# intact, which is what keeps printed QR labels and written NFC tags resolving.



# --- 17a. a TEMPLATE still holding physical rolls ---------------------------
# The one row in the template block whose remedy cannot be guessed: POST
# .../spools onto a template is refused (template_no_spools) and a PUT carrying
# `spools: []` is ACCEPTED and DELETES the rolls, so the obvious "clear it" move
# destroys inventory. Only /promote relocates them, `_id` and `instanceId`
# intact, which is what keeps printed QR labels and written NFC tags resolving.
def case_pin_template_still_holds_spools():
    tpl_id, var_id = "6a1a7c22677d648e9ba9e101", "6a1a7c22677d648e9ba9e102"
    tpl = valid_res(_id=tpl_id, name="PETG Family", parentId=None, color=None,
                    colorName=None, totalWeight=None, lowStockThreshold=None,
                    instanceId="1111111111")
    # the legacy shape: a pre-v1.70 parent that kept its own roll
    tpl["spools"] = [dict(copy.deepcopy(tpl["spools"][0]),
                          _id="6a1a7c22677d648e9ba9e1a1",
                          instanceId="2222222222", label="90")]
    var = valid_res(_id=var_id, name="PETG Family — Green", parentId=tpl_id,
                    instanceId="3333333333")
    var["_inherited"] = list(_PIN_INHERITED)
    vraw = _pin_strip_inheritables(copy.deepcopy(var))
    vraw["spools"] = [dict(copy.deepcopy(var["spools"][0]),
                           _id="6a1a7c22677d648e9ba9e1a2",
                           instanceId="4444444444", label="91")]
    var["spools"] = copy.deepcopy(vraw["spools"])
    rows = _pin_rows({tpl_id: rec(tpl, copy.deepcopy(tpl)),
                      var_id: {"res": var, "raw": vraw}}, {tpl_id: True})
    hit = [m for fid, m in rows
           if fid == tpl_id
           and "(TEMPLATE): holds 1 spool(s) — inventory belongs on a variant" in m]
    if not hit:
        bad("pin-template-holds-spools",
            "a TEMPLATE still holding a physical roll produced no finding — the rolls are "
            "unreachable from the app (POST .../spools onto a template is refused) and the "
            "obvious cleanup, PUT spools:[], DELETES them:\n    "
            + "\n    ".join(m for _, m in rows))
    elif "/promote" not in hit[0] or "deletes the rolls" not in hit[0]:
        bad("pin-template-holds-spools",
            f"the row was emitted without naming /promote as the ONLY move that preserves "
            f"the rolls, so the reader is left with PUT spools:[] — which deletes them: {hit[0]}")
    else:
        ok("pin-template-holds-spools")
    # ...and the VARIANT holding a roll is the INTENDED state — reporting it too
    # would make the real finding unfindable in a real library.
    fp = [m for fid, m in rows if fid == var_id and "inventory belongs on a variant" in m]
    ok("pin-variant-may-hold-spools") if not fp else bad(
        "pin-variant-may-hold-spools",
        f"a variant holding its own roll — where inventory BELONGS — was reported: {fp}")


# --- 17b. parentId pointing at its own row ----------------------------------
# resolveFilament reads the parent by id; a self-link resolves to the row itself,
# so nothing is inherited while `_inherited` and the detail page still present it
# as a variant. It is also unproducible through the write API, so it only ever
# arrives by sync copy / restore / direct edit — the cases nothing else catches.



# --- 17b. parentId pointing at its own row ----------------------------------
# resolveFilament reads the parent by id; a self-link resolves to the row itself,
# so nothing is inherited while `_inherited` and the detail page still present it
# as a variant. It is also unproducible through the write API, so it only ever
# arrives by sync copy / restore / direct edit — the cases nothing else catches.
def case_pin_parent_points_at_itself():
    fid_self = "6a1a7c33677d648e9ba9e201"
    row = valid_res(_id=fid_self, name="Loop PLA", parentId=fid_self, spools=[],
                    color=None, colorName=None, totalWeight=None,
                    lowStockThreshold=None, instanceId="5555555555")
    rows = _pin_rows({fid_self: rec(row, copy.deepcopy(row))})
    hit = [m for fid, m in rows
           if fid == fid_self and "parentId points at itself" in m]
    if not hit:
        bad("pin-self-parent",
            "a row whose parentId is its OWN _id produced no self-link finding — it reads as "
            "a normal variant everywhere while inheriting nothing:\n    "
            + "\n    ".join(m for _, m in rows))
    elif "nothing can inherit" not in hit[0]:
        bad("pin-self-parent",
            f"the self-link row no longer states the consequence, so a reader cannot tell it "
            f"from a cosmetic id oddity: {hit[0]}")
    else:
        ok("pin-self-parent")
    # a legitimate parent link must NOT be read as a self-link
    fp = [m for _, m in _pin_rows(*_pin_family()) if "points at itself" in m]
    ok("pin-self-parent-negative") if not fp else bad(
        "pin-self-parent-negative",
        f"a healthy variant of a DIFFERENT template was reported as self-parented: {fp}")


# --- 17c. a parent that is itself a variant (nested inheritance) -------------
# resolveFilament walks exactly ONE level. A grandchild therefore resolves only
# what its immediate parent STORES — every value that parent inherits from the
# grandparent reads as empty here, while the chain looks complete in the UI.



# --- 17c. a parent that is itself a variant (nested inheritance) -------------
# resolveFilament walks exactly ONE level. A grandchild therefore resolves only
# what its immediate parent STORES — every value that parent inherits from the
# grandparent reads as empty here, while the chain looks complete in the UI.
def case_pin_parent_is_itself_a_variant():
    gp, pa, ch = ("6a1a7c44677d648e9ba9e301", "6a1a7c44677d648e9ba9e302",
                  "6a1a7c44677d648e9ba9e303")
    grand = valid_res(_id=gp, name="ASA Family", parentId=None, spools=[], color=None,
                      colorName=None, totalWeight=None, lowStockThreshold=None,
                      instanceId="6666666666")
    mid = valid_res(_id=pa, name="ASA Family — Grey", parentId=gp, spools=[], color=None,
                    colorName=None, totalWeight=None, lowStockThreshold=None,
                    instanceId="7777777777")
    mid["_inherited"] = list(_PIN_INHERITED)
    mid_raw = _pin_strip_inheritables(copy.deepcopy(mid))
    kid = valid_res(_id=ch, name="ASA Family — Grey Matte", parentId=pa,
                    instanceId="8888888888")
    kid["_inherited"] = list(_PIN_INHERITED)
    kid_raw = _pin_strip_inheritables(copy.deepcopy(kid))
    kid_raw["spools"] = [dict(copy.deepcopy(kid["spools"][0]),
                              _id="6a1a7c44677d648e9ba9e3a1",
                              instanceId="9999999999", label="77")]
    kid["spools"] = copy.deepcopy(kid_raw["spools"])
    rows = _pin_rows({gp: rec(grand, copy.deepcopy(grand)),
                      pa: {"res": mid, "raw": mid_raw},
                      ch: {"res": kid, "raw": kid_raw}}, {gp: True, pa: True})
    hit = [m for fid, m in rows
           if fid == ch and "is itself a variant (nested inheritance)" in m]
    if not hit:
        bad("pin-nested-inheritance",
            "a two-level parent chain produced no finding against the GRANDCHILD — every value "
            "its parent inherits reads as empty on this row and in every slicer export, while "
            "the family looks complete:\n    " + "\n    ".join(m for _, m in rows))
    elif "only one level resolves" not in hit[0] or "ASA Family — Grey" not in hit[0]:
        bad("pin-nested-inheritance",
            f"the nested-inheritance row no longer names the offending parent and what is lost, "
            f"so it cannot be acted on: {hit[0]}")
    else:
        ok("pin-nested-inheritance")
    # a ONE-level family is the supported shape and must stay silent
    fp = [m for _, m in _pin_rows(*_pin_family()) if "nested inheritance" in m]
    ok("pin-nested-negative") if not fp else bad(
        "pin-nested-negative",
        f"an ordinary template/variant pair was reported as nested inheritance: {fp}")


# --- 17d. a scalar stored identically to the template ------------------------
# A pin is invisible: the variant renders the right value today, and keeps
# rendering it after the template is corrected, so a library-wide fix silently
# skips exactly the rows that stored a copy.



# --- 17d. a scalar stored identically to the template ------------------------
# A pin is invisible: the variant renders the right value today, and keeps
# rendering it after the template is corrected, so a library-wide fix silently
# skips exactly the rows that stored a copy.
def case_pin_scalar_field_pinned_to_template():
    def pin(res, raw):
        raw["density"] = 1.24                    # identical to the template's
        res["_inherited"].remove("density")      # ...so it is no longer inherited

    rows = _pin_rows(*_pin_family(pin))
    hit = [m for fid, m in rows
           if fid == _PIN_VAR
           and "stores density=1.24, identical to template 'PLA Family' -> pinned copy" in m]
    if not hit:
        bad("pin-scalar-copy",
            "a variant storing its template's own density verbatim was not reported — it stops "
            "tracking the template silently, so correcting the template leaves this row wrong:\n    "
            + "\n    ".join(m for _, m in rows))
    else:
        ok("pin-scalar-copy")
    # the healthy variant (density absent from the stored read) must stay silent,
    # or the check would flag the very shape it is telling people to adopt
    fp = [m for _, m in _pin_rows(*_pin_family()) if "stores density=" in m]
    ok("pin-scalar-copy-negative") if not fp else bad(
        "pin-scalar-copy-negative",
        f"a variant that stores NO density was reported as pinning it: {fp}")


# --- 17e. a temperature subfield stored identically to the template ----------
# `temperatures` resolves subfield by subfield, so one copied nozzle temp pins
# that subfield alone — the rest of the block keeps tracking and the row looks
# healthy in every summary.



# --- 17e. a temperature subfield stored identically to the template ----------
# `temperatures` resolves subfield by subfield, so one copied nozzle temp pins
# that subfield alone — the rest of the block keeps tracking and the row looks
# healthy in every summary.
def case_pin_temperature_subfield_pinned():
    def pin(res, raw):
        raw["temperatures"]["nozzle"] = 210
        res["_inherited"].remove("temperatures.nozzle")

    rows = _pin_rows(*_pin_family(pin))
    hit = [m for fid, m in rows
           if fid == _PIN_VAR
           and "stores temperatures.nozzle=210, identical to template 'PLA Family'" in m]
    if not hit:
        bad("pin-temperature-copy",
            "a variant storing its template's nozzle temperature verbatim was not reported — "
            "subfield inheritance stops for that one key and a later template retune never "
            "reaches this row:\n    " + "\n    ".join(m for _, m in rows))
    elif "pinned copy" not in hit[0]:
        bad("pin-temperature-copy",
            f"the temperature pin was emitted without naming it a pinned copy: {hit[0]}")
    else:
        ok("pin-temperature-copy")
    fp = [m for _, m in _pin_rows(*_pin_family()) if "stores temperatures." in m]
    ok("pin-temperature-copy-negative") if not fp else bad(
        "pin-temperature-copy-negative",
        f"a variant that stores NO temperature subfields was reported as pinning one: {fp}")


# --- 17f. a whole inheritable ARRAY stored identically to the template -------
# Arrays inherit WHOLE: an empty stored array is the sentinel, a non-empty one
# overrides outright. A copy is therefore a total override that looks like an
# inherited value — and for optTags it also freezes the abrasive/finish tags.



# --- 17f. a whole inheritable ARRAY stored identically to the template -------
# Arrays inherit WHOLE: an empty stored array is the sentinel, a non-empty one
# overrides outright. A copy is therefore a total override that looks like an
# inherited value — and for optTags it also freezes the abrasive/finish tags.
def case_pin_whole_array_pinned():
    def pin(res, raw):
        raw["optTags"] = [4]                     # the template's array, copied
        res["_inherited"].remove("optTags")

    rows = _pin_rows(*_pin_family(pin))
    hit = [m for fid, m in rows
           if fid == _PIN_VAR
           and "stores its own optTags (1 entry) identical to template 'PLA Family'" in m]
    if not hit:
        bad("pin-array-copy",
            "a variant storing a copy of its template's whole optTags array was not reported — "
            "a non-empty array overrides outright, so the template's tags never reach this row "
            "again:\n    " + "\n    ".join(m for _, m in rows))
    elif "pinned copy" not in hit[0]:
        bad("pin-array-copy",
            f"the array pin was emitted without naming it a pinned copy: {hit[0]}")
    else:
        ok("pin-array-copy")
    # an EMPTY stored array is the inherit sentinel and must never be reported
    fp = [m for _, m in _pin_rows(*_pin_family()) if "stores its own optTags" in m]
    ok("pin-array-copy-negative") if not fp else bad(
        "pin-array-copy-negative",
        f"a variant whose optTags array is empty — the inherit sentinel — was reported as "
        f"pinning it: {fp}")

# --- 17. the two pinned-copy sites with their OWN comparison rules -----------
# `compatibleNozzles` and `settings` do not go through the PIN_CHECK_ARRAYS
# sweep -- one compares nozzle IDENTITY, the other is shallow-merged per key --
# so each has its own emit site, and neither was pinned by anything: deleting
# either left the whole suite green, so nothing proved a pin is ever reported.
def case_pin_compatible_nozzles_pinned_copy():
    """A variant storing its template's tick list is a PIN, not a coincidence.

    `compatibleNozzles` is compared by nozzle IDENTITY (the _strip_ids
    comparison used for the other arrays would make two lists pointing at
    DIFFERENT nozzles compare equal). A variant whose stored array carries the
    same ids as its template has stopped tracking it: ticking a nozzle on the
    template never reaches this row again, and because the FilamentForm seeds
    its grid from `?raw=true`, the frozen copy is what every later edit and
    every isCalibrationRowReachable decision starts from.
    """
    TID, KID = "6a1a7c00677d648e9ba9d001", "6a1a7c00677d648e9ba9d002"
    inh = list(A.PIN_CHECK_FIELDS) + list(A.PIN_CHECK_ARRAYS) + \
        [f"temperatures.{t}" for t in A.PIN_CHECK_TEMPS]

    def fam(k_raw_over, inherited):
        # a HEALTHY family, then ONE deviation: the variant stores nothing it
        # inherits, so any row that comes back is caused by k_raw_over alone.
        t = valid_res(_id=TID, name="Family", parentId=None, spools=[], color=None,
                      colorName=None, totalWeight=None, lowStockThreshold=None,
                      instanceId="tttttttttt")
        k = valid_res(_id=KID, name="Family — Blue", parentId=TID, instanceId="kkkkkkkkkk")
        k["_inherited"] = list(inherited)
        kraw = copy.deepcopy(k)
        for f3 in A.PIN_CHECK_FIELDS:
            kraw.pop(f3, None)
        for f3 in A.PIN_CHECK_ARRAYS:
            kraw[f3] = []
        kraw["temperatures"] = {}
        kraw["settings"] = {}
        kraw["compatibleNozzles"] = []
        kraw.update(k_raw_over)
        f, _ = run({TID: rec(t, copy.deepcopy(t)), KID: {"res": k, "raw": kraw}},
                   topology={TID: True})
        return [m for rows in f.values() for _, m in rows]

    same = copy.deepcopy(valid_res()["compatibleNozzles"])
    got = fam({"compatibleNozzles": same}, inh)
    hit = [m for m in got if "stores its own compatibleNozzles (1) identical to template" in m]
    if hit and hit[0].startswith("Family — Blue"):
        ok("pin-compatible-nozzles-reported")
    else:
        bad("pin-compatible-nozzles-reported",
            f"a variant whose STORED compatibleNozzles names the same nozzle ids as its "
            f"template has silently stopped tracking it -- a nozzle ticked on the template "
            f"never reaches this row, and the FilamentForm seeds its grid from this frozen "
            f"copy. Nothing reported it: {got}")

    # CONTROL, the other side of the identity comparison: a list naming a
    # DIFFERENT nozzle is a real override, and calling it a pin would prescribe
    # clearing the array -- which switches the variant onto the template's
    # nozzles and silently changes what it prints with.
    other = [{"_id": "6a1a7bed677d648e9ba9cc0f", "name": "0.6 Hardened", "_deletedAt": None}]
    got = fam({"compatibleNozzles": copy.deepcopy(other)}, inh)
    if [m for m in got if "identical to template" in m]:
        bad("pin-compatible-nozzles-different-silent",
            f"a variant ticking a DIFFERENT nozzle is an override, not a pinned copy; "
            f"reporting it prescribes clearing the array, which switches the variant onto "
            f"the template's nozzles: {got}")
    else:
        ok("pin-compatible-nozzles-different-silent")


def case_pin_settings_bag_pinned_copies():
    """`settings` is SHALLOW-MERGED, so each key the variant stores pins THAT key.

    A slicer round trip echoes the whole bag back onto the variant, so the keys
    arrive without anyone choosing them and the variant silently stops tracking
    every one of them. The row must name the offending keys (they are the unit
    of repair) and must NOT count the openprinttag provenance keys, which are
    per-row linkage and are supposed to be identical.
    """
    TID, KID = "6a1a7c00677d648e9ba9d001", "6a1a7c00677d648e9ba9d002"
    inh = list(A.PIN_CHECK_FIELDS) + list(A.PIN_CHECK_ARRAYS) + \
        [f"temperatures.{t}" for t in A.PIN_CHECK_TEMPS] + ["compatibleNozzles"]

    def fam(bag):
        t = valid_res(_id=TID, name="Family", parentId=None, spools=[], color=None,
                      colorName=None, totalWeight=None, lowStockThreshold=None,
                      instanceId="tttttttttt")
        k = valid_res(_id=KID, name="Family — Blue", parentId=TID, instanceId="kkkkkkkkkk")
        k["_inherited"] = list(inh)
        kraw = copy.deepcopy(k)
        for f3 in A.PIN_CHECK_FIELDS:
            kraw.pop(f3, None)
        for f3 in A.PIN_CHECK_ARRAYS:
            kraw[f3] = []
        kraw["temperatures"] = {}
        kraw["compatibleNozzles"] = []
        kraw["settings"] = copy.deepcopy(bag)
        f, _ = run({TID: rec(t, copy.deepcopy(t)), KID: {"res": k, "raw": kraw}},
                   topology={TID: True})
        return [m for rows in f.values() for _, m in rows]

    got = fam(valid_res()["settings"])          # the whole bag echoed back
    hit = [m for m in got if "settings key(s) identical to template" in m]
    if not hit:
        bad("pin-settings-reported",
            f"a variant carrying its template's settings keys has pinned every one of them "
            f"-- the bag is shallow-merged, so each stored key overrides that key alone and "
            f"stops tracking it. Nothing reported it: {got}")
    elif not ("filament_abrasive" in hit[0] and "compatible_printers_condition" in hit[0]):
        bad("pin-settings-reported",
            f"the row must NAME the pinned keys -- the key is the unit of repair, and "
            f"'some of your settings are pinned' is not actionable: {hit[0]}")
    elif "openprinttag_slug" in hit[0] or "openprinttag_uuid" in hit[0]:
        bad("pin-settings-reported",
            f"the openprinttag provenance keys are PIN_EXEMPT: they are per-row linkage and "
            f"are supposed to match, so counting them prescribes deleting a filament's link "
            f"to its upstream material: {hit[0]}")
    else:
        ok("pin-settings-reported")

    # CONTROL: a bag holding ONLY the exempt keys is the ordinary shape of a
    # linked variant and must stay silent.
    got = fam({"openprinttag_slug": "prusament-pla", "openprinttag_uuid": "u-1"})
    if [m for m in got if "settings key(s) identical to template" in m]:
        bad("pin-settings-exempt-silent",
            f"only the exempt provenance keys are stored, so there is nothing pinned: {got}")
    else:
        ok("pin-settings-exempt-silent")


# --- 18. compatibleNozzles as a REFERENCE ARRAY, not just a tick list --------
# Three separate consequences hang off this one array and none of the three was
# pinned: an element that cannot cast (the whole backup is refused), an array
# whose every entry is tombstoned (effectively unassigned), and an array that
# merely contains one (a stale reference).
def case_pin_uncastable_nozzle_reference():
    """An element that is not an ObjectId reference costs the ENTIRE backup.

    `compatibleNozzles` is declared as an ObjectId array, so one element
    Mongoose cannot cast makes POST /api/snapshot refuse the whole file -- not
    the row, the file -- and the row still reads as healthy in the app because
    the soft-delete checks below merely look for `_deletedAt` and would count
    the junk as a live nozzle.
    """
    good = copy.deepcopy(valid_res()["compatibleNozzles"])
    # Both shapes a real database produces: a legacy 12-byte ASCII id (accepted
    # by older Mongoose, refused by 9.x) and a populated-looking ref whose _id
    # is not hex, which is what a hand-edited or foreign-sourced document holds.
    for label, elem in [("legacy-12-byte-id", "nozzle040brs"),
                        ("populated-non-hex-id", {"_id": "n1", "name": "0.6 Hardened"})]:
        r = valid_res(compatibleNozzles=good + [copy.deepcopy(elem)])
        findings, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in findings.values() for _, m in rows_
                if "compatibleNozzles[1]" in m and "is not a nozzle reference" in m]
        if rows:
            ok(f"uncastable-nozzle-ref-{label}")
        else:
            bad(f"uncastable-nozzle-ref-{label}",
                f"compatibleNozzles[1]={elem!r} cannot be cast to an ObjectId, so POST "
                f"/api/snapshot refuses the ENTIRE backup file while the app still serves the "
                f"row as if it were assigned. Nothing reported it: "
                f"{[m for rows_ in findings.values() for _, m in rows_]}")


def case_pin_all_nozzles_soft_deleted():
    """Every entry tombstoned is EFFECTIVELY UNASSIGNED, and looks assigned.

    A soft-deleted nozzle still populates as a truthy object carrying
    `_deletedAt`, so a non-empty array is not evidence of a usable assignment.
    The row reads as assigned everywhere -- including to a human scanning the
    edit form -- while no live nozzle backs it.
    """
    dead = [{"_id": "6a1a7bed677d648e9ba9cc01", "name": "0.4 Brass",
             "_deletedAt": "2026-03-01T00:00:00.000Z"}]
    r = valid_res(compatibleNozzles=copy.deepcopy(dead))
    findings, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in findings.values() for _, m in rows_
            if "every compatibleNozzles entry is soft-deleted" in m]
    if not rows:
        bad("all-nozzles-soft-deleted-reported",
            f"every compatibleNozzles entry is tombstoned, so the row is effectively "
            f"unassigned while a non-empty array makes it look assigned. Nothing reported it: "
            f"{[m for rows_ in findings.values() for _, m in rows_]}")
    elif "0.4 Brass" not in rows[0]:
        bad("all-nozzles-soft-deleted-reported",
            f"the row must name the tombstoned nozzle -- it is what the user has to replace: "
            f"{rows[0]}")
    else:
        ok("all-nozzles-soft-deleted-reported")

    # CONTROL: a live entry means the row IS assigned, so the stronger claim
    # must not be made -- "effectively unassigned" would send the user to
    # re-tick a nozzle that is already there.
    live = copy.deepcopy(valid_res()["compatibleNozzles"]) + copy.deepcopy(dead)
    r = valid_res(compatibleNozzles=live)
    findings, _ = run({"a": rec(r, copy.deepcopy(r))})
    if [m for rows_ in findings.values() for _, m in rows_
            if "every compatibleNozzles entry is soft-deleted" in m]:
        bad("all-nozzles-soft-deleted-not-overclaimed",
            "one entry is live, so the row is assigned; claiming it is effectively "
            "unassigned sends the user to fix an assignment that already works")
    else:
        ok("all-nozzles-soft-deleted-not-overclaimed")


def case_pin_some_nozzles_soft_deleted():
    """A tombstone ALONGSIDE a live nozzle is a stale reference, not an outage.

    The assignment still works, so this is the weaker of the two claims and it
    must be the one made: the stale entry cannot be used, and it has to name
    which nozzle so the user can drop it.
    """
    stale = {"_id": "6a1a7bed677d648e9ba9cc0f", "name": "0.6 Hardened",
             "_deletedAt": "2026-03-01T00:00:00.000Z"}
    compat = copy.deepcopy(valid_res()["compatibleNozzles"]) + [copy.deepcopy(stale)]
    r = valid_res(compatibleNozzles=compat)
    findings, _ = run({"a": rec(r, copy.deepcopy(r))})
    rows = [m for rows_ in findings.values() for _, m in rows_
            if "compatibleNozzles includes soft-deleted" in m]
    if not rows:
        bad("some-nozzles-soft-deleted-reported",
            f"a tombstoned nozzle sitting beside a live one is a stale reference that cannot "
            f"be used, and the array's length hides it. Nothing reported it: "
            f"{[m for rows_ in findings.values() for _, m in rows_]}")
    elif "0.6 Hardened" not in rows[0]:
        bad("some-nozzles-soft-deleted-reported",
            f"the row must name the stale nozzle -- with a live entry present, the name is "
            f"the only way to tell which one to drop: {rows[0]}")
    else:
        ok("some-nozzles-soft-deleted-reported")

    # CONTROL: an all-live array is the healthy shape and must stay silent.
    r = valid_res()
    findings, _ = run({"a": rec(r, copy.deepcopy(r))})
    if [m for rows_ in findings.values() for _, m in rows_ if "soft-deleted" in m]:
        bad("some-nozzles-soft-deleted-clean-silent",
            "an all-live compatibleNozzles array is healthy and must produce no row")
    else:
        ok("some-nozzles-soft-deleted-clean-silent")



# --- 14d-septies. the Number mirror must be USED on every castable shape ----
# A correct helper exercised only in isolation proves nothing about the code
# that calls it: `_castable_number` accepted `{"_id": "20000"}` while the
# bounds check converted STRINGS only, so a populated-ref numeric cast to
# 20000, blew the max validator, and the audit reported nothing but a generic
# off-type note. The differential test passed throughout, because it never
# looked at the call site.
def case_bounds_check_uses_every_castable_number():
    over = {"dryingTime": 20000}            # schema bound is 0-10080
    for label, stored in (("bare string", "20000"),
                          ("populated ref", {"_id": "20000"}),
                          ("numeric ref", {"_id": 20000}),
                          ("boolean-ish string", " 20000 ")):
        r = valid_res()
        r["dryingTime"] = stored
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        rows = [m for rows_ in f.values() for _, m in rows_]
        if not [m for m in rows if "outside the" in m and "dryingTime" in m]:
            bad("bounds-uses-castable-number",
                f"{label} {stored!r} CASTS to 20000, so Mongoose runs the max validator "
                f"and the restore fails on it -- the audit reported only that the value "
                f"is off-type, which reads as 'checks skipped, nothing broken'. "
                f"rows: {rows}")
            return
    ok("bounds-uses-castable-number")
    # ...and a shape the cast REFUSES must not be bounds-checked, or the row
    # would claim a validator failure that never runs
    for refused in ({"_id": "abc"}, [20000], "abc", {}):
        r = valid_res()
        r["dryingTime"] = refused
        f, _ = run({"a": rec(r, copy.deepcopy(r))})
        fp = [m for rows_ in f.values() for _, m in rows_
              if "outside the" in m and "dryingTime" in m]
        if fp:
            bad("bounds-skips-uncastable-number",
                f"{refused!r} never reaches the Number path at all, so claiming a bound "
                f"violation invents a validator failure: {fp}")
            return
    ok("bounds-skips-uncastable-number")



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
    case_ascii_only_mirror_regexes()
    case_mongoose_cast_mirrors()
    case_no_full_case_folding()
    case_cast_decisions_go_through_the_mirror()
    case_cast_mirrors_match_real_mongoose()
    case_bounds_check_uses_every_castable_number()
    case_pin_discovery_degraded_reported()
    case_pin_unreadable_filament_reported()
    case_pin_abrasive_payload_not_a_list()
    case_pin_abrasive_unassigned_suppresses_generic_nozzle_rows()
    case_pin_unusable_pair_reported()
    case_pin_required_text_missing_reported()
    case_pin_required_text_present_but_empty()
    case_pin_nested_spool_text_shape()
    case_pin_spool_retired_not_boolean()
    case_pin_ledger_elements_are_subdocuments()
    case_pin_ledger_text_shape()
    case_pin_listing_topology_keeps_template()
    case_pin_settings_bag_key_count()
    case_pin_settings_value_length_limit()
    case_pin_settings_nested_value_shapes()
    case_pin_compatible_printers_pin_reported()
    case_pin_net_filament_weight_missing()
    case_pin_numeric_sweep_dedupes_identical_reads()
    case_pin_legacy_roll_gross_below_tare()
    case_pin_every_live_spool_lacks_gross()
    case_pin_promotion_marker_at_uncastable()
    case_pin_top_level_timestamps_uncastable()
    case_pin_tds_url_not_a_string()
    case_pin_tds_url_not_http()
    case_pin_calibration_nozzle_purged()
    case_pin_calibration_nozzle_tombstoned()
    case_pin_bed_type_temps_unusable_key()
    case_pin_preset_label_uncastable_list()
    case_pin_nozzle_temp_below_declared_min()
    case_pin_nozzle_temp_above_declared_max()
    case_pin_nozzle_plausible_band()
    case_pin_bed_temperature_implausible()
    case_pin_standby_ceiling()
    case_pin_spool_missing_instance_id()
    case_pin_spool_location_ref_uncastable()
    case_pin_spool_text_maxlength()
    case_pin_dry_cycle_date_required()
    case_pin_dry_cycle_date_castable()
    case_pin_usage_source_enum()
    case_pin_usage_entry_date()
    case_pin_usage_entry_grams_required()
    case_pin_usage_debited_grams_semantic_bound()
    case_pin_missing_nozzle_temperature()
    case_pin_missing_bed_temperature()
    case_pin_missing_density()
    case_pin_trashed_variant_family_is_stuck()
    case_pin_nested_template_shape()
    case_pin_template_still_carries_field()
    case_pin_template_still_holds_spools()
    case_pin_parent_points_at_itself()
    case_pin_parent_is_itself_a_variant()
    case_pin_scalar_field_pinned_to_template()
    case_pin_temperature_subfield_pinned()
    case_pin_whole_array_pinned()
    case_pin_compatible_nozzles_pinned_copy()
    case_pin_settings_bag_pinned_copies()
    case_pin_uncastable_nozzle_reference()
    case_pin_all_nozzles_soft_deleted()
    case_pin_some_nozzles_soft_deleted()
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
    case_js_truthiness_and_direction()
    case_js_trim_mirror()
    case_schema_string_paths_covered()
    case_schema_date_paths_covered()
    case_objectid_contract()
    case_schema_objectid_paths_covered()
    case_schema_boolean_paths_covered()
    case_js_mirror_sites()
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
