// The worktree lifecycle contract, exercised by running the shipped script against REAL git.
//
// `scripts/worktree.sh` is what `/dev-implement <slug> --isolated` and `/dev-status clean|archive`
// both call, so its behaviour is the feature. Everything here drives the real script in a throwaway
// repository and reads git back afterwards: a script that stopped working fails these by
// construction, and the refusal cases are the negative half — they prove each guard bites rather
// than merely existing.
//
// The load-bearing property is AC-03: creating, using and removing the worktree must leave the
// developer's primary checkout byte-for-byte untouched, INCLUDING uncommitted work that was already
// there. So the repository below is deliberately dirty before the first command runs, and the same
// three-part snapshot (the tracked file's bytes, `git status --porcelain`, `HEAD`) is re-compared
// after every stage.
//
// HONEST SCOPE. This file proves the property for the LIFECYCLE — the script's own commands. It does
// NOT prove "a whole `/dev-implement --isolated` run left the primary untouched": nothing in this
// suite executes a SKILL.md, and the workflow-script harness has no `fs` and no `child_process`. The
// remaining half is an in-run assertion the skill performs on every isolated run (it re-compares the
// same two snapshot commands before integrating) plus a by-hand acceptance check. A green suite here
// is evidence about this script and nothing wider.
//
// Every temp directory lives under os.tmpdir(); nothing here writes a tracked file, and no command
// below runs against this repository.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'worktree.sh')

let failed = 0
let cases = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  cases++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

const made = []
// realpath, because `git rev-parse --show-toplevel` resolves symlinks and os.tmpdir() is one on
// macOS — without this every path comparison below would fail for a reason that is not a bug.
const tmp = (tag) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `devkit-worktree-${tag}-`)))
  made.push(d)
  return d
}

// git's environment overrides `cwd` when it comes to choosing a repository, and a git HOOK exports
// GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE into everything it runs. This repo ships an opt-in pre-commit
// hook that runs the whole suite, and `/dev-implement --isolated` makes its phase commit INSIDE the
// worktree — so this file's `git init` calls would resolve to the developer's real repository
// instead of the throwaway one. Reproduced before this scrub existed: the primary repo was re-inited
// through the inherited GIT_DIR and came back with `core.bare = true`, which breaks every later
// `git status` in that checkout. Scrubbing is the fix; `cwd` alone is not enough.
const ENV = (() => {
  const e = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) delete e[k]
  return e
})()

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '')
}
function gitQuiet(cwd, args) {
  try { return git(cwd, args) } catch (e) { return null }
}

