// The post-fix check: after a review round APPLIES fixes, one agent runs the repo's own executable
// check and wf-review-loop classifies that agent's claim with the same truth table wf-implement
// applies to an implementer's `verify_run`. Two things are being pinned here.
//
// 1. `clean: true` can no longer be returned over a tree nobody ran. A substantiated pass clears it;
//    an honest "it never ran, because X" clears it; a bare `ran: true` claiming no command or no
//    result does NOT — it is worth exactly as much as no check, minus the honesty.
// 2. A check that ran and FAILED buys exactly one repair attempt, and the repair's own files join the
//    next round's re-review scope. Without that append the repair would be the only code in the run
//    nobody reviewed, which trades one hole for another — so a case asserts the re-review prompt
//    names a repaired file.
//
// Everything is asserted through the real entry point, with `agent` stubbed BY LABEL and throwing on
// an unexpected one: "no command available" must spawn ZERO agents, and an agent that should not have
// run fails the test instead of quietly costing money. Reason strings are read off the source rather
// than restated, because a string copied into a test drifts exactly like prose.
const fs = require('fs')
const path = require('path')

const RAW = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-review-loop.js'), 'utf8')
const SRC = RAW.replace(/^export const meta/m, 'const meta')

// Brace-matched extraction (as tests/continuation.test.js does) — fail closed if a name moves.
function extract(signature) {
  const at = RAW.indexOf(signature)
  if (at === -1) throw new Error(`could not find ${signature} — has it been renamed?`)
  let depth = 0
  for (let i = RAW.indexOf('{', at); i < RAW.length; i++) {
    if (RAW[i] === '{') depth++
    else if (RAW[i] === '}' && --depth === 0) return RAW.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

// The script's own words for why a check was skipped or degraded. Pinned by a distinctive fragment
// and fail-closed on 0 or 2+ matches: if the wording changes past recognition the test breaks loudly
// instead of asserting a stale sentence.
const literals = (body) => [...body.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1])
const SKIP_REASONS = literals(extract('async function runFixCheck('))
const CLASSIFY_REASONS = literals(extract('function classifyCheck('))
function pin(list, fragment) {
  const found = list.filter((s) => s.includes(fragment))
  if (found.length !== 1) throw new Error(`expected exactly one source string containing "${fragment}", found ${found.length}`)
  return found[0]
}
const skipped = (fragment) => pin(SKIP_REASONS, fragment)
const degraded = (fragment) => pin(CLASSIFY_REASONS, fragment)

const clearsClean = new Function(`${extract('function clearsClean(')}\nreturn clearsClean`)()
const classifyCheck = new Function(`${extract('function classifyCheck(')}\nreturn classifyCheck`)()

// ---- Harness: seeded-review.test.js's, plus a caller-supplied budget stub built from the LIVE
// `calls` array, which is the only way to say "the floor was reached at this point in the run".
const NO_FLOOR = () => ({ total: null, spent: () => 0, remaining: () => Infinity })

function run(args, replies, budgetFor) {
  const calls = []
  const prompts = {}
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    // Exact match first: `check r1` is a PREFIX of `check r1 (retry)`, so prefix-only matching would
    // make a round's two checks indistinguishable and the retry unstubable.
    const key = Object.keys(replies).find((k) => k === opts.label) || Object.keys(replies).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    prompts[opts.label] = prompt
    return replies[key]
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn(args, () => {}, agent, parallel, parallel, () => {}, async () => ({}), (budgetFor || NO_FLOOR)(calls))
    .then((result) => ({ result, calls, prompts }))
}

// A real budget only falls, which is what this one does: generous until `label` has run, under the
// floor afterwards.
const dropAfter = (label) => (calls) => ({
  total: 300000, spent: () => 0, remaining: () => (calls.includes(label) ? 19000 : 50000),
})
// This one deliberately is NOT monotone. All three floors read the same remaining(), so proving that
// the CHECK's floor is what stopped the check needs the dip to land on exactly the read runFixCheck
// makes: a monotone stub would trip round 2's entry floor (30000) instead and prove nothing about
// the check.
const dipOnceAfter = (label) => (calls) => {
  let dipped = false
  return {
    total: 300000,
    spent: () => 0,
    remaining: () => {
      if (!calls.includes(label) || dipped) return 50000
      dipped = true
      return 19000
    },
  }
}

const CMD = 'sh tests/run-all.sh'
const SEED = [{ id: 'f1', title: 'unchecked null deref', file: 'src/a.ts', line: 12, severity: 'high', confirmed: true }]
const FIXED = { applied: [{ id: 'f1', title: 'unchecked null deref', file: 'src/a.ts', what: 'guarded the deref' }], skipped: [] }
// Seeded findings keep a round down to fix + check + re-review, so the call sequence is readable.
const BASE = { scope: 'src/a.ts', intent: 'ship the queue change', apply: true, maxRounds: 2, seedFindings: SEED, verifyCommand: CMD }
const REPLIES = { 'fix r1': FIXED, 're-review r2': { findings: [] } }
const DECLINED = { repaired: false, abandoned_because: 'the only route to green reverts the confirmed fix' }

let failed = 0
let cases = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  cases++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

// [ran, passed, not_ran_reason, clean] — the four values a caller acts on.
const truth = (r) => {
  const fv = r.result.fix_verify
  return [fv ? fv.ran : null, fv && fv.passed !== undefined ? fv.passed : null, (fv && fv.not_ran_reason) || null, r.result.clean]
}

async function row(name, { args, replies, budget }, expected, expectedCalls) {
  const r = await run({ ...BASE, ...args }, { ...REPLIES, ...replies }, budget)
  check(name, truth(r), expected)
  check(`  └─ agents it spawned`, r.calls, expectedCalls)
  return r
}

async function main() {
  // ---- The truth table, through the entry point.
  await row('substantiated pass unlocks clean',
    { replies: { 'check r1': { ran: true, command: CMD, passed: true } } },
    [true, true, null, true], ['fix r1', 'check r1', 're-review r2'])

  const failing = { ran: true, command: CMD, passed: false, output_summary: 'tests/rules.test.js: 1 case fails, caused by the applied fix' }
  const red = await row('substantiated failure blocks clean, and no re-review follows',
    { replies: { 'check r1': failing, 'repair r1': DECLINED } },
    [true, false, null, false], ['fix r1', 'check r1', 'repair r1'])
  check('the failure survives into the report', red.result.fix_verify.output_summary, failing.output_summary)
  check('and a declined repair leaves one attempt', red.result.fix_verify.attempts, 1)
  check('a declined repair is not reported as a repair', red.result.repairs, undefined)

  const bare = await row('a bare ran=true claim blocks clean',
    { replies: { 'check r1': { ran: true } } },
    [true, null, degraded('naming the command'), false], ['fix r1', 'check r1'])
  // Decision: only a genuine red command buys a repair. There is nothing to repair here — just a
  // claim — and spawning a fixer against no reported failure is how a loop invents work.
  check('a degraded claim buys no repair attempt', bare.calls.some((c) => c.startsWith('repair')), false)

  await row('ran=true with a command but no result blocks clean',
    { replies: { 'check r1': { ran: true, command: CMD } } },
    [true, null, degraded('whether the check passed'), false], ['fix r1', 'check r1'])

  await row('a blank command with passed=true blocks clean',
    { replies: { 'check r1': { ran: true, command: '   ', passed: true } } },
    [true, true, degraded('naming the command'), false], ['fix r1', 'check r1'])

  await row('a failure naming no command is still a failure',
    { replies: { 'check r1': { ran: true, passed: false }, 'repair r1': DECLINED } },
    [true, false, null, false], ['fix r1', 'check r1', 'repair r1'])

  await row('ran=false with a reason is honest, so clean stays reachable',
    { replies: { 'check r1': { ran: false, not_ran_reason: 'no node runtime in this container' } } },
    [false, null, 'no node runtime in this container', true], ['fix r1', 'check r1', 're-review r2'])

  await row('ran=false with no reason gets the default one',
    { replies: { 'check r1': { ran: false } } },
    [false, null, degraded('no reason given'), true], ['fix r1', 'check r1', 're-review r2'])

  await row('an unavailable check agent degrades to a skip',
    { replies: { 'check r1': null } },
    [false, null, skipped('unavailable'), true], ['fix r1', 'check r1', 're-review r2'])

  // ---- No command, no agent. seeded-review.test.js asserts closed call sequences for runs that pass
  // no verifyCommand, so a skip must spawn NOTHING rather than an agent reporting ran: false.
  const NONE = ['fix r1', 're-review r2']
  await row('verifyCommand: false opts out entirely',
    { args: { verifyCommand: false } },
    [false, null, skipped('opted out'), true], NONE)

  await row('no verifyCommand at all spawns nothing',
    { args: { verifyCommand: undefined } },
    [false, null, skipped('no verifyCommand'), true], NONE)

  await row('a blank verifyCommand is no command',
    { args: { verifyCommand: '   ' } },
    [false, null, skipped('no verifyCommand'), true], NONE)

  await row('the budget floor stops the check before it spawns',
    { budget: dipOnceAfter('fix r1') },
    [false, null, skipped('budget floor'), true], NONE)

  await row('a fixer that applied nothing leaves nothing to check',
    { replies: { 'fix r1': { applied: [], skipped: [] } } },
    [false, null, skipped('applied nothing'), true], NONE)

  // ---- Placement: the check must land BEFORE the unresolved-fix exit, or the "some fixes were
  // skipped" path returns no fix_verify at all.
  await row('a skipped fix still gets its check first',
    { replies: { 'fix r1': { applied: FIXED.applied, skipped: [{ id: 'f2', title: 'other', reason: 'needs an approach decision' }] }, 'check r1': { ran: true, command: CMD, passed: true } } },
    [true, true, null, false], ['fix r1', 'check r1'])

  // ---- apply: false changed nothing, so there is nothing to check — /dev-pr --review stays
  // side-effect free by construction, not by prompt.
  const reportOnly = await run(
    { scope: 'src/a.ts', intent: 'x', apply: false, maxRounds: 1, verifyCommand: CMD },
    {
      'review:': { findings: [{ id: 'n1', title: 'x', file: 'src/a.ts', line: 1, severity: 'low' }] },
      'verify:batch r1': { findings: [{ id: 'n1', title: 'x', file: 'src/a.ts', line: 1, severity: 'low', confirmed: true }] },
    })
  check('apply: false spawns no check', reportOnly.calls, ['review:runtime-contracts r1', 'review:intent-verification r1', 'verify:batch r1'])
  check('and returns no fix_verify to gate on', reportOnly.result.fix_verify, undefined)

  // ---- The check is metered, so its spend shows up in the per-phase report rather than vanishing
  // into whichever phase happened to be open.
  const spending = () => { let spent = 0; return { total: null, spent: () => (spent += 1000), remaining: () => Infinity } }
  const metered = await run(BASE, { ...REPLIES, 'check r1': { ran: true, command: CMD, passed: true } }, spending)
  check('cost.by_phase accounts for the check', Object.keys(metered.result.cost.by_phase).includes('check'), true)
  check('and it is a real delta, not a zero', metered.result.cost.by_phase.check > 0, true)

  // ---- The repair attempt.
  const REPAIR = { repaired: true, summary: 'updated the caller the fix missed', changed_files: ['src/caller.ts'] }
  const repaired = await row('a repaired check lets the round finish',
    { replies: { 'check r1': failing, 'repair r1': REPAIR, 'check r1 (retry)': { ran: true, command: CMD, passed: true } } },
    [true, true, null, true], ['fix r1', 'check r1', 'repair r1', 'check r1 (retry)', 're-review r2'])
  check('the retry is counted', repaired.result.fix_verify.attempts, 2)
  check('and clean: true says the check was repaired', repaired.result.fix_verify.repaired, true)
  check('the repair is reported, not hidden', (repaired.result.repairs || []).map((r) => r.changed_files), [REPAIR.changed_files])
  // The load-bearing half of decision 1: a repair nobody reviews trades one hole for another.
  check('the re-review reads the repaired file too', String(repaired.prompts['re-review r2']).includes(REPAIR.changed_files[0]), true)
  check('and the returned applied list stays the fixer\'s own', repaired.result.applied.map((a) => a.id), ['f1'])

  await row('a repair that claims success but stays red still blocks',
    { replies: { 'check r1': failing, 'repair r1': REPAIR, 'check r1 (retry)': { ran: true, command: CMD, passed: false, output_summary: 'same failure' } } },
    [true, false, null, false], ['fix r1', 'check r1', 'repair r1', 'check r1 (retry)'])

  await row('an unavailable repair agent counts as declined',
    { replies: { 'check r1': failing, 'repair r1': null } },
    [true, false, null, false], ['fix r1', 'check r1', 'repair r1'])

  await row('the budget floor cancels the repair, not the check',
    { replies: { 'check r1': failing }, budget: dropAfter('check r1') },
    [true, false, null, false], ['fix r1', 'check r1'])

  // A recheck that never RAN must not overturn a red one. "No check ran, because X" clears `clean` on
  // its own, so a skipped recheck would launder the failure through the budget floor or an unavailable
  // agent — the exact laundering this whole change exists to prevent, one level deeper.
  const starved = await row('a recheck the budget cancels leaves the failure standing',
    { replies: { 'check r1': failing, 'repair r1': REPAIR }, budget: dropAfter('repair r1') },
    [true, false, null, false], ['fix r1', 'check r1', 'repair r1'])
  check('the unrun recheck is recorded, not silent',
    String(starved.result.fix_verify.output_summary).includes(skipped('budget floor')), true)
  check('and it still counts as the second attempt', [starved.result.fix_verify.attempts, starved.result.fix_verify.repaired], [2, true])

  await row('an unavailable recheck agent leaves the failure standing too',
    { replies: { 'check r1': failing, 'repair r1': REPAIR, 'check r1 (retry)': null } },
    [true, false, null, false], ['fix r1', 'check r1', 'repair r1', 'check r1 (retry)'])

  // A repair that claims success but names no file it touched is unreviewable: the next round's
  // targeted re-review reads exactly `applied`/`repairs`, so an accepted-but-undocumented repair
  // would let whatever it actually edited land outside anyone's scope. It must be treated like a
  // decline — no retry, original failure intact — not waved through to the recheck.
  const UNDOCUMENTED_REPAIR = { repaired: true, summary: 'patched the ci script' }
  const undocumented = await row('a repair that names no changed_files is not accepted',
    { replies: { 'check r1': failing, 'repair r1': UNDOCUMENTED_REPAIR } },
    [true, false, null, false], ['fix r1', 'check r1', 'repair r1'])
  check('no retry is spawned for an undocumented repair', undocumented.calls.includes('check r1 (retry)'), false)
  check('it is not reported as an accepted repair', undocumented.result.repairs, undefined)
  check('fix_verify.repaired stays unset', undocumented.result.fix_verify.repaired, undefined)
  check('and the attempt count stays at one', undocumented.result.fix_verify.attempts, 1)

  // The recheck must re-verify the exact command the repair was validated against — including a
  // command the first check SUBSTITUTED for CHECK_COMMAND (checkPrompt allows this when
  // CHECK_COMMAND "cannot run as written") — not silently fall back to the original.
  const SUBSTITUTED = 'npm run test:ci'
  const substitutedFailing = { ran: true, command: SUBSTITUTED, passed: false, output_summary: 'ci script failed after the fix' }
  const resubstituted = await row('the recheck re-runs the substituted command, not CHECK_COMMAND',
    { replies: { 'check r1': substitutedFailing, 'repair r1': REPAIR, 'check r1 (retry)': { ran: true, command: SUBSTITUTED, passed: true } } },
    [true, true, null, true], ['fix r1', 'check r1', 'repair r1', 'check r1 (retry)', 're-review r2'])
  check('the retry is asked to run the substituted command',
    String(resubstituted.prompts['check r1 (retry)']).includes(SUBSTITUTED), true)
  check('not the original CHECK_COMMAND',
    String(resubstituted.prompts['check r1 (retry)']).includes(CMD), false)

  // ---- The return gate. It is unreachable through the entry point today — a check that does not
  // clear breaks the round with `clean` already false, and a ran:false verdict always carries a
  // reason — so no run above can prove the RETURN applies it. Two things stand in for that: the
  // returned expression is read off the source (fail closed: an ungated `clean` fails here), and the
  // predicate itself gets the same nine shapes below.
  const returned = RAW.slice(RAW.lastIndexOf('\nreturn {')).match(/\n {2}clean(?:: ([^,\n]+))?,/)
  if (!returned) throw new Error('could not read the returned `clean` field — has the return shape changed?')
  const expr = returned[1] || 'clean'
  const fromCheck = /clearsClean\(/.test(expr) || [...RAW.matchAll(/const (\w+) = clearsClean\(/g)].some((m) => expr.includes(m[1]))
  check('the returned clean is gated on the check', [expr !== 'clean', fromCheck], [true, true])

  check('no fix round ran → nothing to clear', clearsClean(null), true)
  const gate = [
    ['substantiated pass', { ran: true, command: CMD, passed: true }, true],
    ['substantiated failure', { ran: true, command: CMD, passed: false }, false],
    ['failure with no command', { ran: true, passed: false }, false],
    ['bare ran=true', { ran: true }, false],
    ['ran=true, no result', { ran: true, command: CMD }, false],
    ['ran=true, blank command', { ran: true, command: '   ', passed: true }, false],
    ['ran=false with a reason', { ran: false, not_ran_reason: 'no runtime' }, true],
    ['ran=false with no reason', { ran: false }, true],
    ['no reply at all', {}, true],
  ]
  check('the gate clears exactly the honest shapes',
    gate.map(([, verify]) => clearsClean(classifyCheck({ verify_run: verify }))), gate.map(([, , expected]) => expected))
  // A classified shape with the reason stripped is the one thing that must NOT clear: the honest
  // admission is the whole reason ran=false is allowed through.
  check('an unexplained non-run does not clear', clearsClean({ ran: false, unverified: true }), false)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
