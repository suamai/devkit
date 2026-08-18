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
// `default 5` and `defaults to 5` are the same claim, so both are the pinned restatement. Requiring
// exactly `default ` is how a reworded sentence stops being compared without anything going red.
// A pure function over text: the fail-closed guard and the mutation proof below are second calls.
//
// The gap stops at a COMMA as well as at `.` and `;`, because these knobs are documented in lists —
// `` `checkpointFileThreshold` (default 20), `checkpointMaxWaves` (default 3) `` — and 80 characters
// is far enough to reach the NEXT knob's default. Today the lazy quantifier hides that: the nearer
// match wins. Drop one knob's value and the anchor silently adopts its neighbour's, which is how a
// stale default would be reported as documented-and-correct. The mutation proof below is what
// surfaced it.
const documentedDefaults = (prose, name) => prose.flatMap(({ p, text }) =>
  [...text.matchAll(new RegExp(NAMED(name) + '[^.;,\\n]{0,80}?(?<!non-)defaults?\\s+(?:to\\s+)?`?(\\w+)`?', 'g'))]
    .map((m) => ({ p, documented: m[1] })))

const mismatches = []
for (const [name, value] of Object.entries(DEFAULTS)) {
  for (const { p, documented } of documentedDefaults(PROSE, name)) {
    if (documented !== value) mismatches.push(`${p}: ${name} documented as ${documented}, script says ${value}`)
  }
}
check('every documented default matches its script', mismatches, [])

// Fail closed, the same way the option-set guard below does. The check above compares only what it
// can find, so prose that drifts OUT of the tracked shape produces zero comparisons — and zero
// comparisons read as agreement. Silence is the failure this catches: a documented default that no
// longer states its value in a machine-readable form is exactly as stale as a wrong one, and until
// this case existed a reword made a knob stop being guarded without anything saying so.
check('and every default is stated somewhere in that shape',
  Object.keys(DEFAULTS).filter((name) => documentedDefaults(PROSE, name).length === 0), [])

// Mutation proof, in memory: reword each default out of the tracked shape while leaving the name
// anchored, and the guard above must find nothing left to compare for any of them.
const rewordedAway = (text, name) =>
  text.replace(new RegExp('(' + NAMED(name) + '[^.;,\\n]{0,80}?)(?<!non-)defaults?\\s+(?:to\\s+)?', 'g'), '$1around ')
check('and it goes red when one is reworded out of it',
  Object.keys(DEFAULTS).filter((name) =>
    documentedDefaults(PROSE.map(({ p, text }) => ({ p, text: rewordedAway(text, name) })), name).length > 0), [])

// The skill that tells Claude to pass these options must actually document them; silence there is
// how a knob becomes folklore.
const implSkill = read('skills/dev-implement/SKILL.md')
const undocumented = ['maxParallelSteps', 'checkpointFileThreshold', 'checkpointMaxWaves', 'reviewRounds', 'scoutMode']
  .filter((n) => !new RegExp(NAMED(n)).test(implSkill))
check('dev-implement documents its own knobs', undocumented, [])

// Same for the review loop's knobs, and for the one return field the skill has to act on:
// `fix_verify` is what decides whether a `clean: false` means "a finding survived" or "the tree
// stopped working", and a report that never mentions it turns that distinction into folklore.
const reviewSkill = read('skills/dev-review/SKILL.md')
const undocumentedReview = ['verifyCommand', 'ruleLens', 'seedFindings', 'maxRounds', 'fix_verify']
  .filter((n) => !new RegExp(NAMED(n)).test(reviewSkill))
check('dev-review documents its own knobs', undocumentedReview, [])

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

