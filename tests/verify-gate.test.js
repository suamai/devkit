// Extracts the verification-classification block from the shipped workflow and runs the truth
// table against it. Not a copy of the logic — the real lines, read off disk.
const fs = require('fs')

const src = fs.readFileSync(require('path').join(__dirname, '..', 'workflows', 'wf-implement.js'), 'utf8')
const start = src.indexOf('  const verify = impl.verify_run || {}')
const end = src.indexOf('  if (unverified) log(')
if (start === -1 || end === -1 || end <= start) throw new Error('could not locate the classification block')
const body = src.slice(start, end)

const classify = new Function('impl', `${body}\nreturn { verifyFailed, unverified, unverifiedReason }`)

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
for (const [name, impl, expected, reason] of cases) {
  const got = classify(impl)
  const ok = got.verifyFailed === expected.verifyFailed && got.unverified === expected.unverified && got.unverifiedReason === reason
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} failed=${String(got.verifyFailed).padEnd(5)} unverified=${String(got.unverified).padEnd(5)} reason=${JSON.stringify(got.unverifiedReason)}`)
  if (!ok) console.log(`      expected failed=${expected.verifyFailed} unverified=${expected.unverified} reason=${JSON.stringify(reason)}`)
}
console.log(failed ? `\n${failed}/${cases.length} FAILED` : `\nall ${cases.length} cases pass`)
process.exit(failed ? 1 : 0)
