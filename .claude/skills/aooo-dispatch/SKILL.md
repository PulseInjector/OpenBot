---
name: aooo-dispatch
description: Fan out one aooo development step to a fresh subagent with the standard brief, fences, and verification contract; use when implementing or reviewing a step of docs/aooo/plan.md through delegates.
---

# Dispatch one aooo development step

The coordinator owns the design, the review, and the commit. A fresh delegate implements exactly one
verifiable step. This skill is the shared brief: the recipe, the verification contract, and the
do-not-touch fences in one artifact, so every dispatch carries them without being rewritten by hand.

## The step

Split the unit into steps before dispatching. One step is one verifiable change: it lands green on
its own checks, and the design file says what it must prove. Dispatch serially, hardest step first
when the order allows, and tier the hardest shapes to the strongest model. The next step's brief
usually depends on what the previous step landed, so a step does not start until its predecessor is
committed.

## The brief

Hand the delegate this shape, filled in:

1. **Goal.** One sentence.
2. **Contract.** Quote the design file's section verbatim (path plus heading). The delegate
   implements the contract, never a paraphrase of it.
3. **Scope.** The exact files to create or edit. Anything else is out of scope.
4. **Fences.** The list below, verbatim.
5. **Verification.** The gate command below with the step's own test files, run by the delegate
   before reporting back. Paste the table; do not smooth over a failure.
6. **Report.** Deviations and judgment calls surfaced explicitly, each with the reason. Do not
   commit; the coordinator reviews, reruns the gate, and commits.

## The fences

- Tracked documents are English. Chat replies may be Chinese.
- Never modify anything under `tests/fixtures/aooo/`.
- Never kill or restart the shared development stack, and never let a test bind the app's
  documented ports.
- No credential, token, or private workspace identity in any tracked file or evidence document.
- Raw logs go to `.logs/aooo/`, private files to `.local/`; neither is tracked.
- Do not run the full repository suite; it has known unrelated failures. Run the step's own files.
- A reviewed list (for example the Notion `writeTools`) is a human decision. Surface a gap; never
  extend a list to make a check pass.
- A bug fix lands its failing test first, red, then the fix.

## The verification contract

```sh
bun scripts/aooo/step-gate.ts <test files...> --files <the step's new or edited files> [--journey <name>] [--note]
```

The gate runs the workspace typecheck, the frozen-baseline test typecheck, lint, format, and each
named test file; `--files` adds the import-sort and assist rules over the step's own files;
`--journey` adds the isolated acceptance runner; `--note` appends the result line to
`.local/dev-log.md`. The delegate pastes the table with the report. The coordinator reruns the same
command independently before committing: the gate's table is shared evidence, not a substitute for
the review.

## The coordinator loop

1. Read the delegate's whole diff against the quoted contract, not the summary.
2. Verify every contested claim in source yourself before accepting it.
3. Rerun the gate yourself with the same arguments, with `--note` to record the result.
4. Commit when the diff matches the contract and the gate is green. Record accepted deviations in
   the design file in the same session.