// `covers` is the join the whole evidence chain hangs on — the planner writes it onto a step, the
// implement run reads it back to build the acceptance matrix — so a schema that declares it on one
// side only means the field is asked for and then silently dropped, or read and never populated.
const STEP_SCHEMA_FILES = ['workflows/wf-implement.js', 'workflows/wf-explore-plan.js']
const declaresCovers = (text) => /covers: \{ type: 'array'/.test(text)
check('both step schemas declare covers', STEP_SCHEMA_FILES.filter((f) => !declaresCovers(read(f))), [])
// And it bites — pure over text, so the negative case is a second call on a COPY rather than an edit
// to a file the repo owns.
check('and it fails when a schema drops it',
  STEP_SCHEMA_FILES.filter((f) => !declaresCovers(read(f).replace(/covers: \{ type: 'array'/g, "covered: { type: 'array'"))),
  STEP_SCHEMA_FILES)

// `delivery_verdict` is COMPUTED, not declared in a schema, so `enumOf` cannot see it — the script
// states its vocabulary as one literal for exactly this reason. Fail loudly if that declaration was
// moved or renamed: an empty set would compare against nothing and pass.
function deliveryVerdicts() {
  const m = read('workflows/wf-implement.js').match(/const DELIVERY_VERDICTS = \[([^\]]+)\]/)
  if (!m) throw new Error('workflows/wf-implement.js: could not extract DELIVERY_VERDICTS — has the declaration moved or been renamed?')
  return m[1].split(',').map((v) => v.trim().replace(/'/g, ''))
}

// Prose spells them as `risk: "contract" | "local"`. Compare the sets, not the formatting — and
// judge EVERY such statement in a file, not just the first one, since a document restates a set
// wherever it explains it. A statement naming a single member (`delivery_verdict: 'blocked'` in an
// instruction, `kind: existing-suite` in an aside) is not a claim about the vocabulary at all: the
// alternatives list is what makes a sentence a restatement, so the `|` is what admits it here.
function proseSets(text, name) {
  return [...text.matchAll(new RegExp('`' + name + ': ([^`]+)`', 'g'))]
    .map((m) => m[1]).filter((v) => v.includes('|'))
    .map((v) => v.split('|').map((x) => x.trim().replace(/"/g, '')))
}
function proseSet(text, name) {
  return proseSets(text, name)[0] || null
}
// The sets a document is allowed to restate, and where the truth lives. `status` and `kind` type a
// step's `verify_run`: the status the script DERIVES from ran/command/passed, and the kind of check
// the implementer declares — the field that decides whether a pass is weak evidence. Both are
// restated in the skill and in the docs, which is exactly where a renamed member rots unnoticed.
const OPTION_SETS = [
  ['risk', enumOf('workflows/wf-implement.js', 'risk')],
  ['status', enumOf('workflows/wf-implement.js', 'status')],
  ['kind', enumOf('workflows/wf-implement.js', 'kind')],
  // The run's own verdict on itself: /dev-implement leads its report with it and /dev-pr gates
  // publication on it, so a member renamed in the script while the prose still lists the old word is
  // a gate that quietly stops matching. The five per-gate vocabularies under it (acceptance, tests,
  // review, questions, scope) are deliberately NOT tracked — nothing branches on a gate label, and
  // five more pinned statements would be five more things to maintain exactly forever, which is the
  // decision docs/architecture.md records.
  ['delivery_verdict', deliveryVerdicts()],
]
// Pure over text, so the mutation proof below is just a second call on a COPY rather than a rewrite
// of something the repo owns.
function proseSetDrift(files, name, expected) {
  return files.flatMap(({ p, text }) => proseSets(text, name)
    .filter((stated) => JSON.stringify(stated) !== JSON.stringify(expected))
    .map((stated) => `${p}: ${name} documented as ${stated.join('|')}, schema says ${expected.join('|')}`))
}
check('prose option sets match the schema',
  OPTION_SETS.flatMap(([name, expected]) => proseSetDrift(PROSE, name, expected)), [])
// Fail closed, the same shape as "a caller passing custom lenses exists" below: a set that no
// document states passes the check above by giving it nothing to compare, and an enum whose prose
// was deleted is precisely the drift this is here to catch.
check('and every option set is stated in some document',
  OPTION_SETS.filter(([name]) => !PROSE.some(({ text }) => proseSets(text, name).length)).map(([name]) => name), [])
// And it bites: rename one member and every set must come back as drift. The rename happens on an
// in-memory copy — a check that rewrites a tracked file and restores it afterwards corrupts the tree
// if it dies in between, which is worse than the drift it guards.
const renamedMember = (text, member) => text.split(member).join('renamed-away')
check('and it fails when a member drifts',
  OPTION_SETS.filter(([name, expected]) =>
    proseSetDrift(PROSE.map(({ p, text }) => ({ p, text: renamedMember(text, expected[expected.length - 1]) })),
      name, expected).length === 0).map(([name]) => name), [])

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

// ---- 6. The args a caller has to pass. Here the prose is not a restatement of behavior but the
// invocation itself: `/dev-pr --review` hands the loop two custom `lenses` at the last gate before
// publication, and that silently dropped the repo-conventions reviewer for as long as the lens was
// part of the default array. It is appended now — but it can still only appear if the caller passes
// what rule matching needs: `rules` (the unmatched manifest) and `files` (the concrete paths). A block
// that passes custom lenses and neither of those gets two reviewers and no warning, which is exactly
// the drift that was there before.
function fencedBlocks(text) {
  // Track the opening fence LENGTH: skills/dev-pr/SKILL.md nests a ```json block inside a
  // ````markdown one, and a three-backtick scanner mis-slices that pair into nonsense.
  const blocks = []
  let open = null
  for (const line of text.split('\n')) {
    const fence = line.match(/^\s*(`{3,})\s*(\S*)\s*$/)
    if (open) {
      if (fence && fence[1].length >= open.ticks && !fence[2]) { blocks.push(open.lines.join('\n')); open = null }
      else open.lines.push(line)
    } else if (fence) open = { ticks: fence[1].length, lines: [] }
  }
  if (open) blocks.push(open.lines.join('\n')) // an unclosed fence still gets judged, never dropped
  return blocks
}
// Matches the `scriptPath` fallback too, not just the workflow name. Both skills document that
// fallback for a session where the plugin has not loaded, so a block written that way would otherwise
// pass custom `lenses` with no `rules`/`files` and never be looked at — the exact drift this stops.
const passesLenses = (b) => /devkit:wf-review-loop|wf-review-loop\.js/.test(b) && /\blenses\s*:/.test(b)
// Pure over text, so the negative case below can mutate a COPY instead of a tracked file.
function lensBlocksMissingRulesOrFiles(text) {
  return fencedBlocks(text).filter(passesLenses)
    .filter((b) => !/\brules\b/.test(b) || !/\bfiles\b/.test(b))
}
const lensCallers = PROSE.filter(({ text }) => fencedBlocks(text).some(passesLenses))
// Fail closed: with no such block anywhere, the check below passes by having nothing to look at.
check('a caller passing custom lenses exists', lensCallers.length > 0, true)
check('every custom-lens caller also passes rules and files',
  PROSE.flatMap(({ p, text }) => lensBlocksMissingRulesOrFiles(text).map(() => `${p}: custom lenses without rules/files`)), [])
// And it bites: the same text with those two names renamed away must come back as a violation. The
// mutation is in memory on purpose — a check that rewrites a tracked file and restores it afterwards
// corrupts the repo if it dies in between, which is worse than the drift it was guarding.
const renamedAway = (t) => t.replace(/\brules\b/g, 'scope').replace(/\bfiles\b/g, 'scope')
check('and it fails when they are missing',
  lensCallers.length > 0 && lensCallers.every(({ text }) => lensBlocksMissingRulesOrFiles(renamedAway(text)).length > 0), true)

// ---- 7. The version, which three places state and nothing reconciled. `plugin.json` is what
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

// The criteria-extraction command is stated in TWO skills, because /dev-plan and /dev-implement are
// each their own entry point and neither may assume the other ran. A workflow script has no
// filesystem access, so the id list must arrive pre-extracted either way — but two copies that drift
// give two entry points extracting different lists from the same spec, and the same plan then lints
// differently depending on which skill you invoked. Nothing about that failure is visible: both
// commands still run, and both still print ids.
//
// A pure function over text, so the negative case below is just a second call with a mutated string.
// Fail closed: a command that cannot be found anywhere is a zero-length match set, which must read
// as drift rather than as agreement between two absences.
const CRITERIA_GREP = /grep -oE '\^\[\[:space:\]\]\*\[-\*\]\[\[:space:\]\]\*\(\\\*\\\*\)\?AC-\[0-9\]\+'[^\n]*/g
const criteriaGreps = (texts) => texts.map((t) => (t.match(CRITERIA_GREP) || [])[0] || null)
const criteriaAgree = (texts) => {
  const found = criteriaGreps(texts)
  return found.every(Boolean) && new Set(found).size === 1
}
const CRITERIA_SKILLS = ['skills/dev-plan/SKILL.md', 'skills/dev-implement/SKILL.md']
const criteriaTexts = CRITERIA_SKILLS.map(read)
check('both skills state the criteria-extraction command', criteriaGreps(criteriaTexts).filter(Boolean).length, CRITERIA_SKILLS.length)
check('and the two copies are byte-identical', criteriaAgree(criteriaTexts), true)
// Mutation proof, in memory: one copy loses the `**` alternation (a real drift — it would stop
// matching bolded criteria) and the pair must go red.
check('and it goes red when one copy drifts',
  criteriaAgree([criteriaTexts[0], criteriaTexts[1].replace('(\\*\\*)?', '')]), false)
// And red when a copy disappears entirely, rather than two absences reading as agreement.
check('and red when a copy is gone', criteriaAgree([criteriaTexts[0], 'no command here']), false)

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