// One run of the shipped script. Returns status/stdout/stderr instead of throwing, because refusal
// IS a case here; stderr is piped so a refusal message is data, not noise in the suite output.
function run(cwd, args) {
  try {
    const stdout = execFileSync('sh', [SCRIPT, ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    return { status: e.status === undefined ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
  }
}
const parse = (s) => { try { return JSON.parse(s) } catch (e) { return null } }
const oneJsonLine = (stdout) => /^\{.*\}\n$/.test(stdout) && parse(stdout) !== null

// A throwaway repo shaped like the ones this feature runs in: `.dev/*` gitignored (that is what keeps
// a nested worktree invisible to the primary's `git status`) and one tracked file to dirty.
function makeRepo(tag, branch, at) {
  const dir = at || tmp(tag)
  if (at) fs.mkdirSync(at, { recursive: true })
  git(dir, ['init', '-q', '-b', branch])
  git(dir, ['config', 'user.email', 'devkit@example.invalid'])
  git(dir, ['config', 'user.name', 'devkit tests'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  // Distinct content per repo, so two repos committed in the same second cannot share a commit sha
  // and quietly make a cross-repo comparison below pass for the wrong reason.
  fs.writeFileSync(path.join(dir, 'tracked.txt'), `one\ntwo\n${tag}\n`)
  fs.writeFileSync(path.join(dir, '.gitignore'), '.dev/*\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

// The three things AC-03 is about, in one value: the bytes of the file the developer was editing,
// what git thinks is uncommitted, and where the branch points.
function snapshot(dir) {
  return {
    tracked: fs.readFileSync(path.join(dir, 'tracked.txt')).toString('base64'),
    status: git(dir, ['status', '--porcelain']),
    head: git(dir, ['rev-parse', 'HEAD']),
  }
}
const worktreePaths = (dir) =>
  git(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length

// ---- 1. setup: the line it prints, and the tree it creates.
const repo = makeRepo('lifecycle', 'main')
const baseline = git(repo, ['rev-parse', 'HEAD'])
// Dirtied BEFORE anything runs — this is the uncommitted work AC-03 is protecting.
fs.appendFileSync(path.join(repo, 'tracked.txt'), 'an uncommitted local edit\n')
const before = snapshot(repo)
check('the primary really is dirty, so the AC-03 checks below can fail', before.status.includes('tracked.txt'), true)

const setup = run(repo, ['setup', 'demo', baseline])
check('setup exits 0', setup.status, 0)
check('setup prints exactly one JSON line and nothing else on stdout', oneJsonLine(setup.stdout), true)
const line = parse(setup.stdout) || {}
check('path is the worktree nested in the flow workspace', line.path, path.join(repo, '.dev', 'demo', 'worktree'))
check('branch defaults to the FLAT <slug>-iso', line.branch, 'demo-iso')
check('baseline is the resolved commit, not the shorthand asked for', line.baseline, baseline)
check('setup_ms is a non-negative number', typeof line.setup_ms === 'number' && line.setup_ms >= 0, true)
check('disk_kb is a positive number', typeof line.disk_kb === 'number' && line.disk_kb > 0, true)

// ---- 2. AC-02's precondition: the worktree is AT the baseline, so `git diff <baseline>` means the
// same thing to every agent the flow spawns.
check('the worktree is checked out at the baseline', git(line.path, ['rev-parse', 'HEAD']), baseline)
check('and on the branch the line named', git(line.path, ['rev-parse', '--abbrev-ref', 'HEAD']), line.branch)

// ---- 3. AC-03, at creation.
const afterSetup = snapshot(repo)
check('AC-03: the dirtied tracked file is byte-identical after setup', afterSetup.tracked, before.tracked)
check('AC-03: the primary git status is unchanged after setup', afterSetup.status, before.status)
check('AC-03: the primary HEAD is unchanged after setup', afterSetup.head, before.head)

// ---- 4. AC-03 again, after real work lands inside the worktree. This is the case that matters:
// a commit on the isolated branch must not move the primary's HEAD or touch its tree.
fs.writeFileSync(path.join(line.path, 'tracked.txt'), 'one\ntwo\nwork done inside the worktree\n')
git(line.path, ['add', '-A'])
git(line.path, ['commit', '-qm', 'work inside the worktree'])
const worktreeCommit = git(line.path, ['rev-parse', 'HEAD'])
check('the worktree moved off the baseline', worktreeCommit !== baseline, true)
const afterCommit = snapshot(repo)
check('AC-03: the primary is byte-identical after a commit inside the worktree',
  [afterCommit.tracked, afterCommit.status, afterCommit.head],
  [before.tracked, before.status, before.head])

// ---- 5. The guards, while the worktree exists. Each must refuse BEFORE writing anything.
const inner = run(line.path, ['setup', 'inner', baseline])
check('setup from inside a linked worktree is refused', inner.status, 2)
check('and explains itself in one stderr line', inner.stderr.trim().split('\n').length === 1 && inner.stderr.startsWith('worktree:'), true)
check('and creates nothing, in either tree',
  [fs.existsSync(path.join(line.path, '.dev')), fs.existsSync(path.join(repo, '.dev', 'inner'))], [false, false])

const dup = run(repo, ['setup', 'demo', baseline])
check('a second setup for the same slug is refused', dup.status, 2)
check('naming the branch that blocks it, so the caller can pass an explicit one', dup.stderr.includes(line.branch), true)

const badBaseline = run(repo, ['setup', 'other', '0'.repeat(40)])
check('setup with a baseline that does not resolve is refused', badBaseline.status, 2)
check('and creates nothing', fs.existsSync(path.join(repo, '.dev', 'other')), false)

fs.mkdirSync(path.join(repo, '.dev', 'taken', 'worktree'), { recursive: true })
const taken = run(repo, ['setup', 'taken', baseline, 'branch-for-taken'])
check('setup onto a path that already exists is refused', taken.status, 2)
check('and no branch was created on the way there', gitQuiet(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/branch-for-taken']), null)

const ghost = run(repo, ['remove', 'never-existed'])
check('remove for a slug with no registered worktree is refused', ghost.status, 2)
check('"already gone" is not silently reported as removed', ghost.stdout, '')

check('every refusal keeps stdout empty — only a result is ever printed there',
  [inner.stdout, dup.stdout, badBaseline.stdout, taken.stdout, ghost.stdout].join(''), '')
check('the worktree count never moved while the guards fired', worktreePaths(repo), 2)

// ---- 6. remove: the worktree goes, the branch and its commits stay.
const removed = run(repo, ['remove', 'demo'])
check('remove exits 0', removed.status, 0)
check('remove prints exactly one JSON line', oneJsonLine(removed.stdout), true)
const rline = parse(removed.stdout) || {}
check('naming the path it removed', rline.path, line.path)
check('reporting removed:true', rline.removed, true)
check('and naming the branch it KEPT', rline.branch_kept, line.branch)
check('the worktree directory is gone', fs.existsSync(line.path), false)
check('git is back to one worktree', worktreePaths(repo), 1)
check('AC-05: the branch survives cleanup, with the work still on it',
  gitQuiet(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${line.branch}`]), worktreeCommit)
const afterRemove = snapshot(repo)
check('AC-03: the primary is still byte-identical after remove',
  [afterRemove.tracked, afterRemove.status, afterRemove.head],
  [before.tracked, before.status, before.head])

// ---- 7. --force is an explicit opt-in, never the default: uncommitted work in the worktree stops
// a plain remove, and git's refusal is reported as its own exit code rather than swallowed.
const dirty = run(repo, ['setup', 'dirty', baseline])
check('a second flow can be set up in the same repo', dirty.status, 0)
const dirtyPath = (parse(dirty.stdout) || {}).path
fs.writeFileSync(path.join(dirtyPath, 'scratch.txt'), 'uncommitted work\n')
const refusedDirty = run(repo, ['remove', 'dirty'])
check('remove refuses a worktree holding uncommitted work', refusedDirty.status, 3)
check('and leaves it exactly where it was', fs.existsSync(dirtyPath), true)
const forced = run(repo, ['remove', 'dirty', '--force'])
check('--force removes it', forced.status, 0)
check('and even then the branch survives',
  gitQuiet(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/dirty-iso']) !== null, true)
check('an unknown option is refused rather than ignored', run(repo, ['remove', 'dirty', '--wipe']).status, 2)

// ---- 8. The ref-directory conflict. A repository holding a branch named `dev` cannot hold any
// branch under `refs/heads/dev/` at all: refs are files, so the file `refs/heads/dev` blocks the
// directory `refs/heads/dev/`. That is a DIFFERENT failure from "branch already exists", it is not
// caught by `git check-ref-format`, and a throwaway repo defaulting to `main` would never show it.
//
// The DEFAULT branch name is flat (`<slug>-iso`) precisely so this cannot fire on it — a `main` +
// `dev` layout is ordinary, and a default that dies there is a default nobody can use. So the
// conflict is provoked the only way it still reaches a caller: an explicit prefixed [branch], which
// is what `/dev-implement` passes when the flat default is already taken.
const devRepo = makeRepo('default-branch-dev', 'dev')
const devBaseline = git(devRepo, ['rev-parse', 'HEAD'])
fs.appendFileSync(path.join(devRepo, 'tracked.txt'), 'an uncommitted local edit\n')
const devBefore = snapshot(devRepo)
// First: the flat default is unaffected by the `dev` branch, which is the whole point of the change.
const flatOk = run(devRepo, ['setup', 'flat', devBaseline])
check('the FLAT default works in a repo whose branch is `dev`', flatOk.status, 0)
check('and takes the flat name', (parse(flatOk.stdout) || {}).branch, 'flat-iso')
run(devRepo, ['remove', 'flat'])
const collide = run(devRepo, ['setup', 'iso', devBaseline, 'dev/iso'])
check('an explicit `dev/<slug>` is refused up front in that repo', collide.status, 2)
check('naming the ref that blocks it', collide.stderr.includes('refs/heads/dev'), true)
check('and creating nothing at all', fs.existsSync(path.join(devRepo, '.dev', 'iso')), false)
check('AC-03: the primary is untouched by the refusal',
  [snapshot(devRepo).tracked, snapshot(devRepo).status, snapshot(devRepo).head],
  [devBefore.tracked, devBefore.status, devBefore.head])

// The advice has to be actionable, not merely plausible: take the branch name the refusal offers and
// run it. `dev/<slug>-iso` would collide on the very same `dev` prefix, so this case is what keeps
// the suggested escape honest instead of confidently wrong.
const suggestion = (collide.stderr.match(/for example "([^"]+)"/) || [])[1]
check('the refusal offers a branch name to pass instead', !!suggestion, true)
const rescued = run(devRepo, ['setup', 'iso', devBaseline, suggestion || ''])
check('and that suggested branch actually works in this repository', rescued.status, 0)
const rescuedLine = parse(rescued.stdout) || {}
check('on exactly the branch that was suggested', rescuedLine.branch, suggestion)
check('at the baseline', git(rescuedLine.path || devRepo, ['rev-parse', 'HEAD']), devBaseline)
const rescuedRemoved = parse(run(devRepo, ['remove', 'iso']).stdout) || {}
check('and remove reports the branch git really had there, not the default',
  rescuedRemoved.branch_kept, suggestion)

// The mirror image, in a repo of its own so exactly one ref can be the blocker: with `dev/only`
// present, `refs/heads/dev` is a ref DIRECTORY, so a branch literally named `dev` cannot be created.
const mirrorRepo = makeRepo('ref-directory', 'main')
const mirrorBaseline = git(mirrorRepo, ['rev-parse', 'HEAD'])
git(mirrorRepo, ['branch', 'dev/only', mirrorBaseline])
const mirror = run(mirrorRepo, ['setup', 'mirror-slug', mirrorBaseline, 'dev'])
check('a branch blocked by refs beneath it is refused too', mirror.status, 2)
check('naming the ref beneath it', mirror.stderr.includes('dev/only'), true)
check('and creating nothing', fs.existsSync(path.join(mirrorRepo, '.dev')), false)

// ---- 8b. A repository path with a space and a non-ASCII character. `remove` finds its registration
// and its branch by parsing `git worktree list --porcelain`, which is exactly the parse a space
// breaks; and the JSON line has to survive the same path. Not a hypothetical — developers keep
// checkouts under directories they named themselves.
const oddRepo = makeRepo('odd', 'main', path.join(tmp('odd-parent'), 'sp ace-\u00fcn\u00ef'))
const oddBaseline = git(oddRepo, ['rev-parse', 'HEAD'])
const oddSetup = run(oddRepo, ['setup', 'odd', oddBaseline])
check('setup works under a path with a space and a non-ASCII character', oddSetup.status, 0)
check('and the JSON line still parses, path intact', (parse(oddSetup.stdout) || {}).path, path.join(oddRepo, '.dev', 'odd', 'worktree'))
const oddRemoved = run(oddRepo, ['remove', 'odd'])
check('remove finds that registration too', oddRemoved.status, 0)
check('and reports its branch', (parse(oddRemoved.stdout) || {}).branch_kept, 'odd-iso')

// ---- 9. Outside a git repository nothing is examined at all — a distinct exit code from a refused
// request. Expected is computed from git, so this stays honest on a machine where os.tmpdir() itself
// sits inside a repository.
const nonRepo = tmp('outside')
const nonRepoTop = gitQuiet(nonRepo, ['rev-parse', '--show-toplevel'])
const skip = 'skipped: os.tmpdir() is inside a repository'
const outsideSetup = run(nonRepo, ['setup', 'x', 'HEAD'])
const outsideRemove = run(nonRepo, ['remove', 'x'])
check('outside a git repository every subcommand fails with the environment code',
  nonRepoTop ? skip : [outsideSetup.status, outsideRemove.status],
  nonRepoTop ? skip : [1, 1])
check('and says so in one stderr line',
  nonRepoTop ? skip : outsideSetup.stderr.trim().split('\n').length === 1 && outsideSetup.stderr.startsWith('worktree:'),
  nonRepoTop ? skip : true)

// ---- 10. Argument handling, so a typo is a refusal rather than a surprise.
check('an unknown subcommand is refused', run(repo, ['frobnicate', 'demo']).status, 2)
check('a missing subcommand is refused', run(repo, []).status, 2)
check('a slug that would escape the workspace is refused', run(repo, ['setup', '../evil', baseline]).status, 2)
check('setup without a baseline is refused', run(repo, ['setup', 'nobase']).status, 2)

for (const d of made) fs.rmSync(d, { recursive: true, force: true })

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
