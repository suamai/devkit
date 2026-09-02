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
// The three ladders `policy()` validates against, plus the PROFILES table it looks tiers up in.
// Extracted per FILE rather than once from wf-implement, because each script carries its own copy
// and the copies are a contract — see the drift check further down, which is the reason this is a
// function at all. PROFILES is multi-line, so it is brace-matched by `extract()` like `policy()`
// itself: a line-prefix capture would hand `const PROFILES = {` to `new Function` and throw at
// collection time instead of failing an assertion.
const CONST_NAMES = ['const MODELS =', 'const EFFORTS =', 'const ROLE_NAMES =']
const constsOf = (src, file) => CONST_NAMES
  .map((c) => src.split('\n').find((l) => l.startsWith(c)) || (() => { throw new Error(`${file}: missing ${c}`) })())
  .concat(extract(src, 'const PROFILES ='))
  .join('\n')
const CONSTS = constsOf(IMPL, 'wf-implement.js')

// `policy` closes over `args` and `log`, so they come in as parameters here.
function build(args) {
  const logs = []
  const fn = new Function('args', 'log', `${CONSTS}\n${extract(IMPL, 'function policy(')}\nreturn policy`)
  return { policy: fn(args, (m) => logs.push(m)), logs }
}
const escalate = new Function(`${CONSTS}\n${extract(wf('wf-review-loop.js'), 'function escalate(')}\nreturn escalate`)()

const IMPL_ROLES = ['scout', 'impl', 'gate', 'check', 'run']

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
function throws(name, args, defaults, fragment) {
  let msg = null
  try { build(args).policy(defaults) } catch (e) { msg = e.message }
  check(name, msg && msg.includes(fragment) ? `throws: …${fragment}…` : msg, `throws: …${fragment}…`)
}
const models = (resolved) => Object.keys(resolved).map((r) => `${r}=${resolved[r].model}`).join(' ')

// --- Defaults must reproduce what the workflow shipped with: passing nothing changes nothing.
check('no args → today\'s split', models(build({}).policy(IMPL_ROLES)), 'scout=sonnet impl=opus gate=sonnet check=opus run=sonnet')
check('no args → no effort key at all', build({}).policy(IMPL_ROLES).impl, { model: 'opus' })
check('default profile is a no-op', models(build({ profile: 'default' }).policy(IMPL_ROLES)), 'scout=sonnet impl=opus gate=sonnet check=opus run=sonnet')

// --- A profile selects a COLUMN of the table, per role — not a uniform rung. `cheap` buys back the
// authoring and command-running roles and deliberately leaves the gate (a judge) on sonnet; `max`
// spends fable exactly where an agent authors or synthesises.
check('cheap lowers the authoring roles, not the gate', models(build({ profile: 'cheap' }).policy(IMPL_ROLES)), 'scout=haiku impl=sonnet gate=sonnet check=sonnet run=haiku')
check('max buys fable where it authors', models(build({ profile: 'max' }).policy(IMPL_ROLES)), 'scout=sonnet impl=fable gate=opus check=fable run=sonnet')

// --- An explicit override is an override: it wins over the profile, in either direction.
check('models beats profile', models(build({ profile: 'max', models: { impl: 'haiku' } }).policy(IMPL_ROLES)), 'scout=sonnet impl=haiku gate=opus check=fable run=sonnet')
check('one role tuned, rest default', models(build({ models: { check: 'sonnet' } }).policy(IMPL_ROLES)), 'scout=sonnet impl=opus gate=sonnet check=sonnet run=sonnet')

