# Unit 5 retrospective: investigate failures, then stop

Written 2026-11-20, after the unit 5 acceptance runs. This file records what the 2026-11-19
failure investigation could and could not establish, and the working rules for later units.
The raw suite logs were kept in temporary directories and are not archived. The facts below
come from the two development sessions and the committed test code.

## What happened in unit 5

The original development session lasted about 74 minutes. It completed the implementation
and the two-process HTTP acceptance run, then hit a failure in the overlapping-runs Stop
test. The test expected a new tool call to be rejected after Stop. Instead, the fixture
returned `unexpected`. The agent changed how tool calls were bound to an attempt, but the
same test failed in the final suite, which reported 331 passes and 1 failure.

The follow-up session changed no related code. It ran the Stop test once by itself, then ran
the required acceptance suite. All 332 tests passed. The session committed the unit 5 code
and tests as `df3777ac`. The accurate result is: the current acceptance run passed, the
earlier failure did not recur, and its cause is still unknown. The attempt-scoped recorder
change was already present during the final failing run, so the later pass does not show
that this change fixed the failure.

The test waits for the Agent's abort signal before it tries another tool call. A
user-requested Stop first writes the stop state to the database and then sends that signal.
Other errors can send the same signal. The old logs do not show who sent it, when the
database recorded the stop, or when the new tool call began. They cannot distinguish whether
the test called too early or the runtime admitted a tool call after Stop took effect. The
test is at `server/tests/local-runtime-store.integration.test.ts:561` and the runner at
`server/src/local-runtime/runner.ts:207`.

## How to handle the next unit

1. **List required checks before coding.** Use the current unit's acceptance plan. If an
   extra check fails, compare it with the baseline and assess whether this unit changed the
   failing code. For example, the test typecheck already reported an error in
   `config.test.ts`. Once you confirm an error predates the change and is outside the
   required checks, report it separately.
2. **Preserve the first failure and narrow the next run.** Save a separate log for each run.
   Record the sanitized command, commit, working-tree state, and test environment. Before
   rerunning, write down the competing explanations and the evidence that will distinguish
   them. Add that observation or reduce the test to the smallest useful case. If a test
   passes alone but failed in a suite, rerun the smallest related group while preserving its
   order. Avoid changing both the implementation and the test's timing before collecting
   evidence. Otherwise, you will not know which change affected the result.
3. **Set a time and run limit up front.** Spend no more than 15 minutes or 3 diagnostic
   runs on one failure, whichever comes first. Use the first run to narrow the cause. Each
   later run must collect new evidence. Once you identify the cause, make the smallest
   relevant fix, rerun the failing test, and run the required acceptance checks once. If the
   limit expires first, report the last result, what the evidence confirms, and what
   remains unknown. Keep the unit blocked if a required check still fails or evidence shows
   that required behavior is wrong. Make a local commit to preserve progress when useful.

## Prompt for the next development task

> List this unit's required checks before you start. If an extra check fails, compare it
> with the baseline and report it separately. After the first acceptance failure, save a
> separate log, the command, commit, and working-tree state. Isolate the failing check.
> Before each rerun, state which explanations it will distinguish and what evidence it will
> collect. Spend no more than 15 minutes or 3 diagnostic runs on one failure, whichever
> comes first. If you identify the cause, make the smallest relevant fix, then rerun the
> failing check and the required acceptance suite once. If the limit expires first, report
> what passed, what failed, and whether the earlier failure recurred. Mark the unit blocked
> when a required check still fails or the evidence shows incorrect behavior.
