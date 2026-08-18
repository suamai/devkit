// `/dev-setup --check` promises one thing above everything else: it changes nothing. That promise
// lives in prose — the skill has no workflow script behind it — so the only mechanical hold on it is
// the commands the section prescribes. This reads them out of skills/dev-setup/SKILL.md and asserts
// none of them writes.
//
// What it does NOT do: judge the wording. The criterion's own verification (run the mode in a repo
// with no `.claude/` and assert no file was created) needs the promoted plugin and a restart, so it
// is a manual post-promote check; this is the automatable half, and it is a proxy — a section that
// tells the model to write a file in plain English with no command in it would still pass. That is
// why the scan is over EVERY backticked span and fenced block, not over a curated list.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SKILL = 'skills/dev-setup/SKILL.md'
const text = fs.readFileSync(path.join(ROOT, SKILL), 'utf8')
const HEADING = '## Read-only check (--check)'

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

// ---- The anchor. Slicing by heading is the one thing this test cannot do without, so it fails
// closed: a moved or renamed heading stops the run here instead of scanning an empty string and
// reporting a clean bill of health for a section nobody is reading.
function section(src, heading) {
  const at = src.indexOf('\n' + heading + '\n')
  if (at === -1) return null
  const from = at + 1 + heading.length
  const next = src.indexOf('\n## ', from)
  return src.slice(from, next === -1 ? src.length : next)
}
const slice = section(text, HEADING)
check(`${SKILL} still has the ${HEADING} section`, slice !== null, true)
if (slice === null) {
  console.log(`\nthe heading moved or was renamed. Update HEADING here in the same commit — an\n` +
    `unfindable section would otherwise pass every case below by having nothing to scan.`)
  console.log('\n1 FAILED')
  process.exit(1)
}

// Placement is part of the contract: the mode is defined after the mutating Checklist it skips and
// before the Report both modes share.
const order = ['## Checklist', HEADING, '## Report'].map((h) => text.indexOf('\n' + h + '\n'))
check('it sits between the Checklist and the Report',
  order.every((i, n) => i > -1 && (n === 0 || i > order[n - 1])), true)

// The flag has to be advertised where a reader (and the slash-command hint) looks for it.
const hint = text.match(/^argument-hint:\s*(.+)$/m)
check('the frontmatter advertises the flag', !!hint && /--check/.test(hint[1]), true)

// ---- What the section tells the model to run. Fenced blocks first (tracking the opening fence
// LENGTH, since a nested ```json inside a ````markdown block mis-slices otherwise), then every
// inline span in what is left.
function commands(src) {
  const out = []
  const prose = []
  let open = null
  for (const line of src.split('\n')) {
    const fence = line.match(/^\s*(`{3,})\s*(\S*)\s*$/)
    if (open) {
      if (fence && fence[1].length >= open.ticks && !fence[2]) { out.push(open.lines.join('\n')); open = null }
      else open.lines.push(line)
    } else if (fence) open = { ticks: fence[1].length, lines: [] }
    else prose.push(line)
  }
  if (open) out.push(open.lines.join('\n')) // an unclosed fence is still judged, never dropped
  for (const m of prose.join('\n').matchAll(/`([^`\n]+)`/g)) out.push(m[1])
  return out
}

// `<slug>`, `<glob>`, `<version>` are documented placeholders, not redirects. They are stripped
// before the `>` rule looks at anything, or every placeholder in the file would read as a write.
const bare = (s) => s.replace(/<[^<>\s][^<>]*>/g, '')
const WRITE_SHAPES = [
  ['redirect', />>?/],
  ['mkdir', /\bmkdir\b/],
  ['touch', /\btouch\b/],
  ['tee', /\btee\b/],
  ['sed -i', /\bsed\b[^\n]*\s-i\b/],
  ['cp', /\bcp\b/],
  ['mv', /\bmv\b/],
  ['rm', /\brm\b/],
  ['git init', /\bgit\s+init\b/],
  ['git add', /\bgit\s+add\b/],
  ['git commit', /\bgit\s+commit\b/],
  ['git config --global', /\bgit\s+config\b[^\n]*--global/],
]
// Pure over text, so every negative case below is a second call on a COPY — nothing here touches a
// tracked file.
function writes(src) {
  return commands(src).flatMap((c) => WRITE_SHAPES
    .filter(([, re]) => re.test(bare(c)))
    .map(([shape]) => `${shape}: ${c.replace(/\s+/g, ' ').trim()}`))
}

// Fail closed again: a section whose commands stopped being extracted (a formatting change, a
// scanner bug) would satisfy the write check by giving it nothing to look at.
check('it prescribes commands at all', commands(slice).length > 0, true)
check('and none of them writes', writes(slice), [])

// AC-03's list. A tenth item quietly dropped is the failure this counts.
check('ten items, numbered in order',
  [...slice.matchAll(/^(\d+)\. /gm)].map((m) => m[1]),
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])

// ---- And it bites. Each mutation goes into a COPY of the whole file and is re-sliced, so what is
// proved is the pipeline this test actually runs — heading lookup, extraction, detection.
const injectedSpan = (span) => section(text.replace(HEADING + '\n', HEADING + '\n\nFix it with `' + span + '`.\n'), HEADING)
check('an injected git commit goes red', writes(injectedSpan('git commit -m x')).length > 0, true)
check('an injected redirect goes red', writes(injectedSpan('ls "${CLAUDE_PLUGIN_ROOT}/workflows" > out.txt')).length > 0, true)
const injectedBlock = section(text.replace(HEADING + '\n', HEADING + '\n\n```\nmkdir -p .claude/rules\n```\n'), HEADING)
check('and so does one inside a fenced block', writes(injectedBlock).length > 0, true)

// The control pair. The detector is not blind (the mutating Checklist above the section states real
// writes and must be seen), and it is not trigger-happy (a placeholder is not a redirect).
check('the mutating Checklist does state writes', writes(text).length > 0, true)
check('a documented placeholder is not a redirect',
  writes('Read `git ls-files <glob> | head -1`, then `/dev-implement <slug>`.'), [])

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
