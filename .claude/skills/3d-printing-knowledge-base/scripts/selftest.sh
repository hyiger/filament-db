#!/usr/bin/env bash
# selftest.sh — corpus test for check-provenance.sh and new-external.sh.
#
# Usage: scripts/selftest.sh          Exit 0 = all cases pass.
#
# WHY THIS EXISTS. These two scripts went thirteen review rounds, and nearly
# every round found one more way to write a file with no provenance that still
# audited "Clean". Each was fixed as its own special case because there was
# nothing to run — no harness meant no way to ask "what ELSE is open?", so the
# question was only ever answered one exploit at a time by a reviewer.
#
# Every case below is a shape that once passed and should not, or once failed
# and should not. Add to it before fixing the next one.

set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0

# Each case runs in a fresh tree so files cannot interact.
run_case() { # name expect(ok|bad) file-body...
  local name=$1 expect=$2; shift 2
  local d; d="$(mktemp -d)"; mkdir -p "$d/external"
  printf '%s' "$1" > "$d/external/t.md"
  local out rc
  out="$(cd "$d" && bash "$here/check-provenance.sh" 2>&1)"; rc=$?
  rm -rf "$d"
  if { [[ "$expect" == ok ]] && (( rc == 0 )); } || { [[ "$expect" == bad ]] && (( rc != 0 )); }; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
    printf 'FAIL [%s] expected %s, got exit %d\n%s\n\n' "$name" "$expect" "$rc" "$out"
  fi
}

fm() { printf -- '---\nsource:    %s\nretrieved: %s\ntrust:     %s\nscope:     %s\n---\n\n# t\n\nInert body.\n' \
       "$1" "${2:-2026-08-30}" "${3:-background}" "${4:-\"chem\"}"; }

B='\'   # one literal backslash

# --- values that carry NO provenance (all once audited Clean) ---------------
run_case quoted-empty      bad "$(fm '""')"
run_case plain-null        bad "$(fm 'null')"
run_case tilde-null        bad "$(fm '~')"
run_case comment-only      bad "$(fm 'null # unavailable')"
run_case esc-tab           bad "$(fm "\"${B}t\"")"
run_case esc-unicode-space bad "$(fm "\"${B}u0020\"")"
run_case block-scalar      bad "$(fm '>')"
run_case flow-map          bad "$(fm '{}')"
run_case flow-seq          bad "$(fm '[]')"
run_case anchor            bad "$(fm '&a')"
run_case tag-null          bad "$(fm '!!null')"
run_case tag-emptystr      bad "$(fm '!!str')"
run_case bare-bang         bad "$(fm '!')"
run_case alias             bad "$(fm '*a')"

# --- structurally malformed (once audited Clean) ---------------------------
run_case junk-after-quote  bad "$(fm '"https://x" [')"
run_case unterminated-q    bad "$(fm '"https://x')"
run_case colon-space-value bad "$(fm 'Vendor TDS: rev 3')"
run_case trailing-colon    bad "$(fm 'Vendor TDS:')"
run_case duplicate-key     bad "$(printf -- '---\nsource:    https://x\nsource:    null\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"
run_case extra-line        bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\nunexpected: [\n---\n\n# t\n')"
run_case no-space-colon    bad "$(printf -- '---\nsource:https://x\nretrieved:2026-08-30\ntrust:background\nscope:c\n---\n\n# t\n')"
run_case unterminated-fm   bad "$(printf -- '---\nsource:    "x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n\n# t\n')"
run_case no-front-matter   bad "$(printf -- '# just a heading\n\nBody.\n')"
run_case bad-date          bad "$(fm '"https://x"' '30-08-2026')"
run_case bad-trust         bad "$(fm '"https://x"' '2026-08-30' 'authored')"

# --- legitimate input that MUST pass (false positives are the worse bug) ----
run_case good-quoted       ok  "$(fm '"https://example.com/tds.pdf"')"
run_case good-plain        ok  "$(fm 'https://example.com/tds.pdf')"
run_case good-single       ok  "$(fm "'https://example.com/tds.pdf'")"
run_case quoted-metadata   ok  "$(fm '"https://x"' '"2026-08-30"' '"background"')"
run_case hash-in-value     ok  "$(fm '"Vendor TDS #12: rev 3"')"
run_case escaped-quotes    ok  "$(fm "\"He said ${B}\"hi${B}\" TDS\"")"
run_case trailing-comment  ok  "$(fm '"https://x" # checked')"
run_case quoted-null-str   ok  "$(fm '"null"')"
run_case leading-dash      ok  "$(fm '-Vendor-TDS-rev-3')"
run_case colon-no-space    ok  "$(fm 'ref:12345')"
run_case colon-tab-sep     bad "$(printf -- '---\nsource:    Vendor:\trev\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"
run_case non-ascii         ok  "$(fm '"Émile — TDS révision 3"')"
run_case backslash-tail    ok  "$(fm "\"Vendor TDS rev 3${B}${B}\"")"
run_case windows-path      ok  "$(fm "\"C:${B}${B}temp${B}${B}tds.pdf\"")"
# `t` and `d` happen to be valid escape letters, so the case above passed even
# when escapes were validated by an independent per-backslash regex. `q` is
# not, which is what actually exercises the stateful walk.
run_case windows-path-q    ok  "$(fm "\"C:${B}${B}query${B}${B}vendor.pdf\"")"
run_case apostrophe-single ok  "$(fm "'Vendor''s TDS'")"

