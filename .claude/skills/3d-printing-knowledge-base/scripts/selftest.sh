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
# Right shape, not a real date — the field exists to say WHEN, so an
# impossible one cannot answer that. Leap years must still pass.
run_case impossible-feb30  bad "$(fm '"https://x"' '2026-02-30')"
run_case impossible-month  bad "$(fm '"https://x"' '2026-99-99')"
run_case leap-day-ok       ok  "$(fm '"https://x"' '2024-02-29')"
run_case non-leap-feb28-ok ok  "$(fm '"https://x"' '2026-02-28')"
run_case century-leap-ok   ok  "$(fm '"https://x"' '2000-02-29')"
run_case century-nonleap   bad "$(fm '"https://x"' '1900-02-29')"
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
# A YAML boolean is never provenance; a NUMBER can be (ISBN, year, DOI), so
# only the boolean half of "implicitly typed" is enforced.
run_case bool-true         bad "$(fm 'true')"
run_case bool-no           bad "$(fm 'no')"
run_case bool-off-upper    bad "$(fm 'OFF')"
run_case quoted-true-ok    ok  "$(fm '"true"')"
run_case isbn-unquoted-ok  ok  "$(fm '9780123456789')"
run_case year-unquoted-ok  ok  "$(fm '2026')"
run_case doi-unquoted-ok   ok  "$(fm '10.1016/j.polymer.2019.05.001')"
run_case leading-dash      ok  "$(fm '-Vendor-TDS-rev-3')"
run_case colon-no-space    ok  "$(fm 'ref:12345')"
run_case colon-tab-sep     bad "$(printf -- '---\nsource:    Vendor:\trev\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"
# A bare tab inside a plain scalar is valid YAML — only colon-TAB is a mapping
# separator. Rejecting every tab was a false positive, and for this pair of
# scripts a false positive is worse than the miss it replaced.
run_case plain-tab-ok      ok  "$(printf -- '---\nsource:    Vendor\tTDS rev 3\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"
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
# Only http(s) was exempt, so every other locator shape a person cites was
# flattened by the tr into a parameter phrase — and the GENERATOR writes these.
lk() { printf -- '---\nsource:    %s\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\nInert body.\n' "$1"; }
# ...and the strip must stay locator-SHAPED. A whole-token strip would drop
# this, which is an ordinary way to write a real leak.
run_case leak-slash-pair   bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\nnozzle/bed temp 265/100 here.\n')"
# A citation may contain SPACES; token-based strips removed only fragments and
# left the parameter words behind.
# ...but the whole-value strip must stay gated on the value being a locator END
# TO END. The front matter is scanned on purpose — new-external.sh copies user
# input verbatim — so prose in a scope note must still be reachable.
run_case leak-in-scope     bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "nozzle temp 265 for reference"\n---\n\nInert body.\n')"
run_case leak-scope-slash  bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "chemistry only / nozzle temp 265"\n---\n\nInert body.\n')"
# `source:` is blanked wholesale and `scope:` is scanned as prose, so a scope
# that merely STARTS with a locator must still have its prose read — blanking
# on a prefix match hid a real leak.
# Locator stripping is GONE (see check-provenance.sh). A body citation whose
# filename carries parameter-like words now flags, and the remedy is an
# in-file marker — explicit and auditable, rather than a regex nobody can read.
bodyf() { printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n%s\n' "$1"; }
run_case body-path-now-flags bad "$(bodyf 'See /Users/r/My Charts/pa6-cf-bed-temp-chart.pdf')"
run_case body-path-suppressed ok "$(bodyf '<!-- allow-param-smell: filename words, not a setting -->

See /Users/r/My Charts/pa6-cf-bed-temp-chart.pdf')"
# The marker must require a REASON, so it cannot silence a file invisibly.
# Three refusal shapes, not one: the original case used the no-colon form and
# so passed while `<!-- allow-param-smell: -->` — colon, empty reason — still
# suppressed a real leak. A case that only exercises the easy shape is not
# coverage.
run_case marker-no-colon    bad "$(bodyf '<!-- allow-param-smell -->

Set the nozzle temp to 265 C.')"
run_case marker-empty-reason bad "$(bodyf '<!-- allow-param-smell: -->

Set the nozzle temp to 265 C.')"
run_case marker-blank-reason bad "$(bodyf '<!-- allow-param-smell:    -->

Set the nozzle temp to 265 C.')"
# Bash's [[:space:]] is ASCII-only under the C locale, so these three silenced
# a real leak after the ASCII fix. U+202F is the character this repo's "Space"
# number format emits, which makes it a plausible paste rather than a curio.
# The same Unicode-whitespace hole existed in the FIELD emptiness test, not
# just the suppression reason — fixed in one place and left in two others.
run_case nbsp-only-source  bad "$(fm "\"$(printf '\302\240')\"")"
run_case nbsp-only-scope   bad "$(fm '"https://x"' '2026-08-30' 'background' "\"$(printf '\302\240')\"")"
# Command substitution strips a decoded TRAILING NEWLINE, so `background\n`
# compared equal to `background` and a file a YAML reader sees differently
# audited clean.
run_case trailing-nl-trust bad "$(fm '"https://x"' '2026-08-30' "\"background${B}n\"")"
run_case trailing-nl-date  bad "$(fm '"https://x"' "\"2026-08-30${B}n\"")"
run_case marker-nbsp-reason  bad "$(bodyf "$(printf '<!-- allow-param-smell: \302\240 -->\n\nSet the nozzle temp to 265 C.')")"
run_case marker-nnbsp-reason bad "$(bodyf "$(printf '<!-- allow-param-smell: \342\200\257 -->\n\nSet the nozzle temp to 265 C.')")"
run_case marker-ideo-reason  bad "$(bodyf "$(printf '<!-- allow-param-smell: \343\200\200 -->\n\nSet the nozzle temp to 265 C.')")"
run_case marker-tight-spacing ok "$(bodyf '<!--allow-param-smell:filename words-->

