// The typed verification contract, driven through wf-implement's REAL entry point.
//
// tests/verify-gate.test.js pins the truth TABLE — a pure function of one reply. This file pins what
// the run DOES with it, which no table can show: that an evidenced `infra-error` buys exactly one
// cheap re-run and does not stop the dependent wave, that an unevidenced one buys no agent at all,
// that a step verified only by an already-green check stays verified while reaching the checkpoint
// reviewer, and that a pass which declared no `kind` is counted without being gated on.
//
// Every claim is asserted through a real two-wave run: the whole script wrapped in `new Function`,
// `agent` stubbed BY LABEL and throwing on an unlisted one — so an agent that should not have run is
// a test failure rather than a surprise bill — and `workflow` stubbed to capture the args a
// checkpoint hands its review loop, which is the only place the `priority` block is observable.
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-implement.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')

// AC-04's baseline question, read off the source rather than retyped — a copy drifts exactly like
// restated prose does. Fail closed: a moved or reworded bullet breaks this test instead of the
// assertion silently checking a sentence the prompt no longer contains.
const BASELINE_QUESTION_ANCHOR = 'answer this: '
const baselineStart = SRC.indexOf(BASELINE_QUESTION_ANCHOR)
const baselineEnd = baselineStart === -1 ? -1 : SRC.indexOf('?', baselineStart)
if (baselineStart === -1 || baselineEnd === -1) throw new Error('could not locate the AC-04 baseline question in wf-implement.js')
const BASELINE_QUESTION = SRC.slice(baselineStart + BASELINE_QUESTION_ANCHOR.length, baselineEnd + 1)

// context_confidence: 'high' on both steps so `needsScout` returns false and no scout is spawned:
// this file is about verification, and a scout reply would only be noise in `calls`. s2 depends on s1,
// so "the next wave still ran" is a real question and not an artefact of ordering.
const STEPS = [
  { id: 's1', title: 'the typed contract', goal: 'add the typed verification contract', files: ['src/a.ts'], depends_on: [], verify: 'node tests/a.test.js', context_confidence: 'high', details: 'add the fields and derive the status from the existing table rather than asking the agent for it' },
  { id: 's2', title: 'wire it', goal: 'consume the typed contract in the reporter', files: ['src/b.ts'], depends_on: ['s1'], verify: 'node tests/b.test.js', context_confidence: 'high', details: 'read the new fields in the reporter and print them next to the existing unverified line' },
]

const implReply = (id, verify, extra) => ({
  summary: `${id} implemented`,
  changed_files: [`src/${id}.ts`],
  notes_path: `/w/notes/${id}.md`,
  verify_run: verify,
  ...extra,
})

const OK = (command, kind) => ({ ran: true, command, passed: true, output_summary: 'green', ...(kind ? { kind } : {}) })
const BASE_REPLIES = {
  'impl:s2': implReply('s2', OK('node tests/b.test.js', 'new-test')),
  'consistency-check': { consistent: true, issues: [] },
}

// checkpointMaxWaves: 1 makes every wave flush, so both waves reach a checkpoint and the `priority`
// block is observable for either step. gate: false keeps `calls` down to the agents under test.
function run(replies, stepOverrides) {
  const calls = []
  const prompts = {}
  const reviewArgs = []
  const merged = { ...BASE_REPLIES, ...replies }
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    // Exact match first: a prefix-only lookup would make `impl:s1` and `impl:s10` the same key.
    const key = Object.keys(merged).find((k) => k === opts.label) || Object.keys(merged).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    prompts[opts.label] = prompt
    return merged[key]
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()))
  const workflow = async (ref, wargs) => {
    reviewArgs.push(wargs)
    return { clean: true, rounds: 1, confirmed: [], applied: [], skipped: [] }
  }
  const steps = STEPS.map((s) => ({ ...s, ...((stepOverrides || {})[s.id] || {}) }))
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn({ workspace: '/w', steps, checkpointMaxWaves: 1, gate: false },
    () => {}, agent, parallel, parallel, () => {}, workflow,
    { total: null, spent: () => 0, remaining: () => Infinity })
    .then((result) => ({ result, calls, prompts, reviewArgs }))
}

