// The dry-run schedule projection, exercised through the workflow's REAL entry point.
//
// This is the harness roadmap item 7(b) was after: the script is a function body with a top-level
// `return`, so wrapping the whole file in `new Function` and calling it with `dryRun: true` runs
// every scheduling decision — toWaves, disjoint/pathScope, globToRegExp/ruleMatchesFile, the
// checkpoint policy — and returns them, without a single agent. No anchor extraction, no copies of
// the logic, nothing rearranged in the script to make it testable.
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
  check('the last wave always checkpoints', w2.checkpoint, { number: 1, reason: 'final wave', waves_covered: 2, files: 4 })

  // A contract-risk step forces its own checkpoint — which is what makes wave 1 flush here.
  const risky = await run({ dryRun: true, steps: STEPS.map((s) => (s.id === 's1' ? { ...s, risk: 'contract' } : s)) })
  check('contract risk flushes immediately', risky.schedule.waves[0].checkpoint.reason, 'contract-risk step')

  // Thresholds are arguments, so the projection has to honour them too.
  const eager = await run({ dryRun: true, steps: STEPS, checkpointMaxWaves: 1 })
  check('checkpointMaxWaves is respected', eager.schedule.waves.map((w) => w.checkpoint && w.checkpoint.reason), ['1 waves pending', 'final wave'])

  // Plan lints.
  const sloppy = await run({ dryRun: true, steps: [{ id: 'a', goal: 'x', depends_on: [] }] })
  check('no files and no verify are both flagged', sloppy.schedule.warnings.length, 2)
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

  console.log(failed ? `\n${failed} FAILED` : `\nall ${17} cases pass`)
  process.exit(failed ? 1 : 0)
}

main()
