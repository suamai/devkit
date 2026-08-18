export const meta = {
  name: 'wf-implement',
  description: 'Execute plan steps in dependency waves: adaptive scout → implement → cheap contract gate per wave → full review at cost-driven checkpoints, then a cross-step consistency check',
  whenToUse: 'After a plan from wf-explore-plan is approved by the developer: implement its steps, parallelizing steps with disjoint file sets',
  phases: [
    { title: 'Scout', detail: 'briefs only for ambiguous or oversized steps' },
    { title: 'Implement', detail: 'per-step implementation + executed verification' },
    { title: 'Gate', detail: 'one cheap agent per wave: is the surface later steps consume coherent?' },
    { title: 'Check', detail: 'cross-step consistency + suite' },
  ],
}

// args: { workspace, steps, completed?, baseline?, planPath?, notes?, review?=true, reviewRounds?=2,
//         reviewLoopPath?, scoutMode?='adaptive', maxParallelSteps?=5,
//         gate?=true, checkpointFileThreshold?=20, checkpointMaxWaves?=3, rules?, criteria?,
//         profile?, models?, efforts?, dryRun? }
//   dryRun: with `steps`, returns the computed schedule (waves, parallel groups, scouts, matched
//          rules, projected checkpoints, plan warnings) instead of running anything — a zero-cost
//          plan lint. Without `steps`, the old parse-only smoke test.
//   profile/models/efforts: model tier per role (scout, impl, gate, check) — see the policy block
//          below. Passed through to the nested review loop, so one dial covers the whole run.
//   completed: what an earlier run of this same plan already implemented — the `continuation.completed`
//          array it returned, or bare ids. Stopping early is a designed outcome here (a blocking
//          question, an unclean checkpoint, a failed step, the budget floor), so continuing is a
//          normal path, not error recovery. Pass the SAME `steps` plus this: the caller never edits
//          the dependency graph, because passing only the pending steps would trip toWaves()'s
//          unknown-dependency check. Entries with reviewed !== true are folded into this run's next
//          review checkpoint — code that landed but was never judged is the one thing a continuation
//          must not inherit silently.
//   rules: [{ path, globs }] — the repo's path-scoped rule files (.claude/rules/*.md frontmatter).
//          Scripts have no filesystem access, so the caller reads them; agents get only the ones
//          matching the files they touch. Omit and agents are told to look for them themselves.
//   criteria: the spec's acceptance-criterion ids ("AC-01", …), in document order and NOT
//          deduplicated — the caller extracts them from spec.md for the same reason `rules` arrives
//          pre-extracted, and a spec declaring one id twice is a defect the lint reports rather than
//          something to quietly collapse. They are the known-good set each step's `covers` is judged
//          against, and what `coverage` and `gates.acceptance` below are computed from. Omit them
//          and a plan with no spec behaves exactly as before: `acceptance: "n/a"`.
//   baseline: git SHA captured before this run — reviewers judge diffs since it.
//   workspace: absolute path to the task workspace (e.g. <repo>/.dev/<slug>).
//   Context flows as files with single writers: briefs/<id>.md (scout), notes/<id>.md (implementer).
//   Readers get paths, never dumps.
//
//   Waves are a CORRECTNESS constraint (depends_on) and stay sequential. Review checkpoints are a
//   COST decision and are deliberately coarser: waves accumulate until a checkpoint is worth paying
//   for, and each wave in between gets one cheap contract gate instead of a full review loop.
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
  scout: { model: 'sonnet' },
  impl: { model: 'opus' }, // runs once per step — the pipeline's largest single cost driver
  gate: { model: 'sonnet' },
  check: { model: 'opus' },
  verify: { model: 'sonnet' }, // the one re-run an evidenced infrastructure failure buys — it runs a command, it does not write code
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

// `dryRun` is no longer a parse check. Given `steps` it runs the entire scheduler — waves, disjoint
// batches, scout decisions, rule matching, checkpoint policy — and returns what the run WOULD do,
// at zero agents and zero tokens. So the arg gate has to let a projection through: it needs steps,
// not a workspace. Without steps it stays the old smoke test.
const dryRun = !!(args && args.dryRun)
if (!args) throw new Error('args is required')
if (!dryRun && !args.workspace) throw new Error('args.workspace is required: absolute path to the task workspace')
if (!args.steps || !args.steps.length) {
  if (dryRun) return { ok: true, workflow: 'wf-implement', policy: ROLE }
  throw new Error('args.steps is required: the machine-readable steps from the plan')
}

const workspace = (args.workspace || '').replace(/\/+$/, '')
const planPath = args.planPath || `${workspace}/plan.md`
const notes = args.notes || ''
const MAX_SPLIT_DEPTH = 2 // recursive splitting is an escape valve, not the default mode
const scoutMode = args.scoutMode || 'adaptive'
const maxParallelSteps = Math.max(1, args.maxParallelSteps || 5)
if (!['always', 'adaptive', 'never'].includes(scoutMode)) throw new Error(`invalid scoutMode: ${scoutMode}`)
const gateEnabled = args.gate !== false && args.review !== false
const checkpointFileThreshold = Math.max(1, args.checkpointFileThreshold || 20)
const checkpointMaxWaves = Math.max(1, args.checkpointMaxWaves || 3)

const completed = (Array.isArray(args.completed) ? args.completed : [])
  .map((c) => (typeof c === 'string' ? { id: c } : c))
  .filter((c) => c && c.id)
const completedIds = new Set(completed.map((c) => c.id))

// The canonical acceptance-criterion ids, extracted from spec.md by the CALLER: a workflow script
// has no filesystem access, which is the same reason `rules` arrives pre-extracted. Document order,
// and deliberately NOT deduplicated — a spec that declares one id twice is itself a defect, and the
// coverage lint below is where it gets reported.
const criteria = (Array.isArray(args.criteria) ? args.criteria : [])
  .map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)

// A completed step's id is a satisfied dependency, so it is stripped from what remains rather than
// left dangling. Pure, and the only graph surgery a continuation needs.
function pendingSteps(steps, doneIds) {
  return steps
    .filter((s) => !doneIds.has(s.id))
    .map((s) => ({ ...s, depends_on: (s.depends_on || []).filter((d) => !doneIds.has(d)) }))
}

const STEP_SHAPE = {
  type: 'object', required: ['id', 'title', 'goal', 'files', 'depends_on', 'details'],
  properties: {
    id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    depends_on: { type: 'array', items: { type: 'string' } },
    details: { type: 'string' }, verify: { type: 'string' },
    // Optional, and never in `required`: BRIEF_SCHEMA.substeps reuses this shape, and a scout's
    // sub-steps are invented mid-run with no spec ids of their own to declare.
    covers: { type: 'array', items: { type: 'string' } },
    risk: { type: 'string', enum: ['contract', 'local'] },
    context_confidence: { type: 'string', enum: ['high', 'low'] },
  },
}

// Whether a step needs an exploration agent before implementation. The planner declares it when it
// can (it knows which steps it wrote from verified evidence); the heuristic is only a fallback for
// plans without the field — it can measure the size of `details`, never its usefulness.
function needsScout(s, depth) {
  if (scoutMode === 'never') return false
  if (scoutMode === 'always') return true
  if (depth > 0) return true // a sub-step exists because its parent was too big to hold at once
  if (s.context_confidence === 'high') return false
  if (s.context_confidence === 'low') return true
  return (s.files || []).length > 10 || !s.details || s.details.length < 80
}

const BRIEF_SCHEMA = {
  type: 'object', required: ['summary', 'brief_path', 'too_big'],
  properties: {
    summary: { type: 'string', description: 'compact digest: what the implementer must know; detail lives in the brief file' },
    brief_path: { type: 'string', description: 'path of the full brief file you wrote in the workspace' },
    gotchas: { type: 'array', items: { type: 'string' }, description: 'traps: hidden couplings, stale plan assumptions, ordering constraints' },
    too_big: { type: 'boolean', description: 'true ONLY if this step clearly exceeds one-agent size and must be split' },
    split_reason: { type: 'string' },
    substeps: { type: 'array', minItems: 2, maxItems: 5, items: STEP_SHAPE, description: 'only when too_big: one-agent-sized sub-steps with ids like <parent>a, <parent>b; declare files and depends_on among them' },
  },
}

const IMPL_SCHEMA = {
  type: 'object', required: ['summary', 'changed_files', 'notes_path', 'verify_run'],
  properties: {
    summary: { type: 'string', description: 'compact implementation outcome; detail belongs in notes_path' },
    changed_files: { type: 'array', items: { type: 'string' }, description: 'native JSON array of repository paths actually changed' },
    notes_path: { type: 'string', description: 'path of the notes file you wrote: decisions and why, deviations, traps for later steps' },
    verify_run: {
      type: 'object', required: ['ran'],
      properties: {
        ran: { type: 'boolean', description: 'false only if no executable check was possible. These fields travel together: ran=true without `command` and `passed` is treated exactly like ran=false, because a bare boolean is not evidence.' },
        command: { type: 'string', description: 'REQUIRED when ran=true: the exact command you executed' },
        passed: { type: 'boolean', description: 'REQUIRED when ran=true: whether that command actually succeeded' },
        output_summary: { type: 'string' },
        not_ran_reason: { type: 'string', description: 'required when ran=false: why no executable check was possible. An unverified step is reviewed with extra scrutiny, so "no time" or "looked correct" is not a reason.' },
        status: { type: 'string', enum: ['passed', 'failed', 'not-run', 'infra-error'], description: 'the script DERIVES the status from ran/command/passed, so the only claim worth making here is `infra-error`: the check could not run for a reason unrelated to your change (missing toolchain, registry outage, a service that would not start). It requires BOTH the `command` you tried AND the failure you observed, in `output_summary` or `not_ran_reason`. An unevidenced infra claim that says the check RAN is read as a plain failure; one that honestly says ran=false keeps its not_ran_reason and stays not-run.' },
        kind: { type: 'string', enum: ['new-test', 'existing-suite', 'manual'], description: 'REQUIRED when ran=true (the convention `command` and `passed` already use): new-test = a check that could not have passed before this step, existing-suite = a check that was already green before it (a refactor is the legitimate case), manual = behavior you observed by hand. Omitting it does not make a pass weak evidence, but it is counted.' },
      },
      description: 'result of ACTUALLY RUNNING the step verification — reading the code does not count',
    },
    deviations: { type: 'array', items: { type: 'object', required: ['what', 'why'], properties: { what: { type: 'string' }, why: { type: 'string' } } } },
    concerns: {
      type: 'array', items: { type: 'string' },
      description: 'where YOU are unsure your implementation is right — reviewers get these as priority targets, so vagueness wastes them. Name the file and what could be wrong.',
    },
    needs_user_input: {
      type: 'array',
      items: {
        type: 'object', required: ['question', 'blocking'],
        properties: {
          question: { type: 'string', description: 'the decision only the developer can make' },
          blocking: { type: 'boolean', description: 'true when a different answer would invalidate this step\'s approach — later steps must NOT be built on the guess. The run stops at the next checkpoint instead of continuing.' },
          assumption: { type: 'string', description: 'the reversible choice you made in the meantime' },
        },
      },
      description: 'questions only the developer can answer',
    },
  },
}

