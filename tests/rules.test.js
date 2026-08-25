// The `.claude/rules/` contract: what scripts/rules-manifest.sh extracts from frontmatter, how the
// workflows match those globs against files, and that the two copies of the matcher have not
// drifted. Runs the shipped script and the shipped functions.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const wf = (name) => fs.readFileSync(path.join(ROOT, 'workflows', name), 'utf8')

const FENCE_OPEN = '// >>> shared: repo-rule matching'
const FENCE_CLOSE = '// <<< shared: repo-rule matching'
function fenced(src, file) {
  const a = src.indexOf(FENCE_OPEN)
  const b = src.indexOf(FENCE_CLOSE)
  if (a === -1 || b === -1) throw new Error(`${file}: shared-block markers missing — did someone delete the fence?`)
  return src.slice(src.indexOf('\n', a) + 1, b)
}
function primitives(src, file) {
  const a = src.indexOf('const GLOB_TOKENS =')
  const b = src.indexOf('\n}\n', src.indexOf('function pathScope('))
  if (a === -1 || b === -1) throw new Error(`${file}: GLOB_TOKENS/pathScope not found`)
  return src.slice(a, b + 3)
}

const IMPL = wf('wf-implement.js')
const REVIEW = wf('wf-review-loop.js')

// `rulesNote` renders the matched rules into a prompt; it sits OUTSIDE the fence because it is not
// part of the matcher, so nothing above compares it. Brace-matched from each file and fail-closed if
// the name moves — the shape tests/fix-verify.test.js uses.
function rulesNoteOf(src, file) {
  const at = src.indexOf('function rulesNote(')
  if (at === -1) throw new Error(`${file}: function rulesNote( not found — has it been renamed?`)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`${file}: unbalanced braces after function rulesNote(`)
}

let failed = 0
let cases = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  cases++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

// ---- 1. The frontmatter contract, as the shipped shell script reads it.
// `paths:` is a NATIVE Claude Code key, so these cases are conformance, not preference.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-rules-'))
const rules = path.join(dir, '.claude', 'rules')
fs.mkdirSync(rules, { recursive: true })
const write = (name, body) => fs.writeFileSync(path.join(rules, name), body)

write('db.md', `---
description: DB conventions
paths:
  - "products/**/db/**/*.ts"
  - packages/*/schema/*.ts   # trailing comment
tags:
  - db
  - critical
---
Body text with - a dash list item that is not frontmatter.
`)
write('style.md', `---
description: always-on house style
---
No paths key.
`)
write('inline.md', `---
paths: ["src/**/*.rs", 'tests/*.rs']
description: a key after paths
---
`)
write('bare.md', 'no frontmatter at all\n')

const manifest = JSON.parse(execFileSync('sh', [path.join(ROOT, 'scripts', 'rules-manifest.sh'), rules], { encoding: 'utf8' }))
const byName = Object.fromEntries(manifest.map((r) => [path.basename(r.path), r.globs]))

// The old awk scraped every `-` item in the frontmatter regardless of key, so `tags:` leaked in as
// globs. That is the bug this contract exists to close.
check('paths: block list only', byName['db.md'], ['products/**/db/**/*.ts', 'packages/*/schema/*.ts'])
check('paths: inline array, either quote', byName['inline.md'], ['src/**/*.rs', 'tests/*.rs'])
check('no paths key → unscoped, not absent', byName['style.md'], [])
check('no frontmatter → unscoped', byName['bare.md'], [])
check('every rule file is listed', manifest.length, 4)
check('missing dir is not an error', execFileSync('sh', [path.join(ROOT, 'scripts', 'rules-manifest.sh'), path.join(dir, 'nope')], { encoding: 'utf8' }).trim(), '[]')
fs.rmSync(dir, { recursive: true, force: true })

