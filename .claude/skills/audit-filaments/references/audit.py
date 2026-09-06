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
import decimal
import json
import os
import re
import sys
import urllib.error
import urllib.parse
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
    """Compare array contents, ignoring only each ELEMENT's generated id.

    Recursing was wrong: a calibration's `nozzle`/`printer`/`bedType` are
    POPULATED references whose `_id` IS their identity, so stripping those made
    two calibrations pointing at DIFFERENT nozzles compare equal — a false pin,
    whose documented repair (clear the variant's array) would then switch the
    variant onto the template's targets. Only the array element's own generated
    subdocument id is noise.
    """
    if isinstance(value, list):
        return [_strip_ids(v) for v in value]
    if isinstance(value, dict):
        return {k: v for k, v in sorted(value.items()) if k not in ("_id", "id")}
    return value


# 0xffffffff, NOT 2**64-1. Verified against src/lib/openprinttag.ts:214 — the
# encoder's arithmetic is 32-bit and truncates above this, so a larger tag is
# rejected there. Mirroring the app's EXPRESSION while guessing the constant's
# value from its name is how this was wrong the first time.
MAX_CBOR_UINT = 0xFFFFFFFF


def _encodable_opt_tag(t):
    """Mirror of isEncodableOptTag in src/lib/openprinttag.ts.

    bool is excluded explicitly: it is an int subclass in Python, so True would
    otherwise pass as tag 1 (CONTAINS_ARAMID_FIBER) and read as an abrasive.
    """
    return isinstance(t, int) and not isinstance(t, bool) and 0 <= t <= MAX_CBOR_UINT


def _disp(v):
    """A name safe to interpolate before the text sweep has run."""
    return v if isinstance(v, str) and v else "?"


_MAX_DOUBLE = 1.7976931348623157e308


def num(v):
    """A real number IN THE DOUBLE RANGE, or None.

    Every direct comparison goes through this. A raw-driver sync, a restore or a
    legacy write can leave a string in a numeric field, and `0.7 <= "oops"`
    raises TypeError — which would abort the whole audit over one bad value,
    exactly the failure the per-record fetch guard exists to prevent. The bad
    value is reported separately by the `malformed_numerics` sweep, which walks
    every schema-numeric leaf at any depth (its exclusions are OPAQUE_BAGS,
    populated REFERENCE_FIELDS and RESPONSE_METADATA, so a future bounds table
    over one of those would have no such companion row).

    Python ints are unbounded while JS numbers are doubles, so a JSON body can
    carry an integer no float can hold. Rejecting it here is what keeps
    `float(...)` and `f"{x:.0f}"` at the call sites from raising OverflowError
    and aborting the run.
    """
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if isinstance(v, int) and abs(v) > _MAX_DOUBLE:
        return None
    return v


# Free-form bags whose keys COLLIDE with schema numeric names by coincidence.
# `settings` is a slicer passthrough where values are strings by definition — an
# INI `temperature = 240` is the string "240" and is entirely correct — so
# descending into it reported 30+ false positives on the first real library it
# met. `openprinttagSnapshot` is provenance, not live spec.
OPAQUE_BAGS = {"settings", "openprinttagSnapshot"}

# Detail-response METADATA, injected by the route rather than stored on the
# document. GET /api/filaments/{id} attaches `_variants` (name/color/
# secondaryColors/cost/optTags per live child) plus `_parent`/`_inherited`, so
# walking them reports a CHILD's malformed value a second time against its
# TEMPLATE, at a path (`_variants[0].cost`) the template cannot even be PUT to.
# Every child is fetched and audited in its own right.
RESPONSE_METADATA = {"_variants", "_parent", "_inherited", "_strippedTemplateFields"}

# Populated REFERENCE documents. These are other collections' rows joined into
# this response — a nozzle's own `diameter` is not the filament's field, and the
# same nozzle is referenced by many filaments, so descending here reported one
# nozzle's defect once per referencing filament, against documents that cannot
# repair it. Nozzles are audited by /api/abrasive-nozzles and by the nozzle
# routes; a filament audit only cares whether the REFERENCE resolves.
REFERENCE_FIELDS = {"nozzle", "printer", "bedType", "compatibleNozzles", "installedNozzles"}


_CAL_ELEMENT_RE = re.compile(r"^calibrations\[\d+\]$")


def malformed_numerics(node, path=""):
    """Yield (path, value) for every numeric-named leaf holding a non-number."""
    if isinstance(node, dict):
        for k, v in node.items():
            where = f"{path}.{k}" if path else k
            if k in OPAQUE_BAGS or k in RESPONSE_METADATA:
                continue
            # `calibrations[].nozzle` shares its name with the numeric
            # `temperatures.nozzle` but holds a POPULATED NOZZLE, so a dict there
            # is correct rather than malformed. Scoped BY PATH: name alone
            # exempted `temperatures.nozzle: {}` too, so an object in a numeric
            # temperature field audited clean.
            # A populated reference is another collection's document. Skipping
            # it entirely also preserves the older fix this replaces: an object
            # in the NUMERIC `temperatures.nozzle` is still reported, because
            # that path is not a reference site.
            if k in REFERENCE_FIELDS and (isinstance(v, dict) or isinstance(v, list)):
                if not (k == "nozzle" and not _CAL_ELEMENT_RE.match(path)):
                    continue
            if k in NUMERIC_LEAF_NAMES:
                # `num()` rejects an int past the double range so the comparison
                # sites cannot raise OverflowError — which would leave such a
                # value completely SILENT if the sweep did not name it here. It
                # is genuinely broken data: JSON.stringify renders it null, so
                # it cannot survive an export or a snapshot round-trip.
                if v is not None and not (isinstance(v, (int, float)) and not isinstance(v, bool)):
                    yield where, v
                elif isinstance(v, int) and not isinstance(v, bool) and abs(v) > _MAX_DOUBLE:
                    yield where, v
                continue
            yield from malformed_numerics(v, where)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from malformed_numerics(v, f"{path}[{i}]")


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
    """Identity-only comparison for `compatibleNozzles`.

    NOT because the raw read carries bare ObjectIds -- it does not; the detail
    route runs ONE populated query and both reads come back with full nozzle
    documents, so the non-dict branch below is defensive only. The real reason
    this array is handled separately is the opposite: a populated nozzle's `_id`
    IS its identity, and the structural comparison used for the other arrays
    strips generated ids -- which would make two lists pointing at DIFFERENT
    nozzles compare equal, and the prescribed repair (clear the variant's array)
    would then switch the variant onto the template's nozzles.
    """
    out = []
    for entry in value or []:
        # A bare id is not reachable through either detail read today; kept so a
        # cached or snapshot-sourced document cannot crash the comparison.
        ref = entry.get("_id") if isinstance(entry, dict) else entry
        if ref is not None:
            out.append(str(ref))
    return sorted(out)

# Materials that legitimately print below the general FFF floor. The bundled
# technical reference documents PCL 100 at ~120 C and the orthotic Facilan Ortho
# at 130-170 C, with the polymer softening near 60 C — a flat 150 C floor would
# call every one of those a validity error.
# Matched as a SUBSTRING of the upper-cased type, so "FACILAN" covers
# "Facilan Ortho". Listed because the comment above names it: a tuple that
# contradicts its own rationale is worse than no comment.
LOW_TEMP_TYPES = ("PCL", "FACILAN")

# Metal-filled composites are legitimately far denser than any unfilled polymer —
# copper- and bronze-filled PLA sit around 3-4 g/cm3 — and the schema permits any
# non-negative density. Applying an unfilled-polymer ceiling to them would report
# correct data as invalid and invite a "fix" that corrupts every weight-to-length
# calculation downstream.
# Evidence is the OPT tag ALONE. Name matching is not safe HERE -- and not
# because the app avoids it: FILLED_RE carries `metallic` as a standalone
# alternative, so "Metallic Grey" DOES match it. The app can afford that because
# `filled` is the one reason an explicit `filament_abrasive = "0"` suppresses.
# A density ceiling has no such escape hatch: raised by name, an ordinary
# filament silently accepts a corrupt 4 g/cm3 -- a false negative in place of a
# false positive, which is worse.
OPT_TAG_METAL_FILL = 20
DENSITY_CEILING = 2.5
DENSITY_CEILING_FILLED = 12.0
DENSITY_FLOOR = 0.7
# ...except for foaming grades, which are SUPPOSED to be down there. The app's
# own bundled reference documents it: "colorFabb publishes 0.40-0.48 at full
# foaming" for LW-PLA. A flat 0.7 floor condemned every one of them, so this
# mirrors the LOW_TEMP_TYPES exemption rather than lowering the floor for
# materials that have no business being that light.
DENSITY_FLOOR_FOAMING = 0.3
FOAMING_TYPE_RE = re.compile(r"(^|[^A-Z])LW[^A-Z]?|FOAM|LIGHTWEIGHT")

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
# Mirrored from src/lib/slicerSettings.ts — validateSettingsBag rejects these,
# so a bag past either limit bloats every detail read and every export.
MAX_SETTINGS_KEYS = 400
MAX_SETTING_VALUE_LENGTH = 20_000


