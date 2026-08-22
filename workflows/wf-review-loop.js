export const meta = {
  name: 'wf-review-loop',
  description: 'Loop until clean: two complementary reviewers → semantic clustering + batched verification → apply confirmed fixes → explicit re-review',
  whenToUse: 'Validate implemented code changes. Reusable standalone (via /dev-review) or called from the wf-implement workflow via workflow()',
  phases: [
    { title: 'Review', detail: 'two complementary lenses over the change; later rounds re-review only what the fixes touched' },
    { title: 'Verify', detail: 'cluster and verify all findings in one batch; critical findings get one second opinion' },
    { title: 'Fix', detail: 'apply confirmed fixes; critical defects or a second fix round escalate one model tier' },
    { title: 'Check', detail: "run the repo's own executable check on the fixed tree; a failed check buys one bounded repair attempt, itself re-reviewed" },
  ],
}

// args: { scope, intent?, baseline?, root?, contextPaths?, priority?, rules?, priorRefuted?,
//         apply?=true, maxRounds?=4, lenses?, ruleLens?=true, verifyCommand?, files?,
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
//   maxRounds:    how many rounds the loop may run. The LAST permitted one is report-only: it finds,
//                 verifies and reports, and never hands anything to a fixer — so the loop can no
//                 longer exit leaving fixes at HEAD that nobody reviewed. Budget for that: N rounds
//                 buy N-1 fix rounds. Under `apply: true` the limit is floored at 2, because one
//                 report-only round is not what a caller asking for fixes meant.
//
// returns: { rounds, rounds_end, clean, raw, clustered, confirmed, refuted, applied, skipped,
//            fix_rounds, regressions_introduced, unresolved_after_fix, unreviewed_fixes,
//            scope_source, oscillating?, undeclared_files?, fix_verify?, fix_self_check?,
//            repairs?, cost }
//   rounds_end:   why the loop stopped, from the ROUNDS_END vocabulary below — computed here rather
//                 than re-derived by every caller, so there is one answer and it is checkable.
//   fix_rounds:   how many rounds actually spawned a fixer. The denominator for a regression rate;
//                 `rounds` is not, because report-only and clean rounds fix nothing.
//   regressions_introduced / unresolved_after_fix: confirmed findings a round >= 2 re-review
//                 attributed to the fixes (`origin: introduced-by-fix`) or to a fix that did not
//                 hold (`origin: unresolved`). Always present; 0 is the truth, not a missing field.
//   unreviewed_fixes: the loop exited after a round applied fixes that no later round re-reviewed.
//                 The round budget can no longer cause this; a failed post-fix check and a skipped
//                 fix still can, and a caller that reads this reports it instead of leaving it to be
//                 found in the diff.
//   scope_source: what the LAST fix round's re-review scope was built from — `diff` · `self-report`.
//                 `diff` means the check agent read the tree with git; `self-report` means no check
//                 ran there and the fixer's own `changed_files` plus the confirmed findings' files is
//                 all there was.
//   oscillating:  true (absent otherwise) when the loop stopped itself because the same defect or the
//                 same file kept coming back — see the signatures at the fix gate. Another round is
//                 not the answer to this; a decision is.
//   undeclared_files: paths the post-fix `git status` reported that nothing in the run had declared —
//                 absent when empty. Direct evidence of what the old self-report-only scope missed.
//   fix_self_check: the last fix round's OWN classified run of the check, absent when the fixer
//                 reported none. It gates nothing (`clearsClean` is applied to `fix_verify` alone) —
//                 it is here so a fixer whose self-claim disagrees with the independent check is
//                 visible rather than averaged away.
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
const maxRounds = args.maxRounds || 4
// The last permitted round is report-only (see the fix gate in the loop), so a caller that asks for
// ONE round and also asks for fixes would get a round that finds, verifies, reports and fixes
// nothing — the opposite of what `apply: true` means. Floor it at two: one round to fix, one to
// judge the fix. `apply: false` needs no floor, since one find+verify pass IS its deliverable.
const roundLimit = apply && maxRounds < 2 ? 2 : maxRounds
if (roundLimit !== maxRounds) log(`maxRounds ${maxRounds} with apply: true would make every round report-only — raising the round limit to ${roundLimit} so the fixes get re-reviewed`)
// Why the loop stopped, as one literal so the prose that restates it can be compared against it
// (tests/contract-drift.test.js), mirroring wf-implement's DELIVERY_VERDICTS. The order is the
// precedence the return applies: budget outranks the round limit, because a budget exit that landed
// on the last round would otherwise be filed as convergence that never happened.
const ROUNDS_END = ['clean', 'oscillating', 'max-rounds', 'blocked', 'budget']
const [END_CLEAN, END_OSCILLATING, END_MAX_ROUNDS, END_BLOCKED, END_BUDGET] = ROUNDS_END
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
//
// A function, not a const, because this run refutes things too: round 2's reviewer re-deriving what
// round 1's verifier already threw out is the same waste as re-deriving the caller's priors, and
// `allRefuted` was write-only until here. It is rebuilt per call rather than once because it grows;
// the "built once" argument above belongs to ROOT_NOTE and defends prompt byte-identity for a
// DIFFERENT reason. With nothing refuted the rendered text is empty, exactly as it always was.
// The run's own entries are compacted into the shape callers pass, so one homogeneous list reaches
// the agent instead of a verifier reply with its full description, reasoning and fix_context inlined.
function refutedNote() {
  const refuted = [
    ...(args.priorRefuted || []),
    ...allRefuted.map((f) => ({ title: f.title, file: f.file, line: f.line, why_refuted: f.reasoning })),
  ]
  return refuted.length
    ? `\n## Already investigated and dismissed earlier in this run\n${JSON.stringify(refuted, null, 2)}\n\nDo not re-derive these from scratch. Report one again ONLY if the code changed since in a way that makes the earlier reasoning wrong — and say what changed. Absent that, they are settled.\n`
    : ''
}
// The fixer runs the check itself, before it reports. Non-empty ONLY when this run actually has a
// command, so a caller that opted out (`verifyCommand: false`) or passed none sends the same bytes
// it always did. The independent check agent still runs afterwards and its result is still what
// gates the round — this one exists so the fixer catches its own regression while it is still the
// cheapest agent in the loop to fix it, not so it can grade itself.
const SELF_CHECK_NOTE = args.verifyCommand !== false && CHECK_COMMAND
  ? `\n## Run this check yourself before you report — MANDATORY\nRun it from ${RUN_FROM} after your edits and before you return, exactly as written:\n\`\`\`\n${CHECK_COMMAND}\n\`\`\`\nReport what actually happened in \`self_check\`: the command you ran, whether it passed, and on failure the failing target plus the essential error line. If it went red because of your edits, fix that now and run it again — a regression you leave behind costs the loop a whole round, and you are the only agent that can still fix it for free.\n\nIf the command was already red before you touched anything, for reasons unrelated to these findings, say so in \`self_check.output_summary\` and leave it alone. Do not adjust it to make your own run look green.\n\nAn independent agent runs the same command again after you and THAT result gates the round, not this one. So a green you did not actually get buys nothing: this run exists to catch your own regression while you can still fix it, not to grade yourself.\n`
  : ''
