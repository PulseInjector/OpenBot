# Unit 5: Local runtime backend, authentication and history stream

Checked on 2026-11-20 on `feat/local-bot-workbench`, after unit 4. The implementation commit is
`df3777ac`.

## What the implementation preserves

These are the design decisions the unit had to keep, and the reason the code reads the way it does.

**Client and database run IDs stay separate.** The CopilotKit `RunAgentInput.runId` is the client run
ID and maps to `local_runs.request_key`; `local_runs.id` remains the internal primary key. Attempts
and execution tokens use internal IDs. A Stop request resolves by authenticated actor, Bot, thread
and client run ID in one store operation, and stops only that run's current, unexpired attempt — it
never falls back to whichever run is active on the thread.

**The existing authorization boundary is unchanged.** Actor identity comes from the authenticated
session and Bot identity from the matched route. No user identity is accepted from a request body,
forwarded parameter or ordinary header. Binding owner and Bot permission are checked before
returning history, events or run state. The existing Agent resolver, tool grants, validation,
approval and audit path stay in place.

**Ordinary chat replays from complete history.** The pinned CopilotKit `connect` path clears client
state and carries no durable applied-event cursor, so ordinary chat reconnects are never sent a
suffix. The thread's complete event history is replayed for them; sequence-based reads are kept for
consumers that already hold the prefix, and a consumer advances its cursor only after applying an
event. Each event page and its replay boundary come from one consistent database view, and the
stream closes only after reaching the boundary for the run or thread observed at connection start.
It does not follow a run that starts later.

**The configured Agent lifecycle is preserved.** The Agent instance CopilotKit prepares for the
request is used as-is through the public `runAgent` lifecycle, so its `.use()` middleware and
configured callbacks run. The tool-operation recorder is bound to the claimed execution attempt
rather than to process-global mutable state, and an admitted operation is registered before awaiting
dispatch so Stop cannot miss an in-flight tool call.


## Environment and scope

- macOS; Bun 1.4.4 (the repository pins 1.4.3; exact pinned-runtime parity was not checked).
- A freshly initialised, isolated PostgreSQL 17.9 cluster (Homebrew) outside the repository,
  loopback port 56501, database `openbot_test`, role `openbot`. The development database was not
  used. The cluster needed `LC_ALL=C` at startup; without it the postmaster aborts with
  "postmaster became multithreaded during startup".
- Migrations applied to that database: `{"type":"migrations-applied","status":"ok"}`.
- Two real server processes were spawned by the acceptance test itself on
  `OPENBOT_RUNTIME_MODE=local` with no Intelligence URL, key or licence configured, and with a
  fixture model and fixture MCP server. Ports 59351 and 59352.
- No real model, real Notion connection or external business tool was invoked. The model and MCP
  server are in-process fixtures. Nothing here claims a live provider's behaviour.

## Acceptance checklist

Every required item, with where it was checked.

| # | Item | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Anonymous callers cannot run, connect, stop, or read history or events. | Passed | `local-runtime-http.integration.test.ts`: all five routes answer 401 with only a forwarded `x-user-id` header and no session cookie. |
| 2 | A caller without permission for the Bot or thread cannot read or change its runtime state. | Passed | Same test: a non-owning authenticated actor gets 404 for history, events, run, connect and stop; a private Bot cannot be run by a peer; a public Bot's run for a thread owned by that peer is still refused. |
| 3 | Same client run ID and same request hash returns the existing run without a second execution. | Passed | `local-runtime-store.integration.test.ts`: concurrent identical submissions create one durable run. HTTP test: the identical repeat returns the same events and the fixture tool-call count does not change. |
| 4 | Same client run ID with a different request hash is rejected. | Passed | Store test rejects with `LocalRuntimeConflictError`; HTTP test receives a `LOCAL_RUN_CONFLICT` run error. |
| 5 | Stop targets the client run ID's active attempt and never falls back to the current thread run. | Passed | Store tests: an expired attempt cannot be stopped even with its exact client run ID; only the current client run ID on the owned Bot thread can request Stop. HTTP test: `{}`, a finished run's ID, the internal run ID and a missing ID all answer `stopped: false` while another run is active. |
| 6 | Event pages are ordered, exclusive of the supplied sequence, and scoped to the authorized actor, Bot, and thread. | Passed | `local-runtime.test.ts`: the cursor is validated before reading and only events after it are returned. HTTP test pages by sequence with `limit=3` and reconstructs the full ordered sequence. |
| 7 | Ordinary chat reconnect rebuilds state from complete history. | Passed | `local-runtime-sdk.test.ts` (ordinary local chat resets state on restore and reconstructs it via the existing connect route); `local-runtime.test.ts` (ordinary connect replays from zero even when a sequence header is present). |
| 8 | Incremental readers advance their cursor only after applying events and do not miss committed events across processes. | Passed | `local-runtime-store.integration.test.ts`: a reader follows only the observed run through commits written by a separate process; a completed run replays every event across multiple history pages. |
| 9 | Replay closes only after reading the durable terminal boundary for the observed run or thread. | Passed | Store test asserts `more: true, terminal: false` before the boundary, then completion; the HTTP reconnect closes with the observed run's `STOPPED` error and does not follow a later run. |
| 10 | The CopilotKit-configured Agent runs through its public lifecycle, including middleware. | Passed | `local-runtime-sdk.test.ts`: the runtime-prepared Agent runs its middleware and configured callbacks through `runAgent`. |
| 11 | Existing tool authorization and approval rules remain in force. | Passed | HTTP test: a granted tool executes and is audited; an `ask` rule suspends the run and creates exactly one approval request; revoking the grant during a run produces `mcp.call_rejected` and the tool never executes. |
| 12 | Tool records are attempt-scoped, including in-flight Stop and late results. | Passed | Store tests: stop closes operation admission while a dispatched late result still settles; configured Agents isolate tool operations across overlapping runs and Stop fences late results. HTTP test ends with a `cancelled` run whose operation settled `succeeded`. |
| 13 | The real local HTTP acceptance passes with no Intelligence credentials. | Passed | Two-process run above; neither service had any `INTELLIGENCE_*` variable and both logged `OpenBot server listening on http://127.0.0.1:<port>`. |
| 14 | Relevant tests, typecheck, and `git diff --check` pass. | Passed with the fix in place; the fix was later reverted, so the gate shows one open error | See below. |
| 15 | The acceptance record contains commands, results, and sanitized log locations. | Passed | This file. |

