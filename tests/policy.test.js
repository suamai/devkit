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

// --- Four self-contained scripts cannot import a shared helper, so the resolver is copied. This is
// the check that the copies have not drifted apart into four different cost models.
const RESOLVERS = ['wf-implement.js', 'wf-explore-plan.js', 'wf-review-loop.js', 'wf-plan-remediation.js']
  .map((f) => ({ f, body: extract(wf(f), 'function policy(') }))
const drifted = RESOLVERS.filter((r) => r.body !== RESOLVERS[0].body).map((r) => r.f)
check('policy() is identical in all 4 workflows', drifted, [])

console.log(failed ? `\n${failed} FAILED` : `\nall ${18} cases pass`)
process.exit(failed ? 1 : 0)