# --- leak scan --------------------------------------------------------------
run_case leak-in-body      bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n\nRun the nozzle temp at 265C.\n')"
run_case leak-in-comment   bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n<!--\n  bed temperature 100C\n-->\n')"
run_case leak-underscored  bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\nSet bed_temperature to 100.\n')"
run_case chemistry-ok      ok  "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\nPA6 reduces shrinkage anisotropy; chain retraction in the Doi-Edwards tube model.\n')"
run_case url-with-temp-ok  ok  "$(printf -- '---\nsource:    "https://x.com/pa6-cf-bed-temp-chart"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\nInert body.\n')"

# --- YAML escape semantics (the set is closed; the catch-all was not) -------
run_case esc-U-8digit      bad "$(fm "\"${B}U00000020\"")"
run_case esc-unknown-q     bad "$(fm "\"${B}q\"")"
run_case esc-backspace     bad "$(fm '"https://x"' '2026-08-30' "\"${B}background\"")"
run_case esc-known-newline ok  "$(fm "\"Vendor TDS${B}nrev 3\"")"
run_case esc-slash         ok  "$(fm "\"https:${B}/${B}/x/tds\"")"
run_case esc-U-out-of-range bad "$(fm "\"${B}U00110000\"")"
run_case esc-surrogate     bad "$(fm "\"${B}uD800\"")"
run_case esc-U-valid       ok  "$(fm "\"caf${B}U000000e9 TDS\"")"

# --- byte-level shapes an editor introduces on its own ----------------------
run_case crlf              ok  "$(printf -- '---\r\nsource:    "https://x"\r\nretrieved: 2026-08-30\r\ntrust:     background\r\nscope:     "c"\r\n---\r\n\r\n# t\r\n')"
run_case bom               ok  "$(printf -- '\xEF\xBB\xBF---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"
run_case control-char      bad "$(printf -- '---\nsource:    "a\x01b"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"

# --- enumeration and write-scope --------------------------------------------
# These need a tree rather than a single file, so they are hand-rolled.
# An UNREADABLE subtree, not a symlink cycle: the cycle case is
# find-implementation-dependent — bfs and GNU find report it, while BSD find
# (macOS's default, and what this script actually runs under) detects and skips
# it silently and correctly, so there is nothing to catch there. A permission
# error is reported by every implementation.
d="$(mktemp -d)"; mkdir -p "$d/external/locked"
printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n' > "$d/external/good.md"
printf 'x' > "$d/external/locked/hidden.md"; chmod 000 "$d/external/locked"
if [[ "$(id -u)" == "0" ]]; then
  printf 'SKIP [enumeration-error] running as root; chmod cannot deny\n'
elif (cd "$d" && bash "$here/check-provenance.sh" >/dev/null 2>&1); then
  fail=$((fail+1)); printf 'FAIL [enumeration-error] audit certified an incomplete enumeration\n'
else pass=$((pass+1)); fi
chmod 755 "$d/external/locked" 2>/dev/null; rm -rf "$d"

