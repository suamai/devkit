export const meta = {
  name: 'wf-review-loop',
  description: 'Loop until clean: two complementary reviewers → semantic clustering + batched verification → apply confirmed fixes → explicit re-review',
  whenToUse: 'Validate implemented code changes. Reusable standalone (via /dev-review) or called from the wf-implement workflow via workflow()',
  phases: [
    { title: 'Review', detail: 'two complementary lenses over the change; later rounds re-review only what the fixes touched' },
    { title: 'Verify', detail: 'cluster and verify all findings in one batch; critical findings get one second opinion' },
    { title: 'Fix', detail: 'apply confirmed fixes; critical defects escalate one model tier' },
    { title: 'Check', detail: "run the repo's own executable check on the fixed tree; a failed check buys one bounded repair attempt, itself re-reviewed" },
  ],
}

// args: { scope, intent?, baseline?, root?, contextPaths?, priority?, rules?, priorRefuted?,
//         apply?=true, maxRounds?=3, lenses?, ruleLens?=true, verifyCommand?, fixModel?, files?,
//         seedFindings?, profile?, models?, efforts?, dryRun? }
//   scope:        what to review — files/paths/diff description. Reviewers only look here.
//   intent:       what the change was supposed to accomplish (plan step, spec criteria).
//   baseline:     git SHA before the change — reviewers judge the DIFF since it, not whole files.
//   root:         absolute path to the tree these agents run their commands in — the flow's git
//                 worktree when wf-implement was called with an isolated root. Omit it and every
//                 prompt is byte-identical to a review of the primary checkout; `contextPaths` are
//                 absolute and stay OUTSIDE it either way.
//   contextPaths: workspace files with background (step brief, implementer notes) — hints, not truth.
//   priority:     where to look FIRST inside the scope (author-flagged doubts, unverified steps).
//                 A head start, never a scope restriction.
//   rules:        [{path, globs}] from scripts/rules-manifest.sh — the repo's path-scoped rule
//                 files. Matched here against `files`; the ones that apply add one extra
//                 "repo-conventions" lens, APPENDED to whatever `lenses` resolves to.
//   ruleLens:     false suppresses that appended lens even when rules match (so does `rules: []`).
//   files:        the concrete paths under review. `scope` is prose for the reviewers; this is the
//                 machine-readable list, and rule matching needs it.
//   priorRefuted: findings dismissed by an earlier review of the same run, with their reasoning —
//                 so this one does not re-investigate them from scratch.
//   seedFindings: findings that are already found AND already adversarially verified — the
//                 `confirmed` array of a persisted /dev-pr --review report. Round 1 then goes
//                 straight to the fixer: re-finding them risks MISSING one, which would silently
//                 drop a confirmed defect. The caller must have proved HEAD still equals the
//                 report's reviewed_head; without that the findings describe code that no longer
//                 exists. The post-fix re-review is unchanged, so `clean` still means a pass found
//                 nothing.
//   verifyCommand: the repo's own executable check (e.g. "sh tests/run-all.sh"). After a round
//                 APPLIES fixes, one agent runs it and reports the result; this script has no shell,
//                 so that claim is classified here exactly as wf-implement classifies an
//                 implementer's `verify_run`. `false` opts out entirely; omitting it is the same
//                 thing, said less explicitly.
//
// returns: { rounds, clean, raw, clustered, confirmed, refuted, applied, skipped, fix_verify?,
//            repairs?, cost }
//   raw:          how many findings the reviewers reported before clustering, summed over rounds.
//   clustered:    how many semantic clusters the verifier returned for them, same summation. The
//                 pair is the clustering ratio a calibration reader wants; both are ALWAYS present
//                 (0 when the loop broke before a round produced findings — 0 is the truth, not a
//                 missing field). On the seeded path they are equal by construction, so such a run
//                 honestly reports a ratio of 1.0: no clustering happened.
//   fix_verify:   the classified post-fix check — {ran, command, passed, output_summary,
//                 not_ran_reason, failed, unverified, attempts, repaired?}. ABSENT when no fix round
//                 ran (including the very common "round 1 found nothing" exit) and never present
//                 under apply:false, where nothing was changed and there is nothing to check.
//                 `clean: true` now requires either no fix round, a substantiated pass, or an honest
//                 reason the check never ran — an unsubstantiated `ran: true` blocks it.
//                 `repaired: true` means this round BROKE the check and then applied a repair, which
//                 was re-reviewed like any other change — read `passed` for whether it worked. A
//                 `clean: true` reached that way says so rather than hiding it.
//   repairs:      one entry per accepted repair attempt {round, summary, changed_files} — absent
//                 when no check ever failed.
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
function escalate(model) {
  const i = MODELS.indexOf(model)
  return i === -1 ? model : MODELS[Math.min(MODELS.length - 1, i + 1)]
}
const ROLE = policy({
  review: { model: 'sonnet' },
  verify: { model: 'sonnet' },
  fix: { model: 'sonnet' },
  check: { model: 'sonnet' },
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

// Checked BEFORE the dryRun early return, and deliberately duplicating the check further down: the
// skills tell callers to validate their args with `dryRun: true`, so a dryRun that answers `ok` for
// a `root` the real run would throw on is worse than no check at all. wf-implement.js validates
// ahead of its own projection for the same reason, and the two scripts have to answer the same
// malformed input the same way or the advice to "check it with dryRun" is only true of one of them.
if (args && args.root && !String(args.root).startsWith('/')) throw new Error('args.root must be an absolute path')
if (args && args.dryRun) return { ok: true, workflow: 'wf-review-loop', policy: ROLE }
if (!args || !args.scope) throw new Error('args.scope is required: which files/changes to review')

const intent = args.intent || 'Not provided — judge the code on its own terms.'
const seedFindings = (args.seedFindings || []).filter((f) => f && (f.title || f.id))
const apply = args.apply !== false
const maxRounds = args.maxRounds || 3
// The command one agent runs after a round applies fixes. `false` is an explicit opt-out and a blank
// string is no command at all; both mean no check agent is ever spawned.
const CHECK_COMMAND = typeof args.verifyCommand === 'string' ? args.verifyCommand.trim() : ''
const contextPaths = args.contextPaths || []
const CONTEXT_NOTE = contextPaths.length
  ? `\nBackground documents from earlier agents (read as needed; treat as hints and verify in code, not as ground truth):\n${contextPaths.map((p) => '- ' + p).join('\n')}\n`
  : ''
// The tree the agents run their commands in. Empty by default — and then every prompt below is
// byte-identical to what a review of the primary checkout has always sent, which is why the note is
// built once here instead of branching inside seven prompts. Set (wf-implement passes its own
// `root` down when the flow runs in a git worktree) it is an absolute path. This script has no
// filesystem, no shell and no way to set anyone's working directory, so prompt text is the only
// steering mechanism that exists. The three constants are duplicated verbatim in wf-implement.js — a
// self-contained script cannot import a helper — and tests/isolation.test.js compares the copies.
const root = (args.root || '').replace(/\/+$/, '')
if (root && !root.startsWith('/')) throw new Error('args.root must be an absolute path')
const GIT = root ? `git -C "${root}"` : 'git'
const RUN_FROM = root ? `the work root "${root}"` : 'the repository root'
const ROOT_NOTE = root ? `\n## Work root — read this before running anything\nThis flow runs in a git worktree at "${root}". EVERY repository command — git, build, test, any check named below — runs with that directory as its working directory: \`cd "${root}"\` first, or pass \`git -C "${root}"\`. The code you read and edit is under it. The developer's primary checkout is a DIFFERENT directory and must not be touched. The workspace paths named elsewhere in this prompt are absolute and deliberately sit OUTSIDE "${root}" — read and write those exactly as given.\n` : ''
const BASELINE_NOTE = args.baseline
  ? `\nBaseline: judge the CHANGES since git commit ${args.baseline} — run "${GIT} diff ${args.baseline} -- <files>" to see exactly what changed. Pre-existing defects untouched by the change are out of scope unless the change interacts with them.\n`
  : ''
const PRIORITY_NOTE = args.priority
  ? `\n## Look here first\n${args.priority}\n\nThis is a head start, not a scope restriction: cover the whole scope. A flagged worry that turns out to be fine is a normal outcome — do not manufacture a finding to justify it.\n`
  : ''
// Dismissing the same claim twice is pure waste, but the code has changed since it was dismissed —
// so this is a prior, never a veto.
const REFUTED_NOTE = (args.priorRefuted || []).length
  ? `\n## Already investigated and dismissed earlier in this run\n${JSON.stringify(args.priorRefuted, null, 2)}\n\nDo not re-derive these from scratch. Report one again ONLY if the code changed since in a way that makes the earlier reasoning wrong — and say what changed. Absent that, they are settled.\n`
  : ''

// ---- Path-scoped repo rules, matched here instead of by the caller. `.claude/rules/*.md` is a
// native Claude Code convention (wf-implement.js carries the full note); the caller runs
// scripts/rules-manifest.sh and passes [{path, globs}] plus the concrete `files` under review, and
// this picks the ones that apply. Matching in ONE place is the point: /dev-review used to eyeball
// globs in the main loop — the same job, done twice, once nondeterministically. The block below is
// copied verbatim from wf-implement (self-contained scripts cannot share a helper) and
// tests/rules.test.js asserts the copies stay byte-identical.
const ruleDefs = (args.rules || []).filter((r) => r && r.path)

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

// A third lens only when the repo itself says this area has specific concerns. One aggregated lens,
// never one per rule — lens count is agent count. Capped, because a repo-wide rule (e.g. **/*.ts)
// matches almost any change and would crowd out the specific ones. It is APPENDED to whatever
// `lenses` resolves to: a caller that passes custom lenses (/dev-pr --review passes two) is asking
// for a different pair of general lenses, not for the repo's own checklists to be dropped. Opt out
// with `ruleLens: false` (or by passing no `rules`).
const ruleLensPaths = rulesFor((args.files || []).filter(Boolean)).slice(0, 4)
const DEFAULT_LENSES = [
  { key: 'runtime-contracts', focus: 'logic and error-path bugs, broken invariants, concurrency, callers/callees, contracts, registrations, migrations and regressions' },
  { key: 'intent-verification', focus: 'intent and acceptance criteria, test coverage of behavior, missing requirements, scope creep and silent behavior changes' },
]
const LENSES = [
  ...(args.lenses || DEFAULT_LENSES),
  ...(args.ruleLens !== false && ruleLensPaths.length ? [{
    key: 'repo-conventions',
    focus: `compliance with this repository's own path-scoped rules for the area being changed. READ these rule files first — they are the repo's curated checklists and they name the canonical doc when you need detail:\n${ruleLensPaths.map((p) => '- ' + p).join('\n')}\nReport violations as defects only where breaking the rule causes a real problem (wrong error surface, a contract other code relies on, a missing registration, a convention that later code will trip over). A cosmetic deviation from a rule is not a defect — say nothing rather than padding the round.`,
  }] : []),
]

const FINDINGS_SCHEMA = {
  type: 'object', required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['title', 'file', 'severity', 'description'],
        properties: {
          title: { type: 'string', description: 'short stable slug for the defect' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          description: { type: 'string', description: 'the defect + concrete failure scenario: inputs/state that trigger wrong behavior' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
}

const VERIFIED_FINDINGS_SCHEMA = {
  type: 'object', required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'title', 'merged_titles', 'file', 'severity', 'description', 'confirmed', 'reasoning'],
        properties: {
          id: { type: 'string', description: 'stable kebab-case id for the semantic defect cluster' },
          title: { type: 'string' },
          merged_titles: { type: 'array', items: { type: 'string' } },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          description: { type: 'string' },
          suggested_fix: { type: 'string' },
          confirmed: { type: 'boolean' },
          reasoning: { type: 'string', description: 'file:line evidence covering code truth, runtime reachability and existing handling' },
        },
      },
    },
  },
}

const SECOND_OPINION_SCHEMA = {
  type: 'object', required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'confirmed', 'reasoning'],
        properties: { id: { type: 'string' }, confirmed: { type: 'boolean' }, reasoning: { type: 'string' } },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object', required: ['applied', 'skipped'],
  properties: {
    applied: { type: 'array', items: { type: 'object', required: ['id', 'title', 'file', 'what'], properties: { id: { type: 'string', description: "the originating finding's `id`, echoed VERBATIM — this is what the caller's gate matches on" }, title: { type: 'string' }, file: { type: 'string' }, what: { type: 'string' } } } },
    skipped: { type: 'array', items: { type: 'object', required: ['id', 'title', 'reason'], properties: { id: { type: 'string', description: "the originating finding's `id`, echoed VERBATIM — this is what the caller's gate matches on" }, title: { type: 'string' }, reason: { type: 'string' } } } },
  },
}