const CHECK_SCHEMA = {
  type: 'object', required: ['consistent', 'issues'],
  properties: {
    consistent: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', required: ['description', 'severity'], properties: { description: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, fixed: { type: 'boolean' } } } },
    fixes_applied: { type: 'array', items: { type: 'string' } },
    suite_run: { type: 'object', properties: { ran: { type: 'boolean' }, command: { type: 'string' }, passed: { type: 'boolean' }, output_summary: { type: 'string' } } },
    needs_user_input: { type: 'array', items: { type: 'string' } },
  },
}

const GATE_SCHEMA = {
  type: 'object', required: ['coherent', 'breaks'],
  properties: {
    coherent: { type: 'boolean', description: 'true when the surface pending steps consume is sound as-is' },
    breaks: {
      type: 'array',
      items: {
        type: 'object', required: ['description', 'severity', 'file'],
        properties: {
          description: { type: 'string', description: 'the contract break + which pending step or existing caller hits it' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          file: { type: 'string' },
        },
      },
    },
  },
}

// ---- Scheduling: topological waves over depends_on; within a wave, only steps with declared,
// mutually disjoint file sets run concurrently. No files list => never parallelized.
function toWaves(list) {
  const ids = new Set(list.map((s) => s.id))
  if (ids.size !== list.length) throw new Error('duplicate step ids are not allowed')
  const unknown = list.flatMap((s) => (s.depends_on || []).filter((d) => !ids.has(d)).map((d) => `${s.id}->${d}`))
  if (unknown.length) throw new Error(`unknown step dependencies: ${unknown.join(', ')}`)
  const waves = []
  const placed = new Set()
  while (placed.size < list.length) {
    const wave = list.filter((s) => !placed.has(s.id) && (s.depends_on || []).every((d) => placed.has(d)))
    if (!wave.length) {
      throw new Error('dependency cycle among steps: ' + list.filter((s) => !placed.has(s.id)).map((s) => s.id).join(', '))
    }
    wave.forEach((s) => placed.add(s.id))
    waves.push(wave)
  }
  return waves
}

const GLOB_TOKENS = ['*', '?', '[', ']', '{', '}']
const normalizePath = (f) => f.trim().replace(/^\.\//, '').replace(/\/+$/, '')

// A globbed path is compared by the literal directory scope it can reach: "src/db/*.ts" can only
// touch files under "src/db", so it never conflicts with "src/api/x.ts". Treating any glob as
// universally overlapping (the earlier rule) serialized steps that were in fact disjoint.
function pathScope(raw) {
  const path = normalizePath(raw)
  const globAt = [...path].findIndex((char) => GLOB_TOKENS.includes(char))
  if (globAt === -1) return { path, glob: false }
  const cut = path.lastIndexOf('/', globAt)
  return { path: cut === -1 ? '' : path.slice(0, cut), glob: true }
}

function disjoint(a, b) {
  const af = a.files || []
  const bf = b.files || []
  if (!af.length || !bf.length) return false // undeclared files: cannot prove disjointness
  const within = (x, y) => x === y || x.startsWith(`${y}/`)
  const overlaps = (left, right) => {
    const aScope = pathScope(left)
    const bScope = pathScope(right)
    if ((aScope.glob && !aScope.path) || (bScope.glob && !bScope.path)) return true // repo-wide glob
    return within(aScope.path, bScope.path) || within(bScope.path, aScope.path)
  }
  return !af.some((left) => bf.some((right) => overlaps(left, right)))
}

// ---- Path-scoped repo rules. `.claude/rules/*.md` is a NATIVE Claude Code convention, not a devkit
// one: those files load automatically alongside CLAUDE.md, and a `paths:` frontmatter key scopes a
// file so it loads only when Claude works with matching files (verified against the shipped CLI —
// its /init text and its claudeMdExcludes docs both describe exactly this). That loading is a
// main-session mechanism, and it never reached workflow subagents, so every agent was rediscovering
// conventions the repo had already written down. Scripts have no filesystem access, so the caller
// runs scripts/rules-manifest.sh and passes [{path, globs}]; we do the matching per agent.
//
// The matching below is ours, not the CLI's — a workflow script cannot import its matcher, so the
// two can disagree at the edges. It errs toward offering an extra rule, which costs a read.
const ruleDefs = (args.rules || []).filter((r) => r && r.path)

// >>> shared: repo-rule matching — byte-identical across workflows (tests/rules.test.js)
function globToRegExp(glob) {
  let out = '^'
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 3 } else { out += '.*'; i += 2 }
      } else { out += '[^/]*'; i += 1 }
    } else if (c === '?') {
      out += '[^/]'; i += 1
    } else if (c === '{') {
      const close = glob.indexOf('}', i)
      if (close === -1) { out += '\\{'; i += 1 } else {
        out += `(?:${glob.slice(i + 1, close).split(',').map((a) => a.trim().replace(/[.+^$()|[\]\\*?]/g, '\\$&')).join('|')})`
        i = close + 1
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      out += `\\${c}`; i += 1
    } else {
      out += c; i += 1
    }
  }
  return new RegExp(`${out}$`)
}

// A step may declare files as globs too. Exact regex match governs concrete paths; for a globbed
// declaration we fall back to comparing directory scopes, which errs toward offering an extra rule.
function ruleMatchesFile(ruleGlob, regex, file) {
  const path = normalizePath(file)
  if (regex.test(path)) return true
  const fileScope = pathScope(path)
  if (!fileScope.glob) return false
  const ruleScope = pathScope(normalizePath(ruleGlob))
  if (!ruleScope.path || !fileScope.path) return true
  return fileScope.path === ruleScope.path || fileScope.path.startsWith(`${ruleScope.path}/`) || ruleScope.path.startsWith(`${fileScope.path}/`)
}

// Most specific first: a rule scoped to products/*/packages/domains/src/db says more about the code
// than one covering **/*.ts, so it leads when the list has to be trimmed.
function ruleSpecificity(rule) {
  return Math.max(...(rule.globs || ['']).map((g) => pathScope(normalizePath(g)).path.length))
}

function rulesFor(files) {
  if (!ruleDefs.length) return []
  return ruleDefs
    .filter((rule) => {
      const globs = (rule.globs || []).filter(Boolean)
      // No `paths:` frontmatter means unscoped: Claude Code loads that rule alongside CLAUDE.md for
      // every file, so a subagent — which inherits none of that — must see it for every file too.
      if (!globs.length) return true
      if (!files.length) return false
      return globs.some((g) => {
        const regex = globToRegExp(normalizePath(g))
        return files.some((f) => ruleMatchesFile(g, regex, f))
      })
    })
    .sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a))
    .map((rule) => rule.path)
}
// <<< shared: repo-rule matching

function rulesNote(files, role) {
  const matched = rulesFor(files)
  if (matched.length) {
    return `\n## Repo rules covering these files — READ THEM\n${matched.map((p) => '- ' + p).join('\n')}\nThese are this repository's own checklists for the area you are touching, and they point at the canonical doc when detail is needed. ${role}\n`
  }
  if (ruleDefs.length) return '' // rules exist and none match these paths: nothing to read
  return `\n## Repo rules\nThis repo may keep path-scoped checklists in ".claude/rules/*.md", each with a \`paths:\` frontmatter listing the globs it covers. Check whether one matches the files in play and read it if so. ${role}\n`
}

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function disjointBatches(wave) {
  const rem = [...wave]
  const out = []
  while (rem.length) {
    const batch = []
    for (const s of [...rem]) {
      if (batch.every((b) => disjoint(b, s))) {
        batch.push(s)
        rem.splice(rem.indexOf(s), 1)
      }
    }
    out.push(batch)
  }
  return out
}

function scoutPrompt(s, depth, ctx) {
  const inherited = [...ctx.briefPaths, ...ctx.notesPaths]
  return `You are a read-only context scout preparing the implementation of ONE plan step. Do NOT modify repository files; the only file you write is your brief.

Read the plan at "${planPath}" — overall context plus the section for step ${s.id} ("${s.title}").

Step data:
${JSON.stringify(s, null, 2)}
${inherited.length ? '\nThis is a sub-step. Inherited context from the parent — read these FIRST, they carry the reasoning so far:\n' + inherited.map((p) => '- ' + p).join('\n') : ''}
${notes ? '\nDeveloper notes:\n' + notes : ''}
${rulesNote(s.files || [], 'Carry the points that actually bear on this step into your brief — the implementer should not have to rediscover them.')}
## Size check first
A step is one-agent-sized when it is ONE coherent change with a verifiable outcome, usually within roughly 10 files and one focused session. Do not split a cohesive vertical change merely to hit a file count: every step adds fixed agent cost. If this step CLEARLY exceeds that${depth >= MAX_SPLIT_DEPTH ? ' — note: max split depth reached, flag it but splitting will be ignored' : ''}, set too_big=true, explain why, and propose 2-5 coherent substeps (ids "${s.id}a", "${s.id}b", ...; each declares its files and depends_on among the substeps).

## In BOTH cases, write the brief
WRITE a markdown brief to "${workspace}/briefs/${s.id}.md" with what the implementer(s) need: exact pointers (file:line) to the code to change and its call sites, repo conventions to follow (error handling, naming, test style), and gotchas — hidden couplings, plan assumptions that no longer hold, ordering constraints. Verify the plan's claims against the code rather than repeating them. When splitting, the brief carries the shared context all substeps inherit.

Return only the compact structured summary; the file carries the detail.`
}