# A NUL byte is stripped by command substitution before any validator sees it.
d="$(mktemp -d)"; mkdir -p "$d/external"
printf -- '---\nsource:    "a\000b"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n' > "$d/external/nul.md"
if (cd "$d" && bash "$here/check-provenance.sh" >/dev/null 2>&1); then
  fail=$((fail+1)); printf 'FAIL [nul-byte] audit reported clean for a NUL-bearing file\n'
else pass=$((pass+1)); fi
rm -rf "$d"

# A dangling symlink let the external-only generator write outside external/.
d="$(mktemp -d)"; mkdir -p "$d/external" "$d/authored"
ln -s ../authored/leaked.md "$d/external/evil.md"
(cd "$d" && bash "$here/new-external.sh" "https://x/tds" evil >/dev/null 2>&1)
if [[ -f "$d/authored/leaked.md" ]]; then
  fail=$((fail+1)); printf 'FAIL [symlink-escape] generator wrote through a link into authored/\n'
else pass=$((pass+1)); fi
rm -rf "$d"

# A tree holding only legitimately-unaudited files (a saved PDF) must PASS:
# they are listed, never fatal, and the zero-audited guard contradicted that.
d="$(mktemp -d)"; mkdir -p "$d/external"; printf '%%PDF-1.4' > "$d/external/paper.pdf"
if (cd "$d" && bash "$here/check-provenance.sh" >/dev/null 2>&1); then pass=$((pass+1)); else
  fail=$((fail+1)); printf 'FAIL [pdf-only-tree] a directory of unaudited files was failed\n'; fi
rm -rf "$d"

# external/ aliasing a read-only tier is a second write-scope escape: -d
# follows the link, and the per-file -L check is false for a child that does
# not exist yet. BOTH the tier root and a descendant of it — an equality-only
# check let `external -> authored/references` through.
d="$(mktemp -d)"; mkdir -p "$d/authored"; ln -s authored "$d/external"
(cd "$d" && bash "$here/new-external.sh" "https://x/tds" esc >/dev/null 2>&1)
if [[ -f "$d/authored/esc.md" ]]; then
  fail=$((fail+1)); printf 'FAIL [external-alias-root] generator wrote into authored/\n'
else pass=$((pass+1)); fi
rm -rf "$d"

d="$(mktemp -d)"; mkdir -p "$d/authored/references"; ln -s authored/references "$d/external"
(cd "$d" && bash "$here/new-external.sh" "https://x/tds" esc >/dev/null 2>&1)
if [[ -f "$d/authored/references/esc.md" ]]; then
  fail=$((fail+1)); printf 'FAIL [external-alias-descendant] generator wrote into authored/references/\n'
else pass=$((pass+1)); fi
rm -rf "$d"

# --- generator round-trip: whatever new-external.sh writes must audit clean --
gen_case() { # name citation [scope]
  local d; d="$(mktemp -d)"; mkdir -p "$d/external"
  local out rc
  if ! out="$(cd "$d" && bash "$here/new-external.sh" "$2" "gen$RANDOM" ${3:+"$3"} 2>&1)"; then
    fail=$((fail+1)); printf 'FAIL [%s] generator refused: %s\n' "$1" "$out"; rm -rf "$d"; return
  fi
  out="$(cd "$d" && bash "$here/check-provenance.sh" 2>&1)"; rc=$?
  rm -rf "$d"
  if (( rc == 0 )); then pass=$((pass+1)); else
    fail=$((fail+1)); printf 'FAIL [%s] generator output rejected by auditor:\n%s\n\n' "$1" "$out"; fi
}
gen_case gen-url        "https://en.wikipedia.org/wiki/Polyphenylene_sulfide"
gen_case gen-colon-hash 'Vendor TDS: rev 3 #12'
gen_case gen-quotes     'He said "hi" in the TDS'
gen_case gen-backslash  'Vendor TDS rev 3\'
gen_case gen-winpath    'C:\temp\tds.pdf'
gen_case gen-winpath-q  'C:\query\vendor.pdf'
gen_case gen-non-ascii  'Émile — révision 3'
gen_case gen-scope-hash "https://x/tds" 'chemistry only #1'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
