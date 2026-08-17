// `/dev-review --from-report` seeds wf-review-loop with findings a persisted PR review already
// found AND already verified. The point is not that skipping the finders is cheaper — it is that
// running them again can MISS a finding the report had confirmed, silently dropping a defect.
// So these cases assert that no finder and no verifier runs, and that the honesty gate survives it:
// `clean: true` must still require an explicit post-fix pass that found nothing.
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-review-loop.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')

// One stub for every agent the loop can reach, keyed by label prefix. Anything not listed is an
// agent that should not have run — it fails the test rather than quietly returning something.
function run(args, replies) {
  const calls = []
  const agent = async (_prompt, opts) => {
    calls.push(opts.label)
    const key = Object.keys(replies).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    return replies[key]
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn(args, () => {}, agent, parallel, parallel, () => {}, async () => ({}),
    { total: null, spent: () => 0, remaining: () => Infinity }).then((result) => ({ result, calls }))
}

const SEED = [
  { id: 'f1', title: 'unchecked null deref', file: 'src/a.ts', line: 12, severity: 'high', confirmed: true },
  { id: 'f2', title: 'missing await', file: 'src/b.ts', line: 40, severity: 'critical', confirmed: true },
]
const BASE = { scope: 'src/a.ts, src/b.ts', intent: 'ship the queue change', apply: true, maxRounds: 2 }
const FIXED_BOTH = { applied: [{ id: 'f1', what: 'guarded' }, { id: 'f2', what: 'awaited' }], skipped: [] }

// The clustering ratio the run ledger reports is read off `raw`/`clustered`, never reconstructed
// from `merged_titles`. A pure predicate over a return object, so the mutation proof below is just a
// second call with a perturbed copy — nothing on disk is touched.
const reportsHonestPair = (r) =>
  typeof r.raw === 'number' && typeof r.clustered === 'number' && r.raw >= r.clustered

let failed = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

async function main() {
  // --- Seeded: straight to the fixer, then an explicit re-review.
  const seeded = await run({ ...BASE, seedFindings: SEED }, {
    'fix r1': FIXED_BOTH,
    're-review r2': { findings: [] },
  })
  check('no finder and no verifier runs', seeded.calls, ['fix r1', 're-review r2'])
  check('both seeded findings reach the fixer', seeded.result.applied.length, 2)
  check('and the run can be clean', seeded.result.clean, true)
  check('confirmed carries the seeds through', seeded.result.confirmed.map((f) => f.id), ['f1', 'f2'])

  // A critical seed does NOT buy a second opinion: it already had one when the report was written,
  // and the caller proved HEAD has not moved since.
  check('no critical second opinion on seeds', seeded.calls.some((c) => c.startsWith('verify:critical')), false)

  // Seeded findings arrive already clustered, so raw and clustered must be equal — a seeded run
  // honestly reports a clustering ratio of 1.0 rather than a flattering one.
  check('seeded raw equals seeded clustered',
    [seeded.result.raw, seeded.result.clustered, reportsHonestPair(seeded.result)], [SEED.length, SEED.length, true])
  // Mutation proof: the same predicate over an IN-MEMORY copy with `clustered` pushed past `raw`
  // must fail. Without it, the check above would keep passing if the counters silently stopped
  // tracking the findings at all.
  check('a perturbed copy fails the same predicate',
    reportsHonestPair({ ...seeded.result, clustered: seeded.result.raw + 1 }), false)

  // --- The honesty gate is unchanged. Skipping find/verify must not skip the proof.
  const stillBroken = await run({ ...BASE, seedFindings: SEED }, {
    'fix r1': FIXED_BOTH,
    're-review r2': { findings: [{ id: 'f3', title: 'the fix broke the retry path', file: 'src/a.ts', line: 14, severity: 'high' }] },
    'verify:batch r2': { findings: [{ id: 'f3', title: 'the fix broke the retry path', file: 'src/a.ts', line: 14, severity: 'high', confirmed: true }] },
    'fix r2': { applied: [{ id: 'f3', what: 'restored' }], skipped: [] },
  })
  check('a post-fix regression is not clean', stillBroken.result.clean, false)
  check('round 2 verifies normally', stillBroken.calls, ['fix r1', 're-review r2', 'verify:batch r2', 'fix r2'])

  // A fix the fixer refuses can never be reported clean, seeded or not.
  const refused = await run({ ...BASE, seedFindings: SEED }, {
    'fix r1': { applied: [{ id: 'f1', what: 'guarded' }], skipped: [{ id: 'f2', why: 'needs an approach decision' }] },
  })
  check('a skipped fix leaves clean false', [refused.result.clean, refused.result.skipped.length], [false, 1])

  // --- Without seeds, nothing changes: the normal path still finds, then verifies, then fixes.
  const normal = await run(BASE, {
    'review:': { findings: [{ id: 'n1', title: 'x', file: 'src/a.ts', line: 1, severity: 'low' }] },
    'verify:batch r1': { findings: [{ id: 'n1', title: 'x', file: 'src/a.ts', line: 1, severity: 'low', confirmed: true }] },
    'fix r1': { applied: [{ id: 'n1', what: 'fixed' }], skipped: [] },
    're-review r2': { findings: [] },
  })
  check('unseeded path still sweeps first',
    [normal.calls.filter((c) => c.startsWith('review:')).length, normal.calls.includes('verify:batch r1')], [2, true])
  check('and reaches clean the long way', normal.result.clean, true)

  // The unseeded path is where clustering actually happens: every lens reported the same defect and
  // the verifier returned one cluster for them, so raw must exceed clustered here.
  const lensFindings = normal.calls.filter((c) => c.startsWith('review:')).length
  check('raw counts findings, clustered counts clusters',
    [normal.result.raw, normal.result.clustered], [lensFindings, 1])

  // Junk in seedFindings is dropped rather than handed to a fixer as a finding with no identity.
  const junk = await run({ ...BASE, seedFindings: [null, {}, SEED[0]] }, { 'fix r1': { applied: [{ id: 'f1' }], skipped: [] }, 're-review r2': { findings: [] } })
  check('entries with no id or title are dropped', junk.result.confirmed.length, 1)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${14} cases pass`)
  process.exit(failed ? 1 : 0)
}

main()
