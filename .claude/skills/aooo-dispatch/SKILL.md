---
name: aooo-dispatch
description: Fan out one aooo development step to a fresh subagent with the standard brief, fences, and verification contract; use when implementing or reviewing a step of docs/aooo/plan.md through delegates.
---

# Dispatch one aooo development step

The coordinator owns the design, the review, and the commit. A fresh delegate implements exactly one
verifiable step. This file is the shared contract: every dispatch cites it and then states only the
step's own scope. The dispatch and this file together form the complete brief. Nothing in a step's
scope may weaken a rule here; a step may only narrow its own fence further.

## The step

Split the unit into steps before dispatching. One step is one verifiable change. It lands green on
its own checks, and the design file says what it must prove. Give each step its own
self-contained section in the design file. The section names the files the step may touch, their
order, the invariants the step must keep, and the check that proves it. The delegate reads only
that section and whatever the section explicitly references. Dispatch serially, hardest step
first when the order allows, and tier the hardest shapes to the strongest model. The next step's
brief usually depends on what the previous step landed, so a step does not start until its
predecessor is committed.

## The dispatch

Every dispatch is short: it cites this file, then states three things and nothing else.

1. **Goal.** One sentence.
2. **Contract.** The design file's path plus the heading of the step's section. The delegate reads
   only that section and whatever it explicitly references, never the whole file. Where any other
   instruction, instinct, or existing code disagrees with that section, the section wins.
3. **Scope.** The exact files to create or edit. Anything else is out of scope.

## The fences

- Tracked documents are English. Chat replies may be Chinese.
- Never modify the frozen inputs under `tests/fixtures/aooo/` (`case.json`, the batch source
  files, `initial-page.md`). The directory's README is procedure text, not a frozen input. Correct
  the README when it is wrong, and record the reason in the commit message.
- Never kill or restart the shared development stack, and never let a test bind the app's
  documented ports.
- No credential, token, or private workspace identity in any tracked file or evidence document.
- Raw logs go to `.logs/aooo/`, private files to `.local/`; neither is tracked.
- Do not run the full repository suite; it has known unrelated failures. Run the step's own files.
- A reviewed list (for example the Notion `writeTools`) is a human decision. Surface a gap; never
  extend a list to make a check pass.
- A bug fix lands its failing test first, red, then the fix.
- Do not commit, create branches, or push. The coordinator reviews, reruns the gate, and commits.

## The verification contract

```sh
bun scripts/aooo/step-gate.ts <test files...> --files <the step's new or edited files> [--journey <repository-relative .test.ts path>] [--note]
```

The gate runs the workspace typecheck, the frozen-baseline test typecheck, lint, format, and each
named test file; `--files` adds the import-sort and assist rules over the step's own files;
`--journey` adds the isolated acceptance runner on one repository-relative `.test.ts` path. The
delegate runs it before reporting back.

## The report

An implementation report returns: the files created and modified; the gate's table; every command
run with its actual result, and never a command that was not run; each deviation from the contract
section with its reason; every genuine design choice made and why; anything unresolved.

## The coordinator loop

1. Read the delegate's whole diff against the contract section, not the summary.
2. Verify every contested claim in source yourself before accepting it.
3. Rerun the gate yourself with the same arguments, with `--note` to record the result.
4. Commit when the diff matches the contract and the gate is green. Record accepted deviations in
   the design file in the same session.