// --- Effort: absent means "inherit the session's", and must never reach agent() as null. Effort no
// longer moves with the profile — a table has no arithmetic — so `decompose`'s `low`, the only
// effort any cell names, is the same under every column while its MODEL still changes.
check('effort only when asked for', build({ efforts: { impl: 'xhigh' } }).policy(IMPL_ROLES).impl, { model: 'opus', effort: 'xhigh' })
check('the one declared effort, at default', build({}).policy(['decompose']).decompose, { model: 'sonnet', effort: 'low' })
check('and unchanged by max, which moves no effort', build({ profile: 'max' }).policy(['decompose']).decompose, { model: 'sonnet', effort: 'low' })
check('cheap moves the model, not the effort', build({ profile: 'cheap' }).policy(['decompose']).decompose, { model: 'haiku', effort: 'low' })
check('an efforts override still wins', build({ efforts: { decompose: 'high' } }).policy(['decompose']).decompose, { model: 'sonnet', effort: 'high' })

// --- Roles are a PIPELINE-wide vocabulary: wf-implement forwards its args to wf-review-loop, so a
// role this workflow doesn't own is a passthrough, not a mistake. A role nobody owns is a typo.
check('foreign role is ignored, not fatal', models(build({ models: { review: 'haiku' } }).policy(IMPL_ROLES)), 'scout=sonnet impl=opus gate=sonnet check=opus run=sonnet')
throws('typo in role name throws', { models: { implement: 'haiku' } }, IMPL_ROLES, 'unknown role "implement"')
throws('typo in profile throws', { profile: 'cheep' }, IMPL_ROLES, 'unknown profile "cheep"')
throws('unknown model throws', { models: { impl: 'gpt' } }, IMPL_ROLES, 'unknown model "gpt"')
throws('unknown effort throws', { efforts: { impl: 'extreme' } }, IMPL_ROLES, 'unknown effort "extreme"')

// --- Silent unless tuned: the nested review loop resolves a policy per checkpoint, and a line per
// checkpoint saying "everything is at its default" is noise.
check('silent at defaults', build({}).logs.concat(build({}).policy(IMPL_ROLES) && build({}).logs).length, 0)
const tuned = build({ profile: 'cheap' })
tuned.policy(IMPL_ROLES)
check('logs the resolved policy when tuned', tuned.logs[0], 'policy: scout=haiku impl=sonnet gate=sonnet check=sonnet run=haiku')

// --- The critical-fix escalation is relative, or it stops meaning anything under a cheap profile.
check('critical escalates one rung', [escalate('haiku'), escalate('sonnet'), escalate('opus'), escalate('fable')], ['sonnet', 'opus', 'fable', 'fable'])

// --- The table itself, read out of the shipped source rather than restated. `policy()` throws on a
// role a profile forgot, but only for the roles a workflow actually asks for; these cases cover the
// whole grid, so a cell missing for a role only one workflow uses is caught here and not in a run.
const TABLE = new Function(`${CONSTS}\nreturn { MODELS, EFFORTS, ROLE_NAMES, PROFILES }`)()
const CELLS = Object.keys(TABLE.PROFILES).flatMap((p) => TABLE.ROLE_NAMES.map((r) => ({ p, r, cell: TABLE.PROFILES[p][r] })))
check('every profile covers every role', CELLS.filter((c) => c.cell === undefined).map((c) => `${c.p}.${c.r}`), [])
check('every cell is a real model[/effort]', CELLS.filter((c) => {
  const [model, effort] = String(c.cell).split('/')
  return !TABLE.MODELS.includes(model) || (effort !== undefined && !TABLE.EFFORTS.includes(effort))
}).map((c) => `${c.p}.${c.r}`), [])

// The two judgements the table exists to express, pinned so a later "make cheap cheaper" or "make
// max uniform" edit has to argue with a red test: a cheap run never puts the FIXER below sonnet (a
// bad fix costs more than the tokens it saved), and max spends fable only where an agent authors.
check('cheap never drops the fixer below sonnet',
  TABLE.MODELS.indexOf(TABLE.PROFILES.cheap.fix) >= TABLE.MODELS.indexOf('sonnet'), true)
check('max puts the authoring roles on fable',
  ['impl', 'synth', 'check'].map((r) => TABLE.PROFILES.max[r]), ['fable', 'fable', 'fable'])

