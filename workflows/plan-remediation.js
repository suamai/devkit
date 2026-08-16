export const meta = {
  name: 'plan-remediation',
  description: 'Turn a persisted, verified PR review into a cohesive remediation plan without repeating full repository exploration',
  whenToUse: 'Called by /dev-plan --review for nontrivial or cross-cutting confirmed findings',
  phases: [
    { title: 'Validate', detail: 'optionally re-check current reachability and remediation dependencies in one batch', model: 'sonnet' },
    { title: 'Synthesize', detail: 'group root causes into executable remediation steps and write plan.md', model: 'sonnet' },
  ],
}

// args: { reviewPath, workspace, planPath?, validate?=true, deep?=false, dryRun? }
if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { throw new Error('args arrived as a non-JSON string') } }
if (args && args.dryRun) return { ok: true, workflow: 'plan-remediation' }
if (!args || !args.reviewPath) throw new Error('args.reviewPath is required: persisted PR review markdown')
if (!args.workspace) throw new Error('args.workspace is required: absolute remediation workspace path')

const workspace = args.workspace.replace(/\/+$/, '')
const planPath = args.planPath || `${workspace}/plan.md`

const VALIDATION_SCHEMA = {
  type: 'object', required: ['assessments', 'grouping_notes'],
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'verdict', 'evidence', 'remediation_group'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'stale'] },
          evidence: { type: 'string', description: 'current file:line evidence and reachable failure path' },
          remediation_group: { type: 'string', description: 'stable root-cause group shared by findings that should be fixed together' },
          dependencies: { type: 'array', items: { type: 'string' }, description: 'other finding ids or integration prerequisites' },
          verification: { type: 'string', description: 'cheapest executable check that proves the defect is fixed' },
        },
      },
    },
    grouping_notes: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
}

const PLAN_SCHEMA = {
  type: 'object', required: ['title', 'approach_summary', 'steps', 'open_questions', 'plan_path'],
  properties: {
    title: { type: 'string' },
    approach_summary: { type: 'string' },
    steps: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['id', 'title', 'goal', 'files', 'depends_on', 'details', 'verify', 'source_findings'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          depends_on: { type: 'array', items: { type: 'string' } , description: 'HARD dependencies only: step ids whose code must already exist for this step to compile, run or be verified — not reading order. Every link deepens the sequential wave chain the implementer runs.' },
          details: { type: 'string' }, verify: { type: 'string' },
          risk: { type: 'string', enum: ['contract', 'local'], description: '"contract" when the fix changes a surface other steps or existing callers consume; "local" when contained in its own files' },
          source_findings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    dropped_findings: { type: 'array', items: { type: 'string' } },
    plan_path: { type: 'string' },
  },
}

phase('Validate')
const validation = args.validate === false ? null : await agent(
  `You are the single batched validator for a PR remediation plan.

Read the persisted review at "${args.reviewPath}". Use only its machine-readable CONFIRMED findings as candidates. Re-read current code and relevant callers/tests. Confirm whether each defect is still reachable, identify findings with the same root cause, dependencies between fixes, and the cheapest executable verification. ${args.deep ? 'Inspect integration boundaries deeply because the developer requested deep remediation planning.' : 'Stay proportional: do not rediscover the whole feature or report unrelated defects.'}

Do not modify files. Return native structured data only; no XML or wrapper object.`,
  { label: 'validate:remediation', phase: 'Validate', model: 'sonnet', schema: VALIDATION_SCHEMA },
)
if (args.validate !== false && !validation) throw new Error('remediation validation failed')
if (validation && !validation.assessments.some((a) => a.verdict === 'confirmed')) {
  return {
    reviewPath: args.reviewPath,
    no_action: true,
    reason: 'batched revalidation found no still-current confirmed findings',
    dropped_findings: validation.assessments.map((a) => `${a.id}:${a.verdict}`),
    open_questions: validation.open_questions || [],
  }
}

phase('Synthesize')
const plan = await agent(
  `You are planning fixes for an already-reviewed pull request.

Review evidence: "${args.reviewPath}" (read it, including the machine-readable block).
Remediation workspace: "${workspace}"
Output plan: "${planPath}"
${validation ? `Independent batched validation:\n${JSON.stringify(validation, null, 2)}` : 'The control-plane triage judged independent revalidation unnecessary; still inspect affected code before planning.'}

Use only confirmed, still-current findings. Group findings with one root cause or tightly coupled files into ONE coherent step; never create one agent per finding mechanically. Declare file ownership conservatively, order overlapping/integration work with depends_on — hard dependencies only, since the implementer turns them into sequential waves — mark each step's risk (contract|local), and give every step an executable verification. Keep steps focused enough for one implementation session. Do not expand into unrelated cleanup.

WRITE markdown to "${planPath}" with: title, source review and reviewed HEAD, approach, steps, risks/open questions, dropped/refuted-or-stale findings, and a final section named Machine-readable steps containing a fenced JSON array exactly matching the returned steps. The source review remains immutable evidence; this file records the chosen correction strategy.

Return one native JSON object with these top-level properties: title, approach_summary, steps, risks, open_questions, dropped_findings, and plan_path. Pass them as actual tool-input properties. Do not put the object inside a summary string; do not use XML/tags or nest it under input/result. Keep prose detail in the plan file.`,
  { label: 'synthesize:remediation', phase: 'Synthesize', model: 'sonnet', schema: PLAN_SCHEMA },
)
if (!plan) throw new Error('remediation plan synthesis failed')

return plan
