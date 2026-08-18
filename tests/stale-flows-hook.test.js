// The SessionStart hook's contract, exercised by running the shipped hook against real directories.
//
// `hooks/session-start-stale-flows.sh` is the one piece of this repo that runs unasked in every
// session of every repo that installs the plugin, and its contract is mostly about what it does NOT
// print: silence when nothing is stale. That half has no runtime symptom when it breaks — a hook
// that starts chattering is not an error, it is just a hook everyone turns off — so it belongs in
// the suite rather than in someone's memory.
//
// The new half is the isolated flow. `/dev-implement <slug> --isolated` leaves the work in a git
// worktree, not in the checkout the next session opens in, so an abandoned isolated run has to say
// where its work went. `worktree` is a flat top-level string exactly so the hook's parser-free
// field() can read it, and these cases are what pin that: read wherever the key sits in the object,
// pretty-printed or compact, never confused with `worktree_branch`, and never printed as an empty
// label on the flows that do not have one.
//
// Behavioural, not drift-style: every case drives the real hook and reads its stdout, so a hook that
// stopped working fails them by construction. Every fixture lives under os.tmpdir(); nothing here
// writes a tracked file, and the hook is always handed its root as argv[1] so no case can reach the
// developer's own repository.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const HOOK = path.join(ROOT, 'hooks', 'session-start-stale-flows.sh')

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

const made = []
const tmp = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `devkit-stale-${tag}-`))
  made.push(d)
  return d
}

// A repo-shaped fixture: one `.dev/<slug>/state.json` per flow. An object is pretty-printed, which
// is the shape the skills actually write; a string is written verbatim, which is how the key-order
// and compact-file cases below are expressed.
function fixture(tag, flows) {
  const dir = tmp(tag)
  for (const [slug, state] of Object.entries(flows)) {
    fs.mkdirSync(path.join(dir, '.dev', slug), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.dev', slug, 'state.json'),
      typeof state === 'string' ? state : `${JSON.stringify(state, null, 2)}\n`,
    )
  }
  return dir
}

// The hook must never fail a session start, so the status is asserted next to stdout everywhere.
// $CLAUDE_PROJECT_DIR is removed rather than overridden: the root under test is argv[1], and a case
// that silently fell back to the environment would be reading the developer's real repo.
function run(dir) {
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  try {
    const stdout = execFileSync('sh', [HOOK, dir], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout }
  } catch (e) {
    return { status: e.status === undefined ? -1 : e.status, stdout: String(e.stdout || '') }
  }
}
// The flow rows, as opposed to the header and the two trailer lines.
const rows = (out) => out.split('\n').filter((l) => l.startsWith('  - '))

// ---- 1. An isolated flow says where its work is.
// Every expected value below comes out of this object, so the fixture is the single source for what
// the row should contain; only the row's FORM is stated in the test, because the hook is what owns
// it and it is the thing under test.
const isoState = {
  task: 'worktree-isolated implement',
  stage: 'implementing',
  updated: '2026-08-18 09:14',
  baseline: '1e5a17ad3f',
  worktree: '/home/dev/devkit/.dev/worktree-isolation/worktree',
  worktree_branch: 'dev/worktree-isolation-iso',
  lastRunId: 'wf_abc123',
}
const iso = run(fixture('isolated', { 'worktree-isolation': isoState }))
check('the hook exits 0 — it can never fail a session start', iso.status, 0)
check('a stale isolated flow is reported at all',
  iso.stdout.startsWith('devkit: a workspace is left at `implementing`'), true)
check('and its row names slug, update time and worktree path', rows(iso.stdout),
  [`  - worktree-isolation  (last updated ${isoState.updated})  worktree: ${isoState.worktree}`])
// Names are addresses: the two commands the message hands the developer have to be the real ones.
check('and it still names what continues a flow and what clears it',
  ['/dev-implement <slug>', '/dev-status', 'concurrency lock'].filter((t) => !iso.stdout.includes(t)), [])

// ---- 2. A non-isolated flow is untouched — no label, not even an empty one.
const plainState = { task: 'ordinary implement', stage: 'implementing', updated: '2026-08-17 22:03' }
const plain = run(fixture('plain', { 'plain-flow': plainState }))
check('a stale flow with no worktree key keeps its row unchanged', rows(plain.stdout),
  [`  - plain-flow  (last updated ${plainState.updated})`])
