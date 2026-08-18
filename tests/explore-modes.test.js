// wf-explore-plan's two modes and the findings-reuse path, driven through the real script with
// agents stubbed by label. The claim being tested is the one that justifies explain mode existing
// at all: it leaves the same durable findings a later plan run consumes instead of re-exploring.
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-explore-plan.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')

function run(args, replies, spy) {
  const calls = []
  const logs = []
  // A rejected run resolves to nothing, so a case whose assertion IS the throw needs the labels by
  // reference. Same array the resolved value carries — no second bookkeeping path to drift.
  if (spy) spy.calls = calls
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    const key = Object.keys(replies).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    const reply = replies[key]
    return typeof reply === 'function' ? reply(prompt) : reply
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${SRC}})()`)
  return fn(args, (m) => logs.push(m), agent, parallel, parallel, () => {}, async () => ({}),
    { total: null, spent: () => 0, remaining: () => Infinity }).then((result) => ({ result, calls, logs }))
}

const WS = '/repo/.dev/rate-limits'
const BASE = { task: 'how does rate limiting work here?', workspace: WS }
const scoutOf = (name) => ({
  summary: `${name} summary`, headline_findings: [{ claim: `${name} claim`, evidence: 'src/x.ts:1', relevance: 'high' }],
  open_questions: [], report_path: `${WS}/findings/${name}.md`,
})
const VALIDATION = { verdicts: [], missed_findings: [], suggested_adjustments: [] }
const PLAN = { title: 'p', steps: [{ id: 's1', title: 't', goal: 'g', files: ['a.ts'], depends_on: [], details: 'd' }], open_questions: [] }
const EXPLAIN = {
  title: 'How rate limiting works', answer: 'It does not, yet.',
  entry_points: [{ path: 'src/mw.ts', why: 'the chain is assembled here' }],
  refuted: [{ claim: 'the limiter is per-key', evidence: 'src/mw.ts:40 uses a global bucket' }],
  open_questions: [], doc_path: `${WS}/understanding.md`,
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
  const threeAngles = { angles: ['behavior', 'callers', 'config'].map((n) => ({ name: n, focus: n, why: n })) }
  const fullSweep = {
    decompose: threeAngles,
    'scout:': (prompt) => scoutOf(['behavior', 'callers', 'config'].find((n) => prompt.includes(n)) || 'behavior'),
    'validate:batch': VALIDATION,
  }

  // --- explain mode: same exploration, different synthesizer and different artifact.
  const explain = await run({ ...BASE, mode: 'explain' }, { ...fullSweep, synthesize: EXPLAIN })
  check('explain still explores and validates', explain.calls.filter((c) => c.startsWith('scout:')).length, 3)
  check('and writes a document, not a plan', [explain.result.mode, explain.result.docPath], ['explain', `${WS}/understanding.md`])
  check('no steps, no waves', [explain.result.steps, explain.result.waves], [undefined, undefined])
  // The section a cheaper lookup cannot produce: what is provably NOT true.
  check('refuted claims survive to the caller', explain.result.refuted.length, 1)

  // --- The justification: findings come back reusable, keyed to their report paths.
  check('findings are returned for reuse', explain.result.findings.map((f) => f.angle), ['behavior', 'callers', 'config'])
  check('each carries the path to its full report', explain.result.findings[0].report_path, `${WS}/findings/behavior.md`)

  // --- A later plan run in the same workspace: no re-exploration when the ground is covered.
  const reuse = await run({ ...BASE, task: 'add per-key rate limits', priorFindings: explain.result.findings }, {
    decompose: { angles: [] },
    'validate:batch': VALIDATION,
    synthesize: PLAN,
  })
  check('zero scouts when priors cover it', reuse.calls.filter((c) => c.startsWith('scout:')).length, 0)
  check('and it still produces a plan', reuse.result.steps.length, 1)
  // Reuse skips scouting, never validation — that IS the staleness guard, so it must still run.
  check('validation still runs on reused findings', reuse.calls.includes('validate:batch'), true)
  check('the synthesizer sees all three angles', reuse.result.findings.length, 3)

  // --- Partial reuse: explore only what the priors do not cover.
  const partial = await run({ ...BASE, task: 'add per-key rate limits', priorFindings: explain.result.findings.slice(0, 2) }, {
    decompose: { angles: [{ name: 'storage', focus: 'where counters live', why: 'not covered' }] },
    'scout:': scoutOf('storage'),
    'validate:batch': VALIDATION,
    synthesize: PLAN,
  })
  check('only the uncovered angle is scouted', partial.calls.filter((c) => c.startsWith('scout:')), ['scout:storage'])
  check('old and new findings merge', partial.result.findings.map((f) => f.angle), ['behavior', 'callers', 'storage'])
  // A reused finding keeps the path an earlier run wrote (this run never touches that file); a fresh
  // one carries the path THIS run dispatched its scout to.
  check('reused and fresh findings both carry a path', partial.result.findings.map((f) => f.report_path),
    [`${WS}/findings/behavior.md`, `${WS}/findings/callers.md`, `${WS}/findings/storage.md`])

  // The decomposer must be told what is already on disk, or "propose only new angles" is unanswerable.
  let sawPriors = false
  await run({ ...BASE, priorFindings: explain.result.findings }, {
    decompose: (prompt) => { sawPriors = prompt.includes('Already explored in this workspace') && prompt.includes('behavior'); return { angles: [] } },
    'validate:batch': VALIDATION,
    synthesize: PLAN,
  })
  check('the decomposer is shown the priors', sawPriors, true)

  // --- Angle dispatch. An angle's `name` is the FILENAME its scout writes its report to, so two
  // scouts sharing a name share a file and the second overwrites the first. Not hypothetical: this
  // workflow's own planning run passed `angles` as an array of strings, every `a.name` read back
  // `undefined`, and five scouts wrote to one findings/undefined.md.
  const dispatchedIn = (prompts) => prompts.map((p) => (p.match(/as markdown to "([^"]+)"/) || [])[1])

  const fromStrings = []
  const strings = await run({ ...BASE, angles: ['How the limiter is wired', 'who calls it?'] }, {
    // No `decompose` reply on purpose: an unlisted label throws in this harness, so the run
    // completing at all is the proof that caller-supplied angles skip the decomposer.
    'scout:': (p) => { fromStrings.push(p); return scoutOf('x') },
    'validate:batch': VALIDATION,
    synthesize: PLAN,
  })
  check('a string angle is slugged into its own file', dispatchedIn(fromStrings),
    [`${WS}/findings/how-the-limiter-is-wired.md`, `${WS}/findings/who-calls-it.md`])
  check('  …and never the shared undefined.md', dispatchedIn(fromStrings).some((p) => /undefined/.test(p)), false)
  // The string is the FOCUS; the slug is only a filename. Losing that turns the scout's assignment
  // into its own kebab-cased label.
  check('  …with the string kept verbatim as the focus', /\nFocus: How the limiter is wired\n/.test(fromStrings[0]), true)
  check('  …and both scouts still dispatched', strings.calls.filter((c) => c.startsWith('scout:')).length, 2)

  const dupes = []
  await run({ ...BASE, angles: [{ name: 'a', focus: 'x', why: 'w' }, { name: 'a', focus: 'y', why: 'w' }] }, {
    'scout:': (p) => { dupes.push(p); return scoutOf('a') },
    'validate:batch': VALIDATION,
    synthesize: PLAN,
  })
  check('two angles named the same get two files', dispatchedIn(dupes), [`${WS}/findings/a.md`, `${WS}/findings/a-2.md`])

  // The decomposer can collide two names exactly like a caller can, so the same normalization has to
  // cover both branches — fixing only the caller's path leaves the clobbering reachable.
  const decomposed = []
  await run(BASE, {
    decompose: { angles: [{ name: 'dup', focus: 'first', why: 'w' }, { name: 'dup', focus: 'second', why: 'w' }] },
    'scout:': (p) => { decomposed.push(p); return scoutOf('dup') },
    'validate:batch': VALIDATION,
    synthesize: PLAN,
  })
  check('and so do two the decomposer named the same', dispatchedIn(decomposed), [`${WS}/findings/dup.md`, `${WS}/findings/dup-2.md`])

  // A malformed angle throws, and throwing costs nothing: caller-supplied angles skip the
  // decomposer, so nothing has been spawned yet. Guessing the missing half would fabricate the
  // scout's assignment instead — which is why this is a throw and not a warning.
  const rejects = async (angles) => {
    const spy = {}
    try {
      await run({ ...BASE, angles }, { ...fullSweep, synthesize: PLAN }, spy)
      return { message: null, calls: spy.calls }
    } catch (e) { return { message: e.message, calls: spy.calls } }
  }
  const nameless = await rejects([{ focus: 'x' }])
  check('an angle with no name throws, naming the index', /angles\[0\]/.test(nameless.message || ''), true)
  check('  …at zero agents', nameless.calls, [])
  const notArray = await rejects('behavior, callers')
  check('a non-array angles arg throws', /args\.angles must be an array/.test(notArray.message || ''), true)
  check('  …also at zero agents', notArray.calls, [])

  // A malformed-but-FALSY angles value (e.g. `{}` — an object literal, so truthy, but `.length` is
  // undefined, which is falsy) must still be rejected here rather than silently routed into the paid
  // decompose branch by the pre-existing `!angles || !angles.length` shortcut.
  const falsyMalformed = await rejects({})
  check('a falsy non-array angles arg throws too', /args\.angles must be an array/.test(falsyMalformed.message || ''), true)
  check('  …also at zero agents', falsyMalformed.calls, [])

  // The returned path is the one the SCRIPT dispatched, never the scout's self-report — that field
  // is exactly how findings/undefined.md propagated into the caller's `findings` array.
  const drift = await run({ ...BASE, angles: ['storage'] }, {
    'scout:': { ...scoutOf('storage'), report_path: '/somewhere/else.md' },
    'validate:batch': VALIDATION,
    synthesize: PLAN,
  })
  check('findings carry the dispatched path', drift.result.findings.map((f) => f.report_path), [`${WS}/findings/storage.md`])
  check('  …and so does finding_reports', drift.result.finding_reports, [`${WS}/findings/storage.md`])
  check('  …with the divergence logged, not thrown', drift.logs.some((l) => l.includes('/somewhere/else.md')), true)

  // --- Default mode is unchanged: no mode arg means a plan, as before.
  const plain = await run(BASE, { ...fullSweep, synthesize: PLAN })
  check('default mode is plan', [plain.result.mode, plain.result.steps.length], [undefined, 1])
  check('waves are still computed', plain.result.waves, [['s1']])

  // --- Artifact language. The repo's `Artifact language:` line is only worth writing down if it
  // reaches the agent that writes the file, so assert the prompt, not the arg. Both modes: the two
  // synthesizer prompts are separate strings and it is one edit away from being appended to only one.
  const promptOf = async (args) => {
    let seen = ''
    const replies = args.mode === 'explain' ? EXPLAIN : PLAN
    await run(args, { ...fullSweep, synthesize: (p) => { seen = p; return replies } })
    return seen
  }
  const silent = await promptOf(BASE)
  check('no language arg changes nothing', /## Language/.test(silent), false)

  for (const mode of [undefined, 'explain']) {
    const prompt = await promptOf({ ...BASE, mode, language: 'Portuguese' })
    check(`language reaches the ${mode || 'plan'} synthesizer`, /## Language/.test(prompt), true)
    check(`  …naming the language`, /in Portuguese/.test(prompt), true)
    // The failure that would matter: a translated step id, path or verify command is an address
    // that no longer resolves, and every downstream agent follows those literally.
    check(`  …and protecting addresses`, /never the pointer/.test(prompt) && /\bverify\b/.test(prompt), true)
  }

  // --- Acceptance criteria. `covers` is the plan's half of the evidence chain: the spec branch of
  // the synthesizer prompt is the only thing that asks for it, and it is one edit away from being
  // dropped while the schema still declares the field (or from being asked for on a spec-less run,
  // where there is no criterion to name and every id would be invented).
  const withSpec = await promptOf({ ...BASE, specPath: `${WS}/spec.md` })
  check('a spec makes the synthesizer fill covers', /`covers`/.test(withSpec), true)
  check('  …and no spec asks for none', /covers/.test(silent), false)

  // The field itself, read out of the schema source rather than retyped — a shape restated in a test
  // drifts exactly like prose does. Fails closed if the block moves or is reindented: `required`
  // throws and `props` comes back empty, so neither check below can pass on nothing. The `from`
  // offset matters — VALIDATION_SCHEMA has its own `risks:` earlier in the file.
  const stepShapeOf = (src) => {
    const from = src.indexOf('const PLAN_SCHEMA')
    const block = src.slice(from, src.indexOf('\n    risks:', from))
    // Two `required: [...]` arrays live in this slice: PLAN_SCHEMA's own top-level one, then the
    // step's nested one inside `steps.items` — in that order. Take the LAST, so this reads the
    // step's required list and not the schema's.
    const reqs = [...block.matchAll(/required: \[([^\]]+)\]/g)]
    if (!reqs.length) throw new Error('PLAN_SCHEMA step shape not found — this check has stopped testing')
    const req = reqs[reqs.length - 1]
    return {
      props: [...block.matchAll(/^ {10}(\w+): \{/gm)].map((m) => m[1]),
      required: req[1].split(',').map((v) => v.trim().replace(/'/g, '')),
    }
  }
  const planStep = stepShapeOf(SRC)
  check('PLAN_SCHEMA declares covers on a step', planStep.props.includes('covers'), true)
  // Optional, and it must stay optional: a plan written without a spec has no criterion to name, and
  // the lint downstream reports an absent `covers` rather than rejecting the plan.
  check('  …and never requires it', planStep.required.includes('covers'), false)
  // And the extraction reads the STEP's required array, not PLAN_SCHEMA's top-level one: add
  // `covers` to the step's own required list on an in-memory COPY and the same call must flip to
  // true. Without the fix above, this mutation is invisible — `required` would keep coming back as
  // the top-level ['title', 'steps', 'open_questions'] no matter what the step declares.
  check('  …and required tracks the step, not the top-level schema',
    stepShapeOf(SRC.replace(
      "required: ['id', 'title', 'goal', 'files', 'depends_on', 'details']",
      "required: ['id', 'title', 'goal', 'files', 'depends_on', 'details', 'covers']"
    )).required.includes('covers'), true)
  // And the extraction bites: rename the property on an in-memory COPY and the same call must report
  // it gone, so this cannot quietly stop testing.
  check('  …and it fails when the field disappears',
    stepShapeOf(SRC.replace(/\n( {10})covers: \{/, '\n$1coversRenamed: {')).props.includes('covers'), false)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main()
