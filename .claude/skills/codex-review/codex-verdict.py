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

def is_codex(login):
    return bool(login) and "codex" in login.lower()

def reviewed_oid(body):
    m = re.search(r"Reviewed commit:\**\s*`?([0-9a-f]{7,40})`?", body or "")
    return m.group(1) if m else None

reviews = gh(f"/repos/{REPO}/pulls/{PR}/reviews")
inline = gh(f"/repos/{REPO}/pulls/{PR}/comments")
issues = gh(f"/repos/{REPO}/issues/{PR}/comments")

codex_issue = [c for c in issues if is_codex(c["user"]["login"])]
codex_reviews = sorted(
    [r for r in reviews if r.get("user") and is_codex(r["user"]["login"])],
    key=lambda r: r.get("submitted_at") or "",
)
ratelimit_comments = [c for c in codex_issue if re.search(r"reached your Codex usage limits|usage limit", c["body"], re.I)]
clean_comments = [c for c in codex_issue if re.search(r"didn'?t find any (major )?issues|no major issues", c["body"], re.I)]

def newest(ts_list):
    ts = [t for t in ts_list if t]
    return max(ts) if ts else ""

review_time = codex_reviews[-1].get("submitted_at") if codex_reviews else ""
clean_time = newest([c["created_at"] for c in clean_comments])
rl_time = newest([c["created_at"] for c in ratelimit_comments])

# 1) Clean issue comment for the current HEAD (the authoritative clean signal).
for c in sorted(clean_comments, key=lambda c: c["created_at"], reverse=True):
    oid = reviewed_oid(c["body"]) or (re.search(r"([0-9a-f]{7,40})", c["body"]) or [None, None])[0]
    if oid and HEAD.startswith(oid):
        print("CLEAN", oid); sys.exit(0)
    break  # only the newest clean comment matters

# 2) Latest Codex review object — trust it only if it reviewed the current HEAD.
if codex_reviews:
    latest = codex_reviews[-1]
    oid = reviewed_oid(latest.get("body"))
    if oid and HEAD.startswith(oid):
        rid = latest["id"]
        tied = [c for c in inline if is_codex(c["user"]["login"]) and c.get("pull_request_review_id") == rid]
        if latest.get("state") == "CHANGES_REQUESTED" or tied:
            print("FINDINGS", oid, len(tied)); sys.exit(0)
        print("CLEAN", oid); sys.exit(0)

# 3) Rate limit — only if it's Codex's FRESHEST signal. A historical limit hit
#    that was followed by a successful review/clean comment must NOT block the
#    gate forever, so require the rate-limit comment to be newer than any review
#    or clean verdict.
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
    if any(is_codex((x.get("user") or {}).get("login")) and x.get("content") in ("+1", "hooray", "rocket", "heart") for x in rc):
        print("CLEAN reaction"); sys.exit(0)

# 5) A review exists but it reviewed an older commit (and no fresher verdict).
if codex_reviews:
    print("STALE", reviewed_oid(codex_reviews[-1].get("body")) or "?"); sys.exit(0)

print("NONE")