Set the nozzle temp to 265 C.')"
# A bare URL token stays exempt — it is the one strip that cannot be wrong,
# because \S* stops at whitespace and can only consume one token.
run_case body-url-exempt     ok  "$(bodyf 'See https://x.com/pa6-cf-bed-temp-chart for it.')"
run_case url-cannot-swallow  bad "$(bodyf 'A url foo://nozzle then nozzle temp 265 C.')"

# The source exemption is for the FRONT-MATTER field only — a body line that
# merely begins with that word is prose like any other.
run_case leak-body-source-line bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\nsource: nozzle temp 265 C\n')"
run_case leak-scope-after-locator bad "$(printf -- '---\nsource:    "https://x"\nretrieved: 2026-08-30\ntrust:     background\nscope:     "~/notes then nozzle temp 265"\n---\n\nInert body.\n')"
# (the escaped-quote citation is exercised end-to-end via gen_case below,
#  which is the faithful test: the generator is what emits the \" form)

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
# NEL, LS and PS are legal characters that YAML treats as LINE BREAKS, so the
# value a reader receives differs from the one these line-oriented checks saw.
run_case yaml-nel          bad "$(printf -- '---\nsource:    foo\302\205bar\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"
run_case yaml-ls           bad "$(printf -- '---\nsource:    foo\342\200\250bar\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"
run_case yaml-ps           bad "$(printf -- '---\nsource:    foo\342\200\251bar\nretrieved: 2026-08-30\ntrust:     background\nscope:     "c"\n---\n\n# t\n')"
# ...while ordinary accented text and punctuation must keep passing.
run_case non-ascii-rich    ok  "$(fm '"Émile — révision 3 · café"')"
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

# Finder creates .DS_Store the moment anyone opens the folder, and both
# enumerations skip dotfiles — so the zero-audited guard must skip them too,
# or opening the directory makes the audit permanently red with no remedy.
d="$(mktemp -d)"; mkdir -p "$d/external"; printf '\000\001' > "$d/external/.DS_Store"
if (cd "$d" && bash "$here/check-provenance.sh" >/dev/null 2>&1); then pass=$((pass+1)); else
  fail=$((fail+1)); printf 'FAIL [dotfile-only] .DS_Store alone failed the audit\n'; fi
