export const meta = {
  name: 'docs-audit',
  description: 'Cross-check every doc against the current codebase, adversarially verify each finding, synthesize a prioritized report',
  phases: [
    { title: 'Audit', detail: 'parallel auditors per doc domain, each checking docs vs code' },
    { title: 'Verify', detail: 'adversarially confirm each finding against the code' },
    { title: 'Synthesize', detail: 'group confirmed findings by file, rank' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
          file: { type: 'string' },
          location: { type: 'string', description: 'section heading or line range' },
          claim: { type: 'string', description: 'what the doc currently says' },
          reality: { type: 'string', description: 'what the code/repo shows, with file:line evidence' },
          fix: { type: 'string', description: 'the concrete correction' },
        },
        required: ['severity', 'file', 'location', 'claim', 'reality', 'fix'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean', description: 'true if the doc genuinely contradicts/misstates/omits vs the CURRENT code' },
    severityAdjusted: { type: 'string', enum: ['P1', 'P2', 'P3', 'DROP'] },
    evidence: { type: 'string', description: 'the file:line you checked and what it actually shows' },
  },
  required: ['real', 'severityAdjusted', 'evidence'],
}

const COMMON = `You are auditing documentation for ACCURACY against the CURRENT codebase. Read your assigned doc(s) fully, then verify every concrete claim against the code (grep, read source, check file paths exist, check npm scripts in package.json exist, check API routes under src/app/api/** exist, check version numbers). A finding is where the doc MISSTATES, CONTRADICTS, or is STALE vs the code — OR a materially important feature that exists in code but is undocumented where the doc clearly should cover it.

To find coverage gaps: compare CLAUDE.md's most-recent version-feature section against what actually shipped (read the git log + recently-merged PRs + package.json version) and the recent code.

Severity: P1 = wrong/misleading in a way that causes a reader to make a mistake (wrong command/path/API contract, security-relevant). P2 = stale/drifted (old behavior, missing a shipped feature, an exact count stated as fact that's wrong). P3 = minor (typo, dead link, cosmetic). Do NOT report correct things, subjective style, or "count drifts" lines the doc itself already hedges as approximate.

Do NOT edit any files — read-only audit. Every finding needs file:line evidence on the REALITY side. If your domain is clean, return an empty findings array with a note on what you verified.`

const AUDITORS = [
  { key: 'claude-howto', prompt: `${COMMON}\n\nDOMAIN: CLAUDE.md — Commands, Architecture, Project Layout, Key Conventions, i18n, Testing, CI/CD, Release Process (and gotchas). Verify every npm script exists in package.json; every file/dir path exists; the path alias / standalone / electron-store / IPC / build-config claims match code; the release-process steps + named workflows match .github/workflows. Flag any path/script/config that was renamed or removed.` },
  { key: 'claude-features', prompt: `${COMMON}\n\nDOMAIN: CLAUDE.md — the integration & topic sections + per-version feature sections. Spot-check the most load-bearing claims against code (API route names, lib module names + exported functions, schema fields, guard coverage, transport details). Flag descriptions that contradict the current code (a renamed/removed function/route/field, or changed behavior).` },
  { key: 'claude-coverage', prompt: `${COMMON}\n\nDOMAIN: coverage gaps in CLAUDE.md. Determine what shipped since CLAUDE.md's last version-feature section (git log, recently-merged PRs, package.json version, the new code) and report each materially-undocumented feature as a P2 finding (file: CLAUDE.md) with a concrete "add a section describing X" fix. Also check the trailing Notes and any "Mobile"/companion sections for staleness.` },
  { key: 'docs-user', prompt: `${COMMON}\n\nDOMAIN: the user-facing docs under docs/ (api.md, usage.md, tutorial.md, setup.md, desktop.md, importing.md, nfc.md, troubleshooting.md, testing.md, and any workflow guides). Verify feature descriptions, commands, ports, and API examples against the code. Check internal links + referenced screenshots resolve. Flag stale version numbers stated as current, removed/renamed features, and recently-changed behavior the docs still describe the old way. Prioritize the largest files.` },
  { key: 'openapi', prompt: `${COMMON}\n\nDOMAIN: public/openapi.json vs the actual API. Enumerate real routes (files under src/app/api/** + their exported HTTP methods) and compare to the documented paths. Report: documented endpoints that no longer exist, real endpoints that are undocumented, wrong methods, the wrong info.version, and any request/response shape that contradicts the route's validation. Cross-check docs/api.md against openapi.json for divergence.` },
  { key: 'agents-readme-i18n', prompt: `${COMMON}\n\nDOMAIN: AGENTS.md (all of them), README.md (root + any package READMEs), and any translated docs (e.g. docs/de/*). Verify accuracy vs code. For translated docs do NOT translate — only flag where a translation has clearly DRIFTED from its source-language counterpart (covers a removed feature, wrong command, or is missing a section the source has). Check any SDK/dependency-version claims vs the relevant package.json.` },
]

phase('Audit')
const perDomain = await pipeline(
  AUDITORS,
  (a) => agent(a.prompt, { label: `audit:${a.key}`, phase: 'Audit', schema: FINDINGS_SCHEMA }),
  (res, a) => {
    const findings = (res && res.findings) || []
    if (!findings.length) return { domain: a.key, confirmed: [], dropped: 0, note: (res && res.notes) || 'no findings' }
    return parallel(
      findings.map((f) => () =>
        agent(
          `Adversarially verify this documentation-audit finding. Read the cited doc location AND the code evidence yourself; only confirm it if the doc genuinely misstates/contradicts/omits vs the CURRENT code. Default real:false if the doc is actually correct or merely hedged.\n\nFINDING:\n- file: ${f.file}\n- location: ${f.location}\n- doc claims: ${f.claim}\n- alleged reality: ${f.reality}\n- proposed fix: ${f.fix}`,
          { label: `verify:${a.key}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((v) => ({ ...f, verdict: v })),
      ),
    ).then((verified) => ({
      domain: a.key,
      confirmed: verified.filter(Boolean).filter((f) => f.verdict && f.verdict.real && f.verdict.severityAdjusted !== 'DROP'),
      dropped: verified.filter(Boolean).filter((f) => !(f.verdict && f.verdict.real && f.verdict.severityAdjusted !== 'DROP')).length,
      note: (res && res.notes) || '',
    }))
  },
)

phase('Synthesize')
const all = perDomain.filter(Boolean)
const confirmed = all.flatMap((d) =>
  (d.confirmed || []).map((f) => ({
    severity: f.verdict.severityAdjusted || f.severity,
    file: f.file, location: f.location, claim: f.claim, reality: f.reality, fix: f.fix, domain: d.domain,
  })),
)
const byFile = {}
for (const f of confirmed) (byFile[f.file] = byFile[f.file] || []).push(f)
const order = { P1: 0, P2: 1, P3: 2 }
for (const k of Object.keys(byFile)) byFile[k].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
return {
  totalConfirmed: confirmed.length,
  totalDropped: all.reduce((s, d) => s + (d.dropped || 0), 0),
  bySeverity: { P1: confirmed.filter((f) => f.severity === 'P1').length, P2: confirmed.filter((f) => f.severity === 'P2').length, P3: confirmed.filter((f) => f.severity === 'P3').length },
  byFile,
  domainNotes: all.map((d) => ({ domain: d.domain, note: d.note })),
}
