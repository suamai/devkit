// Extracts the verification-classification block from the shipped workflows and runs the truth table
// against it. Not a copy of the logic — the real lines, read off disk.
//
// TWO scripts classify the same claim: wf-implement judges an implementer's `verify_run`, and
// wf-review-loop judges the post-fix check agent's identical reply. A self-contained workflow script
// cannot import a helper, so the block is copied — and a copy that drifts is two different gates
// wearing one name. Every row therefore runs against BOTH copies, and one case asserts the two
// slices are byte-identical.
const fs = require('fs')
const path = require('path')

const START = '  const verify = impl.verify_run || {}'
// The end anchor is the first line AFTER the classification in each file. Searched from the block
// start (not from 0) and fail-closed: a moved anchor must break the test, never silently shrink it.
const BLOCKS = [
  ['wf-implement.js', '  if (unverified) log('],
  ['wf-review-loop.js', '  return {'],
].map(([file, endAnchor]) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', file), 'utf8')
  const start = src.indexOf(START)
  const end = start === -1 ? -1 : src.indexOf(endAnchor, start)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`${file}: could not locate the classification block (start anchor ${start === -1 ? 'missing' : 'ok'}, end anchor ${JSON.stringify(endAnchor)})`)
  }
  return { file, src, body: src.slice(start, end) }
})

const cases = [
  ['verify_run missing',                {},                                                        { verifyFailed: false, unverified: true },  'no reason given'],
  ['ran=false with reason',             { verify_run: { ran: false, not_ran_reason: 'no runtime' } }, { verifyFailed: false, unverified: true }, 'no runtime'],
  ['ran=false without reason',          { verify_run: { ran: false } },                            { verifyFailed: false, unverified: true },  'no reason given'],
  ['ran=true, bare (THE HOLE)',         { verify_run: { ran: true } },                             { verifyFailed: false, unverified: true },  'claimed ran=true without naming the command it ran'],
  ['ran=true + command, no passed',     { verify_run: { ran: true, command: 'npm test' } },        { verifyFailed: false, unverified: true },  'claimed ran=true without reporting whether the check passed'],
  ['ran=true, blank command, passed',   { verify_run: { ran: true, command: '   ', passed: true } }, { verifyFailed: false, unverified: true }, 'claimed ran=true without naming the command it ran'],
  ['fully substantiated pass',          { verify_run: { ran: true, command: 'npm test', passed: true } },  { verifyFailed: false, unverified: false }, null],
  ['fully substantiated failure',       { verify_run: { ran: true, command: 'npm test', passed: false } }, { verifyFailed: true,  unverified: false }, null],
  ['failure without a command',         { verify_run: { ran: true, passed: false } },              { verifyFailed: true,  unverified: false },  null],
  // The typed fields are additive, and this shared core is deliberately BLIND to them: `status` and
  // `kind` change nothing about who is failed and who is unverified. That is what keeps the old three
  // fields the arbiter — and what lets wf-review-loop keep this table verbatim while knowing nothing
  // about an infra claim. Each of these rows classifies exactly as its untyped twin above.
  ['evidenced infra claim reads as a failure here',
    { verify_run: { ran: true, command: 'npm ci', passed: false, output_summary: 'registry 503', status: 'infra-error' } },
    { verifyFailed: true, unverified: false }, null],
  ['infra claim with ran=false keeps its own reason',
    { verify_run: { ran: false, not_ran_reason: 'docker is not installed', status: 'infra-error' } },
    { verifyFailed: false, unverified: true }, 'docker is not installed'],
  ['an existing-suite pass is still a pass',
    { verify_run: { ran: true, command: 'npm test', passed: true, kind: 'existing-suite' } },
    { verifyFailed: false, unverified: false }, null],
]