// The post-fix check reports the same shape wf-implement asks an implementer for, because it is the
// same claim and it is judged by the same truth table (classifyCheck below).
const FIX_VERIFY_SCHEMA = {
  type: 'object', required: ['ran'],
  properties: {
    ran: { type: 'boolean', description: 'false only if no executable check was possible. These fields travel together: ran=true without `command` and `passed` is treated exactly like ran=false, because a bare boolean is not evidence.' },
    command: { type: 'string', description: 'REQUIRED when ran=true: the exact command you executed' },
    passed: { type: 'boolean', description: 'REQUIRED when ran=true: whether that command actually succeeded' },
    output_summary: { type: 'string', description: 'on failure: the failing target and the essential error line, plus whether it looks caused by the applied fixes or pre-existing. No logs.' },
    not_ran_reason: { type: 'string', description: 'required when ran=false: why no executable check was possible. A round whose check never ran cannot be reported clean, so "no time" or "it looked correct" is not a reason.' },
  },
  description: 'result of ACTUALLY RUNNING the check — reading the code does not count',
}

const REPAIR_SCHEMA = {
  type: 'object', required: ['repaired', 'changed_files'],
  properties: {
    repaired: { type: 'boolean', description: 'true ONLY if you ran the command again yourself and it passed, without reverting a fix or weakening any check' },
    summary: { type: 'string', description: 'what was actually wrong and what you changed' },
    changed_files: { type: 'array', items: { type: 'string' }, description: 'REQUIRED when repaired=true, and must be non-empty: every repository path you modified — the next review round reads exactly these. A repair the next round cannot see is not accepted as clean.' },
    abandoned_because: { type: 'string', description: 'required when repaired=false: the conflict that made green impossible without abandoning a confirmed fix or weakening a check' },
  },
}

