// The computed delivery verdict and the coverage matrix under it, driven through wf-implement's REAL
// entry point.
//
// Nothing here asks an agent what the run was worth: `delivery_verdict`, `gates`, `reasons` and
// `coverage` are a pure function of outputs the run already produced, and this file is what proves
// the function says what the gate table says. Every row is a full stubbed run — the whole script in
// `new Function`, `agent` stubbed BY LABEL and throwing on an unlisted one (so a verdict that
// silently grew an agent is a test failure rather than a surprise bill), `workflow` and `budget`
// overridable per row because a blocked checkpoint and a budget stop are two of the triggers.
//
// The two joins worth staring at, because both are invisible in a green run that never exercises
// them: a SPLIT step's evidence has to be found through the top-level `reports` entry (its leaves are
// `s1a`/`s1b`, and the `covers` the plan declared lives on `s1`), and an INHERITED leaf carries no
// `status` field at all, so reading `status` alone would file a passed one as unverified.
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-implement.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')

// The vocabulary comes off the source, never retyped: a verdict this file expects that the script can
// no longer produce has to fail here rather than quietly test nothing.
const VERDICTS = (SRC.match(/const DELIVERY_VERDICTS = \[([^\]]+)\]/) || [])[1]
if (!VERDICTS) throw new Error('could not extract DELIVERY_VERDICTS from wf-implement.js')
const DELIVERY_VERDICTS = VERDICTS.split(',').map((v) => v.trim().replace(/'/g, ''))

// context_confidence: 'high' so no scout is spawned — every row below is about the verdict, and a
// scout reply would only be noise. s2 depends on s1, so "the second wave ran at all" stays a real
// question, and each step covers one criterion so the matrix has both shapes to join.
const STEPS = [
  { id: 's1', title: 'the gate table', goal: 'compute the five gates', files: ['src/a.ts'], depends_on: [], verify: 'node tests/a.test.js', covers: ['AC-01'], context_confidence: 'high', details: 'derive each gate from the structured outputs the run already produced' },
  { id: 's2', title: 'the verdict', goal: 'fold the gates into one word', files: ['src/b.ts'], depends_on: ['s1'], verify: 'node tests/b.test.js', covers: ['AC-02'], context_confidence: 'high', details: 'one word plus the reasons behind it, computed from the gates and nothing else' },
]
const CRITERIA = ['AC-01', 'AC-02']

const implReply = (id, verify, extra) => ({
  summary: `${id} implemented`,
  changed_files: [`src/${id}.ts`],
  notes_path: `/w/notes/${id}.md`,
  verify_run: verify,
  ...extra,
})
const OK = (command, kind) => ({ ran: true, command, passed: true, output_summary: 'green', ...(kind ? { kind } : {}) })
const SUITE_GREEN = { consistent: true, issues: [], suite_run: { ran: true, command: 'sh tests/run-all.sh', passed: true, output_summary: 'suite green' } }
const CLEAN_REVIEW = { clean: true, rounds: 1, confirmed: [], applied: [], skipped: [] }
const BASE_REPLIES = {
  'impl:s1': implReply('s1', OK('node tests/a.test.js', 'new-test')),
  'impl:s2': implReply('s2', OK('node tests/b.test.js', 'new-test')),
  'consistency-check': SUITE_GREEN,
}

// checkpointMaxWaves: 1 flushes every wave, so a checkpoint's own decision is observable on both;
// gate: false keeps `calls` down to the agents each row is actually about.
function run(o = {}) {
  const calls = []
  const prompts = {}
  const reviewArgs = []
  const merged = { ...BASE_REPLIES, ...(o.replies || {}) }
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    // Exact match first: a prefix-only lookup would make `impl:s1` and `impl:s1a` the same key.
    const key = Object.keys(merged).find((k) => k === opts.label) || Object.keys(merged).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    prompts[opts.label] = prompt
    return merged[key]
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()))
  const workflow = async (ref, wargs) => {
    reviewArgs.push(wargs)
    return o.review === undefined ? CLEAN_REVIEW : o.review
  }
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn({
    workspace: '/w',
    steps: o.steps || STEPS,
    criteria: o.criteria === undefined ? CRITERIA : o.criteria,
    checkpointMaxWaves: 1,
    gate: false,
    ...(o.args || {}),
  }, () => {}, agent, parallel, parallel, () => {}, workflow,
  o.budget || { total: null, spent: () => 0, remaining: () => Infinity })
    .then((result) => ({ result, calls, prompts, reviewArgs }))
}

