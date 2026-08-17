// Which reviewers a round spawns. The `repo-conventions` lens — the one grounded in the repo's own
// `.claude/rules/*.md` checklists rather than in generic judgement — used to live INSIDE the default
// lens array, so `args.lenses || [ …defaults…, ruleLens ]` discarded it whenever a caller passed
// custom lenses. `/dev-pr --review` passes two custom lenses at the last gate before publication, so
// the one review that most wants the repo's own rules was the one review that never got them.
//
// The lens set is unobservable from the return value, but lens count IS agent count and each reviewer
// is labelled `review:<key> r1`, so the stubbed labels are the assertion. Every expected key is
// extracted from the source (or from the caller that passes it), never restated here.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const RAW = fs.readFileSync(path.join(ROOT, 'workflows', 'wf-review-loop.js'), 'utf8')
const SRC = RAW.replace(/^export const meta/m, 'const meta')

// The two defaults are one-liners; the appended rule lens is a multi-line object, so this pattern
// matches exactly the defaults and nothing else.
const DEFAULT_KEYS = [...RAW.matchAll(/\{ key: '([a-z-]+)', focus:/g)].map((m) => m[1])
if (DEFAULT_KEYS.length !== 2) throw new Error(`expected 2 default lenses in the source, found ${DEFAULT_KEYS.length}`)
const RULE_KEY = (RAW.match(/key: '([a-z-]+)',\n\s+focus:/) || [])[1]
if (!RULE_KEY) throw new Error('could not find the appended rule lens key — has the lens object changed shape?')
const CAP = Number((RAW.match(/const ruleLensPaths = .*\.slice\(0, (\d+)\)/) || [])[1])
if (!CAP) throw new Error('could not read the rule-lens cap — has the ruleLensPaths line changed?')

// The real /dev-pr --review lenses, read off the caller that passes them: this is the AC the change
// exists for, so restating them here would let the skill drift out from under the test.
const PR_SKILL = fs.readFileSync(path.join(ROOT, 'skills', 'dev-pr', 'SKILL.md'), 'utf8')
const PR_LENSES = [...PR_SKILL.matchAll(/\{ key: "([a-z-]+)", focus: "([^"]*)"/g)].map((m) => ({ key: m[1], focus: m[2] }))
if (PR_LENSES.length !== 2) throw new Error(`expected 2 custom lenses in skills/dev-pr/SKILL.md, found ${PR_LENSES.length}`)
const PR_KEYS = PR_LENSES.map((l) => l.key)

function run(args, replies) {
  const calls = []
  const prompts = {}
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    const key = Object.keys(replies).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    prompts[opts.label] = prompt
    return replies[key]
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn(args, () => {}, agent, parallel, parallel, () => {}, async () => ({}),
    { total: null, spent: () => 0, remaining: () => Infinity }).then(() => ({ calls, prompts }))
}

// An empty round costs one agent per lens and nothing else: findings [] ends the loop immediately.
async function lensesOf(args) {
  const { calls, prompts } = await run({ scope: 'src/db/user.ts', intent: 'x', apply: false, maxRounds: 1, ...args },
    { 'review:': { findings: [] } })
  return {
    keys: calls.map((c) => {
      const m = c.match(/^review:(.+) r1$/)
      if (!m) throw new Error(`a non-reviewer agent ran: ${c}`)
      return m[1]
    }),
    prompts,
  }
}

const DB_RULE = { path: '.claude/rules/db.md', globs: ['src/db/**/*.ts'] }
const DOC_RULE = { path: '.claude/rules/docs.md', globs: ['docs/**/*.md'] }
const FILES = ['src/db/user.ts']

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

async function main() {
  const noRules = await lensesOf({})
  check('no rules → the two defaults', noRules.keys, DEFAULT_KEYS)

  const matched = await lensesOf({ rules: [DB_RULE], files: FILES })
  check('a matching rule appends a third lens', matched.keys, [...DEFAULT_KEYS, RULE_KEY])

  // AC-05: the /dev-pr --review shape. Both custom lenses survive AND the repo's own rules arrive.
  const pr = await lensesOf({ lenses: PR_LENSES, rules: [DB_RULE], files: FILES })
  check('custom lenses keep the rule lens', pr.keys, [...PR_KEYS, RULE_KEY])

  const prNoMatch = await lensesOf({ lenses: PR_LENSES, rules: [DOC_RULE], files: FILES })
  check('a rule that matches nothing adds nothing', prNoMatch.keys, PR_KEYS)

  const optedOut = await lensesOf({ lenses: PR_LENSES, rules: [DB_RULE], files: FILES, ruleLens: false })
  check('ruleLens: false opts out explicitly', optedOut.keys, PR_KEYS)

  const defaultsOptedOut = await lensesOf({ rules: [DB_RULE], files: FILES, ruleLens: false })
  check('and it opts out of the default set too', defaultsOptedOut.keys, DEFAULT_KEYS)

  // The lens is only worth an agent if the reviewer is told WHICH rule files to read.
  const prompt = pr.prompts[`review:${RULE_KEY} r1`]
  check('the rule lens names the matched rule file', prompt.includes(DB_RULE.path), true)
  check('and does not name one that did not match', prompt.includes(DOC_RULE.path), false)

  // A repo-wide rule matches almost any change, so the list is capped — otherwise the generic rules
  // crowd out the specific ones and the lens becomes unreadable.
  const many = [1, 2, 3, 4, 5].map((n) => ({ path: `.claude/rules/r${n}.md`, globs: ['src/**/*.ts'] }))
  const capped = await lensesOf({ rules: many, files: FILES })
  check('more matches than the cap still means one lens', capped.keys, [...DEFAULT_KEYS, RULE_KEY])
  check('and it lists at most the cap',
    (capped.prompts[`review:${RULE_KEY} r1`].match(/- \.claude\/rules\//g) || []).length, CAP)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
