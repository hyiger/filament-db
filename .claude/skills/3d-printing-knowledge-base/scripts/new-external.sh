#!/usr/bin/env bash
# new-external.sh — create a provenance-stamped file in external/.
#
# Usage: scripts/new-external.sh <url-or-citation> <slug> [scope]
#   scripts/new-external.sh https://en.wikipedia.org/wiki/Polyphenylene_sulfide pps
#   scripts/new-external.sh "Vendor TDS, Fiberon PPS-CF, rev 3" fiberon-pps-cf "chemistry + supplier claims"
#
# Writes external/<slug>.md with front matter filled in, then prints the path.
# Refuses to overwrite. Body is left for you to fill in below the metadata.

set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $# -ge 2 ]] || die "usage: new-external.sh <url-or-citation> <slug> [scope]"
# An EMPTY citation passes the count check -- `new-external.sh "$URL" slug`
# with URL unset is the ordinary way to reach it -- and writes source: "",
# which the auditor's non-whitespace test reads as content because the quotes
# are content. The result is a tier-4 file with no provenance that reports
# Clean, which is the one thing this pair of scripts exists to make impossible.
[[ -n "${1//[[:space:]]/}" ]] || die "source must not be empty (got: '$1')"

SRC="$1"
SLUG="$2"
SCOPE="${3:-chemistry and background only — no processing parameters}"
[[ -n "${SCOPE//[[:space:]]/}" ]] || die "scope must not be empty"

# Locate the knowledge-base root: the dir containing external/.
root="$PWD"
while [[ "$root" != "/" && ! -d "$root/external" ]]; do root="$(dirname "$root")"; done
[[ -d "$root/external" ]] || die "no external/ directory found above $PWD.
  Create the knowledge-base layout first:  mkdir -p external authored"

[[ "$SLUG" =~ ^[a-z0-9][a-z0-9._-]*$ ]] \
  || die "slug must be lowercase alphanumeric with . _ - only (got: $SLUG)"

case "$SRC" in
  *[$'\n\r']*) die "source must be a single line" ;;
esac
# Same rule for the scope. It reaches the same quoting path, and a newline
# there writes a multiline scalar that the line-oriented provenance checker
# still reports clean -- and can forge what look like extra metadata keys.
case "$SCOPE" in
  *[$'\n\r']*) die "scope must be a single line" ;;
esac

# Emit both free-text fields as YAML double-quoted scalars. The documented
# citation form is prose, and prose routinely contains YAML-significant
# characters: "Vendor TDS: revision 3" makes the line a nested mapping, and a
# leading "#" makes the value an empty string plus a comment. Either way the
# helper reports success while writing a file whose provenance is wrong or
# gone -- and check-provenance.sh matches these lines with regexes, so it
# would then certify the result as clean.
yaml_quote() {
  local v=$1
  v=${v//\\/\\\\}   # backslashes first, or the next substitution doubles them
  v=${v//\"/\\\"}
  # Line breaks escaped rather than emitted raw. The callers above already
  # refuse them, so this is belt-and-braces for any future caller -- but it is
  # the difference between a malformed file and a well-formed one, and the
  # checker cannot tell a multiline scalar from injected metadata.
  v=${v//$'\r'/\\r}
  v=${v//$'\n'/\\n}
  printf '"%s"' "$v"
}

out="$root/external/${SLUG}.md"
[[ -e "$out" ]] && die "$out already exists. Pick another slug, or edit it directly."

cat > "$out" <<EOF
---
source:    $(yaml_quote "$SRC")
retrieved: $(date +%Y-%m-%d)
trust:     background
scope:     $(yaml_quote "$SCOPE")
---

# ${SLUG}

<!--
  Body goes here.

  This file is TIER 4 (background only). Nothing in it is authoritative.
  Do NOT record nozzle, bed, chamber, or drying temperatures here, or any
  other value destined for a slicer — those belong in authored/ or the
  Filament DB record, and only after verification.

  Chemistry, structure, general material behaviour, and history are fine.
-->
EOF

printf 'Created %s\n' "$out"
