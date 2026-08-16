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
//         gate?=true, checkpointFileThreshold?=20, checkpointMaxWaves?=3, rules?,
//         profile?, models?, efforts?, dryRun? }
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
})

if (args && args.dryRun) return { ok: true, workflow: 'wf-implement', policy: ROLE }
if (!args || !args.workspace) throw new Error('args.workspace is required: absolute path to the task workspace')
if (!args.steps || !args.steps.length) throw new Error('args.steps is required: the machine-readable steps from the plan')

const workspace = args.workspace.replace(/\/+$/, '')
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

  const impl = await agent(implPrompt(s, brief, batch, ctx), { label: `impl:${s.id}`, phase: 'Implement', ...ROLE.impl, schema: IMPL_SCHEMA })
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
  const blockingQuestions = (impl.needs_user_input || []).filter((q) => q && q.blocking)
  return {
    step: s.id, title: s.title, brief_path: brief.brief_path, impl,
    failed: verifyFailed, stage: verifyFailed ? 'verify' : undefined,
    unverified, unverified_reason: unverifiedReason,
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
  return agent(gatePrompt(waveNumber, changed, dependents), {
    label: `gate:wave-${waveNumber}`, phase: 'Gate', ...ROLE.gate, schema: GATE_SCHEMA,
  })
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
  const unverifiedSteps = leaves.filter((r) => r.unverified)
  const priority = [
    selfReported.length ? `The implementers flagged these as things they were unsure they got right — start here, then widen:\n${selfReported.join('\n')}` : '',
    unverifiedSteps.length ? `These steps have NO substantiated executable check — either none ran, or the implementer claimed one without naming the command or its result. Nothing but this review stands between them and the developer: judge their behavior, do not assume it works:\n${unverifiedSteps.map((r) => `- ${r.step} (${r.unverified_reason || 'no reason given'}): ${(r.impl.changed_files || []).join(', ')}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  return workflow(reviewLoopRef, {
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
    maxRounds: args.reviewRounds ?? 3,
    // The policy travels with the call: a cheap implement whose reviews run at full price is not
    // a cheap run. Role names are pipeline-wide, so review-loop reads the same object.
    profile: args.profile,
    models: args.models,
    efforts: args.efforts,
  })
}

const todoSteps = pendingSteps(args.steps, completedIds)
if (!todoSteps.length) throw new Error('every step in args.steps is listed in args.completed — nothing left to implement')
if (completed.length) log(`continuing: ${completed.length} step(s) already implemented, ${todoSteps.length} to go`)

const allWaves = toWaves(todoSteps)
log(`${todoSteps.length} steps in ${allWaves.length} dependency wave(s)`)
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
      const rs = await parallel(group.map((s) => () => runStep(s, batch, 0, { briefPaths: [], notesPaths: [] })))
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
  checkpointReviews.push({ checkpoint: checkpointNumber, waves: [...pending.waves], steps: pending.steps.map((s) => s.id), reason, review })
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
  const reviewBlocked =
    args.review !== false &&
    (!review ||
      (review.clean !== true && (review.skipped_for_budget || unaddressed.length > 0 || unfixedSevere.length > 0)))
  if (review && review.clean !== true && !reviewBlocked) {
    log(`checkpoint ${checkpointNumber} review not clean, but every confirmed finding was applied or skipped with a reason and no high/critical one was left unfixed — continuing to dependent waves`)
  }
  if (reviewBlocked && review && review.clean !== true) {
    log(`checkpoint ${checkpointNumber} blocked: ${unaddressed.length} unaddressed finding(s), ${unfixedSevere.length} unfixed high/critical`)
  }
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

// ---- Cross-step consistency check
let finalCheck = null
if (!stoppedEarly) {
  phase('Check')
  finalCheck = await agent(
    `You are the final consistency checker for a multi-step implementation.

Plan: "${planPath}" (read it). Workspace: "${workspace}" — per-step briefs in briefs/, implementer notes in notes/.

Step reports (compact; read the notes/ files where detail matters):
${JSON.stringify(leafReports.map((r) => ({ step: r.step, title: r.title, failed: r.failed || false, skipped_for_budget: r.skipped_for_budget || false, summary: r.impl && r.impl.summary, changed_files: r.impl && r.impl.changed_files, deviations: r.impl && r.impl.deviations, concerns: r.impl && r.impl.concerns, verify_run: r.impl && r.impl.verify_run, unverified: r.unverified || false, unverified_reason: r.unverified_reason || undefined, review_clean: r.review && r.review.clean })), null, 2)}

Steps marked \`unverified\` have no substantiated executable check of their own — either none ran, or one was claimed without a command or a pass/fail result. Their behavior rests entirely on the suite you are about to run and on the checkpoint reviews — if the suite does not actually exercise them, say so in an issue rather than reporting a clean composition. Open \`concerns\` the reviews did not resolve are also yours to settle or escalate.

Steps were implemented by separate agents, possibly in parallel. Check the SEAMS between them: do the pieces actually compose — imports/exports, function signatures vs call sites, naming consistency, duplicated helpers that should be one, config/registration each step assumed another would do, plan requirements (and spec acceptance criteria, if the plan references a spec) no step ended up covering. Per-step verify_run covered steps individually, not the composition: run the repo's build/typecheck/test suite if available and report it in suite_run.

Small integration fixes (a rename, a missing import/registration, deduplicating an identical helper): apply directly and list them. Anything structural or judgment-dependent: report as an issue, don't fix.

Keep the suite output out of your report — a compact observed result in suite_run is what is wanted, not logs.

Return the structured report.`,
    { label: 'consistency-check', ...ROLE.check, schema: CHECK_SCHEMA },
  )
} else {
  finalCheck = {
    consistent: false,
    issues: [{ description: 'Implementation stopped before all dependency waves completed.', severity: 'high', fixed: false }],
    suite_run: { ran: false, passed: false, output_summary: 'Skipped because implementation or review did not reach a clean checkpoint.' },
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
const openConcerns = leafReports.flatMap((r) => ((r.impl && r.impl.concerns) || []).map((c) => ({ step: r.step, concern: c })))

// What a follow-up run needs in order to skip this one's work. Built here rather than left to the
// caller: the caller is a prose skill, and deriving this means walking split substeps back to the
// parent id the plan actually declares, then matching against which checkpoints covered what.
// Reported at PLAN-step granularity, because those are the ids `args.steps` contains.
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
    reviewed: reviewedStepIds.has(r.step),
  }
}
const completedEntries = reports.map(continuationEntry).filter(Boolean)
const completedEntryIds = new Set(completedEntries.map((c) => c.id))

return {
  workspace,
  planPath,
  waves: allWaves.map((w) => w.map((s) => s.id)),
  reports,
  checkpointReviews,
  contractGates: gateResults,
  unreviewedWaves,
  unverifiedSteps,
  concerns: openConcerns,
  finalCheck,
  stoppedEarly,
  stopReason,
  needs_user_input: needsInput,
  // Pass `completed` straight back with the SAME `steps` to continue; fold any answers into `notes`.
  continuation: {
    completed: completedEntries,
    pending: args.steps.filter((s) => !completedEntryIds.has(s.id)).map((s) => s.id),
  },
}