function implPrompt(s, brief, batch, ctx) {
  const others = batch.filter((o) => o.id !== s.id)
  const inherited = [...ctx.briefPaths, ...ctx.notesPaths]
  return `You are implementing ONE step of an approved development plan.

Read, in this order:
1. The plan (overall context + your step's section): "${planPath}"
${brief.brief_path !== planPath ? `2. Your step's scout brief: "${brief.brief_path}"` : '2. No separate scout was needed: inspect the relevant code and callers yourself before editing.'}
${inherited.length ? inherited.map((p) => '3. Inherited parent context: "' + p + '"').join('\n') : ''}
${rulesNote(s.files || [], 'They are binding for the code you write here: following them is cheaper than having a reviewer send it back.')}

Your step:
${JSON.stringify(s, null, 2)}

Scout's compact summary (full detail in the brief file; verify anything load-bearing yourself):
${JSON.stringify({ summary: brief.summary, gotchas: brief.gotchas }, null, 2)}
${notes ? '\nDeveloper notes:\n' + notes : ''}
${others.length ? '\nOther steps run CONCURRENTLY and own these files — do NOT touch them: ' + others.flatMap((o) => o.files || []).join(', ') : ''}

## Guidelines
- Implement the step fully, following the repo's conventions and the brief's pointers.
- Stay within your step's files (${(s.files || []).join(', ') || 'as per the plan'}); if the correct implementation genuinely requires touching another file, do it only if no concurrent step owns it, and record it as a deviation.
- If the plan is wrong about something, prefer the smallest correct deviation and record what/why.
- Ambiguity only the developer can resolve: make the safest reversible choice, then record the question in needs_user_input with your assumption. Set blocking=true when a different answer would invalidate this step's approach rather than just adjust it — later steps must not be built on the guess, so a blocking question stops the run at the next checkpoint. Use it when it is true and not otherwise: a false blocking halts work that could have continued, a missed one gets built upon.
- VERIFY by actually running the step's check (${s.verify || 'infer the cheapest concrete check: targeted test, build/typecheck, or a quick runtime probe'}) and report the result in verify_run. Reading the code is not verification. If no executable check was genuinely possible, set ran=false AND give not_ran_reason — an unverified step is reported as such and reviewed with extra scrutiny, so silence is not the cheap path.
- The verify_run fields travel together: ran=true is a claim, \`command\` and \`passed\` are its evidence. Reporting ran=true without both is treated exactly like ran=false — it buys nothing and loses the not_ran_reason that would have explained it.
- Before you report a pass, answer this: would this command have failed at the baseline, before your change? If yes, it is real evidence for this step — \`kind: "new-test"\`. If the honest answer is no, the command was already green and \`kind: "existing-suite"\` is the answer: the step stays VERIFIED, but it is recorded as weak evidence and handed to the reviewer, because a suite that already passed proves your change broke nothing and says nothing about behavior it was supposed to add. For a refactor that is exactly the right answer, so say so rather than reaching for a stronger word. Behavior you checked by hand is \`kind: "manual"\`.
- If the check could not run for a reason unrelated to your code (missing toolchain, registry outage, a service that would not start), set \`status: "infra-error"\` AND name both the exact \`command\` you tried and the failure you observed. Evidenced, that claim buys one cheap re-run instead of stopping the run; unevidenced, an infra claim that still says the check RAN is read as a plain failure. If no check was possible at all, \`ran: false\` with a concrete not_ran_reason is the honest answer and stays exactly that.
- Report in concerns anything you are unsure you got right, naming the file and what could be wrong. Reviewers receive these as priority targets: this is where your own doubt is worth more than their search.
- WRITE your working notes to "${workspace}/notes/${s.id}.md": decisions taken and WHY, deviations, anything later steps or reviewers should know. Sub-steps and reviewers read this file.

## Required StructuredOutput call
At the end, call StructuredOutput with one NATIVE JSON OBJECT whose top-level properties match this exact shape:

{
  "summary": "compact outcome; put detail in the notes file",
  "changed_files": ["path/to/file.ts"],
  "notes_path": "${workspace}/notes/${s.id}.md",
  "verify_run": {
    "ran": true,
    "command": "the command actually run",
    "passed": true,
    "status": "passed",
    "kind": "new-test",
    "output_summary": "compact observed result"
  },
  "deviations": [],
  "concerns": ["src/x.ts: unsure the retry path releases the lock"],
  "needs_user_input": [{ "question": "...", "blocking": false, "assumption": "..." }]
}

STRICT SERIALIZATION RULES:
- Pass these as actual tool-input properties. Do NOT put JSON or other fields inside the summary string.
- Do NOT use XML/tags such as <summary>, <changed_files>, <parameter>, <invoke>, or </invoke>.
- Do NOT wrap the object in "input", "structured_output", "result", or any other property.
- The required top-level properties are summary, changed_files, notes_path, and verify_run.
- Keep the return compact; the notes file carries the full narrative.`
}

// `infra-error` is the one thing a reply's SHAPE can never reveal: from the outside, "the registry
// was down" and "my change broke the build" are the same red command. So the agent CLAIMS it, and the
// claim carries evidence — the command it tried AND the failure it observed. These two helpers are
// the single definition of that rule; the retry gate below and the typed status in runStep both read
// them, so there is one place to change and not two that can disagree.
const infraClaim = (v) => (typeof v.status === 'string' ? v.status.trim() : '') === 'infra-error'
const infraShown = (v) => !!String(v.command || '').trim() && !!(String(v.output_summary || '').trim() || String(v.not_ran_reason || '').trim())

// The re-run an evidenced infra-error buys. It is deliberately NOT an implementer: its whole job is
// to run a command and report what happened, at a cheap tier, once.
//
// It MAY move the environment — re-running `npm ci`, starting the service, restoring a dependency is
// usually the only thing that clears a transient failure, and a retry that just re-runs the same
// command mostly re-reports the same error. That mutation outlives the step: later waves inherit the
// environment, so the agent has to NAME what it ran. It may never touch a tracked file: a check that
// only goes green after the source changed is a defect, and repairing it here would launder that
// defect into a run that reports itself verified.
function verifyRetryPrompt(s, verify) {
  const command = (verify.command || '').trim() || (s.verify || '').trim()
  return `A step's verification check reported an INFRASTRUCTURE failure: the check could not run for reasons unrelated to the code. You get one attempt to establish what is actually true.

## The command — run it from the repository root, exactly as written
\`\`\`
${command || 'No command was named. Determine the step\'s own check from the plan if you can; if you cannot run anything, return ran: false with a concrete reason.'}
\`\`\`

## What the first attempt reported
${verify.output_summary || verify.not_ran_reason || 'No summary was reported — run the command and read the failure yourself.'}

## Step being checked
${s.id}: ${s.goal || s.title || ''}

## What you may and may not do
- Re-run the command and report what it did. \`passed\` is its exit status and nothing else — never a judgement of whether the code looks right.
- You MAY re-run the environment step the first attempt named — \`npm ci\`, starting a service, restoring a dependency, refreshing a cache — because a transient infrastructure failure usually needs that to clear.
- You may NOT edit any tracked file: not source, not tests, not config, not a lockfile. If the only way to make the check pass is a source change, that is a DEFECT and not an infrastructure blip: leave it, report \`passed: false\`, and say so in \`output_summary\`.
- NAME every environment command you ran in \`output_summary\`. Later steps inherit this environment and the reviewer has to be able to see that it moved.
- Claim \`status: "infra-error"\` again ONLY if the same infrastructure failure recurred, and name it. If the command runs now, report its real result instead.

Return only the verify_run object: raw data for an orchestrator, not prose for a human.`
}

// Steps in the same batch run concurrently (parallel(), up to maxParallelSteps) because their FILES
// are disjoint — that guarantee says nothing about infra. If two siblings each hit an evidenced
// infra-error on their first attempt (one registry outage does this to every step that needs it),
// both retries above are independently licensed to mutate the same environment — two concurrent
// `npm ci`s against the same node_modules. Route every retry through one chain so only one is ever
// mutating the environment at a time; it queues just the retry call, not the rest of runStep, so the
// other steps in the batch keep implementing in parallel while a retry waits its turn.
let envRetryChain = Promise.resolve()
function runEnvRetry(fn) {
  const settled = envRetryChain.then(fn)
  envRetryChain = settled.catch(() => {}) // one retry's failure must not jam the queue for the next
  return settled
}

async function runStep(s, batch, depth, ctx) {
  if (budget.total && budget.remaining() < 40000) {
    log(`token budget floor reached — skipping step ${s.id}`)
    return { step: s.id, title: s.title, skipped_for_budget: true }
  }
  const brief = needsScout(s, depth)
    ? await agent(scoutPrompt(s, depth, ctx), { label: `scout:${s.id}`, phase: 'Scout', ...ROLE.scout, schema: BRIEF_SCHEMA })
    : { summary: 'Use the validated plan and inspect current callers before editing.', brief_path: planPath, gotchas: [], too_big: false }
  if (!brief) return { step: s.id, title: s.title, failed: true, stage: 'scout' }

  // Escape valve: recursively split oversized steps; substeps inherit the parent's brief (and
  // the whole inherited chain) as file pointers — no context re-verbalized through the orchestrator.
  if (brief.too_big && brief.substeps && brief.substeps.length > 1 && depth < MAX_SPLIT_DEPTH) {
    log(`step ${s.id} split into ${brief.substeps.length} sub-steps: ${brief.split_reason || 'exceeds one-agent size'}`)
    const subCtx = { briefPaths: [...ctx.briefPaths, brief.brief_path], notesPaths: ctx.notesPaths }
    const subReports = []
    for (const wave of toWaves(brief.substeps)) {
      for (const b of disjointBatches(wave)) {
        for (const group of chunks(b, maxParallelSteps)) {
          const rs = await parallel(group.map((x) => () => runStep(x, b, depth + 1, subCtx)))
          subReports.push(...rs.filter(Boolean))
        }
      }
    }
    return { step: s.id, title: s.title, split: true, split_reason: brief.split_reason, substeps: subReports }
  }
  if (brief.too_big && depth >= MAX_SPLIT_DEPTH) log(`step ${s.id} flagged too_big at max split depth — implementing as-is`)

  let impl = await agent(implPrompt(s, brief, batch, ctx), { label: `impl:${s.id}`, phase: 'Implement', ...ROLE.impl, schema: IMPL_SCHEMA })
  if (!impl) {
    return {
      step: s.id,
      title: s.title,
      failed: true,
      stage: 'implement-result-unavailable',
      expected_notes_path: `${workspace}/notes/${s.id}.md`,
      failure_kind: 'requires-journal-classification',
    }
  }

  // An EVIDENCED infra-error buys exactly one cheap re-run, because "the toolchain fell over" is the
  // one failure a second attempt can genuinely resolve, and treating it as a defect stops dependent
  // waves over nothing. An UNEVIDENCED claim buys no agent at all — mirroring the review loop, where a
  // degraded claim buys no repair attempt: spawning work against a failure nobody named is how a
  // pipeline invents cost out of a free-to-set string.
  //
  // `attempts` is script-counted, never asked of the agent: two sources for one count is a
  // contradiction waiting to be reported. It reaches 2 as soon as the second attempt was PAID FOR —
  // an agent that came back empty still cost a spawn, and the first claim then stands unchanged.
  let attempts = 1
  const firstVerify = impl.verify_run || {}
  if (infraClaim(firstVerify)) {
    if (!infraShown(firstVerify)) {
      log(`step ${s.id} claimed infra-error without naming both the command and the failure it observed — no retry, the claim is judged on its own shape`)
    } else if (budget.total && budget.remaining() < 20000) {
      log(`token budget floor reached — not re-running step ${s.id}'s infrastructure failure`)
    } else {
      log(`step ${s.id} reported an infrastructure failure — one cheap re-run: ${firstVerify.output_summary || firstVerify.not_ran_reason || 'no summary given'}`)
      const retry = await runEnvRetry(() => agent(verifyRetryPrompt(s, firstVerify), {
        label: `verify:${s.id}`, phase: 'Implement', ...ROLE.verify, schema: IMPL_SCHEMA.properties.verify_run,
      }))
      attempts = 2
      if (retry) impl = { ...impl, verify_run: retry }
      else log(`step ${s.id}'s verification re-run agent was unavailable — keeping the first attempt's claim`)
    }
  }

  // A step that ran no check is not a failure (sometimes none is possible) but it is not verified
  // either — the earlier code let it pass as success silently, which made the pipeline's strongest
  // claim unenforceable. It travels to the reviewer and the report as unverified.
  //
  // `ran: true` is a CLAIM; `command` and `passed` are its evidence. Requiring only the boolean made
  // the gate defeatable by one free-to-set field: {ran: true} with nothing else counted as verified
  // AND as passing. Verified now means all three, so an unsubstantiated claim degrades to exactly
  // what it is worth — the same treatment as no check at all, minus the excuse.
  const verify = impl.verify_run || {}
  const verifyCommand = typeof verify.command === 'string' ? verify.command.trim() : ''
  const verifyFailed = verify.ran === true && verify.passed === false
  const unverified = !verifyFailed && !(verify.ran === true && verifyCommand && verify.passed === true)
  const unverifiedReason = !unverified ? null
    : verify.ran !== true ? (verify.not_ran_reason || 'no reason given')
    : !verifyCommand ? 'claimed ran=true without naming the command it ran'
    : 'claimed ran=true without reporting whether the check passed'
  if (unverified) log(`step ${s.id} has no substantiated verification: ${unverifiedReason}`)
  // >>> typed: verification status — one table, derived from the one above (tests/verify-gate.test.js)
  // Everything here is a function of the three lines above plus what the agent CLAIMED, and nothing
  // else, so the block can be lifted out and run on its own.
  //
  // `infra-error` is the one claim the reply's shape cannot reveal, so it is evidenced or it is not an
  // infra-error: the command tried AND the failure observed.
  const infraError = infraClaim(verify) && infraShown(verify)
  const status = infraError ? 'infra-error'
    // The degrade is gated on `verify.ran === true` ON PURPOSE. That is the shape where the escape
    // hatch would actually pay off — "it ran, it went red, but that was the toolchain" — so that is
    // where it is closed. An honest { ran: false, not_ran_reason: 'docker is not installed',
    // status: 'infra-error' } keeps its reason and stays not-run instead of becoming a run-stopping
    // failure. Do not "simplify" this conjunct away: without it the gate punishes the exact honesty
    // it is built on.
    : verifyFailed || (infraClaim(verify) && verify.ran === true) ? 'failed'
    : unverified ? 'not-run'
    : 'passed'
  const kind = typeof verify.kind === 'string' ? verify.kind.trim() : null
  // A refactor's evidence IS the already-green suite, so this stays VERIFIED and is only marked weak.
  // Degrading it to unverified is an explicit non-goal: it would make the one honest answer for a
  // refactor the most expensive one to give.
  const weakEvidence = status === 'passed' && kind === 'existing-suite'
  // <<< typed: verification status
  if (infraError) log(`step ${s.id} could not run its check for infrastructure reasons after ${attempts} attempt(s): ${verify.output_summary || verify.not_ran_reason || 'no summary given'}`)
  else if (infraClaim(verify) && status === 'failed') log(`step ${s.id} claimed infra-error while saying the check ran, and named no evidence — reading it as a failure`)
  if (weakEvidence) log(`step ${s.id} is verified only by a check that was already green (kind: existing-suite) — verified, but weak evidence, and the reviewer is told`)
  const blockingQuestions = (impl.needs_user_input || []).filter((q) => q && q.blocking)
  return {
    step: s.id, title: s.title, brief_path: brief.brief_path, impl,
    failed: status === 'failed', stage: status === 'failed' ? 'verify' : undefined,
    status, kind: kind || undefined, attempts,
    verify_command: verifyCommand || undefined,
    weak_evidence: weakEvidence || undefined,
    infra_error: infraError || undefined,
    // A COUNT, never a gate: `kind` fails open, so a pass that declared none is not weak evidence and
    // this must not touch `failed`, `unverified` or the checkpoint priority block. It is the new
    // field's calibration signal — without counting it there is no way to tell whether the prompt
    // landed or the field is silently dead.
    kind_missing: (status === 'passed' && !kind) || undefined,
    // An infra-error step is honestly unverified — it just is not a defect. Its reason is a THIRD,
    // distinct string, so the honest "no check was possible" and the unevidenced "claimed ran=true
    // without naming the command" stay the two calibration signals the register reads them as.
    //
    // Derived from `status`, not from the pre-typed `unverified` local above: that local doesn't know
    // about the unevidenced-infra-bluff path, where the typed layer degrades `status` to 'failed' but
    // the untyped table still saw a bare `ran=true` and called it unverified too. A step is either
    // failed or unverified, never both — `status` is the one field that already resolved that.
    unverified: status === 'not-run' || infraError,
    unverified_reason: infraError
      ? `the check could not run (infrastructure): ${verify.output_summary || verify.not_ran_reason || 'no summary given'}`
      : unverifiedReason,
    blocking_questions: blockingQuestions.length ? blockingQuestions : undefined,
  }
}

