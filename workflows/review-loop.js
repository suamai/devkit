export const meta = {
  name: 'review-loop',
  description: 'Loop until clean: two complementary reviewers → semantic clustering + batched verification → apply confirmed fixes → explicit re-review',
  whenToUse: 'Validate implemented code changes. Reusable standalone (via /dev-review) or called from the implement workflow via workflow()',
  phases: [
    { title: 'Review', detail: 'two complementary lenses over the change; later rounds re-review only what the fixes touched', model: 'sonnet' },
    { title: 'Verify', detail: 'cluster and verify all findings in one batch; critical findings get one second opinion', model: 'sonnet' },
    { title: 'Fix', detail: 'apply confirmed fixes; opus only for critical defects', model: 'sonnet' },
  ],
}

// args: { scope, intent?, baseline?, contextPaths?, priority?, rules?, priorRefuted?, apply?=true,
//         maxRounds?=3, lenses?, fixModel?, dryRun? }
//   scope:        what to review — files/paths/diff description. Reviewers only look here.
//   intent:       what the change was supposed to accomplish (plan step, spec criteria).
//   baseline:     git SHA before the change — reviewers judge the DIFF since it, not whole files.
//   contextPaths: workspace files with background (step brief, implementer notes) — hints, not truth.
//   priority:     where to look FIRST inside the scope (author-flagged doubts, unverified steps).
//                 A head start, never a scope restriction.
//   rules:        paths of the repo's path-scoped rule files matching the change; adds one extra
//                 "repo-conventions" lens. Ignored when `lenses` is passed explicitly.
//   priorRefuted: findings dismissed by an earlier review of the same run, with their reasoning —
//                 so this one does not re-investigate them from scratch.
if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { throw new Error('args arrived as a non-JSON string') } }
if (args && args.dryRun) return { ok: true, workflow: 'review-loop' }
if (!args || !args.scope) throw new Error('args.scope is required: which files/changes to review')

const intent = args.intent || 'Not provided — judge the code on its own terms.'
const apply = args.apply !== false
const maxRounds = args.maxRounds || 3
const contextPaths = args.contextPaths || []
const CONTEXT_NOTE = contextPaths.length
  ? `\nBackground documents from earlier agents (read as needed; treat as hints and verify in code, not as ground truth):\n${contextPaths.map((p) => '- ' + p).join('\n')}\n`
  : ''
const BASELINE_NOTE = args.baseline
  ? `\nBaseline: judge the CHANGES since git commit ${args.baseline} — run "git diff ${args.baseline} -- <files>" to see exactly what changed. Pre-existing defects untouched by the change are out of scope unless the change interacts with them.\n`
  : ''
const PRIORITY_NOTE = args.priority
  ? `\n## Look here first\n${args.priority}\n\nThis is a head start, not a scope restriction: cover the whole scope. A flagged worry that turns out to be fine is a normal outcome — do not manufacture a finding to justify it.\n`
  : ''
// Dismissing the same claim twice is pure waste, but the code has changed since it was dismissed —
// so this is a prior, never a veto.
const REFUTED_NOTE = (args.priorRefuted || []).length
  ? `\n## Already investigated and dismissed earlier in this run\n${JSON.stringify(args.priorRefuted, null, 2)}\n\nDo not re-derive these from scratch. Report one again ONLY if the code changed since in a way that makes the earlier reasoning wrong — and say what changed. Absent that, they are settled.\n`
  : ''