let failed = 0
let ran = 0
for (const { file, body } of BLOCKS) {
  const classify = new Function('impl', `${body}\nreturn { verifyFailed, unverified, unverifiedReason }`)
  console.log(`\n--- ${file}`)
  for (const [name, impl, expected, reason] of cases) {
    const got = classify(impl)
    const ok = got.verifyFailed === expected.verifyFailed && got.unverified === expected.unverified && got.unverifiedReason === reason
    ran++
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} failed=${String(got.verifyFailed).padEnd(5)} unverified=${String(got.unverified).padEnd(5)} reason=${JSON.stringify(got.unverifiedReason)}`)
    if (!ok) console.log(`      expected failed=${expected.verifyFailed} unverified=${expected.unverified} reason=${JSON.stringify(reason)}`)
  }
}

// Same rows passing twice would still allow two different tables that happen to agree on nine inputs.
// Byte equality is what makes them one gate.
console.log('')
const identical = BLOCKS.every((b) => b.body === BLOCKS[0].body)
ran++
if (!identical) failed++
console.log(`${identical ? 'PASS' : 'FAIL'}  ${'the copies are byte-identical'.padEnd(34)} ${BLOCKS.map((b) => `${b.file}=${b.body.length}b`).join(' ')}`)
if (!identical) {
  console.log('      the classification is copied, not imported — edit both copies in the same commit')
  for (const b of BLOCKS) console.log(`--- ${b.file}\n${b.body}`)
}

// --- The typed layer: wf-implement ONLY, and deliberately so.
//
// One thing the reply's shape cannot reveal is that the toolchain, not the code, is what went red —
// so `infra-error` is the one status an agent CLAIMS, and wf-implement is the only script that acts
// on it (it is the one that owns waves and can decide not to stop them). The layer therefore sits
// strictly AFTER the shared block's end anchor: everything above stays byte-identical with
// wf-review-loop, and this asymmetry is scope, not drift.
//
// It is four consts and no function, so it is fenced in the source rather than extracted by
// signature — the same shape tests/policy.test.js uses for the per-phase cost block, and fail-closed
// for the same reason: a marker that moved must throw here, not quietly shrink the slice to nothing.
const CORE = BLOCKS.find((b) => b.file === 'wf-implement.js')
const IMPL_SRC = CORE.src
const OPEN = '// >>> typed: verification status'
const CLOSE = '// <<< typed: verification status'
function fencedTyped(src) {
  const a = src.indexOf(OPEN)
  const b = src.indexOf(CLOSE)
  if (a === -1 || b === -1 || b <= a) {
    throw new Error(`wf-implement.js: typed-status fence missing (open ${a === -1 ? 'missing' : 'ok'}, close ${b === -1 ? 'missing' : 'ok'})`)
  }
  return src.slice(src.indexOf('\n', a) + 1, b)
}
// The two module-level helpers are the SINGLE definition of "what counts as an infra-error", read by
// both the retry gate and the table below. Pulled by line prefix, and missing one is a throw.
const helperLine = (prefix) => IMPL_SRC.split('\n').find((l) => l.startsWith(prefix))
  || (() => { throw new Error(`wf-implement.js: missing a line starting with ${JSON.stringify(prefix)}`) })()

// Composed exactly as the script has it: the two helpers, then the shared table above, then the
// fenced block. Its only free variables are what those lines already declare, so if the block ever
// starts reaching for `s`, `log` or `attempts`, this throws instead of drifting into a private copy.
const typedStatus = new Function('impl', [
  helperLine('const infraClaim ='),
  helperLine('const infraShown ='),
  CORE.body,
  fencedTyped(IMPL_SRC),
  'return { status, kind, weakEvidence }',
].join('\n'))

const typedCases = [
  // The four statuses, derived from the table above and nothing else.
  ['substantiated pass',                { ran: true, command: 'npm test', passed: true },                { status: 'passed',      kind: null, weakEvidence: false }],
  ['substantiated failure',             { ran: true, command: 'npm test', passed: false },               { status: 'failed',      kind: null, weakEvidence: false }],
  ['bare ran=true (THE HOLE)',          { ran: true },                                                   { status: 'not-run',     kind: null, weakEvidence: false }],
  ['honest ran=false',                  { ran: false, not_ran_reason: 'no runtime' },                    { status: 'not-run',     kind: null, weakEvidence: false }],
  // `infra-error` is CLAIMED, so it is evidenced or it is not one: the command tried AND the failure
  // observed. Half the evidence is no evidence — hence the third row.
  ['evidenced infra claim',             { ran: true, command: 'npm ci', passed: false, output_summary: 'registry 503', status: 'infra-error' },
                                                                                                         { status: 'infra-error', kind: null, weakEvidence: false }],
  ['infra claimed, ran=true, nothing shown',   { ran: true, status: 'infra-error' },                     { status: 'failed',      kind: null, weakEvidence: false }],
  ['infra claimed, command but no failure named', { ran: true, command: 'npm ci', passed: true, status: 'infra-error' },
                                                                                                         { status: 'failed',      kind: null, weakEvidence: false }],
  // DECISION 1: the degrade above is gated on the agent having claimed the check RAN. An honest
  // "it could not run at all" keeps its reason and stays not-run — the hatch is closed exactly where
  // it would have paid off, and nowhere else. Drop the `&& verify.ran === true` conjunct and this row
  // turns an honest non-run into a run-stopping failure.
  ['infra claimed, ran=false, a reason, no command',
    { ran: false, not_ran_reason: 'docker is not installed', status: 'infra-error' },                     { status: 'not-run',     kind: null, weakEvidence: false }],
  // Weak evidence: a pass whose check was already green before the step. Still VERIFIED — a
  // refactor's evidence IS the green suite — just marked, so the reviewer is asked.
  ['existing-suite pass is weak evidence',  { ran: true, command: 'npm test', passed: true, kind: 'existing-suite' },
                                                                                                         { status: 'passed',      kind: 'existing-suite', weakEvidence: true }],
  ['new-test pass is not',              { ran: true, command: 'npm test', passed: true, kind: 'new-test' },
                                                                                                         { status: 'passed',      kind: 'new-test', weakEvidence: false }],
  // DECISION 2: `kind` FAILS OPEN. A pass that declares none is not weak evidence (it is counted
  // elsewhere, as `kind_missing` — a calibration signal, never a gate).
  ['a pass with no kind at all',        { ran: true, command: 'npm test', passed: true },                { status: 'passed',      kind: null, weakEvidence: false }],
  // ...and weak evidence is a property of a PASS. A red check is a defect, and calling it weak on top
  // would send the reviewer looking for missing evidence instead of at the failure.
  ['existing-suite on a failure',       { ran: true, command: 'npm test', passed: false, kind: 'existing-suite' },
                                                                                                         { status: 'failed',      kind: 'existing-suite', weakEvidence: false }],
]

console.log('\n--- wf-implement.js (typed layer)')
// The extraction itself, proven to bite: an anchor that moves has to throw, because a slice that
// silently shrinks would leave this whole table passing against nothing. Mutated in memory, never on
// disk — a check that rewrites a tracked file corrupts the tree if it dies mid-run.
for (const [name, broken] of [['open', IMPL_SRC.replace(OPEN, '')], ['close', IMPL_SRC.replace(CLOSE, '')]]) {
  let threw = false
  try { fencedTyped(broken) } catch (e) { threw = /fence missing/.test(e.message) }
  ran++
  if (!threw) failed++
  console.log(`${threw ? 'PASS' : 'FAIL'}  ${`a missing ${name} marker throws`.padEnd(46)} ${threw}`)
}

for (const [name, verifyRun, expected] of typedCases) {
  const got = typedStatus({ verify_run: verifyRun })
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  ran++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}`)
}

console.log(failed ? `\n${failed}/${ran} FAILED` : `\nall ${ran} cases pass`)
process.exit(failed ? 1 : 0)
