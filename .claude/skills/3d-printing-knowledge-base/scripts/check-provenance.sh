#!/usr/bin/env bash
# check-provenance.sh — audit external/ for missing or malformed front matter,
# and flag files that leaked out of scope.
#
# Usage: scripts/check-provenance.sh
# Exit 0 = clean, 1 = problems found.

set -uo pipefail

root="$PWD"
while [[ "$root" != "/" && ! -d "$root/external" ]]; do root="$(dirname "$root")"; done
if [[ ! -d "$root/external" ]]; then
  printf 'ERROR: no external/ directory found above %s\n' "$PWD" >&2; exit 1
fi

# perl is used by the scalar decoder below and by the comment strip in the leak
# scan. Without it the decoder would pass escapes through and the leak scan
# would silently see no prose -- both failing toward "Clean", so refuse early.
if ! command -v perl >/dev/null 2>&1; then
  printf 'ERROR: perl is required (scalar decoding and HTML-comment stripping).\n' >&2
  exit 1
fi

# Decode a front-matter scalar far enough to tell "has a value" from "has none".
#
# Deliberately not a YAML parser -- it covers exactly the surface these four
# fields can present: the two quoting styles, backslash escapes inside double
# quotes, inline comments, and the plain null spellings. Each of those has now
# been a way to write a file with no provenance that still audited Clean, and
# adding them as separate special cases is what let the next one through.
yaml_scalar() {
  local v=$1 out="" i c prev=""
  case "$v" in
    \"*)
      # Quoted: the value is what is inside. Anything after the closing quote
      # is a comment or junk, and either way not provenance.
      i=1
      while (( i < ${#v} )); do
        c=${v:i:1}
        [[ "$c" == '"' && "$prev" != "\\" ]] && break
        out+="$c"; prev="$c"; i=$((i+1))
      done
      # Escapes are what a double-quoted scalar is FOR, and a value that is
      # only escaped whitespace ("\\t", "\\u0020") resolves to blank -- read
      # verbatim it looked like content. Decode the numeric forms, then the
      # named ones, then drop any remaining backslash.
      printf '%s' "$out" | perl -pe '
        s/\\u([0-9a-fA-F]{4})/chr(hex($1))/ge;
        s/\\x([0-9a-fA-F]{2})/chr(hex($1))/ge;
        s/\\n/\n/g; s/\\t/\t/g; s/\\r/\r/g; s/\\0/ /g;
        s/\\(.)/$1/g'
      return ;;
    \'*)
      out=${v:1}; printf '%s' "${out%%\'*}"; return ;;
  esac
  # Plain scalar: '#' opens a comment at the start or after whitespace, and
  # only then does a null spelling mean anything.
  [[ "$v" == '#'* ]] && { printf ''; return; }
  v="${v%%[[:space:]]#*}"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in null|Null|NULL|'~') v="" ;; esac
  printf '%s' "$v"
}

# What follows the closing quote of a quoted scalar. Exit 1 when the quote is
# never closed.
#
# The decoder stops AT the closing quote and discards whatever comes after, so
# `source: "https://example.com" [` yielded a clean URL and audited fine — and
# the unmatched-line guard cannot see it either, because the line does start
# with a recognized key. Under a canonical-form posture the tail has to be
# checked, not dropped.
yaml_quoted_tail() {
  local v=$1 q=${1:0:1} i=1 c prev=""
  while (( i < ${#v} )); do
    c=${v:i:1}
    # A backslash escape only applies inside DOUBLE quotes; in a single-quoted
    # YAML scalar a backslash is an ordinary character.
    if [[ "$c" == "$q" && ! ( "$q" == '"' && "$prev" == "\\" ) ]]; then
      printf '%s' "${v:i+1}"; return 0
    fi
    prev="$c"; i=$((i+1))
  done
  return 1
}

problems=0
checked=0

while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  checked=$((checked+1))
  rel="${f#"$root"/}"

  if [[ "$(head -n1 "$f")" != "---" ]]; then
    printf '%s\n    no front matter — untrusted, do not read from it\n' "$rel"
    problems=$((problems+1))
    continue
  fi

  # The front matter must actually CLOSE. Without this, awk runs to EOF, the
  # whole file becomes "front matter", the four keys are found somewhere in it
  # and the file is reported Clean -- while the leak loop below sees no prose
  # at all and skips its scan, so a body full of slicer values passes twice.
  # Requiring the terminator BEFORE the first blank line is deliberate: a bare
  # "does a second --- exist?" test is satisfied by an ordinary markdown
  # horizontal rule further down the body, which is the same hole again. The
  # schema is a contiguous four-key block, which is what new-external.sh emits.
  if ! awk 'NR==1{next} /^---$/{ok=1;exit} /^[[:space:]]*$/{exit} END{exit ok?0:1}' "$f"; then
    printf '%s\n    front matter never closed — no terminating "---" line\n' "$rel"
    problems=$((problems+1))
    continue
  fi

  fm="$(awk 'NR==1&&/^---$/{next} /^---$/{exit} {print}' "$f")"

  # Validate the CANONICAL form and refuse everything else.
  #
  # This front matter is machine-written by new-external.sh: four keys, one
  # line each, each a quoted or plain scalar. Trying to accept arbitrary YAML
  # instead has now failed five rounds running -- quoted-empty, plain nulls,
  # inline comments, escaped whitespace, and now block scalars and duplicate
  # keys -- because each was patched as its own case, and every one of them was
  # a file with NO provenance that audited Clean. Hand-rolling a YAML parser in
  # bash is unbounded; checking that a generated file still looks generated is
  # not. Anything outside the canonical form is reported as unsupported, and
  # the remedy is to rewrite it with new-external.sh.
  note=""
  add_note() { note="${note}${note:+; }$1"; }
  # Every line has to be one of the four. Checking only that the four are
  # PRESENT left the rest of the block unread, so `unexpected: [` sat in an
  # otherwise valid file and still audited Clean -- invalid YAML certified as
  # canonical. Claiming a fixed form and then not enforcing it is the weaker
  # half of both postures.
  while IFS= read -r line; do
    [[ -z "${line//[[:space:]]/}" ]] && continue
    case "$line" in
      source:*|retrieved:*|trust:*|scope:*) ;;
      *) add_note "unsupported line: ${line}" ;;
    esac
  done <<<"$fm"
  for key in source retrieved trust scope; do
    cnt="$(grep -cE "^${key}:" <<<"$fm")"
    if (( cnt == 0 )); then add_note "${key}: absent"; continue; fi
    # Duplicates are ambiguous by definition -- readers variously reject them
    # or keep the last -- and `head -1` silently validated the FIRST, so a good
    # value followed by `source: null` passed.
    if (( cnt > 1 )); then add_note "${key}: repeated ${cnt}x"; continue; fi
    raw="$(sed -n "s/^${key}:[[:space:]]*//p" <<<"$fm")"
    case "$raw" in
      [\|\>]*) add_note "${key}: block scalars are not supported here"; continue ;;
      \"*|\'*)
        if tail="$(yaml_quoted_tail "$raw")"; then
          tail="${tail#"${tail%%[![:space:]]*}"}"
          if [[ -n "$tail" && "$tail" != '#'* ]]; then
            add_note "${key}: unexpected text after the quoted value: ${tail}"; continue
          fi
        else
          add_note "${key}: quoted value is never closed"; continue
        fi ;;
    esac
    val="$(yaml_scalar "$raw")"
    if [[ -z "${val//[[:space:]]/}" ]]; then add_note "${key}: empty"; continue; fi
    # Both validate the DECODED value. Matching the serialized text rejected a
    # validly quoted `retrieved: "2026-08-30"` -- a false positive introduced
    # by adding the decoder to the presence check alone.
    case "$key" in
      retrieved)
        [[ "$val" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
          || add_note "retrieved is not YYYY-MM-DD: ${val}" ;;
      trust)
        [[ "$val" == "background" ]] \
          || add_note "trust must be \"background\" in external/ (got: ${val})" ;;
    esac
  done
  if [[ -n "$note" ]]; then
    printf '%s\n    %s\n' "$rel" "$note"
    problems=$((problems+1))
    continue
  fi
done < <(find "$root/external" -type f -name '*.md' | sort)

# Cheap smell test: process parameters that should never live in external/.
# Only prose counts — front matter and HTML comments are stripped first, or the
# template's own warning text trips the detector.
PARAM_RE='nozzle temp|bed temp|chamber temp|extrusion multiplier|pressure advance|volumetric speed|dry(ing)? (temp|time)'
leaks=0
while IFS= read -r f; do
  # Fail OPEN on unterminated front matter: if fm is still set at EOF the
  # delimiter never closed, so treat the entire file as prose and scan it
  # rather than emitting nothing. Skipping it is what let a body of prohibited
  # values through -- and this loop does not share the `continue` above.
  prose="$(awk 'NR==1&&/^---$/{fm=1;next} fm&&/^---$/{fm=0;next} !fm
                END{if (fm) {while ((getline line < FILENAME) > 0) print line}}' "$f" \
           | perl -0777 -pe 's/<!--.*?-->//gs')"
  [[ -z "$prose" ]] && continue
  if grep -qiE "$PARAM_RE" <<<"$prose"; then
    (( leaks == 0 )) && printf '\nPossible processing parameters in external/ (tier 4 must not carry these):\n'
    printf '    %s\n' "${f#"$root"/}"
    leaks=$((leaks+1))
  fi
done < <(find "$root/external" -type f -name '*.md' | sort)

printf '\nChecked %d file(s) in external/.\n' "$checked"
if (( problems == 0 && leaks == 0 )); then
  printf 'Clean.\n'; exit 0
fi
printf '%d provenance problem(s), %d possible parameter leak(s).\n' "$problems" "$leaks"
exit 1