## A failure this run found, and its follow-up fix

The unit 5 closeout run on 2026-11-19 recorded `bun run typecheck:tests` as failing with one new
error that had not been in the baseline:

```
server/tests/config.test.ts: error TS2339: Property 'intelligence' does not exist on type 'RuntimeCapabilities'. (line 63)
```

The completion record written at the time did not mention it. Our own commit `4142b8da` caused it:
making `RuntimeCapabilities` a union of the `intelligence` and `local` shapes broke a direct read of
`config.runtime.intelligence` in upstream test code. The closeout run fixed it by narrowing with
`if (config.runtime.mode !== "intelligence")`, the same pattern the file already uses in two other
places, and with that fix in place the gate was clean against its 240 known baseline errors.

On 2026-11-20 the doc-migration task reverted that fix to keep its own changes free of code. The
error was present again and open until a follow-up code task landed the same 3-line narrowing. The
revert changed no runtime behavior: the tests still pass when run, because the mode in that test is
`intelligence` either way.

On 2026-11-20 that follow-up landed (issue #3): the narrowing guard was re-added at
`server/tests/config.test.ts:63`, matching the pattern the file uses at lines 145 and 160.
`bun run typecheck:tests` is clean against the 240-error baseline, and
`bun test server/tests/config.test.ts` passes 144 tests.

## Actual checks

Run from the repository root with `TEST_DATABASE_URL` pointing at the isolated database above.

| Check | Result |
| --- | --- |
| `DATABASE_URL=… bun run --cwd server db:migrate` | `{"type":"migrations-applied","status":"ok"}` |
| Targeted suite (11 files, below) | 211 pass, 0 fail, 524 assertions |
| `bun run typecheck` | All five workspaces exit 0 |
| `bun run typecheck:tests` | Clean against the 240-error baseline with the fix in place; 1 new open error after the fix was reverted |
| `git diff --check` | Clean |
| Full repository suite | 8562 pass, 80 skip, 11 fail — failures are outside this unit, see below |

The targeted suite was:

```sh
bun test \
  server/tests/local-runtime.test.ts \
  server/tests/local-runtime-sdk.test.ts \
  server/tests/local-runtime-http.integration.test.ts \
  server/tests/local-runtime-store.integration.test.ts \
  toolkit/tests/tool-operation.test.ts \
  server/tests/config.test.ts \
  server/tests/schema.test.ts \
  server/tests/migration-journal.test.ts \
  server/tests/headless-tools.test.ts \
  server/tests/server-side-tools.integration.test.ts \
  server/tests/agent-resolver.test.ts
```

### The full-suite failures

The full suite was run once for information, not as a unit 5 gate. Its 11 failures are in files this
branch never changed, and each has an environment or packaging cause rather than a behavioural one:

- `tests/agent-bot.test.ts` (3): the `agent-bot` workspace cannot resolve `@ag-ui/encoder`.
- `agent-langgraph/tests` (2): cannot resolve `@langchain/anthropic` or `@ag-ui/core`; two further
  tests there time out at 10 s against a real provider with no network.
- `agent-computer/tests/egress-connect.test.ts` (1): a connection-timeout assertion.
- One connector test: `composio: 503 Service Unavailable`, and an owner-Allow test that depends on
  it.
- 3 suite-level errors: `the database is unreachable` for tests that read `DATABASE_URL` directly
  rather than `TEST_DATABASE_URL`.

None of them touches the local runtime, authentication, replay or tool recording.

## What this does not prove

- No real model, so nothing here shows how a live provider behaves under Stop or reconnect.
- No real Notion or external tool, so no external document state was verified. A tool's resolved
  return value is a durable tool result, not proof that a remote document reached its final state.
- Bun 1.4.4 was used, not the pinned 1.4.3.
- The earlier Stop-timing failure from the 2026-11-19 run did not recur in this run either. Its
  cause is still unconfirmed. The evidence for that investigation, including what the logs can and
  cannot distinguish, is in the local retrospective and is not reproduced here.

## Reproduction

```sh
initdb -D "$AOOO_UNIT5_PG" -U openbot --encoding=UTF8 --locale=C
LC_ALL=C pg_ctl -D "$AOOO_UNIT5_PG" -l "$AOOO_UNIT5_POSTGRES_LOG" \
  -o "-p 56501 -k $AOOO_UNIT5_SOCK -c listen_addresses=127.0.0.1" start
createdb -h 127.0.0.1 -p 56501 -U openbot openbot_test

export TEST_DATABASE_URL="postgres://openbot@127.0.0.1:56501/openbot_test"
DATABASE_URL="$TEST_DATABASE_URL" bun run --cwd server db:migrate
UNIT5_LOG_DIR="$AOOO_UNIT5_LOGS" bun test server/tests/local-runtime.test.ts …
```

`UNIT5_LOG_DIR` makes the HTTP test write each spawned service's stdout and stderr there. Leave it
unset to discard them.
