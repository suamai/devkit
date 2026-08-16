export const meta = {
  name: 'wf-plan-remediation',
  description: 'Turn a persisted, verified PR review into a cohesive remediation plan without repeating full repository exploration',
  whenToUse: 'Called by /dev-plan --review for nontrivial or cross-cutting confirmed findings',
  phases: [
    { title: 'Validate', detail: 'optionally re-check current reachability and remediation dependencies in one batch' },
    { title: 'Synthesize', detail: 'group root causes into executable remediation steps and write plan.md' },
  ],
}

// args: { reviewPath, workspace, planPath?, validate?=true, deep?=false,
//         profile?, models?, efforts?, dryRun? }
if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { throw new Error('args arrived as a non-JSON string') } }

// ---- Model/effort policy (roles, not phases — a policy passes intact into nested workflows).
// Defaults are the tiers this workflow shipped with; `profile` shifts every role one rung on the
// model ladder, explicit `models`/`efforts` win over it, and an unknown role throws rather than
// being silently ignored. Effort defaults to inheriting the session's. See docs/architecture.md.
const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const ROLE_NAMES = ['decompose', 'scout', 'validate', 'synth', 'impl', 'gate', 'check', 'review', 'verify', 'fix']
const PROFILE_SHIFT = { cheap: -1, default: 0, max: 1 }
function policy(defaults) {
  const a = args || {}
  const shift = a.profile == null ? 0 : PROFILE_SHIFT[a.profile]
  if (shift === undefined) throw new Error(`unknown profile "${a.profile}" — use ${Object.keys(PROFILE_SHIFT).join(' | ')}`)
  const models = a.models || {}
  const efforts = a.efforts || {}
  for (const k of [...Object.keys(models), ...Object.keys(efforts)]) {
    if (!ROLE_NAMES.includes(k)) throw new Error(`unknown role "${k}" — pipeline roles are ${ROLE_NAMES.join(', ')}`)
  }
  const pick = (ladder, base, override, what) => {
    if (override != null) {
      if (!ladder.includes(override)) throw new Error(`unknown ${what} "${override}" — use ${ladder.join(' | ')}`)
      return override
    }
    if (base == null) return null
    return ladder[Math.min(ladder.length - 1, Math.max(0, ladder.indexOf(base) + shift))]
  }
  const out = {}
  for (const name of Object.keys(defaults)) {
    const model = pick(MODELS, defaults[name].model, models[name], 'model')
    const effort = pick(EFFORTS, defaults[name].effort || null, efforts[name], 'effort')
    out[name] = effort ? { model, effort } : { model } // never hand agent() an effort of null
  }
  if (a.profile != null || Object.keys(models).length || Object.keys(efforts).length) {
    log(`policy: ${Object.keys(out).map((r) => `${r}=${out[r].model}${out[r].effort ? '/' + out[r].effort : ''}`).join(' ')}`)
  }
  return out
}
const ROLE = policy({
  validate: { model: 'sonnet' },
  synth: { model: 'sonnet' },
})

// >>> shared: per-phase cost — byte-identical across workflows (tests/policy.test.js)
// budget.spent() is the TURN's cumulative output tokens, shared with the main loop and with every
// other workflow, so only deltas mean anything and only around intervals that do not overlap.
// Phases are sequential even when the agents inside one are not — which is exactly why the split
// stops at phase granularity: agents running concurrently interleave, and no delta can separate
// them. A second workflow running at the same time inflates these numbers and nothing here can
// detect that, so this reports what it measured, not what it is certain the phase cost.
const cost = {}
async function metered(phase, fn) {
  const before = budget.spent()
  try { return await fn() } finally { cost[phase] = (cost[phase] || 0) + Math.max(0, budget.spent() - before) }
}
function costReport() {
  const phases = Object.keys(cost).filter((k) => cost[k] > 0)
  const total = phases.reduce((sum, k) => sum + cost[k], 0)
  if (total) log(`cost: ${phases.map((k) => `${k}=${Math.round(cost[k] / 1000)}k`).join(' ')} — ${Math.round(total / 1000)}k output tokens`)
  // budget.total is null unless the developer put a "+300k"-style target in their own message, and
  // every budget floor in this file is gated on it. Reporting that is the difference between a run
  // that was protected and one that only looked protected.
  return { by_phase: { ...cost }, total, budget_total: budget.total, floors_active: budget.total != null }
}
// <<< shared: per-phase cost

if (args && args.dryRun) return { ok: true, workflow: 'wf-plan-remediation', policy: ROLE }
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
const validation = args.validate === false ? null : await metered('validate', () => agent(
  `You are the single batched validator for a PR remediation plan.

Read the persisted review at "${args.reviewPath}". Use only its machine-readable CONFIRMED findings as candidates. Re-read current code and relevant callers/tests. Confirm whether each defect is still reachable, identify findings with the same root cause, dependencies between fixes, and the cheapest executable verification. ${args.deep ? 'Inspect integration boundaries deeply because the developer requested deep remediation planning.' : 'Stay proportional: do not rediscover the whole feature or report unrelated defects.'}

Do not modify files. Return native structured data only; no XML or wrapper object.`,
  { label: 'validate:remediation', phase: 'Validate', ...ROLE.validate, schema: VALIDATION_SCHEMA },
))
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
const plan = await metered('synthesize', () => agent(
  `You are planning fixes for an already-reviewed pull request.

Review evidence: "${args.reviewPath}" (read it, including the machine-readable block).
Remediation workspace: "${workspace}"
Output plan: "${planPath}"
${validation ? `Independent batched validation:\n${JSON.stringify(validation, null, 2)}` : 'The control-plane triage judged independent revalidation unnecessary; still inspect affected code before planning.'}

Use only confirmed, still-current findings. Group findings with one root cause or tightly coupled files into ONE coherent step; never create one agent per finding mechanically. Declare file ownership conservatively, order overlapping/integration work with depends_on — hard dependencies only, since the implementer turns them into sequential waves — mark each step's risk (contract|local), and give every step an executable verification. Keep steps focused enough for one implementation session. Do not expand into unrelated cleanup.

WRITE markdown to "${planPath}" with: title, source review and reviewed HEAD, approach, steps, risks/open questions, dropped/refuted-or-stale findings, and a final section named Machine-readable steps containing a fenced JSON array exactly matching the returned steps. The source review remains immutable evidence; this file records the chosen correction strategy.

Return one native JSON object with these top-level properties: title, approach_summary, steps, risks, open_questions, dropped_findings, and plan_path. Pass them as actual tool-input properties. Do not put the object inside a summary string; do not use XML/tags or nest it under input/result. Keep prose detail in the plan file.`,
  { label: 'synthesize:remediation', phase: 'Synthesize', ...ROLE.synth, schema: PLAN_SCHEMA },
))
if (!plan) throw new Error('remediation plan synthesis failed')

return { ...plan, cost: costReport() }