phase('Scout')
const stepsById = new Map(args.steps.map((s) => [s.id, s]))
const unknownCompleted = completed.filter((c) => !stepsById.has(c.id)).map((c) => c.id)
if (unknownCompleted.length) throw new Error(`args.completed names steps absent from args.steps: ${unknownCompleted.join(', ')}`)

// Work an earlier run implemented but no checkpoint ever reviewed. It is in the tree and nothing
// has judged it, so it rides along into this run's next checkpoint as a report with no agent behind
// it. Everything downstream (review scope, context paths, final check) treats it like any other.
const inheritedReports = completed
  .filter((c) => c.reviewed !== true)
  .map((c) => ({
    step: c.id,
    title: (stepsById.get(c.id) || {}).title || c.id,
    inherited: true,
    brief_path: c.brief_path,
    notes_paths: c.notes_paths || (c.notes_path ? [c.notes_path] : []),
    unverified: c.unverified === true,
    unverified_reason: c.unverified === true ? (c.unverified_reason || 'inherited unverified from an earlier run') : null,
    // Carried across the continuation boundary so a step that was only ever backed by an already-green
    // check keeps that mark into the checkpoint that finally reviews it.
    weak_evidence: c.weak_evidence === true || undefined,
    impl: {
      summary: 'implemented by an earlier run of this plan; carried into this run for review',
      changed_files: c.changed_files || (stepsById.get(c.id) || {}).files || [],
      notes_path: (c.notes_paths || [])[0] || c.notes_path,
      concerns: c.concerns || [],
      deviations: [],
    },
  }))

const reports = [...inheritedReports]
const checkpointReviews = []
const gateResults = []
const priorRefuted = []
function flat(rs) { return rs.flatMap((r) => (r.split ? flat(r.substeps) : [r])) }

function changedFilesOf(steps, stepReports) {
  const reported = flat(stepReports).flatMap((r) => (r.impl && r.impl.changed_files) || [])
  return [...new Set(reported.length ? reported : steps.flatMap((s) => s.files || []))]
}

// The executable check a checkpoint hands down to its review loop: the covered steps' own `verify`
// commands, deduplicated and joined with ' && '. The join is the wanted semantics — the shell
// short-circuits, so any failing command fails the whole check and the agent reports the first
// target that broke. Most plans give every step the same command, so the dedupe usually collapses
// this to one; the plan is what decides what "working" means here, not a guess at the repo's suite.
//
// Only TOP-LEVEL plan steps ever reach `pending.steps`, so a step that was split contributes its
// parent's `verify` and never its substeps' — a known limitation, not an oversight: substep objects
// are invented mid-run by a scout and live inside that step's report, out of the checkpoint's reach.
function verifyCommandFor(steps) {
  const commands = (steps || []).map((s) => (s && typeof s.verify === 'string' ? s.verify.trim() : '')).filter(Boolean)
  const unique = [...new Set(commands)]
  return unique.length ? unique.join(' && ') : null
}

// The gate is deliberately NOT a review: it answers one question — is the surface the pending steps
// are about to build on coherent? Anything else is cheaper to catch at the checkpoint review.
function gatePrompt(waveNumber, changed, dependents) {
  return `You are a contract gate between waves of a multi-step implementation. You are NOT a code reviewer — a full review of this code runs later, at less cost than finding the same defect twice.

Wave ${waveNumber} just landed these files:
${changed.map((f) => '- ' + f).join('\n')}
${args.baseline ? `\nInspect exactly what changed with "git diff ${args.baseline} -- <file>".\n` : ''}
Steps that must now build on it:
${dependents.map((s) => `- ${s.id}: ${s.goal}\n  files: ${(s.files || []).join(', ') || 'undeclared'}`).join('\n')}

Plan (for what the pending steps expect): "${planPath}"

## Your only question
Would a pending step — or an existing caller — hit a broken contract if work continued right now? Look at the consumable surface only: exported symbols and their signatures, types and schemas, registrations/wiring a pending step assumes exists, and contracts this wave changed under existing callers.

Ignore internal implementation quality, style, naming, test coverage, error-message wording, and any defect contained inside this wave's own files. Those are the checkpoint reviewer's job; reporting them here is a false positive and costs a full review round.

Severity high or critical means later work would be built on something wrong. Do NOT modify files. Return structured data only.`
}

async function gateWave(waveNumber, changed, dependents) {
  if (!gateEnabled || !dependents.length || !changed.length) return null
  if (budget.total && budget.remaining() < 30000) return null
  return metered('gate', () => agent(gatePrompt(waveNumber, changed, dependents), {
    label: `gate:wave-${waveNumber}`, phase: 'Gate', ...ROLE.gate, schema: GATE_SCHEMA,
  }))
}