function reviewPrompt(lens, round) {
  return `You are a code reviewer with a single lens. Round ${round} of an iterative review.

## Scope — review only this
${args.scope}
${BASELINE_NOTE}${ROOT_NOTE}
## Intent of the change
${intent}
${CONTEXT_NOTE}${PRIORITY_NOTE}${REFUTED_NOTE}
## Your lens: ${lens.key}
${lens.focus}

## Guidelines
- Read the code in scope plus whatever surrounding code you need to judge it (callers, types, tests).
- Report only real defects you can articulate a concrete failure scenario for — no style nits, no speculative "might be nice".
- Give each finding a short stable title slug. A later verifier clusters semantic duplicates.
- Do NOT modify any files.

Your final output is raw data for an orchestrator, not prose for a human.`
}

// Round 1 casts the wide net. Later rounds exist to answer a narrow question — did the fixes hold,
// and did they break anything? Re-running the full multi-lens sweep to answer that pays for the wide
// net twice, so the re-review is one agent scoped to the code the fixes actually touched.
function rereviewPrompt(confirmed, applied, skipped, round) {
  const touched = [...new Set([...applied.map((a) => a.file), ...confirmed.map((f) => f.file)].filter(Boolean))]
  return `You are re-reviewing round ${round - 1}'s fixes. A full multi-lens review already swept this change; do not repeat it.

## Defects that were confirmed and handed to the fixer
${JSON.stringify(confirmed.map((f) => ({ id: f.id, title: f.title, file: f.file, line: f.line, severity: f.severity, description: f.description })), null, 2)}

## What the fixer reported doing
applied: ${JSON.stringify(applied, null, 2)}
skipped: ${JSON.stringify(skipped, null, 2)}

## Files to read
${touched.map((f) => '- ' + f).join('\n') || args.scope}
Plus whatever callers, types or tests you need to judge the fixes.
${BASELINE_NOTE}${ROOT_NOTE}
## Original intent of the change
${intent}
${CONTEXT_NOTE}
## Answer only these two questions
1. Is each confirmed defect actually resolved in the current code? A fix that is partial, moved the bug, or was reported as applied but is not in the code is still a finding — report it with its original title.
2. Did the fixes introduce anything new — broken callers of a changed signature, a new error path, an invariant the fix violated, a behavior change beyond the fix's mandate? Report those as new findings.

Do NOT hunt for pre-existing defects elsewhere in the scope: round 1 covered that ground, and re-reporting it here restarts the loop for nothing. Report nothing if the fixes are sound — an empty findings array is the expected outcome of a good fix round.

Do NOT modify any files. Your final output is raw data for an orchestrator.`
}

