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
//         planPath?, mode?='plan', docPath?, priorFindings?, language?, profile?, models?, efforts?,
//         dryRun? }
//   language: write plan.md / understanding.md and the returned prose in this language, whatever the
//         conversation used. Addresses (ids, paths, commands, config keys) are never translated.
//         The skills read it from the repo's `Artifact language:` line in CLAUDE.md.
//   mode: 'plan' writes plan.md with executable steps; 'explain' writes understanding.md and returns
//         prose — same exploration and same validation, different synthesizer.
//   priorFindings: the `findings` array a previous run in this workspace returned. Angles it already
//         covers are not re-explored; the findings themselves still go through validation, so a
//         claim that went stale gets refuted rather than trusted.
//   workspace: absolute path to the task workspace (e.g. <repo>/.dev/<slug>).
//   Context discipline (RLM-style): scouts WRITE full reports to <workspace>/findings/ and RETURN
//   compact summaries; downstream agents receive paths and read detail only when load-bearing.
if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { throw new Error('args arrived as a non-JSON string') } }

// ---- Model/effort policy (roles, not phases — a policy passes intact into nested workflows).
// PROFILES is the whole cost model: one model[/effort] per pipeline role per profile, so a profile
// is a table lookup and not arithmetic on the ladder. `default` is exactly the tiers these workflows
// shipped with, so passing nothing changes nothing. `cheap` and `max` are per-role judgements rather
// than a uniform rung: cheap leaves the judging roles on sonnet, because a judge that goes wrong
// costs more than the tokens it saved, and max spends `fable` only where an agent authors or
// synthesises. Explicit `models`/`efforts` beat the profile, and an unknown profile, role, model or
// effort throws before any agent spawns. Effort inherits the session's unless the table names one —
// `decompose` is the only role that does. See docs/architecture.md.
const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const ROLE_NAMES = ['decompose', 'scout', 'validate', 'synth', 'impl', 'gate', 'check', 'review', 'verify', 'fix', 'run']
// Values are padded AFTER the colon on purpose. Padding before a role NAME instead would make this
// table the first indented `review:` in the file and steal the text anchor that
// tests/delivery-verdict.test.js slices its gate expression on — a red case in a test about code
// nobody touched (see .claude/rules/workflow-scripts.md). Keep the padding on the value side.
const PROFILES = {
  cheap:   { decompose:  'haiku/low', scout:  'haiku', validate: 'sonnet', synth: 'sonnet', impl: 'sonnet', gate: 'sonnet', check: 'sonnet', review: 'sonnet', verify: 'sonnet', fix: 'sonnet', run:  'haiku' },
  default: { decompose: 'sonnet/low', scout: 'sonnet', validate: 'sonnet', synth:   'opus', impl:   'opus', gate: 'sonnet', check:   'opus', review: 'sonnet', verify: 'sonnet', fix: 'sonnet', run: 'sonnet' },
  max:     { decompose: 'sonnet/low', scout: 'sonnet', validate:   'opus', synth:  'fable', impl:  'fable', gate:   'opus', check:  'fable', review:   'opus', verify:   'opus', fix:   'opus', run: 'sonnet' },
}
function policy(roles) {
  const a = args || {}
  const profile = a.profile == null ? 'default' : a.profile
  if (!Object.keys(PROFILES).includes(profile)) throw new Error(`unknown profile "${a.profile}" — use ${Object.keys(PROFILES).join(' | ')}`)
  const table = PROFILES[profile]
  const models = a.models || {}
  const efforts = a.efforts || {}
  for (const k of [...Object.keys(models), ...Object.keys(efforts)]) {
    if (!ROLE_NAMES.includes(k)) throw new Error(`unknown role "${k}" — pipeline roles are ${ROLE_NAMES.join(', ')}`)
  }
  const pick = (ladder, base, override, what) => {
    const value = override == null ? base : override
    if (value == null) return null
    if (!ladder.includes(value)) throw new Error(`unknown ${what} "${value}" — use ${ladder.join(' | ')}`)
    return value
  }
  const out = {}
  for (const name of roles) {
    if (!table[name]) throw new Error(`role "${name}" is not in the "${profile}" profile — PROFILES must cover every role in ROLE_NAMES`)
    const [baseModel, baseEffort] = table[name].split('/')
    const model = pick(MODELS, baseModel, models[name], 'model')
    const effort = pick(EFFORTS, baseEffort || null, efforts[name], 'effort')
    out[name] = effort ? { model, effort } : { model } // never hand agent() an effort of null
  }
  if (a.profile != null || Object.keys(models).length || Object.keys(efforts).length) {
    log(`policy: ${Object.keys(out).map((r) => `${r}=${out[r].model}${out[r].effort ? '/' + out[r].effort : ''}`).join(' ')}`)
  }
  return out
}
// `decompose` takes the task text in and returns angle names — it reads no code, which is why it
// is the one role the table gives an effort cell.
const ROLE = policy(['decompose', 'scout', 'validate', 'synth'])

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

