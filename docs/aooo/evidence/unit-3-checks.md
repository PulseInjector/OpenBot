# Unit 3: Local persistence and thread execution coordination

Checked on 2026-11-18 on `feat/local-bot-workbench`, after unit 2 at `b3382d79`.
The implementation commit contains this report and `unit-3-evidence.json`.

## Environment and scope

- macOS; Bun 1.4.4 (the repository pins 1.4.3; exact pinned-runtime parity was not checked).
- Isolated local PostgreSQL 17.9, loopback port 56432, database `openbot_test`. Six local runtime
  tables were applied by the repository migration runner. The application database was not used.
- The committed migration is generated from the Drizzle schema. Re-running generation after the
  change reported no schema changes.
- Tests use the real PostgreSQL database and store transactions. They cover concurrent request
  deduplication, persistent event/message history across store instances, exclusive lease claims,
  expired-generation fencing, and durable operation intent, dispatch, and settlement.
- No server restart or live tool dispatch was run. The fresh store instance checks database-backed
  history persistence; the operation test verifies the stored dispatch boundary and result.

## Observed results

| Scenario | Observation |
| --- | --- |
| Two concurrent submissions with one thread/key/hash | One run ID; one submission reports `created: true`; one run and one queued event are stored. |
| Event and message projection | Sequences 1-4 are `run.queued`, `attempt.started`, and two `message.upsert` events. The projection contains the final content at sequence 4 when read through a new store instance. |
| Competing workers | One lease claim succeeds while the other is rejected. After expiry, generation 2 takes over generation 1. |
| Expired worker | Its event append and operation intent are rejected after generation 2 is current. |
| Current worker operation and run completion | Sequences 4-7 are `operation.intent`, `operation.dispatched`, `operation.succeeded`, and `attempt.succeeded`; the operation result and terminal run/attempt states are readable from history. |

The evidence JSON records the asserted event sequences and lifecycle outcomes. Test rows are removed
after each run. The local PostgreSQL cluster and raw logs are not committed.

## Actual checks

| Command / check | Result |
| --- | --- |
| `DATABASE_URL=... bun run --cwd server db:migrate` | Passed against the isolated database. |
| `DATABASE_URL=... bun run --cwd server db:generate --name local_runtime_verify` | Passed; no schema changes. |
| `TEST_DATABASE_URL=... bun test server/tests/local-runtime-store.integration.test.ts` | 3 passed, 24 assertions. |
| `bun run typecheck` | Passed for shared, toolkit, worker, server, and app. |
| `TEST_DATABASE_URL=... bun run typecheck:tests` | Clean against baseline (240 known errors). |
| `bun test server/tests/schema.test.ts server/tests/migration-journal.test.ts` | 21 passed, 46 assertions. |
| `bunx biome check` on changed TypeScript/schema/config files | Passed. |
| `git diff --check` | Passed. |

The full repository test suite, build, live server restart, and external tool invocation were not run.

## Reproduction

Point `TEST_DATABASE_URL` and `DATABASE_URL` at an isolated database migrated through this branch;
keep credentials outside tracked files. From the repository root:

~~~sh
DATABASE_URL="$AOOO_UNIT3_DB_URL" bun run --cwd server db:migrate
DATABASE_URL="$AOOO_UNIT3_DB_URL" bun run --cwd server db:generate --name local_runtime_verify
TEST_DATABASE_URL="$AOOO_UNIT3_DB_URL" bun test server/tests/local-runtime-store.integration.test.ts
bun run typecheck
TEST_DATABASE_URL="$AOOO_UNIT3_DB_URL" bun run typecheck:tests
bun test server/tests/schema.test.ts server/tests/migration-journal.test.ts
~~~
