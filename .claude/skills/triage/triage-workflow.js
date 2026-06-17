export const meta = {
  name: 'triage',
  description: 'Root-cause a set of issues in parallel against the code, returning a ranked fix plan per issue',
  phases: [{ title: 'Investigate', detail: 'one deep investigator per issue' }],
}

// args: an array of { number, title, body } — fetch with `gh issue view` before
// invoking and pass via Workflow's `args`.
const ISSUES = Array.isArray(args) ? args : []

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    issue: { type: 'string' },
    rootCause: { type: 'string', description: 'the concrete root cause, with file:line evidence' },
    evidence: { type: 'array', items: { type: 'string' } },
    fixPlan: { type: 'string', description: 'the concrete code change(s) to make' },
    affectedFiles: { type: 'array', items: { type: 'string' } },
    testPlan: { type: 'string' },
    risk: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    openQuestions: { type: 'string', description: 'anything needing a human/design decision' },
  },
  required: ['issue', 'rootCause', 'evidence', 'fixPlan', 'affectedFiles', 'testPlan', 'confidence'],
}

const COMMON = `Read the actual code to root-cause the issue; cite file:line. Do NOT edit files — investigate + plan only. Be concrete and skeptical; verify the hypothesis against the code rather than guessing. If something can't be confirmed without specific hardware/an environment you lack, say so and give the most likely cause + the diagnostic that would confirm it. Flag any fix decision that needs the user's call (a UX/product choice, a risky behavior change).`

if (!ISSUES.length) {
  log('No issues passed in args — pass [{number,title,body}] via Workflow args.')
  return { plans: [] }
}

phase('Investigate')
const plans = await parallel(
  ISSUES.map((iss) => () =>
    agent(
      `${COMMON}\n\nISSUE #${iss.number} — ${iss.title}\n\n${iss.body || '(no body)'}\n\nTrace the relevant code path end-to-end and produce the root cause + a concrete fix plan.`,
      { label: `investigate:#${iss.number}`, phase: 'Investigate', schema: PLAN_SCHEMA },
    ),
  ),
)
return { plans: plans.filter(Boolean) }