function verifyPrompt(found, round) {
  return `You are the batched adversarial verifier for review round ${round}.

Raw findings from complementary reviewers:
${JSON.stringify(found, null, 2)}

Context:
Scope: ${args.scope}
Intent: ${intent}
${BASELINE_NOTE}${ROOT_NOTE}${CONTEXT_NOTE}${REFUTED_NOTE}

First SEMANTICALLY CLUSTER reports with the same root cause, even when titles or cited files differ. Produce one canonical finding per root defect and list the merged titles. Then independently verify every cluster against current code: confirm only when the code supports the claim, the failure is reachable, and no existing guard/test/invariant neutralizes it. Preserve only the highest justified severity. Uncertainty means confirmed=false.

If the background includes a multi-step plan still being executed, distinguish a real completed-wave regression from a temporary condition explicitly owned by a named pending step. Defer the latter (confirmed=false, with the pending step in reasoning); the final consistency check will fail if it remains unresolved. Do not defer a regression that no pending step actually owns.

Do NOT modify files. Return every cluster, including refuted ones, as structured data.`
}

function criticalPrompt(findings) {
  return `You are a second independent verifier for CRITICAL findings only:

${JSON.stringify(findings, null, 2)}

Scope: ${args.scope}
Intent: ${intent}
${BASELINE_NOTE}${ROOT_NOTE}
Re-read the code. Confirm each id only if code evidence, runtime reachability and absence of prior handling all hold. Do not modify files. Return structured verdicts.`
}