const rowFor = (result, id) => (result.coverage.criteria.find((c) => c.id === id) || {})
const seenVerdicts = new Set()
const verdictOf = (result) => { seenVerdicts.add(result.delivery_verdict); return result.delivery_verdict }
const hasReason = (result, gate) => result.reasons.some((r) => r.startsWith(`${gate}: `))

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
  // ---- (1) `ready`: every mandatory gate carries evidence, including a suite that actually ran.
  const ready = await run()
  check('a fully evidenced run is ready', verdictOf(ready.result), 'ready')
  check('  └─ with every gate at its cleanest value', ready.result.gates,
    { acceptance: 'passed', tests: 'passed', review: 'clean', questions: 'none', scope: 'within-plan' })
  check('  └─ and nothing to explain', ready.result.reasons, [])
  // The matrix is the join, not a restatement of it: the criterion, the step that claimed it, and the
  // command that step actually ran.
  check('  └─ the matrix names the criterion, the step and the command it ran', rowFor(ready.result, 'AC-01'),
    { id: 'AC-01', covered_by: ['s1'], status: 'passed', unsubstantiated_by: [], checks: [{ step: 's1', command: 'node tests/a.test.js', status: 'passed', weak_evidence: false }] })
  check('  └─ with nothing uncovered and no unknown id',
    [ready.result.coverage.uncovered, ready.result.coverage.unknown], [[], []])

  // ---- (2) `ready-with-unverified`: no known failure, and at least one claim nothing executed.
  // (a) a step that honestly ran no check of its own — the suite still ran and passed.
  const noStepCheck = await run({ replies: { 'impl:s2': implReply('s2', { ran: false, not_ran_reason: 'no runtime surface to exercise here' }) } })
  check('an unverified step downgrades the verdict, never blocks it', verdictOf(noStepCheck.result), 'ready-with-unverified')
  check('  └─ tests: unverified, and the criterion resting on it says so',
    [noStepCheck.result.gates.tests, rowFor(noStepCheck.result, 'AC-02').status], ['unverified', 'unverified'])
  check('  └─ and the reason names that gate', hasReason(noStepCheck.result, 'tests'), true)

  // (a2) The same shape with the criterion resting on TWO steps: s2 covers AC-01 as well and runs
  // nothing. The row is `unverified` because only an all-passed set reads `passed` — but s1's
  // `node tests/a.test.js` did run and did pass, so a reason line claiming no executed check
  // substantiates AC-01 would contradict the matrix printed beside it. It has to name the silent
  // step instead, which is what makes the line safe for /dev-pr to quote without the matrix.
  const partlyCovered = await run({
    steps: [STEPS[0], { ...STEPS[1], covers: ['AC-01'] }],
    criteria: ['AC-01'],
    replies: { 'impl:s2': implReply('s2', { ran: false, not_ran_reason: 'no runtime surface to exercise here' }) },
  })
  check('a half-substantiated criterion names the step that ran nothing',
    [rowFor(partlyCovered.result, 'AC-01').status, rowFor(partlyCovered.result, 'AC-01').unsubstantiated_by],
    ['unverified', ['s2']])
  check('  └─ the reason names it instead of denying the check that passed',
    (partlyCovered.result.reasons.find((r) => r.startsWith('acceptance: ')) || '').includes('(s2)'), true)
  check('  └─ and the passing command stays visible in the row',
    rowFor(partlyCovered.result, 'AC-01').checks.filter((c) => c.status === 'passed').map((c) => c.command),
    ['node tests/a.test.js'])
  // (b) the run finished, and the CHECKER itself reported that it ran no suite. Distinct from the
  // stopped-run placeholder below: nothing stopped here, the agent simply had nothing to run.
  const noSuite = await run({ replies: { 'consistency-check': { consistent: true, issues: [], suite_run: { ran: false, output_summary: 'this repo documents no suite' } } } })
  check('a suite that never ran is not-run, not a pass',
    [verdictOf(noSuite.result), noSuite.result.gates.tests], ['ready-with-unverified', 'not-run'])
  // Weak evidence is the case that deliberately does NOT downgrade: a refactor's already-green check
  // is the honest answer, and flattening it into `unverified` would price honesty above silence.
  const weak = await run({ replies: { 'impl:s1': implReply('s1', OK('node tests/a.test.js', 'existing-suite')) } })
  check('an already-green check stays a pass and is marked in the row',
    [verdictOf(weak.result), weak.result.gates.tests, rowFor(weak.result, 'AC-01').checks[0].weak_evidence], ['ready', 'passed', true])

  // An OPEN question is informational — the question was asked and a reversible assumption recorded —
  // so it neither blocks nor downgrades. It is also the trap in `reasons`: `ready` tolerates a gate
  // that is not at its cleanest value, so a reason line printed per non-clean gate would explain a
  // verdict that has nothing to explain.
  const openQuestion = await run({
    replies: { 'impl:s1': implReply('s1', OK('node tests/a.test.js', 'new-test'), { needs_user_input: [{ question: 'which id format do you prefer?', blocking: false, assumption: 'the shorter one' }] }) },
  })
  check('an open question leaves the run ready',
    [verdictOf(openQuestion.result), openQuestion.result.gates.questions], ['ready', 'open'])
  check('  └─ and a ready verdict explains nothing', openQuestion.result.reasons, [])

  // ---- (3) `blocked`, one row per trigger. Five survive by design — the sixth, a stale plan, has no
  // computable source and was dropped rather than stubbed — and `review` gets two rows because it
  // reads two independent sources.
  //
  // (a) a step's own check went red.
  const redStep = await run({ replies: { 'impl:s1': implReply('s1', { ran: true, command: 'node tests/a.test.js', passed: false, output_summary: '2 cases fail' }) } })
  check('a failed verification blocks', verdictOf(redStep.result), 'blocked')
  check('  └─ on tests, and on the criterion that rested on it',
    [redStep.result.gates.tests, redStep.result.gates.acceptance, rowFor(redStep.result, 'AC-01').status], ['failed', 'failed', 'failed'])
  check('  └─ and the reason names the step', redStep.result.reasons.some((r) => r.startsWith('tests: ') && r.includes('s1')), true)

  // ...the same failure, reached through the OTHER shape `runStep` returns it in: the impl agent
  // itself came back unavailable (`agent()` resolved to a falsy value) rather than a red check, and
  // the one cheap re-serialization attempt it buys came back empty too. That leaf carries `.failed`
  // and no `.status` or `.impl` at all — the shape `failedSteps` and the coverage matrix must
  // recognize without ever seeing a status string, or it reads as `not-run` / `unverified` instead
  // of the `failed` it actually is.
  const implUnavailable = await run({ replies: { 'impl:s1': null, 'result:s1': null } })
  check('an unavailable impl agent blocks, not just downgrades', verdictOf(implUnavailable.result), 'blocked')
  check('  └─ on tests, and on the criterion that rested on it',
    [implUnavailable.result.gates.tests, implUnavailable.result.gates.acceptance, rowFor(implUnavailable.result, 'AC-01').status], ['failed', 'failed', 'failed'])
  check('  └─ and the reason names the step', implUnavailable.result.reasons.some((r) => r.startsWith('tests: ') && r.includes('s1')), true)

  // ...and the other half of that gate: no step failed, the SUITE did.
  const redSuite = await run({ replies: { 'consistency-check': { consistent: false, issues: [], suite_run: { ran: true, command: 'sh tests/run-all.sh', passed: false, output_summary: '1 suite failed' } } } })
  check('a suite that ran and did not pass blocks',
    [verdictOf(redSuite.result), redSuite.result.gates.tests], ['blocked', 'failed'])
  check('  └─ even though every step passed its own check',
    [redSuite.result.reports.every((r) => r.status === 'passed'), redSuite.result.reasons.some((r) => r.startsWith('tests: ') && r.includes('suite'))], [true, true])

  // (b) source one for `review`: the checkpoint's own decision, persisted onto its entry at the
  // moment it was made rather than re-derived here from findings a second copy could read differently.
  const blockedCheckpoint = await run({ review: { clean: false, rounds: 2, confirmed: [{ id: 'f1', severity: 'critical', title: 't' }], applied: [], skipped: [] } })
  check('a blocked checkpoint blocks', verdictOf(blockedCheckpoint.result), 'blocked')
  check('  └─ the entry carries the decision the loop actually made',
    blockedCheckpoint.result.checkpointReviews.map((c) => [c.blocked, c.unfixed_severe, c.unaddressed, c.check_failed]), [[true, 1, 1, false]])
  check('  └─ and gates.review reads it', blockedCheckpoint.result.gates.review, 'blocked')

  // (c) source two: an unfixed high/critical from the consistency check on a run that did NOT stop
  // early and whose every checkpoint was clean. This is the row that fails if `gates.review` reads
  // `checkpointReviews` alone — the check runs after the last checkpoint and nothing re-checks it.
  const checkIssue = await run({ replies: { 'consistency-check': { consistent: false, issues: [{ description: 'two steps registered the same handler', severity: 'critical', fixed: false }], suite_run: { ran: true, command: 'sh tests/run-all.sh', passed: true, output_summary: 'green' } } } })
  check('an unfixed critical from the final check alone blocks', verdictOf(checkIssue.result), 'blocked')
  check('  └─ with every checkpoint clean and the run not stopped',
    [checkIssue.result.checkpointReviews.every((c) => c.blocked === false), checkIssue.result.stoppedEarly], [true, false])
  check('  └─ gates.review is blocked all the same', checkIssue.result.gates.review, 'blocked')
  check('  └─ and the reason names the consistency check',
    checkIssue.result.reasons.some((r) => r.startsWith('review: ') && r.includes('consistency check')), true)

  // (d) a blocking question: the implementer guessed at something that changes its own approach.
  const blockingQuestion = await run({
    replies: { 'impl:s1': implReply('s1', OK('node tests/a.test.js', 'new-test'), { needs_user_input: [{ question: 'which table owns the id?', blocking: true, assumption: 'the left one' }] }) },
  })
  check('a blocking question blocks', verdictOf(blockingQuestion.result), 'blocked')
  check('  └─ on questions, naming the step that asked',
    [blockingQuestion.result.gates.questions, blockingQuestion.result.reasons.some((r) => r.startsWith('questions: ') && r.includes('s1'))], ['blocking', true])

  // (e) a budget stop. The floor trips before the first step even scouts, so this row spawns no agent
  // at all — and the stop lands on `scope`, which is what the gate table says a budget stop is.
  const budgetStop = await run({ budget: { total: 500000, spent: () => 0, remaining: () => 10000 } })
  check('a budget stop blocks', verdictOf(budgetStop.result), 'blocked')
  check('  └─ on scope, with the stop reason verbatim in the reason line',
    [budgetStop.result.gates.scope, budgetStop.result.reasons.some((r) => r.startsWith('scope: ') && r.includes(budgetStop.result.stopReason))], ['incomplete', true])
  check('  └─ and it cost nothing to find out', budgetStop.calls, [])
  check('  └─ the criterion its skipped step claimed carries no evidence',
    [rowFor(budgetStop.result, 'AC-01').status, rowFor(budgetStop.result, 'AC-01').checks], ['unverified', []])

  // (f) an incomplete dependency wave: three waves, a checkpoint policy that lets wave 1 defer, and a
  // failure in wave 2 — so wave 3 never runs and two implemented waves never reach a review at all.
  // A single-wave stop cannot show this: `pending.waves` is pushed before the blocked check, so
  // `unreviewedWaves` is non-empty for any early stop.
  const CHAIN = [
    { ...STEPS[0] },
    { ...STEPS[1] },
    { id: 's3', title: 'the report', goal: 'lead the report with the verdict', files: ['src/c.ts'], depends_on: ['s2'], verify: 'node tests/c.test.js', covers: ['AC-03'], context_confidence: 'high', details: 'state the verdict, then the reasons, then the gates' },
  ]
  const unreviewedWave = await run({
    steps: CHAIN,
    criteria: ['AC-01', 'AC-02', 'AC-03'],
    args: { checkpointMaxWaves: 3 },
    replies: { 'impl:s2': implReply('s2', { ran: true, command: 'node tests/b.test.js', passed: false, output_summary: 'red' }) },
  })
  check('a wave that never reached a review blocks', verdictOf(unreviewedWave.result), 'blocked')
  check('  └─ scope is incomplete, and names both the unreviewed waves and the work left',
    [unreviewedWave.result.gates.scope, unreviewedWave.result.unreviewedWaves, unreviewedWave.result.continuation.pending],
    ['incomplete', [1, 2], ['s2', 's3']])
  check('  └─ the reason says so rather than only that the run stopped',
    unreviewedWave.result.reasons.some((r) => r.startsWith('scope: ') && r.includes('never reviewed') && r.includes('s3')), true)
  check('  └─ and s3 never ran', unreviewedWave.calls.includes('impl:s3'), false)

  // ---- A run with review turned off can never be `ready`: `not-run` is not `clean`, and the gate
  // says which of the two it is rather than letting the absence read as a pass.
  const noReview = await run({ args: { review: false } })
  check('a run with no review is never ready',
    [verdictOf(noReview.result), noReview.result.gates.review], ['ready-with-unverified', 'not-run'])
  check('  └─ and the reason says why nothing reviewed it',
    [noReview.reviewArgs.length, noReview.result.reasons.some((r) => r.startsWith('review: ') && r.includes('disabled'))], [0, true])

  // ---- (4) AC-07: absence is not a failure. No criteria, no step claiming to cover one.
  const bare = await run({ criteria: [], steps: STEPS.map(({ covers, ...s }) => s) })
  check('no criteria and no covers is n/a, not a failure',
    [verdictOf(bare.result), bare.result.gates.acceptance, bare.result.coverage], ['ready', 'n/a', null])

  // A plan whose steps claim ids while the caller passed no canonical list: there is a claim, so this
  // is not `n/a` — but there is nothing to check it against, so it is not `passed` either.
  const noList = await run({ criteria: [] })
  check('covers without a criteria list proves nothing',
    [verdictOf(noList.result), noList.result.gates.acceptance, noList.result.coverage.criteria,
      noList.result.coverage.unknown.map((u) => u.id)],
    ['ready-with-unverified', 'unverified', [], ['AC-01', 'AC-02']])

  // ---- (5) The matrix's other two shapes.
  // A criterion no step covers does NOT block: a suite-level check is a legitimate cover, and the
  // matrix showing the empty row is the whole point of computing it.
  const uncovered = await run({ criteria: ['AC-01', 'AC-02', 'AC-04'] })
  check('an uncovered criterion downgrades, never blocks', verdictOf(uncovered.result), 'ready-with-unverified')
  check('  └─ it is listed, with the gate and the reason naming it',
    [uncovered.result.coverage.uncovered, uncovered.result.gates.acceptance, uncovered.result.reasons.some((r) => r.startsWith('acceptance: ') && r.includes('AC-04'))],
    [['AC-04'], 'uncovered', true])
  // ...and the checker is TOLD, instead of being asked to hunt for it in the plan's prose. This is
  // what makes computing coverage before the check worth anything.
  check('  └─ and the final checker is handed the id',
    String(uncovered.prompts['consistency-check']).includes('AC-04'), true)

  // An id the spec never declared addresses nothing, so it gets no row of its own — only `unknown`,
  // where it stays visible instead of looking like evidence attached to a criterion.
  const unknownId = await run({ steps: [STEPS[0], { ...STEPS[1], covers: ['AC-99'] }] })
  check('an id no spec declares gets no row, only `unknown`',
    [unknownId.result.coverage.unknown, unknownId.result.coverage.criteria.map((c) => c.id), unknownId.result.coverage.uncovered],
    [[{ id: 'AC-99', steps: ['s2'] }], ['AC-01', 'AC-02'], ['AC-02']])

  // ---- (6) A SPLIT step: `covers` is declared on the plan step, and its evidence is the aggregate of
  // leaves that carry different ids. Looking the step up in the flattened leaves finds nothing, which
  // would read as `not-run` — so this row is what keeps the join on the top-level reports.
  const split = await run({
    steps: [{ ...STEPS[0], context_confidence: 'low' }],
    criteria: ['AC-01'],
    replies: {
      'scout:s1': {
        summary: 'too big', brief_path: '/w/briefs/s1.md', too_big: true, split_reason: 'two independent surfaces',
        substeps: [
          { id: 's1a', title: 'a', goal: 'a', files: ['src/a1.ts'], depends_on: [], verify: 'node tests/a1.test.js', details: 'the first surface' },
          { id: 's1b', title: 'b', goal: 'b', files: ['src/a2.ts'], depends_on: [], verify: 'node tests/a2.test.js', details: 'the second surface' },
        ],
      },
      'scout:s1a': { summary: 'ok', brief_path: '/w/briefs/s1a.md', too_big: false },
      'scout:s1b': { summary: 'ok', brief_path: '/w/briefs/s1b.md', too_big: false },
      'impl:s1a': implReply('s1a', OK('node tests/a1.test.js', 'new-test')),
      'impl:s1b': implReply('s1b', OK('node tests/a2.test.js', 'new-test')),
    },
  })
  check('a split step\'s criterion is covered by its leaves', rowFor(split.result, 'AC-01'),
    { id: 'AC-01', covered_by: ['s1'], status: 'passed', unsubstantiated_by: [],
      checks: [{ step: 's1a', command: 'node tests/a1.test.js', status: 'passed', weak_evidence: false },
        { step: 's1b', command: 'node tests/a2.test.js', status: 'passed', weak_evidence: false }] })
  check('  └─ and the run is ready on that evidence', verdictOf(split.result), 'ready')

  // ---- (7) An INHERITED leaf, folded in from an earlier run. It carries `unverified`/`weak_evidence`
  // and no `status` at all: reading `status` alone would file this passed step as unverified and
  // downgrade a criterion that is actually done.
  const inherited = await run({
    args: { completed: [{ id: 's1', changed_files: ['src/a.ts'], notes_paths: ['/w/notes/s1.md'], brief_path: '/w/briefs/s1.md' }] },
    replies: { 'impl:s1': undefined },
  })
  check('an inherited leaf reads as passed, not unverified', rowFor(inherited.result, 'AC-01'),
    { id: 'AC-01', covered_by: ['s1'], status: 'passed', unsubstantiated_by: [], checks: [{ step: 's1', command: null, status: 'passed', weak_evidence: false }] })
  check('  └─ and it never re-implements the step it inherited',
    [inherited.calls.includes('impl:s1'), verdictOf(inherited.result)], [false, 'ready'])

  // ---- (8) A bare `suite_run: {ran: true}` from the consistency check — no command, no passed — is
  // worth exactly what no suite result is worth, never a substantiated pass. Mirrors THE HOLE the
  // per-step `verify_run` discipline already closes (tests/verify-gate.test.js): `ran` is a claim,
  // `command` and `passed` are its evidence.
  const bareSuiteRan = await run({ replies: { 'consistency-check': { consistent: true, issues: [], suite_run: { ran: true } } } })
  check('a bare suite_run.ran claim is not a substantiated pass',
    [verdictOf(bareSuiteRan.result), bareSuiteRan.result.gates.tests], ['ready-with-unverified', 'not-run'])
  const suiteRanNoPassed = await run({ replies: { 'consistency-check': { consistent: true, issues: [], suite_run: { ran: true, command: 'sh tests/run-all.sh' } } } })
  check('  └─ ran=true plus a command but no passed is the same unevidenced claim',
    suiteRanNoPassed.result.gates.tests, 'not-run')

  // ---- (9) The consistency-check agent itself comes back unavailable on a run that did NOT stop
  // early — mirrors `implUnavailable` above, but for the one agent that checks how every step
  // COMPOSES. A silent null must not read as a downgrade to `ready-with-unverified`: it blocks.
  const checkUnavailable = await run({ replies: { 'consistency-check': null } })
  check('an unavailable consistency-check agent blocks, not just downgrades', verdictOf(checkUnavailable.result), 'blocked')
  check('  └─ even though every step passed its own check',
    checkUnavailable.result.reports.every((r) => r.status === 'passed'), true)
  check('  └─ and gates.review names it, not a silent "nothing reviewed this"', checkUnavailable.result.gates.review, 'blocked')

  // ---- (10) A CONTINUATION run where an earlier step is already done AND already reviewed
  // (`reviewed: true` in args.completed) — the normal shape after a clean multi-session continuation.
  // It must read as complete, not as still pending, its criterion must read as passed, not
  // unverified, and it must survive back out through `continuation.completed` — or a THIRD
  // continuation round loses it and re-implements work that finished two rounds ago.
  const reviewedContinuation = await run({
    args: { completed: [{ id: 's1', reviewed: true, changed_files: ['src/a.ts'], notes_paths: ['/w/notes/s1.md'], brief_path: '/w/briefs/s1.md' }] },
  })
  check('a step already done and reviewed reads as complete, not pending',
    [verdictOf(reviewedContinuation.result), reviewedContinuation.result.gates.scope, reviewedContinuation.result.continuation.pending],
    ['ready', 'within-plan', []])
  check('  └─ its criterion reads passed, not unverified', rowFor(reviewedContinuation.result, 'AC-01').status, 'passed')
  check('  └─ and it survives back out through continuation.completed, so a third round would not lose it',
    reviewedContinuation.result.continuation.completed.some((c) => c.id === 's1'), true)
  check('  └─ and it never re-implements the step it already finished',
    reviewedContinuation.calls.includes('impl:s1'), false)

  // ---- (11) A checkpoint blocks on an otherwise fully-implemented, fully-reviewed LAST wave —
  // nothing is actually incomplete, so `scope` must not say it is, and the fabricated `finalCheck`
  // placeholder must not manufacture a second severe issue on top of the checkpoint's own verdict.
  const blockedLastWave = await run({
    steps: [STEPS[0]],
    criteria: ['AC-01'],
    review: { clean: false, rounds: 1, confirmed: [{ id: 'f1', severity: 'critical', title: 't' }], applied: [], skipped: [] },
  })
  check('a checkpoint blocked on a fully-implemented last wave still blocks, via review',
    [verdictOf(blockedLastWave.result), blockedLastWave.result.gates.review], ['blocked', 'blocked'])
  check('  └─ but scope is NOT incomplete — nothing was actually left undone',
    [blockedLastWave.result.gates.scope, blockedLastWave.result.continuation.pending, blockedLastWave.result.unreviewedWaves],
    ['within-plan', [], []])
  check('  └─ the placeholder does not manufacture its own severe issue on top of the checkpoint\'s',
    (blockedLastWave.result.finalCheck.issues || []).some((i) => i.severity === 'high' || i.severity === 'critical'), false)
  check('  └─ so the reasons do not falsely claim leftover implementation work',
    blockedLastWave.result.reasons.some((r) => r.startsWith('scope: ')), false)

  // `gates.review` reads TWO sources and only one of them can be isolated by behavior: a blocked
  // checkpoint ALWAYS stops the run, and a stopped run whose waves/steps are genuinely incomplete
  // carries a fabricated unfixed high issue of its own, so a row blocking on the checkpoint would
  // block on the placeholder too (case (11) above is the one shape where it does not, precisely
  // because nothing there is genuinely incomplete). The checkpoint source is guarded over the source
  // text instead — fail closed if the expression moves, and proven to bite on a copy with that
  // disjunct removed, since a check that silently stops testing is worse than none.
  function reviewGateReadsCheckpoints(text) {
    const at = text.indexOf('\n  review: ')
    const end = at === -1 ? -1 : text.indexOf("? 'blocked'", at)
    if (at === -1 || end === -1) return false
    return /blockedCheckpoints/.test(text.slice(at, end))
  }
  check('gates.review still reads the checkpoints\' own decision', reviewGateReadsCheckpoints(SRC), true)
  check('  └─ and it goes red when that source is dropped',
    reviewGateReadsCheckpoints(SRC.replace('blockedCheckpoints.length || ', '')), false)

  // Every verdict the script can produce is exercised above, and every verdict exercised is one the
  // script still declares — the second half is what stops this file from testing a word that moved.
  check('all three verdicts are exercised', [...seenVerdicts].sort(), [...DELIVERY_VERDICTS].sort())

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
