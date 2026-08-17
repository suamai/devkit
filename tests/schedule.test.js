// The dry-run schedule projection, exercised through the workflow's REAL entry point.
//
// This is the harness roadmap item 7(b) was after: the script is a function body with a top-level
// `return`, so wrapping the whole file in `new Function` and calling it with `dryRun: true` runs
// every scheduling decision — toWaves, disjoint/pathScope, globToRegExp/ruleMatchesFile, the
// checkpoint policy — and returns them, without a single agent. No anchor extraction, no copies of
// the logic, nothing rearranged in the script to make it testable.
//
// Two things the projection cannot reach are pinned here too, at the bottom: the args a checkpoint
// hands its review loop, and the gate that stops the run when the post-fix check failed. Both live in
// code no dryRun executes, so they are predicates over source text, each with an in-memory mutation
// proving it still bites.
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-implement.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')

const logs = []
// dryRun returns before any of these can be called; they exist so a regression that reaches an
// agent fails loudly here instead of silently costing money in a real run.
const boom = (what) => () => { throw new Error(`dryRun reached ${what}() — it must not spawn work`) }
function run(args) {
  logs.length = 0
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn(args, (m) => logs.push(m), boom('agent'), boom('parallel'), boom('pipeline'),
    () => {}, boom('workflow'), { total: null, spent: () => 0, remaining: () => Infinity })
}

const STEPS = [
  { id: 's1', goal: 'add the retry policy type', files: ['src/queue/policy.ts'], depends_on: [], verify: 'npm test -- policy', context_confidence: 'high' },
  { id: 's2', goal: 'wire it into the worker', files: ['src/queue/worker.ts'], depends_on: ['s1'], verify: 'npm test -- worker', risk: 'contract' },
  { id: 's3', goal: 'expose it in config', files: ['src/config/queue.ts'], depends_on: ['s1'], verify: 'npm test -- config', context_confidence: 'low' },
  { id: 's4', goal: 'docs', files: ['docs/queue.md'], depends_on: [], verify: 'npm run docs:check' },
  { id: 's5', goal: 'a second edit to the same worker file', files: ['src/queue/worker.ts'], depends_on: ['s1'], verify: 'npm test' },
]
const RULES = [
  { path: '.claude/rules/queue.md', globs: ['src/queue/**/*.ts'] },
  { path: '.claude/rules/style.md', globs: [] },
]

