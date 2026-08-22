// The scaffolding the review loop's fixer never had. `implPrompt` gives an implementer the repo's
// path-scoped rules, a mandate about what its edit reaches, and a check it must run itself;
// `fixPrompt` gave none of it — and the fixer is the only agent in this loop that writes code, so
// every regression it introduces comes back as the next round's finding.
//
// What is pinned here:
//   1. The rules reach the two code-writing agents (fix, repair), matched against the files the fix
//      will touch rather than dumped, and the copy of the note is the one wf-implement uses.
//   2. The anti-weakening prohibition — which existed only in `repairPrompt`, after the check had
//      already gone red — is now in `fixPrompt` VERBATIM. Extracted from the source, never retyped:
//      a sentence copied into a test drifts exactly like prose does.
//   3. The fixer runs the check itself when this run has one, and a caller that opted out still gets
//      a prompt that never mentions a command.
//   4. The schemas that carry the result: `changed_files` is REQUIRED (the next round's re-review
//      reads exactly that list), `self_check` is the check agent's own shape, and the verifier's
//      clusters carry `fix_context`/`fix_locality`/`origin`.
//
// Everything is asserted through the real entry point, with `agent` stubbed BY LABEL and throwing on
// an unexpected one, capturing both the prompt and the schema each agent was handed.
const fs = require('fs')
const path = require('path')

const RAW = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-review-loop.js'), 'utf8')
const SRC = RAW.replace(/^export const meta/m, 'const meta')

// Brace-matched extraction (tests/fix-verify.test.js's shape) — fail closed if a name moves.
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
function pin(list, fragment) {
  const found = list.filter((s) => s.includes(fragment))
  if (found.length !== 1) throw new Error(`expected exactly one source line containing "${fragment}", found ${found.length}`)
  return found[0]
}
// The prohibition, read off `repairPrompt` where it has always lived. The bullet marker is the only
// thing dropped: `fixPrompt` states it as a paragraph.
const ANTI_WEAKENING = pin(extract('function repairPrompt(').split('\n'), 'expected-to-fail').replace(/^- /, '')

// ---- Harness: tests/seeded-review.test.js's by-label stub, plus the schema each agent was handed.
function run(args, replies) {
  const calls = []
  const prompts = {}
  const schemas = {}
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    // Exact match first: `check r1` is a PREFIX of `check r1 (retry)`.
    const key = Object.keys(replies).find((k) => k === opts.label) || Object.keys(replies).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    prompts[opts.label] = prompt
    schemas[opts.label] = opts.schema
    return replies[key]
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn(args, () => {}, agent, parallel, parallel, () => {}, async () => ({}),
    { total: null, spent: () => 0, remaining: () => Infinity })
    .then((result) => ({ result, calls, prompts, schemas }))
}

const CMD = 'sh tests/run-all.sh'
const MATCHING_RULE = '.claude/rules/db.md'
const UNMATCHED_RULE = '.claude/rules/py.md'
const RULES = [
  { path: MATCHING_RULE, globs: ['src/**/*.ts'] },
  { path: UNMATCHED_RULE, globs: ['**/*.py'] },
]
const SEED = [{ id: 'f1', title: 'unchecked null deref', file: 'src/a.ts', line: 12, severity: 'high', confirmed: true }]
const FIXED = { applied: [{ id: 'f1', title: 'unchecked null deref', file: 'src/a.ts', what: 'guarded the deref' }], skipped: [], changed_files: ['src/a.ts', 'src/caller.ts'] }
// Seeded findings keep a round down to fix + check + re-review, so the call list stays readable.
const BASE = { scope: 'src/a.ts', intent: 'ship the queue change', apply: true, maxRounds: 2, seedFindings: SEED, verifyCommand: CMD, rules: RULES }
const REPLIES = { 'fix r1': FIXED, 'check r1': { ran: true, command: CMD, passed: true }, 're-review r2': { findings: [] } }

let failed = 0
let cases = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  cases++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

