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

SRC="$1"
SLUG="$2"
SCOPE="${3:-chemistry and background only — no processing parameters}"

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

out="$root/external/${SLUG}.md"
[[ -e "$out" ]] && die "$out already exists. Pick another slug, or edit it directly."

cat > "$out" <<EOF
---
source:    ${SRC}
retrieved: $(date +%Y-%m-%d)
trust:     background
scope:     ${SCOPE}
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