def _js_number(x):
    """Render a number exactly as `JSON.stringify` does.

    This implements ECMAScript's Number::toString rather than approximating it,
    because the divergences from Python are not cosmetic when the result is
    MEASURED against a 20,000-character limit:

      * `json.dumps(1e20)`  -> `1e+20`  (5)   JS -> `100000000000000000000` (21)
      * `json.dumps(1e-6)`  -> `1e-06`  (5)   JS -> `0.000001`              (8)
      * `repr(float(123456789012345678901))` gives the exact binary value
        (`...683968`) where JS prints the shortest round-trip digits zero-padded
        (`...680000`).

    The rule, over the shortest round-trip digits `s` (length k) and the decimal
    point position n: integer form while k <= n <= 21, a point inside the digits
    while 0 < n <= 21, a leading `0.000…` while -6 < n <= 0, and exponential
    otherwise — with an unpadded exponent, unlike Python's `e-07`.
    """
    try:
        f = float(x)
    except OverflowError:
        # An int past the double range is not representable as a JS number --
        # the same answer JSON.stringify gives Infinity, which the screen below
        # already maps to null.
        return "null"
    if f != f or f in (float("inf"), float("-inf")):
        return "null"                       # JSON.stringify(NaN|Infinity) === null
    if f == 0:
        return "0"                          # and JSON.stringify(-0) === "0"
    sign = "-" if f < 0 else ""
    digits_t, exp = decimal.Decimal(repr(abs(f))).normalize().as_tuple()[1:]
    s_dig = "".join(map(str, digits_t))
    k = len(s_dig)
    n = exp + k
    if k <= n <= 21:
        return sign + s_dig + "0" * (n - k)
    if 0 < n <= 21:
        return sign + s_dig[:n] + "." + s_dig[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + s_dig
    mant = s_dig[0] + ("." + s_dig[1:] if k > 1 else "")
    e = n - 1
    return f"{sign}{mant}e{'+' if e >= 0 else '-'}{abs(e)}"


def _js_stringify(v):
    """`JSON.stringify(value ?? null)`, matching the app's own measurement."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return _js_number(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(_js_stringify(e) for e in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(f"{json.dumps(str(k), ensure_ascii=False)}:{_js_stringify(e)}"
                              for k, e in v.items()) + "}"
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
MAX_SECONDARY_COLORS = 5   # OpenPrintTag spec limit, enforced by the schema

# Containers whose SHAPE a raw-driver sync or restore can break. A truthy
# non-container here crashes any `.get()`/iteration, so each is reported and
# treated as empty for the rest of the run.
CONTAINER_SHAPES = {
    "temperatures": dict, "settings": dict, "bedTypeTemps": list,
    "calibrations": list, "presets": list, "spools": list,
    "secondaryColors": list, "optTags": list, "compatibleNozzles": list,
}

# Containers nested one level down, keyed by the list that holds them.
# CONTAINER_SHAPES only reaches the top level, so a spool holding
# `usageHistory: 3` was iterated directly and aborted the run, and a preset
# holding `temperatures: "oops"` was skipped in silence. Keyed by parent so a new
# subdocument container is one table entry rather than another bespoke guard.
# Arrays whose ELEMENTS must be subdocuments. The container check accepts a list
# of anything, so `spools: ["oops"]` passed while every later pass skipped the
# non-dict quietly and the record audited clean — the app cannot compute
# inventory from that live spool. compatibleNozzles is deliberately ABSENT: the
# raw read carries ObjectId strings there, so a non-dict element is normal.
DICT_ELEMENT_ARRAYS = ("spools", "calibrations", "presets", "bedTypeTemps")

# Elements of the NESTED subdocument arrays. NESTED_CONTAINER_SHAPES checks only
# that the container is a list, so `usageHistory: ["oops"]` passed it and every
# later pass dropped the scalar in silence (bounds_check returns on a non-dict) —
# the record audited clean while exportSpools reads `u.grams` and `c.date` off it.
NESTED_DICT_ELEMENT_ARRAYS = {"spools": ("usageHistory", "dryCycles")}

# Booleans read by TRUTHINESS. `retired` is the one that matters: any non-empty
# string hides the spool from the spool count, the gram total and the % bar, so a
# corrupt flag silently removes inventory. Reported but deliberately NOT coerced —
# coercing would make the audit disagree with what the app actually computes.
NESTED_BOOL_FIELDS = {"spools": ("retired",)}

# String fields inside a spool. These four are checked together but their
# consequences are NOT the same, so each carries its own -- see
# _nested_text_consequence. Pasting label's React-child crash onto `instanceId`
# (an identity key, never rendered as a child) or `photoDataUrl` (an <img src>,
# which coerces instead of throwing) sent the reader looking for a crash that
# cannot happen and hid the failure that does.
NESTED_TEXT_FIELDS = {"spools": ("instanceId", "label", "lotNumber", "photoDataUrl")}


def _react_child_throws(v):
    """React renders string / number / boolean / null children happily and
    flattens arrays; it throws "Objects are not valid as a React child" only
    when a plain object reaches it. So a numeric label does NOT crash the page,
    and claiming it does is a false alarm on the loudest kind of finding."""
    if isinstance(v, dict):
        return True
    if isinstance(v, list):
        return any(_react_child_throws(e) for e in v)
    return False


def _nested_text_consequence(field, value):
    """The consequence of a non-string value, per field and per value shape."""
    if field == "instanceId":
        return ("this is the durable per-spool identity a printed QR label and a written NFC tag "
                "carry, and BOTH match tiers are type-strict -- the Mongo `spools.instanceId` "
                "equality and the `sp.instanceId === id` re-scan that follows it -- so scanning "
                "this spool resolves to nothing")
    if field == "photoDataUrl":
        return ("it goes straight to an <img src>, which COERCES rather than throwing, so the "
                "spool shows a permanently broken image with no error to explain it")
    if field == "lotNumber":
        # Wrong in BOTH directions before: an object was reported as a
        # detail-page crash it cannot cause (the detail page only ever puts
        # lotNumber in a controlled <input>, which coerces), and a NUMBER was
        # called harmless when it is not -- /inventory's search does
        # `(s.lotNumber || "").toLowerCase()`, and a truthy non-string has no
        # .toLowerCase, so the page throws as soon as the user types.
        extra = (" and, being an object, it also fails Mongoose's String cast, so POST "
                 "/api/snapshot refuses the ENTIRE backup file"
                 if isinstance(value, (dict, list)) else "")
        return ("the Spool Inventory search does `(s.lotNumber || \"\").toLowerCase()`, and a "
                "truthy non-string has no .toLowerCase — so /inventory throws the moment anyone "
                "types in the search box" + extra)
    if _react_child_throws(value):
        return ("it renders directly as a React child and React throws on an object, so opening "
                "this filament -- or expanding its inventory row -- fails outright")
    if field == "label":
        return ("React renders this shape as a child without complaint, so nothing looks "
                "wrong -- but computeNextSpoolLabel skips every non-string label "
                "(`typeof raw !== \"string\"`), so the Next # button can hand this same roll "
                "number out again for a new spool")
    return "the schema declares a string here, so the value is off-type rather than fatal"

# Text one level deeper still, inside the ledgers. `jobLabel` and `notes` are
# rendered as React children on the detail page, so a non-string throws when the
# usage history or dry-cycle list is expanded.
LEDGER_TEXT_FIELDS = {("spools", "usageHistory"): ("jobLabel",),
                      ("spools", "dryCycles"): ("notes",)}

NESTED_CONTAINER_SHAPES = {
    "spools": {"usageHistory": list, "dryCycles": list},
    "presets": {"temperatures": dict},
}

# Scalar STRING fields. Mongoose casts most of these, but a raw-driver write, a
# hybrid-sync copy or a restored snapshot can leave a number, a list or a dict
# here, and the passes below call .upper()/.lower()/.strip() on them. Swept with
# the containers for the same reason the containers are swept centrally: guarding
# each call site is what turns one defect into one review round per site.
# `inherits` is here because the detail page renders it directly as a React
# child, exactly like the other five — a non-string throws on open.
# `instanceId` is here because the detail page renders it DIRECTLY as a React
# child (`{filament.instanceId}` beside the name), so a non-string throws on
# open — and the cross-record identity pass indexes strings only, so without
# this the field had no check at all.
TEXT_FIELDS = ("name", "vendor", "type", "color", "colorName", "inherits", "instanceId")

# Schema-required text, with the model's own trim semantics (Filament.ts):
# `name` is `{required, trim}` so Mongoose trims BEFORE the required check and a
# whitespace-only name is a violation; `vendor`/`type` are required WITHOUT trim,
# so only the exact empty string is. Judged on the STORED read — resolveFilament
# treats "" as missing and substitutes the template's value, so a variant's empty
# vendor is invisible in the resolved response.
REQUIRED_TEXT = {"name": True, "vendor": False, "type": False}

# Every `<field>: { type: Number }` leaf in the Filament schema. ONE recursive
# sweep reports a non-number in any of them, at any depth, so the individual
# passes can skip quietly instead of each needing its own reporting branch —
# four consecutive review rounds found the next unreported site otherwise.
NUMERIC_LEAF_NAMES = {
    "bed", "bedFirstLayer", "bedTemp", "bedTempFirstLayer", "chamberTemp", "cost",
    "debitedGrams", "density", "diameter", "dryingTemperature", "dryingTime",
    "durationMin", "extrusionMultiplier", "fanBridgeSpeed", "fanMaxSpeed",
    "fanMinSpeed", "firstLayerTemperature", "glassTempTransition", "grams",
    "heatDeflectionTemp", "lowStockThreshold", "maxPrintSpeed", "maxVolumetricSpeed",
    "minPrintSpeed", "netFilamentWeight", "nozzle", "nozzleFirstLayer",
    "nozzleRangeMax", "nozzleRangeMin", "nozzleTemp", "nozzleTempFirstLayer",
    "pressureAdvance", "retractLength", "retractLift", "retractSpeed",
    "shoreHardnessA", "shoreHardnessD", "shrinkageXY", "shrinkageZ", "spoolWeight",
    "standby", "tempC", "temperature", "totalWeight", "transmissionDistance",
}

# getRemainingPct CLAMPS with Math.min(100, ...), so remaining mass above the
# net weight does not overflow -- it SATURATES, and the bar sits at a confident
# 100% until real usage brings it back under net. Only report past a tolerance:
# a "1 kg" spool is routinely wound 1000-1050 g, and a kitchen scale drifts, so
# a few percent over is normal stock rather than a defect.
OVER_NET_TOLERANCE = 1.10
# The mirror of OVER_NET_TOLERANCE, and it needs one for the same reason: a roll
# weighed a few grams under its tare is a FINISHED roll plus scale drift, not a
# data defect. Without this the check fired on the ordinary end of a spool's
# life with a diagnosis ("a tare inherited from a template whose spools are
# heavier") that does not fit it at all.
BELOW_TARE_TOLERANCE_G = 15.0
BELOW_TARE_TOLERANCE_FRAC = 0.05

# Schema constraints that are not numeric min/max. Same rationale as
# NUMERIC_BOUNDS, sharper consequence: POST /api/snapshot pre-validates EVERY
# document before it writes anything and 400s the WHOLE file on the first
# failure, so one of these anywhere in the library makes the user's backup
# un-restorable -- and they only find out at restore time.
MAX_SPOOL_TEXT_LENGTH = 200                              # Filament.ts maxlength
NESTED_TEXT_MAXLEN = {"spools": ("label", "lotNumber")}


def _short(v, limit=40):
    """A document-derived value used as an IDENTIFIER inside a message. Values
    here come from the API, so length is not bounded by anything the app
    enforces; a report is useless if one bad row is 10 KB wide."""
    t = v if isinstance(v, str) else repr(v)
    return t if len(t) <= limit else t[:limit] + "…"


def _utf16_len(text):
    """`maxlength` counts JS String.length -- UTF-16 code units, not code
    points. An emoji or any astral character costs TWO, so a 150-character
    Python string can be a 300-unit JS string and fail a check that measured
    len()."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


# WHATWG "strip leading/trailing C0-or-space, then delete every tab and
# newline ANYWHERE" -- the sanitisation `new URL` performs before it parses.
_URL_STRIP = "".join(chr(c) for c in range(0x21))
_URL_REMOVE = {0x09: None, 0x0A: None, 0x0D: None}
_URL_SCHEME_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*:")


# ECMAScript time value range (ES2024 21.4.1.1): a Date outside +/-8.64e15 ms
# is Invalid, so a raw numeric date past it can be neither cast nor rendered.
JS_MAX_TIME_VALUE = 8_640_000_000_000_000
_ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
# Only the shapes whose components can be READ are judged; an unrecognised
# tail is left alone rather than guessed at (see _bad_date).
_ISO_TIME_RE = re.compile(r"^[Tt](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?")
_ISO_OFFSET_RE = re.compile(r"[+-](\d{2}):?(\d{2})$")


def _bad_date(v):
    """True ONLY when Mongoose's Date cast is certain to fail. Mongoose casts a
    string with `new Date(v)` and raises CastError on an Invalid Date, so this
    has to mirror V8 -- and V8 accepts far more than ISO 8601 ("Jan 1 2020",
    "2020/01/01", "2026-1-5", even "2020-02-30", which it rolls over to Mar 1).
    Anything stricter than V8 here would condemn a date the app stores happily,
    so this deliberately reports only the shapes V8 provably rejects and stays
    silent on the rest. Verified against node's own `new Date` over a corpus of
    real and malformed values: no value node accepts is reported."""
    if isinstance(v, bool):
        return False              # new Date(true) is 1970-01-01T00:00:00.001Z
    if isinstance(v, (int, float)):
        # NOT "always valid": the ECMAScript time value range is +/-8.64e15 ms
        # (~+/-273,790 years), and one millisecond past it is an Invalid Date.
        # NaN and the infinities are Invalid too.
        if v != v or v in (float("inf"), float("-inf")):
            return True
        return abs(v) > JS_MAX_TIME_VALUE
    if isinstance(v, dict):
        return True               # new Date({}) is Invalid Date -> CastError
    if isinstance(v, list):
        return not v              # new Date([]) is Invalid; a non-empty array
                                  # stringifies and may well parse
    if not isinstance(v, str):
        return False              # None is handled by the presence checks
    t = v.strip()
    if not t:
        return True               # "" and whitespace-only are Invalid Date
    if not any(c.isascii() and c.isdigit() for c in t):
        return True               # no ASCII digit -> no date format can match
    mo = _ISO_DATE_RE.match(t)
    if mo:
        # An ISO-SHAPED string is parsed by the spec path, which rejects an
        # out-of-range month or day outright (V8 rolls 02-30 over, so the day
        # ceiling is the calendar maximum of 31, not the month's own length).
        _m, _d = int(mo.group(2)), int(mo.group(3))
        if not (1 <= _m <= 12) or not (1 <= _d <= 31):
            return True
        # The TIME half is judged the same way, because the date prefix alone
        # being sane says nothing: V8 rejects "…T25:00:00Z" outright. Confirmed
        # boundaries -- hour 24 is legal ONLY as exactly 24:00:00, there are no
        # leap seconds (23:59:60 is rejected), and an offset hour must be <= 23.
        # A tail this regex cannot read (a bare "T", "Tnonsense", a one-digit
        # hour) is NOT judged: V8 does reject those, but guessing at shapes we
        # cannot parse is how a false positive gets in.
        _t = _ISO_TIME_RE.match(t[mo.end():])
        if _t:
            _h, _mi = int(_t.group(1)), int(_t.group(2))
            _se = int(_t.group(3)) if _t.group(3) else 0
            if _h > 24 or _mi > 59 or _se > 59:
                return True
            if _h == 24 and (_mi or _se):
                return True
            _off = _ISO_OFFSET_RE.search(t)
            if _off and (int(_off.group(1)) > 23 or int(_off.group(2)) > 59):
                return True
    return False


def _bad_tds_url(v):
    """Mirror of the model's `isValidTdsUrl`: `new URL(v)` with an http(s)
    protocol. This reports ONLY the three things `new URL` is certain to
    reject, because a false positive here tells the user to "fix" a URL that
    already works -- and a tdsUrl is a link they pasted from a vendor site.

    Why neither a `startswith("http")` test nor `urlsplit` mirrors it:
      - `new URL` strips leading/trailing C0-and-space and deletes interior
        tabs/newlines, so " https://x.com " and a line-wrapped paste are VALID.
      - the scheme is case-insensitive: "HTTPS://x.com" is valid.
      - for a SPECIAL scheme every leading "/" and "\\" after the colon is
        consumed as authority framing, so "http:/x.com", "http:///x.com" and
        even "HTTP:\\\\x.com" all parse with the host that follows -- the
        shapes a `urlsplit`-based mirror wrongly condemns for an empty netloc.
      - a bare "http:" or "http://" REJECTS: a special scheme demands a host.
    Deliberately NOT mirrored (reported as fine): a host that parses
    structurally but fails IDNA/IPv6/port validation. Those throw in the
    browser too, so this under-reports rather than misdirects."""
    if not isinstance(v, str) or v == "":
        return False                       # the schema allows null and ""
    s = v.strip(_URL_STRIP).translate(_URL_REMOVE)
    mo = _URL_SCHEME_RE.match(s)
    if not mo:
        return True                        # no scheme at all -> `new URL` throws
    if s[:mo.end() - 1].lower() not in ("http", "https"):
        return True                        # a real URL, but not one this field takes
    rest = s[mo.end():].lstrip("/\\")     # special-scheme slash framing
    for i, ch in enumerate(rest):
        if ch in "/\\?#":
            rest = rest[:i]
            break
    return not rest.rsplit("@", 1)[-1]     # empty host -> `new URL` throws


# src/lib/orcaSlicerBundle.ts — Orca/Bambu is the only EXPORT consumer of
# bedTypeTemps and indexes BED_TYPE_KEY_MAP by exact string with no else
# branch. The field is FREE TEXT though (Filament.ts says so, and
# bedTypeTempRefFilter matches it against user-created BedType names), so this
# list is used ONLY to spot a case/whitespace twin -- never as a closed
# vocabulary. See the bedTypeTemps check.
# src/lib/validateSpoolBody.ts — the charset/length contract every API write
# to a spool id must satisfy. Mirrored so a value that arrived by a path
# WITHOUT validation is reported before the user next tries to edit it.
SPOOL_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
MAX_SPOOL_ID_LENGTH = 128
# openprinttag.ts: brand_specific_instance_id is capped at 16 characters, and an
# over-long id is OMITTED rather than truncated (GH #952 — a truncated id reads
# back as a DIFFERENT id and breaks scan-back). So there are two distinct
# ceilings, and the lower one costs the tag identity silently.
MAX_TAG_ID_LENGTH = 16


def _id_contract_problem(value):
    """Which consumer bound a stored instanceId violates, or None."""
    if not isinstance(value, str):
        return None                       # a non-string is reported by the shape sweep
    t = value.strip()
    if not t:
        return None                       # absence has its own row
    if len(t) > MAX_SPOOL_ID_LENGTH:
        return (f"is {len(t)} characters, past the {MAX_SPOOL_ID_LENGTH}-character contract -> "
                f"/api/filaments/match caps its query at the same length, so this id can never "
                f"round-trip through a QR or NFC scan, and any edit through the API is refused")
    if not SPOOL_ID_RE.match(t):
        return ("is outside the allowed charset (letters, digits, dot, underscore, hyphen) -> "
                "validateSpoolInstanceId refuses it, so any later edit to this spool is rejected "
                "until the id is replaced")
    if len(t) > MAX_TAG_ID_LENGTH:
        return (f"is {len(t)} characters, past the {MAX_TAG_ID_LENGTH}-character OpenPrintTag "
                f"field -> the encoder OMITS it rather than truncating (a truncated id would read "
                f"back as a different one), so a written tag carries no instance id at all and "
                f"scan-back falls through to name/vendor/type")
    return None

# Roots that are REQUIRED and therefore stored on every row, so `_inherited`
# can never contain them. Naming one as a blame root made the single-owner
# "INHERITED from template" branch unreachable at that site and forced every
# genuinely inherited value there into the MIXED branch instead.
ALWAYS_STORED_ROOTS = ("name", "vendor", "type")

# Settings keys a variant is SUPPOSED to duplicate from its template. The detail
# route computes `_hasOwnOptLink` from the RAW row, so a variant that carries its
# own OPT linkage needs these stored locally even when the template has the same
# values — deleting them as "pinned copies" would disable the variant's own
# "Check for updates" button. (v1.52 #753 Approach C.)
PIN_EXEMPT_SETTINGS = ("openprinttag_slug", "openprinttag_uuid")

ORCA_PLATE_KEYS = ("Cool Plate", "Engineering Plate", "Hot Plate",
                   "Textured PEI Plate", "Textured Cool Plate")

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

# The usage-entry `source` enum, mirrored from the schema.
USAGE_SOURCES = {"manual", "slicer", "job", "nfc"}
ORDERED_PAIRS_USAGE = [("debited vs requested grams", "debitedGrams", "grams")]
LOW_TEMP_FLOOR = 60
NOZZLE_FLOOR = 150
NOZZLE_CEILING = 450

HEX6 = re.compile(r"#[0-9A-Fa-f]{6}\Z")

CATEGORIES = [
    # `notchecked` is a CROSS-CUTTING completeness channel, not a defect
    # category: it carries the rows that say part of the library was not
    # audited at all. It is deliberately exempt from --only, because a filter
    # is exactly when those rows matter most — `--only abrasive` over a library
    # where three records failed their detail read used to print a clean
    # abrasive section with nothing to say that three rows were never examined.
    ("notchecked",   "NOT CHECKED (completeness caveats — always shown)"),
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
    # DISCOVERY. The listing is an aggregation: `$size` over secondaryColors /
    # calibrations and `$map` over spools all ERROR on a non-array — which are
    # precisely the shapes this audit exists to find. So one corrupt row can
    # break the very read that discovers the records, and the whole library goes
    # unaudited. On failure, fall back to the snapshot export, which is a plain
    # `find().lean()` and therefore shape-tolerant.
    degraded = None
    listing = None
    try:
        listing = fetch(f"{base}/api/filaments", api_key)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("lookup failed: HTTP 401. This instance sets FILAMENTDB_API_KEY; pass --api-key.")
        degraded = f"HTTP {e.code}"
    except Exception as e:
        degraded = f"{type(e).__name__}: {e}"

    if listing is None or not isinstance(listing, list):
        if listing is not None and degraded is None:
            degraded = f"unexpected response shape: {type(listing).__name__}"
        try:
            snap = fetch(f"{base}/api/snapshot", api_key)
            rows = ((snap.get("collections") or {}).get("filaments")
                    if isinstance(snap, dict) else None) or []
            # The snapshot carries trashed and purged rows too; the listing does
            # not, and every later check assumes ACTIVE records.
            listing = [{"_id": str(x.get("_id")), "parentId": x.get("parentId"),
                        "hasVariants": False}
                       for x in rows if isinstance(x, dict)
                       and x.get("_deletedAt") in (None, "") and not x.get("_purged")]
            # ACTIVE children only, matching the listing's own hasVariants: a
            # parent whose sole variant is trashed is not a template, and
            # counting it as one would make the fallback disagree with the
            # normal path (13 templates against 12 on the library under test).
            parents_seen = {str(x.get("parentId")) for x in rows
                            if isinstance(x, dict) and x.get("parentId")
                            and x.get("_deletedAt") in (None, "") and not x.get("_purged")}
            for row in listing:
                row["hasVariants"] = row["_id"] in parents_seen
            degraded = (f"the /api/filaments listing failed ({degraded}); records were discovered "
                        f"through the snapshot export instead. That listing is an aggregation and "
                        f"errors on exactly the malformed containers this audit looks for, so the "
                        f"failure itself is likely a finding — check the shape rows below.")
        except Exception as e:
            sys.exit(f"lookup failed: {degraded}; the snapshot fallback also failed "
                     f"({type(e).__name__}: {e}). Is the app running at {base}?")

    ids = [str(f["_id"]) for f in listing if isinstance(f, dict) and f.get("_id") is not None]
    listing_topology = {str(f["_id"]): bool(f.get("hasVariants"))
                        for f in listing if isinstance(f, dict) and f.get("_id") is not None}
    if not ids:
        sys.exit("no filaments returned — refusing to report a clean audit of an empty read")

    def one(i):
        # A record can vanish between the listing and the detail read, or a
        # corrupted restored row can 500 its own GET route. Letting that
        # propagate out of pool.map would abort the entire audit before ANY
        # finding is rendered — one bad row hiding every other row's defects,
        # which is the opposite of what this tool is for.
        try:
            res = fetch(f"{base}/api/filaments/{i}", api_key)
            raw = fetch(f"{base}/api/filaments/{i}?raw=true", api_key)
        except Exception as e:  # noqa: BLE001 - reported, never swallowed
            return i, {"error": f"{type(e).__name__}: {e}"}
        if cache_dir:
            # OUTSIDE the fetch try/except is not good enough: an unwritable or
            # mistyped --cache path raises OSError here, and that propagates out
            # of pool.map and aborts the whole audit AFTER every record has
            # already been fetched. A debugging convenience must never be able
            # to destroy the run it was meant to help debug.
            try:
                for _fn, _doc in ((f"{i}.resolved.json", res), (f"{i}.raw.json", raw)):
                    with open(os.path.join(cache_dir, _fn), "w") as _fh:
                        json.dump(_doc, _fh)
            except OSError as e:
                return i, {"res": res, "raw": raw, "cache_error": f"{type(e).__name__}: {e}"}
        return i, {"res": res, "raw": raw}

    # Hoisted out of one(): an unusable directory should fail FAST and by name,
    # not after 2N HTTP round-trips, and not once per worker.
    if cache_dir:
        try:
            os.makedirs(cache_dir, exist_ok=True)
        except OSError as e:
            sys.exit(f"--cache {cache_dir!r} is unusable ({type(e).__name__}: {e})")

    with ThreadPoolExecutor(max_workers=8) as pool:
        fetched = dict(pool.map(one, ids))
    _cache_errs = {i: v["cache_error"] for i, v in fetched.items() if "cache_error" in v}
    if _cache_errs:
        print(f"warning: --cache could not write {len(_cache_errs)} record(s); "
              f"e.g. {next(iter(_cache_errs.values()))}", file=sys.stderr)
    failed = {i: v["error"] for i, v in fetched.items() if "error" in v}
    records = {i: v for i, v in fetched.items() if "error" not in v}
    if not records:
        sys.exit(f"every detail read failed (e.g. {next(iter(failed.values()), '?')}) — "
                 f"refusing to report a clean audit")

    # The authoritative abrasive audit. A failure here must be visible, not
    # silently rendered as "no abrasive problems".
    try:
        payload = fetch(f"{base}/api/abrasive-nozzles", api_key)
        # Defaulting a missing key to [] would render "no abrasive problems" for a
        # 200 carrying an error object — the one category where a silent miss
        # means a ruined nozzle. An unexpected shape is NOT CHECKED, not clean.
        if isinstance(payload, dict) and isinstance(payload.get("findings"), list):
            abrasive = payload["findings"]
        else:
            abrasive = {"error": f"unexpected response shape: {type(payload).__name__} "
                                 f"without a 'findings' list"}
    except Exception as e:
        abrasive = {"error": str(e)}

    # UNPOPULATED calibration references. Both detail reads populate
    # `calibrations.printer` / `.bedType`, and populate() yields null for a
    # target that no longer exists -- which is byte-identical to the SUPPORTED
    # generic state (a calibration deliberately scoped to no printer and no
    # bed). So the two reads in hand physically cannot tell a purged scope from
    # a generic one, and the difference matters: pickRepresentativeCalibration
    # (orcaSlicerBundle.ts) takes the FIRST row with both refs null as the
    # export default, so a purged printer silently promotes one machine's
    # tuning to every machine. /api/snapshot is a plain find().lean() and is
    # the only read that carries the raw ObjectIds. ~0.5 MB / 25 ms on the
    # library under test, but it is the WHOLE database including spool photos,
    # so it is fetched once and only the ids are kept.
    ref_index = None
    try:
        snap = fetch(f"{base}/api/snapshot", api_key)
        cols = snap.get("collections") if isinstance(snap, dict) else None
        if isinstance(cols, dict):
            def _ids(key):
                # None when the snapshot does not CARRY the collection, which is
                # a real state (restore treats an absent key as "leave this
                # collection alone", and an older export predates some of them).
                # Collapsing that into an empty set would report every stored
                # reference in the library as dangling in one go.
                rows = cols.get(key)
                if not isinstance(rows, list):
                    return None
                return {str(x.get("_id")) for x in rows
                        if isinstance(x, dict) and x.get("_id") is not None}
            ref_index = {
                "printers": _ids("printers"),
                "bedTypes": _ids("bedTypes"),
                "locations": _ids("locations"),
                # Every row the collection HOLDS, trashed included: a
                # soft-deleted target still populates as an object, so the
                # existing soft-delete rows cover it. Only a target that is
                # gone entirely populates as null, and that is what this finds.
                "cals": {str(x.get("_id")): (x.get("calibrations") or [])
                         for x in (cols.get("filaments") or [])
                         if isinstance(x, dict) and x.get("_id") is not None},
            }
        else:
            ref_index = {"error": f"unexpected snapshot shape: {type(snap).__name__}"}
    except Exception as e:
        ref_index = {"error": f"{type(e).__name__}: {e}"}
    return records, abrasive, failed, listing_topology, degraded, ref_index


def audit(records, abrasive, failed=None, listing_topology=None, degraded=None,
          ref_index=None):
    findings = {}

    # Side inputs are guarded here, not at each use. They arrive from separate
    # HTTP reads, so a route that answers 200 with an unexpected body (a proxy
    # error page, an older build's shape) must degrade to "not checked" rather
    # than abort an audit of records that were read perfectly well.
    if not isinstance(records, dict):
        records = {}
    if not isinstance(failed, dict):
        failed = {} if failed is None else {}
    if not isinstance(listing_topology, dict):
        listing_topology = {}

    def add(cat, msg, fid=None):
        # Keyed on (record id, message), not text alone: hybrid sync, a restore or
        # a legacy database can leave two ACTIVE records sharing a name, and every
        # message identifies a filament by name. Deduping on text would collapse
        # two real defects into one row and hide the second record entirely.
        findings.setdefault(cat, []).append((fid, msg))

    if degraded:
        add("notchecked", f"DISCOVERY DEGRADED: {degraded}", None)

    for bad_id, err in (failed or {}).items():
        add("notchecked", f"filament {bad_id}: could NOT be read ({err}) -> it was not audited", bad_id)

    # Filaments the authoritative audit already reported as having no nozzle
    # assignment. The generic check below must not restate the same defect.
    abrasive_unassigned = set()

    # --- abrasive: report what the app determined, do not re-derive ----------
    if isinstance(abrasive, dict) and "error" in abrasive:
        add("abrasive", f"COULD NOT REACH /api/abrasive-nozzles ({abrasive['error']}) — "
                        f"abrasive safety was NOT checked")
    elif not isinstance(abrasive, (list, tuple)):
        add("abrasive", f"/api/abrasive-nozzles returned {type(abrasive).__name__}, not a list "
                        f"-> abrasive safety was NOT checked")
    else:
        for f in abrasive:
            if not isinstance(f, dict):
                add("abrasive", f"/api/abrasive-nozzles returned a {type(f).__name__} entry "
                                f"-> that entry was NOT checked")
                continue
            name = f.get("filamentName", "?")
            # Consume the nested fields defensively. `", ".join([1])` raises, and
            # so does `.get` on a scalar softNozzles entry — and this loop runs
            # BEFORE the per-record work, so either would abort the whole audit
            # and hide every finding, in the category where that is worst.
            _reasons = f.get("reasons")
            why = (", ".join(str(x) for x in _reasons)
                   if isinstance(_reasons, list) and _reasons else "abrasive")
            src = f" (inherited from {f['inheritedFrom']})" if f.get("inheritedFrom") else ""
            _soft = f.get("softNozzles")
            soft = ([n.get("name") if isinstance(n, dict) else n for n in _soft]
                    if isinstance(_soft, list) else [])
            if f.get("flagMismatch"):
                # `src` is NOT re-pasted here: the route populates inheritedFrom
                # for the NOZZLE-scoped findings, so attaching it to a flag row
                # points the fix at the template when `filament_abrasive` may be
                # the variant's own bag entry.
                add("abrasive", f"{name}: material reads abrasive ({why}) but settings.filament_abrasive "
                                f"is not on -> EXPORTS AS NON-ABRASIVE", str(f.get("filamentId")))
            if soft:
                add("abrasive", f"{name}: abrasive ({why}) but permitted on unfit nozzle(s) {soft}{src}",
                    str(f.get("filamentId")))
            if f.get("unassigned"):
                abrasive_unassigned.add(str(f.get("filamentId")))
                add("abrasive", f"{name}: abrasive ({why}) with no nozzle assignment at all{src}",
                    str(f.get("filamentId")))

    # PAIR SHAPE, ONCE, BEFORE ANY CONSUMER. A record whose two reads are not both
    # documents is reported and dropped here rather than guarded at each use: the
    # parents derivation below runs before the main loop, so an in-loop guard left
    # it exposed and a single malformed pair aborted the audit of every other
    # record — the failure this whole guard exists to prevent, one scope up.
    usable = {}
    for fid, v in records.items():
        rr = v.get("res") if isinstance(v, dict) else None
        rw = v.get("raw") if isinstance(v, dict) else None
        if isinstance(rr, dict) and isinstance(rw, dict):
            usable[fid] = v
        else:
            add("notchecked", f"filament {fid}: response was {type(rr).__name__}/"
                             f"{type(rw).__name__}, not two documents -> it was NOT audited",
                str(fid))
    records = usable

    # NORMALISE EVERY RECORD BEFORE AUDITING ANY OF THEM.
    #
    # These sweeps used to run per record inside the audit loop, which is only
    # sound while a record reads nothing but itself. It does not: the pin checks
    # read the record's PARENT, and iteration is name-ordered, so a variant
    # sorting before its template reached a template whose shapes had not been
    # swept yet and a malformed container there aborted the whole run. Doing
    # every record first makes the loop's "shapes are already safe" assumption
    # true for cross-record reads as well as self-reads.
    #
    # `coerced_by_fid` is keyed by record because these sets are BUILT here and
    # READ by the colour checks in a LATER loop. A bare loop-local left the FINAL
    # record's state standing in for every record: one non-string `color` on the
    # last row silently disabled the malformed-colour check for the whole
    # library, and a non-string `colorName` there disabled every #808080 sentinel
    # row. Leakage through a loop-local is invisible in any single-record test,
    # which is how it survived.
    coerced_by_fid = {}
    for fid, v in records.items():
        r, raw = v["res"], v["raw"]
        # For a standalone or a template the two reads are the same document, so
        # sweeping both would emit every shape finding twice. The duplicate
        # REPORTING is suppressed by `_seen_shape` below, which dedupes on
        # (category, identity) — an earlier revision compared the two documents
        # up front instead, and that comparison is gone; the raw doc is still
        # swept either way, because later passes read it.
        _seen_shape = set()
        # Text first: `name` is interpolated into every message, and
        # type/colorName are upper/lower-cased.
        def add_shape(cat, msg, ident):
            # Keyed on the message with the read marker removed, so ONE defect
            # present identically in both reads collapses to one row while two
            # genuinely different malformed values at the same path both report.
            # Whole-document equality was the wrong test: for a variant
            # the two reads always differ — inheritance and response metadata see
            # to that — so a locally stored defect was reported twice.
            key = (cat, ident, msg.replace(" (resolved)", "").replace(" (stored)", ""))
            if key in _seen_shape:
                return
            _seen_shape.add(key)
            add(cat, msg, str(fid))

        # `vendor`, `type` and `inherits` are inheritable, so a template's
        # malformed value arrives in every child's RESOLVED read. Suppress the
        # duplicate REPORT — never the coercion, which every later pass depends
        # on. name/color/colorName are VARIANT_ONLY and never appear here.
        _inh_text = r.get("_inherited")
        _inh_text = ({x for x in _inh_text if isinstance(x, str)}
                     if isinstance(_inh_text, (list, tuple)) else set())
        coerced_text = set()   # stored read — a "" here is the record's own
        coerced_res = set()    # resolved read — a "" here is this sweep's doing
        coerced_by_fid[fid] = (coerced_text, coerced_res)
        for doc, which in ((r, "resolved"), (raw, "stored")):
            for tf in TEXT_FIELDS:
                tv = doc.get(tf)
                if tv is not None and not isinstance(tv, str):
                    # Keyed on `which`, not `doc is raw`: if one object is ever
                    # passed for both reads, `doc is raw` is False on the first
                    # pass and the second already sees the coerced "", so the
                    # field would land in neither set.
                    (coerced_text if which == "stored" else coerced_res).add(tf)
                    if not (which == "resolved" and tf in _inh_text):
                        add_shape("physical", f"{_disp(r.get('name'))}: {tf} is "
                                              f"{type(tv).__name__}, not a string ({which}) -> "
                                              f"malformed; treated as empty", ("text", tf))
                    doc[tf] = ""
        for rf, trims in REQUIRED_TEXT.items():
            sv = raw.get(rf)
            # A non-string is already reported by the sweep above; reporting the
            # "" it was coerced to would be one defect wearing two rows.
            if rf in coerced_text:
                continue
            if sv is None:
                # Absent or null. Especially invisible on a variant, where the
                # resolved read inherits vendor/type from the template and looks
                # complete.
                add_shape("physical", f"{_disp(r.get('name'))}: {rf} is missing but the schema "
                                      f"requires it -> written by a path that bypassed validation",
                          ("required-text", rf))
                continue
            if not isinstance(sv, str):
                continue
            empty = (str(sv).strip() == "") if trims else (sv == "")
            if empty:
                how = "empty after trimming" if trims else "the empty string"
                add_shape("physical", f"{_disp(r.get('name'))}: {rf} is {how} but the schema "
                                      f"requires it -> written by a path that bypassed validation",
                          ("required-text", rf))
        nm = r.get("name") or "?"
        for doc, which in ((r, "resolved"), (raw, "stored")):
            _inh_here = v["res"].get("_inherited")
            _inh_here = ({x for x in _inh_here if isinstance(x, str)}
                         if isinstance(_inh_here, (list, tuple)) else set())
            for cf, want in CONTAINER_SHAPES.items():
                cv = doc.get(cf)
                if cv is not None and not isinstance(cv, want):
                    # SUPPRESS THE REPORT, NEVER THE COERCION. A template's
                    # malformed inheritable container arrives verbatim in every
                    # child's resolved read — resolveFilament copies the array
                    # wholesale, and `"31"?.length` is 2 so a STRING passes its
                    # non-empty test — and the template reports its own copy, so
                    # a child reporting it again duplicates one defect. But every
                    # later pass assumes these shapes are safe: skipping the
                    # coercion left a string in `optTags` and crashed the entire
                    # run, and iterated `spools`/`calibrations`/`presets`
                    # character by character. The value is in THIS document
                    # whoever owns it, so it is always made safe.
                    if not (which == "resolved" and cf in _inh_here):
                        add_shape("physical", f"{nm}: {cf} is {type(cv).__name__}, not a "
                                              f"{want.__name__} ({which}) -> malformed; treated as "
                                              f"empty", ("container", cf))
                    doc[cf] = want()
            # Elements of the subdocument arrays must themselves be documents.
            # Same suppression rule as the container sweep above, for the same
            # reason one level down: `calibrations: ["oops"]` on a template has a
            # perfectly good CONTAINER shape, so the guard above never fires, and
            # resolveFilament hands the whole array to every child that stores an
            # empty one -- so the element row fanned out across the family,
            # naming documents that cannot repair it. `_inherited` is
            # resolveFilament's own report of which arrays came from the
            # template, so this can never mis-suppress a variant-owned array.
            for parent_key in DICT_ELEMENT_ARRAYS:
                _inh_arr = which == "resolved" and parent_key in _inh_here
                for idx, sub in enumerate(doc.get(parent_key) or []):
                    if not isinstance(sub, dict) and not _inh_arr:
                        add_shape("physical", f"{nm}: {parent_key}[{idx}] is "
                                              f"{type(sub).__name__} ({sub!r}), not a subdocument "
                                              f"({which}) -> that entry is skipped by every check",
                                  ("element", parent_key, idx))

            # …and the containers one level down, in every list that has them.
            for parent_key, subshapes in NESTED_CONTAINER_SHAPES.items():
                # As above: an inherited array's contents belong to the template.
                # Suppresses the REPORTS only -- every coercion below still runs,
                # because this document is the one the later passes read.
                # Applied to EVERY sweep in this block, not only the ones whose
                # table currently lists an inheritable key: today the nested
                # text/bool/ledger tables are keyed on `spools` alone, which is
                # VARIANT_ONLY and can never be inherited, so those guards are
                # inert -- but three separate review rounds each found the NEXT
                # unguarded site in this file, and a uniform invariant is what
                # stops the fan-out returning silently the day an inheritable
                # array is added to one of those tables.
                _inh_arr = which == "resolved" and parent_key in _inh_here
                for idx, sub in enumerate(doc.get(parent_key) or []):
                    if not isinstance(sub, dict):
                        continue
                    tag = sub.get("instanceId") or sub.get("label") or sub.get("_id") or idx
                    for sf, swant in subshapes.items():
                        sv = sub.get(sf)
                        if sv is not None and not isinstance(sv, swant):
                            if not _inh_arr:
                                add_shape("physical", f"{nm}: {parent_key}[{tag}] {sf} is "
                                                      f"{type(sv).__name__}, not a "
                                                      f"{swant.__name__} ({which}) -> malformed; "
                                                      f"treated as empty",
                                          ("nested", parent_key, str(tag), sf))
                            sub[sf] = swant()
                    # …and the ELEMENTS of those nested lists. Reported, never
                    # removed: the wording promises the entry is skipped, and the
                    # audit stays non-mutating beyond the container coercions.
                    for tf2 in NESTED_TEXT_FIELDS.get(parent_key, ()):
                        tv2 = sub.get(tf2)
                        if tv2 is not None and not isinstance(tv2, str) and not _inh_arr:
                            add_shape("physical",
                                      f"{nm}: {parent_key}[{tag}].{tf2} is {type(tv2).__name__} "
                                      f"({tv2!r}), not a string ({which}) -> "
                                      f"{_nested_text_consequence(tf2, tv2)}",
                                      ("nested-text", parent_key, str(tag), tf2))
                    for bf in NESTED_BOOL_FIELDS.get(parent_key, ()):
                        bv = sub.get(bf)
                        if bv is not None and not isinstance(bv, bool) and not _inh_arr:
                            add_shape("physical",
                                      f"{nm}: {parent_key}[{tag}].{bf} is {type(bv).__name__} "
                                      f"({bv!r}), not a boolean ({which}) -> the app tests it by "
                                      f"truthiness, so this spool may be silently excluded from "
                                      f"the count, the gram total and the % bar",
                                      ("nested-bool", parent_key, str(tag), bf))
                    for sf in NESTED_DICT_ELEMENT_ARRAYS.get(parent_key, ()):
                        for eidx, ent in enumerate(sub.get(sf) or []):
                            if not isinstance(ent, dict):
                                if not _inh_arr:
                                    add_shape("physical",
                                              f"{nm}: {parent_key}[{tag}] {sf}[{eidx}] is "
                                              f"{type(ent).__name__} ({ent!r}), not a "
                                              f"subdocument ({which}) -> that entry is skipped "
                                              f"by every check",
                                              ("nested-element", parent_key, str(tag), sf, eidx))
                                continue
                            for lf in LEDGER_TEXT_FIELDS.get((parent_key, sf), ()):
                                lv = ent.get(lf)
                                if lv is not None and not isinstance(lv, str) and not _inh_arr:
                                    # `jobLabel` IS a React child (the usage
                                    # disclosure renders `{u.jobLabel || …}`) but
                                    # only an object throws there; `notes` has no
                                    # render site anywhere in the app, so the
                                    # crash sentence was false for it outright.
                                    if lf == "jobLabel" and _react_child_throws(lv):
                                        _lc = ("the usage disclosure renders it as a React child, "
                                               "so React throws on this object and expanding the "
                                               "history fails")
                                    elif isinstance(lv, (dict, list)):
                                        _lc = ("Mongoose's String cast refuses it, so POST "
                                               "/api/snapshot refuses the ENTIRE backup file")
                                    else:
                                        _lc = ("the schema declares a string and Mongoose casts "
                                               "this on the next write, so nothing breaks — the "
                                               "stored value simply is not the declared type")
                                    add_shape("physical",
                                              f"{nm}: {parent_key}[{tag}] {sf}[{eidx}].{lf} is "
                                              f"{type(lv).__name__} ({lv!r}), not a string "
                                              f"({which}) -> {_lc}",
                                              ("ledger-text", parent_key, str(tag), sf, eidx, lf))
        # optTags ELEMENT validity. The container check above accepts a list of
        # anything, but the schema's setter and the CBOR encoder both keep only
        # non-negative integers, and the app's abrasive audit matches tags
        # against a Set<number> — so a string "31" from a raw sync or a restore
        # is silently dropped from the tag encoding AND misses the carbon-fibre
        # wear check, in a category where a miss means a ruined nozzle.
        _inh_tags = v["res"].get("_inherited")
        _inh_tags = ({x for x in _inh_tags if isinstance(x, str)}
                     if isinstance(_inh_tags, (list, tuple)) else set())
        for doc, which in ((r, "resolved"), (raw, "stored")):
            badtags = [t for t in (doc.get("optTags") or []) if not _encodable_opt_tag(t)]
            # `optTags` is a whole-array inheritable (GH #477), so a template's
            # bad tag arrives in every child's RESOLVED read. The child stores an
            # empty array, so "store them as non-negative integers" would have it
            # create a local override instead of repairing the source.
            if badtags and not (which == "resolved" and "optTags" in _inh_tags):
                add_shape("physical", f"{nm}: optTags contains non-encodable {badtags!r} "
                                      f"({which}) -> dropped by the tag encoder and invisible to "
                                      f"the abrasive check; store them as non-negative integers",
                          ("optTags", repr(badtags)))

    # Template-ness is DERIVED from having variants — there is no schema flag.
    # Restricted to ids that are actually present: an active variant can point at
    # a missing or soft-deleted parent, and counting that absent id would report a
    # template that does not exist (the structural check below reports the
    # dangling link itself).
    parents = {str(v["raw"]["parentId"]) for v in records.values()
               if v["raw"].get("parentId") and str(v["raw"]["parentId"]) in records}
    # A template whose ONLY variant failed its detail read would otherwise be
    # reclassified as a standalone — inviting false missing-core and nozzle
    # findings and skipping its template-state checks. The listing already
    # carries the topology, so trust it when a child could not be loaded.
    for lid, flag in (listing_topology or {}).items():
        if flag and lid in records:
            parents.add(lid)

    for fid, v in records.items():
        r, raw = v["res"], v["raw"]
        name = r.get("name") or "?"
        is_template = fid in parents
        # resolveFilament reports which fields this row resolved from its parent
        # (src/lib/resolveFilament.ts). Absent for standalones and templates, and
        # in exactly those cases nothing is inherited, so "absent means empty" is
        # safe. Used to attribute a finding to the document that can be FIXED.
        _inh = r.get("_inherited")
        inherited_fields = ({x for x in _inh if isinstance(x, str)}
                            if isinstance(_inh, (list, tuple)) else set())
        _ppid = str(raw["parentId"]) if raw.get("parentId") else None
        parent_name = (records.get(_ppid, {}).get("res", {}).get("name")
                       if _ppid else None) or "its template"

        def _inh_blame(*roots):
            """Attribution for any inheritable field, by its `_inherited` root.

            Every emit site that reports a VALUE needs this: a variant inheriting
            a bad value stores nothing, so naming it as the owner is false and
            points the repair at the one document that cannot make it. Review
            found this site by site — temperatures, then bounds, then malformed
            numerics, then ordering and density — so it is now one helper applied
            at every value-based emission.
            """
            named = [x for x in roots if x and x not in ALWAYS_STORED_ROOTS]
            # A whole-array inheritable resolves by FALLBACK: an empty stored
            # array IS the inherit sentinel (resolveFilament), and such a field
            # may be absent from `_inherited` simply because the template's
            # array is empty too. Treating it as "stored here" gave the ordinary
            # variant shape a false MIXED clause telling the reader the value
            # lives on a row that does not carry it. It is neither inherited nor
            # owned, so it is dropped from consideration entirely.
            named = [x for x in named
                     if not (x in PIN_CHECK_ARRAYS and x not in inherited_fields
                             and not raw.get(x))]
            inh = [x for x in named if x in inherited_fields]
            if not inh:
                return ""
            if len(inh) == len(named):
                return (f" -> INHERITED from template {parent_name!r}; fix it there or every "
                        f"variant keeps it")
            # MIXED ownership. `any()` blamed the template wholesale, but the
            # remedy differs: for a local minPrintSpeed against an inherited max,
            # editing the template changes every sibling and leaves the offending
            # local value in place. Name both sides and let the reader choose.
            local = [x for x in named if x not in inherited_fields]
            return (f" -> MIXED: {', '.join(inh)} inherited from template {parent_name!r} while "
                    f"{', '.join(local)} is stored here — correcting the template would change "
                    f"every sibling, so fix whichever value is actually wrong")

        def _temp_root(label):
            """The `_inherited` root that owns a collected temperature."""
            if label.startswith("calibration["):
                return "calibrations"
            if label.startswith("preset["):
                return "presets"
            if label.startswith("bedTypeTemps["):
                return "bedTypeTemps"
            return f"temperatures.{label}"

        def _temp_blame(label):
            return _inh_blame(_temp_root(label))

        temps = r.get("temperatures") or {}
        all_spools = r.get("spools") or []
        live_spools = [s for s in all_spools if isinstance(s, dict) and not s.get("retired")]

        # Then every numeric-named leaf at any depth, reported ONCE here so the
        # individual passes can skip quietly.
        # Both reads: resolveFilament treats "" as an inheritance sentinel and
        # substitutes the parent's number, so a variant storing `cost: ""` looks
        # perfectly valid in the resolved response and only `raw` reveals it.
        # Deduped on (path, value) so a defect visible in both is one row.
        _seen_num = set()
        for where_path, badv, which_read in (
                [(p_, v_, "resolved") for p_, v_ in malformed_numerics(r)]
                + [(p_, v_, "stored") for p_, v_ in malformed_numerics(raw)]):
            if (where_path, repr(badv)) in _seen_num:
                continue
            _seen_num.add((where_path, repr(badv)))
            # A template storing a bad inheritable value appears in EVERY child's
            # resolved read, so reporting it per child duplicates one defect across
            # the family and points at rows that store null and cannot fix it. The
            # template audits its own copy, so the child stays quiet — the same
            # attribution the bounds path makes explicit via `_blame`.
            # Strip array indices before matching: the traversal yields
            # `calibrations[0].fanMinSpeed` while `_inherited` records the root as
            # `calibrations`, so a bare split on "." left every inheriting child
            # reporting a defect only its template can repair.
            plain = re.sub(r"\[\d+\]", "", where_path)
            # Only the RESOLVED read can be showing a value the row does not own.
            # A defect found in the STORED read is this record's own by
            # definition — and that is exactly the `cost: ""` case, where the
            # variant's malformed value is invisible in the resolved response
            # because resolveFilament read it as an inheritance sentinel.
            if which_read == "resolved" and (
                    where_path in inherited_fields or plain in inherited_fields
                    or plain.split(".")[0] in inherited_fields):
                continue
            add("physical", f"{name}: {where_path} is {type(badv).__name__} ({_short(repr(badv))}), not a "
                            f"number ({which_read}) -> malformed; checks on it are skipped", fid)

        # (legacy note) density/diameter are covered by the sweep above too.

        # --- settings bag shape ----------------------------------------------
        # `settings` is Mixed, so a legacy row can hold a string or an array.
        # Checked for EVERY record, not just variants: resolveFilament spreads a
        # parent's bag into each child's effective settings, so a malformed one on
        # a template reaches every colour in the family and its slicer exports,
        # and a standalone never enters the pin block at all.
        # Shape is reported and coerced by the sweep at the top of the loop, on
        # BOTH reads; only the SIZE limits remain here.
        own_settings = raw.get("settings")
        if isinstance(own_settings, dict):
            if len(own_settings) > MAX_SETTINGS_KEYS:
                add("physical", f"{name}: settings holds {len(own_settings)} keys, past the "
                                f"{MAX_SETTINGS_KEYS}-key limit validateSettingsBag enforces -> "
                                f"bloats every detail read and export", fid)
            for k, v in own_settings.items():
                # validateSettingsBag measures JSON.stringify(value ?? null), so a
                # string's quotes and escapes COUNT: 10,001 quote characters
                # measure as 10,001 raw but serialise to 20,004 and are rejected.
                text = _js_stringify(v)
                # JavaScript's String.length counts UTF-16 CODE UNITS, so a
                # non-BMP character (emoji) counts 2 where Python's len() counts
                # 1: 10,000 emoji measure 10,002 here and 20,002 in the app.
                # The helper, not a second inline copy of the same expression:
                # its `surrogatepass` is what keeps a lone surrogate (legal in
                # JSON, and JS counts it as one unit) from aborting the run.
                measured = _utf16_len(text)
                # The bag is FLAT by contract — a slicer key mapping to a scalar,
                # or since #678 an array of scalars. validateSettingsBag checks
                # only object-ness, the key count and the serialised LENGTH, so an
                # OBJECT value is accepted by the ordinary write and then
                # String()-coerced by every emitter, exporting as the literal
                # "[object Object]" into both the INI bundle and the Orca JSON —
                # silently, in the bag whose whole purpose is lossless round-trip.
                # `String()` on a nested ARRAY joins with commas -- it does
                # not produce "[object Object]". Only an object does that, so
                # the two ship differently and a reader grepping the export for
                # "[object Object]" would never find the array case.
                _nested_obj = isinstance(v, dict) or (isinstance(v, list)
                                                      and any(isinstance(e, dict) for e in v))
                _nested_arr = isinstance(v, list) and any(isinstance(e, list) for e in v)
                if _nested_obj or _nested_arr:
                    _sc = ("ships as the literal '[object Object]'" if _nested_obj else
                           "ships with its elements comma-JOINED (String([0.8, 0.9]) is "
                           "'0.8,0.9'), which a re-import then reads back as one scalar "
                           "containing commas — silently, with no [object Object] to grep for")
                    add("physical", f"{name}: settings.{k} is a {type(v).__name__}, but the bag "
                                    f"holds scalars (or an array of scalars) -> every exporter "
                                    f"String()-coerces it, so it {_sc}", fid)
                if measured > MAX_SETTING_VALUE_LENGTH:
                    add("physical", f"{name}: settings.{k} is {measured} UTF-16 units, past the "
                                    f"{MAX_SETTING_VALUE_LENGTH}-character limit", fid)

        # A settings-bag `compatible_printers_condition` is the #1066 defect:
        # PrusaSlicer evaluates it as a hard VISIBILITY filter, so a preset
        # duplicated in the slicer from another printer's profile carries that
        # printer's condition in and the synced preset then appears on NO other
        # machine — silently, with no in-app cause. Read from the STORED bag, so
        # a variant that merely inherits the pin has no own key and the row
        # lands on the template that can clear it.
        _own_bag = raw.get("settings")
        if isinstance(_own_bag, dict):
            for _pk in ("compatible_printers_condition", "compatible_printers"):
                _pv = _own_bag.get(_pk)
                if isinstance(_pv, str) and _pv.strip():
                    add("structure", f"{name}: settings.{_pk} pins {_pv!r} -> PrusaSlicer treats "
                                     f"this as a hard visibility filter, so the exported preset is "
                                     f"HIDDEN on every printer that fails it, with nothing in the "
                                     f"slicer to say why. It is editable on the form's Slicer tab; "
                                     f"clearing it means writing an explicit empty string, not "
                                     f"deleting the key (a null is PrusaSlicer's inherit marker)",
                        fid)

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
            _raw_net = r.get("netFilamentWeight")
            net = num(_raw_net)
            # Claim "absent" only when it IS absent: a present-but-malformed
            # value is named by the central sweep, and saying the field is
            # missing would be a false statement about the record.
            if _raw_net is None or (net is not None and net <= 0):
                add("inventory", f"{name}: {unit} but netFilamentWeight={_raw_net!r} -> no % bar"
                                 f"{_inh_blame('netFilamentWeight')}", fid)
            _raw_tare = r.get("spoolWeight")
            tare = num(_raw_tare)
            if _raw_tare is None:
                # NOT "nothing displays": getRemainingGrams substitutes a 0 g
                # tare (inventoryStats.ts), so the list still shows a gram
                # figure — one that silently counts the empty spool's own mass
                # as filament. What is actually lost is the percentage bar,
                # which needs the tare as its denominator.
                add("inventory", f"{name}: {unit} but no spoolWeight (tare) -> no % bar, and the "
                                 f"gram figure counts the spool's own mass as filament"
                                 f"{_inh_blame('spoolWeight')}", fid)

            def _below_tare_slack(t):
                """How far under the tare is still just a finished roll."""
                return max(BELOW_TARE_TOLERANCE_G, BELOW_TARE_TOLERANCE_FRAC * t)

            # `_diag` names the two causes that actually produce a LARGE
            # shortfall. The template clause is dropped on a row that has no
            # parent, where it is impossible by construction.
            _diag = ("a net weight typed into the gross field"
                     if not raw.get("parentId") else
                     "a tare inherited from a template whose spools are heavier, or a net weight "
                     "typed into the gross field")

            if legacy_roll:
                gross = num(r.get("totalWeight"))
                if (tare is not None and gross is not None
                        and tare - gross > _below_tare_slack(tare)):
                    add("inventory", f"{name}: legacy gross {gross}g is below tare {tare}g by "
                                     f"{tare - gross:.0f}g -> clamps to 0, so the roll reads as "
                                     f"EMPTY everywhere and spool-check refuses every job — "
                                     f"usually {_diag}{_inh_blame('spoolWeight')}", fid)
            else:
                missing_gross = 0
                for s in live_spools:
                    gross = num(s.get("totalWeight"))
                    # `num()` answers None for present-but-malformed as well as
                    # absent, and the numeric sweep has already named the
                    # off-type value — so reporting "has no totalWeight" here
                    # contradicts it, and letting it feed missing_gross could
                    # add a second contradictory "every live spool is missing
                    # its gross weight" on top.
                    _g_absent = s.get("totalWeight") in (None, "")
                    if gross is None and not _g_absent:
                        continue
                    if gross is None:
                        # Schema-supported, but getRemainingPct skips such a spool
                        # and returns null outright when none is left countable.
                        missing_gross += 1
                        add("inventory", f"{name}: live spool {s.get('instanceId') or s.get('_id')} has no "
                                         f"totalWeight (gross) -> it contributes nothing to the bar", fid)
                    elif (tare is not None
                          and tare - gross > _below_tare_slack(tare)):
                        # NOT the legacy roll's consequence. getRemainingPct
                        # clamps this spool's contribution to 0 but STILL counts
                        # it in validCount, so it adds a whole `net` to the
                        # denominator while adding nothing to the numerator --
                        # it drags the filament's bar down rather than emptying
                        # it. And spool-check answers ok when ANY spool has
                        # enough, so with a healthy sibling no job is refused.
                        # getRemainingPct counts only spools that CARRY a gross
                        # weight (validCount), and spool-check likewise needs a
                        # sibling with one -- so the branch is the weighed count,
                        # not the live count. And the denominator sentence only
                        # means anything when a net weight exists; without one
                        # there is no bar at all (its own row says so).
                        _weighed = sum(1 for _s in live_spools
                                       if num(_s.get("totalWeight")) is not None)
                        if _weighed <= 1:
                            _conseq = ("so the filament reads as EMPTY and spool-check refuses "
                                       "every job")
                        elif net is not None and net > 0:
                            _conseq = (f"so it contributes 0g yet still adds {int(net)}g to the % "
                                       f"denominator — it drags the whole filament's bar down")
                        else:
                            _conseq = ("so it contributes 0g to the gram total; there is no % bar "
                                       "to drag down because no net weight is set")
                        add("inventory", f"{name}: spool {_short(s.get('instanceId') or s.get('_id'))} "
                                         f"gross {gross}g is below tare {tare}g by "
                                         f"{tare - gross:.0f}g -> clamps to 0, {_conseq} — "
                                         f"usually {_diag}{_inh_blame('spoolWeight')}", fid)
                if missing_gross and missing_gross == len(live_spools):
                    add("inventory", f"{name}: every live spool is missing its gross weight -> "
                                     f"getRemainingPct returns null, no bar at all", fid)

            # Saturation is the mirror of the below-tare case and is easy to
            # miss precisely because it looks healthy: the bar reads 100%.
            # Reproduce getRemainingPct's arithmetic EXACTLY -- numerator
            # sum(max(0, gross - tare)) over live spools that carry a gross,
            # denominator net * that same count (NOT net alone; with three
            # spools the denominator is 3x net, and comparing against one net
            # would report every healthy multi-spool filament).
            if net is not None and net > 0 and tare is not None:
                if legacy_roll:
                    _gross = num(r.get("totalWeight"))
                    _numer = max(0.0, _gross - tare) if _gross is not None else None
                    _denom = net
                    _scope = "the roll holds"
                else:
                    _numer, _valid = 0.0, 0
                    for s in live_spools:
                        _g = num(s.get("totalWeight"))
                        if _g is not None:
                            _numer += max(0.0, _g - tare)
                            _valid += 1
                    _denom = net * _valid if _valid else None
                    _scope = f"{_valid} weighed spool(s) hold"
                if _numer is not None and _denom:
                    _ratio = _numer / _denom
                    if _ratio > OVER_NET_TOLERANCE:
                        add("inventory", f"{name}: {_scope} {_numer:.0f}g of filament against a "
                                         f"{_denom:.0f}g net capacity ({_ratio * 100:.0f}%) -> "
                                         f"getRemainingPct clamps with Math.min(100, ...), so the "
                                         f"bar SATURATES at 100% and cannot move until "
                                         f"{_numer - _denom:.0f}g is consumed; the low-stock "
                                         f"threshold is measured against the same inflated figure. "
                                         f"Either netFilamentWeight is set too low for this spool "
                                         f"size or the tare is too small"
                                         f"{_inh_blame('netFilamentWeight', 'spoolWeight')}", fid)

        # --- drying: the field is minutes, every datasheet says hours --------
        dry_t, dry_temp = num(r.get("dryingTime")), num(r.get("dryingTemperature"))
        # Gated on a drying TEMPERATURE being present: without it, a small value
        # may be a deliberate duration rather than an hours-for-minutes slip, and
        # this is the documented heuristic.
        if isinstance(dry_t, (int, float)) and 0 < dry_t <= 24 and dry_temp is not None:
            add("drying-units", f"{name}: dryingTime={dry_t} at {dry_temp}C — the field is "
                                f"MINUTES; {dry_t} hours would be {int(dry_t * 60)}"
                                f"{_inh_blame('dryingTime', 'dryingTemperature')}", fid)

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
        noz, lo, hi, bed = (num(temps.get("nozzle")), num(temps.get("nozzleRangeMin")),
                            num(temps.get("nozzleRangeMax")), num(temps.get("bed")))
        nfl, bfl = num(temps.get("nozzleFirstLayer")), num(temps.get("bedFirstLayer"))
        def ordering_check(container, pairs, cat, where="", inherit_prefix="", inherit_root=""):
            if not isinstance(container, dict):
                return
            for label, f_lo, f_hi in pairs:
                # num() rather than isinstance: Python counts bool as int, so
                # `minPrintSpeed: true` / `maxPrintSpeed: false` compared as 1 > 0
                # and added an INVERTED claim on top of the malformed-value rows
                # the sweep had already emitted — asserting an ordering between
                # two values it had just said were not numbers.
                a, b = num(container.get(f_lo)), num(container.get(f_hi))
                if a is not None and b is not None and a > b:
                    blame = (_inh_blame(inherit_root) if inherit_root
                             else _inh_blame(inherit_prefix + f_lo, inherit_prefix + f_hi))
                    add(cat, f"{name}: {where}INVERTED {label} — {f_lo}={a} is above {f_hi}={b}{blame}", fid)

        # tdsUrl is checked on the STORED read only. It is inheritable, so the
        # resolved read carries the TEMPLATE's value on every colour variant and
        # a single bad URL on a template would be reported once per child, each
        # naming a document the user cannot fix it on.
        # The scalar-string sweep catches a NON-STRING top-level instanceId,
        # but "" and null pass it and the identity pass indexes non-empty
        # strings only — the same two-way gap the spool id had. Here the
        # consequence is sharper: with no spools to fall back FROM,
        # selectSpoolForWrite has neither a spool id nor the filament fallback.
        _tid_v = raw.get("instanceId")
        if _tid_v is None or _tid_v == "":
            _no_spool_id = not any(
                isinstance(_s, dict) and isinstance(_s.get("instanceId"), str)
                and _s.get("instanceId")
                for _s in (raw.get("spools") or []))
            _tid_cons = ("selectSpoolForWrite has neither a spool id nor this fallback, so "
                         "GET /api/filaments/{id}/openprinttag answers 422 and no tag can be "
                         "written for this filament at all" if _no_spool_id else
                         "its spools still carry their own ids so tag writes keep working, but "
                         "the transitional filament-level fallback every pre-#732 label and tag "
                         "relies on is gone")
            add("structure", f"{name}: no filament-level instanceId -> {_tid_cons}. The schema "
                             f"defaults it and a startup backfill mints one, so a row still "
                             f"missing it was written by a path that bypassed the model", fid)
        else:
            # The same consumer bounds apply to the filament-level fallback:
            # selectSpoolForWrite hands THIS value to the tag encoder for a
            # spool-less filament, so an id past either ceiling cannot round-trip
            # even though it is present and looks fine.
            _tid_bad = _id_contract_problem(_tid_v)
            if _tid_bad:
                add("structure", f"{name}: filament-level instanceId {_short(repr(_tid_v))} "
                                 f"{_tid_bad}", fid)

        _tds = raw.get("tdsUrl")
        if _tds is not None and not isinstance(_tds, str):
            # `_bad_tds_url` judges URL GRAMMAR and answers False for a
            # non-string, and tdsUrl is not in the scalar-string sweep, so this
            # shape had no check at all. A plain object is the definite case:
            # Mongoose's String cast refuses a value whose only toString is
            # Object.prototype's, so the restore fails outright. Everything else
            # casts through its own toString and then faces the URL validator,
            # which the result will almost never satisfy.
            _cast = ("Mongoose's String cast refuses a plain object outright, so POST "
                     "/api/snapshot rejects the ENTIRE backup file"
                     if isinstance(_tds, dict) else
                     "Mongoose casts it through its own toString and then applies the http(s) "
                     "validator to the result, so the backup is refused unless that string "
                     "happens to be a valid URL")
            add("structure", f"{name}: tdsUrl is {type(_tds).__name__} ({_tds!r}), not a string -> "
                             f"the detail page's safeHttpUrl gets a non-string and renders no TDS "
                             f"link, and {_cast}{_inh_blame('tdsUrl')}", fid)
        elif _bad_tds_url(_tds):
            add("structure", f"{name}: tdsUrl {_tds!r} is not a valid http(s) URL -> the model's "
                             f"validator rejects it, so POST /api/snapshot refuses the ENTIRE "
                             f"backup file; the detail page also renders no link for it", fid)

        ordering_check(temps, ORDERED_PAIRS, "temps", inherit_prefix="temperatures.")
        ordering_check(r, ORDERED_PAIRS_TOP, "physical")   # roots are bare, prefix empty

        nozzle_like = [("nozzle", noz), ("nozzleFirstLayer", nfl)]
        bed_like = [("bed", bed), ("bedFirstLayer", bfl)]

        # REFERENCE INTEGRITY walks the STORED array; the VALUE checks below
        # deliberately walk the resolved one. A variant that inherits
        # `calibrations` carries the template's array verbatim, so reporting a
        # dead ref off the resolved read named one defect once per inheriting
        # variant, at an index that variant does not store — the same fan-out
        # already fixed for the container and element sweeps. The ?raw=true
        # response populates these refs too, so this costs no extra fetch, and
        # with the emits keyed to the storing document `_inh_blame` is
        # unreachable here and deliberately absent.
        for idx, cal in enumerate(raw.get("calibrations") or []):
            if not isinstance(cal, dict):
                continue
            nz = cal.get("nozzle")
            noz_name = nz.get("name") if isinstance(nz, dict) else None
            if nz is None:
                add("structure", f"{name}: calibration[{idx}] references a nozzle that no longer "
                                 f"exists -> populate() answers null for it, so /calibration cannot "
                                 f"diameter-match this row and the Prusa fan-out drops it: the "
                                 f"tuning is genuinely unreachable", fid)
            elif isinstance(nz, dict) and nz.get("_deletedAt"):
                # NOT the purged case's consequence. A soft-deleted nozzle
                # populates as a FULL document that still carries its
                # `diameter`, and neither consumer filters tombstones:
                # /calibration's diameter filter has no `_deletedAt` clause
                # (it filters the PRINTER explicitly, which shows the omission
                # is not incidental) and the Prusa fan-out drops only a
                # null/diameter-less nozzle. So the tuning is still SERVED and
                # still EXPORTED — what is lost is the ability to edit it.
                add("structure", f"{name}: calibration[{idx}] references soft-deleted nozzle "
                                 f"{noz_name!r} -> /calibration and the slicer exports still serve "
                                 f"this tuning (neither filters tombstoned nozzles), but the "
                                 f"nozzle is gone from the active catalogue, so the row drops out "
                                 f"of the FilamentForm grid into the orphan list and can only be "
                                 f"removed, not corrected", fid)
            # `printer` and `bedType` are `default: null`, unlike the required
            # nozzle above, so null is the schema's supported "generic" state and
            # must NOT be reported. A TOMBSTONED ref is reported -- but each of
            # the two fails DIFFERENTLY, and neither is "unreachable".
            for ref_field in ("printer", "bedType"):
                rv = cal.get(ref_field)
                if isinstance(rv, dict) and rv.get("_deletedAt"):
                    _rn = rv.get("name") or rv.get("_id")
                    if ref_field == "printer":
                        _rc = ("`?printer=` filters tombstoned printers out of the addressable "
                               "set, so this row can no longer be selected by machine and the "
                               "lookup falls back to a generic entry; the FilamentForm also has "
                               "no tab for a deleted printer, so the row lands in the orphan list")
                    else:
                        _rc = ("the bed lookup matches by NAME, so /calibration and the exports "
                               "still serve this tuning — but isCalibrationRowReachable has no tab "
                               "for a bed type missing from the active catalogue, so the row lands "
                               "in the FilamentForm orphan list and can only be removed")
                    add("structure", f"{name}: calibration[{idx}] references soft-deleted "
                                     f"{ref_field} {_rn!r} -> {_rc}", fid)

        for idx, cal in enumerate(r.get("calibrations") or []):
            if not isinstance(cal, dict):
                continue
            nz = cal.get("nozzle")
            noz_name = nz.get("name") if isinstance(nz, dict) else None
            where = f"calibration[{idx}]" + (f" ({noz_name})" if noz_name else "")
            # Reference integrity is handled by the STORED-array loop above;
            # this loop is VALUES ONLY, and reads the resolved document on
            # purpose — a variant exports the temperatures and calibration
            # values it inherits, so those legitimately follow the child.
            # `printer` and `bedType` are NOT checked here, and cannot be:
            # their null is the supported "generic" state, and BOTH reads
            # populate them (the detail route runs one populated query for raw
            # and resolved alike), so a purged target and a genuine generic are
            # indistinguishable in this loop. They are checked instead by the
            # calibration-scope pass at the end of audit(), against the
            # UNPOPULATED ids from /api/snapshot — the only read that carries
            # them. Keyed by the document that STORES the array, so an inherited
            # calibrations array is not re-reported against every child.
            ordering_check(cal, ORDERED_PAIRS_CAL, "physical", f"{where} ", inherit_root="calibrations")
            nozzle_like += [(f"{where} nozzleTemp", num(cal.get("nozzleTemp"))),
                            (f"{where} nozzleTempFirstLayer", num(cal.get("nozzleTempFirstLayer")))]
            bed_like += [(f"{where} bedTemp", num(cal.get("bedTemp"))),
                         (f"{where} bedTempFirstLayer", num(cal.get("bedTempFirstLayer")))]
            chamber = num(cal.get("chamberTemp"))
            if chamber is not None and not 0 <= chamber <= CHAMBER_MAX:
                add("temps", f"{name}: {where} chamberTemp {chamber}C outside 0-{CHAMBER_MAX}C"
                             f"{_temp_blame('calibration[')}", fid)

        # Per-plate overrides: filamentToOrcaSlicerKeys writes BOTH temperature
        # and firstLayerTemperature from this array into the exported preset,
        # overriding the otherwise-valid base values.
        for idx_bt, bt in enumerate(r.get("bedTypeTemps") or []):
            if not isinstance(bt, dict):
                continue
            plate_raw = bt.get("bedType")
            if not isinstance(plate_raw, str) or not plate_raw.strip():
                # `bedType` is schema-required, and orcaSlicerBundle indexes
                # BED_TYPE_KEY_MAP with it — so a missing or blank key silently
                # drops this row's temperatures from the exported preset.
                add("physical", f"{name}: bedTypeTemps[{idx_bt}] has no usable bedType "
                                f"({plate_raw!r}) -> the schema requires it and the Orca export "
                                f"indexes on it, so these temperatures are silently dropped"
                                f"{_inh_blame('bedTypeTemps')}", fid)
            else:
                # ONLY a case/whitespace twin of a canonical key is reported.
                # `bedType` is deliberately FREE TEXT (Filament.ts: "holds a
                # slicer bed-surface key", and its own example "Textured PEI" is
                # PrusaSlicer's vocabulary, not Orca's), and `bedTypeTempRefFilter`
                # matches it against user-created BedType NAMES — so there is no
                # closed vocabulary to check against, and an "expected one of
                # [...]" row would condemn every legitimate surface the user
                # named. A twin is different: it case-folds onto a key the
                # export DOES recognise, which no vocabulary explains and a
                # rename certainly fixes.
                _near = next((k for k in ORCA_PLATE_KEYS
                              if k.strip().casefold() == plate_raw.strip().casefold()
                              and k != plate_raw), None)
                if _near:
                    add("physical", f"{name}: bedTypeTemps[{idx_bt}] bedType {plate_raw!r} differs "
                                    f"from {_near!r} only by case/whitespace -> the Orca/Bambu "
                                    f"export indexes BED_TYPE_KEY_MAP by EXACT string with no "
                                    f"fallback, so these temperatures are dropped; rename it to "
                                    f"{_near!r}{_inh_blame('bedTypeTemps')}", fid)
            plate = plate_raw if isinstance(plate_raw, str) and plate_raw.strip() else "?"
            bed_like += [(f"bedTypeTemps[{plate}] temperature", num(bt.get("temperature"))),
                         (f"bedTypeTemps[{plate}] firstLayerTemperature", num(bt.get("firstLayerTemperature")))]

        for idx, pre in enumerate(r.get("presets") or []):
            if not isinstance(pre, dict):
                continue
            _plabel = pre.get("label")
            # THREE different states, and they do not fail the same way. The
            # schema declares `label: {type: String, required: true}` with NO
            # `trim`, so "   " is a perfectly valid document and React renders a
            # whitespace child without complaint -- calling that a crash was a
            # false alarm on the loudest kind of row.
            if _plabel is None or _plabel == "":
                add("physical", f"{name}: presets[{idx}].label is {_plabel!r} -> `label` is "
                                f"schema-REQUIRED, so POST /api/snapshot refuses the ENTIRE "
                                f"backup file{_inh_blame('presets')}", fid)
            elif _react_child_throws(_plabel):
                add("physical", f"{name}: presets[{idx}].label is {type(_plabel).__name__} "
                                f"({_plabel!r}) -> the detail page renders it directly as a React "
                                f"child, and React throws on an object, so opening this filament "
                                f"fails outright{_inh_blame('presets')}", fid)
            elif not isinstance(_plabel, str):
                # A number or boolean is off-type but harmless: React renders it,
                # and Mongoose casts it through the schema's String path, so the
                # backup restores. Claiming a crash here would be the same error
                # this branch was split to fix, one shape further down.
                add("physical", f"{name}: presets[{idx}].label is {type(_plabel).__name__} "
                                f"({_plabel!r}), not a string -> React renders it and Mongoose "
                                f"casts it to a string on the next write, so nothing breaks — the "
                                f"stored value simply is not the type the schema declares"
                                f"{_inh_blame('presets')}", fid)
            elif not _plabel.strip():
                add("physical", f"{name}: presets[{idx}].label is {_plabel!r} — whitespace only "
                                f"-> the schema accepts it (required, but not trimmed) and React "
                                f"renders it, so the preset row simply shows an EMPTY name and "
                                f"cannot be told from its siblings{_inh_blame('presets')}", fid)
            label = _plabel if isinstance(_plabel, str) and _plabel.strip() else idx
            pt = pre.get("temperatures") or {}
            if not isinstance(pt, dict):
                continue
            nozzle_like += [(f"preset[{label}] nozzle", num(pt.get("nozzle"))),
                            (f"preset[{label}] nozzleFirstLayer", num(pt.get("nozzleFirstLayer")))]
            bed_like += [(f"preset[{label}] bed", num(pt.get("bed"))),
                         (f"preset[{label}] bedFirstLayer", num(pt.get("bedFirstLayer")))]

        typ_upper = (r.get("type") or "").upper()
        floor = LOW_TEMP_FLOOR if any(t in typ_upper for t in LOW_TEMP_TYPES) else NOZZLE_FLOOR
        for label, val in nozzle_like:
            if val is None:
                continue
            blame = _temp_blame(label)
            # A range comparison has TWO owners — the value and the bound it is
            # judged against. A child with a LOCAL range and an inherited
            # calibration is the case that matters: blaming the template alone
            # would change every sibling to satisfy this one child's range.
            if lo is not None and val < lo:
                add("temps", f"{name}: {label} {val} is BELOW the declared range min {lo}"
                             f"{_inh_blame(_temp_root(label), 'temperatures.nozzleRangeMin')}", fid)
            if hi is not None and val > hi:
                add("temps", f"{name}: {label} {val} is ABOVE the declared range max {hi}"
                             f"{_inh_blame(_temp_root(label), 'temperatures.nozzleRangeMax')}", fid)
            if not floor <= val <= NOZZLE_CEILING:
                # The band is chosen BY TYPE — but `type` is `required: true`
                # and stored on EVERY row, so it can never appear in
                # `_inherited`. Naming it as a blame root made the single-owner
                # "INHERITED from template" branch unreachable here and forced
                # every genuinely inherited temperature into MIXED instead. The
                # type is stated as CONTEXT for the band, not as an ownership
                # claim.
                add("temps", f"{name}: {label} {val}C outside the plausible band for "
                             f"{r.get('type') or '?'} ({floor}-{NOZZLE_CEILING}C — chosen from "
                             f"this row's own type)"
                             f"{_inh_blame(_temp_root(label))}", fid)
        for label, val in bed_like:
            if val is not None and not 0 <= val <= 200:
                add("temps", f"{name}: {label} {val}C implausible{_temp_blame(label)}", fid)
        # Standby is an IDLE temperature, legitimately far below the print window,
        # so only its ceiling is meaningful.
        standby = num(temps.get("standby"))
        if standby is not None and not 0 <= standby <= NOZZLE_CEILING:
            add("temps", f"{name}: standby {standby}C implausible{_temp_blame('standby')}", fid)

        # --- physical --------------------------------------------------------
        dens = num(r.get("density"))
        metal_filled = OPT_TAG_METAL_FILL in (r.get("optTags") or [])
        ceiling = DENSITY_CEILING_FILLED if metal_filled else DENSITY_CEILING
        _ftype = (r.get("type") or "")
        _foaming = bool(FOAMING_TYPE_RE.search(_ftype.upper())) if isinstance(_ftype, str) else False
        floor = DENSITY_FLOOR_FOAMING if _foaming else DENSITY_FLOOR
        if dens is not None and not floor <= dens <= ceiling:
            kind = ("metal-filled" if metal_filled
                    else "foaming grade" if _foaming else "unfilled polymer")
            # The metal-fill hint belongs to the CEILING only. Pasted onto a
            # below-floor row it told a user with density 0.43 to add optTag 20,
            # which does not move the floor (so the finding returns on the next
            # run) and puts the tag in ABRASIVE_OPT_TAGS — so the audit's own
            # highest-severity category would then report a soft foaming PLA as
            # exporting non-abrasive. A remedy that makes things worse.
            if dens > ceiling and not metal_filled:
                hint = (" — if this really is metal-filled, add optTag 20 (METAL_FILL), which also "
                        "corrects its abrasive classification")
            elif dens < floor and not _foaming:
                hint = (" — a foaming grade legitimately sits here (the bundled reference puts "
                        "LW-PLA at 0.40-0.48 fully foamed); if it is one, name the type so it "
                        "reads as LW-/foaming and this row goes away. Do NOT add optTag 20: it "
                        "does not move the floor and it marks the filament abrasive")
            else:
                hint = ""
            add("physical", f"{name}: density {dens} g/cm3 outside the plausible {kind} range "
                            f"({floor}-{ceiling}){hint}{_inh_blame('density', 'optTags')}", fid)
        dia = num(r.get("diameter"))
        if dia is not None and not any(abs(dia - d) < 0.06 for d in (1.75, 2.85, 3.0)):
            add("physical", f"{name}: diameter {dia}mm is not a standard size"
                            f"{_inh_blame('diameter')}", fid)
        def _blame(field, where="", inherit_root=""):
            """Whose data is this, and where should the user go?

            A variant that INHERITS a field stores nothing for it, so telling its
            owner the value "was written by a path that bypassed validation" is
            false — the variant was never written at all — and it points the
            repair at the wrong document. One bad value on an 8-colour template
            otherwise produces 9 identical rows, 8 of them un-actionable. The app
            already solves this: /api/abrasive-nozzles returns `inheritedFrom`
            and the UI says to change it on the template.
            """
            if (where or field) and inherit_root and inherit_root in inherited_fields:
                return (f" -> INHERITED from template {parent_name!r}; fix it there or every "
                        f"variant keeps it")
            if not where and field in inherited_fields:
                return (f" -> INHERITED from template {parent_name!r}; fix it there or every "
                        f"variant keeps it")
            return " -> written by a path that bypassed validation"

        def bounds_check(container, table, where="", source="schema", inherit_prefix="",
                         inherit_root=""):
            # `inherit_prefix` is used ONLY for the inheritance lookup, never in
            # the message: resolveFilament records nested temperature entries
            # qualified (`temperatures.nozzleRangeMin`) while top-level scalars
            # are bare, so an inherited range endpoint was blamed on the variant.
            if not isinstance(container, dict):
                return
            for f2, (bmin, bmax) in table.items():
                val = container.get(f2)
                if val is None:
                    continue
                if num(val) is None:
                    continue   # reported once by the malformed_numerics sweep
                if (bmin is not None and val < bmin) or (bmax is not None and val > bmax):
                    rng = f"{bmin}-{bmax}" if bmax is not None else f">= {bmin}"
                    add("physical", f"{name}: {where}{f2}={val} outside the {source} bound "
                                    f"({rng}){_blame(inherit_prefix + f2, where, inherit_root)}", fid)

        bounds_check(r, NUMERIC_BOUNDS)
        bounds_check(temps, RANGE_BOUNDS, inherit_prefix="temperatures.")
        for idx, pre in enumerate(r.get("presets") or []):
            if isinstance(pre, dict):
                bounds_check(pre, PRESET_BOUNDS, f"preset[{pre.get('label') or idx}] ",
                             inherit_root="presets")
        for sp in (r.get("spools") or []):
            if not isinstance(sp, dict):
                continue
            # The tag is pasted into every row for this spool, and it is read
            # from the document -- so an over-long or hostile instanceId would
            # otherwise carry itself, verbatim and in full, through the entire
            # report. Cap it here rather than at each use.
            tag = _short(sp.get("instanceId") or sp.get("_id"))
            bounds_check(sp, SPOOL_BOUNDS, f"spool {tag} ")
            # Both are optional `type: Date` with a null default, so a null is
            # correct — but a raw-sync or restore string that Date cannot cast
            # is not, and it fails LOUDLY: the SpoolCard seeds its inputs with
            # `new Date(v).toISOString()` during render, which throws RangeError
            # on an Invalid Date and takes the whole detail page down.
            # `instanceId` is the spool's durable identity. The type sweep in
            # the shape pass catches a non-string, but "" and null pass it, and
            # the cross-record identity pass indexes non-empty strings only — so
            # the ABSENT case had no check anywhere, and it is the one that
            # silently degrades every per-spool flow.
            _sid_v = sp.get("instanceId")
            if _sid_v is None or _sid_v == "":
                add("structure", f"{name}: spool {tag} has no instanceId -> selectSpoolForWrite "
                                 f"answers no-id-available, so writing a tag for THIS spool fails, "
                                 f"and the QR/NFC flows fall back to the filament-level id — the "
                                 f"scan still finds the filament but no longer identifies the "
                                 f"roll. The startup backfill mints one, so a spool still missing "
                                 f"it was written by a path that bypassed the model", fid)
            else:
                _sid_bad = _id_contract_problem(_sid_v)
                if _sid_bad:
                    add("structure", f"{name}: spool {tag} instanceId {_short(repr(_sid_v))} "
                                     f"{_sid_bad}", fid)
            # `createdAt` is declared `{type: Date, default: Date.now}` on the
            # spool subdocument, so an ABSENT one is filled in on restore and is
            # not a defect — but a present-but-uncastable value fails the cast
            # exactly like the other two.
            # A dangling `locationId` survives every other check: /inventory
            # groups by it, and a spool pointing at a deleted Location joins no
            # row, so the group renders as a SECOND "no location" bucket while
            # the spool also vanishes from every `?kind=` filtered view. Same
            # "cannot judge" posture as the calibration scope refs.
            _loc_live = ref_index.get("locations") if isinstance(ref_index, dict) else None
            _lid = sp.get("locationId")
            if (isinstance(_loc_live, set) and _lid is not None and _lid != ""
                    and not isinstance(_lid, (dict, list)) and str(_lid) not in _loc_live):
                add("structure", f"{name}: spool {tag} locationId={str(_lid)!r} resolves to no "
                                 f"Location row -> /inventory joins nothing for it, so the spool "
                                 f"falls into a second 'no location' bucket and drops out of every "
                                 f"kind-filtered view", fid)
            for _df in ("purchaseDate", "openedDate", "createdAt"):
                _dv = sp.get(_df)
                # `""` is NOT a bad date here: Mongoose's castDate returns null
                # for it (cast/date.js — `if (value == null || value === '')`),
                # and isoToDateInput short-circuits on the falsy value, so the
                # page opens and the backup restores. The dryCycle branch below
                # still reports `""` — correctly, because `date` is REQUIRED
                # there and null fails that.
                if _dv not in (None, "") and _bad_date(_dv):
                    # createdAt has no render site of its own, so it gets the
                    # consequence it actually has rather than the SpoolCard's.
                    _dcons = ("POST /api/snapshot cannot cast it, so the ENTIRE backup file is "
                              "refused" if _df == "createdAt" else
                              "the SpoolCard seeds its date inputs with "
                              "`new Date(v).toISOString()` at RENDER time, so this throws a "
                              "RangeError and the whole filament page fails to open; POST "
                              "/api/snapshot rejects the backup on it too")
                    add("structure", f"{name}: spool {tag} {_df}={_dv!r} cannot be cast to a Date "
                                     f"-> {_dcons}", fid)
            for _tf in NESTED_TEXT_MAXLEN["spools"]:
                _tv = sp.get(_tf)
                if isinstance(_tv, str) and _utf16_len(_tv) > MAX_SPOOL_TEXT_LENGTH:
                    add("structure", f"{name}: spool {tag} {_tf} is {_utf16_len(_tv)} UTF-16 units, "
                                     f"past the schema's {MAX_SPOOL_TEXT_LENGTH}-character "
                                     f"maxlength -> POST /api/snapshot validates every document "
                                     f"before writing and 400s the ENTIRE backup on this row", fid)
            for dc in (sp.get("dryCycles") or []):
                bounds_check(dc, DRY_CYCLE_BOUNDS, f"spool {tag} dryCycle ")
                # `date` is schema-REQUIRED on a dry cycle with no default, so
                # unlike the usage-entry fields there is no read that papers
                # over it -- but nothing validates on the way in through a raw
                # sync copy or a restore of an older file.
                if isinstance(dc, dict):
                    _dcd = dc.get("date")
                    if _dcd is None or _dcd == "":
                        add("structure", f"{name}: spool {tag} dryCycle has no date -> the schema "
                                         f"requires one, so POST /api/snapshot refuses the ENTIRE "
                                         f"backup file rather than this row", fid)
                    elif _bad_date(_dcd):
                        # Presence alone was not enough: a value Mongoose cannot
                        # CAST fails identically at restore, and the row looks
                        # populated to every other check.
                        add("structure", f"{name}: spool {tag} dryCycle date={_dcd!r} cannot be "
                                         f"cast to a Date -> the schema requires a real one, so "
                                         f"POST /api/snapshot refuses the ENTIRE backup file "
                                         f"rather than this row", fid)
            for ue in (sp.get("usageHistory") or []):
                bounds_check(ue, USAGE_BOUNDS, f"spool {tag} usage ", source="route")
                # `grams` is schema-REQUIRED on a usage entry, and bounds_check
                # skips a None. Spool export and analytics read the missing value
                # as zero, so the entry vanishes from usage totals in silence.
                # `source` is an enum, and analytics counts ONLY exact "manual"
                # (src/app/api/analytics/route.ts) — so a typo does not error, it
                # quietly removes real usage from the manual aggregation.
                if isinstance(ue, dict):
                    src_v = ue.get("source")
                    # `x in <set>` raises on an unhashable x, so the type test
                    # comes first — a dict or list here is malformed anyway and
                    # is reported by the same row.
                    # `source` carries `default: "manual"`, so a properly written
                    # entry always has one — an explicit null means it was written
                    # past validation, and analytics then skips it.
                    # Absent as well as null: the schema DEFAULTS this to
                    # "manual", so a properly written entry always carries one,
                    # and analytics counts only exact "manual" — an omitted
                    # source removes that usage from the totals just as a null
                    # does. Legacy rows predating the field land here too, which
                    # is correct: their usage is genuinely missing from analytics.
                    if not isinstance(src_v, str) or src_v not in USAGE_SOURCES:
                        _shown = "absent" if "source" not in ue else repr(src_v)
                        add("physical", f"{name}: spool {tag} usage source={_shown} is not one of "
                                        f"{sorted(USAGE_SOURCES)} -> analytics counts only exact "
                                        f"'manual', so this entry silently drops out of the manual "
                                        f"usage and cost totals", fid)
                if isinstance(ue, dict):
                    _ud = ue.get("date")
                    # `date` carries `default: Date.now`, so a properly written
                    # entry always has one and a restore fills a missing one in
                    # -- the loss is in ANALYTICS, which builds `new Date(u.date)`
                    # and `continue`s on NaN, so the grams and their cost vanish
                    # from every total while the spool's own ledger still shows
                    # them. That mismatch is the symptom a user actually reports.
                    if _ud is None or _bad_date(_ud):
                        # The consequence depends on `source`. Analytics filters
                        # `u.source !== "manual"` in the SAME loop, so a job or
                        # slicer entry was never counted from the ledger anyway
                        # -- its grams reach the totals through the PrintHistory
                        # row, and claiming they are "missing from every total"
                        # would send the reader looking for a shortfall that is
                        # not there.
                        _usrc = ue.get("source")
                        if _usrc == "manual":
                            _ucons = ("analytics builds `new Date(u.date)` and skips the entry "
                                      "when it is invalid, so these grams and their cost are "
                                      "missing from every total while the spool's ledger still "
                                      "lists them")
                        elif _usrc in ("job", "slicer"):
                            _ucons = ("analytics counts only source='manual', so these grams still "
                                      "reach the totals through their PrintHistory row — what is "
                                      "broken is this ledger entry itself, which /history and the "
                                      "spool's usage list order and display by date")
                        else:
                            _ucons = ("analytics counts only source='manual', so this entry was "
                                      "never in the totals — what is broken is the ledger row, "
                                      "which /history and the spool's usage list order by date")
                        _uwhat = ("has no date" if _ud is None
                                  else f"date={_ud!r} cannot be cast to a Date")
                        add("physical", f"{name}: spool {tag} usage entry {_uwhat} -> {_ucons}",
                            fid)
                if isinstance(ue, dict) and ue.get("grams") is None:
                    add("physical", f"{name}: spool {tag} usage entry has no grams -> the schema "
                                    f"requires it, and export and analytics read it as zero, so "
                                    f"this entry silently vanishes from usage totals", fid)
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
            # Through the shared helper, not a bespoke loop: a second copy of the
            # same logic is exactly how this table missed the malformed-value
            # reporting that bounds_check gained.
            bounds_check(cal, CALIBRATION_BOUNDS, f"{where} ", inherit_root="calibrations")

        # --- missing core spec (EFFECTIVE — a template legitimately has none) -
        if not is_template:
            # `noz`/`bed`/`dens` are num() results, and num() returns None for a
            # PRESENT-but-malformed value too -- so a `density: "oops"` produced
            # a second, contradictory row saying the field is absent, on top of
            # the malformed-value row the numeric sweep had already emitted. And
            # because all three are inheritable, the template got the accurate
            # row while every child got this misleading one. Test the underlying
            # field for absence, and attribute what remains.
            def _absent(container, key):
                return not isinstance(container, dict) or container.get(key) in (None, "")

            # All three are inheritable, so on a VARIANT the fix belongs on the
            # template — one write clears the row for the whole colour family,
            # and writing it here instead pins this row off the template. The
            # absence is not attributable via _inh_blame (nothing is inherited:
            # the value is missing on BOTH sides), so say it directly.
            _where_to_set = ("" if not _ppid or not parent_name else
                             f" -> this field is inheritable; setting it once on template "
                             f"{parent_name!r} fills it for every colour, while setting it here "
                             f"pins this row off the template")
            if noz is None and _absent(temps, "nozzle"):
                add("missing-core", f"{name}: no nozzle temperature{_where_to_set}", fid)
            if bed is None and _absent(temps, "bed"):
                add("missing-core", f"{name}: no bed temperature{_where_to_set}", fid)
            if dens is None and _absent(r, "density"):
                add("missing-core", f"{name}: no density{_where_to_set}", fid)

        # --- colour ----------------------------------------------------------
        # A colour the TEXT SWEEP just coerced to "" is not a colour defect —
        # reporting it would emit a phantom `malformed color ''` for a field
        # already named as a malformed non-string, and would then defeat the
        # documented #808080 exemption below by blanking colorName.
        col = r.get("color")
        _c_text, _c_res = coerced_by_fid.get(fid, (set(), set()))
        if "color" not in _c_res and col is not None and not HEX6.match(str(col)):
            add("colour", f"{name}: malformed color {col!r}", fid)
        # #808080 is the legacy default the pre-v1.70 form stamped on everything,
        # but it is ALSO the correct hex for a filament that really is grey.
        cname = (r.get("colorName") or "").lower()
        _cname_lost = "colorName" in _c_res
        secondaries = r.get("secondaryColors") or []
        if isinstance(secondaries, list):   # shape already reported above
            if len(secondaries) > MAX_SECONDARY_COLORS:
                add("colour", f"{name}: {len(secondaries)} secondaryColors, past the OpenPrintTag "
                              f"limit of {MAX_SECONDARY_COLORS} -> the encoder truncates the extras"
                              f"{_inh_blame('secondaryColors')}", fid)
            for pos, sc in enumerate(secondaries):
                if not (isinstance(sc, str) and HEX6.match(sc)):
                    add("colour", f"{name}: secondaryColors[{pos}]={sc!r} is not #RRGGBB -> the "
                                  f"OPT encoder skips it, and a slicer export may use it when the "
                                  f"primary colour is null{_inh_blame('secondaryColors')}", fid)
        # The exemption used to be a two-spelling substring test over colorName,
        # which asserted "legacy sentinel" for every OTHER grey the user might
        # have named — Silver, Graphite, Slate, Ash, Gunmetal — and for a grey
        # stated only in `name`. #808080 IS the correct hex for those. What the
        # pre-v1.70 form actually left behind is the hex with NO colour name at
        # all, so that is the only shape reported; any non-empty colorName means
        # a human named this colour and it is theirs.
        if (col == "#808080" and not _cname_lost
                and not (isinstance(r.get("colorName"), str) and r["colorName"].strip())):
            add("colour", f"{name}: colour is the legacy #808080 sentinel with no colorName -> the "
                          f"pre-v1.70 form stamped this on every filament, so it is probably not "
                          f"the real colour; a genuinely grey filament wants a colorName", fid)

        # --- template violations (v1.70 #605) --------------------------------
        # parentPromotionState's own predicate, lifted out so the all-trashed
        # case below can reuse it verbatim rather than re-deriving it.
        _colour, _cname_raw = raw.get("color"), raw.get("colorName")
        promote_runs = (
            (isinstance(_colour, str) and _colour != "")
            or (isinstance(_cname_raw, str) and _cname_raw.strip() != "")
            or bool(raw.get("spools"))
            or raw.get("totalWeight") is not None
        )
        # A parent whose variants are ALL TRASHED is not `is_template` (that is
        # derived from LIVE children), so the whole block below is skipped and
        # the row audits as an ordinary standalone — while every one of those
        # variants answers 409 parent_must_be_template_first on restore (#1103).
        # The family is stuck, and nothing in the report said so.
        if not is_template and r.get("_hasTrashedVariants") and promote_runs:
            _carried = [f for f in TEMPLATE_STRIP if raw.get(f) not in (None, "", [])]
            if raw.get("spools"):
                _carried.append(f"{len(raw['spools'])} spool(s)")
            add("template", f"{name}: has TRASHED variants and still carries "
                            f"{', '.join(_carried) or 'promotable state'} -> it is not a template "
                            f"(that is derived from LIVE children), so nothing else in this report "
                            f"treats it as one — but POST /api/filaments/<variant>/restore answers "
                            f"409 parent_must_be_template_first for every one of those variants, "
                            f"so the family cannot be restored [POST /api/filaments/{fid}/promote "
                            f"accepts this row: /promote counts variants INCLUDING trashed ones]",
                fid)
        if is_template:
            # A row that is BOTH a variant and a parent is not a template the
            # app can act on, and every remedy below assumes it is. Detect it
            # FIRST and re-aim them: `/promote` tests `filament.parentId ||`
            # before anything else and refuses with 400 not_a_template, so
            # "Convert to template" -- the remedy the carrying case would
            # otherwise prescribe -- is dead on exactly these rows.
            _gp = str(raw["parentId"]) if raw.get("parentId") else None
            nested_parent = bool(_gp)
            if nested_parent:
                _gp_name = (records.get(_gp, {}).get("res", {}).get("name")
                            or f"filament {_gp}")
                add("template", f"{name} (TEMPLATE): also carries parentId -> it is BOTH a variant "
                                f"of {_gp_name!r} AND a parent, a shape createVariantGated refuses "
                                f"(parent_is_variant) and no API path can produce — it arrived by "
                                f"a raw sync copy, a restore, or a direct DB edit. Two "
                                f"consequences: POST /api/filaments/{fid}/promote refuses this row "
                                f"with 400 not_a_template, so the app's own repair for everything "
                                f"below is UNAVAILABLE; and resolveFilament walks exactly ONE "
                                f"level, so this row's own variants inherit from it and never see "
                                f"{_gp_name!r}. Repair the SHAPE first — PUT {{\"parentId\": null}} "
                                f"here (this row then stops inheriting from {_gp_name!r}, so copy "
                                f"anything it was relying on down first), or re-parent its variants "
                                f"onto {_gp_name!r} — after that the rows below become actionable.",
                    fid)
            # Promotion is a WHOLE-TEMPLATE operation, not a per-field one. Its
            # gate is parentPromotionState.needed — a non-empty `color` (NOT
            # trimmed), a `colorName` non-empty AFTER trimming, a spool count, or
            # totalWeight. When that is satisfied, performParentPromotion MOVES
            # colour, colourName, spools, totalWeight AND lowStockThreshold onto
            # the new variant. So the repair must be chosen from the parent's full
            # state: deciding per field would tell the user to null a threshold
            # that promotion would have preserved, destroying it.
            for fld in TEMPLATE_STRIP:
                val = raw.get(fld)
                if val in (None, "", []):
                    continue
                if nested_parent and promote_runs:
                    # A destructive null was prescribed unconditionally here,
                    # even where the shape repair one row above makes /promote
                    # MOVE the value onto a variant instead of deleting it. Name
                    # the sequence rather than the shortcut: the null is still
                    # available, but it is the "I want this gone" branch, not
                    # the repair.
                    how = (f'/promote is refused while this row carries parentId — repair the '
                           f'shape (above), then Convert to template, which MOVES this onto a '
                           f'variant; PUT {{"{fld}": null}} only if you want it deleted')
                elif nested_parent:
                    # promote_runs is False, so promotion would move nothing and
                    # the null really is the only remedy.
                    how = f'/promote refused (see above) — PUT {{"{fld}": null}}'
                elif promote_runs:
                    how = "Convert to template — moves this onto a new variant"
                else:
                    how = f'promote returns 400 nothing_to_convert here — PUT {{"{fld}": null}}'
                add("template", f"{name} (TEMPLATE): still carries {fld}={val!r} [{how}]", fid)
            if raw.get("spools"):
                # This row was the ONLY one in the block shipping no remedy, and
                # it is the one where guessing is most expensive. Two things the
                # reader needs and cannot infer: promotion is the only move that
                # PRESERVES the rolls (POST .../spools onto a template is refused
                # with template_no_spools, and a PUT carrying `spools: []` is
                # accepted -- it DELETES them rather than relocating them); and
                # the subdocuments move verbatim, `_id` and `instanceId` included,
                # so printed QR labels and written NFC tags keep resolving.
                # `promote_runs` is True by construction here -- carrying spools
                # is itself one of parentPromotionState's triggers.
                _spool_how = (
                    "no safe remedy until the shape above is fixed — /promote is refused on this "
                    "row and PUT spools:[] DELETES the rolls rather than moving them"
                    if nested_parent else
                    f"Convert to template (POST /api/filaments/{fid}/promote) — moves the spools "
                    f"onto a new variant with their _id and instanceId intact, so printed labels "
                    f"and NFC tags keep resolving. Do NOT PUT spools:[] — that deletes the rolls "
                    f"instead of moving them")
                add("template", f"{name} (TEMPLATE): holds {len(raw['spools'])} spool(s) — "
                                f"inventory belongs on a variant [{_spool_how}]", fid)

        # --- pinned inheritance ----------------------------------------------
        pid = str(raw["parentId"]) if raw.get("parentId") else None
        parent_ok = False
        if pid:
            if pid == fid:
                add("structure", f"{name}: parentId points at itself -> nothing can inherit", fid)
            elif pid not in records and pid in listing_topology:
                # The parent IS active — the listing carries it — but its detail
                # read failed, so it is absent from `records`. Calling that a
                # broken link would be a false report of data loss against a
                # perfectly healthy row; the read failure is already reported
                # separately under `structure`.
                add("notchecked", f"{name}: parent {pid} could not be read, so this row's "
                                 f"inheritance was NOT audited (the parent exists and is active)",
                    fid)
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
            # DEFENCE IN DEPTH, not the primary guard: the CONTAINER_SHAPES
            # sweep already coerced `settings` to {} on BOTH reads, so as the
            # code stands neither branch can fire. Kept because .items() on a
            # legacy string would abort the whole audit, and a future caller
            # that reaches this block without going through normalisation would
            # otherwise take the whole run down. The earlier comment credited
            # THIS site with the protection, which was misleading about where
            # the invariant actually comes from.
            if not isinstance(own_set, dict):
                own_set = {}
            if not isinstance(par_set, dict):
                par_set = {}
            dup = sorted(k for k, val in own_set.items()
                         if k in par_set and _json_equal(par_set[k], val)
                         and k not in PIN_EXEMPT_SETTINGS)
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
                # An empty tick list is NORMAL, not a defect: since #1021 the
                # export derives nothing from it (it fails open, visible on
                # every printer), and the #859 slicer sync-back resolves a
                # nozzle from the global catalog without ever writing ticks. The
                # bare row condemned the app's own documented default — and was
                # the one finding in the file carrying no consequence at all.
                # It costs the user something ONLY when calibrations exist:
                # isCalibrationRowReachable starts with
                # `if (!ctx.compatibleNozzleIds.includes(nozzleId)) return false`,
                # so with no ticks EVERY stored calibration drops out of the
                # form's grid into the orphan list, where it can be removed but
                # not corrected.
                _cal_n = len([c for c in (raw.get("calibrations") or [])
                              if isinstance(c, dict)])
                if _cal_n:
                    add("nozzles", f"{name}: no compatibleNozzles, but {_cal_n} calibration(s) are "
                                   f"stored -> isCalibrationRowReachable requires the row's nozzle "
                                   f"to be ticked, so every one of them drops out of the "
                                   f"FilamentForm grid into the orphan list and can only be "
                                   f"removed, not edited"
                                   f"{_inh_blame('compatibleNozzles')}", fid)
            elif not live:
                add("nozzles", f"{name}: every compatibleNozzles entry is soft-deleted ({stale}) -> "
                               f"effectively unassigned{_inh_blame('compatibleNozzles')}", fid)
            elif stale:
                add("nozzles", f"{name}: compatibleNozzles includes soft-deleted {stale} -> stale "
                               f"reference that cannot be used{_inh_blame('compatibleNozzles')}", fid)

    # The audited ids, so main() cannot iterate records this function discarded:
    # `records` was rebound to `usable` above, and the grouping in main() used to
    # read `rec["res"].get(...)` off the ORIGINAL mapping and die on the very
    # record audit() had just reported as unreadable — the one-bad-row-hides-
    # everything failure, one scope up.
    # --- cross-record spool identity ------------------------------------------
    # The only check that cannot be made per record. `matchFilament` resolves a
    # scanned id against spools[].instanceId BEFORE the filament-level fallback
    # (src/lib/matchFilament.ts), so a duplicate id makes a printed QR or an NFC
    # tag resolve to nothing, or to the wrong filament. The API refuses these at
    # write time (isSpoolInstanceIdTaken) but there is NO unique index, so hybrid
    # sync's replaceOne, a snapshot restore or a promotion can still land one.
    # Read from the STORED documents only: `instanceId` and `spools` are
    # VARIANT_ONLY, so nothing here is inherited and nothing can be misattributed.
    # `top_ci` is the same index case-FOLDED, because matchFilament's tier order
    # is spool-exact, spool case-insensitive, THEN filament-exact: a spool id
    # differing from a filament id only by case shadows it just as completely as
    # an exact duplicate, and an exact-key comparison cannot see it.
    spool_owners, top_owners, top_ci = {}, {}, {}
    _parent_of = {_f: (str(_v["raw"]["parentId"]) if _v["raw"].get("parentId") else None)
                  for _f, _v in records.items()}
    for _fid, _v in records.items():
        _raw = _v["raw"]
        _nm = _raw.get("name") or _v["res"].get("name") or "?"
        _tid = _raw.get("instanceId")
        if isinstance(_tid, str) and _tid:
            top_owners.setdefault(_tid, []).append((_fid, _nm))
            top_ci.setdefault(_tid.casefold(), []).append((_fid, _nm))
        for _sp in (_raw.get("spools") or []):
            if isinstance(_sp, dict):
                _sid = _sp.get("instanceId")
                if isinstance(_sid, str) and _sid:
                    spool_owners.setdefault(_sid, []).append(
                        (_fid, _nm, _sp.get("label") or _sp.get("_id")))

    def _who(rows):
        return ", ".join(sorted(f"{n} [{i}]" for i, n, *_ in rows))

    for _sid, _owners in sorted(spool_owners.items()):
        _fids = {i for i, _, _ in _owners}
        if len(_fids) > 1:
            add("structure", f"spool instanceId {_sid!r} is carried by spools on {len(_fids)} "
                             f"different filaments ({_who(_owners)}) -> matchFilament returns NO "
                             f"match with both as candidates, so every QR label and NFC tag "
                             f"holding this id stops resolving", None)
        elif len(_owners) > 1:
            add("structure", f"{_owners[0][1]}: spool instanceId {_sid!r} is carried by "
                             f"{len(_owners)} of its own spools "
                             f"({', '.join(str(t) for _, _, t in _owners)}) -> the filament still "
                             f"resolves, but WHICH roll a scan reports is array order, so a "
                             f"weight update can land on the wrong spool", _owners[0][0])
        # A spool id equal to ITS OWN filament's is the #732 Phase 1 carry-over
        # and is legitimate — exactly what `ownFilamentId` excludes in
        # isSpoolInstanceIdTaken. Only a FOREIGN filament's id is a shadow.
        # The #732 carry-over exemption below keys on the spool still living on
        # the filament whose top-level id it copied — and a v1.70 promotion
        # breaks exactly that pairing: the spools move to a NEW variant with
        # `instanceId` preserved while the parent keeps its own top-level id. So
        # the audit's own prescribed remedy ("Convert to template ... so printed
        # labels and NFC tags keep resolving") manufactured this finding on the
        # next run — and its consequence was backwards, because resolving that
        # label to the variant now holding the roll is precisely what the
        # promotion guarantees. Exempt the parent<->child pair; a genuinely
        # FOREIGN family still reports.
        def _kin_of(candidates):
            """Filament ids in the SAME family as one of this id's spool owners."""
            return {i for i, _ in candidates
                    for o in _fids
                    if _parent_of.get(o) == i or _parent_of.get(i) == o}

        _kin = _kin_of(top_owners.get(_sid, []))
        _shadowed = [(i, n) for i, n in top_owners.get(_sid, [])
                     if i not in _fids and i not in _kin]
        if _shadowed:
            add("structure", f"spool instanceId {_sid!r} (on {_owners[0][1]}) equals the "
                             f"FILAMENT-level instanceId of {_who(_shadowed)} -> the spool tier "
                             f"runs first, so a label carrying that filament's id resolves to "
                             f"the WRONG filament", None)
        else:
            # matchFilament runs spool-exact, then spool CASE-INSENSITIVE, and
            # only THEN the filament-level exact tier -- so a spool id that
            # differs from a filament id only by case shadows it just as
            # completely, and an exact-key comparison sees nothing at all.
            # Same promotion exemption as the exact branch above — otherwise
            # suppressing it there just moved the false finding into this row.
            _ci_all = top_ci.get(_sid.casefold(), [])
            _ci_kin = _kin_of(_ci_all)
            _ci = [(i, n) for i, n in _ci_all
                   if i not in _fids and i not in _ci_kin and n is not None]
            if _ci:
                add("structure", f"spool instanceId {_sid!r} (on {_owners[0][1]}) differs only by "
                                 f"CASE from the filament-level instanceId of {_who(_ci)} -> "
                                 f"matchFilament runs its case-insensitive SPOOL tier before the "
                                 f"exact filament tier, so a scan of that filament's own id "
                                 f"resolves to this spool's filament instead", None)

    for _tid, _owners in sorted(top_owners.items()):
        if len(_owners) > 1:
            # NOT "ambiguous": the exact-case filament tier is a findOne
            # (matchFilament.ts), which returns whichever row Mongo happens to
            # pick and reports it as a confident single match. The scan does not
            # fail visibly -- it silently answers with one of them.
            add("structure", f"filament-level instanceId {_tid!r} is shared by {_who(_owners)} "
                             f"-> the exact-case tier is a findOne, so a scan of this id resolves "
                             f"SILENTLY to whichever row Mongo returns first, reported as a "
                             f"confident match — it never surfaces as ambiguous", None)

    # --- calibration scope references (needs the UNPOPULATED ids) ---------
    # Run over the SNAPSHOT's own per-filament arrays rather than the resolved
    # read: a variant that inherits `calibrations` carries the TEMPLATE's array,
    # so walking the resolved read would report the template's dangling ref once
    # per child, at an index the child does not own. Keyed by document, this
    # always names the row that stores the reference.
    if isinstance(ref_index, dict) and "error" in ref_index:
        add("notchecked", f"calibration scope references were NOT checked: the /api/snapshot read "
                         f"failed ({ref_index['error']}). Both detail reads populate "
                         f"`calibrations.printer`/`.bedType`, so a purged target is "
                         f"indistinguishable from the generic state without it.", None)
    elif isinstance(ref_index, dict):
        _live = {"printer": ref_index.get("printers"), "bedType": ref_index.get("bedTypes")}
        # Distinguishing an absent collection from an empty one stops a false
        # positive, but silence about it is its own defect: with `printers`
        # omitted, every printer scope goes unchecked and the report looks
        # structurally clean. Say so, in the same words as a failed read.
        for _f, _coll in (("printer", "printers"), ("bedType", "bedTypes")):
            if not isinstance(_live[_f], set):
                add("notchecked", f"calibration {_f} references were NOT checked: the /api/snapshot "
                                 f"response carried no `{_coll}` collection, so no {_f} id could be "
                                 f"resolved. Both detail reads populate these refs, and populate() "
                                 f"nulls a purged target, so they are invisible without it.", None)

        def _dangles(cal, field):
            """True when this ref is STORED but resolves to no row — the state
            populate() renders as null. None when it cannot be judged."""
            # `not isinstance(..., set)` rather than `is None`: this index is
            # built from an external HTTP response, and `x in 42` raises rather
            # than returning False — which would abort the WHOLE audit and hide
            # every finding, the one failure this checker must never have.
            # Anything that is not a set of ids cannot judge anything, which is
            # the same answer as an absent collection.
            if not isinstance(_live[field], set):
                return None        # the snapshot did not carry that collection
            ref = cal.get(field)
            if ref is None or ref == "" or isinstance(ref, (dict, list)):
                return False       # unset (a genuine generic scope), or malformed
            return str(ref) not in _live[field]

        _cal_map = ref_index.get("cals")
        for _fid, _cals in (_cal_map if isinstance(_cal_map, dict) else {}).items():
            if _fid not in records or not isinstance(_cals, list):
                continue           # only rows this run actually audited
            _nm = records[_fid]["res"].get("name") or "?"
            for _i, _cal in enumerate(_cals):
                if not isinstance(_cal, dict):
                    continue       # shape already reported by the element sweep
                # The consequence is NOT the same for both fields, and it is not
                # even the same for one field twice. pickRepresentativeCalibration
                # tests `printer == null && bedType == null`, so the export-default
                # promotion happens only when BOTH refs are null after populate --
                # a dangling printer beside a LIVE bed type fails that predicate,
                # and claiming otherwise would send the reader looking for an
                # export defect that is not there.
                _both_null = all(
                    _cal.get(f) in (None, "") or _dangles(_cal, f) for f in ("printer", "bedType")
                ) and not any(isinstance(_cal.get(f), (dict, list)) for f in ("printer", "bedType"))
                for _f in ("printer", "bedType"):
                    if not _dangles(_cal, _f):
                        continue
                    _conseq = (
                        "populate() nulls it, and with the other scope empty too that is EXACTLY "
                        "the shape pickRepresentativeCalibration reads as the generic "
                        "any-printer/any-bed default -- so this calibration's tuning is baked "
                        "into the single-preset Orca/Bambu export for EVERY machine"
                        if _both_null else
                        "populate() nulls it, so the calibration silently loses its "
                        f"{_f} scope: it still exports and still renders, but no longer as the "
                        f"tuning for the {_f} it was measured on")
                    add("structure",
                        f"{_nm}: calibration[{_i}] stores {_f}={str(_cal.get(_f))!r}, which "
                        f"resolves to no {_f} row at all -> {_conseq}. Re-point it at a live "
                        f"{_f}, or clear it deliberately if the tuning really is generic.", _fid)

    return findings, parents, set(records)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("FILAMENTDB_URL", "http://localhost:3456"))
    ap.add_argument("--api-key", default=os.environ.get("FILAMENTDB_API_KEY"))
    ap.add_argument("--cache", help="directory to save the fetched records into")
    ap.add_argument("--only", help="comma-separated category keys to report")
    ap.add_argument("--json", action="store_true", help="emit findings as JSON")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    records, abrasive, failed, topology, degraded, ref_index = load(
        base, args.api_key, args.cache)
    findings, parents, audited = audit(records, abrasive, failed, topology, degraded,
                                       ref_index)

    # A filter that matches NO known category must never render as a clean audit.
    # `--only abrasives` (plural) printed "0 findings" over a library with a real
    # abrasive defect — a silence the user has every reason to read as safety.
    wanted = None
    if args.only:
        wanted = {k.strip().lower() for k in args.only.split(",") if k.strip()}
        known = {k for k, _ in CATEGORIES}
        unknown = sorted(wanted - known)
        if not wanted:
            ap.error("--only: no category given")
        if unknown:
            ap.error("--only: unknown categor%s %s; known keys are: %s"
                     % ("y" if len(unknown) == 1 else "ies",
                        ", ".join(unknown), ", ".join(sorted(known))))

    # Records whose NAME is shared with another active record. Keyed on the name
    # rather than on an identical message: two duplicates usually have DIFFERENT
    # defects, so every message would be unique and no id would be appended —
    # leaving the report unable to say which of the two to repair.
    # Grouped on the TRIMMED name. "X" and "X " are distinct raw keys but render
    # identically, and that pair is a documented unresolved state (the #1116 trim
    # migration deliberately refuses to merge a whitespace twin, and Data health
    # surfaces it) — so bucketing on the raw string would leave both records
    # without an id in exactly the case the reader most needs one.
    by_name = {}
    for rid in audited:
        key = (records[rid]["res"].get("name") or "").strip()
        by_name.setdefault(key, []).append(rid)
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
        out = {k: render(v) for k, v in findings.items()
               if not wanted or k in wanted or k == "notchecked"}
        print(json.dumps({"filaments": len(records), "templates": len(parents), "findings": out}, indent=2))
        return

    total = 0
    for key, title in CATEGORIES:
        raw_rows = findings.get(key)
        if not raw_rows or (wanted and key not in wanted and key != "notchecked"):
            continue
        rows = render(raw_rows)
        total += len(rows)
        print(f"\n### {title}  ({len(rows)})")
        for row in rows:
            print("  -", row)
    print(f"\n=== {total} findings across {len(audited)} filaments "
          f"({len(parents)} templates) ===")


if __name__ == "__main__":
    main()
