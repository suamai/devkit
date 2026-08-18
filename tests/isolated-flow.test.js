// The isolated-flow contract, spread across three files that must agree.
//
// `/dev-implement --isolated` is stated in one skill, its cleanup is offered by a second, and the
// thing both of them invoke is a shell script. Nothing forces those three to describe the same
// feature: each is prose (or a script) that a later edit can move independently, and the failure is
// silent — a skill that offers a command the script no longer has, or a state key only one side
// writes, reads exactly as well as a correct one.
//
// So every assertion here is anchored on a VALUE or on STRUCTURE — an extracted command string, a
// key name, the relative order of two sections — never on a canonical sentence. That is the same
// rule tests/contract-drift.test.js states in its own header, and for the same reason: a test that
// passes because a file still contains the word "worktree" while the sentence around it says the
// opposite is worse than no test, because it trains people to ignore the suite.
//
// Covers AC-01 (the state field, named by its writer and its reader), AC-04 (present before
// integrating), AC-05 (cleanup is offered and never destroys the branch) and AC-06 (every isolated
// instruction is conditional, so a run without the flag reads as it did before).
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8') } catch (e) {
    throw new Error(`${p} is missing — if a skill or script was renamed, update what invokes it (and this test)`)
  }
}

const IMPLEMENT = 'skills/dev-implement/SKILL.md'
const STATUS = 'skills/dev-status/SKILL.md'
const SCRIPT = 'scripts/worktree.sh'
const implement = read(IMPLEMENT)
const status = read(STATUS)
const script = read(SCRIPT)

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

// ---- 1. The flag is reachable. A skill whose argument-hint omits it is a feature nobody discovers.
const hint = (implement.match(/^argument-hint:.*$/m) || [''])[0]
check('--isolated is in the argument-hint', /--isolated/.test(hint), true)

// ---- 2. The cleanup command is the same string everywhere it is offered.
// This command is stated in two skills because each offers it at a different moment, and
// .claude/rules/prose-contracts.md's rule for an unavoidable copy is identical bytes plus a check
// comparing the pair. Extract every occurrence and collapse: more than one distinct string means
// one side was edited alone.
const CLEANUP = /sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/worktree\.sh" remove [^\n]*/g
const cleanupsIn = (text) => (text.match(CLEANUP) || []).map((s) => s.trim())
const allCleanups = [...cleanupsIn(implement), ...cleanupsIn(status)]
check('both skills state the cleanup command', [cleanupsIn(implement).length > 0, cleanupsIn(status).length > 0], [true, true])
check('and every copy of it is byte-identical', new Set(allCleanups).size, 1)
// Mutation proof, in memory: one copy grows a flag the others do not have, and the pair must go red.
check('and it goes red when one copy drifts',
  new Set([...allCleanups, allCleanups[0] + ' --force']).size, 2)

// The command names a script and a subcommand; both have to exist for the offer to be real.
check('the script it names exists', fs.existsSync(path.join(ROOT, SCRIPT)), true)
check('and it has a remove subcommand', /\bremove\b/.test(script), true)
// The `setup` half is what /dev-implement's preflight invokes — assert it the same way rather than
// trusting that a script with `remove` also has the other verb.
check('and a setup subcommand', /\bsetup\b/.test(script), true)

