#!/usr/bin/env python3
"""Commit-aware Codex review verdict for a PR.

Codex's review state is subtle and easy to misread — this script encodes the
rules learned the hard way (and hardened by adversarial review):

  * The CLEAN signal is an ISSUE COMMENT ("Codex Review: Didn't find any major
    issues. Reviewed commit `<oid>`") or a 👍 REACTION — NEVER a PR review
    object. Codex never submits an APPROVED review.
  * A PR REVIEW OBJECT therefore always means FINDINGS (its suggestions may be
    inline comments tied via `pull_request_review_id`, OR in the review body).
    A review carries a stable `commit_id` (the commit it reviewed).
  * FINDINGS on the current HEAD are STICKY (worst-wins): a later clean comment
    or a benign 0-inline review can never clear an earlier HEAD findings review.
    (Safe direction: at worst this blocks merging a HEAD Codex later re-cleared
    in place — recover by pushing a new commit.)
  * Codex re-reviews STALE commits — gate every verdict on the current HEAD.
    Match a review by `commit_id`; match a clean comment ONLY via its explicit
    "Reviewed commit" line (never guess a SHA from arbitrary body text); require
    >= 9 SHA chars to avoid prefix-collision false matches.
  * A clean 👍 reaction is trusted only when it's a CODEX reaction on a request
    tied to the current HEAD (its body names a SHA HEAD starts with) — otherwise
    a 👍 earned by an earlier commit would pass the gate for unreviewed changes.
  * Bot identity is pinned (`chatgpt-codex-connector[bot]`, type "Bot") — a
    "codex" substring login is spoofable on a public PR.

Output (one line):
  CLEAN <oid>            -- gate satisfied: clean review/reaction of HEAD
  FINDINGS <oid> <n>     -- a review of HEAD; n inline findings (read body too if 0)
  RATELIMIT              -- Codex usage limit is the freshest signal; wait for reset
  STALE <oid>            -- latest verdict is for an older commit; push/wait
  NONE                   -- no Codex activity yet

Usage: codex-verdict.py <PR> <HEAD_full_sha> [owner/repo]
Exit codes: 0 with a verdict line, 2 on a gh/API error.
"""
import json, re, subprocess, sys

if len(sys.argv) < 3:
    print("usage: codex-verdict.py <PR> <HEAD_sha> [owner/repo]", file=sys.stderr)
    sys.exit(2)

PR = sys.argv[1]
HEAD = sys.argv[2].lower()
REPO = sys.argv[3] if len(sys.argv) > 3 else None

def gh(path):
    # Relative endpoint form (no leading "/"): on Windows `gh api` rejects an
    # endpoint that looks like an absolute filesystem path.
    path = path.lstrip("/")
    # `--paginate` alone emits each page as a SEPARATE JSON document (so a
    # multi-page PR isn't a single parseable doc). `--slurp` wraps the pages in
    # one outer array — flatten it (all our endpoints return arrays).
    out = subprocess.run(["gh", "api", path, "--paginate", "--slurp"], capture_output=True, text=True)
    if out.returncode == 0:
        pages = json.loads(out.stdout or "[]")
        flat = []
        for p in pages:
            flat.extend(p if isinstance(p, list) else [p])
        return flat
    # Fallback for an older gh without --slurp: a single (first) page.
    out = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if out.returncode != 0:
        print("ERR", out.stderr.strip()[:200], file=sys.stderr)
        sys.exit(2)
    return json.loads(out.stdout or "[]")

if REPO is None:
    r = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print("ERR could not resolve repo; pass owner/repo", file=sys.stderr)
        sys.exit(2)
    REPO = r.stdout.strip()

# Pin the Codex actor: the `[bot]` login is unspoofable (brackets aren't valid
# in a human username) and `type == "Bot"` confirms it. A substring match on
# "codex" would let a public-PR user spoof a clean verdict.
CODEX_LOGINS = {"chatgpt-codex-connector[bot]", "chatgpt-codex-connector"}

def is_codex(user):
    if not isinstance(user, dict):
        return False
    login = user.get("login")
    return login in CODEX_LOGINS and (login.endswith("[bot]") or user.get("type") == "Bot")

def body_of(x):
    return x.get("body") or ""  # REST can return body: null (hidden/deleted)

def reviewed_oid(body):
    m = re.search(r"Reviewed commit:\**\s*`?([0-9a-f]{7,40})`?", body or "", re.I)
    return m.group(1).lower() if m else None