async function reviewCheckpoint(pending, checkpointNumber) {
  if (args.review === false) return null
  const leaves = flat(pending.reports).filter((r) => r.impl)
  if (!leaves.length) return null
  if (budget.total && budget.remaining() < 40000) {
    log(`budget too low for checkpoint ${checkpointNumber} review — stopping without clean verdict`)
    return { clean: false, skipped_for_budget: true }
  }
  const changed = changedFilesOf(pending.steps, pending.reports)
  const contexts = [...new Set([planPath, ...leaves.flatMap((r) => [r.brief_path, ...(r.notes_paths || [r.impl.notes_path])]).filter(Boolean)])]
  const reviewLoopRef = args.reviewLoopPath ? { scriptPath: args.reviewLoopPath } : 'devkit:wf-review-loop'
  const waveLabel = pending.waves.length > 1 ? `waves ${pending.waves[0]}-${pending.waves[pending.waves.length - 1]}` : `wave ${pending.waves[0]}`
  // The implementers' own doubt is the cheapest review lead available: it points at code the author
  // could not convince themselves about. Same for steps no executable check covered.
  const selfReported = leaves.flatMap((r) => ((r.impl.concerns || []).map((c) => `- ${r.step}: ${c}`)))
  // A deviation is the plan the developer approved not being what landed. The implementer already
  // judged it worth doing and said why; nobody else has looked at it yet, and the reviewer is the only
  // one who sees it next to the code.
  const deviations = leaves.flatMap((r) => ((r.impl.deviations || [])
    .filter((d) => d && (d.what || d.why))
    .map((d) => `- ${r.step}: ${d.what || 'unstated'} — ${d.why || 'no reason given'}`)))
  const unverifiedSteps = leaves.filter((r) => r.unverified)
  const weakSteps = leaves.filter((r) => r.weak_evidence)
  const priority = [
    selfReported.length ? `The implementers flagged these as things they were unsure they got right — start here, then widen:\n${selfReported.join('\n')}` : '',
    deviations.length ? `These steps did NOT implement the plan as written — the implementer deviated and gave a reason. The plan is what the developer approved, so judge each one on its merits AND on whether anything else in this change still assumes the original:\n${deviations.join('\n')}` : '',
    unverifiedSteps.length ? `These steps have NO substantiated executable check — either none ran, or the implementer claimed one without naming the command or its result. Nothing but this review stands between them and the developer: judge their behavior, do not assume it works:\n${unverifiedSteps.map((r) => `- ${r.step} (${r.unverified_reason || 'no reason given'}): ${(r.impl.changed_files || []).join(', ')}`).join('\n')}` : '',
    weakSteps.length ? `These steps are verified only by a check that was ALREADY GREEN before them (kind: existing-suite). The command proves the step broke nothing and nothing more: if the step's goal was to ADD behavior, nothing here is evidence that it works — judge that behavior directly. A refactor is the case where an already-green check legitimately IS the evidence, so read the goal before you decide which one this is:\n${weakSteps.map((r) => `- ${r.step} (ran ${r.verify_command || 'no command reported'}): ${(r.impl.changed_files || []).join(', ')}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  return metered('review', () => workflow(reviewLoopRef, {
    scope: `Files changed in implementation ${waveLabel}: ${changed.join(', ')}`,
    intent: `Plan steps covered by this checkpoint (${waveLabel} of ${planPath}) — review them as one composed change, including how they fit together:\n${pending.steps.map((s) => `- ${s.id}: ${s.goal}\n  ${s.details || ''}`).join('\n')}`,
    contextPaths: contexts,
    priority: priority || undefined,
    // The rules matching what changed become an extra review lens: what this repo says about this
    // area, rather than a hardcoded guess at which domains deserve special scrutiny. The review loop
    // gets the raw definitions and the file list and matches them with the same code this file uses,
    // so there is one matcher for both entry points rather than one here and prose in /dev-review.
    rules: ruleDefs,
    files: changed,
    // Refutations from earlier checkpoints, so a later one does not re-litigate a defect that was
    // already investigated and dismissed with reasoning.
    priorRefuted: priorRefuted.length ? priorRefuted : undefined,
    baseline: args.baseline,
    apply: true,
    // This loop APPLIES fixes, so it also has to prove the tree still works afterwards — otherwise a
    // checkpoint can report every finding fixed over code that stopped building. The checkpoint is
    // where this belongs because it is the only place with both the fixes and the steps' own commands:
    // the cross-step consistency check is the run's only other executor, and a run that stops early
    // never reaches it (see the `stoppedEarly` guard below).
    verifyCommand: verifyCommandFor(pending.steps) || undefined,
    maxRounds: args.reviewRounds ?? 3,
    // The policy travels with the call: a cheap implement whose reviews run at full price is not
    // a cheap run. Role names are pipeline-wide, so review-loop reads the same object.
    profile: args.profile,
    models: args.models,
    efforts: args.efforts,
  }))
}

const todoSteps = pendingSteps(args.steps, completedIds)
if (!todoSteps.length) throw new Error('every step in args.steps is listed in args.completed — nothing left to implement')
if (completed.length) log(`continuing: ${completed.length} step(s) already implemented, ${todoSteps.length} to go`)

const allWaves = toWaves(todoSteps)
log(`${todoSteps.length} steps in ${allWaves.length} dependency wave(s)`)

// What this run WOULD do, from the same functions the run itself uses — never a second model of the
// schedule, which would be free to be wrong in exactly the way the real one is not.
//
// It is a projection, not a promise, and it errs in one direction only: checkpoints can fire
// EARLIER than shown, never later, because a blocking question or a gate break also forces one and
// neither is knowable before the agents run. Same for the agent floor.
function projectSchedule() {
  const out = []
  let pendingProjected = inheritedReports.map((r) => stepsById.get(r.step)).filter(Boolean)
  let pendingWaves = 0
  let checkpoints = 0
  let gates = 0
  let scouts = 0
  for (let i = 0; i < allWaves.length; i++) {
    const wave = allWaves[i]
    pendingWaves++
    pendingProjected = [...pendingProjected, ...wave]
    const accumulated = changedFilesOf(pendingProjected, [])
    const laterSteps = allWaves.slice(i + 1).flat()
    const waveScouts = wave.filter((s) => needsScout(s, 0)).map((s) => s.id)
    scouts += waveScouts.length
    // Mirrors the flush condition in the loop below, minus the two agent-dependent triggers.
    const reason = !laterSteps.length ? 'final wave'
      : wave.some((s) => s.risk === 'contract') ? 'contract-risk step'
      : accumulated.length >= checkpointFileThreshold ? `${accumulated.length} files pending`
      : pendingWaves >= checkpointMaxWaves ? `${pendingWaves} waves pending`
      : null
    const entry = {
      wave: i + 1,
      steps: wave.map((s) => s.id),
      // Only steps with declared disjoint files run together; everything else is serialized here,
      // which is the single most useful thing to see before approving a plan.
      parallel_groups: disjointBatches(wave).flatMap((b) => chunks(b, maxParallelSteps)).map((b) => b.map((s) => s.id)),
      scouts: waveScouts,
      rules: Object.fromEntries(wave.map((s) => [s.id, rulesFor(s.files || [])]).filter(([, r]) => r.length)),
    }
    if (reason) {
      checkpoints++
      // `verify_command` is what this checkpoint would hand its review loop as the post-fix check —
      // computed here, before `pendingProjected` is reset, from the same helper the real call site
      // uses. A plan whose steps declare no verify shows `null` and gets no check.
      entry.checkpoint = { number: checkpoints, reason, waves_covered: pendingWaves, files: accumulated.length, verify_command: verifyCommandFor(pendingProjected) }
      pendingWaves = 0
      pendingProjected = []
    } else {
      const dependents = laterSteps.filter((s) => (s.depends_on || []).some((d) => wave.some((w) => w.id === d)))
      const fires = gateEnabled && dependents.length > 0 && changedFilesOf(wave, []).length > 0
      if (fires) gates++
      entry.gate = fires ? { dependents: dependents.map((s) => s.id) } : null
    }
    out.push(entry)
  }

  const warnings = []
  if (allWaves.length >= 4 && allWaves.every((w) => w.length === 1)) {
    warnings.push(`${allWaves.length} waves of one step each: waves are the sequential spine, so this is the plan's wall-clock. Check every depends_on is a hard dependency, not reading order.`)
  }
  for (let i = 0; i < allWaves.length; i++) {
    for (const [a, b] of allWaves[i].flatMap((x, xi) => allWaves[i].slice(xi + 1).map((y) => [x, y]))) {
      // Same wave means no dependency between them, so an overlap is not a correctness bug — but it
      // silently costs the parallelism the plan looks like it has.
      if (!disjoint(a, b)) warnings.push(`wave ${i + 1}: ${a.id} and ${b.id} declare overlapping files and no dependency, so they run sequentially anyway`)
    }
  }
  for (const s of todoSteps) {
    if (!(s.files || []).length) warnings.push(`${s.id} declares no files: it can never run in parallel, and rule matching has nothing to match`)
    if (!s.verify) warnings.push(`${s.id} has no verify command: it can only ever come back unverified`)
  }
  // One command shared by several steps cannot be per-step evidence for each of them: whichever step
  // runs first makes it green, and every later step's "verified" is then a suite that was already
  // passing. Appended after the loops above so warnings[0] stays the chain warning.
  const byVerifyCommand = new Map()
  for (const s of todoSteps) {
    const command = typeof s.verify === 'string' ? s.verify.trim() : ''
    if (!command) continue
    if (!byVerifyCommand.has(command)) byVerifyCommand.set(command, [])
    byVerifyCommand.get(command).push(s.id)
  }
  for (const [command, ids] of byVerifyCommand) {
    // A lone step sharing a command with nobody is the normal case, not a lint.
    if (ids.length < 2) continue
    warnings.push(`${ids.join(', ')} declare the same verify command ("${command}"): one shared check cannot be per-step evidence for each of them — a step whose goal adds behavior comes back weak_evidence, since that command already passed before it.`)
  }

  // Coverage of the spec's acceptance criteria, free and before any agent runs. It reads
  // `args.steps` — the whole PLAN — and not `todoSteps`: a continuation strips the steps already
  // implemented, and reading those would report every criterion they cover as covered by nobody.
  const coveredBy = new Map()
  for (const s of args.steps) {
    const listed = (Array.isArray(s.covers) ? s.covers : [])
      .map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
    // Needs no spec to be wrong: one step covering a criterion twice is still one claim, so the
    // repeat only buys a second matrix row saying exactly what the first one said.
    const twice = [...new Set(listed.filter((id, i) => listed.indexOf(id) !== i))]
    if (twice.length) warnings.push(`${s.id} lists ${twice.join(', ')} twice in covers: one step covering a criterion twice is still one claim, and the repeat only adds a matrix row that says nothing new.`)
    for (const id of new Set(listed)) {
      if (!coveredBy.has(id)) coveredBy.set(id, [])
      coveredBy.get(id).push(s.id)
    }
  }
  // The other two checks need the canonical list. Without a spec there is no known-good set: every
  // id would be "unknown" and every criterion "uncovered", so a plan with no criteria must behave
  // exactly as it did before this lint existed.
  if (criteria.length) {
    const declared = new Map()
    for (const id of criteria) declared.set(id, (declared.get(id) || 0) + 1)
    for (const [id, n] of declared) {
      if (n < 2) continue
      warnings.push(`${id} is declared ${n} times in the criteria list: two criteria sharing one id cannot be told apart in the coverage matrix, so evidence for one reads as evidence for both.`)
    }
    for (const [id, ids] of coveredBy) {
      if (declared.has(id)) continue
      warnings.push(`${id} is covered by ${ids.join(', ')} but is in no criteria list: an id is an address into the spec, so that evidence attaches to nothing and whatever it was meant to cover stays uncovered.`)
    }
    // Two different steps covering one criterion is legal and stays silent — the synthesizer is
    // told criteria may be covered by more than one step.
    const uncovered = [...declared.keys()].filter((id) => !coveredBy.has(id))
    if (uncovered.length) warnings.push(`no step covers ${uncovered.join(', ')}: nothing in the plan claims to verify them, so those rows of the acceptance matrix stay empty — either a step declares the id, or the plan says in prose which suite-level check covers it.`)
  }

  return {
    waves: out,
    warnings,
    // A floor, and labelled as one: gates that find breaks, blocking questions and extra review
    // rounds all add agents, and nothing here removes any.
    agents_min: scouts + todoSteps.length + gates + checkpoints * 4 + 1,
    agents_min_note: 'floor: scouts + one implementer per step + gates + ~4 per review checkpoint + the final consistency check. Gate breaks, blocking questions, extra review rounds and the one cheap re-run an evidenced infra-error buys only add.',
  }
}

if (dryRun) return { ok: true, workflow: 'wf-implement', policy: ROLE, schedule: projectSchedule() }

let waveNumber = 0
let checkpointNumber = 0
let stoppedEarly = false
let stopReason = null
let pending = { waves: [], steps: [], reports: [] }
if (inheritedReports.length) {
  pending.steps.push(...inheritedReports.map((r) => stepsById.get(r.step)).filter(Boolean))
  pending.reports.push(...inheritedReports)
  log(`${inheritedReports.length} step(s) from the earlier run were never reviewed — folded into the next checkpoint`)
}

for (const wave of allWaves) {
  waveNumber++
  const waveReports = []
  for (const batch of disjointBatches(wave)) {
    for (const group of chunks(batch, maxParallelSteps)) {
      log(`steps ${group.map((s) => s.id).join(', ')}${group.length > 1 ? ' (parallel, disjoint files)' : ''}`)
      const rs = await metered('steps', () => parallel(group.map((s) => () => runStep(s, batch, 0, { briefPaths: [], notesPaths: [] }))))
      waveReports.push(...rs.filter(Boolean))
    }
  }
  reports.push(...waveReports)
  pending.waves.push(waveNumber)
  pending.steps.push(...wave)
  pending.reports.push(...waveReports)

  const blocked = flat(waveReports).filter((r) => r.failed || r.skipped_for_budget)
  if (blocked.length) {
    stopReason = blocked.map((r) => `${r.step}:${r.stage || 'budget'}`).join(', ')
    log(`stopping before dependent waves: ${stopReason}`)
    stoppedEarly = true
    break
  }

  // A blocking question means an implementer guessed at something that changes its step's approach.
  // Building dependent waves on that guess is the expensive mistake: review what landed, then stop
  // and let the developer answer. The workflow cannot ask mid-run, so stopping IS the interrupt.
  const blockingQuestions = flat(waveReports).flatMap((r) => (r.blocking_questions || []).map((q) => ({ step: r.step, ...q })))
  if (blockingQuestions.length) {
    log(`wave ${waveNumber} raised ${blockingQuestions.length} blocking question(s) — reviewing what landed, then stopping for the developer`)
  }

  // Checkpoint policy: waves are sequential because of depends_on, but paying a full review loop per
  // wave costs ~7-9 agents for what is often one small step. Accumulate until a review is worth it —
  // a wider scope also lets the reviewer see the composed change, which per-wave review cannot.
  const laterSteps = allWaves.slice(waveNumber).flat()
  const isLastWave = !laterSteps.length
  const accumulatedFiles = changedFilesOf(pending.steps, pending.reports)
  const riskyWave = wave.some((s) => s.risk === 'contract')
  let flush = isLastWave || riskyWave || blockingQuestions.length > 0 || accumulatedFiles.length >= checkpointFileThreshold || pending.waves.length >= checkpointMaxWaves
  let gate = null

  if (!flush) {
    const dependents = laterSteps.filter((s) => (s.depends_on || []).some((d) => wave.some((w) => w.id === d)))
    gate = await gateWave(waveNumber, changedFilesOf(wave, waveReports), dependents)
    if (gate) {
      const severe = (gate.breaks || []).filter((b) => b.severity === 'high' || b.severity === 'critical')
      gateResults.push({ wave: waveNumber, coherent: gate.coherent, breaks: gate.breaks || [] })
      if (severe.length) {
        log(`gate on wave ${waveNumber} found ${severe.length} contract break(s) — promoting to a review checkpoint now`)
        flush = true
      }
    }
    if (!flush) log(`wave ${waveNumber} deferred to the next review checkpoint (${accumulatedFiles.length} file(s) pending)`)
  }

  if (!flush) continue

  checkpointNumber++
  const review = await reviewCheckpoint(pending, checkpointNumber)
  const reason = isLastWave ? 'final wave' : blockingQuestions.length ? 'blocking question from an implementer' : riskyWave ? 'contract-risk step' : gate ? 'gate found a contract break' : accumulatedFiles.length >= checkpointFileThreshold ? `${accumulatedFiles.length} files pending` : `${pending.waves.length} waves pending`
  // Bound rather than pushed inline: this checkpoint's own verdict on its review is computed a few
  // lines below and is written onto THIS object. Deriving a second copy at the return would be free
  // to disagree with the decision the run actually acted on, over the same findings, and nothing
  // would catch that.
  const checkpointEntry = { checkpoint: checkpointNumber, waves: [...pending.waves], steps: pending.steps.map((s) => s.id), reason, review }
  checkpointReviews.push(checkpointEntry)
  const summary = review ? { clean: review.clean, rounds: review.rounds, confirmed: (review.confirmed || []).length, applied: (review.applied || []).length, skipped: (review.skipped || []).length } : null
  for (const report of flat(pending.reports)) report.review = summary
  for (const f of (review && review.refuted) || []) {
    priorRefuted.push({ title: f.title, file: f.file, line: f.line, why_refuted: f.reasoning })
  }

  const confirmedFindings = (review && review.confirmed) || []
  const appliedFindings = (review && review.applied) || []
  const skippedFindings = (review && review.skipped) || []

  // Findings are accounted for by IDENTITY, not by count. Two reasons the count is wrong:
  // an applier labels its entries sometimes with the finding's `id` and sometimes with its
  // `title`, and a finding deliberately skipped WITH A RECORDED REASON is accounted for —
  // not the same thing as one silently dropped. Counting conflates them and blocks a
  // checkpoint that actually resolved everything it found.
  const norm = (v) => String(v).trim().toLowerCase()
  const keysOf = (f) => [f && f.id, f && f.title, ...((f && f.merged_titles) || [])].filter(Boolean).map(norm)
  // CONSUMABLE 1:1, not set membership. `review.confirmed` is the union across every round, and
  // `title` is only ever described as "a short stable slug" — nothing makes it unique. Two
  // distinct findings that land on the same slug must not both be cleared by one fixer entry, so
  // an entry is claimed by the first finding that matches it and is then spent.
  const poolOf = (entries) => entries.map((e) => ({ keys: [e && e.id, e && e.title].filter(Boolean).map(norm), used: false }))
  const claim = (f, pool) => {
    const keys = keysOf(f)
    const entry = pool.find((e) => !e.used && e.keys.some((k) => keys.includes(k)))
    if (!entry) return false
    entry.used = true
    return true
  }
  const appliedPool = poolOf(appliedFindings)
  const skippedPool = poolOf(skippedFindings)
  // Applied wins over skipped for the same finding: a fix that landed is the stronger claim.
  const verdicts = confirmedFindings.map((f) => {
    const applied = claim(f, appliedPool)
    return { f, applied, accounted: applied || claim(f, skippedPool) }
  })
  const wasApplied = (f) => verdicts.find((v) => v.f === f)?.applied === true

  // If not a single finding matches by identity, the labels are too divergent to reason about.
  // Fail CLOSED — every finding counts as unaddressed. The old count comparison could reconcile
  // to zero here (applied+skipped >= confirmed) and silently unblock the checkpoint, which is the
  // exact failure this identity matching exists to prevent.
  const matchedAny = verdicts.some((v) => v.accounted)
  const unaddressed = matchedAny
    ? verdicts.filter((v) => !v.accounted).map((v) => v.f)
    : confirmedFindings
  // A high/critical finding has to be FIXED, not merely acknowledged: skipping one still
  // stops the run. Finding AND fixing one, however, is the system working — gating on the
  // mere presence of a severe finding means a thorough checkpoint can never pass.
  const unfixedSevere = confirmedFindings.filter(
    (f) => f && (f.severity === 'high' || f.severity === 'critical') && (matchedAny ? !wasApplied(f) : true),
  )
  // "Every finding was applied" and "the tree still works" are different claims, and only the second
  // one is about behavior. The review loop ran the covered steps' verify commands after applying its
  // fixes, so a check that did not clear stops the run — without this, the "continuing to dependent
  // waves" log below would print over code that no longer builds.
  //
  // This MIRRORS the loop's own gate (`wf-review-loop.js`: `ran === true && !clearsClean(fv)`), and it
  // has to: a claim to have run that named no command or no result is worth as much as no check, minus
  // the honesty — and it already cost the round its post-fix re-review, so treating it as "did not
  // fail" would feed dependent waves a tree that NOTHING judged. `ran !== true` is the honest
  // opt-out (`verifyCommand: false`, no command available, budget floor) and deliberately does not
  // block; that is what keeps the brief's AC-03 reachable.
  const fixVerify = (review && review.fix_verify) || null
  const checkRan = !!(fixVerify && fixVerify.ran === true)
  const checkCleared = !!(fixVerify && fixVerify.unverified !== true && fixVerify.passed === true)
  const checkFailed = checkRan && !checkCleared
  const checkVerdict = !checkRan ? 'did not run' : checkCleared ? 'passed' : fixVerify.failed === true ? 'FAILED' : 'UNPROVEN (claimed to run without substantiating a pass)'
  const reviewBlocked =
    args.review !== false &&
    (!review ||
      (review.clean !== true && (review.skipped_for_budget || unaddressed.length > 0 || unfixedSevere.length > 0 || checkFailed)))
  if (review && review.clean !== true && !reviewBlocked) {
    log(`checkpoint ${checkpointNumber} review not clean, but every confirmed finding was applied or skipped with a reason, no high/critical one was left unfixed and the post-fix check ${checkVerdict} — continuing to dependent waves`)
  }
  if (reviewBlocked && review && review.clean !== true) {
    log(`checkpoint ${checkpointNumber} blocked: ${unaddressed.length} unaddressed finding(s), ${unfixedSevere.length} unfixed high/critical, post-fix check ${checkVerdict}`)
  }
  // Persisted at the moment it was made. The identity matching above exists only here, so
  // `gates.review` at the return reads this decision rather than re-deriving it — and the counts
  // travel with it, because "blocked" without what blocked it is a verdict nobody can act on.
  checkpointEntry.unfixed_severe = unfixedSevere.length
  checkpointEntry.unaddressed = unaddressed.length
  checkpointEntry.check_failed = checkFailed
  checkpointEntry.blocked = reviewBlocked
  pending = { waves: [], steps: [], reports: [] }
  if (reviewBlocked || blockingQuestions.length) {
    const why = reviewBlocked ? `checkpoint-${checkpointNumber}:review-not-clean` : `blocking question(s) from ${[...new Set(blockingQuestions.map((q) => q.step))].join(', ')}`
    log(`stopping before dependent waves: ${why}`)
    stoppedEarly = true
    stopReason = why
    break
  }
}

// Waves implemented but never reviewed — only reachable when the run stopped early.
const unreviewedWaves = pending.waves

const leafReports = flat(reports)

// What a follow-up run needs in order to skip this one's work. Built here rather than left to the
// caller: the caller is a prose skill, and deriving this means walking split substeps back to the
// parent id the plan actually declares, then matching against which checkpoints covered what.
// Reported at PLAN-step granularity, because those are the ids `args.steps` contains.
//
// Computed here, before the coverage matrix and the final check — not further down, next to the
// verdict that used to be its only reader — because both of those need it too: the matrix has to
// credit a step this run never touched, and the stopped-early placeholder below has to know whether
// anything is actually left before it claims so.
const reviewedStepIds = new Set(checkpointReviews.filter((c) => c.review).flatMap((c) => c.steps))
function continuationEntry(r) {
  const leaves = flat([r])
  if (!leaves.length || leaves.some((x) => !x.impl || x.failed || x.skipped_for_budget)) return null
  const firstUnverified = leaves.find((x) => x.unverified)
  return {
    id: r.step,
    changed_files: [...new Set(leaves.flatMap((x) => (x.impl.changed_files) || []))],
    notes_paths: [...new Set(leaves.flatMap((x) => x.notes_paths || [x.impl.notes_path]).filter(Boolean))],
    brief_path: r.brief_path,
    unverified: Boolean(firstUnverified),
    unverified_reason: firstUnverified ? firstUnverified.unverified_reason || undefined : undefined,
    weak_evidence: leaves.some((x) => x.weak_evidence === true),
    reviewed: reviewedStepIds.has(r.step),
  }
}
// A step already done AND already reviewed by an EARLIER run never reaches `reports` at all —
// `inheritedReports` above deliberately drops `reviewed: true` entries, since nothing this run does
// should re-review them. That made it invisible to `reports.map(continuationEntry)`, which both
// re-listed a finished step as pending below AND, passed on verbatim as `continuation.completed`,
// dropped it from the NEXT run's `args.completed` — which reads as "go re-implement it". The original
// entry IS this run's evidence for that step, so it is carried forward unchanged instead.
const untouchedCompleted = completed.filter((c) => c.reviewed === true)
const completedEntries = [...untouchedCompleted, ...reports.map(continuationEntry).filter(Boolean)]
const completedEntryIds = new Set(completedEntries.map((c) => c.id))
// Named once and read twice — by `gates.scope` below and by `continuation.pending` in the return —
// so the two can never drift into disagreeing about what is left.
const pendingStepIds = args.steps.filter((s) => !completedEntryIds.has(s.id)).map((s) => s.id)

// ---- The acceptance-criterion coverage matrix.
// A criterion's status is DERIVED here and never self-reported: the id, the plan steps that declared
// they cover it, and the check each of those steps actually ran. Computed before the consistency
// check on purpose, so that checker can be TOLD which criteria no step covers instead of being asked
// to hunt for them in the plan's prose.
//
// Three inputs, and they are deliberately not the same array: `criteria` (the canonical ids, which
// only the caller can extract), `args.steps[].covers` (the whole PLAN, not `todoSteps` — a
// continuation strips the steps it already finished, and reading the trimmed list would report what
// they cover as covered by nobody), and `reports` — the TOP-LEVEL array, one entry per plan step id.
// NOT `leafReports`: that one has already walked into a split step's substeps, where `s2a` exists and
// the `s2` the plan declared `covers` on does not.
const declaredCovers = (s) => (Array.isArray(s.covers) ? s.covers : [])
  .map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
// A leaf folded in from `args.completed` carries `unverified`/`weak_evidence` and no `status` at all,
// so reading `status` alone would file an inherited pass as unverified.
const leafStatus = (x) => (x.failed ? 'failed' : x.status || (x.unverified ? 'not-run' : 'passed'))
// Steps an EARLIER run already completed and reviewed, indexed for the coverage join below: they
// never reach `reports` this run (see `untouchedCompleted` above), so their evidence has to be read
// off the completed entry itself or the join reads a finished step as `not-run`.
const untouchedById = new Map(untouchedCompleted.map((c) => [c.id, c]))
let coverage = null
if (criteria.length || args.steps.some((s) => declaredCovers(s).length)) {
  // Evidence per PLAN step, because that is the granularity `covers` is declared at: substeps are
  // invented mid-run by a scout and have no spec ids of their own, the same documented limitation
  // `verifyCommandFor` carries. A split step aggregates its own leaves through `flat([r])`, exactly
  // as continuationEntry() does above.
  const stepEvidence = new Map()
  for (const s of args.steps) {
    const r = reports.find((x) => x.step === s.id)
    const untouched = !r ? untouchedById.get(s.id) : null
    if (untouched) {
      // Same evidence shape an inherited leaf gets below (`command: null`, weak_evidence/unverified
      // read straight off the entry) — this step just never had a leaf here to read them from.
      const check = { step: s.id, command: null, status: untouched.unverified ? 'not-run' : 'passed', weak_evidence: untouched.weak_evidence === true }
      stepEvidence.set(s.id, { status: check.status, checks: [check] })
      continue
    }
    // A budget-skipped report carries no `impl`: nothing was implemented, so it is not evidence, and
    // a step whose only leaves are those reads the same as a step with no report at all. A leaf that
    // failed before implementation even ran (scout or impl agent unavailable) ALSO carries no `impl`,
    // but it is not silence — `leafStatus` already reads `.failed` before it reads `.status`, so kept
    // in, it renders as the `failed` check it is instead of vanishing into `not-run`.
    const leaves = r ? flat([r]).filter((x) => x.impl || x.failed) : []
    const checks = leaves.map((x) => ({
      step: x.step, command: x.verify_command || null, status: leafStatus(x), weak_evidence: x.weak_evidence === true,
    }))
    stepEvidence.set(s.id, {
      status: checks.some((c) => c.status === 'failed') ? 'failed'
        : !checks.length ? 'not-run'
        : checks.every((c) => c.status === 'passed') ? 'passed'
        : 'unverified',
      checks,
    })
  }
  const coveredBy = new Map()
  for (const s of args.steps) {
    for (const id of new Set(declaredCovers(s))) {
      if (!coveredBy.has(id)) coveredBy.set(id, [])
      coveredBy.get(id).push(s.id)
    }
  }
  // Deduplicated for the matrix only: the lint already reports a spec that declares one id twice, and
  // a second row would restate the first one word for word.
  const knownIds = [...new Set(criteria)]
  const rows = knownIds.map((id) => {
    const coveredByIds = coveredBy.get(id) || []
    const evidence = coveredByIds.map((sid) => stepEvidence.get(sid)).filter(Boolean)
    return {
      id,
      covered_by: coveredByIds,
      // Conservative on purpose: a criterion resting partly on a step nothing substantiated is not
      // proven, so only an all-passed set reads `passed`.
      status: !coveredByIds.length ? 'uncovered'
        : evidence.some((e) => e.status === 'failed') ? 'failed'
        : evidence.every((e) => e.status === 'passed') ? 'passed'
        : 'unverified',
      checks: evidence.flatMap((e) => e.checks),
    }
  })
  coverage = {
    criteria: rows,
    uncovered: rows.filter((c) => c.status === 'uncovered').map((c) => c.id),
    // An id a step claims that the spec never declared. It addresses nothing, so it gets no row of
    // its own — only this list, which is what keeps that evidence from looking attached to something.
    unknown: [...coveredBy.entries()].filter(([id]) => !knownIds.includes(id)).map(([id, steps]) => ({ id, steps })),
  }
}

// Composed here rather than inside the prompt below: that prompt is one big template literal, and a
// nested one inside it would need every backtick escaped for the same string either way.
const uncoveredNote = coverage && coverage.uncovered.length
  ? `\n\nNo step in this plan claims to cover these acceptance criteria: ${coverage.uncovered.join(', ')}. The suite you are about to run is the only thing left that could cover them: check whether it actually exercises each one, and raise an issue for the ones it does not rather than reporting a clean composition.`
  : ''

// ---- Cross-step consistency check
let finalCheck = null
if (!stoppedEarly) {
  phase('Check')
  finalCheck = await metered('check', () => agent(
    `You are the final consistency checker for a multi-step implementation.

Plan: "${planPath}" (read it). Workspace: "${workspace}" — per-step briefs in briefs/, implementer notes in notes/.

Step reports (compact; read the notes/ files where detail matters):
${JSON.stringify(leafReports.map((r) => ({ step: r.step, title: r.title, failed: r.failed || false, skipped_for_budget: r.skipped_for_budget || false, summary: r.impl && r.impl.summary, changed_files: r.impl && r.impl.changed_files, deviations: r.impl && r.impl.deviations, concerns: r.impl && r.impl.concerns, verify_run: r.impl && r.impl.verify_run, status: r.status, kind: r.kind, attempts: r.attempts, weak_evidence: r.weak_evidence || false, unverified: r.unverified || false, unverified_reason: r.unverified_reason || undefined, review_clean: r.review && r.review.clean })), null, 2)}

Steps marked \`unverified\` have no substantiated executable check of their own — either none ran, or one was claimed without a command or a pass/fail result. Their behavior rests entirely on the suite you are about to run and on the checkpoint reviews — if the suite does not actually exercise them, say so in an issue rather than reporting a clean composition. Open \`concerns\` the reviews did not resolve are also yours to settle or escalate.

Steps marked \`weak_evidence\` passed a check that was already green BEFORE them (\`kind: existing-suite\`), so their command proves they broke nothing and nothing more: where such a step's goal was to add behavior, the suite you run is the first thing that could exercise it — check that it does, and raise an issue if it does not. Steps with \`status: "infra-error"\` never had their check run at all (the toolchain, not the code, failed, and one re-run did not clear it); nothing has executed them, so whatever you can establish about them here is all the evidence that exists.

Steps were implemented by separate agents, possibly in parallel. Check the SEAMS between them: do the pieces actually compose — imports/exports, function signatures vs call sites, naming consistency, duplicated helpers that should be one, config/registration each step assumed another would do, plan requirements no step ended up covering. Per-step verify_run covered steps individually, not the composition: run the repo's build/typecheck/test suite if available and report it in suite_run.${uncoveredNote}

Small integration fixes (a rename, a missing import/registration, deduplicating an identical helper): apply directly and list them. Anything structural or judgment-dependent: report as an issue, don't fix.

Keep the suite output out of your report — a compact observed result in suite_run is what is wanted, not logs.

Return the structured report.`,
    { label: 'consistency-check', ...ROLE.check, schema: CHECK_SCHEMA },
  ))
  if (!finalCheck) {
    // Mirrors the impl-agent-unavailable path in `runStep`: an unavailable agent here is not a
    // downgrade, it is a blocked run. This is the one agent that checks how the steps COMPOSE, and
    // nothing else in the workflow re-runs that check — a silent null would let a run whose every
    // step passed individually read as `ready-with-unverified` when in truth nothing verified the
    // seams between them, or ran a suite, at all.
    finalCheck = {
      consistent: false,
      issues: [{ description: 'The consistency-check agent was unavailable — nothing verified how the steps compose or ran the suite.', severity: 'critical', fixed: false }],
      suite_run: { ran: false, passed: false, output_summary: 'The consistency-check agent was unavailable, so no suite ran.' },
    }
  }
} else {
  // Not every `stoppedEarly` trigger means work is actually left: a checkpoint that blocked ON the
  // last wave, or a blocking question raised there, stops the run with every wave already implemented
  // AND reviewed — `unreviewedWaves` and `pendingStepIds` (computed above, before this block on
  // purpose) are both empty in that shape. Leading with "stopped before all waves completed" over
  // that is a false claim about leftover implementation work, when the actionable problem already
  // lives in `gates.review` or `gates.questions` and does not need this placeholder to repeat it,
  // wrongly, as a claim this script cannot back with a step id.
  const incompleteWork = unreviewedWaves.length > 0 || pendingStepIds.length > 0
  finalCheck = {
    consistent: false,
    issues: incompleteWork
      ? [{ description: 'Implementation stopped before all dependency waves completed.', severity: 'high', fixed: false }]
      // Medium, not high: nothing here is an unfixed defect the review layer missed — `gates.review`
      // and `gates.questions` already carry whatever actually stopped the run — so this must not add
      // its own severe issue on top of theirs for the one true fact it does state: no suite ran.
      : [{ description: `Implementation stopped after every wave was implemented and reviewed (${stopReason || 'see checkpointReviews'}) — nothing here ran the cross-step consistency check.`, severity: 'medium', fixed: false }],
    // NOT a result: nothing ran, and nothing here judged anything. The run stopped before the
    // consistency check, which is the only agent in this workflow that executes a suite — so this
    // field is a placeholder the script fabricated, and stating it as an outcome would contradict the
    // real one. /dev-implement runs the repository's own documented check in its main loop before it
    // reports a stopped run, and THAT result is the one to state.
    suite_run: { ran: false, passed: false, output_summary: 'No suite was run and nothing here executed anything: the workflow stopped before the consistency check. This field is a placeholder with nothing behind it — /dev-implement runs the repository suite in the main loop and reports that result instead.' },
  }
  if (unreviewedWaves.length) {
    finalCheck.issues.push({ description: `Wave(s) ${unreviewedWaves.join(', ')} were implemented but never reached a review checkpoint.`, severity: 'high', fixed: false })
  }
}

// Blocking questions first: they are why the run stopped, and answering them may invalidate work.
const needsInput = []
for (const r of leafReports) {
  for (const q of (r.impl && r.impl.needs_user_input) || []) {
    needsInput.push({ step: r.step, question: q.question, blocking: q.blocking === true, assumption: q.assumption })
  }
}
if (finalCheck && finalCheck.needs_user_input) needsInput.push(...finalCheck.needs_user_input.map((q) => ({ step: 'final-check', question: q, blocking: false })))
needsInput.sort((a, b) => Number(b.blocking) - Number(a.blocking))

const unverifiedSteps = leafReports
  .filter((r) => r.unverified)
  .map((r) => ({ step: r.step, reason: r.unverified_reason || null, changed_files: r.impl.changed_files || [] }))
// Verified, and deliberately still verified — but only by a command that was already green before the
// step ran. Reported separately so a developer can see the difference between "a test proves this" and
// "nothing broke", which the boolean alone flattens.
const weakEvidenceSteps = leafReports
  .filter((r) => r.weak_evidence)
  .map((r) => ({ step: r.step, command: r.verify_command || null, changed_files: (r.impl && r.impl.changed_files) || [] }))
// Not defects: the check could not run for reasons unrelated to the code, and it was retried once.
// They did not stop dependent waves, and they are unverified all the same.
const infraErrors = leafReports
  .filter((r) => r.infra_error)
  .map((r) => ({ step: r.step, command: r.verify_command || null, reason: r.unverified_reason || null, attempts: r.attempts || 1 }))
// The calibration signal for `kind`, which fails open: passes that declared none. Ids rather than a
// count, so the report can name them; expected to trend to zero, and never a gate.
const kindMissing = leafReports.filter((r) => r.kind_missing).map((r) => r.step)
const openConcerns = leafReports.flatMap((r) => ((r.impl && r.impl.concerns) || []).map((c) => ({ step: r.step, concern: c })))

// ---- The delivery verdict: five gates, one word, and the evidence behind each one.
// A pure function of structured outputs this run already produced. No agent decides it and none is
// spawned for it — which is the only reason the word can be read as a fact about the run instead of
// as a summary somebody wrote. The gate vocabularies are deliberately NOT drift-tracked (nothing
// branches on a gate label); only this one is, which is why it is a literal a test can extract.
const DELIVERY_VERDICTS = ['ready', 'ready-with-unverified', 'blocked']
const [READY, READY_WITH_UNVERIFIED, BLOCKED] = DELIVERY_VERDICTS
const suiteRun = (finalCheck && finalCheck.suite_run) || null
// Same discipline as `verify_run` above (lines 627-634, `unverified`/`verifyFailed`): `ran: true` is
// a CLAIM, `command` and `passed` are its evidence. Requiring only the boolean would make this the
// one place composition-level checking still hands out a substantiated pass for one free-to-set
// field — a consistency-check reply of exactly `{suite_run: {ran: true}}`, no command, no passed.
const suiteCommand = typeof (suiteRun && suiteRun.command) === 'string' ? suiteRun.command.trim() : ''
// A claimed failure needs no evidence bar: nobody games a check by claiming it went red, so
// `passed === false` is trusted on `ran === true` alone, exactly like `verifyFailed` above.
const suiteFailed = !!(suiteRun && suiteRun.ran === true && suiteRun.passed === false)
const suitePassed = !!(suiteRun && suiteRun.ran === true && suiteCommand && suiteRun.passed === true)
const unfixedSevereIssues = ((finalCheck && finalCheck.issues) || [])
  .filter((i) => i && (i.severity === 'high' || i.severity === 'critical') && i.fixed !== true)
const blockedCheckpoints = checkpointReviews.filter((c) => c.blocked === true)
// `.failed === true` catches a leaf that never reached `status` at all — the scout/impl-unavailable
// early returns in `runStep` set only `.failed`, matching the convention `blocked` above already
// reads at line 999 — so a step that failed to even get implemented still reads `failed` here rather
// than falling through as if nothing ran.
const failedSteps = leafReports.filter((r) => r.failed === true || r.status === 'failed').map((r) => r.step)
const unverifiedNames = [...new Set([...unverifiedSteps.map((u) => u.step), ...infraErrors.map((e) => e.step)])]
const gates = {
  // Read off `coverage` rather than re-derived: one join, one answer. `uncovered` and `unverified`
  // do not block — a suite-level check is a legitimate cover, and the matrix shows which rows rest
  // on one.
  acceptance: !coverage ? 'n/a'
    : coverage.criteria.some((c) => c.status === 'failed') ? 'failed'
    : coverage.criteria.length && coverage.criteria.every((c) => c.status === 'passed') ? 'passed'
    : coverage.uncovered.length ? 'uncovered'
    : 'unverified',
  // `weakEvidenceSteps` is deliberately not read here: a check that was already green is still a
  // check, the matrix row carries the mark, and the report counts them separately. A run that
  // stopped early lands on `not-run` for free — the placeholder above sets `suite_run.ran` false. A
  // bare `{ran: true}` with no command and no substantiated pass reads the same way, for the reason
  // `suitePassed` above states: it is not evidence, so it is worth exactly what no result is worth.
  tests: failedSteps.length || suiteFailed ? 'failed'
    : !suitePassed ? 'not-run'
    : unverifiedSteps.length || infraErrors.length ? 'unverified'
    : 'passed',
  // TWO sources, and both are load-bearing: the checkpoint's own decision (persisted onto the entry
  // at the moment it was made) and the consistency check, which runs AFTER the last checkpoint and is
  // never re-checked against it. `blocked` is tested before `not-run` on purpose — a stopped run whose
  // waves or steps are genuinely incomplete carries a fabricated unfixed-high issue of its own (the
  // `stoppedEarly` branch above), and "nothing reviewed this" is not the honest label for a run that
  // stopped because something did. The one shape where that placeholder does NOT also carry a severe
  // issue is a checkpoint blocked on an otherwise fully-implemented, fully-reviewed last wave — there
  // `blockedCheckpoints` is the only source left saying so, which is why it is read at all rather than
  // trusting the placeholder alone.
  review: blockedCheckpoints.length || unfixedSevereIssues.length ? 'blocked'
    : args.review === false || !checkpointReviews.some((c) => c.review) ? 'not-run'
    : 'clean',
  // `open` is informational: the question was asked and a reversible assumption recorded.
  questions: needsInput.some((q) => q.blocking === true) ? 'blocking'
    : needsInput.length ? 'open'
    : 'none',
  // Where a budget stop and an unreviewed dependency wave both land — read off `unreviewedWaves` and
  // `pendingStepIds` themselves, never off `stoppedEarly` alone: a checkpoint blocked on the last
  // wave, or a blocking question raised there, also stops the run, with every wave already
  // implemented AND reviewed. `stoppedEarly` cannot tell that shape apart from a genuinely unfinished
  // run — only the two derived sets can — and gates.review / gates.questions already carry that
  // shape's real reason, so `scope` staying `within-plan` there is not a missed block, it is the
  // honest answer to the one question this gate asks.
  //
  // The design named a SIXTH blocked trigger for this gate — a stale plan — and it is deliberately
  // not implemented rather than stubbed: nothing in this script's reach represents plan staleness
  // (no filesystem, no git, no clock), so the branch would have nothing behind it. IDEAS.md #13
  // (the plan-freshness gate) would ship `planned_at_sha`, which is the field that makes it
  // computable, and this expression is where its branch goes. docs/architecture.md carries the full
  // statement — do not invent an argument no caller passes in the meantime.
  scope: unreviewedWaves.length || pendingStepIds.length ? 'incomplete' : 'within-plan',
}
const blocking = gates.acceptance === 'failed' || gates.tests === 'failed'
  || gates.review === 'blocked' || gates.questions === 'blocking' || gates.scope === 'incomplete'
const delivery_verdict = blocking ? BLOCKED
  : (gates.acceptance === 'passed' || gates.acceptance === 'n/a') && gates.tests === 'passed'
    && gates.review === 'clean' && (gates.questions === 'none' || gates.questions === 'open')
    && gates.scope === 'within-plan' ? READY
  : READY_WITH_UNVERIFIED
// Exactly [] when the verdict is `ready` — which is not the same as "when nothing blocks". `ready`
// tolerates an open, non-blocking question, so a per-gate loop run unconditionally would print a
// reason line under a verdict that has nothing left to explain.
const reasons = []
if (delivery_verdict !== READY) {
  if (gates.acceptance !== 'passed' && gates.acceptance !== 'n/a') {
    const named = (gates.acceptance === 'uncovered' ? coverage.uncovered
      : coverage.criteria.filter((c) => c.status === gates.acceptance).map((c) => c.id)).join(', ')
    reasons.push(gates.acceptance === 'failed' ? `acceptance: a step covering ${named} failed its check`
      : gates.acceptance === 'uncovered' ? `acceptance: ${named} covered by no step`
      : `acceptance: no executed check substantiates ${named || 'any criterion this plan declares'}`)
  }
  if (gates.tests !== 'passed') {
    reasons.push(gates.tests === 'failed'
      ? `tests: ${[failedSteps.length ? `${failedSteps.join(', ')} failed the check it ran` : '',
        suiteFailed ? 'the final suite ran and did not pass' : ''].filter(Boolean).join('; ')}`
      : gates.tests === 'not-run'
      ? `tests: no suite result — ${stoppedEarly ? `the run stopped before the consistency check (${stopReason})` : 'the consistency check reported that it ran none'}`
      : `tests: the suite passed, but ${unverifiedNames.length} step(s) carry no substantiated check of their own (${unverifiedNames.join(', ')})`)
  }
  if (gates.review !== 'clean') {
    reasons.push(gates.review === 'blocked'
      ? `review: ${[blockedCheckpoints.length ? `checkpoint ${blockedCheckpoints.map((c) => c.checkpoint).join(', ')} blocked the run` : '',
        unfixedSevereIssues.length ? `${unfixedSevereIssues.length} unfixed high/critical issue(s) from the consistency check` : ''].filter(Boolean).join('; ')}`
      : `review: ${args.review === false ? 'review was disabled for this run' : 'no checkpoint produced a review'}`)
  }
  if (gates.questions !== 'none') {
    const asked = needsInput.filter((q) => gates.questions !== 'blocking' || q.blocking === true)
    reasons.push(`questions: ${asked.length} ${gates.questions} question(s) from ${[...new Set(asked.map((q) => q.step))].join(', ')}`)
  }
  if (gates.scope !== 'within-plan') {
    // `stoppedEarly` is read for the reason it stopped, never for whether to block — the gate above
    // already established that (`unreviewedWaves`/`pendingStepIds`), and this branch only runs when
    // one of them is actually non-empty, which — the loop only breaks early on a genuine stop — makes
    // `stoppedEarly` true here too. Named anyway, defensively, rather than assumed.
    reasons.push(`scope: ${[stoppedEarly ? `the run stopped (${stopReason})` : '',
      unreviewedWaves.length ? `wave(s) ${unreviewedWaves.join(', ')} were implemented but never reviewed` : '',
      pendingStepIds.length ? `${pendingStepIds.join(', ')} did not complete` : ''].filter(Boolean).join('; ')}`)
  }
}

return {
  workspace,
  planPath,
  waves: allWaves.map((w) => w.map((s) => s.id)),
  reports,
  checkpointReviews,
  contractGates: gateResults,
  unreviewedWaves,
  unverifiedSteps,
  weakEvidenceSteps,
  infraErrors,
  kindMissing,
  concerns: openConcerns,
  finalCheck,
  // The run's own verdict on itself, computed above from everything already in this object.
  delivery_verdict,
  gates,
  reasons,
  coverage,
  stoppedEarly,
  stopReason,
  needs_user_input: needsInput,
  // `steps` covers scouting AND implementation: the steps in a wave run concurrently, so their
  // agents interleave and no delta can attribute tokens to one or the other. `review` is the whole
  // nested review loop, which reports its own breakdown separately.
  cost: costReport(),
  // Pass `completed` straight back with the SAME `steps` to continue; fold any answers into `notes`.
  continuation: {
    completed: completedEntries,
    pending: pendingStepIds,
  },
}