check('and nothing about worktrees is printed for it', /worktree/.test(plain.stdout), false)

// Both labels are independent of each other: a state with a worktree but no `updated` prints one.
const wt = '/srv/checkout/.dev/k/worktree'
const noUpdated = run(fixture('no-updated', { k: `{"stage":"implementing","worktree":"${wt}"}\n` }))
check('the worktree label does not depend on updated', rows(noUpdated.stdout), [`  - k  worktree: ${wt}`])
// And the pre-existing bare row still works, which is the other end of the same `${var:+…}` chain.
const bare = run(fixture('bare', { bare: '{"stage":"implementing"}\n' }))
check('a flow with neither field is still a bare row', rows(bare.stdout), ['  - bare'])

// ---- 3. Mixed: the plural header, and only the isolated flow carrying a path.
const mixed = run(fixture('mixed', { 'a-plain': plainState, 'b-iso': isoState }))
check('two stale flows get the plural header',
  mixed.stdout.startsWith('devkit: 2 workspaces are left at `implementing`'), true)
check('and exactly one of the two rows carries a worktree',
  rows(mixed.stdout).filter((l) => l.includes('worktree: ')).length, 1)

// ---- 4. Silence is the contract. Each of these must print nothing at all and still exit 0 —
// including an isolated flow that FINISHED, because a `worktree` key is not a staleness signal.
const emptyDev = tmp('empty-dev')
fs.mkdirSync(path.join(emptyDev, '.dev'))
const noState = tmp('no-state')
fs.mkdirSync(path.join(noState, '.dev', 'workspace'), { recursive: true })
for (const [name, dir] of [
  ['no .dev directory at all', tmp('no-dev')],
  ['a .dev holding nothing', emptyDev],
  ['a workspace with no state file', noState],
  ['a root that does not exist', path.join(tmp('gone'), 'nope')],
  ['a finished flow', fixture('done', { done: { stage: 'implemented', updated: '2026-08-16 08:00' } })],
  ['a finished ISOLATED flow', fixture('done-iso', { done: { ...isoState, stage: 'implemented' } })],
  ['a flow whose stage merely contains the word', fixture('substring', { s: { stage: 'not-implementing-yet' } })],
]) {
  const r = run(dir)
  check(`silent: ${name}`, [r.status, r.stdout], [0, ''])
}

// ---- 5. field() finds `worktree` wherever it sits, and never mistakes `worktree_branch` for it.
// This is the whole reason the state key is flat: the hook has no JSON parser, and `worktree_branch`
// is a prefix-lookalike sitting right next to it in every real isolated state file.
const stamp = '2026-08-18 10:00'
const shapes = {
  'a-first-key': `{"worktree":"${wt}","stage":"implementing","updated":"${stamp}"}\n`,
  'b-last-key': `{"stage":"implementing","updated":"${stamp}","worktree":"${wt}"}\n`,
  'c-after-lookalike': `{"stage":"implementing","updated":"${stamp}","worktree_branch":"dev/k","worktree":"${wt}"}\n`,
  'd-before-lookalike': `{"stage":"implementing","worktree":"${wt}","worktree_branch":"dev/k","updated":"${stamp}"}\n`,
  'e-pretty-printed': `{\n  "stage": "implementing",\n  "worktree_branch": "dev/k",\n  "worktree": "${wt}",\n  "updated": "${stamp}"\n}\n`,
}
const shaped = run(fixture('shapes', shapes))
check('worktree is read at any position, in any formatting, past its lookalike',
  rows(shaped.stdout),
  Object.keys(shapes).sort().map((slug) => `  - ${slug}  (last updated ${stamp})  worktree: ${wt}`))

// The negative half of the same guard: `worktree_branch` ALONE must not be read as `worktree`, or
// every isolated flow whose worktree key was dropped by `archive` would print a branch as a path.
const branchOnly = run(fixture('branch-only', {
  b: `{"stage":"implementing","updated":"${stamp}","worktree_branch":"dev/k"}\n`,
}))
check('worktree_branch alone is not read as a worktree path', rows(branchOnly.stdout),
  [`  - b  (last updated ${stamp})`])

for (const d of made) fs.rmSync(d, { recursive: true, force: true })

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
