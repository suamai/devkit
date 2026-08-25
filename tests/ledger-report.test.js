// The calibration reader: what scripts/ledger-report.sh computes from a ledger file, what it does
// when there is none, and what it refuses to say. Runs the shipped script against a fixture written
// into a throwaway HOME — never a tracked file, and never the developer's real ledger.
//
// The expectations here are hand-computed from the fixture below (each one carries its arithmetic),
// because a test that recomputed the medians in JS would drift into the same mistake twice. The one
// value that IS extracted from source is the agents floor: that formula lives in wf-implement.js and
// is copied into the awk, so this file evaluates the shipped expression to prove the copy still
// agrees.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'ledger-report.sh')

let failed = 0
let cases = 0
function check(name, actual, expected) {
  cases++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${a}`)
  if (!ok) console.log(`      expected ${e}`)
}

// ---- the fixture. One object per ledger line, in the shape docs/architecture.md documents:
// every string-valued field top-level, numbers/booleans inside cost/findings/verification only.
const PLAN = [
  // tier, cost.total, cost.by_phase
  { phase: 'plan', slug: 'a', tier: 'small', concurrent: false, cost: { by_phase: { explore: 10000 }, total: 10000, budget_total: null, floors_active: false } },
  { phase: 'plan', slug: 'b', tier: 'medium', signal: 'cross-cutting', open_questions: 2, agents_projected: 18, concurrent: false, cost: { by_phase: { explore: 20000, validate: 6000 }, total: 26000, budget_total: null, floors_active: false } },
  { phase: 'plan', slug: 'c', tier: 'medium', signal: 'cross-cutting', concurrent: 'unknown', cost: { by_phase: { explore: 24000, validate: 6000 }, total: 30000, budget_total: null, floors_active: false } },
  { phase: 'plan', slug: 'd', tier: 'trivial', concurrent: false, cost: { by_phase: { explore: 2000 }, total: 2000, budget_total: null, floors_active: false } },
]
const IMPLEMENT = [
  // 'a' and 'd' carry tier: 'medium' — the same tier as two PLAN lines below, but at a wholly
  // different cost magnitude. That is what proves phase=implement tier=medium and phase=plan
  // tier=medium are kept as separate buckets rather than blended into one median.
  { phase: 'implement', slug: 'a', tier: 'medium', waves: 3, steps_leaf: 10, splits: 1, scouts_ran: 2, gates: 2, gate_breaks: 1, checkpoints: 1, agents_projected: 18, concurrent: false, findings: { raw_titles: 12, clusters: 5, confirmed: 4, refuted: 1, applied: 4, skipped: 0 }, verification: { steps: 10, passed: 9, unverified_honest: 1, unverified_unevidenced: 0, unverified_infra: 0, weak_evidence: 2, kind_missing: 0 }, cost: { by_phase: { steps: 30000, gate: 0, review: 12000 }, total: 42000, budget_total: null, floors_active: false } },
  // A stop reason is free text with a comma and parentheses in it — the reader must not lose the
  // fields after it, which is exactly what a naive "up to the next comma" split would do.
  { phase: 'implement', slug: 'b', steps_leaf: 6, splits: 0, scouts_ran: 1, gates: 1, checkpoints: 1, agents_projected: 12, concurrent: true, stopped: true, stop_reason: 'a blocking question was raised, see the report (s3)', findings: { raw_titles: 8, clusters: 4, confirmed: 3, refuted: 1, applied: 3, skipped: 0 }, verification: { steps: 6, passed: 5, unverified_honest: 0, unverified_unevidenced: 1, unverified_infra: 0, weak_evidence: 0, kind_missing: 0 }, cost: { by_phase: { steps: 20000, review: 10000 }, total: 30000, budget_total: null, floors_active: false } },
  { phase: 'implement', slug: 'c', steps_leaf: 4, splits: 1, scouts_ran: 0, gates: 1, checkpoints: 0, agents_projected: 8, concurrent: 'unknown', verification: { steps: 4, passed: 3, unverified_honest: 0, unverified_unevidenced: 0, unverified_infra: 1, weak_evidence: 0, kind_missing: 1 }, cost: { by_phase: { steps: 50000 }, total: 50000, budget_total: null, floors_active: false } },
  { phase: 'implement', slug: 'd', tier: 'medium', steps_leaf: 4, splits: 0, scouts_ran: 1, gates: 1, checkpoints: 1, agents_projected: 10, concurrent: false, findings: { raw_titles: 6, clusters: 2, confirmed: 1, refuted: 1, applied: 1, skipped: 0 }, verification: { steps: 3, passed: 3, unverified_honest: 0, unverified_unevidenced: 0, unverified_infra: 0, weak_evidence: 0, kind_missing: 0 }, cost: { by_phase: { steps: 16000, review: 6000 }, total: 22000, budget_total: null, floors_active: false } },
]
const REVIEW = [
  // Two of these four carry the regression pair (`fix_rounds` top-level, `regressions_introduced`
  // inside findings) and two carry neither — so row 8's n= is what proves a line missing the field
  // is not counted as a fix phase that introduced nothing.
  { phase: 'review', rounds: 1, clean: true, rounds_end: 'clean', profile: 'cheap', fix_rounds: 4, findings: { raw_titles: 6, clusters: 3, confirmed: 2, refuted: 1, applied: 2, skipped: 0, regressions_introduced: 2 }, cost: { by_phase: { review: 8000 }, total: 8000, budget_total: null, floors_active: false } },
  { phase: 'review', rounds: 2, clean: true, rounds_end: 'clean', findings: { raw_titles: 4, clusters: 2, confirmed: 1, refuted: 1, applied: 1, skipped: 0 }, cost: { by_phase: { review: 12000 }, total: 12000, budget_total: null, floors_active: false } },
  { phase: 'review', rounds: 3, clean: false, rounds_end: 'max-rounds', fix_rounds: 8, findings: { raw_titles: 9, clusters: 3, confirmed: 3, refuted: 0, applied: 2, skipped: 1, regressions_introduced: 3 }, cost: { by_phase: { review: 20000 }, total: 20000, budget_total: null, floors_active: false } },
  { phase: 'review', rounds: 1, clean: true, rounds_end: 'clean', seeded: true, findings: { raw_titles: 3, clusters: 1, confirmed: 1, refuted: 0, applied: 1, skipped: 0 }, cost: { by_phase: { review: 6000 }, total: 6000, budget_total: null, floors_active: false } },
]
const GARBAGE = 'this is not json at all'

// The garbage line sits in the middle: a reader that gives up on it would truncate everything after.
function ledgerText(lines) {
  const [p, i, r] = lines
  return [...p.map(JSON.stringify), GARBAGE, ...i.map(JSON.stringify), ...r.map(JSON.stringify)].join('\n') + '\n'
}
const clone = (o) => JSON.parse(JSON.stringify(o))

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ledger-report-'))
fs.mkdirSync(path.join(home, '.claude', 'devkit'), { recursive: true })
const LEDGER = path.join(home, '.claude', 'devkit', 'runs.jsonl')
function writeLedger(text) { fs.writeFileSync(LEDGER, text) }
writeLedger(ledgerText([PLAN, IMPLEMENT, REVIEW]))

function run(h, args) {
  const r = spawnSync('sh', [SCRIPT].concat(args || []), { encoding: 'utf8', env: { ...process.env, HOME: h } })
  return { status: r.status, out: r.stdout, err: r.stderr }
}
// The row a needle names, whitespace-collapsed so alignment changes are not test failures.
function row(text, prefix) {
  const l = text.split('\n').map((x) => x.trim().replace(/\s+/g, ' ')).find((x) => x.startsWith(prefix))
  return l === undefined ? `<no row starting with ${JSON.stringify(prefix)}>` : l
}

const report = run(home, [])
check('the report exits 0', report.status, 0)
// 12 objects above; the garbage line is the 13th and must be counted, not swallowed.
check('every readable line is counted', row(report.out, 'devkit calibration'), 'devkit calibration — 12 ledger line(s) from ~/.claude/devkit/runs.jsonl')
check('the unreadable line is skipped AND counted', row(report.out, '1 line(s) skipped'), '1 line(s) skipped as unreadable')

// 1. raw 12+8+6+6+4+9+3 = 48 over clusters 5+4+2+3+2+3+1 = 20 → 2.40, from 7 lines carrying findings.
check('clustering ratio', row(report.out, '1. Clustering ratio'), '1. Clustering ratio n=7 2.40 raw titles per semantic cluster (48 raw / 20 clusters)')
// 2. splits 1+0+1+0 = 2 over leaf steps 10+6+4+4 = 24 → 0.08.
check('split rate over implement lines', row(report.out, '2. Split rate'), '2. Split rate n=4 0.08 (2 splits / 24 leaf steps)')
// 3. clean:true lines only — rounds 1, 2, 1. The unclean 3-round line shows up in rounds_end.
check('round convergence counts clean runs', row(report.out, '3. Round convergence'), '3. Round convergence n=3 rounds to clean: 1×2 2×1')
check('and every rounds_end', row(report.out, 'n=4 ended:'), 'n=4 ended: clean×3 max-rounds×1')
// 4. tiers small, medium, medium, trivial → 2 of 4 past small.
check('escalation rate over plan lines', row(report.out, '4. Escalation rate'), '4. Escalation rate n=4 50% went past small (2/4)')
check('with the signal histogram', row(report.out, 'n=2 signals:'), 'n=2 signals: cross-cutting×2')
// 5. honest 1+0+0+0, unevidenced 0+1+0+0, infra 0+0+1+0, over 10+6+4+3 = 23 steps.
check('unverified split three ways', row(report.out, '5. Unverified steps'), '5. Unverified steps n=4 honest 1, unevidenced 1, infra 1, over 23 steps')

// 6. medians, never means. implement totals 22k 30k 42k 50k → (30+42)/2 = 36k; a mean would be 36k
// too, so plan (2k 10k 26k 30k → median 18k, mean 17k) is the row that proves which one ran.
check('median cost.total by phase', row(report.out, 'phase=implement'), 'phase=implement n=4 36k')
check('a median, not a mean', row(report.out, 'phase=plan'), 'phase=plan n=4 18k')
// tier=medium is scoped by phase: plan's 26k/30k (28k median) must not blend with implement's
// 42k/22k (32k median) — the two populations sit at wholly different magnitudes.
check('median by tier is scoped to plan', row(report.out, 'phase=plan tier=medium'), 'phase=plan tier=medium n=2 28k')
check('median by tier is scoped to implement, not blended with plan', row(report.out, 'phase=implement tier=medium'), 'phase=implement tier=medium n=2 32k')
// An omitted `profile` is the shipped default, so 11 of the 12 lines land here and only the one
// explicit "cheap" review does not.
check('an omitted profile counts as default', row(report.out, 'profile=default'), 'profile=default n=11 22k')
check('and an explicit one does not', row(report.out, 'profile=cheap'), 'profile=cheap n=1 8k')
// by_phase keys: review 12k 10k 6k 8k 12k 20k 6k → median 10k. The `gate: 0` entry is not a sample.
check('median per cost.by_phase key', row(report.out, 'by_phase=review'), 'by_phase=review n=7 10k')
check('a zero-cost phase is not a sample', report.out.includes('by_phase=gate'), false)

// 7. The floor formula is wf-implement.js's, so take it from there rather than restating it: if that
// line changes, this fails and the copy inside the awk has to move with it.
const IMPL_SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'wf-implement.js'), 'utf8')
const AGENTS_MIN = IMPL_SRC.match(/agents_min:\s*([^\n]+?),\s*\n/)
if (!AGENTS_MIN) throw new Error('wf-implement.js: the agents_min expression was not found')
const floorOf = new Function('scouts', 'todoSteps', 'gates', 'checkpoints', `return ${AGENTS_MIN[1]}`)
const floors = IMPLEMENT.map((l) => floorOf(l.scouts_ran, { length: l.steps_leaf }, l.gates, l.checkpoints))
check('the shipped floor formula gives', floors, [19, 13, 6, 11])
check('projected agents, median of 8 10 12 18', row(report.out, 'projected by the plan'), 'projected by the plan n=4 11')
check('observed floor, median of 6 11 13 19', row(report.out, 'observed floor'), 'observed floor n=4 12')

// 8. Only 2 of the 12 lines carry both fields: regressions 2+3 = 5 over fix rounds 4+8 = 12 → 0.42.
// The other ten carry neither, and n=2 rather than n=12 is what says they were left out instead of
// being read as fix phases that introduced nothing.
check('regressions per fix round', row(report.out, '8. Regression rate'), '8. Regression rate n=2 0.42 regressions per fix round (5 introduced / 12 fix rounds)')

// AC-04: the caveat is a number, not a sentence. false on 5 of the 12 cost-carrying lines.
check('concurrency caveat carries its count', row(report.out, '7 of 12'), '7 of 12 token samples ran with concurrent true or unknown — their cost.by_phase may be inflated.')

// ---- no ledger, and an empty one. Neither is an error: the file appears when a phase first runs.
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ledger-none-'))
const none = run(bare, [])
check('no ledger exits 0', none.status, 0)
check('no ledger says where it would be', none.out.trim(), 'no ledger yet at ~/.claude/devkit/runs.jsonl — it is written by the phase skills; run any phase to start one')
check('no ledger quotes nothing', run(bare, ['--quote', '--phase', 'implement']).out.trim(), 'n=0 comparable runs')
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ledger-empty-'))
fs.mkdirSync(path.join(emptyHome, '.claude', 'devkit'), { recursive: true })
fs.writeFileSync(path.join(emptyHome, '.claude', 'devkit', 'runs.jsonl'), '')
const empty = run(emptyHome, [])
check('an empty ledger exits 0', empty.status, 0)
check('an empty ledger says so', empty.out.trim(), 'ledger at ~/.claude/devkit/runs.jsonl is empty — no phase has recorded a run yet')

// ---- --quote: one line, and a refusal below three samples.
const q4 = run(home, ['--quote', '--phase', 'implement'])
check('--quote prints exactly one line', q4.out.split('\n').filter((l) => l !== '').length, 1)
check('--quote with 4 matches', q4.out.trim(), 'n=4 comparable runs: median 36k output tokens, median 12 agents (floor)')
check('--quote with 2 matches refuses a median', run(home, ['--quote', '--phase', 'plan', '--tier', 'medium']).out.trim(), 'n=2 — sample too small to quote (need 3)')
check('--quote with no match', run(home, ['--quote', '--phase', 'debug']).out.trim(), 'n=0 comparable runs')
// An absent --tier widens the query; an absent `profile` field still matches --profile default.
check('--profile default matches lines with none', run(home, ['--quote', '--phase', 'implement', '--profile', 'default']).out.trim(), q4.out.trim())
check('--profile cheap does not', run(home, ['--quote', '--phase', 'implement', '--profile', 'cheap']).out.trim(), 'n=0 comparable runs')
check('--quote needs a phase', run(home, ['--quote']).status, 2)
check('a filter without --quote is refused', run(home, ['--tier', 'medium']).status, 2)
check('an unknown argument is refused', run(home, ['--calibration']).status, 2)

// ---- mutation proof (.claude/rules/tests.md): a reader that silently stopped reading a field would
// keep printing the old number. Change one fixture value in the throwaway ledger and the printed
// median must move — same check, second call.
const mutatedCost = clone(IMPLEMENT)
mutatedCost[2].cost.total = 24000 // was 50000 → totals 22k 24k 30k 42k → median 27k
writeLedger(ledgerText([PLAN, mutatedCost, REVIEW]))
const afterCost = run(home, [])
check('mutating cost.total moves the median', row(afterCost.out, 'phase=implement'), 'phase=implement n=4 27k')
check('and it did move', row(afterCost.out, 'phase=implement') === row(report.out, 'phase=implement'), false)

const mutatedFindings = clone(IMPLEMENT)
mutatedFindings[0].findings.raw_titles = 24 // was 12 → 60 raw over 20 clusters → 3.00
writeLedger(ledgerText([PLAN, mutatedFindings, REVIEW]))
const afterFindings = run(home, [])
check('mutating raw_titles moves the ratio', row(afterFindings.out, '1. Clustering ratio'), '1. Clustering ratio n=7 3.00 raw titles per semantic cluster (60 raw / 20 clusters)')

const mutatedReview = clone(REVIEW)
mutatedReview[0].findings.regressions_introduced = 8 // was 2 → 11 over the same 12 fix rounds → 0.92
writeLedger(ledgerText([PLAN, IMPLEMENT, mutatedReview]))
const afterRegressions = run(home, [])
check('mutating regressions_introduced moves the rate', row(afterRegressions.out, '8. Regression rate'), '8. Regression rate n=2 0.92 regressions per fix round (11 introduced / 12 fix rounds)')
check('and it did move', row(afterRegressions.out, '8. Regression rate') === row(report.out, '8. Regression rate'), false)

// ---- unq() must decode a \uXXXX escape (scripts/ledger-report.sh), not drop the backslash and
// leak the raw hex digits into the report. Expected comes from JSON.parse on the same fixture line,
// never restated by hand.
const uHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ledger-unicode-'))
fs.mkdirSync(path.join(uHome, '.claude', 'devkit'), { recursive: true })
const uLine = '{"phase":"plan","tier":"medium","signal":"cross\\u2011cutting"}\n'
fs.writeFileSync(path.join(uHome, '.claude', 'devkit', 'runs.jsonl'), uLine)
const uExpected = JSON.parse(uLine).signal
const uReport = run(uHome, [])
check('a \\u escape decodes the same way JSON.parse would', row(uReport.out, 'n=1 signals:'), `n=1 signals: ${uExpected}×1`)
fs.rmSync(uHome, { recursive: true, force: true })

// ---- a triage can name more than one signal, and the line carries them comma-separated. Each must
// land in its own histogram bucket: the joined string as one key is what made the escalation row
// stop answering "which signal is doing the discriminating work". The run count and the signal
// count are deliberately different totals, so both are asserted on the same fixture.
const mHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ledger-multisignal-'))
fs.mkdirSync(path.join(mHome, '.claude', 'devkit'), { recursive: true })
fs.writeFileSync(path.join(mHome, '.claude', 'devkit', 'runs.jsonl'), [
  { phase: 'plan', tier: 'medium', signal: 'contract-change' },
  // one with a space after the comma and one without: the ledger is hand-written by a skill's
  // heredoc, so both spellings will occur and must collapse to the same two buckets.
  { phase: 'plan', tier: 'medium', signal: 'contract-change, independent-parts' },
  { phase: 'plan', tier: 'large', signal: 'unknown-code,contract-change' },
].map((o) => JSON.stringify(o)).join('\n') + '\n')
const mReport = run(mHome, [])
check('each signal of a multi-signal line is counted separately',
  row(mReport.out, 'n=3 signals:'),
  'n=3 signals: contract-change×3 independent-parts×1 unknown-code×1')
// n=3 is runs-with-a-signal, not the 5 signal occurrences above it: the escalation rate divides by
// runs, so a multi-signal line must not inflate its denominator.
check('a multi-signal line still counts as one escalated run',
  row(mReport.out, '4. Escalation rate'),
  '4. Escalation rate n=3 100% went past small (3/3)')
fs.rmSync(mHome, { recursive: true, force: true })

// ---- a ledger from before the field existed must say n=0, not a confident zero — and half a pair
// is not a sample either: `fix_rounds` alone has no numerator, `regressions_introduced` alone has no
// denominator, and counting either would put a made-up number where the missing one belongs.
const gHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ledger-noregression-'))
fs.mkdirSync(path.join(gHome, '.claude', 'devkit'), { recursive: true })
const gBase = { phase: 'review', rounds: 1, clean: true, rounds_end: 'clean', findings: { raw_titles: 3, clusters: 1, confirmed: 1, refuted: 0, applied: 1, skipped: 0 }, cost: { by_phase: { review: 5000 }, total: 5000, budget_total: null, floors_active: false } }
const gOnlyRounds = clone(gBase); gOnlyRounds.fix_rounds = 3
const gOnlyRegressions = clone(gBase); gOnlyRegressions.findings.regressions_introduced = 2
fs.writeFileSync(path.join(gHome, '.claude', 'devkit', 'runs.jsonl'),
  [gBase, gOnlyRounds, gOnlyRegressions].map((o) => JSON.stringify(o)).join('\n') + '\n')
const gReport = run(gHome, [])
check('a ledger with no regression field says n=0', row(gReport.out, '8. Regression rate'), '8. Regression rate n=0 — no data')
// …and n=0 because nothing carried the pair, not because the three lines went unread: the row that
// reads the same findings objects still counts all three, 9 raw over 3 clusters.
check('while the rest of those lines is still read', row(gReport.out, '1. Clustering ratio'), '1. Clustering ratio n=3 3.00 raw titles per semantic cluster (9 raw / 3 clusters)')
fs.rmSync(gHome, { recursive: true, force: true })

// ---- and the zero denominator, which is not the same thing: every sampled line recorded the pair
// and every one of them recorded zero fix rounds (a ledger where every review went clean in round
// one). There is no rate to print, only the counts — awk treats a division by zero as fatal, so the
// guard is what keeps the whole report from dying on a real ledger.
const zHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-ledger-nofixrounds-'))
fs.mkdirSync(path.join(zHome, '.claude', 'devkit'), { recursive: true })
const zLine = clone(gBase); zLine.fix_rounds = 0; zLine.findings.regressions_introduced = 0
fs.writeFileSync(path.join(zHome, '.claude', 'devkit', 'runs.jsonl'),
  [zLine, zLine].map((o) => JSON.stringify(o)).join('\n') + '\n')
const zReport = run(zHome, [])
check('no fix rounds at all prints the counts, not a rate', row(zReport.out, '8. Regression rate'), '8. Regression rate n=2 0 introduced, 0 fix rounds')
check('and the report still exits 0', zReport.status, 0)
fs.rmSync(zHome, { recursive: true, force: true })

fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(bare, { recursive: true, force: true })
fs.rmSync(emptyHome, { recursive: true, force: true })

console.log(failed ? `\n${failed} FAILED` : `\nall ${cases} cases pass`)
process.exit(failed ? 1 : 0)
