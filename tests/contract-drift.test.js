// Prose drift: the workflow scripts are the source of truth for defaults, option sets and severity
// levels, and the skills and docs restate them for a human. When a script changes and its prose does
// not, the prose becomes a confident lie — the failure mode no reviewer catches, because nobody
// diffs a SKILL.md against a schema.
//
// What this checks is deliberately narrow: CONCRETE VALUES, extracted from the script and compared
// against every place that states them. It does not check wording, and it does not grep for
// canonical sentences — a test that passes because a file still contains the word "disjoint" while
// the sentence around it now says the opposite is a test that trains people to ignore the suite.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8') } catch (e) {
    // A bare ENOENT stack is a bad way to learn that a file was renamed without its callers.
    throw new Error(`${p} is missing — if a workflow or skill was renamed, update what invokes it (and this test)`)
  }
}
const PROSE = ['README.md', 'docs/manual.md', 'docs/architecture.md',
  ...fs.readdirSync(path.join(ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`)]
  .map((p) => ({ p, text: read(p) }))

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

// ---- 1. Names that are addresses. A workflow renamed without its callers is a run that never
// starts; the skills invoke these by string. This runs FIRST because everything below reads those
// files by name, and "wf-review-loop.js is missing" is a better failure than a stack trace.
const shipped = fs.readdirSync(path.join(ROOT, 'workflows')).map((f) => f.replace(/\.js$/, '')).sort()
const invoked = [...new Set(PROSE.flatMap(({ text }) => [...text.matchAll(/devkit:(wf-[\w-]+)/g)].map((m) => m[1])))].sort()
check('every workflow the skills invoke exists', invoked.filter((n) => !shipped.includes(n)), [])
check('and every shipped workflow is reachable', shipped.filter((n) => !invoked.includes(n)), [])

// Same for skills. A `/dev-foo` in the docs that does not exist is a command the reader will type
// and watch fail; a skill nothing points at is one nobody will find.
const skills = fs.readdirSync(path.join(ROOT, 'skills')).sort()
const named = [...new Set(PROSE.flatMap(({ text }) => [...text.matchAll(/\/(dev-[a-z]+)\b/g)].map((m) => m[1])))].sort()
check('every /dev-* the docs name exists', named.filter((n) => !skills.includes(n)), [])
check('and every skill is named somewhere', skills.filter((n) => !named.includes(n)), [])

// A skill's frontmatter name is its address; a directory renamed without it silently stops resolving.
const misnamed = skills.filter((d) => {
  const m = read(`skills/${d}/SKILL.md`).match(/^name:\s*(\S+)/m)
  return !m || m[1] !== d
})
check('frontmatter name matches its directory', misnamed, [])

// ---- 2. Defaults. The script owns the number; prose that names one must name the same number.
// Extracted from the source, never restated here — a constant copied into the test drifts too.
function defaultOf(file, expr) {
  const m = read(file).match(expr)
  if (!m) throw new Error(`${file}: could not extract a default with ${expr} — has the line changed?`)
  return m[1]
}
const DEFAULTS = {
  maxParallelSteps: defaultOf('workflows/wf-implement.js', /args\.maxParallelSteps \|\| (\d+)/),
  checkpointFileThreshold: defaultOf('workflows/wf-implement.js', /args\.checkpointFileThreshold \|\| (\d+)/),
  checkpointMaxWaves: defaultOf('workflows/wf-implement.js', /args\.checkpointMaxWaves \|\| (\d+)/),
  reviewRounds: defaultOf('workflows/wf-implement.js', /maxRounds: args\.reviewRounds \?\? (\d+)/),
  maxRounds: defaultOf('workflows/wf-review-loop.js', /const maxRounds = args\.maxRounds \|\| (\d+)/),
  scoutMode: defaultOf('workflows/wf-implement.js', /const scoutMode = args\.scoutMode \|\| '(\w+)'/),
}

// Prose spells the name three ways — `maxParallelSteps` (default 5), `reviewRounds: N` (default 3 —
// …), `scoutMode: "always" | …` (default adaptive: …) — so the anchor is the name followed by a
// backtick or a colon. `non-default` is English, not a claim about a value; excluding it is the
// difference between a useful test and one that cries wolf until it gets deleted.
const NAMED = (name) => '`' + name + '[`:]'
const mismatches = []
for (const [name, value] of Object.entries(DEFAULTS)) {
  for (const { p, text } of PROSE) {
    const re = new RegExp(NAMED(name) + '[^.;\\n]{0,80}?(?<!non-)default\\s+`?(\\w+)`?', 'g')
    for (const m of text.matchAll(re)) {
      if (m[1] !== value) mismatches.push(`${p}: ${name} documented as ${m[1]}, script says ${value}`)
    }
  }
}
check('every documented default matches its script', mismatches, [])

// The skill that tells Claude to pass these options must actually document them; silence there is
// how a knob becomes folklore.
const implSkill = read('skills/dev-implement/SKILL.md')
const undocumented = ['maxParallelSteps', 'checkpointFileThreshold', 'checkpointMaxWaves', 'reviewRounds', 'scoutMode']
  .filter((n) => !new RegExp(NAMED(n)).test(implSkill))
check('dev-implement documents its own knobs', undocumented, [])

// ---- 3. Option sets. An enum that gains or loses a member while the prose still lists the old set
// is the same lie in a different shape.
function enumOf(file, key) {
  const m = read(file).match(new RegExp(key + ": \\{ type: 'string', enum: \\[([^\\]]+)\\]"))
  if (!m) throw new Error(`${file}: no enum found for ${key}`)
  return m[1].split(',').map((v) => v.trim().replace(/'/g, ''))
}
// The same field is declared in two schemas — those must agree with each other before anything else.
check('risk enum agrees across schemas',
  enumOf('workflows/wf-explore-plan.js', 'risk'), enumOf('workflows/wf-implement.js', 'risk'))
check('context_confidence enum agrees across schemas',
  enumOf('workflows/wf-explore-plan.js', 'context_confidence'), enumOf('workflows/wf-implement.js', 'context_confidence'))

// Prose spells them as `risk: "contract" | "local"`. Compare the sets, not the formatting.
function proseSet(text, name) {
  const m = text.match(new RegExp('`' + name + ': ([^`]+)`'))
  return m ? m[1].split('|').map((v) => v.trim().replace(/"/g, '')) : null
}
const proseDrift = []
for (const [name, expected] of [['risk', enumOf('workflows/wf-implement.js', 'risk')]]) {
  for (const { p, text } of PROSE) {
    const stated = proseSet(text, name)
    if (stated && JSON.stringify(stated) !== JSON.stringify(expected)) {
      proseDrift.push(`${p}: ${name} documented as ${stated.join('|')}, schema says ${expected.join('|')}`)
    }
  }
}
check('prose option sets match the schema', proseDrift, [])

// scoutMode has no schema — the script branches on the strings, so those branches ARE the enum.
const scoutModes = [...read('workflows/wf-implement.js').matchAll(/scoutMode === '(\w+)'/g)].map((m) => m[1]).sort()
const scoutProse = proseSet(implSkill, 'scoutMode')
check('scoutMode prose lists the modes the script branches on',
  scoutProse && scoutProse.filter((m) => m !== DEFAULTS.scoutMode).sort(), scoutModes)

// ---- 4. Severity levels. Four schemas declare them; the gate/report prose acts on the top two, so
// a renamed level silently disables a publication block.
const severities = ['workflows/wf-implement.js', 'workflows/wf-review-loop.js']
  .map((f) => [...read(f).matchAll(/severity: \{ type: 'string', enum: \[([^\]]+)\]/g)].map((m) => m[1].replace(/[' ]/g, '')))
  .flat()
check('every severity enum is identical', [...new Set(severities)].length, 1)
check('and the blocking pair still exists', severities[0].split(',').filter((s) => s === 'high' || s === 'critical'), ['high', 'critical'])

// ---- 5. The one soft guide that is a number: step size. Stated in the synthesizer prompt and in
// the architecture diagram, nowhere else, and they have to agree or the diagram teaches the wrong
// shape to whoever is changing the prompt.
const promptGuide = read('workflows/wf-explore-plan.js').match(/roughly (\d+) files/)
const diagramGuide = read('docs/architecture.md').match(/~(\d+) files as a soft guide/)
check('step-size guide agrees', promptGuide && promptGuide[1], diagramGuide && diagramGuide[1])

// ---- 6. The version, which three places state and nothing reconciled. `plugin.json` is what
// Claude Code loads; `marketplace.json` states it twice more (once as catalogue metadata, once on
// the plugin entry) and a marketplace consumer reads THOSE. Under a plugin a repo cannot pin a
// version, so a marketplace advertising 0.2.0 while the plugin ships 0.3.0 is not cosmetic — the
// changelog is the entire compatibility story and this is what keeps it addressable.
const plugin = JSON.parse(read('.claude-plugin/plugin.json'))
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'))
const entry = marketplace.plugins.find((p) => p.name === plugin.name)
check('marketplace lists the plugin it ships', !!entry, true)
check('every manifest states one version',
  [...new Set([plugin.version, marketplace.metadata.version, entry && entry.version])], [plugin.version])

// A bump with no changelog entry is a version that moved without saying what changed — the exact
// failure the changelog exists to prevent, and the cheapest one to catch. Heading form is
// `## 0.2.0 — YYYY-MM-DD`; only the number is load-bearing here.
const released = [...read('CHANGELOG.md').matchAll(/^## \[?(\d+\.\d+\.\d+)\]?/gm)].map((m) => m[1])
check('the shipped version has a changelog entry', released.includes(plugin.version), true)
check('and it is the most recent one', released[0], plugin.version)

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