function fixPrompt(confirmed) {
  return `You are applying review fixes. These findings were reported by reviewers and independently confirmed by adversarial verification:

${JSON.stringify(confirmed, null, 2)}

Context:
Scope: ${args.scope}
Intent: ${intent}
${BASELINE_NOTE}${ROOT_NOTE}${CONTEXT_NOTE}
For each canonical finding, apply the minimal correct fix, following the surrounding code's conventions. Re-read the code first; if a finding is wrong or unsafe to fix, skip it and say why. Stay inside scope unless correctness strictly requires a direct dependency or canonical documentation update; keep any expansion minimal and report it. Never perform unrelated cleanup.

Return the structured report. The next round explicitly re-reviews the result.`
}

// The round changed code. Reading it again is what the re-review does; this agent's whole job is to
// RUN something and report what happened, because "every finding was applied" and "the tree still
// works" are different claims and only one of them was ever checked.
function checkPrompt(round, command, fix) {
  return `You are running one executable check after review round ${round} applied fixes. You are not reviewing the code: you run a command and report what it did.
${ROOT_NOTE}
## The command — run it from ${RUN_FROM}, exactly as written
\`\`\`
${command}
\`\`\`

## What the fixer just changed (context for the failure, not something to re-judge)
${JSON.stringify((fix.applied || []).map((a) => ({ id: a.id, title: a.title, file: a.file, what: a.what })), null, 2)}

## Rules
- \`passed\` is the command's exit status and nothing else — never a judgement of whether the code looks right. A command that exits 0 passed even if you dislike what you saw; one that exits non-zero failed even if you believe the failure is unfair.
- Do NOT modify any file: not the code, not a test, not a config, not a lockfile. A check that repairs what it found launders the exact failure this check exists to surface. Report it and stop.
- If the command cannot run as written (missing tool, no such script, wrong working directory), you MAY instead run the repository's own documented build/test command from its README, CLAUDE.md or package manifest — and you MUST report THAT exact command in \`command\`. If you can run no check at all, return \`ran: false\` with a concrete reason naming what stopped you.
- On failure, name the failing target in \`output_summary\` — the failing test/file/rule plus the essential error line — and say whether it looks caused by the applied fixes or pre-existing. Do not paste logs.

Your final output is raw data for an orchestrator, not prose for a human.`
}

// The most dangerous prompt in this file. An agent told to make a red command green will revert the
// fix, or delete the assertion that failed, unless it is forbidden BY NAME — and from the outside
// that is indistinguishable from a repair. Declining is a first-class answer here for that reason,
// and whatever it does touch joins the next re-review's scope.
function repairPrompt(round, command, fix, fixVerify) {
  return `Round ${round} of a code review applied fixes for independently confirmed defects, and then this command FAILED. Make the command pass WITHOUT abandoning those fixes. You get one attempt.
${ROOT_NOTE}
## The command that must pass
\`\`\`
${command}
\`\`\`

## How it failed
${fixVerify.output_summary || 'No summary was reported — run the command yourself and read the failure.'}

## The fixes that must survive
${JSON.stringify((fix.applied || []).map((a) => ({ id: a.id, title: a.title, file: a.file, what: a.what })), null, 2)}

## Hard constraints — a repair that breaks one of these is worse than no repair
- Do NOT revert, neuter or partially undo any fix listed above. Those are confirmed defects; putting a bug back to get a green command is not a repair, it is a regression with a passing suite.
- Do NOT delete, skip, comment out, mark as expected-to-fail, or weaken any test, assertion, expectation, type or lint rule so the command goes green. Loosening what detects the problem is not fixing the problem.
- Do NOT loosen the command itself, its configuration, or any threshold it enforces.
- No unrelated cleanup. Change the least code that makes the command pass.

Run the command first and read the actual failure. Usually a fix was incomplete rather than wrong: a caller it did not update, a test that encodes the behavior the fix deliberately changed (correct it to the new behavior — do not delete it), a type or signature that needs updating at its definition.

If the only route to green is to abandon a confirmed fix or weaken a check, STOP: change nothing, return \`repaired: false\`, and say exactly what the conflict is in \`abandoned_because\`. That is a correct and expected answer — the loop then reports the failure instead of hiding it, which is the entire point of running the check.

List every file you touched in \`changed_files\`: the next review round reads them, so a repair is reviewed like any other change. Your final output is raw data for an orchestrator.`
}

