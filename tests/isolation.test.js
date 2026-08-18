// `root` — the one arg that tells every agent an implement run spawns WHICH TREE to run its commands
// in, driven through both scripts' REAL entry points.
//
// The scripts have no filesystem, no shell and no way to set anybody's working directory: an isolated
// run steers its agents with prompt text and nothing else. So the thing to test is the text — that it
// reaches every prompt that issues a command, that the nested review loop is handed the same root,
// and that a run WITHOUT one is byte-identical to what has always been sent (AC-06). The last claim
// is the one a `.includes()` cannot make, so it is asserted by equivalence instead: strip the note and
// the two root-aware command prefixes out of an isolated prompt and what remains must equal the
// non-isolated prompt EXACTLY. A splice that leaked a newline into the ordinary path fails there.
//
// Every expected string is evaluated FROM THE SOURCE's own constant lines — a note retyped here would
// drift exactly like restated prose, and the drift would be invisible because both sides would still
// contain the word "worktree".
const fs = require('fs')
const path = require('path')

const REPO = path.join(__dirname, '..')
const wf = (name) => fs.readFileSync(path.join(REPO, 'workflows', name), 'utf8')
const IMPL_RAW = wf('wf-implement.js')
const REVIEW_RAW = wf('wf-review-loop.js')
const IMPL_SRC = IMPL_RAW.replace(/^export const meta/m, 'const meta')
const REVIEW_SRC = REVIEW_RAW.replace(/^export const meta/m, 'const meta')

// The four constants are the whole mechanism. A self-contained Workflow script cannot import a
// helper, so they exist twice; pulled by line prefix here, fail-closed, exactly as
// tests/verify-gate.test.js pulls the two infra-error helpers.
const CONSTANTS = ['root', 'GIT', 'RUN_FROM', 'ROOT_NOTE']
function constLine(src, file, name) {
  const line = src.split('\n').find((l) => l.startsWith(`const ${name} = `))
  if (!line) throw new Error(`${file}: no line starting with "const ${name} = " — has it been renamed?`)
  return line
}
const sameConst = (a, b, name) => constLine(a, 'wf-implement.js', name) === constLine(b, 'wf-review-loop.js', name)
// A copy of a source line with that line changed — the negative case for the comparison above, so it
// is proved to still be testing something. In memory: nothing here touches a tracked file.
const drift = (src, file, name) => src.replace(constLine(src, file, name), `${constLine(src, file, name)} // drift`)

// Evaluated, not pattern-matched: this is the script's own expression producing the script's own
// string for a given root, so what the test expects and what the run sends cannot disagree.
function valueOf(src, file, name, root) {
  const decl = name === 'root' ? '' : `\n${constLine(src, file, name)}`
  return new Function('args', `${constLine(src, file, 'root')}${decl}\nreturn ${name}`)({ root })
}

const WT = '/wt'
const NOTE = valueOf(IMPL_SRC, 'wf-implement.js', 'ROOT_NOTE', WT)
const GIT_AT = valueOf(IMPL_SRC, 'wf-implement.js', 'GIT', WT)
const GIT_PLAIN = valueOf(IMPL_SRC, 'wf-implement.js', 'GIT', '')
const RUN_AT = valueOf(IMPL_SRC, 'wf-implement.js', 'RUN_FROM', WT)
const RUN_PLAIN = valueOf(IMPL_SRC, 'wf-implement.js', 'RUN_FROM', '')
// The note's own heading, so "does this prompt carry a work root at all?" is asked with the script's
// word and not with one this file chose.
const MARKER = NOTE.split('\n').find((l) => l.startsWith('## '))
if (!MARKER) throw new Error('the work-root note has no heading line — what should absence be detected by?')

// AC-06, said as an equivalence: an isolated prompt minus the note and minus the two root-aware
// command prefixes IS the non-isolated prompt. Order matters — the note itself quotes the git prefix.
const deIsolate = (text) => text.split(NOTE).join('').split(GIT_AT).join(GIT_PLAIN).split(RUN_AT).join(RUN_PLAIN)

// ---- wf-implement harness: tests/delivery-verdict.test.js's, with the gate left ON (it is one of the
// prompts under test) and scoutMode 'always' so a scout prompt exists to inspect. The checkpoint
// policy is left at its defaults ON PURPOSE: a wave that flushes to a checkpoint never gates, so
// forcing checkpoints (what the other harnesses do) would silently drop `gate:wave-1` from this run.
// Neither step declares risk 'contract' for the same reason.
const BASELINE = 'a1b2c3d'
const STEPS = [
  { id: 's1', title: 'thread the root', goal: 'carry the work root into every prompt', files: ['src/a.ts'], depends_on: [], verify: 'node tests/a.test.js', details: 'one opaque string arg spliced into the prompts that run commands' },
  { id: 's2', title: 'consume it', goal: 'pass the same root to the nested review loop', files: ['src/b.ts'], depends_on: ['s1'], verify: 'node tests/b.test.js', details: 'the checkpoint reviewer must read the same tree the implementers wrote' },
]
const brief = (id) => ({ summary: `context for ${id}`, brief_path: `/w/briefs/${id}.md`, gotchas: [], too_big: false })
const implReply = (id) => ({
  summary: `${id} implemented`,
  changed_files: [`src/${id}.ts`],
  notes_path: `/w/notes/${id}.md`,
  verify_run: { ran: true, command: `node tests/${id}.test.js`, passed: true, kind: 'new-test', output_summary: 'green' },
})
const IMPL_REPLIES = {
  'scout:s1': brief('s1'),
  'scout:s2': brief('s2'),
  'impl:s1': implReply('s1'),
  'impl:s2': implReply('s2'),
  'gate:wave-1': { coherent: true, breaks: [] },
  'consistency-check': { consistent: true, issues: [], suite_run: { ran: true, command: 'sh tests/run-all.sh', passed: true, output_summary: 'suite green' } },
}
const CLEAN_REVIEW = { clean: true, rounds: 1, confirmed: [], applied: [], skipped: [] }