// Two modes over one machine. `explain` answers "how does this work here?" and writes prose instead
// of steps — but the reason it lives here rather than in the built-in Explore agent (which is far
// cheaper for a throwaway answer) is that it leaves the SAME durable, adversarially validated
// findings/ artifacts behind. A later `plan` run in this workspace passes them back as
// `priorFindings` and skips re-exploring what is already on disk. That is what makes understanding
// a stage of the pipeline instead of a feature beside it.
const mode = args.mode === 'explain' ? 'explain' : 'plan'
const docPath = args.docPath || `${workspace}/understanding.md`
const priorFindings = (args.priorFindings || []).filter((f) => f && f.angle && f.report_path)

// Artifact language. Without this, `plan.md` and `understanding.md` come out in whatever language
// the conversation happened in — fine until you work in one language and publish in another, at
// which point it is a per-repo fact rather than a per-conversation one. Same mechanism as
// `profile`: a line in CLAUDE.md that the skill reads and passes here. Absent, nothing changes.
//
// It binds the STRUCTURED OUTPUT too, not just the document, because half the plan's prose reaches
// the developer through the returned steps rather than through the file. What it must not touch is
// anything that is an address: a translated `id`, path or verify command is a pointer that no longer
// resolves, and every downstream agent follows those literally.
const LANGUAGE = args.language
  ? `\n\n## Language\nWrite the document — and every prose string in your structured output — in ${args.language}, regardless of the language of this prompt or of the task brief. Leave anything that is an address exactly as it appears in the repo: identifiers, step ids, file paths, commands (including every \`verify\`), config keys, and quoted code. Translate the explanation, never the pointer.`
  : ''

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
      // Zero is a legitimate answer once prior findings cover the ground; without them it is not.
      type: 'array', minItems: priorFindings.length ? 0 : 3, maxItems: 5,
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
          covers: { type: 'array', items: { type: 'string' }, description: 'acceptance-criterion ids from the spec that this step’s verification proves, VERBATIM as the spec writes them ("AC-01"), and only ids the spec actually declares — an invented, misspelled or renumbered id is a coverage-lint warning the developer sees before approving. Omit the field entirely when the plan has no spec, or when the step covers no criterion; one criterion may legitimately be covered by more than one step, and one step may cover several.' },
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

// The explain-mode counterpart. `refuted` is the section no cheaper tool can write: a lone Explore
// agent can tell you how something works, but only a run that put its claims through adversarial
// validation can tell you which plausible belief about this code is provably false.
const EXPLAIN_SCHEMA = {
  type: 'object', required: ['title', 'answer', 'entry_points', 'open_questions'],
  properties: {
    title: { type: 'string' },
    answer: { type: 'string', description: 'the direct answer, 5-10 sentences, first and without preamble — what was actually asked, not a tour of the subsystem' },
    mechanisms: {
      type: 'array',
      items: {
        type: 'object', required: ['name', 'how_it_works', 'evidence'],
        properties: {
          name: { type: 'string' },
          how_it_works: { type: 'string', description: 'the actual control/data flow, not the intent the naming implies' },
          evidence: { type: 'string', description: 'file:line pointers' },
        },
      },
    },
    entry_points: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['path', 'why'],
        properties: { path: { type: 'string' }, why: { type: 'string', description: 'what a reader learns by starting here' } },
      },
      description: 'where to start reading, in order — the single most reusable output of an exploration',
    },
    surprises: {
      type: 'array',
      items: {
        type: 'object', required: ['what', 'evidence'],
        properties: {
          what: { type: 'string', description: 'a coupling, a name that does not describe its behavior, an invariant held only by convention' },
          evidence: { type: 'string' },
          why_it_matters: { type: 'string' },
        },
      },
      description: 'things that contradict what a competent reader would assume — the part worth paying an exploration for',
    },
    refuted: {
      type: 'array',
      items: {
        type: 'object', required: ['claim', 'evidence'],
        properties: { claim: { type: 'string', description: 'a plausible belief about this code that is NOT true' }, evidence: { type: 'string' } },
      },
      description: 'plausible claims validation disproved, with proof — state these even when nobody asked',
    },
    open_questions: PLAN_SCHEMA.properties.open_questions,
    doc_path: { type: 'string', description: 'path of the document you wrote' },
  },
}