// The check agent's reply is a CLAIM. The five statements below are a byte-identical copy of the
// truth table wf-implement.js applies to a step's `verify_run` — same identifiers, same reason
// strings — which is why this takes an impl-shaped wrapper instead of the reply directly.
// tests/verify-gate.test.js runs both copies through the same nine rows and fails if they drift.
function classifyCheck(impl, attempt = 1) {
  const verify = impl.verify_run || {}
  const verifyCommand = typeof verify.command === 'string' ? verify.command.trim() : ''
  const verifyFailed = verify.ran === true && verify.passed === false
  const unverified = !verifyFailed && !(verify.ran === true && verifyCommand && verify.passed === true)
  const unverifiedReason = !unverified ? null
    : verify.ran !== true ? (verify.not_ran_reason || 'no reason given')
    : !verifyCommand ? 'claimed ran=true without naming the command it ran'
    : 'claimed ran=true without reporting whether the check passed'
  return {
    ran: verify.ran === true,
    command: verifyCommand || undefined,
    passed: typeof verify.passed === 'boolean' ? verify.passed : undefined,
    output_summary: verify.output_summary || undefined,
    // The derived reason lands here: there is no sibling `unverified_reason` field in this shape, and
    // the gate below needs the honest "it never ran" admission to be readable by a caller.
    not_ran_reason: unverifiedReason || undefined,
    failed: verifyFailed,
    unverified,
    attempts: attempt,
  }
}

// What may unlock `clean` after a round applied fixes: no fix round at all, a substantiated pass, or
// an admission that nothing ran. A CLAIM to have run that named no command or no result is worth
// exactly as much as no check, minus the honesty — so it blocks.
function clearsClean(fv) {
  if (!fv) return true
  if (fv.ran === true) return fv.unverified !== true && fv.passed === true
  return Boolean(fv.not_ran_reason)
}

// Skipping spawns NOTHING: a caller with no command must not pay for an agent that can only report
// that it had nothing to run. `command` defaults to CHECK_COMMAND but the post-repair retry overrides
// it with whatever the first check actually substituted (checkPrompt lets an agent run the repo's own
// documented command when CHECK_COMMAND "cannot run as written") — the repair was validated against
// that substituted command, so the recheck must re-run the same one, not silently fall back to the
// original.
async function runFixCheck(round, fix, attempt = 1, command = CHECK_COMMAND) {
  const skip = args.verifyCommand === false ? 'the caller opted out of the post-fix check (verifyCommand: false)'
    : !command ? 'no verifyCommand was passed, so this run has no executable check to run'
    : !fix ? 'the fixer did not report, so there is nothing to check'
    : !(fix.applied || []).length ? 'the fixer applied nothing, so the tree is unchanged'
    : budget.total && budget.remaining() < 20000 ? 'token budget floor reached before the check could run'
    : null
  if (skip) return classifyCheck({ verify_run: { ran: false, not_ran_reason: skip } }, attempt)
  const reply = await metered('check', () => agent(checkPrompt(round, command, fix), {
    label: attempt === 1 ? `check r${round}` : `check r${round} (retry)`,
    phase: 'Check', ...ROLE.check, schema: FIX_VERIFY_SCHEMA,
  }))
  if (!reply) return classifyCheck({ verify_run: { ran: false, not_ran_reason: 'the check agent was unavailable' } }, attempt)
  return classifyCheck({ verify_run: reply }, attempt)
}

const allConfirmed = []
const allRefuted = []
const allApplied = []
const allSkipped = []
// Findings before clustering, and the clusters they collapsed into — accumulated across rounds
// because the ratio is a property of the whole run, not of one pass. Reported rather than derived:
// counting `merged_titles` after the fact omits every raw finding the verifier dropped without
// clustering. On the seeded path each seeded finding maps 1:1, so both rise by the same number and
// the run honestly reports a ratio of 1.0 — no clustering happened, and that is worth seeing.
let rawFindings = 0
let clusteredFindings = 0
let round = 0
let clean = false
let lastRound = null // previous round's confirmed findings + fixer report, for the targeted re-review
let fixVerify = null // the last fix round's classified check — null until a round applies fixes
const repairs = []

