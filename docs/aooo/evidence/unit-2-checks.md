# Unit 2: Bot creation and authorization retries

Checked on 2026-11-18 on feat/local-bot-workbench, starting from 50bf5e17; depends on
unit 1 (b9b58ed0). The implementation commit contains this report and unit-2-evidence.json.
Find its exact commit with git log -- docs/aooo/evidence/unit-2-checks.md; the completion
record in the implementation plan also records the pushed commit.

## Environment and scope

- macOS; installed Bun 1.4.4 (the repository pins 1.4.3; exact pinned-runtime parity was not checked).
- Real isolated PostgreSQL 17.12 with pgvector, Docker container aooo-unit2-postgres,
  loopback port 55439, database aooo_unit2_test. The existing development database was not used.
- Generated migrations 0066 and 0067 applied successfully; reapplying also exited 0.
- UI tests use Happy DOM and controlled HTTP responses. Database suites exercise the real stores,
  Hono routes, transactions, grants, and migration schema. No live model, external app invocation,
  independent Notion test-page update, browser visual check, or native desktop acceptance was run.

## Observed results

| Scenario | Before | After failure / first commit | After retry |
| --- | --- | --- | --- |
| Creation committed, response discarded | 0 matching Bots | 1 Bot | Same Bot; total 1, one request row |
| Six concurrent creates, one actor/key | Baseline Bot count | Six submissions | One additional Bot, one unique returned ID |
| Dedup insert forced to fail | 5 suite Bots | Still 5; no request row; no orphan profile | One Bot can then be created successfully |
| Changed title or confirmed permissions | Original Bot/request | Changed request | HTTP 409; original request row retained |
| App grant fails on LIST | No grants | FETCH only | FETCH and LIST; only LIST is written during retry |
| App directory grows before retry | Confirmed FETCH and LIST | NEW_READ becomes available | NEW_READ and SEND absent; expanded confirmation returns 409 |
| Grant commits, then throws | No grant | One persisted grant, HTTP 500 | Still one row; one grant call across both attempts |
| Conversation skill grant response lost | No skills | read-docs committed; check-facts failed | Fresh read; only check-facts retried; unrelated skill not included |

The schema also keeps creation keys consumed after Bot deletion. Tests cover different actors
using the same key, deleted originals, canonical ref order, keyed requests that omit explicit refs,
and malformed or ineligible grant confirmations. The manual sheet reuses its original body and
selected apps/refs across retries, even when the app directory changes. The transcript card reuses
its tool-call-derived request ID across remounts. Partial creation can be retried or explicitly kept
with its existing skills; it is never reported as declined after a known successful create.

Sanitized database observations are committed in unit-2-evidence.json. They are generated from
asserted database reads during the tests, not live business success metrics. Test rows are cleaned
up afterward. Raw local logs and JSON are ignored under .local/unit2/.

## Actual checks

| Command / check | Result | Local log |
| --- | --- | --- |
| Root bun run typecheck | Passed all five workspaces | .local/unit2/typecheck.log |
| bun run typecheck:tests | No new errors; 240 existing baseline errors unchanged | .local/unit2/typecheck-tests.log |
| UI and route tests below | 86 pass, 0 fail; 227 assertions | .local/unit2/ui-routes.log |
| Database tests below | 102 pass, 0 fail; 483 assertions | .local/unit2/database.log |
| Fixture, schema and migration tests below | 45 pass, 0 fail; 147 assertions | .local/unit2/schema-fixtures.log |
| Changed TypeScript files: Biome check and lint with error-on-warnings | Passed | .local/unit2/format-lint.log |
| git diff --check | Passed | .local/unit2/diff-check.log |
| Drizzle migration check | Passed | .local/unit2/migration-check.log |
| Drizzle db:generate after implementation | No schema changes | .local/unit2/migration-generate.log |
| db:migrate against the isolated database | Passed | .local/unit2/migrate.log |

Database error traces for the injected grant failures are expected: those requests assert HTTP 500,
then check the persisted grants and retry. One initial run failed because an existing giveable-app
response assertion did not include the new refs field; it was updated, and the final rerun passed.
The full repository suite and build were not run for this work unit.

## Reproduction

Install the locked dependencies and migrate an isolated test database. Set AOOO_UNIT2_DB_URL
locally to that database's URL; keep credentials outside tracked files. From the repository root:

~~~sh
DATABASE_URL="$AOOO_UNIT2_DB_URL" bun run --filter server db:migrate
bun run typecheck
bun run typecheck:tests
bun test server/tests/agent-routes.test.ts \
  app/tests/proposed-bot-card.test.tsx \
  app/tests/new-bot-sheet.test.tsx \
  app/tests/bot-creation-retry.test.tsx \
  app/tests/app-access-mutations.test.ts \
  app/tests/bot-access-your-apps.test.tsx
TEST_DATABASE_URL="$AOOO_UNIT2_DB_URL" \
AOOO_CREATION_EVIDENCE=.local/unit2/creation.json \
AOOO_GRANT_EVIDENCE=.local/unit2/grants.json \
bun test server/tests/bot-creation-retry.integration.test.ts \
  server/tests/agent-profile-store.integration.test.ts \
  server/tests/owner-app-grants.integration.test.ts \
  server/tests/app-access-routes.integration.test.ts
bun test tests/aooo-fixtures.test.ts \
  server/tests/schema.test.ts \
  server/tests/migration-journal.test.ts \
  server/tests/migration-reach.test.ts
~~~

Creation without a request ID remains supported for older/internal clients and has no deduplication
guarantee. The manual New Bot sheet retains its confirmation only while open; full-page reload or
closing the unfinished sheet starts a new manual flow. The conversation card's ID is durable in its
transcript tool call. These checks establish this work unit's retry behavior, not stage-one live
workbench or crash-recovery acceptance.