// `calls` is owned by the CALLER, because one case asserts what ran before a THROW: a calls array
// returned through the resolved promise is unreachable on the path that rejects, so that assertion
// would pass on an empty array it never filled.
function runImpl(extraArgs, calls = []) {
  const prompts = {}
  const reviewArgs = []
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    const key = Object.keys(IMPL_REPLIES).find((k) => k === opts.label)
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    prompts[opts.label] = prompt
    return IMPL_REPLIES[key]
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()))
  const workflow = async (ref, wargs) => { reviewArgs.push(wargs); return CLEAN_REVIEW }
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${IMPL_SRC}})()`)
  return fn({ workspace: '/w', steps: STEPS, baseline: BASELINE, scoutMode: 'always', ...extraArgs },
    () => {}, agent, parallel, parallel, () => {}, workflow,
    { total: null, spent: () => 0, remaining: () => Infinity })
    .then((result) => ({ result, calls, prompts, reviewArgs }))
}

// ---- wf-review-loop harness: tests/lens-composition.test.js's, plus tests/fix-verify.test.js's
// seeded shape, which is the only cheap way to reach the post-fix check prompt.
function runReview(args, replies, calls = []) {
  const prompts = {}
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    // Exact match first: `check r1` is a prefix of `check r1 (retry)`.
    const key = Object.keys(replies).find((k) => k === opts.label) || Object.keys(replies).find((k) => opts.label.startsWith(k))
    if (!key) throw new Error(`unexpected agent: ${opts.label}`)
    prompts[opts.label] = prompt
    return replies[key]
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
  const fn = new Function('args', 'log', 'agent', 'parallel', 'pipeline', 'phase', 'workflow', 'budget',
    `return (async () => {${REVIEW_SRC}})()`)
  return fn(args, () => {}, agent, parallel, parallel, () => {}, async () => ({}),
    { total: null, spent: () => 0, remaining: () => Infinity }).then((result) => ({ result, calls, prompts }))
}

const CMD = 'sh tests/run-all.sh'
const SEED = [{ id: 'f1', title: 'unchecked null deref', file: 'src/a.ts', line: 12, severity: 'high', confirmed: true }]
const FIXED = { applied: [{ id: 'f1', title: 'unchecked null deref', file: 'src/a.ts', what: 'guarded the deref' }], skipped: [] }
const SEEDED = { scope: 'src/a.ts', intent: 'ship the queue change', baseline: BASELINE, apply: true, maxRounds: 2, seedFindings: SEED, verifyCommand: CMD }
const SEEDED_REPLIES = { 'fix r1': FIXED, 'check r1': { ran: true, command: CMD, passed: true }, 're-review r2': { findings: [] } }
const SWEEP = { scope: 'src/a.ts', intent: 'ship the queue change', baseline: BASELINE, apply: false, maxRounds: 1 }

let failed = 0
let cases = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  cases++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

async function rejects(promise) {
  try {
    await promise
    return 'resolved'
  } catch (e) {
    return e.message
  }
}

async function main() {
  // ---- 1. One mechanism, two copies. A self-contained script cannot import a helper, so the four
  // constants are duplicated; a change to one that misses the other is the failure this catches.
  for (const name of CONSTANTS) {
    check(`const ${name} is byte-identical in both scripts`, sameConst(IMPL_SRC, REVIEW_SRC, name), true)
    check(`  └─ and the comparison goes red when that copy drifts`,
      sameConst(IMPL_SRC, drift(REVIEW_SRC, 'wf-review-loop.js', name), name), false)
  }
  // The empty branch is what AC-06 rests on: no root, no bytes.
  check('no root → the note is the empty string', valueOf(IMPL_SRC, 'wf-implement.js', 'ROOT_NOTE', ''), '')
  check('  └─ and the git prefix is bare git', GIT_PLAIN, 'git')

  // ---- 2. wf-implement: the root reaches every prompt that issues a command.
  const iso = await runImpl({ root: WT })
  const plain = await runImpl({})
  check('both runs spawned the same agents', iso.calls, plain.calls)
  const PROMPTS = ['scout:s1', 'impl:s1', 'gate:wave-1', 'consistency-check']
  for (const label of PROMPTS) {
    check(`${label} carries the work root`, iso.prompts[label].includes(NOTE), true)
    // AC-06 at the JS layer: without a root the note is not merely empty, it is ABSENT.
    check(`  └─ and without a root it is not mentioned`, plain.prompts[label].includes(MARKER), false)
    // …and nothing else moved: strip the isolated additions and the two prompts are the same bytes.
    check(`  └─ non-isolated prompt is byte-identical`, deIsolate(iso.prompts[label]) === plain.prompts[label], true)
  }

  // The commands the prompts quote name the tree too — a `git diff` run in the primary checkout of an
  // isolated run reports no change at all, which reads exactly like a step that did nothing.
  check('the gate inspects the diff in the work root', iso.prompts['gate:wave-1'].includes(`"${GIT_AT} diff ${BASELINE}`), true)
  check('  └─ and plain git without one', plain.prompts['gate:wave-1'].includes(`"${GIT_PLAIN} diff ${BASELINE}`), true)

  // The workspace is deliberately OUTSIDE the worktree (it holds state.json, the lock and the plan),
  // so the note has to say so or an implementer will write its notes into the tree about to be
  // discarded. Asserted by value: the note names the workspace path the prompt also names.
  check('the note tells agents not to redirect workspace paths', NOTE.includes('OUTSIDE'), true)
  check('  └─ and the impl prompt still names the workspace it must write to',
    iso.prompts['impl:s1'].includes('/w/notes/s1.md'), true)

  // ---- 3. The nested review loop gets the same root: the only nested workflow() call in the repo.
  check('the checkpoint review is handed the same root', iso.reviewArgs[0].root, WT)
  check('  └─ alongside the same baseline', iso.reviewArgs[0].baseline, BASELINE)
  check('  └─ and no root when there is none', plain.reviewArgs[0].root, undefined)

  // ---- 4. Malformed roots are refused before a single agent runs — a relative path would be
  // resolved against whatever cwd each agent happens to have, which is the bug this whole arg exists
  // to prevent.
  const relCalls = []
  check('a relative root throws', /absolute path/.test(await rejects(runImpl({ root: 'wt' }, relCalls))), true)
  check('  └─ before any agent runs', relCalls, [])
  const relReviewCalls = []
  check('  └─ in the review loop too',
    /absolute path/.test(await rejects(runReview({ ...SWEEP, root: 'wt' }, { 'review:': { findings: [] } }, relReviewCalls))), true)
  check('  └─ there too, before any agent runs', relReviewCalls, [])
  // A trailing slash is a caller's typo, not a different tree.
  const slashed = await runImpl({ root: `${WT}/` })
  check('a trailing slash is normalized away', slashed.reviewArgs[0].root, WT)
  check('  └─ in the prompts as well', slashed.prompts['impl:s1'].includes(NOTE), true)

  // ---- 5. wf-review-loop, reached standalone: the round-1 reviewers and the post-fix check.
  const sweepIso = await runReview({ ...SWEEP, root: WT }, { 'review:': { findings: [] } })
  const sweepPlain = await runReview(SWEEP, { 'review:': { findings: [] } })
  check('every round-1 reviewer was spawned', sweepIso.calls, sweepPlain.calls)
  check('  └─ and every one of them carries the work root',
    sweepIso.calls.every((c) => sweepIso.prompts[c].includes(NOTE)), true)
  check('  └─ none of them mentions it without a root',
    sweepPlain.calls.some((c) => sweepPlain.prompts[c].includes(MARKER)), false)
  check('  └─ and the baseline diff names the work root',
    sweepIso.calls.every((c) => sweepIso.prompts[c].includes(`"${GIT_AT} diff ${BASELINE}`)), true)
  check('  └─ non-isolated reviewer prompts are byte-identical',
    sweepIso.calls.every((c) => deIsolate(sweepIso.prompts[c]) === sweepPlain.prompts[c]), true)

  const fixIso = await runReview({ ...SEEDED, root: WT }, SEEDED_REPLIES)
  const fixPlain = await runReview(SEEDED, SEEDED_REPLIES)
  check('the post-fix check ran in both', [fixIso.calls.includes('check r1'), fixPlain.calls.includes('check r1')], [true, true])
  check('  └─ the check prompt carries the work root', fixIso.prompts['check r1'].includes(NOTE), true)
  // The heading used to hardcode "the repository root", which is the WRONG tree for an isolated run.
  check('  └─ and names it as the directory to run from', fixIso.prompts['check r1'].includes(RUN_AT), true)
  check('  └─ the repository root when there is no root', fixPlain.prompts['check r1'].includes(RUN_PLAIN), true)
  check('  └─ without a root the check prompt is byte-identical',
    deIsolate(fixIso.prompts['check r1']) === fixPlain.prompts['check r1'], true)
  check('  └─ and the fixer is told too', fixIso.prompts['fix r1'].includes(NOTE), true)

  console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