// The checkpoint's post-fix check is wired in the args of reviewCheckpoint, which no dryRun can
// reach — the projection mirrors the flush POLICY, not the call. Extracting that one function body
// by brace matching (same shape as tests/continuation.test.js) is the only thing that binds them,
// and it fails closed: a missing signature throws instead of passing vacuously.
function extract(signature, text) {
  const at = text.indexOf(signature)
  if (at === -1) throw new Error(`could not find ${signature} — has it been renamed?`)
  let depth = 0
  for (let i = text.indexOf('{', at); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

// A predicate over TEXT, so the negative case below can mutate a copy in memory. A drift check that
// only ever runs against the real file can silently stop testing; one that also runs against a
// deliberately broken copy cannot. (In memory, never a write: a check that corrupts the repo when it
// dies mid-run is worse than the drift it guards.)
function bindsCheckpointCommand(text) {
  // Found by signature rather than by name, so renaming the helper moves both sides at once and this
  // still holds — while dropping the arg, or passing it something other than the steps the checkpoint
  // is reviewing, goes red.
  const helper = (text.match(/\nfunction (\w+)\(steps\) \{/) || [])[1]
  if (!helper) return false
  return extract('async function reviewCheckpoint(', text).includes(`verifyCommand: ${helper}(pending.steps)`)
}

// The other half: a checkpoint whose post-fix check did not clear must block the run. "Every finding
// was applied" and "the tree still works" are different claims, and the wave loop is not a function,
// so there is nothing to extract and call — this reads the gate instead.
//
// It pins the DERIVATION, not just the name: the gate must be `checkRan && !checkCleared`, mirroring
// the review loop's `ran === true && !clearsClean(fv)`. Pinning only `fix_verify.failed` was the
// earlier version and it let the misleading case through — a check that claims `ran: true` and
// substantiates nothing is `failed: false`, so the run continued into dependent waves over a tree the
// skipped re-review never judged. If the loop's return shape is renamed, all three lines go red.
const CHECK_RAN_DECL = /\n *const (\w+) = !!\(fixVerify && fixVerify\.ran === true\)/
const CHECK_CLEARED_DECL = /\n *const (\w+) = !!\(fixVerify && fixVerify\.unverified !== true && fixVerify\.passed === true\)/
const CHECK_FAILED_DECL = /\n *const (\w+) = (\w+) && !(\w+)\n/
function blocksOnFailedCheck(text) {
  const ran = (text.match(CHECK_RAN_DECL) || [])[1]
  const cleared = (text.match(CHECK_CLEARED_DECL) || [])[1]
  const decl = text.match(CHECK_FAILED_DECL)
  if (!ran || !cleared || !decl) return false
  // The blocker must be derived from exactly those two, in that polarity — not from `failed` alone.
  if (decl[2] !== ran || decl[3] !== cleared) return false
  const name = decl[1]
  const at = text.indexOf('const reviewBlocked =')
  // The assignment ends where the next statement begins. A negative end index would make the slice
  // run to the end of the file and read as a pass, so an unfound anchor is a false, never a shrug.
  const end = at === -1 ? -1 : text.indexOf('\n  if (', at)
  if (at === -1 || end === -1) return false
  return text.slice(at, end).includes(name)
}

let failed = 0
let cases = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  cases++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

async function main() {
  const { schedule, policy } = await run({ dryRun: true, steps: STEPS, rules: RULES })
  const [w1, w2] = schedule.waves

  check('waves come from depends_on', schedule.waves.map((w) => w.steps.join('+')), ['s1+s4', 's2+s3+s5'])

  // The single most useful line before approving a plan: what actually runs at the same time.
  // s2 and s5 both own worker.ts, so the wave that looks three-wide is really two rounds.
  check('wave 1 runs fully parallel', w1.parallel_groups, [['s1', 's4']])
  check('overlapping files split a wave', w2.parallel_groups, [['s2', 's3'], ['s5']])
  check('and it is called out, not just implied',
    schedule.warnings.some((w) => w.includes('s2 and s5') && w.includes('overlapping files')), true)

  // The planner's own confidence decides; the heuristic is only the fallback.
  check('context_confidence drives scouting', [w1.scouts, w2.scouts], [['s4'], ['s2', 's3', 's5']])

  // Rules are matched per step, and an unscoped one reaches every step.
  check('scoped rule reaches only its area', w2.rules.s2, ['.claude/rules/queue.md', '.claude/rules/style.md'])
  check('unscoped rule reaches the rest', w2.rules.s3, ['.claude/rules/style.md'])

  // Checkpoint policy: wave 1 defers (2 files, 1 wave — both under the thresholds) and gets a gate
  // instead; wave 2 is last, so it flushes.
  check('a deferred wave gates instead', [w1.checkpoint === undefined, w1.gate], [true, { dependents: ['s2', 's3', 's5'] }])
  // ...and it carries the command it would hand its review loop: every covered step's own `verify`,
  // in wave then declaration order, joined with ' && ' so the first failure fails the check. This
  // checkpoint covers both waves, so all five steps' commands are in it.
  check('the last wave always checkpoints', w2.checkpoint,
    { number: 1, reason: 'final wave', waves_covered: 2, files: 4, verify_command: 'npm test -- policy && npm run docs:check && npm test -- worker && npm test -- config && npm test' })

  // A contract-risk step forces its own checkpoint — which is what makes wave 1 flush here.
  const risky = await run({ dryRun: true, steps: STEPS.map((s) => (s.id === 's1' ? { ...s, risk: 'contract' } : s)) })
  check('contract risk flushes immediately', risky.schedule.waves[0].checkpoint.reason, 'contract-risk step')

  // Thresholds are arguments, so the projection has to honour them too.
  const eager = await run({ dryRun: true, steps: STEPS, checkpointMaxWaves: 1 })
  check('checkpointMaxWaves is respected', eager.schedule.waves.map((w) => w.checkpoint && w.checkpoint.reason), ['1 waves pending', 'final wave'])

  // The combined command is the steps' own strings and nothing else: trimmed, blank ones dropped, a
  // step without `verify` contributing nothing, and duplicates collapsed — most plans give every step
  // the same command, so without the dedupe a checkpoint would run one suite once per step.
  const mixed = await run({ dryRun: true, steps: [
    { id: 'a', goal: 'a', files: ['a.ts'], depends_on: [], verify: 'npm test' },
    { id: 'b', goal: 'b', files: ['b.ts'], depends_on: [], verify: '   ' },
    { id: 'c', goal: 'c', files: ['c.ts'], depends_on: [] },
    { id: 'd', goal: 'd', files: ['d.ts'], depends_on: [], verify: ' npm test ' },
  ] })
  check('trimmed, deduped, blank and absent dropped', mixed.schedule.waves[0].checkpoint.verify_command, 'npm test')

  // The same collapse the line above is happy about is a plan smell one level up: `a` and `d` are two
  // steps standing on ONE check, so whichever runs first makes it green and the other's "verified" is
  // a suite that was already passing. The dedupe cannot see that; the lint says it out loud, before
  // any agent is spawned. Grouped on the trimmed string, which is why ' npm test ' counts.
  check('steps sharing one verify command are flagged',
    mixed.schedule.warnings.some((w) => w.includes('a, d') && w.includes('same verify command')), true)
  // ...and it stays a lint about SHARING, not a lint about every plan with two steps.
  const distinctVerify = await run({ dryRun: true, steps: [
    { id: 'a', goal: 'a', files: ['a.ts'], depends_on: [], verify: 'npm test -- a' },
    { id: 'b', goal: 'b', files: ['b.ts'], depends_on: [], verify: 'npm test -- b' },
  ] })
  check('distinct commands are not',
    distinctVerify.schedule.warnings.some((w) => w.includes('same verify command')), false)

  // Plan lints.
  const sloppy = await run({ dryRun: true, steps: [{ id: 'a', goal: 'x', depends_on: [] }] })
  check('no files and no verify are both flagged', sloppy.schedule.warnings.length, 2)
  // The same step the lint complains about: no verify anywhere means no command, so the checkpoint
  // asks its review loop for no check rather than inventing one.
  check('no verify at all → no command', sloppy.schedule.waves[0].checkpoint.verify_command, null)
  const chain = await run({ dryRun: true, steps: ['a', 'b', 'c', 'd'].map((id, i, all) => ({ id, goal: id, files: [`${id}.ts`], verify: 'x', depends_on: i ? [all[i - 1]] : [] })) })
  check('a chain of single steps is flagged', chain.schedule.warnings[0].startsWith('4 waves of one step each'), true)

  // The floor is a floor: it counts what is certain and says so.
  check('agent floor', schedule.agents_min, 4 + 5 + 1 + 4 + 1)

  // The projection must not quietly become a second, divergent model of the run: it reuses the
  // script's own functions, and reaching an agent at all is a hard failure (see `boom`).
  check('zero agents, and the policy still resolves', policy.impl, { model: 'opus' })

  // Without steps it is still the old parse-only smoke test — /dev-setup depends on that shape.
  check('no steps → plain smoke test', Object.keys(await run({ dryRun: true })).sort(), ['ok', 'policy', 'workflow'])

  // toWaves' unknown-dependency check runs here too, so a broken graph fails at lint time, free.
  let threw = null
  try { await run({ dryRun: true, steps: [{ id: 'a', goal: 'a', files: ['a.ts'], depends_on: ['ghost'] }] }) } catch (e) { threw = e.message }
  check('a dangling depends_on fails the lint', String(threw).includes('unknown step dependencies: a->ghost'), true)

  // Everything above proves the PROJECTION carries the command. The run itself is what has to hand it
  // to the review loop, and that happens in args no dryRun executes — so bind the two.
  check('the checkpoint hands the review loop that command', bindsCheckpointCommand(SRC), true)
  // ...and the binding check is proven to bite: strip that one arg from a copy of the source and it
  // must go red, or it is a check that would keep passing after the wiring was deleted.
  check('and it goes red when the arg is dropped',
    bindsCheckpointCommand(SRC.replace(/\n *verifyCommand: \w+\(pending\.steps\)[^\n]*/, '')), false)

  // Same for the consequence: a check that did not clear has to reach `reviewBlocked`, or the run
  // continues into dependent waves over a tree that stopped working.
  const checkFailedName = (SRC.match(CHECK_FAILED_DECL) || [])[1]
  check('a post-fix check that did not clear blocks the run', blocksOnFailedCheck(SRC), true)
  check('and it goes red when that disjunct is dropped',
    blocksOnFailedCheck(SRC.replace(` || ${checkFailedName}`, '')), false)
  // The specific regression this derivation exists to prevent: blocking on `failed` ALONE lets an
  // unsubstantiated claim ("ran: true", no command or no result) read as "did not fail". Such a check
  // proved nothing AND cost the round its re-review, so the wave would advance on no evidence at all.
  check('and it goes red if the gate degrades to `failed` alone',
    blocksOnFailedCheck(SRC.replace(CHECK_FAILED_DECL,
      `\n  const ${checkFailedName} = !!(fixVerify && fixVerify.failed === true)\n`)), false)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main()
