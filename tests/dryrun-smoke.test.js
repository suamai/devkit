// The zero-cost smoke test, tested. `/dev-setup` step 6 tells every new repo to run all three
// workflows with `args: {"dryRun": true}` and states that all three must return `{ok: true}` — a
// promise nothing enforced. `schedule.test.js` drives wf-implement's dryRun hard, but the
// wf-explore-plan and wf-review-loop branches had no test at all, so a parse error or a reordered
// arg guard in either would surface for the first time in someone else's fresh checkout.
//
// This is also what makes the pre-commit hook a single line: the "three dryRun calls" the hook was
// supposed to make live here instead, where they run through the real entry points and where a
// fourth workflow cannot be added without one.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const WORKFLOWS = path.join(ROOT, 'workflows')

// Zero agents is the whole claim, so every hook that could spawn work throws. A regression that
// reaches one fails here rather than quietly costing money in a real /dev-setup run.
const boom = (what) => () => { throw new Error(`dryRun reached ${what}() — it must not spawn work`) }
function run(file, args) {
  const src = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').replace(/^export const meta/m, 'const meta')
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${src}})()`)
  return fn(args, () => {}, boom('agent'), boom('parallel'), boom('pipeline'), () => {}, boom('workflow'),
    { total: null, spent: () => 0, remaining: () => Infinity })
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

// Discovered, not listed. A new workflow file is covered the moment it lands; the alternative is a
// hard-coded array that silently stops describing the directory.
const SHIPPED = fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.js')).sort()

async function main() {
  check('there are workflows to smoke test', SHIPPED.length > 0, true)

  for (const file of SHIPPED) {
    const name = file.replace(/\.js$/, '')
    let result = null
    let error = null
    try { result = await run(file, { dryRun: true }) } catch (e) { error = e.message }

    check(`${name}: dryRun returns instead of throwing`, error, null)
    if (error) continue

    // `ok: true` is the literal sentence in skills/dev-setup/SKILL.md step 6.
    check(`${name}: ok: true`, result.ok, true)
    // The returned name is how a developer reading three results knows which script answered which
    // call; a copy-pasted branch that names the wrong workflow is invisible without this.
    check(`${name}: names itself`, result.workflow, name)

    // Step 6 also promises the resolved policy comes back "for free", so a repo can check its
    // `profile` before it can cost anything. Validate the shape against the ladder in the script
    // itself rather than against a list restated here.
    const src = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8')
    const models = src.match(/^const MODELS = \[([^\]]+)\]/m)[1].split(',').map((v) => v.trim().replace(/'/g, ''))
    const roles = Object.keys(result.policy || {})
    check(`${name}: policy covers its roles`, roles.length > 0, true)
    check(`${name}: every role resolves to a real model`,
      roles.filter((r) => !models.includes(result.policy[r].model)), [])
  }

  // The one arg a dryRun caller is likely to add. An unknown profile must throw *before* any agent
  // runs — that is the entire point of checking a cost setting with a dry run.
  for (const file of SHIPPED) {
    const name = file.replace(/\.js$/, '')
    let msg = null
    try { await run(file, { dryRun: true, profile: 'cheep' }) } catch (e) { msg = e.message }
    check(`${name}: a typo'd profile throws at zero cost`, msg && msg.includes('unknown profile'), true)

    const cheap = await run(file, { dryRun: true, profile: 'cheap' })
    const base = await run(file, { dryRun: true })
    const shifted = Object.keys(base.policy).some((r) => cheap.policy[r].model !== base.policy[r].model)
    check(`${name}: profile reaches the resolved policy`, shifted, true)
  }

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
