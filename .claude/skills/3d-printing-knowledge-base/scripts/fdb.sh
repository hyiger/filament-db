#!/usr/bin/env bash
# fdb.sh — thin, safe wrapper around the Filament DB REST API.
#
# Handles base URL, optional bearer auth, and — most importantly — turns
# failures into LOUD errors instead of empty output that an agent might
# mistake for "no results".
#
# Usage:
#   ./fdb.sh check                 Verify the API is reachable. Run this first.
#   ./fdb.sh get <path>            Raw GET, e.g. get /api/filaments/abc123
#   ./fdb.sh list                  All filaments, projected to a small summary
#   ./fdb.sh find <substring>      Filaments whose name matches (case-insensitive)
#   ./fdb.sh detail <substring>    Full record for the single best name match
#   ./fdb.sh schema                Field names present on a sample record
#
# Env:
#   FILAMENTDB_URL      default http://localhost:3456
#   FILAMENTDB_API_KEY  sent as "Authorization: Bearer ..." when set

set -euo pipefail

BASE="${FILAMENTDB_URL:-http://localhost:3456}"

TMPFILE=""
cleanup() { [[ -n "${TMPFILE:-}" ]] && rm -f "$TMPFILE"; TMPFILE=""; }
# Backstop for non-pipeline invocations. Note that req() runs inside a pipeline
# in most subcommands, and a pipeline element is a subshell that does NOT
# inherit this trap — so die() and the success path clean up explicitly too.
trap cleanup EXIT INT TERM

die() { cleanup; printf 'FDB ERROR: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl not found on PATH"
command -v jq   >/dev/null 2>&1 || die "jq not found on PATH. Install with: brew install jq"

# --- core request -----------------------------------------------------------
# NOTE: deliberately avoids bash arrays. macOS ships bash 3.2, where expanding
# an empty array under `set -u` raises "unbound variable".
req() {
  local path="$1" url tmp http rc
  url="${BASE}${path}"
  tmp="$(mktemp "${TMPDIR:-/tmp}/fdb.XXXXXX")" || die "cannot create temp file"
  TMPFILE="$tmp"

  if [[ -n "${FILAMENTDB_API_KEY:-}" ]]; then
    http="$(curl -sS --max-time 30 -o "$tmp" -w '%{http_code}' \
             -H "Authorization: Bearer ${FILAMENTDB_API_KEY}" "$url" 2>/dev/null)" || rc=$?
  else
    http="$(curl -sS --max-time 30 -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null)" || rc=$?
  fi
  rc="${rc:-0}"

  if [[ "$rc" -ne 0 ]]; then
    case "$rc" in
      7)  die "connection refused at ${BASE}
  Filament DB is not running. Start the Electron app, or 'npm run dev' in the repo." ;;
      6)  die "cannot resolve host in ${BASE}. Check FILAMENTDB_URL." ;;
      28) die "timed out after 30s reaching ${url}. Is the app responding?" ;;
      *)  die "curl exited ${rc} for ${url}" ;;
    esac
  fi

  case "$http" in
    200) ;;
    401)
      die "HTTP 401 from ${path}
  The FILAMENTDB_API_KEY bearer gate is active on this instance.
  That gate is all-or-nothing across /api/:path* with no same-origin exemption.
  Export the key in this shell and retry:  export FILAMENTDB_API_KEY=..." ;;
    403)
      # Filament DB's own gate answers 401 and only 401 (src/proxy.ts), so a
      # 403 came from something in front of it — a reverse proxy, a corporate
      # gateway, an allow-list. Prescribing an API key there sends the user
      # after a fix that cannot work.
      die "HTTP 403 from ${path}
  Filament DB's own API-key gate answers 401, never 403, so this came from
  something in front of it (a proxy or gateway). An API key will not help.
  Check what is sitting between this shell and ${BASE}." ;;
    404) die "HTTP 404 from ${path} — endpoint does not exist on this version. Do NOT guess another path; ask the user." ;;
    000) die "no HTTP response from ${url}. The server closed the connection." ;;
    *)   die "HTTP ${http} from ${path}. Body: $(head -c 400 "$tmp")" ;;
  esac

  jq -e . "$tmp" >/dev/null 2>&1 \
    || die "response from ${path} was not valid JSON. First 400 bytes: $(head -c 400 "$tmp")"

  cat "$tmp"
  cleanup
}

# Some deployments wrap collections as {data:[...]} or {filaments:[...]}.
# Normalise to a bare array so downstream jq is stable.
as_array() {
  jq 'if type=="array" then .
      elif has("data")      and (.data|type)=="array"      then .data
      elif has("filaments") and (.filaments|type)=="array" then .filaments
      elif has("items")     and (.items|type)=="array"     then .items
      else error("unexpected list shape; run: fdb.sh get /api/filaments | jq \"keys\"") end'
}

cmd="${1:-}"; shift || true

case "$cmd" in
  check)
    req /api/filaments | as_array \
      | jq -r '"OK — API reachable at '"${BASE}"', \(length) filaments visible."'
    ;;

  get)
    [[ $# -ge 1 ]] || die "usage: fdb.sh get <path>"
    req "$1"
    ;;

  schema)
    # Show what fields actually exist rather than assuming. Run once per session
    # if you are unsure of a field name; do not guess names.
    #
    # Reads a DETAIL record, not the list. The list route is a projection --
    # it drops calibrations, drying, shrinkage and the settings bag among
    # others -- so enumerating a list item reports a field as absent when it
    # exists, which is precisely the wrong answer for a command whose whole
    # job is "does this field name exist?".
    sid="$(req /api/filaments | as_array | jq -r 'if length == 0 then error("no filaments returned") else .[0]._id // .[0].id end')"
    req "/api/filaments/${sid}" | jq '
      (.filament // .) | to_entries
      | map({key, type: (.value|type)})
      | sort_by(.key)'
    ;;

  list)
    req /api/filaments | as_array | jq '[.[] | {
      id:       (._id // .id),
      name,
      material: .type,
      brand:    .vendor,
      isParent: (.hasVariants // false),
      spools:   ((.spools // []) | length)
    }] | sort_by(.name)'
    ;;

  find)
    [[ $# -ge 1 ]] || die "usage: fdb.sh find <substring>"
    req /api/filaments | as_array | jq --arg q "$1" '[.[]
      | select((.name // "") | ascii_downcase | contains($q | ascii_downcase))
      | { id: (._id // .id), name,
          material: .type, brand: .vendor,
          spools: ((.spools // []) | length) }]
      | if length == 0 then error("no filament name contains \"" + $q + "\"") else . end'
    ;;

  detail)
    [[ $# -ge 1 ]] || die "usage: fdb.sh detail <substring>"
    ids="$(req /api/filaments | as_array | jq -r --arg q "$1" '[.[]
      | select((.name // "") | ascii_downcase | contains($q | ascii_downcase))
      | (._id // .id)] | .[]')"
    count="$(printf '%s\n' "$ids" | grep -c . || true)"
    [[ "$count" -eq 0 ]] && die "no filament name contains \"$1\""
    [[ "$count" -gt 1 ]] && die "\"$1\" matched ${count} filaments. Narrow the search — do NOT pick one arbitrarily. Run: fdb.sh find \"$1\""
    # Single-record route: this is the path that resolves parent/variant inheritance.
    req "/api/filaments/${ids}"
    ;;

  ""|help|-h|--help)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    ;;

  *)
    die "unknown command: ${cmd}. Run 'fdb.sh help'."
    ;;
esac
