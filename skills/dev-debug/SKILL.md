---
name: dev-debug
description: Track down a bug — establish a repro first, fan out competing hypotheses read-only, refute them adversarially, then narrow serially against the running code and prove the repro is dead.
argument-hint: <symptom, failing test, or error> [--no-repro]
---

You debug a reported problem. The feature pipeline (`spec → plan → implement`) is the wrong shape
here: debugging is **reproduce → hypothesize → narrow → fix → prove the repro is dead**, and its
expensive mistake is not slow exploration, it is confident diagnosis of the wrong cause.

No workflow script — the fan-out is a handful of agents and the narrowing has to talk to you and run
commands, which is main-loop work.

## 1. Get a repro, or say out loud that you have not got one

A deterministic repro is the only thing that can end this, so it is the first thing to try, not the
last. Aim for the cheapest one that fails reliably: an existing failing test, a new focused test, a
one-line command, a script under the scratchpad.

Record it verbatim — the exact command, the exact expected-vs-actual. You will run it again at the
end and the two runs must be comparable.

If you cannot reproduce it, **say so explicitly and keep it visible in every later message**. An
unreproduced bug can be reasoned about, but it cannot be *closed*: nothing distinguishes "fixed" from
"changed something and the symptom moved". Offer the developer the two honest routes — get more
evidence (logs, the failing input, the environment), or accept a speculative fix explicitly labelled
as unverified. `--no-repro` means they already chose the second; it does not make the fix verified.

## 2. Fan out hypotheses — read-only, and that is structural

Spawn 3-5 agents (`Explore`), one per candidate causal path, each told to **argue from code**: where
the failure could originate, the mechanism, the evidence (`file:line`), and what observation would
confirm or kill it. Give each the repro, the symptom, and a distinct starting region — overlapping
agents return the same first-guess three times.

**None of them may execute anything.** This is not caution about side effects: parallel agents
running the repro contend for one working tree, which is the same reason only one `/dev-implement`
runs per clone. An agent that edits a file to test a theory corrupts every other agent's evidence.
Read-only is what makes the fan-out safe to parallelise at all.

Ask each for its **strongest disconfirming observation**, not just its supporting evidence. A
hypothesis that cannot say what would prove it wrong is a story, and stories survive fan-out by
sounding good.

## 3. Refute before you narrow

Take the surviving hypotheses and attack them, the way `wf-review-loop` verifies findings: one agent
per hypothesis whose job is to **refute** it from code, defaulting to refuted when uncertain. Cheap,
parallel, still read-only.

This inverts the failure mode that makes debugging expensive. A plausible cause is easy to generate
and feels like progress; the cost is paid later, in instrumenting and rebuilding around a theory that
was never checked. Kill them here, where killing one costs one agent.

Report what survived **and what was refuted, with the reason**. A refuted hypothesis is real
information: it is the thing you will otherwise re-propose in twenty minutes.

## 4. Narrow serially, against the running code

Now, and only now, execute — in the main loop, one thing at a time, because the working tree is
shared and the ordering of observations is the evidence.

- Prefer observations that **split the remaining hypotheses**, not ones that confirm the favourite.
  One well-placed log line that eliminates two candidates beats three that confirm one.
- Instrument, do not fix. Keep changes reversible and out of the way until the cause is known;
  `git stash`/`git checkout --` at the end of a wrong path costs nothing if you did not entangle it
  with a fix.
- After each observation, say which hypotheses it killed. If it killed none, the observation was
  badly chosen — pick a sharper one rather than repeating it louder.

Stop when you can state the cause as a mechanism: *this input reaches this line in this state, which
produces that.* "Probably a race" is not a cause; it is where you were before you started.

## 5. Fix — through the normal path, sized by the fix

Triage exactly as `/dev-plan` does, with the same bias toward the cheap tier:

- One obvious edit → do it inline.
- Several files, an unclear approach, or a contract change → `/dev-plan "fix <cause>"`, which gets
  exploration, a plan you approve and waves. Name the cause in the task, not the symptom — the
  symptom is what sent everyone down the wrong path.

If the diagnosis changed what you believe about the subsystem, that is exactly the material item
`/dev-implement` step 10 ratchets into `.claude/rules/` — offer it.

## 6. Prove the repro is dead

Run the recorded repro again, unmodified, and report the before/after. This is the only step that
closes the loop, and it is not satisfied by "the code now looks right" or by a passing test that was
written after the fix and never observed failing.

Then check the neighbourhood: run the surrounding suite, and consider `/dev-review` scoped to the
changed files — a fix aimed at one path is the classic way to break its sibling.

Report: the repro, the cause as a mechanism, **the hypotheses that were refuted and why**, the fix,
and the before/after of the repro. If you never reproduced it, say that first and last, and call the
fix unverified.

Then append one `debug` line to the run ledger — once per invocation, whatever the outcome, including
a run that never got a repro:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-append.sh" <<'JSON'
{"phase":"debug","hypotheses":4,"refuted":3,"repro":"yes"}
JSON
```

`hypotheses` is how many step 2 actually fanned out, `refuted` how many step 3 killed, and `repro` is
`"yes"` only when step 1 produced one that failed on demand — `--no-repro` is a `"no"`. Add `tier`
and `signal` only when step 5 escalated into `/dev-plan`, to mark where that escalation came from
(comma-separated if several fired);
the plan run writes its own line with its own numbers. There is deliberately **no** `slug` and **no**
`state.json` write here, and neither is to be added later: debugging is not a pipeline stage and has
no workspace (see the Notes below). A failed append is one sentence in the report, never a failed
phase.

## Notes

- The read-only fan-out is a hard rule, not a default. If a hypothesis genuinely requires executing
  something to evaluate, that belongs in step 4, serially, in the main loop.
- Hypotheses are not evidence, and neither is agreement between agents. Three agents converging on
  one cause means they share a prior, not that the cause is right — only step 4 settles it.
- No workspace, no `state.json`, no flow: debugging is not a pipeline stage. If it turns into real
  work, that work goes through `/dev-plan` and gets a workspace like anything else.