// A third lens only when the repo itself says this area has specific concerns: the caller passes the
// path-scoped rules matching the changed files. One aggregated lens, never one per rule — lens count
// is agent count. An explicit `lenses` argument overrides everything, including this.
const ruleLens = (args.rules || []).filter(Boolean)
const LENSES = args.lenses || [
  { key: 'runtime-contracts', focus: 'logic and error-path bugs, broken invariants, concurrency, callers/callees, contracts, registrations, migrations and regressions' },
  { key: 'intent-verification', focus: 'intent and acceptance criteria, test coverage of behavior, missing requirements, scope creep and silent behavior changes' },
  ...(ruleLens.length ? [{
    key: 'repo-conventions',
    focus: `compliance with this repository's own path-scoped rules for the area being changed. READ these rule files first — they are the repo's curated checklists and they name the canonical doc when you need detail:\n${ruleLens.map((p) => '- ' + p).join('\n')}\nReport violations as defects only where breaking the rule causes a real problem (wrong error surface, a contract other code relies on, a missing registration, a convention that later code will trip over). A cosmetic deviation from a rule is not a defect — say nothing rather than padding the round.`,
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

function reviewPrompt(lens, round) {
  return `You are a code reviewer with a single lens. Round ${round} of an iterative review.

## Scope — review only this
${args.scope}
${BASELINE_NOTE}
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
${BASELINE_NOTE}
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
${BASELINE_NOTE}${CONTEXT_NOTE}${REFUTED_NOTE}

First SEMANTICALLY CLUSTER reports with the same root cause, even when titles or cited files differ. Produce one canonical finding per root defect and list the merged titles. Then independently verify every cluster against current code: confirm only when the code supports the claim, the failure is reachable, and no existing guard/test/invariant neutralizes it. Preserve only the highest justified severity. Uncertainty means confirmed=false.

If the background includes a multi-step plan still being executed, distinguish a real completed-wave regression from a temporary condition explicitly owned by a named pending step. Defer the latter (confirmed=false, with the pending step in reasoning); the final consistency check will fail if it remains unresolved. Do not defer a regression that no pending step actually owns.

Do NOT modify files. Return every cluster, including refuted ones, as structured data.`
}

function criticalPrompt(findings) {
  return `You are a second independent verifier for CRITICAL findings only:

${JSON.stringify(findings, null, 2)}

Scope: ${args.scope}
Intent: ${intent}
${BASELINE_NOTE}
Re-read the code. Confirm each id only if code evidence, runtime reachability and absence of prior handling all hold. Do not modify files. Return structured verdicts.`
}

function fixPrompt(confirmed) {
  return `You are applying review fixes. These findings were reported by reviewers and independently confirmed by adversarial verification:

${JSON.stringify(confirmed, null, 2)}

Context:
Scope: ${args.scope}
Intent: ${intent}
${BASELINE_NOTE}${CONTEXT_NOTE}
For each canonical finding, apply the minimal correct fix, following the surrounding code's conventions. Re-read the code first; if a finding is wrong or unsafe to fix, skip it and say why. Stay inside scope unless correctness strictly requires a direct dependency or canonical documentation update; keep any expansion minimal and report it. Never perform unrelated cleanup.

Return the structured report. The next round explicitly re-reviews the result.`
}

const allConfirmed = []
const allRefuted = []
const allApplied = []
const allSkipped = []
let round = 0
let clean = false
let lastRound = null // previous round's confirmed findings + fixer report, for the targeted re-review

while (round < maxRounds) {
  if (budget.total && budget.remaining() < 30000) { log(`token budget floor reached after ${round} round(s) — stopping`); break }
  round++

  let found
  if (round === 1) {
    found = (await parallel(LENSES.map((l) => () =>
      agent(reviewPrompt(l, round), { label: `review:${l.key} r${round}`, phase: 'Review', model: 'sonnet', schema: FINDINGS_SCHEMA }),
    ))).filter(Boolean).flatMap((r) => r.findings)
  } else {
    const re = await agent(rereviewPrompt(lastRound.confirmed, lastRound.applied, lastRound.skipped, round), {
      label: `re-review r${round}`, phase: 'Review', model: 'sonnet', schema: FINDINGS_SCHEMA,
    })
    // An unavailable re-review is not evidence of a clean result — never let it fall through as one.
    if (!re) { log(`round ${round}: re-review agent unavailable — stopping without a clean verdict`); break }
    found = re.findings
  }

  log(`round ${round}: ${found.length} raw findings`)
  if (!found.length) { clean = true; break }

  if (budget.total && budget.remaining() < 20000) { log('budget too low for verification — stopping without clean verdict'); break }
  const verified = await agent(verifyPrompt(found, round), { label: `verify:batch r${round}`, phase: 'Verify', model: 'sonnet', schema: VERIFIED_FINDINGS_SCHEMA })
  if (!verified) break
  let confirmed = verified.findings.filter((f) => f.confirmed)
  allRefuted.push(...verified.findings.filter((f) => !f.confirmed))

  const critical = confirmed.filter((f) => f.severity === 'critical')
  if (critical.length) {
    const second = await agent(criticalPrompt(critical), { label: `verify:critical r${round}`, phase: 'Verify', model: 'sonnet', schema: SECOND_OPINION_SCHEMA })
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
  if (!confirmed.length) { clean = true; break }
  allConfirmed.push(...confirmed)

  if (!apply) break // report-only mode: one full find+verify pass is the deliverable

  if (budget.total && budget.remaining() < 20000) { log('budget too low for fixes — stopping without clean verdict'); break }
  const fixModel = args.fixModel || (confirmed.some((f) => f.severity === 'critical') ? 'opus' : 'sonnet')
  const fix = await agent(fixPrompt(confirmed), { label: `fix r${round}`, phase: 'Fix', model: fixModel, schema: FIX_SCHEMA })
  if (fix) {
    allApplied.push(...fix.applied)
    allSkipped.push(...fix.skipped)
  }
  lastRound = { confirmed, applied: (fix && fix.applied) || [], skipped: (fix && fix.skipped) || [] }
  if (!fix || fix.skipped.length) {
    log(`round ${round}: ${fix ? fix.skipped.length : confirmed.length} fixes unresolved — cannot declare clean`)
    break
  }
  // Never suppress across rounds: the next pass must report the same defect if the fix failed.
}

return {
  rounds: round,
  clean, // true only after an explicit pass with no confirmed defects
  confirmed: allConfirmed,
  refuted: allRefuted,
  applied: allApplied,
  skipped: allSkipped,
}
