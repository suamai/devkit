// The run-ledger line contract, exercised by running the shipped script the skills invoke.
//
// What matters here is not that a line appears but that it appears the way `docs/architecture.md` →
// "The run ledger" promises: exactly one line per call, appended and never rewritten, parseable as
// JSON, with an envelope the model never types — and with a field that cannot be read OMITTED rather
// than guessed. Everything downstream (the calibration report, the cost quote) reads those numbers
// without a second opinion, so a silently wrong envelope is a silently wrong report.
//
// These are behavioural checks, not drift-style text checks: each one drives the real script and
// reads the file back, so a script that stopped working fails them by construction. The refusal
// cases are the negative half — they prove the guard bites instead of merely existing.
//
// Every temp file lives under os.tmpdir(); nothing here writes a tracked file, and $HOME is pointed
// at a throwaway directory so a developer's real ledger is never touched by the suite.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'ledger-append.sh')

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
const tmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `devkit-ledger-${tag}-`)); made.push(d); return d }
const ledgerOf = (home) => path.join(home, '.claude', 'devkit', 'runs.jsonl')
const rawOf = (home) => (fs.existsSync(ledgerOf(home)) ? fs.readFileSync(ledgerOf(home), 'utf8') : null)
const linesOf = (home) => (rawOf(home) || '').split('\n').filter((l) => l !== '')

