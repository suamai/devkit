// Model/effort policy: resolution, validation, and the fact that the four self-contained workflows
// carry the SAME resolver. Runs the shipped code, extracted from the workflow files by signature.
const fs = require('fs')
const path = require('path')

const wf = (name) => fs.readFileSync(path.join(__dirname, '..', 'workflows', name), 'utf8')

function extract(src, signature) {
  const at = src.indexOf(signature)
  if (at === -1) throw new Error(`could not find ${signature} — has it been renamed?`)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

const IMPL = wf('wf-implement.js')
const CONSTS = ['const MODELS =', 'const EFFORTS =', 'const ROLE_NAMES =', 'const PROFILE_SHIFT =']
  .map((c) => IMPL.split('\n').find((l) => l.startsWith(c)) || (() => { throw new Error(`missing ${c}`) })())
  .join('\n')

// `policy` closes over `args` and `log`, so they come in as parameters here.
function build(args) {
  const logs = []
  const fn = new Function('args', 'log', `${CONSTS}\n${extract(IMPL, 'function policy(')}\nreturn policy`)
  return { policy: fn(args, (m) => logs.push(m)), logs }
}
const escalate = new Function(`${CONSTS}\n${extract(wf('wf-review-loop.js'), 'function escalate(')}\nreturn escalate`)()

const IMPL_ROLES = { scout: { model: 'sonnet' }, impl: { model: 'opus' }, gate: { model: 'sonnet' }, check: { model: 'opus' } }

let failed = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}
function throws(name, args, defaults, fragment) {
  let msg = null
  try { build(args).policy(defaults) } catch (e) { msg = e.message }
  check(name, msg && msg.includes(fragment) ? `throws: …${fragment}…` : msg, `throws: …${fragment}…`)
}
const models = (resolved) => Object.keys(resolved).map((r) => `${r}=${resolved[r].model}`).join(' ')

// --- Defaults must reproduce what the workflow shipped with: passing nothing changes nothing.
check('no args → today\'s split', models(build({}).policy(IMPL_ROLES)), 'scout=sonnet impl=opus gate=sonnet check=opus')
check('no args → no effort key at all', build({}).policy(IMPL_ROLES).impl, { model: 'opus' })
check('default profile is a no-op', models(build({ profile: 'default' }).policy(IMPL_ROLES)), 'scout=sonnet impl=opus gate=sonnet check=opus')

// --- profile shifts one rung and clamps at both ends of the ladder.
check('cheap shifts down', models(build({ profile: 'cheap' }).policy(IMPL_ROLES)), 'scout=haiku impl=sonnet gate=haiku check=sonnet')
check('max shifts up, clamped at opus', models(build({ profile: 'max' }).policy(IMPL_ROLES)), 'scout=opus impl=opus gate=opus check=opus')

// --- An explicit override is an override: it wins over the profile, in either direction.
check('models beats profile', models(build({ profile: 'max', models: { impl: 'haiku' } }).policy(IMPL_ROLES)), 'scout=opus impl=haiku gate=opus check=opus')
check('one role tuned, rest default', models(build({ models: { check: 'sonnet' } }).policy(IMPL_ROLES)), 'scout=sonnet impl=opus gate=sonnet check=sonnet')

// --- Effort: absent means "inherit the session's", and must never reach agent() as null.
check('effort only when asked for', build({ efforts: { impl: 'xhigh' } }).policy(IMPL_ROLES).impl, { model: 'opus', effort: 'xhigh' })
check('a declared effort default shifts too', build({ profile: 'max' }).policy({ decompose: { model: 'sonnet', effort: 'low' } }).decompose, { model: 'opus', effort: 'medium' })
check('and clamps at the bottom', build({ profile: 'cheap' }).policy({ decompose: { model: 'sonnet', effort: 'low' } }).decompose, { model: 'haiku', effort: 'low' })

