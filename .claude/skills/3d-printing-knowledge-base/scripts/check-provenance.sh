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
      printf '%s' "$out"; return ;;
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

  missing=""
  for key in source retrieved trust scope; do
    # A QUOTED-EMPTY value has to count as missing. The generator emits these
    # fields as quoted scalars, so `source: ""` satisfies a bare
    # non-whitespace test -- the quotes are the content -- and a file with no
    # provenance at all passes the audit. Strip surrounding quotes before
    # deciding, and require something left.
    val="$(yaml_scalar "$(sed -n "s/^${key}:[[:space:]]*//p" <<<"$fm" | head -1)")"
    [[ -n "${val//[[:space:]]/}" ]] || missing="${missing}${missing:+ }${key}"
  done
  if [[ -n "$missing" ]]; then
    printf '%s\n    missing/empty: %s\n' "$rel" "$missing"
    problems=$((problems+1))
    continue
  fi

  d="$(sed -n 's/^retrieved:[[:space:]]*//p' <<<"$fm" | head -1)"
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || {
    printf '%s\n    retrieved is not YYYY-MM-DD: %s\n' "$rel" "$d"
    problems=$((problems+1)); continue; }

  t="$(sed -n 's/^trust:[[:space:]]*//p' <<<"$fm" | head -1)"
  [[ "$t" == "background" ]] || {
    printf '%s\n    trust must be "background" in external/ (got: %s)\n' "$rel" "$t"
    problems=$((problems+1)); continue; }
done < <(find "$root/external" -type f -name '*.md' | sort)

# Cheap smell test: process parameters that should never live in external/.
# Only prose counts — front matter and HTML comments are stripped first, or the
# template's own warning text trips the detector.
PARAM_RE='nozzle temp|bed temp|chamber temp|extrusion multiplier|pressure advance|volumetric speed|dry(ing)? (temp|time)'
# Without perl the comment strip used to fail into an empty $prose for every
# file, skipping the entire scan while still printing "Clean." Refuse loudly.
if ! command -v perl >/dev/null 2>&1; then
  printf 'ERROR: perl is required for the parameter-leak scan (it strips HTML comments).\n' >&2
  exit 1
fi
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