// ---- Angle normalization. An angle's `name` is not a label: it is the FILENAME every scout writes
// its report to, so a missing or duplicated one sends two scouts to the same path and the second
// silently overwrites the first. Not hypothetical — run wf_836cc7e3-5d4 passed `angles` as an array
// of strings, every `a.name` read back `undefined`, and five scouts shared one
// `<workspace>/findings/undefined.md`.
function slugifyAngle(text, index) {
  const slug = String(text).toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') // the cut can leave a trailing separator behind
  return slug || `angle-${index + 1}` // a focus made entirely of punctuation still needs a filename
}

// Both sources of angles converge here — the caller's `args.angles` AND the decomposer's output,
// which can emit two identical names of its own, so validating only the caller's path would leave
// the same clobbering reachable. A malformed entry THROWS, and that must not be softened into a
// warning: the decompose agent is skipped whenever `angles` is non-empty, so a bad caller-supplied
// array costs exactly zero agents here, while carrying on would cost a whole exploration phase
// whose reports then overwrite one another.
// `reserved` seeds the disambiguation set with names this run must not reuse even though they never
// appear in `raw` — namely priorFindings' own `angle` values. Without it a fresh angle sharing a
// prior finding's name dispatches its scout to that finding's `report_path` (same workspace, same
// `findingsDir`), overwriting the file the reused entry still points readers at.
function normalizeAngles(raw, reserved) {
  if (!Array.isArray(raw)) throw new Error(`args.angles must be an array of {name, focus, why} objects — a plain string is accepted as that angle's focus — received ${typeof raw}: ${JSON.stringify(raw)}`)
  const taken = new Set(reserved || [])
  return raw.map((entry, index) => {
    let angle
    if (typeof entry === 'string') {
      // A bare string is unambiguous: it IS the focus, and the name is only a filename, so it is derived.
      angle = { name: slugifyAngle(entry, index), focus: entry, why: 'supplied verbatim by the caller' }
    } else if (entry && typeof entry === 'object' && entry.name && entry.focus) {
      angle = { ...entry, why: entry.why || 'not stated' }
    } else {
      // Guessing the missing half fabricates the scout's assignment: an invented focus reads to the
      // scout exactly like one a human wrote, and an invented name collides with the next entry.
      throw new Error(`angles[${index}] must be a string, or an object with both a name and a focus — received ${JSON.stringify(entry)}`)
    }
    // Deterministic disambiguation, in order: the first `a` keeps `a.md`, the next takes `a-2.md`.
    let name = angle.name
    for (let n = 2; taken.has(name); n++) name = `${angle.name}-${n}`
    taken.add(name)
    return name === angle.name ? angle : { ...angle, name }
  })
}

// ---- Phase 1: decompose into exploration angles (skipped if caller provides them)
phase('Decompose')
let angles = args.angles
// Only "nothing supplied" (or an explicitly empty array) skips validation and falls through to the
// decomposer. Anything else the caller supplied — including a malformed-but-falsy shape like `{}` —
// must still reach `normalizeAngles` below and throw there, or a caller bug silently pays for a whole
// decompose-and-explore run instead of being rejected at zero agents.
if (angles === undefined || angles === null || (Array.isArray(angles) && !angles.length)) {
  const d = await metered('decompose', () => agent(
    `You are decomposing a development task into parallel repository-exploration angles.

${TASK_BRIEF}

Produce 3-5 exploration angles for read-only scouts. Merge related concerns into one angle when they share entry points or evidence. Each scout works alone and cannot see the others, so angles must be self-contained and collectively cover what ${mode === 'explain' ? 'a reader needs to understand the subject: how it actually works, its entry points, who calls it, what constrains it, and where the behavior differs from what the naming suggests' : 'an implementer needs: current behavior, integrations/callers, conventions, tests, and relevant config/build/deploy touchpoints'}. Skip irrelevant angles and give concrete hints about where to look.
${priorFindings.length ? `
## Already explored in this workspace
An earlier run left these reports on disk; they will be re-validated against current code and handed to the synthesizer either way.
${JSON.stringify(priorFindings.map((f) => ({ angle: f.angle, focus: f.focus, summary: f.summary })), null, 2)}

Propose ONLY angles these do not already cover. Returning an EMPTY array is the right answer when they cover the ground — re-exploring what is already on disk buys nothing. Do not re-list an existing angle to be thorough.
` : ''}
Your final output is consumed by a script, not a human — return the structured data only.`,
    { label: 'decompose', ...ROLE.decompose, schema: ANGLES_SCHEMA },
  ))
  if (!d) throw new Error('decomposition agent failed')
  angles = d.angles
}
// Both branches pass through here — a caller's array and a decomposer's are equally capable of
// naming two angles the same thing, and the name is the report path. `priorFindings` seeds the
// disambiguation set too: its entries never pass through `raw`, but their `report_path`s are
// already claimed in this workspace.
angles = normalizeAngles(angles, priorFindings.map((f) => f.angle))
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
${JSON.stringify(scouts.map(({ angle, scout, report_path }) => ({ angle: angle.name, focus: angle.focus, report_path, headline_findings: scout.headline_findings, risks: scout.risks })), null, 2)}

