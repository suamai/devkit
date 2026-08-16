export const meta = {
  name: 'wf-explore-plan',
  description: 'Fan-out repo exploration by angle, one batched validation of load-bearing claims, cross-checked plan synthesis into a task workspace',
  whenToUse: 'Start of a medium/large dev task: turn a task brief or spec into a validated, step-structured plan file',
  phases: [
    { title: 'Decompose', detail: 'derive exploration angles from the task' },
    { title: 'Explore', detail: 'one scout per angle; full reports land in the workspace' },
    { title: 'Validate', detail: 'one adversarial pass over load-bearing claims from all reports' },
    { title: 'Synthesize', detail: 'cross-check findings, write the plan file' },
  ],
}

// args: { task, workspace, specPath?, scope?, requirements?, constraints?, angles?, validate?=true,
//         planPath?, profile?, models?, efforts?, dryRun? }
//   workspace: absolute path to the task workspace (e.g. <repo>/.dev/<slug>).
//   Context discipline (RLM-style): scouts WRITE full reports to <workspace>/findings/ and RETURN
//   compact summaries; downstream agents receive paths and read detail only when load-bearing.
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
  decompose: { model: 'sonnet', effort: 'low' }, // task text in, angle names out — reads no code
  scout: { model: 'sonnet' },
  validate: { model: 'sonnet' },
  synth: { model: 'opus' },
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

if (args && args.dryRun) return { ok: true, workflow: 'wf-explore-plan', policy: ROLE }
if (!args || !args.task) throw new Error('args.task is required: what is being built or changed')
if (!args.workspace) throw new Error('args.workspace is required: absolute path to the task workspace (e.g. <repo>/.dev/<slug>)')

const workspace = args.workspace.replace(/\/+$/, '')
const planPath = args.planPath || `${workspace}/plan.md`
const findingsDir = `${workspace}/findings`

const TASK_BRIEF = [
  '## Task', args.task,
  '## Scope', args.scope || 'Not specified — infer a reasonable scope from the repository.',
  '## Requirements', args.requirements || 'Not specified.',
  '## Constraints', args.constraints || 'None stated.',
  args.specPath ? `## Specification\nThe full spec lives at "${args.specPath}" — read it before starting. Its acceptance criteria are binding.` : '',
].filter(Boolean).join('\n')

const ANGLES_SCHEMA = {
  type: 'object', required: ['angles'],
  properties: {
    angles: {
      type: 'array', minItems: 3, maxItems: 5,
      items: {
        type: 'object', required: ['name', 'focus', 'why'],
        properties: {
          name: { type: 'string', description: 'short kebab-case label (used as a filename)' },
          focus: { type: 'string', description: 'what exactly this scout must investigate' },
          why: { type: 'string', description: 'why this angle matters for THIS task' },
          hints: { type: 'string', description: 'where/how to look: dirs, naming conventions, entry points' },
        },
      },
    },
  },
}

const SCOUT_SCHEMA = {
  type: 'object', required: ['summary', 'headline_findings', 'open_questions', 'report_path'],
  properties: {
    summary: { type: 'string', description: '3-6 sentence digest of what this angle revealed' },
    headline_findings: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object', required: ['claim', 'evidence', 'relevance'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'file:line pointers plus a short quote of the code' },
          relevance: { type: 'string', description: 'how this affects the task' },
        },
      },
      description: 'only the findings that change what the plan should be — full detail goes in the report file',
    },
    risks: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'ambiguities only the developer can resolve' },
    report_path: { type: 'string', description: 'path of the full report file you wrote' },
  },
}

const VALIDATION_SCHEMA = {
  type: 'object', required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', required: ['angle', 'claim', 'verdict'],
        properties: {
          angle: { type: 'string' },
          claim: { type: 'string', description: 'the scout claim being judged, quoted or paraphrased' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'] },
          correction: { type: 'string', description: 'corrected version of the claim, if imprecise' },
          evidence: { type: 'string', description: 'file:line proof for the verdict' },
        },
      },
    },
    missed_findings: {
      type: 'array', maxItems: 3,
      items: { type: 'object', required: ['angle', 'claim', 'evidence'], properties: { angle: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' } } },
      description: 'at most three critical misses across the whole exploration',
    },
    suggested_adjustments: { type: 'array', items: { type: 'string' } },
  },
}