async function main() {
  const r = await run(BASE, REPLIES)
  const fixPrompt = r.prompts['fix r1']
  check('the round ran fix, check and re-review', r.calls, ['fix r1', 'check r1', 're-review r2'])

  // ---- 1. Repo rules, matched against the files the fix will touch.
  check('the fixer is handed the rule covering the fixed file', fixPrompt.includes(MATCHING_RULE), true)
  // Matched, not dumped: a rule scoped to a language this change does not touch is noise that
  // crowds out the one that applies.
  check('  └─ and not the one that covers nothing here', fixPrompt.includes(UNMATCHED_RULE), false)

  // ---- 2. The anti-weakening prohibition, verbatim from repairPrompt.
  check('the fixer is forbidden from weakening a check, in repairPrompt\'s own words',
    fixPrompt.includes(ANTI_WEAKENING), true)

  // ---- 3. The fixer runs the check itself.
  check('the fixer is told to run this run\'s check command', fixPrompt.includes(CMD), true)

  const optedOut = await run({ ...BASE, verifyCommand: false }, REPLIES)
  check('a caller that opted out spawns no check agent', optedOut.calls, ['fix r1', 're-review r2'])
  // The note is empty, not merely quiet: an opted-out run must send the prompt it always sent.
  check('  └─ and its fixer is told to run nothing', optedOut.prompts['fix r1'].includes(CMD), false)
  check('  └─ while still getting the rules and the prohibition',
    [optedOut.prompts['fix r1'].includes(MATCHING_RULE), optedOut.prompts['fix r1'].includes(ANTI_WEAKENING)], [true, true])

  // ---- 4. What the fixer has to report back.
  const fixSchema = r.schemas['fix r1']
  check('changed_files is REQUIRED of the fixer', fixSchema.required.includes('changed_files'), true)
  // The re-review reads exactly that list, so it is the whole footprint — not one file per finding.
  check('  └─ separately from the per-finding `applied` list',
    [Object.keys(fixSchema.properties).includes('applied'), Object.keys(fixSchema.properties).includes('changed_files')], [true, true])
  // `self_check` is the check agent's own shape, both sides read from the source: one claim, judged
  // by one truth table, whoever made it. Every field the fixer declares must be that agent's field
  // byte for byte — but NOT the reverse: `changed_files` belongs to the independent agent alone,
  // because only it is told to run `git status`, and the fixer already declares its own footprint at
  // the top level of FIX_SCHEMA. So the comparison runs over what `self_check` declares, and drift on
  // either side of a shared field still fails it.
  const selfProps = fixSchema.properties.self_check.properties
  const checkProps = r.schemas['check r1'].properties
  check('self_check mirrors the check agent\'s schema exactly',
    Object.keys(selfProps).filter((k) => JSON.stringify(selfProps[k]) !== JSON.stringify(checkProps[k])), [])
  // Fail closed: a self_check emptied of its evidence fields would satisfy the comparison above by
  // giving it nothing to compare, and the truth table reads exactly these five.
  check('  └─ and it is the whole evidence claim, not a subset of it',
    ['ran', 'command', 'passed', 'output_summary', 'not_ran_reason'].filter((k) => !selfProps[k]), [])

  // ---- 5. The verifier hands the fixer the context it already paid to read.
  const sweep = await run(
    { scope: 'src/a.ts', intent: 'ship the queue change', apply: false, maxRounds: 1, rules: RULES, files: ['src/a.ts'] },
    {
      'review:': { findings: [{ title: 'x', file: 'src/a.ts', line: 1, severity: 'low', description: 'd' }] },
      'verify:batch r1': { findings: [{ id: 'n1', title: 'x', file: 'src/a.ts', severity: 'low', description: 'd', confirmed: true, reasoning: 'r' }] },
    })
  const clusterProps = sweep.schemas['verify:batch r1'].properties.findings.items.properties
  check('the verifier can attach fix context to a cluster',
    [Object.keys(clusterProps).includes('fix_context'), Object.keys(clusterProps).includes('fix_locality')], [true, true])
  // Optional in the schema on purpose: `required` would demand it of refuted clusters too, and the
  // prompt asks for it only where a fix is actually coming.
  check('  └─ without being required to, on a cluster it refutes',
    sweep.schemas['verify:batch r1'].properties.findings.items.required.some((k) => k.startsWith('fix_')), false)

  // ---- 6. Origin: which round's fix a defect belongs to, declared identically in both schemas
  // because a re-reviewer sets it and the verifier carries it through clustering.
  const rereviewProps = r.schemas['re-review r2'].properties.findings.items.properties
  check('both schemas declare the same origin vocabulary', rereviewProps.origin, clusterProps.origin)
  // Read off the schema the re-reviewer was handed, so the prompt and the enum cannot disagree.
  check('the re-review prompt names every origin it may set',
    rereviewProps.origin.enum.filter((v) => !r.prompts['re-review r2'].includes(v)), [])
  // Round 1 has no fixes to attribute anything to, so a sweep must not ask for the field at all.
  check('a round-1 sweep is never asked to set one',
    sweep.schemas['review:runtime-contracts r1'].properties.findings.items.required.includes('origin'), false)

  // ---- 7. The repair agent writes code under the same rules the fixer does.
  const red = await run(BASE, {
    ...REPLIES,
    'check r1': { ran: true, command: CMD, passed: false, output_summary: 'tests/rules.test.js: 1 case fails' },
    'repair r1': { repaired: false, abandoned_because: 'the only route to green reverts the confirmed fix' },
  })
  check('the repair agent gets the rules too', red.prompts['repair r1'].includes(MATCHING_RULE), true)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