Validate only HEADLINE claims that materially change the plan; do not re-check every supporting observation. Cluster equivalent claims across angles before spending time on them. Confirm only with independent code evidence; refute with proof; mark unverified when checking would be disproportionate and let the synthesizer spot-check it if load-bearing. Identify at most 3 critical misses across ALL reports, not per angle. Every verdict and miss must name its angle.

Do NOT modify any files. Your final output is raw data for an orchestrator.`
}

const scoutResults = angles.length
  ? await metered('explore', () => parallel(angles.map((a) => () =>
      agent(scoutPrompt(a), { label: `scout:${a.name}`, phase: 'Explore', ...ROLE.scout, schema: SCOUT_SCHEMA })
    )))
  : []
if (priorFindings.length) log(`reusing ${priorFindings.length} finding(s) from this workspace; ${angles.length} new angle(s) to explore`)

// Reuse skips SCOUTING, never validation: prior findings go through the same adversarial pass as
// fresh ones, so a claim that has gone stale since it was written gets refuted rather than trusted.
// That is the whole staleness guard — no HEAD comparison, no expiry, just the check that already
// exists doing its job on older input.
// `report_path` on the entry is the path this script DISPATCHED the scout to, not the one the scout
// reported back: the self-reported field is what carried the broken `findings/undefined.md` into the
// returned findings, and a caller reusing them has to be handed a path that exists. A prior finding
// keeps its own — an earlier run wrote that file and this one does not.
const scouted = [
  ...priorFindings.map((f) => ({
    angle: { name: f.angle, focus: f.focus || 'from an earlier run in this workspace' },
    scout: { summary: f.summary, headline_findings: f.headline_findings || [], open_questions: [], report_path: f.report_path },
    report_path: f.report_path,
    reused: true,
  })),
  ...angles.map((angle, index) => ({ angle, scout: scoutResults[index], report_path: `${findingsDir}/${angle.name}.md` })),
].filter((entry) => entry.scout)

// A scout that wrote somewhere else is a deviation worth seeing, not a reason to fail the run: the
// dispatched path is what downstream agents get either way, so say so rather than swapping it.
for (const entry of scouted) {
  if (entry.reused || !entry.scout.report_path || entry.scout.report_path === entry.report_path) continue
  log(`scout "${entry.angle.name}" reported "${entry.scout.report_path}" but was dispatched to "${entry.report_path}" — using the dispatched path`)
}

if (!scouted.length) throw new Error('all scouts failed — nothing to synthesize')

phase('Validate')
const validation = args.validate === false
  ? { verdicts: [], missed_findings: [], suggested_adjustments: [] }
  : await metered('validate', () => agent(validatePrompt(scouted), { label: 'validate:batch', phase: 'Validate', ...ROLE.validate, schema: VALIDATION_SCHEMA }))
if (!validation) throw new Error('batched validation failed')

const validated = scouted.map(({ angle, scout, reused, report_path }) => ({
  angle: angle.name,
  focus: angle.focus,
  reused: reused || undefined,
  report_path,
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
const EVIDENCE = `Compact summaries and validation verdicts (JSON). Full scout reports are at the report_path of each entry — read them where a decision hinges on detail:
${JSON.stringify(validated, null, 2)}
Batched validator adjustments (included once, not duplicated per angle):
${JSON.stringify(validation.suggested_adjustments || [], null, 2)}`

const explainPrompt = `You are answering a question about how an existing codebase works. Scouts explored it by angle (full reports on disk), followed by one batched adversarial pass over their load-bearing claims (verdicts: confirmed / refuted / unverified).

${TASK_BRIEF}

${EVIDENCE}