// --- Roles are a PIPELINE-wide vocabulary: wf-implement forwards its args to wf-review-loop, so a
// role this workflow doesn't own is a passthrough, not a mistake. A role nobody owns is a typo.
check('foreign role is ignored, not fatal', models(build({ models: { review: 'haiku' } }).policy(IMPL_ROLES)), 'scout=sonnet impl=opus gate=sonnet check=opus')
throws('typo in role name throws', { models: { implement: 'haiku' } }, IMPL_ROLES, 'unknown role "implement"')
throws('typo in profile throws', { profile: 'cheep' }, IMPL_ROLES, 'unknown profile "cheep"')
throws('unknown model throws', { models: { impl: 'gpt' } }, IMPL_ROLES, 'unknown model "gpt"')
throws('unknown effort throws', { efforts: { impl: 'extreme' } }, IMPL_ROLES, 'unknown effort "extreme"')

// --- Silent unless tuned: the nested review loop resolves a policy per checkpoint, and a line per
// checkpoint saying "everything is at its default" is noise.
check('silent at defaults', build({}).logs.concat(build({}).policy(IMPL_ROLES) && build({}).logs).length, 0)
const tuned = build({ profile: 'cheap' })
tuned.policy(IMPL_ROLES)
check('logs the resolved policy when tuned', tuned.logs[0], 'policy: scout=haiku impl=sonnet gate=haiku check=sonnet')

// --- The critical-fix escalation is relative, or it stops meaning anything under a cheap profile.
check('critical escalates one rung', [escalate('haiku'), escalate('sonnet'), escalate('opus')], ['sonnet', 'opus', 'opus'])

// --- Self-contained scripts cannot import a shared helper, so the resolver is copied into each.
// This is the check that the copies have not drifted apart into different cost models.
const WORKFLOWS = ['wf-implement.js', 'wf-explore-plan.js', 'wf-review-loop.js']
const RESOLVERS = WORKFLOWS.map((f) => ({ f, body: extract(wf(f), 'function policy(') }))
check('policy() is identical in all 3 workflows', RESOLVERS.filter((r) => r.body !== RESOLVERS[0].body).map((r) => r.f), [])

// Same for the per-phase cost accounting, which is fenced rather than extracted by signature
// because it is a const plus two functions.
function fencedCost(src, file) {
  const a = src.indexOf('// >>> shared: per-phase cost')
  const b = src.indexOf('// <<< shared: per-phase cost')
  if (a === -1 || b === -1) throw new Error(`${file}: per-phase cost markers missing`)
  return src.slice(src.indexOf('\n', a) + 1, b)
}
const METERS = WORKFLOWS.map((f) => ({ f, body: fencedCost(wf(f), f) }))
check('metered()/costReport() identical too', METERS.filter((m) => m.body !== METERS[0].body).map((m) => m.f), [])

// The report must never claim protection it does not have: budget.total is null unless the
// developer put a "+300k"-style target in their own message, and every floor is gated on it.
const meter = new Function('log', 'budget', `${METERS[0].body}\nreturn { metered, costReport }`)
const noBudget = meter(() => {}, { total: null, spent: () => 1000, remaining: () => Infinity })
check('no directive → floors reported inactive', noBudget.costReport(), { by_phase: {}, total: 0, budget_total: null, floors_active: false })
const withBudget = meter(() => {}, { total: 300000, spent: () => 1000, remaining: () => 299000 })
check('a directive → floors reported active', withBudget.costReport().floors_active, true)

// Deltas around real awaits, and the clamp that keeps a phase from going negative if spent() ever
// moves backwards under concurrency.
;(async () => {
  let fake = 0
  const lines = []
  const m2 = new Function('log', 'budget', `${METERS[0].body}\nreturn { metered, costReport }`)(
    (l) => lines.push(l), { total: null, spent: () => fake, remaining: () => Infinity })
  await m2.metered('steps', async () => { fake += 12000 })
  await m2.metered('review', async () => { fake += 3000 })
  await m2.metered('steps', async () => { fake += 500 })
  check('deltas accumulate per phase', m2.costReport().by_phase, { steps: 12500, review: 3000 })
  check('and are logged in thousands', lines[0], 'cost: steps=13k review=3k — 16k output tokens')
  await m2.metered('backwards', async () => { fake -= 9999 })
  check('a backwards delta clamps to zero', m2.costReport().by_phase.backwards, 0)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${25} cases pass`)
  process.exit(failed ? 1 : 0)
})()
