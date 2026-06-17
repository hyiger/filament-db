#!/usr/bin/env python3
"""Commit-aware Codex review verdict for a PR.

Codex's review state is subtle and easy to misread — this script encodes the
gotchas learned the hard way:

  * A CLEAN review is an ISSUE COMMENT ("Codex Review: Didn't find any major
    issues. Reviewed commit `<oid>`") — NOT a PR review object. A watcher that
    only polls /pulls/{n}/reviews will wait forever on a clean PR.
  * FINDINGS are a PR REVIEW object (state COMMENTED/CHANGES_REQUESTED, body
    "Here are some automated review suggestions") plus inline comments. The
    inline comments are tied to that review via `pull_request_review_id` — do
    NOT key off comment.commit_id, which GitHub re-anchors to the new HEAD on a
    stale finding.
  * Codex sometimes RE-REVIEWS A STALE COMMIT — its "Reviewed commit" line is
    the previous SHA. Re-posting `@codex review` does NOT dislodge it; only a
    NEW push does. So always gate the verdict on reviewed-commit == HEAD.
  * A clean re-review can arrive as a 👍 REACTION on the `@codex review`
    request comment instead of a new comment.
  * Bot login is `chatgpt-codex-connector` in GraphQL, `chatgpt-codex-connector[bot]`
    in REST — match the substring "codex" to cover both.

Output (one line):
  CLEAN <oid>            -- gate satisfied: clean review of the current HEAD
  FINDINGS <oid> <n>     -- a review of HEAD with n inline findings to address
  RATELIMIT              -- Codex usage limit hit; wait for reset
  STALE <oid>            -- latest review is for an older commit; push/wait
  NONE                   -- no Codex activity yet

Usage: codex-verdict.py <PR> <HEAD_full_sha> [owner/repo]
Exit codes: 0 with a verdict line, 2 on a gh/API error.
"""
import json, re, subprocess, sys

if len(sys.argv) < 3:
    print("usage: codex-verdict.py <PR> <HEAD_sha> [owner/repo]", file=sys.stderr)
    sys.exit(2)

PR = sys.argv[1]
HEAD = sys.argv[2]
REPO = sys.argv[3] if len(sys.argv) > 3 else None

def gh(path):
    # Use the relative endpoint form (no leading "/"): on Windows `gh api`
    # rejects an endpoint that looks like an absolute filesystem path.
    path = path.lstrip("/")
    out = subprocess.run(["gh", "api", path, "--paginate"], capture_output=True, text=True)
    if out.returncode != 0:
        out = subprocess.run(["gh", "api", path], capture_output=True, text=True)
        if out.returncode != 0:
            print("ERR", out.stderr.strip()[:200], file=sys.stderr)
            sys.exit(2)
    txt = out.stdout.strip()
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return json.loads(txt.replace("][", ","))  # --paginate may concat arrays

if REPO is None:
    r = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print("ERR could not resolve repo; pass owner/repo", file=sys.stderr)
        sys.exit(2)
    REPO = r.stdout.strip()

# The Codex actor's identity — REST gives `chatgpt-codex-connector[bot]` (type
# "Bot"); the bare form appears in GraphQL. A substring match on "codex" is
# SPOOFABLE on a public PR (a human could register a "codex"-ish login and post
# a fake "Didn't find any issues" comment to bypass the gate), so pin the exact
# identity. The `[bot]` suffix is itself unspoofable (brackets aren't valid in a
# human username); `type == "Bot"` is the belt-and-suspenders check.
CODEX_LOGINS = {"chatgpt-codex-connector[bot]", "chatgpt-codex-connector"}

def is_codex(user):
    if not isinstance(user, dict):
        return False
    login = user.get("login")
    return login in CODEX_LOGINS and (login.endswith("[bot]") or user.get("type") == "Bot")

def reviewed_oid(body):
    m = re.search(r"Reviewed commit:\**\s*`?([0-9a-f]{7,40})`?", body or "")
    return m.group(1) if m else None

reviews = gh(f"/repos/{REPO}/pulls/{PR}/reviews")
inline = gh(f"/repos/{REPO}/pulls/{PR}/comments")
issues = gh(f"/repos/{REPO}/issues/{PR}/comments")