while (round < maxRounds) {
  if (budget.total && budget.remaining() < 30000) { log(`token budget floor reached after ${round} round(s) — stopping`); break }
  round++

  let found
  let preVerified = false
  if (round === 1 && seedFindings.length) {
    // The findings arrive already found AND already adversarially verified — from a persisted
    // /dev-pr --review report, whose caller has proved HEAD still equals the reviewed one. Finding
    // them again is not free caution: a second finder can MISS one, which silently drops a defect
    // that was confirmed. So round 1 goes straight to the fixer, and the explicit post-fix
    // re-review below is unchanged — `clean` still requires a pass that found nothing.
    log(`round 1: ${seedFindings.length} pre-verified finding(s) from the caller — skipping find and verify`)
    found = seedFindings
    preVerified = true
  } else if (round === 1) {
    found = (await metered('review', () => parallel(LENSES.map((l) => () =>
      agent(reviewPrompt(l, round), { label: `review:${l.key} r${round}`, phase: 'Review', ...ROLE.review, schema: FINDINGS_SCHEMA }),
    )))).filter(Boolean).flatMap((r) => r.findings)
  } else {
    const re = await metered('review', () => agent(rereviewPrompt(lastRound.confirmed, lastRound.applied, lastRound.skipped, round), {
      label: `re-review r${round}`, phase: 'Review', ...ROLE.review, schema: FINDINGS_SCHEMA,
    }))
    // An unavailable re-review is not evidence of a clean result — never let it fall through as one.
    if (!re) { log(`round ${round}: re-review agent unavailable — stopping without a clean verdict`); break }
    found = re.findings
  }

  log(`round ${round}: ${found.length} raw findings`)
  rawFindings += found.length // the logged number and the returned one are the same one, by construction
  if (!found.length) { clean = true; break }

  if (!preVerified && budget.total && budget.remaining() < 20000) { log('budget too low for verification — stopping without clean verdict'); break }
  const verified = preVerified
    ? { findings: found.map((f) => ({ ...f, confirmed: true })) }
    : await metered('verify', () => agent(verifyPrompt(found, round), { label: `verify:batch r${round}`, phase: 'Verify', ...ROLE.verify, schema: VERIFIED_FINDINGS_SCHEMA }))
  if (!verified) break
  let confirmed = verified.findings.filter((f) => f.confirmed)
  allRefuted.push(...verified.findings.filter((f) => !f.confirmed))

  // Seeded findings skip the critical second opinion too: they already had one when the report was
  // written, and the caller vouched that the code has not moved since.
  const critical = preVerified ? [] : confirmed.filter((f) => f.severity === 'critical')
  if (critical.length) {
    const second = await metered('verify', () => agent(criticalPrompt(critical), { label: `verify:critical r${round}`, phase: 'Verify', ...ROLE.verify, schema: SECOND_OPINION_SCHEMA }))
    if (!second) break
    const byId = new Map(second.verdicts.map((v) => [v.id, v]))
    confirmed = confirmed.filter((f) => {
      if (f.severity !== 'critical') return true
      const verdict = byId.get(f.id)
      if (verdict?.confirmed === true) return true
      allRefuted.push({ ...f, confirmed: false, reasoning: `${f.reasoning} | Critical second opinion: ${verdict?.reasoning || 'missing verdict'}` })
      return false
    })
  }

  log(`round ${round}: ${confirmed.length}/${verified.findings.length} semantic clusters confirmed`)
  // The post-verify count, which the critical second opinion above does not change: a demoted
  // critical moves from confirmed to refuted but stays exactly one cluster, counted once.
  clusteredFindings += verified.findings.length
  if (!confirmed.length) { clean = true; break }
  allConfirmed.push(...confirmed)

  if (!apply) break // report-only mode: one full find+verify pass is the deliverable

  if (budget.total && budget.remaining() < 20000) { log('budget too low for fixes — stopping without clean verdict'); break }
  // A critical defect buys one rung above this run's fix tier, not a hardcoded opus: the
  // escalation has to keep meaning something under a cheap profile, where sonnet IS the escalation.
  const fixModel = args.fixModel || (confirmed.some((f) => f.severity === 'critical') ? escalate(ROLE.fix.model) : ROLE.fix.model)
  const fix = await metered('fix', () => agent(fixPrompt(confirmed), { label: `fix r${round}`, phase: 'Fix', ...ROLE.fix, model: fixModel, schema: FIX_SCHEMA }))
  if (fix) {
    allApplied.push(...fix.applied)
    allSkipped.push(...fix.skipped)
  }
  lastRound = { confirmed, applied: (fix && fix.applied) || [], skipped: (fix && fix.skipped) || [] }

  // The fixes changed code, so the only honest way to know the tree still works is to run something.
  // This script has no shell: it hands the command to one agent and gates that agent's claim exactly
  // as wf-implement gates an implementer's.
  fixVerify = await runFixCheck(round, fix)
  log(`round ${round}: check ${fixVerify.ran
    ? `ran (${fixVerify.command || 'command not reported'}) — ${fixVerify.passed === true ? 'passed' : fixVerify.passed === false ? 'FAILED' : 'no result reported'}`
    : `did not run — ${fixVerify.not_ran_reason}`}`)

  // A command that ran and failed is the one review outcome this round can still act on, so it buys
  // exactly one repair attempt. A degraded `ran: true` claim buys none — there is no reported failure
  // to repair, only an unsubstantiated claim, and the gate below already refuses it.
  if (fixVerify.failed === true && !(budget.total && budget.remaining() < 20000)) {
    const repair = await metered('fix', () => agent(repairPrompt(round, fixVerify.command || CHECK_COMMAND, fix, fixVerify), {
      label: `repair r${round}`, phase: 'Check', ...ROLE.fix, schema: REPAIR_SCHEMA,
    }))
    const repaired = repair && repair.repaired ? (repair.changed_files || []).filter(Boolean) : []
    if (repair && repair.repaired && repaired.length) {
      repairs.push({ round, summary: repair.summary, changed_files: repaired })
      // Load-bearing, not bookkeeping: the targeted re-review reads `applied`, so without this append
      // the repair would be the only code in the run that nobody reviewed — trading one hole for
      // another. It goes into lastRound only; the returned `applied` stays the fixer's own report.
      lastRound.applied = [...lastRound.applied, ...repaired.map((f) => ({
        id: `repair-r${round}`, title: 'repair of the post-fix check', file: f,
        what: repair.summary || 'changed to make the post-fix check pass',
      }))]
      // Re-verify the exact command the repair was told to satisfy, not a fresh rediscovery of it —
      // see runFixCheck's `command` param.
      const recheck = await runFixCheck(round, fix, 2, fixVerify.command || CHECK_COMMAND)
      // A recheck that could not RUN is not permission to forget that the command failed. "No check
      // ran, because X" clears `clean` on its own — so letting a skipped recheck replace a red verdict
      // would launder the failure through the budget floor or an unavailable agent. Only a check that
      // actually ran can overturn one.
      fixVerify = recheck.ran === true ? recheck : {
        ...fixVerify,
        attempts: recheck.attempts,
        output_summary: `${fixVerify.output_summary || 'the check failed'} | a repair was applied but the recheck never ran: ${recheck.not_ran_reason}`,
      }
      fixVerify.repaired = true
      log(`round ${round}: repaired ${repaired.length} file(s) after the failed check — recheck ${fixVerify.passed === true ? 'passed' : 'still not green'}`)
    } else if (repair && repair.repaired) {
      // Claimed repaired:true but named no file it touched: unreviewable, since the next round's
      // targeted re-review reads exactly `applied`/`repairs`. Whatever it actually edited would land
      // outside anyone's scope, so this is treated as untrustworthy rather than accepted — the
      // original failure stands and the gate below breaks the round on it.
      log(`round ${round}: the repair agent claimed repaired=true but named no changed_files — not accepted`)
    } else {
      log(`round ${round}: the check failed and was not repaired — ${(repair && repair.abandoned_because) || 'the repair agent was unavailable'}`)
    }
  }

  // A repair that worked leaves passed:true here, so the round proceeds to its re-review; one that
  // did not breaks out with the failure intact, saving a re-review whose empty result could only
  // mislead.
  if (fixVerify.ran === true && !clearsClean(fixVerify)) {
    log(`round ${round}: the post-fix check did not clear (${fixVerify.not_ran_reason || 'it failed'}) — cannot declare clean`)
    break
  }
  if (!fix || fix.skipped.length) {
    log(`round ${round}: ${fix ? fix.skipped.length : confirmed.length} fixes unresolved — cannot declare clean`)
    break
  }
  // Never suppress across rounds: the next pass must report the same defect if the fix failed.
}

// The check's verdict cannot be applied where it is produced: both `clean = true` sites above fire in
// a round that ran no fixer at all, so it persists in `fixVerify` and is applied once, here.
const checkClears = clearsClean(fixVerify)
if (clean && !checkClears) {
  log(`a pass found no defects, but the post-fix check did not clear (${fixVerify.not_ran_reason || 'it failed'}) — reporting clean: false`)
}
return {
  rounds: round,
  clean: clean && checkClears, // an explicit pass with no confirmed defects AND a check that cleared
  raw: rawFindings, // always present: 0 means no round produced a finding, not "unknown"
  clustered: clusteredFindings,
  confirmed: allConfirmed,
  refuted: allRefuted,
  applied: allApplied,
  skipped: allSkipped,
  fix_verify: fixVerify || undefined, // absent when no round ever applied fixes
  repairs: repairs.length ? repairs : undefined,
  cost: costReport(),
}