// One sentence, used by both code-writing agents in this file. rulesNote's own register: it appends
// to "…they point at the canonical doc when detail is needed."
const FIX_RULE_ROLE = "They are binding for the code you write here: a fix that breaks one comes back as the next round's finding."

// What earlier rounds of THIS run already did. Until now every agent after round 1 saw exactly one
// round — `lastRound` is reassigned, so round 3's fixer could not know that round 1 had already
// "fixed" the same defect, which is the shape of every oscillation this loop produces.
//
// Compact BY CONSTRUCTION — ids, titles, files and the one-line `what`, never descriptions. This is
// context, not a transcript: a fixer that re-reads a full finding it already has in front of it pays
// for the same tokens twice, every round, and the payload grows with the run.
//
// In-run state only. Nothing here crosses a run boundary and no ledger number ever enters a prompt;
// this is not the cross-cycle memory docs/architecture.md rejects.
const HISTORY_FIX_ROLE = 'If you are about to change one of these again, say so in the matching `what` and say why. A defect that survived an earlier fix means that fix was wrong or incomplete — not that it should be undone: every one of them was independently confirmed and nothing has refuted it since, so reverting one is a regression with a plausible cover story.'
const HISTORY_REVIEW_ROLE = 'A defect an earlier round already applied a fix for, reported again now, is the strongest signal in this run: the fix did not hold. Say that plainly rather than reporting it as fresh. And a file this run has now edited two or three times is where to look hardest — repeated edits to one place are where a later fix quietly undoes an earlier one.'
// The loop matches a defect across rounds by `id` alone (see `identityOf` below) — so if this
// round's cluster is the same semantic defect as one an earlier round already confirmed and handed
// to a fixer, reusing THAT id is what makes "still here after two fixes" visible at all. Nothing
// else enforces this: two independent verify:batch calls have no reason to invent the same slug for
// the same defect on their own.
const HISTORY_VERIFY_ROLE = 'If a cluster you produce here is the same semantic defect as one of these earlier rounds\' confirmed findings, reuse that finding\'s exact `id` — do not invent a new one for it. A fresh id for an old defect makes a fix that already failed once look freshly found instead of still unresolved.'
function historyNote(history, role) {
  if (!history || !history.length) return ''
  return `\n## What earlier rounds of this run already did\n${JSON.stringify(history, null, 2)}\n${role}\n`
}

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