codex_issue = [c for c in issues if is_codex(c.get("user"))]
codex_reviews = sorted(
    [r for r in reviews if is_codex(r.get("user"))],
    key=lambda r: r.get("submitted_at") or "",
)
ratelimit_comments = [c for c in codex_issue if re.search(r"reached your Codex usage limits|usage limit", c["body"], re.I)]
clean_comments = [c for c in codex_issue if re.search(r"didn'?t find any (major )?issues|no major issues", c["body"], re.I)]

def newest(ts_list):
    ts = [t for t in ts_list if t]
    return max(ts) if ts else ""

def first_sha(body):
    m = re.search(r"([0-9a-f]{7,40})", body or "")
    return m.group(1) if m else None

# Resolve the verdicts that pertain to the CURRENT HEAD, with their timestamps,
# then report whichever is FRESHEST — so a stale (older-commit) review never
# overrides a HEAD verdict, AND a clean comment never masks a NEWER HEAD review
# that has findings (e.g. an auto-review says clean, then `@codex review`
# returns suggestions on the same commit).
head_clean_time = ""
for c in clean_comments:
    oid = reviewed_oid(c["body"]) or first_sha(c["body"])
    if oid and HEAD.startswith(oid):
        head_clean_time = max(head_clean_time, c["created_at"])

# A review's `commit_id` is the STABLE record of the commit it reviewed (set at
# submit time; unlike an inline comment's commit_id it isn't re-anchored). Use
# it to classify the review — a findings review whose body omits the "Reviewed
# commit" line would otherwise never match HEAD and the findings would be hidden.
head_review = None  # (submitted_at, findings_count, has_findings)
for r in codex_reviews:  # ascending; the last HEAD review wins
    oid = r.get("commit_id") or reviewed_oid(r.get("body"))
    if oid and (HEAD == oid or HEAD.startswith(oid)):
        tied = [c for c in inline if is_codex(c.get("user")) and c.get("pull_request_review_id") == r["id"]]
        has_findings = r.get("state") == "CHANGES_REQUESTED" or bool(tied)
        head_review = (r.get("submitted_at") or "", len(tied), has_findings)

# 1) Decide between the HEAD clean-comment and the HEAD review by recency.
if head_review and (not head_clean_time or head_review[0] >= head_clean_time):
    if head_review[2]:
        print("FINDINGS", HEAD[:10], head_review[1]); sys.exit(0)
    print("CLEAN", HEAD[:10]); sys.exit(0)
if head_clean_time:
    print("CLEAN", HEAD[:10]); sys.exit(0)

# 2) Rate limit — only if it's Codex's FRESHEST signal. A historical limit hit
#    later followed by a successful review/clean comment must NOT block the gate
#    forever, so require it to be newer than any review or clean verdict.
review_time = codex_reviews[-1].get("submitted_at") if codex_reviews else ""
clean_time = newest([c["created_at"] for c in clean_comments])
rl_time = newest([c["created_at"] for c in ratelimit_comments])
if rl_time and rl_time >= review_time and rl_time >= clean_time:
    print("RATELIMIT"); sys.exit(0)

# 4) A Codex 👍 on the most recent review REQUEST means clean (Codex's documented
#    "no suggestions" behaviour). The request comment must merely CONTAIN
#    "@codex review" (the skill's request also leads with "Addressed in <sha>…"),
#    and the reaction must be from Codex itself — a maintainer's 👍 doesn't count.
requests = sorted(
    [c for c in issues if "@codex review" in c["body"].lower()],
    key=lambda c: c["created_at"],
)
if requests:
    rc = gh(f"/repos/{REPO}/issues/comments/{requests[-1]['id']}/reactions")
    if any(is_codex(x.get("user")) and x.get("content") in ("+1", "hooray", "rocket", "heart") for x in rc):
        print("CLEAN reaction"); sys.exit(0)

# 5) Codex has weighed in, but its latest verdict is for an OLDER commit — a
#    review for a non-HEAD SHA OR a clean comment for one (which may exist with
#    NO review objects at all). Report STALE (push a new commit) rather than
#    NONE (poll forever).
stale = []
if codex_reviews:
    r = codex_reviews[-1]
    stale.append((r.get("submitted_at") or "", r.get("commit_id") or reviewed_oid(r.get("body")) or "?"))
if clean_comments:
    c = max(clean_comments, key=lambda c: c["created_at"])
    stale.append((c["created_at"], reviewed_oid(c["body"]) or first_sha(c["body"]) or "?"))
if stale:
    stale.sort()
    print("STALE", stale[-1][1]); sys.exit(0)

print("NONE")