MIN_SHA = 9  # reject sub-9-char SHAs — a short prefix can collide with HEAD.

def matches_head(oid):
    return bool(oid) and len(oid) >= MIN_SHA and HEAD.startswith(oid.lower())

def names_head(body):
    # True if the text contains a >=9-char hex SHA that HEAD starts with.
    return any(HEAD.startswith(m.lower()) for m in re.findall(r"[0-9a-f]{9,40}", body or "", re.I))

reviews = gh(f"repos/{REPO}/pulls/{PR}/reviews")
inline = gh(f"repos/{REPO}/pulls/{PR}/comments")
issues = gh(f"repos/{REPO}/issues/{PR}/comments")

codex_issue = [c for c in issues if is_codex(c.get("user"))]
codex_reviews = sorted([r for r in reviews if is_codex(r.get("user"))], key=lambda r: r.get("submitted_at") or "")
ratelimit_comments = [c for c in codex_issue if re.search(r"reached your Codex usage limits|usage limit", body_of(c), re.I)]
clean_comments = [c for c in codex_issue if re.search(r"didn'?t find any (major )?issues|no major issues", body_of(c), re.I)]

# HEAD findings are STICKY: any non-APPROVED Codex review on HEAD = findings
# (Codex never APPROVEs). Worst-wins — a later clean comment / benign review
# never clears it.
head_findings = False
head_findings_count = 0
for r in codex_reviews:
    oid = r.get("commit_id") or reviewed_oid(body_of(r))
    if matches_head(oid):
        tied = [c for c in inline if is_codex(c.get("user")) and c.get("pull_request_review_id") == r["id"]]
        if r.get("state") != "APPROVED" or tied:
            head_findings = True
            head_findings_count = max(head_findings_count, len(tied))

# Clean issue comment for HEAD — bound ONLY via the explicit "Reviewed commit"
# line, never a guessed body token.
head_clean = any(matches_head(reviewed_oid(body_of(c))) for c in clean_comments)

# 1) Findings on HEAD win unconditionally (worst-wins).
if head_findings:
    print("FINDINGS", HEAD[:10], head_findings_count); sys.exit(0)

# 2) Clean comment for HEAD.
if head_clean:
    print("CLEAN", HEAD[:10]); sys.exit(0)

# 3) Rate limit — only if it's Codex's FRESHEST signal (a historical limit hit
#    later followed by a verdict must not block the gate forever).
def newest(ts):
    ts = [t for t in ts if t]
    return max(ts) if ts else ""
review_time = codex_reviews[-1].get("submitted_at") if codex_reviews else ""
clean_time = newest([c.get("created_at") for c in clean_comments])
rl_time = newest([c.get("created_at") for c in ratelimit_comments])
if rl_time and rl_time >= review_time and rl_time >= clean_time:
    print("RATELIMIT"); sys.exit(0)

# 4) A CODEX 👍 on a review REQUEST tied to the CURRENT HEAD means clean. The
#    request body must name HEAD (the skill's "Addressed in <sha>") so a 👍
#    earned by an earlier commit can't pass the gate for unreviewed changes.
head_requests = sorted(
    [c for c in issues if "@codex review" in body_of(c).lower() and names_head(body_of(c))],
    key=lambda c: c.get("created_at") or "",
)
if head_requests:
    rc = gh(f"repos/{REPO}/issues/comments/{head_requests[-1]['id']}/reactions")
    if any(is_codex(x.get("user")) and x.get("content") in ("+1", "hooray", "rocket", "heart") for x in rc):
        print("CLEAN reaction"); sys.exit(0)

# 5) Codex weighed in, but its latest verdict is for an OLDER commit (a review
#    for a non-HEAD SHA, or a clean comment for one — which may exist with NO
#    review objects). Report STALE (push a new commit) rather than NONE.
stale = []
if codex_reviews:
    r = codex_reviews[-1]
    stale.append((r.get("submitted_at") or "", r.get("commit_id") or reviewed_oid(body_of(r)) or "?"))
if clean_comments:
    c = max(clean_comments, key=lambda c: c.get("created_at") or "")
    stale.append((c.get("created_at") or "", reviewed_oid(body_of(c)) or "?"))
if stale:
    stale.sort()
    print("STALE", stale[-1][1]); sys.exit(0)

print("NONE")
