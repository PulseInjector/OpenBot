# Unit 4: Tool operation records and stop boundary

Checked on 2026-11-18 on `feat/local-bot-workbench`, after unit 3 at `837209c6`.
The implementation commits are recorded in `unit-4-evidence.json` after the code commits.

## Environment and scope

- macOS; Bun 1.4.4 (the repository pins 1.4.3; exact pinned-runtime parity was not checked).
- Isolated PostgreSQL 17 test cluster under ignored `.logs/aooo/unit4/postgres`, loopback port
  56432, database `openbot_test`. The running development database on port 55432 was not used.
- The generated migration adds `local_attempts.stop_requested`; operation records reuse the unit 3
  table and append-only per-thread event sequence.
- Built-in tool execution and headless tool execution accept the same operation recorder. The
  local-runtime adapter binds that recorder to one trusted actor and execution token. Authorization
  is checked before recording and again immediately before the dispatch transaction.
- The current server runtime does not yet supply this recorder by default. The local-runner call site
  is part of work unit 5; this unit verifies the shared execution boundary and its real PostgreSQL
  adapter independently. No claim is made that existing live runs now persist into local history.
- Calling the recorder's `stop()` persists the stop gate first, rejects further operations, and
  waits for already-dispatched calls to persist a result or `unknown` before returning.

## Observed results

| Scenario | Observation |
| --- | --- |
| Partial arguments | Missing call ID, non-object parameters, and schema validation failure reject before intent or dispatch. |
| Two operations with stop between them | First result persists; stop is recorded; second call is refused before intent; the first attempt ends interrupted. |
| Parallel calls | Each call has its own intent, dispatch marker, and settlement. |
| In-flight timeout and late result | Operation records `unknown` at the settlement deadline, then records a late successful receipt against that same operation ID. |
| Disconnected tool rejection | Dispatched operation records `unknown` with a reason; it is not reported as a confirmed external failure. |
| Lease/stop fencing | A stopped attempt cannot create or dispatch a new operation. A result for an already-dispatched operation can still be appended after stop and before attempt termination. |

The integration timeline for the stop case is `run.queued`, `attempt.started`,
`operation.intent`, `operation.dispatched`, `attempt.stop_requested`, `operation.succeeded`,
`attempt.interrupted`. The adapter integration checks that the stored operation includes the full
validated parameters, actor-bound authorization runs twice, and the result is committed before
the adapter returns it.

## Actual checks

| Command / check | Result |
| --- | --- |
| `DATABASE_URL=... bun run --cwd server db:migrate` | Passed on the isolated PostgreSQL database. |
| `DATABASE_URL=... bun run --cwd server db:generate --name verify_unit4` | Passed; no schema changes after generating migration 0069. |
| `TEST_DATABASE_URL=... bun test server/tests/local-runtime-store.integration.test.ts` | 5 passed, 35 assertions. |
| `TEST_DATABASE_URL=... bun test toolkit/tests/tool-operation.test.ts server/tests/headless-tools.test.ts server/tests/local-runtime-store.integration.test.ts server/tests/schema.test.ts server/tests/migration-journal.test.ts` | 42 passed, 160 assertions. |
| `bun run typecheck` | Passed for shared, toolkit, worker, server, and app. |
| `TEST_DATABASE_URL=... bun run typecheck:tests` | Clean against baseline (240 known errors). |
| `bunx biome check` on changed TypeScript/schema/config files | Passed. |
| `git diff --check` | Passed. |

No live model call, business-document write, or external tool invocation was run. The implementation
plan Notion page was updated with this completion record. A tool's resolved return value is a durable
tool result, not proof that a remote document reached the intended final state. The
external effect remains unverified until a read-back or a service-specific receipt is checked. A
dispatch with no verifiable return is recorded as `unknown` and must not be replayed automatically.
The timeout/late-result and disconnect cases use controlled adapters, not a claim about a live
provider's behavior.

## Reproduction

Use an isolated database migrated through this branch and keep credentials out of tracked files.
From the repository root:

~~~sh
DATABASE_URL="$AOOO_UNIT4_DB_URL" bun run --cwd server db:migrate
DATABASE_URL="$AOOO_UNIT4_DB_URL" bun run --cwd server db:generate --name verify_unit4
TEST_DATABASE_URL="$AOOO_UNIT4_DB_URL" bun test toolkit/tests/tool-operation.test.ts server/tests/headless-tools.test.ts server/tests/local-runtime-store.integration.test.ts server/tests/schema.test.ts server/tests/migration-journal.test.ts
bun run typecheck
TEST_DATABASE_URL="$AOOO_UNIT4_DB_URL" bun run typecheck:tests
~~~