// The default branch name is a value the script owns and the skill restates — both paths now offer
// the same flat `<slug>-iso` when `dev/<slug>` is impossible, so extract it rather than trusting the
// two to have been edited together.
const DEFAULT_BRANCH = (script.match(/branch=\$\{4:-([^}]+)\}/) || [])[1]
check('worktree.sh defaults the branch to a flat name', DEFAULT_BRANCH, '$slug-iso')
check('and it carries no "dev/" prefix', /(^|[^-\w])dev\//.test(String(DEFAULT_BRANCH)), false)
// The skill has to offer that same shape where it names a fallback, or its advice sends the
// developer to a branch the script would not have chosen.
check('/dev-implement offers the same flat shape', /<slug>-iso/.test(implement), true)

// ---- 3. AC-01: the state keys, named by the skill that WRITES them and the skill that READS them.
// A key only one side knows is a field that silently never round-trips.
for (const key of ['worktree', 'worktree_branch']) {
  check(`${key} is named by both skills`,
    [new RegExp(`\`${key}\``).test(implement), new RegExp(`\`${key}\``).test(status)], [true, true])
}

// ---- 4. AC-04: the diff and verdict are presented BEFORE anything integrates, and the rules
// ratchet — which writes to the primary checkout — comes after that decision. Anchored on the
// numbered step headings and their positions in the file, not on how either is worded: if someone
// reorders the steps, the indices move and this fails.
const stepAt = (n) => {
  const m = implement.match(new RegExp(`^${n}\\. \\*\\*`, 'm'))
  return m ? m.index : -1
}
const report = stepAt(9)
const present = stepAt(10)
const ratchet = stepAt(11)
check('steps 9, 10 and 11 all exist', [report, present, ratchet].every((i) => i >= 0), true)
check('the pre-integration step follows the report', present > report, true)
check('and the rules ratchet follows it', ratchet > present, true)
// The heading has to be the presentation step, not merely the tenth of something. One value, taken
// from the heading text itself.
check('step 10 is the presentation step', /^10\. \*\*Present before integrating/m.test(implement), true)

// ---- 5. AC-05: cleanup is OFFERED, and it can never destroy the work.
// The branch is what survives a removed worktree, so a branch-deleting command anywhere in the
// script would make the offered cleanup capable of discarding unmerged commits.
const deletesBranch = (text) => /git branch\s+(-[Dd]\b|--delete\b)/.test(text)
check('worktree.sh never deletes a branch', deletesBranch(script), false)
// Mutation proof: the guard is a real grep, not a regex that matches nothing.
check('and that check would catch one', deletesBranch('git branch -D dev/x'), true)
check('and the long form too', deletesBranch('git branch --delete dev/x'), true)

// ---- 6. AC-06: every isolated instruction is CONDITIONAL. Without the flag the skill must read as
// it did before, which means no paragraph may state that the flow runs in a worktree unqualified.
// Fenced blocks are excluded on purpose: a code block carries no prose to qualify itself, and the
// section that introduces it is what names the condition.
//
// Stripped line by line rather than with a `/```[\s\S]*?```/` pair match, because this skill indents
// its fences: a non-greedy pair then closes against the wrong fence, leaves the info string ("bash")
// behind as text and welds two distant paragraphs into one. That mis-strip does not fail loudly — it
// invents paragraphs that were never in the file, which is how this assertion would end up reporting
// a violation nobody wrote.
const prose = (text) => {
  let inFence = false
  return text.split('\n').filter((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return false }
    return !inFence
  }).join('\n')
}
const MENTIONS_ROOT = /worktree|<root>|`root`/i
const NAMES_ISOLATION = /isolated|isolation/i
// `worktree.sh` is stripped first: the claim this guards against is "the flow runs in a worktree"
// stated without its condition, and naming the SCRIPT is not that claim. The non-isolated preflight
// legitimately points at `scripts/worktree.sh` for a branch name it shares, and counting a filename
// as an unconditional instruction would force that paragraph to pretend it is about isolation. The
// mutation cases below are what keep this from becoming a hole: the real regression still fails.
const unconditional = (text) => prose(text)
  .split(/\n\s*\n/)
  .filter((p) => MENTIONS_ROOT.test(p.replace(/worktree\.sh/g, '')) && !NAMES_ISOLATION.test(p))
check('no unconditional worktree instruction in /dev-implement', unconditional(implement).length, 0)
// Mutation proof: a paragraph that says the flow runs in a worktree without naming the flag is
// exactly the regression this assertion exists to catch.
check('and an unconditional one would be caught',
  unconditional('The run happens in a worktree at <root>.\n\nUnrelated text.').length, 1)
// ...while the same sentence qualified by the flag is fine.
check('and a conditional one is not',
  unconditional('Under --isolated the run happens in a worktree at <root>.').length, 0)
// And the strip above does not open a hole: a paragraph naming the script AND making the
// unconditional claim is still caught, because the claim survives the filename being removed.
check('naming worktree.sh does not launder a real claim',
  unconditional('Run worktree.sh; the flow then runs in a worktree at <root>.').length, 1)
// A paragraph that only names the script is the case the strip exists for.
check('but naming worktree.sh alone is fine',
  unconditional('Use the branch name scripts/worktree.sh defaults to.').length, 0)

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