// ---- 2. Matching, run from the shipped source.
// `ruleDefs` is the caller-supplied set the matcher closes over; take its definition from the
// source too rather than restating it here.
const RULE_DEFS = IMPL.split('\n').find((l) => l.startsWith('const ruleDefs ='))
if (!RULE_DEFS) throw new Error('wf-implement.js: const ruleDefs line not found')
const scope = new Function('args', `${RULE_DEFS}\n${primitives(IMPL, 'wf-implement.js')}\n${fenced(IMPL, 'wf-implement.js')}\nreturn { rulesFor, globToRegExp, normalizePath }`)
const build = (defs) => scope({ rules: defs }).rulesFor

const DEFS = [
  { path: '.claude/rules/db.md', globs: ['src/db/**/*.ts'] },
  { path: '.claude/rules/wide.md', globs: ['**/*.ts'] },
  { path: '.claude/rules/style.md', globs: [] },
]
// `ruleDefs` closes over `args`, so each build gets its own set.
const rulesFor = build(DEFS)

check('scoped rule matches its area', rulesFor(['src/db/user.ts']), ['.claude/rules/db.md', '.claude/rules/wide.md', '.claude/rules/style.md'])
check('scoped rule stays out otherwise', rulesFor(['src/api/http.ts']), ['.claude/rules/wide.md', '.claude/rules/style.md'])
// Specificity ordering is what makes the review loop's slice(0, 4) keep the useful rules: a rule
// scoped to src/db says more about the code than one covering **/*.ts.
check('most specific first', rulesFor(['src/db/user.ts'])[0], '.claude/rules/db.md')

// An unscoped rule is loaded natively for EVERY file, so a subagent must see it for every file —
// including files no scoped rule matches, and steps that declare no files at all.
check('unscoped rule reaches unrelated files', rulesFor(['README.md']), ['.claude/rules/style.md'])
check('unscoped rule reaches a step with no files', rulesFor([]), ['.claude/rules/style.md'])
check('no rules configured → nothing', build([])(['src/db/user.ts']), [])

const globToRegExp = scope({}).globToRegExp
const m = (glob, file) => globToRegExp(glob).test(file)
check('** crosses directories', [m('src/**/*.ts', 'src/a/b/c.ts'), m('src/**/*.ts', 'src/c.ts')], [true, true])
check('* stays inside one segment', [m('src/*.ts', 'src/c.ts'), m('src/*.ts', 'src/a/c.ts')], [true, false])
check('{a,b} alternation', [m('src/*.{ts,tsx}', 'src/c.tsx'), m('src/*.{ts,tsx}', 'src/c.js')], [true, false])
check('a dot is literal, not any-char', [m('src/a.ts', 'src/a.ts'), m('src/a.ts', 'src/aXts')], [true, false])

// ---- 3. Drift. Two self-contained scripts cannot import a shared matcher, so it is copied; this is
// the only thing that keeps the copies one algorithm instead of two.
check('shared matcher is byte-identical', fenced(IMPL, 'wf-implement.js') === fenced(REVIEW, 'wf-review-loop.js'), true)
check('its primitives are too', primitives(IMPL, 'wf-implement.js') === primitives(REVIEW, 'wf-review-loop.js'), true)
// The third copy: the review loop hands the same note to its fixer and its repair agent that
// wf-implement hands an implementer. Two renderings of one repo's rules would be two contracts.
const IMPL_NOTE = rulesNoteOf(IMPL, 'wf-implement.js')
const REVIEW_NOTE = rulesNoteOf(REVIEW, 'wf-review-loop.js')
check('rulesNote is byte-identical', IMPL_NOTE === REVIEW_NOTE, true)
// Mutation proof, on an in-memory copy: without it this comparison could stop testing anything and
// keep passing. Nothing on disk is touched.
check('  └─ and the comparison goes red when the copy drifts',
  IMPL_NOTE === REVIEW_NOTE.replace('READ THEM', 'READ THEM SOMETIME'), false)

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
