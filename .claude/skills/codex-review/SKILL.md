---
name: codex-review
description: Drive a PR through the Codex review merge-gate to a CLEAN verdict on the current HEAD. Use after pushing to an open PR, when asked to "get Codex clean", merge a PR, or whenever the Codex review loop needs running. Encodes the commit-aware verdict detection (clean-is-an-issue-comment, stale-commit re-reviews, the new-push-to-dislodge trick, 👍-reaction-means-clean) that is easy to get wrong.
---

# Codex review merge-gate

A **clean Codex review of the current HEAD is a HARD gate for merging** any PR in this repo — never merge without it, even on green CI / resolved threads / a direct "merge it". This skill runs the request → detect → address → re-request loop until the gate is satisfied.

## The loop

1. **Identify the PR + HEAD.** `gh pr view <PR> --json headRefOid,headRefName -q '.headRefOid + " " + .headRefName'`. Capture the full HEAD SHA — every verdict is judged against it.
2. **Request a review** (do this after EVERY push to the PR, not just the first):
   ```
   gh pr comment <PR> --body "Addressed in <short-sha> — <one-line summary>.

   @codex review"
   ```
   On the first open, Codex auto-fires, so the explicit request is redundant-but-harmless.
3. **Poll the verdict** with the bundled detector (commit-aware — see Gotchas):
   ```
   python3 .claude/skills/codex-review/codex-verdict.py <PR> <HEAD_full_sha>
   ```
   Run it on a cadence (background loop, ~45s between polls; Codex usually answers in a few minutes). Terminal states: `CLEAN`, `FINDINGS`, `RATELIMIT`. Keep polling on `STALE` / `NONE`.
4. **Act on the verdict:**
   - `CLEAN <oid>` (oid == HEAD) → gate satisfied. Confirm CI is green (`gh pr checks <PR>`), then the PR is mergeable. **Do not merge unless the user has greenlit the merge** — getting clean ≠ permission to merge.
   - `FINDINGS <oid> <n>` → read the inline comments, fix each, reply to the threads explaining the fix, push, and **go back to step 2**. Read them with:
     ```
     RID=$(gh api repos/<owner/repo>/pulls/<PR>/reviews --jq '[.[] | select(.user.login|test("codex";"i"))] | sort_by(.submitted_at) | last | .id')
     gh api repos/<owner/repo>/pulls/<PR>/comments --jq ".[] | select(.pull_request_review_id == $RID) | {path, line, body}"
     ```
     Reply to a thread: `gh api repos/<owner/repo>/pulls/<PR>/comments/<comment_id>/replies -f body="Fixed in <sha>. <how>"`
     (Use the relative `repos/…` endpoint form — `gh api /repos/…` fails on Windows.)
   - `RATELIMIT` → do NOT merge and do NOT substitute green-CI for the gate. Wait for the limit to reset, then re-request and resume polling.
   - `STALE <oid>` → Codex reviewed an OLDER commit. **Re-posting `@codex review` will NOT dislodge it** — push a new commit (even a trivial/rebase one) to force a review of the real HEAD, then resume.

Repeat until `CLEAN` on HEAD with zero unresolved Codex threads.

## Gotchas the detector handles (and why it exists)

- **A clean review is an ISSUE COMMENT**, not a PR review object: `Codex Review: Didn't find any major issues. Reviewed commit: \`<oid>\``. Polling only `/pulls/{n}/reviews` misses it (this cost ~4h once).
- **FINDINGS are a review object + inline comments** tied via `pull_request_review_id`. Don't key off `comment.commit_id` — GitHub re-anchors a stale finding's comment to the new HEAD, so it can read as the current HEAD even though the finding is stale.
- **Stale-commit re-reviews**: Codex's `Reviewed commit:` may be the previous SHA after a re-request. Always require `reviewed-commit == HEAD`. A NEW push is the reliable re-trigger.
- **👍 reaction**: a clean re-review sometimes shows up only as a thumbs-up on the `@codex review` request comment.
- **Bot login**: `chatgpt-codex-connector` (GraphQL) vs `chatgpt-codex-connector[bot]` (REST) — match the substring `codex`.

## Notes
- The detector auto-detects `owner/repo` via `gh repo view`; pass it explicitly as a 3rd arg if needed.
- Branch protection blocks the merge button on a non-approving review; the maintainer merges with `gh pr merge <PR> --squash --delete-branch --admin` once the gate + CI are satisfied **and** the user has approved merging.
