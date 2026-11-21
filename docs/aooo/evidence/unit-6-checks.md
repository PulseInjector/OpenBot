# Unit 6: Reconnect to the original thread, run display, and the desktop dev entry

Checked on 2026-11-21 on `feat/local-bot-workbench`, after unit 5. The implementation commits are
`0ab279cd` (crash settlement), `667b48f2` (client history restore), `61e9df53` (tool-turn fold),
`676a7a36` (run status derivation), `bc1b0bd2` (status strip), `f5b19395` (start.sh local mode, issue
#4), `31663026` (desktop local entry), and `df31b03b` (browser reconnect journey). The design the
unit was built from is [the unit 6 design file](../designs/unit-6-reconnect-and-desktop.md).

## What the implementation preserves

These are the design decisions the unit had to keep, and the reason the code reads the way it does.

**Crashed runs settle at read time and nowhere else.** `settleLapsedThreadWork` runs in one
binding-locked transaction, marks a lapsed running attempt `interrupted` with the lease-expiry
reason, cancels the run, and appends exactly one `RUN_ERROR` (code `STOPPED`) and one
`attempt.interrupted` event in `finishAttempt`'s order and payload shape. Exactly two call sites
trigger it, `openThreadReplay` and `readHistory`, so a reconnecting client or history read never
targets a dead run as live. No background reaper exists, a settled run is never claimed again, and
the lease window is one exported constant shared with the runner's claim default, overridable by
`OPENBOT_LOCAL_LEASE_MS`.

**One history mechanism, not two half-wired ones.** `readThreadMessages` reads the runtime mode once
per page load and, in local mode, maps the server's history projection through the existing
`readableTurns` boundary instead of the SDK REST endpoint that 422s without a private contract the
fork never touches. The `/bot` page keeps its replay restore. The mode branch exists in exactly one
function.

**Tool turns fold at read time.** The runner persists every AG-UI event in `local_events` but only
text and input content as message rows, so `readHistory` folds the recorded `TOOL_CALL_*` and
`TOOL_CALL_RESULT` events into the message projection: a call attaches to the row its
`parentMessageId` names or mints one, a result mints a tool row whose id derives from its
`toolCallId`, and rows anchor where they first appeared so interleaved text and tool use keeps its
order. No table, no column, and no event type was added, and the writer is unchanged.

**One derivation of run status.** `summarizeRunState` is pure over the history read, enforces the
agreeing-pair invariant for every terminal run, and fails closed on a disagreement. A thin status
route exposes it behind the history route's own ownership checks, and the client hook consumes it
rather than re-deriving phases, so the UI, the evidence scripts, and the reconnect journey read one
function.

**start.sh never kills what it cannot attribute.** The script reads and exports
`OPENBOT_RUNTIME_MODE` once, probes a local listener through the constant product marker plus
`mode: "local"`, refuses a same-product listener in the wrong mode with a message naming its mode,
refuses a non-product listener without killing it, and restarts only processes attributable to this
checkout. The Intelligence branches are byte for byte unchanged, pinned by the 20 pre-existing
script tests passing unmodified. The capabilities payload gains one constant `product` marker.

**The desktop shell's Intelligence machinery is untouched.** A `Local workbench` section on the
welcome screen parses the address through one pure loopback-only validator, probes
`/api/capabilities` for the product marker, local mode, and durable history, fails closed through
the existing failure panel, and opens a `WebviewWindow` on success. One Tauri v2 capability grant was
required; no CSP change and no Rust module change.

## Every acceptance item, with where it was checked

| Acceptance item | Result | Where |
| --- | --- | --- |
| With the page closed, the server keeps working, and reopening does not dispatch again | Passed | Journey close-reopen phase; one `local_runs` row, one `run.queued` event, model request count unchanged by the reopen |
| After a refresh the conversation reconnects to the original run | Passed | Journey refresh phase; one run, one queued event, no second submission |
| After a normal service restart, history is readable | Passed | Journey service-restart phase; a replacement server on the same port and database serves the full transcript and status |
| A crash mid-run clearly shows an interrupt | Passed | Journey crash phase; SIGKILL with `OPENBOT_LOCAL_LEASE_MS=3000`, the strip reads `Run was interrupted: execution lease expired`, and no new attempt starts |
| The conversation shows run state, failure reason, history, and artifacts | Passed | Journey visible-state phase; `Run succeeded`, `Run failed` with the stored reason, the folded tool line, and the final message link |
| start.sh brings up and verifies a local stack | Code and script tests passed; live run not run | 27 script tests (98 assertions) including both wrong-mode refusals and the no-marker refusal without a kill; the human run against the dev database is deferred to the closing session |
| The macOS dev shell connects to local mode | Not run | Human-driven; the feature map records `desktop-local` as not run with no driver. The unit 5 prerequisite HTTP evidence still stands |

## Focused checks actually run, and their results

All were run on 2026-11-21 by the implementing subagents and rerun independently by the
coordinator.

- `bun run verify:aooo server/tests/local-runtime-crash-settlement.integration.test.ts` — 3 tests,
  54 assertions, 0 failures. Settles through each of the three readers, is idempotent, never claims a
  settled run again, spares live work, orphans only queued runs older than the lease window, and
  rejects a wrong owner or Bot.
- `bun run verify:aooo server/tests/local-runtime-history-fold.integration.test.ts` — 3 tests,
  5 assertions, 0 failures. A recorded tool call and result fold in sequence order, a parentless call
  mints its row, and a second read is byte-identical.
- `bun run verify:aooo server/tests/local-runtime-summary.integration.test.ts` — 4 tests,
  12 assertions, 0 failures. Every phase the store writes, the crash-settle interrupted path, and a
  disagreeing pair in an older run failing the read.
- `bun run verify:aooo server/tests/local-runtime-browser-reconnect.integration.test.ts` —
  1 test, 32 assertions, 0 failures, three consecutive green runs (two by the implementer, one by
  the coordinator). Evidence per run in `.logs/aooo/verify-*/` holds `browser-reconnect.json` and
  the five screenshots.
- `bun run verify:aooo server/tests/local-runtime-store.integration.test.ts` and
  `server/tests/local-runtime-http.integration.test.ts` — 9/68 and 1/94, 0 failures, the unit 5
  regressions.
- `bun test` on the touched app suites — the projection test 4/19, the status strip suite 8/21, the
  importing batch 174 tests 787 assertions, all 0 failures.
- `bun test scripts/` — 117 tests, 700 assertions, 0 failures; `bash -n scripts/start.sh` clean.
- `bun test` under `desktop/` — 192 tests, 950 assertions, 0 failures; `tsc --noEmit` clean.
- Root `bun run typecheck` — clean after every step. `bun scripts/typecheck-tests.ts` — no new
  error against the 240-error baseline after every step.
- `biome check` on every touched file — clean. The one assist finding in `channel-chat.tsx`
  (import ordering) was verified against HEAD to predate this unit and was left untouched.

## Known deviations and open facts

- Bun 1.4.4 against the project's pinned 1.4.3, the same tolerated deviation the unit 5 record
  carries.
- A stale local dev stack from 2026-11-20 was still running on this machine at review time; it
  predates the product marker, so the desktop gate and start.sh correctly refuse it until it is
  restarted. The closing session must restart it before the live checks.
- The status strip reads the thread on mount and polls only while a run is live, so a page left open
  across a failure surfaces the failed strip on its next read, not at the moment the run fails. The
  feature map records this as a gotcha.
- The live end-to-end facts deferred to the closing session by the operator's instruction: a human
  `OPENBOT_RUNTIME_MODE=local bash scripts/start.sh` against the dev database printing the local mode
  line, the same script without the override still printing the licence line, the desktop window
  actually opening under `bun run tauri dev`, and the workbench page loading in it.
- The full repository suite was not run; its 11 known failures are in files this unit did not
  touch, per the unit 5 record.
- No real model and no real Notion were called; those are unit 7's live acceptance.
- Issue #4 was closed as completed with the fix commit and the checks above, and the live
  confirmation listed as open until the closing session.