// --- The shipped default, per workflow. The role LIST is read off each script; the tiers it must
// resolve to are RESTATED here, which is the one place in this suite that is right rather than
// drift-prone: the value being frozen is what these workflows shipped with BEFORE the table existed,
// so reading it out of the table these cases guard would assert nothing at all.
const SHIPPED = {
  'wf-explore-plan.js': 'decompose=sonnet/low scout=sonnet validate=sonnet synth=opus',
  'wf-implement.js': 'scout=sonnet impl=opus gate=sonnet check=opus run=sonnet',
  'wf-review-loop.js': 'review=sonnet verify=sonnet fix=sonnet run=sonnet',
}
for (const [file, shipped] of Object.entries(SHIPPED)) {
  const src = wf(file)
  const listed = src.match(/const ROLE = policy\(\[([^\]]+)\]\)/)
  if (!listed) throw new Error(`${file}: could not read its role list — has the policy([…]) call moved or grown a second line?`)
  const roles = listed[1].split(',').map((r) => r.trim().replace(/'/g, ''))
  const resolve = new Function('args', 'log', `${constsOf(src, file)}\n${extract(src, 'function policy(')}\nreturn policy`)({}, () => {})
  const resolved = resolve(roles)
  check(`${file}: no args resolves the tiers it shipped with`,
    roles.map((r) => `${r}=${resolved[r].model}${resolved[r].effort ? '/' + resolved[r].effort : ''}`).join(' '), shipped)
}

// --- Self-contained scripts cannot import a shared helper, so the resolver is copied into each.
// This is the check that the copies have not drifted apart into different cost models.
const WORKFLOWS = ['wf-implement.js', 'wf-explore-plan.js', 'wf-review-loop.js']
const RESOLVERS = WORKFLOWS.map((f) => ({ f, body: extract(wf(f), 'function policy(') }))
check('policy() is identical in all 3 workflows', RESOLVERS.filter((r) => r.body !== RESOLVERS[0].body).map((r) => r.f), [])

// The resolver is only half the contract. `policy()` validates every override against the ladders
// and resolves every tier out of the table above, and all of those are copied into each script too — with nothing comparing them. A role
// present in one copy and not another is therefore ACCEPTED by the script that owns it and then
// throws `unknown role` inside the nested workflow it forwards the policy to: wf-implement passes
// `profile`/`models`/`efforts` straight into wf-review-loop, which re-validates against its own
// ROLE_NAMES. Identical vocabularies are what makes docs/architecture.md's "one object survives
// workflow() nesting" true rather than merely intended.
const POLICY_CONSTS = WORKFLOWS.map((f) => ({ f, body: constsOf(wf(f), f) }))
const constDrift = (copies) => copies.filter((c) => c.body !== copies[0].body).map((c) => c.f)
check('policy constants identical in all 3 workflows', constDrift(POLICY_CONSTS), [])
// Mutation proof, in memory: a role added to one copy alone must be named. A pure function over
// text, so the negative case is just a second call and no tracked file is ever written.
check('and it names the copy a role drifted into',
  constDrift(POLICY_CONSTS.map((c) => (c.f === 'wf-review-loop.js'
    ? { f: c.f, body: c.body.replace("'decompose'", "'judge', 'decompose'") } : c))), ['wf-review-loop.js'])
// And the same proof for the TABLE, which the vocabulary check above cannot reach: two copies whose
// role names agree can still price a role differently, and the copy that would silently spend more
// is the one the caller never passed an override to. (A no-op replace here fails this case too.)
check('and the copy a tier drifted into',
  constDrift(POLICY_CONSTS.map((c) => (c.f === 'wf-explore-plan.js'
    ? { f: c.f, body: c.body.replace("run: 'sonnet' }", "run: 'opus' }") } : c))), ['wf-explore-plan.js'])

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

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
})()