const PLAN_SCHEMA = {
  type: 'object', required: ['title', 'steps', 'open_questions'],
  properties: {
    title: { type: 'string' },
    approach_summary: { type: 'string', description: '4-8 sentences: the chosen approach and why' },
    steps: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['id', 'title', 'goal', 'files', 'depends_on', 'details'],
        properties: {
          id: { type: 'string', description: 'short unique id, e.g. s1, s2' },
          title: { type: 'string' },
          goal: { type: 'string', description: 'observable outcome of the step' },
          files: { type: 'array', items: { type: 'string' }, description: 'files this step owns (created or modified). Disjoint file sets enable parallel execution.' },
          depends_on: { type: 'array', items: { type: 'string' } , description: 'HARD dependencies only: step ids whose code must already exist for this step to compile, run or be verified. Not a preferred reading order, not thematic affinity — every link here deepens the sequential wave chain.' },
          details: { type: 'string', description: 'what to do, key decisions, pointers (file:line) into existing code' },
          verify: { type: 'string', description: 'an EXECUTABLE check where possible (command, test to run, behavior to exercise); tie to acceptance criteria when a spec exists' },
          risk: { type: 'string', enum: ['contract', 'local'], description: '"contract" when the step changes a surface other steps or existing callers consume (exported signatures, types/schemas, wiring/registration) — it earns an immediate review checkpoint; "local" when the change is contained in its own files' },
          context_confidence: { type: 'string', enum: ['high', 'low'], description: '"high" when your details give an implementer everything needed (verified file:line pointers, the callers, the convention to follow) — no exploration agent will be spawned for it; "low" when you are pointing at roughly the right place and whoever implements it must investigate first. Judge honestly per step: "high" on a step you actually hand-waved costs a wrong implementation, "low" everywhere costs an extra agent per step.' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    open_questions: {
      type: 'array',
      items: {
        type: 'object', required: ['question', 'why_it_matters'],
        properties: {
          question: { type: 'string' },
          why_it_matters: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: '2-4 candidate answers with tradeoffs' },
        },
      },
      description: 'decisions only the developer can make — these block or reshape the plan',
    },
    dropped_claims: { type: 'array', items: { type: 'string' }, description: 'scout claims dropped as refuted/conflicting, with one-line reason' },
  },
}

// ---- Phase 1: decompose into exploration angles (skipped if caller provides them)
phase('Decompose')
let angles = args.angles
if (!angles || !angles.length) {
  const d = await metered('decompose', () => agent(
    `You are decomposing a development task into parallel repository-exploration angles.

${TASK_BRIEF}

Produce 3-5 exploration angles for read-only scouts. Merge related concerns into one angle when they share entry points or evidence. Each scout works alone and cannot see the others, so angles must be self-contained and collectively cover what an implementer needs: current behavior, integrations/callers, conventions, tests, and relevant config/build/deploy touchpoints. Skip irrelevant angles and give concrete hints about where to look.

Your final output is consumed by a script, not a human — return the structured data only.`,
    { label: 'decompose', ...ROLE.decompose, schema: ANGLES_SCHEMA },
  ))
  if (!d) throw new Error('decomposition agent failed')
  angles = d.angles
}
log(`exploring ${angles.length} angles: ${angles.map(a => a.name).join(', ')}`)

// ---- Phase 2: explore all angles. Phase 3 validates the load-bearing claims in one batch.
function scoutPrompt(a) {
  return `You are a read-only exploration scout for a development task. Do NOT modify repository files; the only file you write is your own report.

${TASK_BRIEF}

## Your angle: ${a.name}
Focus: ${a.focus}
Why it matters for this task: ${a.why}
${a.hints ? 'Where/how to look: ' + a.hints : ''}

## Guidelines
- Explore the repository from this angle only; other scouts cover other angles.
- Every claim needs evidence: file paths with line numbers and a short quote of the relevant code.
- Mark in your report what you VERIFIED in code versus what you are ASSUMING.
- Note risks, surprising couplings, and anything that contradicts the task brief.
- If the brief seems wrong or ambiguous given what you find, record an open question — do not silently reinterpret.

## Output discipline
WRITE your full report (all findings, evidence, code quotes) as markdown to "${findingsDir}/${a.name}.md".
RETURN only the compact structured summary: the digest, at most 6 headline findings (the ones that change what the plan should be), risks, open questions, and the report path. Downstream agents read your file for detail — the summary is for routing, not a replacement.`
}

function validatePrompt(scouts) {
  return `You are the single adversarial validator for a multi-angle repository exploration.

${TASK_BRIEF}

Scout summaries and report paths:
${JSON.stringify(scouts.map(({ angle, scout }) => ({ angle: angle.name, focus: angle.focus, report_path: scout.report_path, headline_findings: scout.headline_findings, risks: scout.risks })), null, 2)}

Validate only HEADLINE claims that materially change the plan; do not re-check every supporting observation. Cluster equivalent claims across angles before spending time on them. Confirm only with independent code evidence; refute with proof; mark unverified when checking would be disproportionate and let the synthesizer spot-check it if load-bearing. Identify at most 3 critical misses across ALL reports, not per angle. Every verdict and miss must name its angle.

Do NOT modify any files. Your final output is raw data for an orchestrator.`
}

const scoutResults = await metered('explore', () => parallel(angles.map((a) => () =>
  agent(scoutPrompt(a), { label: `scout:${a.name}`, phase: 'Explore', ...ROLE.scout, schema: SCOUT_SCHEMA })
)))
const scouted = angles.map((angle, index) => ({ angle, scout: scoutResults[index] })).filter((entry) => entry.scout)

if (!scouted.length) throw new Error('all scouts failed — nothing to synthesize')

phase('Validate')
const validation = args.validate === false
  ? { verdicts: [], missed_findings: [], suggested_adjustments: [] }
  : await metered('validate', () => agent(validatePrompt(scouted), { label: 'validate:batch', phase: 'Validate', ...ROLE.validate, schema: VALIDATION_SCHEMA }))
if (!validation) throw new Error('batched validation failed')

const validated = scouted.map(({ angle, scout }) => ({
  angle: angle.name,
  focus: angle.focus,
  scout,
  validation: {
    verdicts: validation.verdicts.filter((v) => v.angle === angle.name),
    missed_findings: (validation.missed_findings || []).filter((f) => f.angle === angle.name),
    suggested_adjustments: [],
  },
}))

// ---- Phase 4: cross-check everything and write the plan (opus)
// The synthesizer receives compact summaries + verdicts; full reports stay on disk as paths.
phase('Synthesize')
const synth = await metered('synthesize', () => agent(
  `You are the planning orchestrator for a development task. Scouts explored the repo by angle (full reports on disk), followed by one batched adversarial pass over their load-bearing claims (verdicts: confirmed / refuted / unverified, plus corrections and missed findings).

${TASK_BRIEF}

Compact summaries and validation verdicts (JSON). Full scout reports are at the report_path of each entry — read them where a decision hinges on detail:
${JSON.stringify(validated, null, 2)}
Batched validator adjustments (included once, not duplicated per angle):
${JSON.stringify(validation.suggested_adjustments || [], null, 2)}

## Your job
1. Cross-check across angles: reconcile conflicts between scouts, drop refuted claims, spot-check load-bearing "unverified" claims yourself (you may read the repo and the full reports).
2. Evaluate each suggested_adjustment and missed_finding; adopt the justified ones.
3. Design the plan as ONE-AGENT-SIZED steps. A step is one coherent change with a verifiable outcome, usually within roughly 10 files and one focused session. Prefer cohesive vertical slices: every step adds fixed scout/implementation/review overhead, so never split merely to hit a file count. Split genuine overflow. Per step declare: owned files, depends_on, concrete details with file:line pointers, an EXECUTABLE verification ("read the code" does not count), \`risk\` ("contract" when the step changes a surface others consume, "local" otherwise), and \`context_confidence\`. You are the only one who knows which steps you wrote from verified evidence and which you wrote from a plausible guess — \`context_confidence: "low"\` buys that step a dedicated exploration agent before implementation, "high" skips it. Spending it where you were vague and saving it where you were precise is worth more than any downstream heuristic can recover.
4. Keep the dependency graph SHALLOW. The implementer runs steps in topological waves: steps become sequential only through \`depends_on\`, and depth costs wall-clock and review overhead. So declare a dependency only when the other step's code must already exist for this one to compile, run or be verified — never for reading order or thematic grouping. A chain s1→s2→s3→s4 of one step each is usually a plan-shape mistake: either those steps are one cohesive step, or the dependencies are softer than declared. Prefer a wide first wave of independent steps over a deep chain, and aim for at most about three waves unless the work genuinely layers.${args.specPath ? '\n5. The spec at "' + args.specPath + '" has binding acceptance criteria: every criterion must be covered by at least one step’s verification. Say in the plan which step covers which criterion.' : ''}
${args.specPath ? '6' : '5'}. Collect open questions ONLY where the developer's answer genuinely changes the plan.

## Write the plan file
Write the full plan to "${planPath}":

# Plan: <title>
## Context        — task brief + what exploration established (with pointers)
## Approach       — the chosen approach and rejected alternatives
## Steps          — one "### <id>: <title>" section per step: goal, files, depends_on, risk, details, verification${args.specPath ? ' (+ acceptance criteria covered)' : ''}
## Risks
## Open questions
## Machine-readable steps
A fenced \`\`\`json block containing exactly the steps array you return in your structured output.

Return the structured data; the plan file is the human-facing artifact.`,
  { label: 'synthesize', ...ROLE.synth, schema: PLAN_SCHEMA },
))

if (!synth) throw new Error('synthesis agent failed')
log(`plan written: ${planPath} — ${synth.steps.length} steps, ${synth.open_questions.length} open questions`)

// Wave shape drives implementation wall-clock: depth is sequential, width is parallel. Surface it
// here so the developer can push back on a needlessly deep chain BEFORE approving the plan.
// Best-effort only — a malformed graph is the wf-implement workflow's error to raise, not ours.
function waveShape(steps) {
  const ids = new Set(steps.map((s) => s.id))
  const placed = new Set()
  const waves = []
  while (placed.size < steps.length) {
    const wave = steps.filter((s) => !placed.has(s.id) && (s.depends_on || []).every((d) => placed.has(d) || !ids.has(d)))
    if (!wave.length) return null // cycle or unknown dependency
    wave.forEach((s) => placed.add(s.id))
    waves.push(wave.map((s) => s.id))
  }
  return waves
}

const waves = waveShape(synth.steps)
if (waves) {
  log(`wave shape: ${waves.length} wave(s) — ${waves.map((w) => w.join('+')).join(' → ')}`)
  const thinChain = waves.length >= 4 && waves.filter((w) => w.length === 1).length >= 3
  if (thinChain) log(`WARNING: ${waves.length} waves with mostly single steps — the dependency chain is probably deeper than the work requires; consider consolidating before approving`)
} else {
  log('WARNING: could not compute a wave shape — the steps have a dependency cycle or an unknown dependency id')
}

return {
  workspace,
  planPath,
  waves,
  title: synth.title,
  approach_summary: synth.approach_summary,
  steps: synth.steps,
  risks: synth.risks || [],
  open_questions: synth.open_questions,
  dropped_claims: synth.dropped_claims || [],
  angles: angles.map((a) => a.name),
  finding_reports: validated.map((v) => v.scout.report_path),
  cost: costReport(),
}