// The note that puts those rules in front of an agent that WRITES code. Copied byte-identically
// from wf-implement.js — a self-contained script cannot import a helper — and pinned by
// tests/rules.test.js. The reviewers get the rules as a lens; the fixer and the repair agent get
// them the way an implementer does, because they edit the same files under the same conventions.
function rulesNote(files, role) {
  const matched = rulesFor(files)
  if (matched.length) {
    return `\n## Repo rules covering these files — READ THEM\n${matched.map((p) => '- ' + p).join('\n')}\nThese are this repository's own checklists for the area you are touching, and they point at the canonical doc when detail is needed. ${role}\n`
  }
  if (ruleDefs.length) return '' // rules exist and none match these paths: nothing to read
  return `\n## Repo rules\nThis repo may keep path-scoped checklists in ".claude/rules/*.md", each with a \`paths:\` frontmatter listing the globs it covers. Check whether one matches the files in play and read it if so. ${role}\n`
}

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
          origin: { type: 'string', enum: ['introduced-by-fix', 'unresolved', 'pre-existing'], description: "where the defect came from, set ONLY by a round >= 2 re-review and carried through clustering: 'unresolved' — a confirmed defect the fixes did not actually resolve; 'introduced-by-fix' — the fixes broke this; 'pre-existing' — genuinely older than the fixes. A round-1 sweep and a seeded finding OMIT it: there are no fixes to attribute anything to, so the distinction does not exist." },
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
          origin: { type: 'string', enum: ['introduced-by-fix', 'unresolved', 'pre-existing'], description: "where the defect came from, set ONLY by a round >= 2 re-review and carried through clustering: 'unresolved' — a confirmed defect the fixes did not actually resolve; 'introduced-by-fix' — the fixes broke this; 'pre-existing' — genuinely older than the fixes. A round-1 sweep and a seeded finding OMIT it: there are no fixes to attribute anything to, so the distinction does not exist." },
          fix_locality: { type: 'string', enum: ['local', 'contract'], description: "how far a correct fix reaches: 'local' — contained in the file cited above; 'contract' — it changes a surface other code consumes (a signature, a return shape, an error surface, a schema, a documented default), so the fixer has to enumerate that surface before editing. Confirmed clusters only." },
          fix_context: {
            type: 'object',
            description: 'what the fixer needs and would otherwise pay an agent to rediscover — harvested from the reading you already did to verify this cluster. Confirmed clusters only; omit it entirely for a refuted one.',
            properties: {
              callers: { type: 'array', items: { type: 'string' }, description: 'file:line of the code that breaks if the cited behavior changes' },
              invariant: { type: 'string', description: 'the property that must still hold once this is fixed, in one sentence' },
              tests: { type: 'array', items: { type: 'string' }, description: 'the tests that encode this behavior today, by path and case name' },
              blast_radius: { type: 'string', description: 'what else a correct fix has to touch: types, schemas, docs or prompts that restate the behavior' },
            },
          },
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
  type: 'object', required: ['applied', 'skipped', 'changed_files'],
  properties: {
    applied: { type: 'array', items: { type: 'object', required: ['id', 'title', 'file', 'what'], properties: { id: { type: 'string', description: "the originating finding's `id`, echoed VERBATIM — this is what the caller's gate matches on" }, title: { type: 'string' }, file: { type: 'string' }, what: { type: 'string' } } } },
    skipped: { type: 'array', items: { type: 'object', required: ['id', 'title', 'reason'], properties: { id: { type: 'string', description: "the originating finding's `id`, echoed VERBATIM — this is what the caller's gate matches on" }, title: { type: 'string' }, reason: { type: 'string' } } } },
    // `applied` is one file per finding; this is the whole footprint. They are different lists on
    // purpose: a caller updated in passing appears only here, and only here can the next round see it.
    changed_files: { type: 'array', items: { type: 'string' }, description: "every repository path you modified, including callers, tests and docs you had to update; the next round's re-review reads exactly these, so a file you edited and did not list is read by nobody" },
    self_check: {
      type: 'object',
      description: 'result of ACTUALLY RUNNING the check named in the prompt yourself — reading the code does not count. Omit it only when the prompt named no command.',
      properties: {
        ran: { type: 'boolean', description: 'false only if no executable check was possible. These fields travel together: ran=true without `command` and `passed` is treated exactly like ran=false, because a bare boolean is not evidence.' },
        command: { type: 'string', description: 'REQUIRED when ran=true: the exact command you executed' },
        passed: { type: 'boolean', description: 'REQUIRED when ran=true: whether that command actually succeeded' },
        output_summary: { type: 'string', description: 'on failure: the failing target and the essential error line, plus whether it looks caused by the applied fixes or pre-existing. No logs.' },
        not_ran_reason: { type: 'string', description: 'required when ran=false: why no executable check was possible. A round whose check never ran cannot be reported clean, so "no time" or "it looked correct" is not a reason.' },
      },
    },
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
    // Independent of `ran`: a check that could not run at all still leaves a tree that git can read,
    // and that reading is the only unmediated view of the round the loop ever gets.
    changed_files: { type: 'array', items: { type: 'string' }, description: 'every repository path `git status --porcelain` reports as differing from HEAD — plain paths, no status letters. A report of the tree, not a judgement of it: report what the command printed, including paths that look unrelated to the fixes.' },
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
${CONTEXT_NOTE}${PRIORITY_NOTE}${refutedNote()}
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
function rereviewPrompt(confirmed, applied, skipped, round, ctx = {}) {
  // `applied` and `confirmed` name the defect SITES. `ctx.declared` names everything else the fixer
  // reported touching to fix them — the caller it updated, the test it corrected — which is exactly
  // what the blast-radius mandate now pushes it to touch. Without this term FIX_SCHEMA's promise to
  // the fixer ("the next round's re-review reads exactly these") was false for every collateral file:
  // declaring one excluded it from the undeclared section AND never added it here, so honesty and
  // silence produced the same blind spot.
  const touched = [...new Set([
    ...applied.map((a) => a.file), ...confirmed.map((f) => f.file), ...(ctx.declared || []),
  ].filter(Boolean).map(normalizePath))]
  // Files the round changed that its own report never mentioned. Nothing else in this prompt
  // describes them, which is precisely why they go first rather than into the list below.
  const undeclared = [...new Set((ctx.undeclared || []).filter(Boolean))]
  const UNDECLARED_NOTE = undeclared.length
    ? `\n## Files the fixer changed but did not report — read these FIRST\n${undeclared.map((f) => '- ' + f).join('\n')}\nThe fixer's report below does not mention these, so nothing tells you what happened to them or why. An edit nobody declared is where an unintended change hides — read them before anything else, and judge them as part of the fixes.\n`
    : ''
  // The fixer ran the check itself and an independent agent ran it again. Only their DISAGREEMENT is
  // passed in: when the two agree there is nothing here anyone can act on, and a paragraph that
  // appears in every prompt regardless is the one that stops being read.
  const DISAGREEMENT_NOTE = ctx.disagreement
    ? `\n## The fixer's own check and the independent one disagree\nThe fixer reported: ${ctx.disagreement.self}\nThe independent agent reported: ${ctx.disagreement.independent}\nSame command, same tree, two answers — so one of these agents is wrong about what the code does, and which one it is matters more than either result. Check it yourself where the fixes touched, and treat a fixer that reported a green it did not get as a finding in its own right.\n`
    : ''
  return `You are re-reviewing round ${round - 1}'s fixes. A full multi-lens review already swept this change; do not repeat it.

## Defects that were confirmed and handed to the fixer
${JSON.stringify(confirmed.map((f) => ({ id: f.id, title: f.title, file: f.file, line: f.line, severity: f.severity, description: f.description })), null, 2)}

## What the fixer reported doing
applied: ${JSON.stringify(applied, null, 2)}
skipped: ${JSON.stringify(skipped, null, 2)}
${UNDECLARED_NOTE}
## Files to read
${touched.map((f) => '- ' + f).join('\n') || args.scope}
Plus whatever callers, types or tests you need to judge the fixes.
${BASELINE_NOTE}${ROOT_NOTE}
## Original intent of the change
${intent}
${CONTEXT_NOTE}${historyNote(ctx.history, HISTORY_REVIEW_ROLE)}${DISAGREEMENT_NOTE}
## Answer only these two questions
1. Is each confirmed defect actually resolved in the current code? A fix that is partial, moved the bug, or was reported as applied but is not in the code is still a finding — report it with its original title and \`origin: "unresolved"\`.
2. Did the fixes introduce anything new — broken callers of a changed signature, a new error path, an invariant the fix violated, a behavior change beyond the fix's mandate? Report those as new findings with \`origin: "introduced-by-fix"\`. Set \`origin: "pre-existing"\` only for a defect these fixes demonstrably could not have caused — if the fixes could have caused it, it is not pre-existing.

Round 1's ground stays closed: do not go looking for pre-existing defects the fixes never touched, and do not re-litigate what an earlier round dismissed. But question 2 is not confined to the files listed above — anything these fixes could have broken is in scope WHEREVER it lives: a caller in another module, a test that encodes the behavior the fix changed, a type or schema that still declares the old shape, a doc or prompt that still describes it. Follow each change outward until it stops reaching anything, then stop. Report nothing if the fixes are sound — an empty findings array is the expected outcome of a good fix round.

Do NOT modify any files. Your final output is raw data for an orchestrator.`
}

function verifyPrompt(found, round, history) {
  return `You are the batched adversarial verifier for review round ${round}.

Raw findings from complementary reviewers:
${JSON.stringify(found, null, 2)}

Context:
Scope: ${args.scope}
Intent: ${intent}
${BASELINE_NOTE}${ROOT_NOTE}${CONTEXT_NOTE}${refutedNote()}${historyNote(history, HISTORY_VERIFY_ROLE)}

First SEMANTICALLY CLUSTER reports with the same root cause, even when titles or cited files differ. Produce one canonical finding per root defect and list the merged titles. Then independently verify every cluster against current code: confirm only when the code supports the claim, the failure is reachable, and no existing guard/test/invariant neutralizes it. Preserve only the highest justified severity. Uncertainty means confirmed=false.

For every cluster you CONFIRM — and only those — fill \`fix_context\` and \`fix_locality\` from the reading you have just done: the callers that break if the cited behavior changes, the invariant that must still hold, the tests that encode the behavior today, and what else a correct fix has to touch. \`fix_locality\` is \`contract\` when a fix changes a surface other code consumes and \`local\` when it is contained in the file you cited. You have already paid for this reading; the agent that fixes this has not, and it is the agent that breaks a caller when it has to guess.

Carry each finding's \`origin\` through into the cluster you produce, unchanged; when you merge findings whose origins differ, re-check the evidence for both rather than mechanically taking the stronger label — the cluster's origin is whichever attribution (\`introduced-by-fix\` over \`unresolved\` over \`pre-existing\`) the code actually supports, not whichever one merging happened to preserve. Dropping the field is not neutral either: the run counts regressions off YOUR output, so a cluster that loses its origin is counted as no regression at all.

That context is for the fixer and it NEVER makes a finding more likely to be real. Confirm on evidence exactly as you would if these fields did not exist, leave them off everything you refute, and do not inflate a blast radius to make a cluster look serious — severity is judged on the failure, not on the size of the fix.

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

// The agent that writes almost all of this loop's code (repairPrompt writes the rest, under the same
// rules). It gets what wf-implement gives an implementer — the path-scoped repo rules, a mandate to
// enumerate what an edit reaches BEFORE making it, and its own run of the check — because the round
// a broken caller costs is far more expensive than the prompt that would have prevented it. `ctx` is
// optional so the loop can add cross-round context without changing the signature again.
function fixPrompt(confirmed, ctx = {}) {
  const RULES = rulesNote([...confirmed.map((f) => f.file), ...(ctx.touched || [])].filter(Boolean), FIX_RULE_ROLE)
  return `You are applying review fixes. These findings were reported by reviewers and independently confirmed by adversarial verification:

${JSON.stringify(confirmed, null, 2)}

Context:
Scope: ${args.scope}
Intent: ${intent}
${BASELINE_NOTE}${ROOT_NOTE}${CONTEXT_NOTE}${RULES}${historyNote(ctx.history, HISTORY_FIX_ROLE)}
For each canonical finding, apply the minimal correct fix, following the surrounding code's conventions. Re-read the code first; if a finding is wrong or unsafe to fix, skip it and say why.

## Enumerate the blast radius BEFORE you edit
For every behavior you are about to change, list first — before touching anything — the callers of any signature, return shape, error surface or timing you change; the tests that encode that behavior; the types and schemas that declare it; and the docs or prompts that restate it. Then change all of them in the same pass, and list every path in \`changed_files\`.

Updating what your own edit broke is NEVER out of scope: it is part of the fix, and leaving it is exactly how a fix becomes the next round's defect. Three get missed most often — a caller you did not update; a test that encodes the behavior you deliberately changed (correct it to the new behavior, do NOT delete it); a type or signature that needs updating at its definition.

What IS out of scope: unrelated cleanup, refactors, and defects nobody reported. Leave code you are only reading through exactly as you found it.

Do NOT delete, skip, comment out, mark as expected-to-fail, or weaken any test, assertion, expectation, type or lint rule so the command goes green. Loosening what detects the problem is not fixing the problem.
${SELF_CHECK_NOTE}
Return the structured report. The next round explicitly re-reviews the result.`
}

// The round changed code. Reading it again is what the re-review does; this agent's whole job is to
// RUN something and report what happened, because "every finding was applied" and "the tree still
// works" are different claims and only one of them was ever checked.
//
// It also reports the DIFF, for one reason that has nothing to do with the check: this agent is the
// only one in the loop with a shell, and until it read `git status` the next round's file scope was
// whatever the fixer chose to declare. A file edited in passing and not listed was read by nobody.
// Spawning an agent just to run `git status` would break "skipping spawns NOTHING" (runFixCheck);
// asking the one that is already running costs a line.
function checkPrompt(round, command, fix, selfCheck) {
  // The fixer was told to run the same command before reporting. Naming its claim here is not an
  // invitation to agree with it — an agent handed an expected answer will find it — so the framing
  // is adversarial by construction: this is the claim you are here to test.
  const SELF_CLAIM = selfCheck
    ? `\n## What the fixer CLAIMS it already got from this command\n${JSON.stringify({ ran: selfCheck.ran, command: selfCheck.command, passed: selfCheck.passed, output_summary: selfCheck.output_summary, not_ran_reason: selfCheck.not_ran_reason }, null, 2)}\nThat is a claim by the agent that wrote the code, and it is the reason you exist: run the command yourself and report what YOU got. If your result differs from the claim above, report yours — do not reconcile them, do not re-run until they agree, and do not treat the claim as a reason to look less carefully.\n`
    : ''
  return `You are running one executable check after review round ${round} applied fixes. You are not reviewing the code: you run a command and report what it did.
${ROOT_NOTE}
## The command — run it from ${RUN_FROM}, exactly as written
\`\`\`
${command}
\`\`\`

## Then report what the tree actually looks like
Run this from ${RUN_FROM} as well, after the command above:
\`\`\`
${GIT} status --porcelain
\`\`\`
List every repository path it reports in \`changed_files\` — plain paths, no status letters, no renames expanded into prose. This is a report of what differs from HEAD, not a judgement of it: do not decide whether a path belongs, do not leave one out because it looks unrelated, and do not add one the command did not print. A path missing here is a file the next review round never reads.

## What the fixer just changed (context for the failure, not something to re-judge)
${JSON.stringify((fix.applied || []).map((a) => ({ id: a.id, title: a.title, file: a.file, what: a.what })), null, 2)}
${SELF_CLAIM}
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
  const RULES = rulesNote((fix.applied || []).map((a) => a.file).filter(Boolean), FIX_RULE_ROLE)
  return `Round ${round} of a code review applied fixes for independently confirmed defects, and then this command FAILED. Make the command pass WITHOUT abandoning those fixes. You get one attempt.
${ROOT_NOTE}${RULES}
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
    // Carried through, never judged — and deliberately inside the RETURN LITERAL rather than
    // computed above it: everything from `const verify` down to the opening of this literal is
    // byte-compared against wf-implement.js's copy of the same truth table
    // (tests/verify-gate.test.js), so a line added inside that slice is drift in a gate, not a new
    // field. Absent for an impl-shaped caller — an implementer's verify_run has no such field —
    // which is why it is optional everywhere.
    changed_files: verify.changed_files || undefined,
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
async function runFixCheck(round, fix, attempt = 1, command = CHECK_COMMAND, selfCheck = null) {
  const skip = args.verifyCommand === false ? 'the caller opted out of the post-fix check (verifyCommand: false)'
    : !command ? 'no verifyCommand was passed, so this run has no executable check to run'
    : !fix ? 'the fixer did not report, so there is nothing to check'
    : !(fix.applied || []).length ? 'the fixer applied nothing, so the tree is unchanged'
    : budget.total && budget.remaining() < 20000 ? 'token budget floor reached before the check could run'
    : null
  if (skip) return classifyCheck({ verify_run: { ran: false, not_ran_reason: skip } }, attempt)
  const reply = await metered('check', () => agent(checkPrompt(round, command, fix, selfCheck), {
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
// One compact record per round that reached the fixer. `lastRound` is REASSIGNED each round, so
// until now every agent after round 1 saw exactly one round: a round-3 fixer could not know that
// round 1 had already "fixed" the same defect, which is the shape of every oscillation this loop
// produces. This is what fixPrompt and rereviewPrompt read.
const history = []
// The files each fix round is known to have touched — the fixer's declared `changed_files`, the
// files its `applied` entries name, and whatever the post-fix `git status` reported that nothing
// already known accounted for (`carryUndeclared` below). Deliberately NOT the raw `git status`
// snapshot: on a dirty tree that reports the WHOLE uncommitted diff every round, so folding it in
// unfiltered would make a file merely dirty before this run started look "touched" by every fix
// round that followed it — exactly the false signal the churn check below must not fire on.
// Deliberately NOT part of `history` either: this feeds the oscillation signature and the "already
// known" set, and putting a file list in the prompt payload every round would only make it bigger.
const fixTouched = [] // [{ round, files: [...] }]
// Paths the check agent's git status reported that nothing in the run had declared. Accumulated
// across rounds because it is evidence about the run, not about one round of it.
const allUndeclared = []
// Identity of a finding, for matching one round's report against another's. `id` is the canonical
// cluster key the fixer is told to echo verbatim; `title` is the fallback, because a re-review that
// re-reports an unresolved defect is told to reuse its ORIGINAL TITLE and may not know its id.
const identityOf = (f) => String((f && f.id) || (f && f.title) || '').trim().toLowerCase()
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
let fixRounds = 0 // rounds that actually spawned a fixer — the denominator for a regression rate
let oscillating = false
// Why the loop stopped, recorded AT the break rather than reconstructed at the return: several exits
// are indistinguishable afterwards (a budget floor on the last round looks exactly like the round
// limit), and a verdict reconstructed from the wreckage is free to disagree with what happened.
let stopReason = null
// What the last re-review's file scope was built from. `self-report` until a check agent actually
// reads the tree, because that is the honest name for the fixer's own list.
let scopeSource = 'self-report'
let lastSelfCheck = null // the last fix round's classified SELF-claim — reported, never gated on
let fixedInRound = 0 // the last round that changed code
let reviewedThroughRound = 0 // the last round whose changes a re-review actually judged
// Carried from the round that made them to the re-review that judges it, which runs one iteration
// later. Not hung on `lastRound`: rereviewPrompt reads that object's three fields positionally and
// the repair block mutates its `applied`, so it stays exactly the shape those two agreed on.
let carryUndeclared = []
let carryDeclared = []
let carryDisagreement = null

while (round < roundLimit) {
  if (budget.total && budget.remaining() < 30000) { log(`token budget floor reached after ${round} round(s) — stopping`); stopReason = END_BUDGET; break }
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
    const re = await metered('review', () => agent(rereviewPrompt(lastRound.confirmed, lastRound.applied, lastRound.skipped, round, {
      history, undeclared: carryUndeclared, declared: carryDeclared, disagreement: carryDisagreement,
    }), {
      label: `re-review r${round}`, phase: 'Review', ...ROLE.review, schema: FINDINGS_SCHEMA,
    }))
    // An unavailable re-review is not evidence of a clean result — never let it fall through as one.
    if (!re) { log(`round ${round}: re-review agent unavailable — stopping without a clean verdict`); stopReason = END_BLOCKED; break }
    // This round's re-review judged the previous round's changes — the one fact `unreviewed_fixes`
    // is derived from, recorded where it is true rather than inferred from the round count.
    reviewedThroughRound = round - 1
    found = re.findings
  }

  log(`round ${round}: ${found.length} raw findings`)
  rawFindings += found.length // the logged number and the returned one are the same one, by construction
  if (!found.length) { clean = true; break }

  if (!preVerified && budget.total && budget.remaining() < 20000) { log('budget too low for verification — stopping without clean verdict'); stopReason = END_BUDGET; break }
  // Where this round's own refutations start, so the history record can carry them without a second
  // accumulator: `allRefuted` is appended to twice below (the batch verdict, then the critical
  // second opinion) and the slice from here is exactly what this round dismissed.
  const refutedFrom = allRefuted.length
  const verified = preVerified
    ? { findings: found.map((f) => ({ ...f, confirmed: true })) }
    : await metered('verify', () => agent(verifyPrompt(found, round, history), { label: `verify:batch r${round}`, phase: 'Verify', ...ROLE.verify, schema: VERIFIED_FINDINGS_SCHEMA }))
  if (!verified) { stopReason = END_BLOCKED; break }
  let confirmed = verified.findings.filter((f) => f.confirmed)
  allRefuted.push(...verified.findings.filter((f) => !f.confirmed))

  // Seeded findings skip the critical second opinion too: they already had one when the report was
  // written, and the caller vouched that the code has not moved since.
  const critical = preVerified ? [] : confirmed.filter((f) => f.severity === 'critical')
  if (critical.length) {
    const second = await metered('verify', () => agent(criticalPrompt(critical), { label: `verify:critical r${round}`, phase: 'Verify', ...ROLE.verify, schema: SECOND_OPINION_SCHEMA }))
    if (!second) { stopReason = END_BLOCKED; break }
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

  // report-only mode: one full find+verify pass is the deliverable. `confirmed.length` is nonzero
  // here (the empty case already broke above with `clean = true`), so this round is ending with
  // defects on the table that nothing here will resolve — the same "not clean, unaddressed" fact
  // `blocked` already names elsewhere, decided explicitly rather than left for the round-limit
  // fallback to guess at (which used to mislabel this as `max-rounds` whenever `maxRounds` happened
  // to equal 1, and as the round limit's absence otherwise — two different verdicts for the same
  // by-design outcome).
  if (!apply) { stopReason = END_BLOCKED; break }

  // ---- Oscillation. Fixing the same thing over and over is not convergence, and another round of
  // it is not the answer — a developer's decision is. Two signatures, either sufficient, both
  // evaluated BEFORE the fixer runs so the round that would have repeated the loop never happens.
  //
  // The thresholds are deliberately not "applied once and confirmed again": a partial fix
  // re-reported under its original title is the EXPECTED output of rereviewPrompt's question 1, and
  // stopping there would converge by looking away — the failure mode this whole change set exists to
  // avoid. Twice fixed and still here, or three rounds editing one file, is a different claim.
  //
  // Evaluated before the report-only break below, not after: on the last permitted round both stop
  // the loop and neither spawns anything, so the only difference is which reason the developer is
  // given — and "the loop kept fixing the same thing" is the one they must not answer by re-running.
  // It is also the precedence the return applies, and a verdict never reached is a precedence that
  // never applies.
  const appliedRounds = new Map() // finding identity -> the distinct rounds that reported fixing it
  for (const h of history) {
    for (const key of new Set(h.applied.map(identityOf).filter(Boolean))) {
      appliedRounds.set(key, (appliedRounds.get(key) || new Set()).add(h.round))
    }
  }
  const repeated = confirmed.find((f) => (appliedRounds.get(identityOf(f)) || new Set()).size >= 2)
  const churnRounds = new Map() // file -> the distinct fix rounds that touched it
  for (const t of fixTouched) {
    for (const file of new Set(t.files)) churnRounds.set(file, (churnRounds.get(file) || new Set()).add(t.round))
  }
  const churned = [...churnRounds.entries()].find(([, rounds]) => rounds.size >= 3)
  if (repeated || churned) {
    oscillating = true
    stopReason = END_OSCILLATING
    log(repeated
      ? `round ${round}: oscillating — "${repeated.title || repeated.id}" was reported fixed in ${[...appliedRounds.get(identityOf(repeated))].join(' and ')} and is confirmed again. Stopping before another fix round; this needs a decision, not another attempt.`
      : `round ${round}: oscillating — ${churned[0]} has been edited by ${churned[1].size} separate fix rounds (${[...churned[1]].join(', ')}). Stopping before another fix round; this needs a decision, not another attempt.`)
    break
  }

  // The LAST permitted round is report-only. A round that found, verified and fixed at the round
  // limit used to exit with those fixes at HEAD and nothing judging them — the loop's own output,
  // unreviewed, which is the one thing the loop exists to prevent. Reporting the findings unfixed is
  // the honest trade: the developer reads them and decides, instead of inheriting a diff no agent
  // has looked at. Budget for it — N rounds buy N-1 fix rounds.
  if (round >= roundLimit) {
    log(`round ${round} is the last permitted round of ${roundLimit} — reporting ${confirmed.length} confirmed finding(s) WITHOUT fixing them, so the loop never leaves a fix nobody re-reviewed`)
    stopReason = END_MAX_ROUNDS
    break
  }

  if (budget.total && budget.remaining() < 20000) { log('budget too low for fixes — stopping without clean verdict'); stopReason = END_BUDGET; break }

  // ONE combined escalation rule, deliberately not two escalate() calls stacked when both conditions
  // hold. The two signals say the SAME thing — this work is harder than the fix tier assumes — and
  // one rung is the deliberate size of that answer; on a three-rung ladder a second step is a no-op
  // from any default profile and doubles the price under `cheap`, where the budget was the point.
  // The base stays RELATIVE to this run's fix tier rather than a hardcoded opus
  // (docs/architecture.md → "Cost policy"), or "a hard case gets a better model" quietly means
  // nothing under a cheap profile — exactly when it matters most. Round >= 2 joins severity because
  // "this defect already survived a fix round" is that same evidence, arrived at by experiment.
  const fixModel = confirmed.some((f) => f.severity === 'critical') || round >= 2 ? escalate(ROLE.fix.model) : ROLE.fix.model
  fixRounds++
  // `touched` widens rule matching to files earlier rounds are already known to have reached
  // (`fixTouched`, built up as the loop runs) — not just this round's confirmed-finding files — so a
  // rule scoped to collateral territory (a test, a caller) the blast-radius mandate below pushed an
  // earlier round into still reaches the fixer here, even though none of THIS round's findings cite
  // it. Empty on round 1, where there is no earlier round to have touched anything yet.
  const fix = await metered('fix', () => agent(fixPrompt(confirmed, { history, touched: fixTouched.flatMap((t) => t.files) }), { label: `fix r${round}`, phase: 'Fix', ...ROLE.fix, model: fixModel, schema: FIX_SCHEMA }))
  if (fix) {
    allApplied.push(...fix.applied)
    allSkipped.push(...fix.skipped)
  }
  lastRound = { confirmed, applied: (fix && fix.applied) || [], skipped: (fix && fix.skipped) || [] }
  // Compact by construction — ids, titles, files and the one-line `what`, never descriptions. The
  // record is appended where `lastRound` is assigned so the two always describe the same round; the
  // repair block below mutates `lastRound.applied` and deliberately does not touch this, which is
  // the fixer's own report and stays that.
  history.push({
    round,
    confirmed: confirmed.map((f) => ({ id: f.id, title: f.title, file: f.file })),
    applied: lastRound.applied.map((a) => ({ id: a.id, title: a.title, file: a.file, what: a.what })),
    skipped: lastRound.skipped.map((s) => ({ id: s.id, title: s.title, reason: s.reason })),
    refuted: allRefuted.slice(refutedFrom).map((f) => ({ id: f.id, title: f.title })),
  })
  if (fix && (lastRound.applied.length || (fix.changed_files || []).length)) fixedInRound = round

  // The fixer was told to run the check itself. Classified through the SAME truth table as the
  // independent agent's claim — the function is pure and free — and used for reporting and for
  // context only. It is never passed to clearsClean: the whole value of the check agent is that the
  // runner is not the writer, and a fixer that can clear its own gate is exactly the agent that
  // starts weakening tests. A fixer that reported nothing gets null rather than an empty object,
  // which would classify as an honest "did not run" and be indistinguishable from one that said so.
  const selfCheck = fix && fix.self_check ? classifyCheck({ verify_run: fix.self_check }) : null
  if (selfCheck) {
    lastSelfCheck = selfCheck
    log(`round ${round}: the fixer's own check ${selfCheck.ran
      ? `ran (${selfCheck.command || 'command not reported'}) — ${selfCheck.passed === true ? 'passed' : selfCheck.passed === false ? 'FAILED' : 'no result reported'}`
      : `did not run — ${selfCheck.not_ran_reason}`}`)
  }

  // The fixes changed code, so the only honest way to know the tree still works is to run something.
  // This script has no shell: it hands the command to one agent and gates that agent's claim exactly
  // as wf-implement gates an implementer's.
  fixVerify = await runFixCheck(round, fix, 1, CHECK_COMMAND, selfCheck)
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
      const recheck = await runFixCheck(round, fix, 2, fixVerify.command || CHECK_COMMAND, selfCheck)
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

  // ---- What the round actually changed, from two independent sources, and their disagreement.
  //
  // The re-review's file scope used to BE the fixer's self-report (`applied` plus the confirmed
  // findings' files), so a caller or helper edited in passing and not reported was read by nobody —
  // which is precisely where a regression hides. The check agent has a shell and has just run
  // `git status --porcelain`, so the second source costs no agent: "skipping spawns NOTHING" stays
  // true, because nothing is spawned that was not already running.
  //
  // Where the pre-fix SHA would come from: nowhere. This script has no shell, and `root` may be a
  // worktree with its own state. So "already known" is everything the run has declared so far, and
  // the remainder is reported as undeclared. On the seeded --from-report path (clean tree, HEAD equal
  // to the reviewed head) that is exact; on a dirty standalone review it over-reports, which is
  // honest and costs one extra file in a reading list.
  const reportedDiff = [...new Set((fixVerify.changed_files || []).filter(Boolean).map(normalizePath))]
  const declaredThisRound = [...new Set([
    ...((fix && fix.changed_files) || []).filter(Boolean).map(normalizePath),
    ...lastRound.applied.map((a) => a.file).filter(Boolean).map(normalizePath),
  ])]
  // Carried to the next re-review as its reading list, in BOTH branches: the fixer's own account of
  // what it touched is the only source when no check ran, and it is still the account the re-review
  // must judge when one did.
  carryDeclared = declaredThisRound
  if (reportedDiff.length) {
    const known = new Set([
      ...(args.files || []).filter(Boolean).map(normalizePath),
      ...allApplied.map((a) => a.file).filter(Boolean).map(normalizePath),
      ...declaredThisRound,
      ...fixTouched.flatMap((t) => t.files), // prior rounds' declared + undeclared touches, already normalized
    ])
    carryUndeclared = reportedDiff.filter((p) => !known.has(p))
    scopeSource = 'diff'
    if (carryUndeclared.length) {
      allUndeclared.push(...carryUndeclared.filter((p) => !allUndeclared.includes(p)))
      log(`round ${round}: ${carryUndeclared.length} file(s) changed in the tree that nothing in this run declared — the next re-review reads them first`)
    }
  } else {
    // No check ran (opted out, no command, budget floor, nothing applied) — there is no diff, so the
    // scope degrades to what the fixer said it touched plus the confirmed findings' files, exactly
    // as it always was. Assigned rather than left alone: this names the source of the LAST fix
    // round's scope, and a run whose first round read the tree and whose second could not did not
    // get a diff-derived scope for the re-review that mattered most.
    carryUndeclared = []
    scopeSource = 'self-report'
  }
  // NOT `reportedDiff`: on a dirty tree that is the WHOLE uncommitted diff, present again every
  // round regardless of whether this round's fixer changed anything — feeding it in raw would make
  // the churn signature above fire off tree dirtiness rather than off three genuinely separate fix
  // rounds. `carryUndeclared` is `reportedDiff` already netted against everything the run knows
  // about (original scope, prior applies, this round's own declaration, prior rounds' touches), so
  // a file only lands here when THIS round plausibly changed it: the fixer said so, or the tree
  // shows it and nothing already accounts for it.
  fixTouched.push({ round, files: [...new Set([...declaredThisRound, ...carryUndeclared])] })

  // Two agents ran the same command on the same tree and disagreed about it. Only the disagreement
  // travels — agreement is the normal case and adds nothing a re-reviewer can act on.
  carryDisagreement = selfCheck && selfCheck.ran === true && fixVerify.ran === true && selfCheck.passed !== fixVerify.passed
    ? {
      self: `${selfCheck.command || 'command not reported'} — ${selfCheck.passed === true ? 'passed' : selfCheck.passed === false ? 'FAILED' : 'no result reported'}${selfCheck.output_summary ? ` (${selfCheck.output_summary})` : ''}`,
      independent: `${fixVerify.command || 'command not reported'} — ${fixVerify.passed === true ? 'passed' : fixVerify.passed === false ? 'FAILED' : 'no result reported'}${fixVerify.output_summary ? ` (${fixVerify.output_summary})` : ''}`,
    }
    : null
  if (carryDisagreement) log(`round ${round}: the fixer's own check and the independent one disagree — both results travel to the next re-review`)

  // A repair that worked leaves passed:true here, so the round proceeds to its re-review; one that
  // did not breaks out with the failure intact, saving a re-review whose empty result could only
  // mislead.
  if (fixVerify.ran === true && !clearsClean(fixVerify)) {
    log(`round ${round}: the post-fix check did not clear (${fixVerify.not_ran_reason || 'it failed'}) — cannot declare clean`)
    stopReason = END_BLOCKED
    break
  }
  if (!fix || fix.skipped.length) {
    log(`round ${round}: ${fix ? fix.skipped.length : confirmed.length} fixes unresolved — cannot declare clean`)
    stopReason = END_BLOCKED
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
// The terminal verdict, in one place. Precedence: a clean run is clean whatever else happened;
// otherwise the reason recorded AT THE BREAK wins. No `round >= roundLimit` fallback: every break
// site above now sets `stopReason` itself (a `clean = true` exit never reaches here at all), so a
// round that merely happens to equal the limit — an unavailable agent's last shot, or an apply:false
// pass whose caller passed maxRounds: 1 — is never confused with the round budget actually being the
// cause. Budget is tested BEFORE max-rounds because a budget exit that landed on the last round would
// otherwise be filed as convergence that never happened — the rule skills/dev-review/SKILL.md
// already stated, now computed rather than re-derived by each caller.
const roundsEnd = clean && checkClears ? END_CLEAN
  : stopReason === END_OSCILLATING ? END_OSCILLATING
  : stopReason === END_BUDGET ? END_BUDGET
  : stopReason === END_MAX_ROUNDS ? END_MAX_ROUNDS
  : END_BLOCKED
// Fixes at HEAD that no later round read. The round budget can no longer cause this — the last
// permitted round applies nothing — but a failed post-fix check and a skipped fix still break out of
// a round that already changed code, and a caller that is told so reports it instead of leaving it
// to be discovered in the diff.
const unreviewedFixes = fixedInRound > reviewedThroughRound
if (unreviewedFixes) log(`round ${fixedInRound} changed code that no later round re-reviewed — reporting unreviewed_fixes: true`)
log(`rounds_end: ${roundsEnd} after ${round} round(s), ${fixRounds} of them fix rounds`)
return {
  rounds: round,
  rounds_end: roundsEnd,
  clean: clean && checkClears, // an explicit pass with no confirmed defects AND a check that cleared
  raw: rawFindings, // always present: 0 means no round produced a finding, not "unknown"
  clustered: clusteredFindings,
  confirmed: allConfirmed,
  refuted: allRefuted,
  applied: allApplied,
  skipped: allSkipped,
  fix_rounds: fixRounds,
  // Counted from `origin`, which only a round >= 2 re-review sets — so a run that never re-reviewed
  // reports 0 because there was no basis for attributing anything, not because nothing broke.
  regressions_introduced: allConfirmed.filter((f) => f.origin === 'introduced-by-fix').length,
  unresolved_after_fix: allConfirmed.filter((f) => f.origin === 'unresolved').length,
  unreviewed_fixes: unreviewedFixes,
  scope_source: scopeSource,
  oscillating: oscillating || undefined, // absent otherwise, the repairs/fix_verify convention
  undeclared_files: allUndeclared.length ? allUndeclared : undefined,
  fix_verify: fixVerify || undefined, // absent when no round ever applied fixes
  fix_self_check: lastSelfCheck || undefined, // reported, never gated on — see clearsClean
  repairs: repairs.length ? repairs : undefined,
  cost: costReport(),
}
