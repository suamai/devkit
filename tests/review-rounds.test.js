// Round control in wf-review-loop: which round is allowed to fix, what every round after the first
// remembers, when the loop stops itself, where the re-review's file scope comes from, and which
// model the fixer gets. Five behaviors that share one property — none of them is visible in any
// single round, so all of them are asserted through the REAL entry point over a whole run.
//
// The harness is seeded-review.test.js's: the script wrapped in `new Function`, `agent` stubbed BY
// LABEL and throwing on a label nobody stubbed, so an agent that must not run (a fixer on the last
// permitted round, one after an oscillation stop) fails the test instead of costing money. Every
// number the assertions compare against — the round default, the fix tier, the model ladder — is
// read off the source, never restated here: a constant copied into a test drifts exactly like prose.
const fs = require('fs')
const path = require('path')

const RAW = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-review-loop.js'), 'utf8')
const SRC = RAW.replace(/^export const meta/m, 'const meta')

// Fail closed: a declaration that moved or was reworded must throw here rather than quietly handing
// the assertions a default of its own.
function sourceValue(expr, what) {
  const m = RAW.match(expr)
  if (!m) throw new Error(`could not read ${what} from wf-review-loop.js — has the declaration moved?`)
  return m[1]
}
const ROUND_DEFAULT = Number(sourceValue(/const maxRounds = args\.maxRounds \|\| (\d+)/, 'the maxRounds default'))
const MODELS = sourceValue(/const MODELS = \[([^\]]+)\]/, 'the model ladder').split(',').map((s) => s.trim().replace(/'/g, ''))
const FIX_TIER = sourceValue(/\n {2}fix: \{ model: '(\w+)' \}/, "the fix role's default model")
// escalate()'s own rule, over the ladder read above: one rung, clamped at the top.
const ESCALATED = MODELS[Math.min(MODELS.length - 1, MODELS.indexOf(FIX_TIER) + 1)]
const ROUNDS_END = sourceValue(/const ROUNDS_END = \[([^\]]+)\]/, 'the ROUNDS_END vocabulary').split(',').map((s) => s.trim().replace(/'/g, ''))

const NO_FLOOR = () => ({ total: null, spent: () => 0, remaining: () => Infinity })

function run(args, replies, budgetFor) {
  const calls = []
  const prompts = {}
  const models = {}
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    // Exact match first: `check r1` is a PREFIX of `check r1 (retry)`, so a prefix-only lookup would
    // make a round's two checks indistinguishable.
    const key = Object.keys(replies).find((k) => k === opts.label) || Object.keys(replies).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    prompts[opts.label] = prompt
    models[opts.label] = opts.model
    return replies[key]
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn(args, () => {}, agent, parallel, parallel, () => {}, async () => ({}), (budgetFor || NO_FLOOR)(calls))
    .then((result) => ({ result, calls, prompts, models }))
}

// A real budget only falls: generous until `label` has run, under every floor afterwards.
const dropAfter = (label) => (calls) => ({
  total: 300000, spent: () => 0, remaining: () => (calls.includes(label) ? 19000 : 50000),
})

const CMD = 'sh tests/run-all.sh'
// One seeded finding keeps round 1 down to a single fixer, so the call list reads as the shape of
// the run rather than as a list of reviewers.
const seed = (id, file) => [{ id, title: `defect ${id}`, file, line: 1, severity: 'high', confirmed: true }]
const finding = (id, file, extra) => ({ id, title: `defect ${id}`, file, line: 1, severity: 'high', description: 'd', ...extra })
const confirmedFinding = (id, file, extra) => ({ ...finding(id, file, extra), confirmed: true, reasoning: 'r' })
const fixOf = (id, file, files) => ({
  applied: [{ id, title: `defect ${id}`, file, what: `fixed ${id}` }],
  skipped: [],
  changed_files: files || [file],
})
const BASE = { scope: 'src/a.ts', intent: 'ship the queue change', apply: true, verifyCommand: false }

let failed = 0
let cases = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  cases++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

async function main() {
  // ---- 1. The last permitted round is report-only.
  //
  // maxRounds: 3 — round 1 fixes the seed, round 2 fixes what that broke, and round 3 finds a third
  // defect and REPORTS it. `fix r3` is deliberately unstubbed: a loop that spawned one would fail
  // here rather than leaving a fix at HEAD that no round is left to judge.
  const lastRound = await run({ ...BASE, maxRounds: 3, seedFindings: seed('f1', 'src/a.ts') }, {
    'fix r1': fixOf('f1', 'src/a.ts'),
    're-review r2': { findings: [finding('f2', 'src/b.ts', { origin: 'introduced-by-fix' })] },
    'verify:batch r2': { findings: [confirmedFinding('f2', 'src/b.ts', { origin: 'introduced-by-fix' })] },
    'fix r2': fixOf('f2', 'src/b.ts'),
    're-review r3': { findings: [finding('f3', 'src/c.ts', { origin: 'introduced-by-fix' })] },
    'verify:batch r3': { findings: [confirmedFinding('f3', 'src/c.ts', { origin: 'introduced-by-fix' })] },
  })
  check('the last permitted round never spawns a fixer',
    lastRound.calls, ['fix r1', 're-review r2', 'verify:batch r2', 'fix r2', 're-review r3', 'verify:batch r3'])
  check('  └─ and says so as the terminal verdict',
    [lastRound.result.rounds_end, lastRound.result.rounds, lastRound.result.fix_rounds], ['max-rounds', 3, 2])
  // The whole point of stopping there: what the round found is reported, and nothing it applied is
  // left unread. Both halves, because either one alone would be satisfied by doing nothing.
  check('  └─ the finding it could not fix is still reported',
    [lastRound.result.confirmed.map((f) => f.id), lastRound.result.clean], [['f1', 'f2', 'f3'], false])
  check('  └─ and no fix leaves the loop unreviewed', lastRound.result.unreviewed_fixes, false)
  // Attribution comes off `origin`, which only a round >= 2 re-review sets — the seed has none.
  check('  └─ regressions are counted from origin, not from the round number',
    [lastRound.result.regressions_introduced, lastRound.result.unresolved_after_fix], [2, 0])

  // ---- 2. apply: true with one round would otherwise be report-only, so the limit is floored at 2.
  const floored = await run({ ...BASE, maxRounds: 1, seedFindings: seed('f1', 'src/a.ts') }, {
    'fix r1': fixOf('f1', 'src/a.ts'),
    're-review r2': { findings: [] },
  })
  check('apply: true with maxRounds 1 still gets a fix round and its re-review',
    floored.calls, ['fix r1', 're-review r2'])
  check('  └─ and the run can reach clean', [floored.result.clean, floored.result.rounds_end, floored.result.rounds], [true, 'clean', 2])

  // apply: false needs no floor — one find+verify pass IS the deliverable, and /dev-pr --review
  // passes exactly this. The rule must stay a no-op there.
  const reportOnly = await run({ ...BASE, apply: false, maxRounds: 1, files: ['src/a.ts'] }, {
    'review:': { findings: [finding('n1', 'src/a.ts')] },
    'verify:batch r1': { findings: [confirmedFinding('n1', 'src/a.ts')] },
  })
  check('apply: false is untouched by the floor',
    [reportOnly.calls.length, reportOnly.result.rounds, reportOnly.result.rounds_end], [3, 1, 'blocked'])

  // The same by-design single pass, but with maxRounds left far from 1 — round(1) is nowhere near
  // roundLimit(4), so the OLD `round >= roundLimit` fallback could never have mislabeled this one as
  // `max-rounds`. Both runs stopping over the identical unaddressed-findings fact must carry the
  // identical verdict, whatever maxRounds happened to be.
  const reportOnlyUnfloored = await run({ ...BASE, apply: false, maxRounds: 4, files: ['src/a.ts'] }, {
    'review:': { findings: [finding('n1', 'src/a.ts')] },
    'verify:batch r1': { findings: [confirmedFinding('n1', 'src/a.ts')] },
  })
  check('  └─ and the verdict does not depend on how far maxRounds was from 1',
    [reportOnlyUnfloored.result.rounds, reportOnlyUnfloored.result.rounds_end], [1, 'blocked'])

  // ---- 3. The round budget default. Read off the source: a run that passes no maxRounds at all
  // must reach exactly that many rounds, with the last one report-only.
  const replies = { 're-review r5': { findings: [] } }
  for (let r = 1; r <= ROUND_DEFAULT; r++) {
    if (r > 1) {
      replies[`re-review r${r}`] = { findings: [finding(`f${r}`, `src/${r}.ts`, { origin: 'pre-existing' })] }
      replies[`verify:batch r${r}`] = { findings: [confirmedFinding(`f${r}`, `src/${r}.ts`, { origin: 'pre-existing' })] }
    }
    // Every round fixes a DIFFERENT finding in a DIFFERENT file, so neither oscillation signature
    // fires and the round budget is the only thing that can stop this run.
    if (r < ROUND_DEFAULT) replies[`fix r${r}`] = fixOf(`f${r}`, `src/${r}.ts`)
  }
  const defaulted = await run({ ...BASE, seedFindings: seed('f1', 'src/1.ts') }, replies)
  check('with no maxRounds the loop runs the script\'s own default',
    [defaulted.result.rounds, defaulted.result.fix_rounds], [ROUND_DEFAULT, ROUND_DEFAULT - 1])
  check('  └─ ending report-only, not mid-fix',
    [defaulted.calls.includes(`fix r${ROUND_DEFAULT}`), defaulted.result.rounds_end], [false, 'max-rounds'])

  // ---- 4. Cross-round memory reaches the fixer, and the fix model escalates by round.
  check('round 2\'s fixer is shown what round 1 already did',
    [defaulted.prompts['fix r2'].includes('"round": 1'), defaulted.prompts['fix r2'].includes('fixed f1')], [true, true])
  check('  └─ and round 1\'s fixer has no history to be shown',
    defaulted.prompts['fix r1'].includes('What earlier rounds of this run already did'), false)
  // ONE rung above this run's fix tier, both read from the source. The base is relative on purpose:
  // a hardcoded opus would make the escalation a no-op under a cheap profile.
  check('a defect that survived a round buys the fixer one rung',
    [defaulted.models['fix r1'], defaulted.models['fix r2'], defaulted.models['fix r3']],
    [FIX_TIER, ESCALATED, ESCALATED])
  // The severity half of the same rule, on the round where the round half cannot fire. A seeded
  // critical skips the second-opinion agent, so this is round 1 with one fixer and nothing else.
  const urgent = await run(
    { ...BASE, maxRounds: 2, seedFindings: [{ ...seed('f1', 'src/a.ts')[0], severity: 'critical' }] },
    { 'fix r1': fixOf('f1', 'src/a.ts'), 're-review r2': { findings: [] } })
  check('  └─ and a critical defect buys the same one rung in round 1',
    [urgent.models['fix r1'], urgent.models['fix r1'] === ESCALATED], [ESCALATED, true])

  // ---- 5. Oscillation, signature 1: the same defect reported fixed twice and still confirmed.
  const repeated = await run({ ...BASE, seedFindings: seed('f1', 'src/a.ts') }, {
    'fix r1': fixOf('f1', 'src/a.ts'),
    're-review r2': { findings: [finding('f1', 'src/a.ts', { origin: 'unresolved' })] },
    'verify:batch r2': { findings: [confirmedFinding('f1', 'src/a.ts', { origin: 'unresolved' })] },
    'fix r2': fixOf('f1', 'src/a.ts'),
    're-review r3': { findings: [finding('f1', 'src/a.ts', { origin: 'unresolved' })] },
    'verify:batch r3': { findings: [confirmedFinding('f1', 'src/a.ts', { origin: 'unresolved' })] },
  })
  check('twice fixed and confirmed again stops the loop',
    repeated.calls, ['fix r1', 're-review r2', 'verify:batch r2', 'fix r2', 're-review r3', 'verify:batch r3'])
  check('  └─ saying why, rather than spending the rounds it had left',
    [repeated.result.oscillating, repeated.result.rounds_end, repeated.result.rounds], [true, 'oscillating', 3])
  check('  └─ and the run had rounds left to spend', repeated.result.rounds < ROUND_DEFAULT, true)
  check('  └─ while what it stopped over is still reported', repeated.result.unresolved_after_fix, 2)

  // The "repeated" signature above only works because `identityOf` can match round 3's confirmed
  // finding against round 1's applied fix by `id` — nothing forces an independent verify:batch call
  // to reuse an earlier round's id on its own, so round 2's verifier must be HANDED round 1's id and
  // told to reuse it rather than invent a fresh one.
  check('round 2\'s verifier is shown the id an earlier round already assigned',
    [repeated.prompts['verify:batch r2'].includes('"id": "f1"'), repeated.prompts['verify:batch r2'].includes('reuse')],
    [true, true])
  // Round 1 here goes straight to the fixer (seeded), so no verify:batch call exists to check — the
  // call list assertion above already confirms that.
  check('  └─ and round 3\'s verifier is shown it too, not just the immediately preceding round',
    repeated.prompts['verify:batch r3'].includes('"id": "f1"'), true)

  // The threshold is NOT "applied once and confirmed again": a partial fix re-reported under its
  // original title is the expected output of the re-review's first question, and stopping there
  // would converge by looking away. Round 2 must therefore still fix.
  check('one failed fix is not oscillation', repeated.calls.includes('fix r2'), true)

  // ---- 6. Oscillation, signature 2: one file edited by three separate fix rounds, three DIFFERENT
  // findings — so signature 1 cannot be what fires. Round 4 is also the last permitted round, which
  // is the point: the loop reports the diagnosis it has, not merely that it ran out of rounds.
  const churn = await run({ ...BASE, seedFindings: seed('f1', 'src/a.ts') }, {
    'fix r1': fixOf('f1', 'src/a.ts'),
    're-review r2': { findings: [finding('f2', 'src/a.ts')] },
    'verify:batch r2': { findings: [confirmedFinding('f2', 'src/a.ts')] },
    'fix r2': fixOf('f2', 'src/a.ts'),
    're-review r3': { findings: [finding('f3', 'src/a.ts')] },
    'verify:batch r3': { findings: [confirmedFinding('f3', 'src/a.ts')] },
    'fix r3': fixOf('f3', 'src/a.ts'),
    're-review r4': { findings: [finding('f4', 'src/a.ts')] },
    'verify:batch r4': { findings: [confirmedFinding('f4', 'src/a.ts')] },
  })
  check('three fix rounds over one file is oscillation too',
    [churn.result.oscillating, churn.result.rounds_end, churn.calls.includes('fix r4')], [true, 'oscillating', false])
  check('  └─ two rounds over one file is not', churn.calls.includes('fix r3'), true)

  // ---- 7. The re-review's file scope IS the fixer's self-report — and only that.
  const scoped = await run(
    { ...BASE, verifyCommand: CMD, files: ['src/a.ts'], seedFindings: seed('f1', 'src/a.ts') },
    {
      'fix r1': fixOf('f1', 'src/a.ts', ['src/a.ts', 'src/caller-i-updated.ts']),
      'check r1': { ran: true, command: CMD, passed: true, changed_files: ['src/a.ts', 'src/helper.ts'] },
      're-review r2': { findings: [finding('f2', 'src/b.ts', { origin: 'introduced-by-fix' })] },
      'verify:batch r2': { findings: [confirmedFinding('f2', 'src/b.ts', { origin: 'introduced-by-fix' })] },
      'fix r2': fixOf('f2', 'src/b.ts'),
      'check r2': { ran: true, command: CMD, passed: true, changed_files: ['src/a.ts', 'src/helper.ts', 'src/b.ts', 'src/other.ts'] },
      're-review r3': { findings: [] },
    })
  // The seam this closes: a file the fixer HONESTLY declares in changed_files but has no `applied`
  // entry for — the caller it updated, the test it corrected. FIX_SCHEMA promises the fixer that what
  // it lists there is what the next round reads, and before this it was in no list at all.
  check('a file the fixer declared but did not apply against is read too',
    scoped.prompts['re-review r2'].includes('src/caller-i-updated.ts'), true)
  // The limitation, pinned so nobody mistakes it for a capability. A tree-derived second source was
  // built here and removed: `git status` reports whether a path DIFFERS from HEAD and never what
  // changed inside it, so on a dirty tree it named the whole uncommitted diff every round and could
  // not tell an undeclared edit from a file that had simply been dirty all along. What is left is a
  // self-report: an edit the fixer does not declare is not detected, and this asserts exactly that.
  check('a file ONLY the check agent saw does not reach the re-review — undeclared is undetected',
    [scoped.prompts['re-review r2'].includes('src/helper.ts'),
      JSON.stringify(scoped.prompts['fix r1']).includes('src/helper.ts')],
    [false, false])
  check('  └─ and the check agent is no longer asked to read the tree at all',
    scoped.prompts['check r1'].includes('status --porcelain'), false)
  // The counters below are read off the verifier's clusters, so the instruction to carry `origin`
  // through clustering is the only thing standing between a dropped field and a reported rate of 0.
  check('the verifier is told to carry origin through clustering',
    scoped.prompts['verify:batch r2'].includes('origin'), true)
  check('  └─ and the run is honest about what it attributed', scoped.result.regressions_introduced, 1)

  const serialized = (r) => JSON.parse(JSON.stringify(r.result))
  check('  └─ and a run that did not oscillate says nothing about it',
    ['oscillating' in serialized(floored), 'oscillating' in serialized(repeated)], [false, true])

  // ---- 8. The fixer's own run of the check is reported and never gates anything.
  const selfChecked = await run(
    { ...BASE, verifyCommand: CMD, seedFindings: seed('f1', 'src/a.ts') },
    {
      'fix r1': { ...fixOf('f1', 'src/a.ts'), self_check: { ran: true, command: CMD, passed: false, output_summary: 'one case red' } },
      'check r1': { ran: true, command: CMD, passed: true, changed_files: ['src/a.ts'] },
      're-review r2': { findings: [] },
    })
  // The independent agent is what `clean` rests on. A fixer's gloomier self-report does not block it,
  // and a rosier one could not unlock it — clearsClean is applied to fix_verify and nothing else.
  check('the independent check decides clean, not the fixer\'s own',
    [selfChecked.result.clean, selfChecked.result.fix_verify.passed, selfChecked.result.fix_self_check.passed],
    [true, true, false])
  check('  └─ the check agent is shown the claim it is there to test',
    selfChecked.prompts['check r1'].includes('one case red'), true)
  check('  └─ and their disagreement travels to the re-review',
    selfChecked.prompts['re-review r2'].includes('disagree'), true)
  check('a fixer that ran nothing gets no invented self-claim', floored.result.fix_self_check, undefined)

  // ---- 9. What an earlier round refuted is not re-litigated by a later one.
  // maxRounds: 2 makes round 2 the report-only one, so the verifier's prompt is the last thing this
  // run produces and no fixer is needed to reach it.
  const refuted = await run({ ...BASE, maxRounds: 2, files: ['src/a.ts'] }, {
    'review:': { findings: [finding('n1', 'src/a.ts'), finding('n2', 'src/a.ts')] },
    'verify:batch r1': {
      findings: [
        confirmedFinding('n1', 'src/a.ts'),
        { ...finding('n2', 'src/a.ts'), confirmed: false, reasoning: 'the guard three lines up already handles this' },
      ],
    },
    'fix r1': fixOf('n1', 'src/a.ts'),
    're-review r2': { findings: [finding('n3', 'src/a.ts', { origin: 'introduced-by-fix' })] },
    'verify:batch r2': { findings: [confirmedFinding('n3', 'src/a.ts', { origin: 'introduced-by-fix' })] },
  })
  check('round 2\'s verifier is told what round 1 already dismissed',
    refuted.prompts['verify:batch r2'].includes('the guard three lines up already handles this'), true)
  check('  └─ and round 1\'s verifier had nothing to be told',
    refuted.prompts['verify:batch r1'].includes('Already investigated and dismissed'), false)

  // ---- 10. The two exits that CAN still leave an unreviewed fix, and the verdict each carries.
  const blocked = await run(
    { ...BASE, verifyCommand: CMD, maxRounds: 3, seedFindings: seed('f1', 'src/a.ts') },
    {
      'fix r1': fixOf('f1', 'src/a.ts'),
      'check r1': { ran: true, command: CMD, passed: false, output_summary: 'two cases red', changed_files: ['src/a.ts'] },
      'repair r1': { repaired: false, abandoned_because: 'green requires reverting the confirmed fix' },
    })
  check('a post-fix check that failed still leaves fixes nobody read',
    [blocked.result.rounds_end, blocked.result.unreviewed_fixes, blocked.result.clean], ['blocked', true, false])

  const starved = await run({ ...BASE, seedFindings: seed('f1', 'src/a.ts') },
    { 'fix r1': fixOf('f1', 'src/a.ts') }, dropAfter('fix r1'))
  check('a budget floor is reported as budget, never as the round limit',
    [starved.result.rounds_end, starved.result.unreviewed_fixes], ['budget', true])

  // An unavailable agent that happens to fire on the LAST permitted round used to coincide with
  // `round >= roundLimit` and get mislabeled `max-rounds`, even though nothing about the round budget
  // caused the stop — round 1's confirmed finding just sits there, unreviewed by round 2.
  const unavailableLast = await run(
    { ...BASE, maxRounds: 2, seedFindings: seed('f1', 'src/a.ts') },
    { 'fix r1': fixOf('f1', 'src/a.ts'), 're-review r2': null })
  check('an unavailable re-review on the last round is blocked, not max-rounds',
    [unavailableLast.result.rounds_end, unavailableLast.result.rounds], ['blocked', 2])
  // The identical event on an EARLIER round (not the last one) must carry the identical verdict —
  // the label no longer depends on where in the round budget the agent went missing.
  const unavailableEarly = await run(
    { ...BASE, maxRounds: 5, seedFindings: seed('f1', 'src/a.ts') },
    { 'fix r1': fixOf('f1', 'src/a.ts'), 're-review r2': null })
  check('  └─ and the same event on an earlier round carries the identical verdict',
    [unavailableEarly.result.rounds_end, unavailableEarly.result.rounds], ['blocked', 2])

  // ---- 11. Oscillation signature 2 must come from what a fix round actually touched, not from a
  // dirty tree. `src/scope-unrelated.ts` is part of the original scope and sits in every check
  // agent's `git status` for three straight fix rounds — but no fixer ever declares or applies
  // against it, so it must never make the churn signature fire. Four DISTINCT files get fixed across
  // four DISTINCT rounds so signature 1 (a repeated id) cannot be what proves this either.
  const dirtyTree = await run(
    { ...BASE, verifyCommand: CMD, maxRounds: 5, files: ['src/scope-unrelated.ts'], seedFindings: seed('f1', 'src/a.ts') },
    {
      'fix r1': fixOf('f1', 'src/a.ts'),
      'check r1': { ran: true, command: CMD, passed: true, changed_files: ['src/a.ts', 'src/scope-unrelated.ts'] },
      're-review r2': { findings: [finding('f2', 'src/b.ts')] },
      'verify:batch r2': { findings: [confirmedFinding('f2', 'src/b.ts')] },
      'fix r2': fixOf('f2', 'src/b.ts'),
      'check r2': { ran: true, command: CMD, passed: true, changed_files: ['src/a.ts', 'src/b.ts', 'src/scope-unrelated.ts'] },
      're-review r3': { findings: [finding('f3', 'src/c.ts')] },
      'verify:batch r3': { findings: [confirmedFinding('f3', 'src/c.ts')] },
      'fix r3': fixOf('f3', 'src/c.ts'),
      'check r3': { ran: true, command: CMD, passed: true, changed_files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/scope-unrelated.ts'] },
      're-review r4': { findings: [finding('f4', 'src/d.ts')] },
      'verify:batch r4': { findings: [confirmedFinding('f4', 'src/d.ts')] },
      // By round 4 the check has reported `src/scope-unrelated.ts` as differing from HEAD in three
      // separate rounds — the raw-diff bug would have stopped the loop right here, before this call.
      'fix r4': fixOf('f4', 'src/d.ts'),
      'check r4': { ran: true, command: CMD, passed: true, changed_files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/scope-unrelated.ts'] },
      're-review r5': { findings: [] },
    })
  check('a file dirty for three rounds but touched by no fixer does not read as churn',
    [dirtyTree.calls.includes('fix r4'), dirtyTree.result.oscillating], [true, undefined])
  check('  └─ the run reaches its real outcome instead of a false oscillation stop',
    [dirtyTree.result.rounds_end, dirtyTree.result.rounds, dirtyTree.result.fix_rounds], ['clean', 5, 4])

  // Every verdict this file exercises is one the script still declares, and the vocabulary is read
  // off the source — so a member renamed there breaks this rather than testing a word that moved.
  const seen = [...new Set([lastRound, floored, reportOnly, reportOnlyUnfloored, defaulted, repeated, churn, scoped, selfChecked, blocked, starved, unavailableLast, unavailableEarly]
    .map((r) => r.result.rounds_end))]
  check('every verdict used is one the script declares', seen.filter((v) => !ROUNDS_END.includes(v)), [])
  check('and all five are reachable', ROUNDS_END.filter((v) => !seen.includes(v)), [])
  // And it bites, on a perturbed COPY: a declared verdict no run above can produce must come back as
  // unreachable, or the case above is passing by having nothing to look for.
  check('  └─ and a verdict nothing can produce fails the same filter',
    [...ROUNDS_END, 'never-emitted'].filter((v) => !seen.includes(v)), ['never-emitted'])

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
