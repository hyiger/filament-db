---
name: docs-audit
description: Run a full documentation-vs-code audit — parallel auditors per doc domain, each finding adversarially verified against the code before it lands, synthesized into a prioritized file-grouped report. Use when asked to "audit the docs", "check docs for drift", before cutting a release, or after a big feature epic. Optionally fix the findings as a PR.
---

# Documentation audit

Cross-checks all docs (CLAUDE.md, AGENTS.md, README, `docs/**`, `public/openapi.json`, translations) against the current code, and reports where they've drifted. The key design choices that make it trustworthy: **fan out by domain** (so each doc area gets focused attention) and **adversarially verify every finding** against the code before reporting (so the report is confirmed drift, not auditor noise).

## Run it

This requires multi-agent orchestration, so it only runs when the user has opted into a workflow (see the Workflow tool's rules). Run the bundled script from the repo root:

```
Workflow({ scriptPath: ".claude/skills/docs-audit/audit-workflow.js" })
```

It runs three phases — **Audit** (6 parallel domain auditors → structured findings), **Verify** (one adversarial verifier per finding, dropping false positives), **Synthesize** (confirmed findings grouped by file, ranked P1→P3) — and returns:
`{ totalConfirmed, totalDropped, bySeverity, byFile, domainNotes }`.

Present the report grouped by file, severity-ranked, each with the doc's claim, the code reality (file:line), and the fix.

## Acting on the report
- **Audit only:** stop at the report (the literal meaning of "audit").
- **Fix as a PR (the #727/#748 pattern):** branch off main, apply the fixes (each mirrors a verified finding), open ONE `docs:` PR, and take it through Codex review before merging — push, comment `@codex review`, and iterate until Codex's review of the current HEAD is clean (the user-level `codex-review` skill automates that loop if you have it installed). Group commits by file/theme.

## Sequencing caveat
Don't document a feature whose files only exist on an unmerged PR — that's itself drift. If a finding references something landing in another open PR, fix it **in that PR** (its natural home) or defer until that PR merges to main.

## Tuning
- The auditor domains live in `audit-workflow.js`; add/adjust a domain there if the doc set changes.
- Scale: the verify phase spawns one agent per finding. That's intended (precision over cost). If a run is huge, the auditors can be told to report only material (P1/P2) findings.