// One append. Returns the exit status and stderr instead of throwing, because refusal IS a case.
function append(body, { home, cwd = ROOT, script = SCRIPT } = {}) {
  try {
    // stderr is piped, not inherited: a refusal message is a case here, not noise in the suite output.
    execFileSync('sh', [script], { input: body, cwd, env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { status: 0, stderr: '' }
  } catch (e) {
    return { status: e.status === undefined ? -1 : e.status, stderr: String(e.stderr || '') }
  }
}
// git as the source of truth for what the envelope should say — extracted, never restated.
function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch (e) { return null }
}

// ---- 1. Creation and the append-only property.
const home = tmp('append')
const first = append('{"phase":"plan","slug":"run-ledger","tier":"medium","open_questions":2}\n', { home })
check('a well-formed body is accepted', first.status, 0)
check('the ledger is created on first use', fs.existsSync(ledgerOf(home)), true)
check('one call writes exactly one line', linesOf(home).length, 1)

const afterFirst = rawOf(home)
append('{"phase":"implement","slug":"run-ledger","waves":3}\n', { home })
const afterSecond = rawOf(home)
check('a second call adds a second line', linesOf(home).length, 2)
// The append-only proof. A read-modify-write would still leave two lines here; only a byte-identical
// prefix rules out the rewrite that loses a concurrent session's line.
check('and leaves the first line byte-identical', afterSecond.startsWith(afterFirst), true)
check('every line is parseable JSON', linesOf(home).every((l) => { try { JSON.parse(l); return true } catch (e) { return false } }), true)

// ---- 2. The envelope, against the sources it claims to read.
const line1 = JSON.parse(linesOf(home)[0])
check('ts is an ISO-8601 UTC instant', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(line1.ts), true)
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version
check('plugin_version is the shipped version', line1.plugin_version, shipped)
const top = git(ROOT, ['rev-parse', '--show-toplevel'])
check('repo is the basename of the git toplevel', line1.repo, top ? path.basename(top) : undefined)
check('repo_sha is the run cwd HEAD', line1.repo_sha, git(ROOT, ['rev-parse', 'HEAD']) || undefined)

// Outside a repository the two git fields are OMITTED, never invented. Expected is computed from git
// in that same cwd, so this case is honest even on a machine where os.tmpdir() sits inside a repo.
const nonRepo = tmp('cwd')
const outHome = tmp('outside')
append('{"phase":"debug","repro":"yes"}\n', { home: outHome, cwd: nonRepo })
const outside = JSON.parse(linesOf(outHome)[0])
const outsideTop = git(nonRepo, ['rev-parse', '--show-toplevel'])
check('outside a repo, repo is omitted rather than guessed', outside.repo === undefined ? null : outside.repo, outsideTop ? path.basename(outsideTop) : null)
check('and the line is still complete without it', [outside.phase, typeof outside.ts], ['debug', 'string'])

// esc() (ledger-append.sh:59) is what keeps an envelope string value from breaking the JSON it is
// spliced into. `repo` is the one envelope field a developer's own filesystem can put a `"` or `\`
// into, so exercise it there rather than asserting on esc() as an isolated function.
const weirdParent = tmp('weird-parent')
const weirdRepo = path.join(weirdParent, 'weird"repo\\name')
fs.mkdirSync(weirdRepo)
execFileSync('git', ['init', '-q'], { cwd: weirdRepo, stdio: ['ignore', 'ignore', 'ignore'] })
const weirdHome = tmp('weird-home')
const weirdResult = append('{"phase":"debug"}\n', { home: weirdHome, cwd: weirdRepo })
check('a repo name with a quote and a backslash is accepted', weirdResult.status, 0)
const weirdLine = JSON.parse(linesOf(weirdHome)[0])
check('esc() escapes it so the line still parses, repo intact', weirdLine.repo, path.basename(weirdRepo))

// ---- 3. The body reaches the file byte-for-byte.
// A quoted heredoc is what the skills use, so nothing in the body is expanded — the values below are
// exactly the ones that break a naive `echo`: an embedded double quote, an apostrophe, a backslash.
const bodyHome = tmp('body')
const payload = {
  phase: 'review',
  slug: "it's-a-slug",
  stop_reason: 'reviewer said "no" \\ then stopped',
  cost: { by_phase: { steps: 42000 }, total: 42000, budget_total: null, floors_active: false },
  findings: { raw_titles: 9, clusters: 4, confirmed: 3, refuted: 1, applied: 3, skipped: 0 },
  concurrent: false,
}
append(`${JSON.stringify(payload)}\n`, { home: bodyHome })
const round = JSON.parse(linesOf(bodyHome)[0])
for (const k of Object.keys(payload)) check(`body key survives verbatim: ${k}`, round[k], payload[k])

// An empty object is a legitimate body: the envelope alone is still a usable line, and it is the one
// shape a naive brace-splice turns into `{…,}`.
const emptyHome = tmp('empty-object')
check('an empty object body is accepted', append('{}\n', { home: emptyHome }).status, 0)
const envelopeOnly = JSON.parse(linesOf(emptyHome)[0])
check('and yields the envelope alone', Object.keys(envelopeOnly).filter((k) => !['ts', 'plugin_version', 'plugin_commit', 'repo', 'repo_sha'].includes(k)), [])

// Heredocs in a SKILL.md may arrive indented or with a blank line around them; that is still one body.
const wsHome = tmp('whitespace')
check('surrounding blank lines are tolerated', append('\n   {"phase":"spec","slug":"x"}   \n\n', { home: wsHome }).status, 0)
check('and the body still parses', JSON.parse(linesOf(wsHome)[0]).phase, 'spec')

// ---- 4. Refusals. A corrupt line is worse than a missing one, so each of these must write nothing.
for (const [name, body] of [
  ['a two-line body', '{"phase":"plan"}\n{"phase":"review"}\n'],
  ['an empty body', ''],
  ['a body that is not an object', 'phase=plan\n'],
  ['a body missing its closing brace', '{"phase":"plan"\n'],
]) {
  const h = tmp('refuse')
  const r = append(body, { home: h })
  check(`${name} is refused`, r.status, 2)
  check(`${name} writes nothing`, fs.existsSync(ledgerOf(h)), false)
  check(`${name} explains itself in one stderr line`, r.stderr.trim().split('\n').length === 1 && r.stderr.startsWith('ledger-append:'), true)
}

// An environment that cannot hold the file is a different failure from a refused body, and the
// skills are told to distinguish them: exit 1, one line, and nothing pretends to have been written.
// ($HOME pointed at a regular file, so mkdir -p fails without any chance of touching a real home.)
const notADir = path.join(tmp('unwritable'), 'home-is-a-file')
fs.writeFileSync(notADir, 'not a directory\n')
const broken = append('{"phase":"plan"}\n', { home: notADir })
check('an unusable $HOME fails with the environment code', broken.status, 1)
check('and says so in one line', broken.stderr.trim().split('\n').length === 1 && broken.stderr.startsWith('ledger-append:'), true)

// A genuinely UNSET $HOME is the guard at ledger-append.sh:86, not the mkdir -p failure above —
// the two live on different lines and only one of them was ever driven.
function appendNoHome(body, { cwd = ROOT, script = SCRIPT } = {}) {
  const env = { ...process.env }
  delete env.HOME
  try {
    execFileSync('sh', [script], { input: body, cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { status: 0, stderr: '' }
  } catch (e) {
    return { status: e.status === undefined ? -1 : e.status, stderr: String(e.stderr || '') }
  }
}
const noHome = appendNoHome('{"phase":"plan"}\n')
check('an unset $HOME fails with the environment code', noHome.status, 1)
check('and says $HOME specifically', noHome.stderr.trim(), 'ledger-append: $HOME is not set — nothing written')

// ---- 5. plugin_version and plugin_commit are read from the install the script sits in — not from
// the cwd and not from a constant. Driven through a throwaway plugin root so both the present and
// the absent case are deterministic; a working tree has no FROZEN_AT, a promoted install does.
function fakeRoot(tag, frozen) {
  const dir = tmp(tag)
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.mkdirSync(path.join(dir, '.claude-plugin'))
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'ledger-append.sh'))
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{\n  "name": "devkit",\n  "version": "9.9.9-fixture"\n}\n')
  if (frozen) fs.writeFileSync(path.join(dir, 'FROZEN_AT'), `${frozen}\n`)
  const h = tmp(`${tag}-home`)
  append('{"phase":"pr"}\n', { home: h, script: path.join(dir, 'scripts', 'ledger-append.sh') })
  return { dir, line: JSON.parse(linesOf(h)[0]) }
}
const sha = '0123456789abcdef0123456789abcdef01234567'
const withFrozen = fakeRoot('frozen', sha)
const noFrozen = fakeRoot('unfrozen', null)
const fixtureVersion = JSON.parse(fs.readFileSync(path.join(withFrozen.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version
check('plugin_version comes from the root the script sits in', withFrozen.line.plugin_version, fixtureVersion)
check('plugin_commit is FROZEN_AT beside it', withFrozen.line.plugin_commit, fs.readFileSync(path.join(withFrozen.dir, 'FROZEN_AT'), 'utf8').trim())
check('and is omitted when there is no FROZEN_AT', 'plugin_commit' in noFrozen.line, false)

// ---- 6. Prose coverage: the skills are what actually write the ledger, so a skill that stops
// naming the script is a phase that silently stops being measured — and every downstream number is
// then a sample short with nothing to show for it. That failure has no runtime symptom, which is
// exactly why it belongs in the suite.
//
// What this CANNOT prove: that an agent runs the command it was told to run. Nothing here executes a
// SKILL.md — those are prompts, and only the first real run after `scripts/promote-plugin.sh` tests
// obedience. The checkable half is that the instruction exists at all, in the shape
// `docs/architecture.md` → "The run ledger" documents; the rest is not automatable from here.
//
// Every check below is a pure function over text, so its negative case is a second call on an
// in-memory copy with the token renamed away — never a rewrite of something the repo owns.
const SKILL_DIR = path.join(ROOT, 'skills')
const skillsOnDisk = fs.readdirSync(SKILL_DIR).sort()
const skillFile = (name) => ({ name, text: fs.readFileSync(path.join(SKILL_DIR, name, 'SKILL.md'), 'utf8') })
const allSkills = skillsOnDisk.map(skillFile)
const renameTo = (token, into) => ({ name, text }) => ({ name, text: text.split(token).join(into) })

// The documented carrier is a call, not a mention: `sh "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.sh"`.
const invokes = (text, script) =>
  new RegExp('sh\\s+"\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/' + script.replace(/\./g, '\\.') + '"').test(text)

// Which skills owe a line is not a list worth maintaining twice: `phase` is an enum in the line
// contract, and each member has a skill of the same name. Extracted from the doc that owns it.
const contract = fs.readFileSync(path.join(ROOT, 'docs', 'architecture.md'), 'utf8')
const phases = (contract.match(/`phase` \(`([a-z|]+)`\)/) || [])[1]
check('the line contract still names its phases', !!phases, true)
const phaseSkills = phases.split('|').map((p) => `dev-${p}`).sort()
check('every phase in the contract has a skill', phaseSkills.filter((n) => !skillsOnDisk.includes(n)), [])
// The other half of the same fence, so a phase quietly dropped from the doc cannot narrow this test
// without failing it. `/dev-setup` and `/dev-status` are the two documented non-phases — they write
// nothing — and a NEW skill lands here as a failure that forces the same decision to be made again.
check('and every other skill is one of the two documented non-phases',
  skillsOnDisk.filter((n) => !phaseSkills.includes(n)), ['dev-setup', 'dev-status'])

const phaseFiles = phaseSkills.map(skillFile)
const missingAppend = (skills) => skills.filter(({ text }) => !invokes(text, 'ledger-append.sh')).map(({ name }) => name)
check('every phase skill invokes the append script', missingAppend(phaseFiles), [])
check('and it fails when the invocation is renamed away',
  missingAppend(phaseFiles.map(renameTo('ledger-append.sh', 'renamed-away.sh'))), phaseSkills)

// `/dev-status` is the ledger's reader, and the two commands it gained are the only way a human ever
// sees any of this — an undocumented one is a feature nobody can invoke.
const statusText = skillFile('dev-status').text
function statusGaps(text) {
  const gaps = []
  if (!invokes(text, 'ledger-report.sh')) gaps.push('no ledger-report.sh invocation')
  for (const token of ['--calibration', 'archive <slug>']) if (!text.includes(token)) gaps.push(`${token} undocumented`)
  return gaps
}
check('dev-status invokes the reader and documents both commands', statusGaps(statusText), [])
check('and it fails when any of the three drifts',
  ['ledger-report.sh', '--calibration', 'archive <slug>']
    .filter((t) => statusGaps(statusText.split(t).join('renamed-away')).length === 0), [])

// A script path a skill names but the tree does not ship is a command that fails at the one moment
// it is needed. Fail closed: with no script named anywhere, the emptiness below would mean nothing.
const namedScripts = (text) => [...new Set([...text.matchAll(/scripts\/([\w.-]+\.sh)/g)].map((m) => m[1]))]
const dangling = (skills) => skills.flatMap(({ name, text }) => namedScripts(text)
  .filter((s) => !fs.existsSync(path.join(ROOT, 'scripts', s)))
  .map((s) => `${name}: scripts/${s}`))
check('the skills name scripts at all', [...new Set(allSkills.flatMap(({ text }) => namedScripts(text)))].length > 0, true)
check('every scripts/*.sh a skill names exists on disk', dangling(allSkills), [])
check('and it fails when one is renamed away',
  dangling(allSkills.map(renameTo('ledger-append.sh', 'renamed-away.sh'))).length > 0, true)

// AC-08's three interrupts: the moments a run stops on a person rather than on itself. Which three
// they are is the plan's judgement, but the tool name is an address — `PushNotification` is what the
// harness resolves, and a paraphrase there is an instruction that silently does nothing.
const NOTIFIERS = ['dev-plan', 'dev-implement', 'dev-pr']
const notifierFiles = NOTIFIERS.map(skillFile)
const missingPing = (skills) => skills.filter(({ text }) => !/\bPushNotification\b/.test(text)).map(({ name }) => name)
check('the three interrupt skills name PushNotification', missingPing(notifierFiles), [])
check('and it fails when the tool name drifts',
  missingPing(notifierFiles.map(renameTo('PushNotification', 'SomeOtherTool'))), NOTIFIERS)

for (const d of made) fs.rmSync(d, { recursive: true, force: true })

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