const reportFor = (result, id) => result.reports.find((r) => r.step === id) || {}

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
  // ---- (a) An evidenced infra-error is not a defect: one re-run, and the dependent wave still runs.
  const INFRA = { ran: true, command: 'npm ci', passed: false, output_summary: 'registry returned 503', status: 'infra-error' }
  const stillBroken = await run({
    'impl:s1': implReply('s1', INFRA),
    'verify:s1': { ran: true, command: 'npm ci', passed: false, output_summary: 're-ran npm ci; registry still 503', status: 'infra-error' },
  })
  const infraStep = reportFor(stillBroken.result, 's1')
  check('an evidenced infra-error buys exactly one re-run', stillBroken.calls,
    ['impl:s1', 'verify:s1', 'impl:s2', 'consistency-check'])
  check('  └─ and it is not read as a defect', [infraStep.failed, infraStep.status], [false, 'infra-error'])
  check('  └─ the second attempt is script-counted', infraStep.attempts, 2)
  check('  └─ the dependent wave still ran', [stillBroken.result.stoppedEarly, stillBroken.calls.includes('impl:s2')], [false, true])
  check('  └─ it is reported as an infra error, not silently', stillBroken.result.infraErrors.map((e) => [e.step, e.attempts]), [['s1', 2]])
  // Not a defect and still not verified: nothing executed this step, which is a different sentence
  // from "it passed" and has to stay one.
  check('  └─ and it is honestly unverified all the same', infraStep.unverified, true)

  // ---- (b) The point of the re-run: it can clear.
  const cleared = await run({
    'impl:s1': implReply('s1', INFRA),
    'verify:s1': { ran: true, command: 'npm ci && node tests/a.test.js', passed: true, kind: 'new-test', output_summary: 'npm ci re-run, suite green' },
  })
  const clearedStep = reportFor(cleared.result, 's1')
  check('a re-run that clears leaves a substantiated pass',
    [clearedStep.status, clearedStep.attempts, clearedStep.unverified], ['passed', 2, false])
  check('  └─ and the run completes', cleared.calls.includes('consistency-check'), true)

  // ---- (c) The re-run is not an escape hatch: a genuine red is a genuine red.
  const red = await run({
    'impl:s1': implReply('s1', INFRA),
    'verify:s1': { ran: true, command: 'node tests/a.test.js', passed: false, output_summary: 'a.test.js: 2 cases fail' },
  })
  const redStep = reportFor(red.result, 's1')
  check('a re-run that comes back red fails the step', [redStep.failed, redStep.status, redStep.stage], [true, 'failed', 'verify'])
  check('  └─ and the run stops before the dependent wave',
    [red.calls, red.result.stoppedEarly, String(red.result.stopReason).includes('s1:verify')],
    [['impl:s1', 'verify:s1'], true, true])

  // ---- (d) An unevidenced infra claim that says the check RAN buys no agent and degrades.
  // The reply below would be a substantiated NOTHING without the degrade — ran=true, passed=true, no
  // command — so `not-run` is what the shared table alone would say. `failed` is the typed layer
  // closing the hatch: an infra claim naming neither a command nor a failure is not an infra-error.
  const bluffing = await run({
    'impl:s1': implReply('s1', { ran: true, passed: true, status: 'infra-error', output_summary: 'the registry was down' }),
  })
  const bluffStep = reportFor(bluffing.result, 's1')
  check('an unevidenced infra claim buys no re-run', bluffing.calls.includes('verify:s1'), false)
  check('  └─ it degrades to a failure and stops the run',
    [bluffStep.failed, bluffStep.status, bluffStep.attempts, bluffing.result.stoppedEarly], [true, 'failed', 1, true])
  check('  └─ and says which step failed where', String(bluffing.result.stopReason).includes('s1:verify'), true)
  // A step is either failed or unverified, never both — the typed `status` already resolved which one
  // this is, and the report has to agree with it instead of reusing the pre-typed table's verdict.
  check('  └─ and it is never ALSO reported unverified', bluffStep.unverified, false)

  // ---- (e) The honest path is untouched: ran=false keeps its own reason and does not stop anything.
  // The degrade above is gated on the agent having claimed the check RAN, precisely so that admitting
  // "I could not run it, and here is why" never costs more than staying silent would have.
  const honest = await run({
    'impl:s1': implReply('s1', { ran: false, not_ran_reason: 'docker is not installed in this container', status: 'infra-error' }),
  })
  const honestStep = reportFor(honest.result, 's1')
  check('an honest ran=false infra claim stays not-run',
    [honestStep.status, honestStep.failed, honestStep.attempts], ['not-run', false, 1])
  check('  └─ it buys no re-run either, and the run continues',
    [honest.calls.includes('verify:s1'), honest.calls.includes('impl:s2'), honest.result.stoppedEarly], [false, true, false])
  check('  └─ and it keeps the agent\'s own reason', honestStep.unverified_reason, 'docker is not installed in this container')

  // The three unverified shapes have to stay TELLABLE APART, because two of them are calibration
  // signals the developer watches (the honest non-run, the unevidenced claim) and the third is not a
  // defect at all. One shared string would collapse all three into one number.
  check('the three unverified reasons stay distinguishable',
    new Set([infraStep.unverified_reason, bluffStep.unverified_reason, honestStep.unverified_reason]).size, 3)

  // ---- (f) Weak evidence: verified, deliberately — and handed to the reviewer, with the deviations.
  const DEVIATION = { what: 'renamed exportedHelper to resolveHelper', why: 'the plan named a symbol that no longer exists' }
  const weak = await run({
    'impl:s1': implReply('s1', OK('node tests/a.test.js', 'existing-suite'), { deviations: [DEVIATION] }),
  })
  const weakStep = reportFor(weak.result, 's1')
  check('an already-green check is weak evidence, still verified',
    [weakStep.status, weakStep.weak_evidence, weakStep.unverified], ['passed', true, false])
  check('  └─ and it is reported with the command behind it',
    weak.result.weakEvidenceSteps, [{ step: 's1', command: 'node tests/a.test.js', changed_files: ['src/s1.ts'] }])
  const priority = String((weak.reviewArgs[0] || {}).priority || '')
  check('  └─ the checkpoint reviewer is told which step and which command',
    [priority.includes('s1'), priority.includes('existing-suite'), priority.includes('node tests/a.test.js')], [true, true, true])
  check('  └─ and the implementer\'s deviation reaches the same reviewer',
    [priority.includes(DEVIATION.what), priority.includes(DEVIATION.why)], [true, true])

  // ---- (g) `kind` fails open: a pass that declared none is counted, never gated on.
  const noKind = await run({ 'impl:s1': implReply('s1', OK('node tests/a.test.js')) })
  const noKindStep = reportFor(noKind.result, 's1')
  check('a pass with no kind is not weak evidence',
    [noKindStep.status, noKindStep.weak_evidence === true, noKindStep.failed, noKindStep.unverified], ['passed', false, false, false])
  check('  └─ but it is counted', noKind.result.kindMissing.includes('s1'), true)
  // The proof that the count is not a gate: nothing about it reaches the reviewer's priority block, so
  // it can never cost a review round. It is a number the developer watches, and that is all. The
  // checkpoint count travels with the assertion, or "no checkpoint mentioned s1" would also be true of
  // a run that held no checkpoints at all.
  check('  └─ and the count never reaches the reviewer',
    [noKind.reviewArgs.length, noKind.reviewArgs.some((a) => String(a.priority || '').includes('s1'))], [2, false])

  // ---- (h) AC-04: the implementer is asked the question that makes `kind` answerable at all.
  check('the implementer is asked the baseline question',
    String(noKind.prompts['impl:s1']).includes(BASELINE_QUESTION), true)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