rm -rf "$d"

# ...but a genuinely unexplained empty enumeration must still refuse to certify.
d="$(mktemp -d)"; mkdir -p "$d/external/sub"; printf 'x' > "$d/external/sub/.hidden"
printf 'x' > "$d/external/notes.rtf"
# Captured, not piped into `grep -q`: this file runs under `pipefail`, and
# grep -q exits on the first match, SIGPIPEs the script upstream, and the
# pipeline then reports failure for a run that actually succeeded.
out="$(cd "$d" && bash "$here/check-provenance.sh" 2>&1)"
case "$out" in
  *"Not audited"*) pass=$((pass+1)) ;;
  *) fail=$((fail+1)); printf 'FAIL [unaudited-listed] a non-text file was not listed\n' ;;
esac
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
gen_case gen-escaped-quote 'PA6 "CF" bed temp chart.pdf'

# --- the generator/auditor contract -----------------------------------------
# gen_case above asserts "valid input round-trips". This asserts the weaker but
# much broader invariant that actually caught the bug it was written for: for
# ANY input, either the generator REFUSES it or the auditor reports the result
# clean. What must never happen is the generator exiting 0 on a file its own
# auditor then rejects -- the user gets a success message and a broken file,
# and the two tools disagree about the same bytes.
#
# The point is that a case here does not have to decide in advance WHICH side
# should catch a given input. Three commits running, a validation rule was
# tightened in one script and not its sibling; each time the gap was invisible
# because no test crossed the two. Add nasty inputs here freely -- passing
# costs nothing and the contradiction cannot hide.
gen_contract() { # name citation [scope]
  local d out rc; d="$(mktemp -d)"; mkdir -p "$d/external"
  if ! (cd "$d" && bash "$here/new-external.sh" "$2" "gen$RANDOM" ${3:+"$3"}) >/dev/null 2>&1; then
    pass=$((pass+1)); rm -rf "$d"; return   # refused up front: contract held
  fi
  out="$(cd "$d" && bash "$here/check-provenance.sh" 2>&1)"; rc=$?
  rm -rf "$d"
  if (( rc == 0 )); then pass=$((pass+1)); else
    fail=$((fail+1))
    printf 'FAIL [%s] generator ACCEPTED input its own auditor rejects:\n%s\n\n' "$1" "$out"
  fi
}

# YAML line breaks: legal characters, but a parser splits the line on them, so
# the value the auditor validated is not the value a reader gets.
gen_contract ct-nel        "$(printf 'foo\xc2\x85bar')"
gen_contract ct-ls         "$(printf 'foo\xe2\x80\xa8bar')"
gen_contract ct-ps         "$(printf 'foo\xe2\x80\xa9bar')"
gen_contract ct-nel-scope  'https://x/tds' "$(printf 'chemistry\xc2\x85only')"
gen_contract ct-bel        "$(printf 'foo\x07bar')"
gen_contract ct-del        "$(printf 'foo\x7fbar')"
gen_contract ct-nbsp       "$(printf 'foo\xc2\xa0bar')"
gen_contract ct-badutf8    "$(printf 'foo\xffbar')"
gen_contract ct-lone-surro "$(printf 'foo\xed\xa0\x80bar')"
# YAML-significant prose and quoting shapes.
gen_contract ct-leading-hash   '#not-a-comment'
gen_contract ct-leading-dash   '- looks like a list item'
gen_contract ct-leading-quote  '"unbalanced'
gen_contract ct-trailing-bs    'ends with backslash\'
gen_contract ct-yaml-bool      'yes'
gen_contract ct-yaml-null      '~'
gen_contract ct-brace          '{a: b}'
gen_contract ct-anchor         '&anchor value'
gen_contract ct-tab            "$(printf 'has\ttab')"
gen_contract ct-fake-key       'x" \n retrieved: "1999-01-01'
gen_contract ct-emoji          'TDS 📄 revision 3'
gen_contract ct-rtl            "$(printf 'TDS \xd7\xa2\xd7\x91\xd7\xa8\xd7\x99\xd7\xaa')"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
