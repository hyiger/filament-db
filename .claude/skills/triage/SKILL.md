---
name: triage
description: Root-cause one or more GitHub issues in parallel against the codebase and produce a ranked fix plan per issue (root cause with file:line evidence, concrete fix, test plan, risk, confidence, open questions). Use when handed several new issues / bug reports to "look into" or "address" — it stops at investigation, before the bespoke fixing.
---

# Issue triage (parallel root-cause)

Turns a pile of issues into actionable, code-grounded fix plans by investigating them in parallel. It deliberately stops at the **plan** — the actual fixes are bespoke per issue and you implement them after reviewing the plans (each as its own PR through the `codex-review` gate).

## Run it

1. **Find the issues.** `gh issue list --state open` (or use the numbers the user gave). Identify which are genuinely new / in scope.
2. **Fetch each issue's text** and build the args array:
   ```
   gh issue view <n> --json number,title,body
   ```
   Assemble `[{ number, title, body }, ...]`.
3. **Run the investigation workflow** (multi-agent — requires the user's workflow opt-in), passing the issues as `args`:
   ```
   Workflow({ scriptPath: ".claude/skills/triage/triage-workflow.js", args: [{number, title, body}, ...] })
   ```
   One investigator per issue runs concurrently and returns a structured plan: `rootCause` (+ file:line `evidence`), `fixPlan`, `affectedFiles`, `testPlan`, `risk`, `confidence`, `openQuestions`.

## After the plans come back
- Present each plan: root cause, fix, confidence, and any **open question** that's a product/UX call — surface those to the user before implementing (e.g. with AskUserQuestion).
- Implement each fix on its own branch → PR → `codex-review` gate → merge. Reference the issue with `Fixes #<n>` in the PR body so it auto-closes.
- For a finding that can't be fully verified without specific hardware (e.g. a Windows-only timing bug), implement the platform-independent fix, ship it, and flag the on-hardware confirmation as owed.

## When NOT to use
- A single, obvious issue you can root-cause in a couple of reads — just do it.
- "Investigations" that need design discussion more than code spelunking.
