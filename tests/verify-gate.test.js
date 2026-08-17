// Extracts the verification-classification block from the shipped workflows and runs the truth table
// against it. Not a copy of the logic — the real lines, read off disk.
//
// TWO scripts classify the same claim: wf-implement judges an implementer's `verify_run`, and
// wf-review-loop judges the post-fix check agent's identical reply. A self-contained workflow script
// cannot import a helper, so the block is copied — and a copy that drifts is two different gates
// wearing one name. Every row therefore runs against BOTH copies, and one case asserts the two
// slices are byte-identical.
const fs = require('fs')
const path = require('path')

const START = '  const verify = impl.verify_run || {}'
// The end anchor is the first line AFTER the classification in each file. Searched from the block
// start (not from 0) and fail-closed: a moved anchor must break the test, never silently shrink it.
const BLOCKS = [
  ['wf-implement.js', '  if (unverified) log('],
  ['wf-review-loop.js', '  return {'],
].map(([file, endAnchor]) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', file), 'utf8')
  const start = src.indexOf(START)
  const end = start === -1 ? -1 : src.indexOf(endAnchor, start)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`${file}: could not locate the classification block (start anchor ${start === -1 ? 'missing' : 'ok'}, end anchor ${JSON.stringify(endAnchor)})`)
  }
  return { file, body: src.slice(start, end) }
})

const cases = [
  ['verify_run missing',                {},                                                        { verifyFailed: false, unverified: true },  'no reason given'],
  ['ran=false with reason',             { verify_run: { ran: false, not_ran_reason: 'no runtime' } }, { verifyFailed: false, unverified: true }, 'no runtime'],
  ['ran=false without reason',          { verify_run: { ran: false } },                            { verifyFailed: false, unverified: true },  'no reason given'],
  ['ran=true, bare (THE HOLE)',         { verify_run: { ran: true } },                             { verifyFailed: false, unverified: true },  'claimed ran=true without naming the command it ran'],
  ['ran=true + command, no passed',     { verify_run: { ran: true, command: 'npm test' } },        { verifyFailed: false, unverified: true },  'claimed ran=true without reporting whether the check passed'],
  ['ran=true, blank command, passed',   { verify_run: { ran: true, command: '   ', passed: true } }, { verifyFailed: false, unverified: true }, 'claimed ran=true without naming the command it ran'],
  ['fully substantiated pass',          { verify_run: { ran: true, command: 'npm test', passed: true } },  { verifyFailed: false, unverified: false }, null],
  ['fully substantiated failure',       { verify_run: { ran: true, command: 'npm test', passed: false } }, { verifyFailed: true,  unverified: false }, null],
  ['failure without a command',         { verify_run: { ran: true, passed: false } },              { verifyFailed: true,  unverified: false },  null],
]

let failed = 0
let ran = 0
for (const { file, body } of BLOCKS) {
  const classify = new Function('impl', `${body}\nreturn { verifyFailed, unverified, unverifiedReason }`)
  console.log(`\n--- ${file}`)
  for (const [name, impl, expected, reason] of cases) {
    const got = classify(impl)
    const ok = got.verifyFailed === expected.verifyFailed && got.unverified === expected.unverified && got.unverifiedReason === reason
    ran++
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} failed=${String(got.verifyFailed).padEnd(5)} unverified=${String(got.unverified).padEnd(5)} reason=${JSON.stringify(got.unverifiedReason)}`)
    if (!ok) console.log(`      expected failed=${expected.verifyFailed} unverified=${expected.unverified} reason=${JSON.stringify(reason)}`)
  }
}

// Same rows passing twice would still allow two different tables that happen to agree on nine inputs.
// Byte equality is what makes them one gate.
console.log('')
const identical = BLOCKS.every((b) => b.body === BLOCKS[0].body)
ran++
if (!identical) failed++
console.log(`${identical ? 'PASS' : 'FAIL'}  ${'the copies are byte-identical'.padEnd(34)} ${BLOCKS.map((b) => `${b.file}=${b.body.length}b`).join(' ')}`)
if (!identical) {
  console.log('      the classification is copied, not imported — edit both copies in the same commit')
  for (const b of BLOCKS) console.log(`--- ${b.file}\n${b.body}`)
}

console.log(failed ? `\n${failed}/${ran} FAILED` : `\nall ${ran} cases pass`)
process.exit(failed ? 1 : 0)
