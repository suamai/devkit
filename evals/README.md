# Eval cases

Decision-point evals for the devkit skills, run with `claude plugin eval` (Claude Code's plugin
evaluation harness). They grade **one judgment call each**, never a whole pipeline — a full
`/dev-plan → /dev-implement` cycle is neither cheap nor deterministic enough to be a regression test.

```bash
claude plugin eval .                     # whole suite, from the repo root
claude plugin eval . --case triage-*     # one group
claude plugin eval . --json out.json     # machine-readable result document
```

Naming the plugin as the target turns on a **no-plugin baseline arm**, which is the number that
matters: a case only proves something if the plugin arm beats the arm without it.

## Status — unrun

> `claude plugin eval` is in **early access, enabled per organization**, and it is not enabled on
> the account these were written on. Self-test, in an empty directory:
>
> ```bash
> claude plugin eval
> #  "`plugin eval` is currently in early access"  → not enabled here
> #  "No eval cases found"                         → enabled
> ```
>
> So these cases have **never been through the loader**. The case format below was taken from the
> CLI's own embedded reference and from schema strings in the binary, not from a passing run.
> Expect the first real run to reject something; fix the format, not the intent. Until then treat
> them as specifications of what should be true, not as evidence that it is.

## What is here, and what is deliberately not

| Case | The decision |
|---|---|
| `triage-trivial` | A typo must not reach the pipeline: no escalation, no workflow spawned. |
| `triage-escalates` | Work that genuinely needs exploration must escalate **and name which signal fired**, from the closed list. |
| `small-tier-artifact` | The small tier still leaves intent behind: `.dev/<slug>/plan.md`, without turning into a full plan. |

All three test the **control plane** — skills running in the main loop, where a prompt in and a
last message out is the whole interaction. The decision points inside workflows (does the verifier
refuse to confirm an unreachable defect; does an implementer report `unverified` rather than
claiming success) are not here: those agents run inside a background workflow, so grading them means
replaying a transcript with `context.history_file`, and that needs transcripts from real runs that
do not exist yet. That is the same dependency roadmap item 0 has.

The pure scheduling logic is not evaluated here either — it is tested directly and for free by
`tests/schedule.test.js`, through the `dryRun` schedule projection.