## Your job
1. Answer the question that was asked. Not a tour of the subsystem — the answer first, then what supports it. If the exploration did not actually settle it, say so instead of padding.
2. Cross-check across angles: reconcile conflicts, drop refuted claims, spot-check load-bearing "unverified" claims yourself (you may read the repo and the full reports).
3. Describe what the code DOES, not what its naming suggests it does. Where those differ, that difference is the most valuable thing you can report — put it in \`surprises\`.
4. Fill \`refuted\` with plausible beliefs about this code that are provably false, each with its evidence. A reader arrives with assumptions; this is the only place anything corrects them, and it is what this run bought over a single quick lookup.
5. Collect open questions ONLY where a developer's answer would change the picture — not questions you could have answered by reading more.

## Write the document
Write it to "${docPath}":

# <title>
## Answer            — the direct answer, first, no preamble
## How it works      — mechanisms with file:line evidence
## Where to start    — entry points in reading order
## What would surprise you
## Not true          — plausible claims this exploration disproved, with proof
## Open questions

Return the structured data; the document is the human-facing artifact.${LANGUAGE}`

const synth = await metered('synthesize', () => agent(
  mode === 'explain' ? explainPrompt : `You are the planning orchestrator for a development task. Scouts explored the repo by angle (full reports on disk), followed by one batched adversarial pass over their load-bearing claims (verdicts: confirmed / refuted / unverified, plus corrections and missed findings).

${TASK_BRIEF}

${EVIDENCE}

## Your job
1. Cross-check across angles: reconcile conflicts between scouts, drop refuted claims, spot-check load-bearing "unverified" claims yourself (you may read the repo and the full reports).
2. Evaluate each suggested_adjustment and missed_finding; adopt the justified ones.
3. Design the plan as ONE-AGENT-SIZED steps. A step is one coherent change with a verifiable outcome, usually within roughly 10 files and one focused session. Prefer cohesive vertical slices: every step adds fixed scout/implementation/review overhead, so never split merely to hit a file count. Split genuine overflow. Per step declare: owned files, depends_on, concrete details with file:line pointers, an EXECUTABLE verification ("read the code" does not count), \`risk\` ("contract" when the step changes a surface others consume, "local" otherwise), and \`context_confidence\`. You are the only one who knows which steps you wrote from verified evidence and which you wrote from a plausible guess — \`context_confidence: "low"\` buys that step a dedicated exploration agent before implementation, "high" skips it. Spending it where you were vague and saving it where you were precise is worth more than any downstream heuristic can recover.
4. Keep the dependency graph SHALLOW. The implementer runs steps in topological waves: steps become sequential only through \`depends_on\`, and depth costs wall-clock and review overhead. So declare a dependency only when the other step's code must already exist for this one to compile, run or be verified — never for reading order or thematic grouping. A chain s1→s2→s3→s4 of one step each is usually a plan-shape mistake: either those steps are one cohesive step, or the dependencies are softer than declared. Prefer a wide first wave of independent steps over a deep chain, and aim for at most about three waves unless the work genuinely layers.${args.specPath ? '\n5. The spec at "' + args.specPath + '" has binding acceptance criteria: every criterion must be covered by at least one step’s verification. The structured \`covers\` array on each step is what carries that claim: the ids exactly as the spec writes them, and only ids it actually declares — an id that is not in the spec, and a criterion that no step covers, are both coverage-lint warnings the developer sees before approving the plan. Where a criterion is genuinely covered by a suite-level check rather than by any single step, say so in prose (in Risks, or in that step’s details) rather than faking a \`covers\` entry for it. Say in the plan which step covers which criterion.' : ''}
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

Return the structured data; the plan file is the human-facing artifact.${LANGUAGE}`,
  { label: 'synthesize', ...ROLE.synth, schema: mode === 'explain' ? EXPLAIN_SCHEMA : PLAN_SCHEMA },
))

if (!synth) throw new Error('synthesis agent failed')

// Everything downstream can be handed straight back as `priorFindings` — the point of explain mode.
const reusableFindings = validated.map((v) => ({
  angle: v.angle, focus: v.focus, report_path: v.report_path,
  summary: v.scout.summary, headline_findings: v.scout.headline_findings || [],
})).filter((f) => f.report_path)

if (mode === 'explain') {
  log(`understanding written: ${docPath} — ${(synth.refuted || []).length} refuted claim(s), ${synth.open_questions.length} open question(s)`)
  return {
    mode,
    workspace,
    docPath: synth.doc_path || docPath,
    title: synth.title,
    answer: synth.answer,
    mechanisms: synth.mechanisms || [],
    entry_points: synth.entry_points || [],
    surprises: synth.surprises || [],
    refuted: synth.refuted || [],
    open_questions: synth.open_questions,
    // Pass these to a later run in this workspace as `priorFindings`: it re-validates them against
    // current code and explores only what they do not cover.
    findings: reusableFindings,
    cost: costReport(),
  }
}

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
  finding_reports: validated.map((v) => v.report_path),
  findings: reusableFindings,
  cost: costReport(),
}
