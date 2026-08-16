// Continuation scheduling: a completed step's id must stop being a dependency, or toWaves() rejects
// the graph outright. Runs the shipped functions, extracted from the workflow by signature.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wf-implement.js'), 'utf8')

function extract(signature) {
  const at = src.indexOf(signature)
  if (at === -1) throw new Error(`could not find ${signature} — has it been renamed?`)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

const scope = new Function(`${extract('function pendingSteps(')}\n${extract('function toWaves(')}\nreturn { pendingSteps, toWaves }`)()
const { pendingSteps, toWaves } = scope

const STEPS = [
  { id: 's1', files: ['a.ts'], depends_on: [] },
  { id: 's2', files: ['b.ts'], depends_on: ['s1'] },
  { id: 's3', files: ['c.ts'], depends_on: ['s1', 's2'] },
  { id: 's4', files: ['d.ts'], depends_on: [] },
]
const shape = (waves) => waves.map((w) => w.map((s) => s.id).join('+')).join(' → ')

let failed = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${actual}`)
  if (!ok) console.log(`      expected ${expected}`)
}

check('nothing completed', shape(toWaves(pendingSteps(STEPS, new Set()))), 's1+s4 → s2 → s3')
check('s1 done — s2/s3 lose a satisfied dep', shape(toWaves(pendingSteps(STEPS, new Set(['s1'])))), 's2+s4 → s3')
check('s1+s2 done — s3 becomes wave 1', shape(toWaves(pendingSteps(STEPS, new Set(['s1', 's2'])))), 's3+s4')
check('a leaf done changes nothing else', shape(toWaves(pendingSteps(STEPS, new Set(['s4'])))), 's1 → s2 → s3')
check('everything done', pendingSteps(STEPS, new Set(['s1', 's2', 's3', 's4'])).length, 0)

// The caller passes ONE steps array and reuses it after the run (continuation.pending is computed
// from it), so the surgery must not mutate the input.
check('input is not mutated', JSON.stringify(STEPS[2].depends_on), '["s1","s2"]')

// The failure this whole mechanism exists to avoid: passing only the pending steps.
let threw = null
try { toWaves(STEPS.filter((s) => s.id !== 's1')) } catch (e) { threw = e.message }
check('naive filtering still throws', String(threw).slice(0, 30), 'unknown step dependencies: s2-')

console.log(failed ? `\n${failed} FAILED` : `\nall ${7} cases pass`)
process.exit(failed ? 1 : 0)
