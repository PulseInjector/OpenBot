# Repeatable local verification harness

Checked on 2026-11-20 on `feat/local-bot-workbench` at revision `382c9268cca632920916d61660b6385b93607d7a` (working tree contained this harness change). This adds a reusable shell around existing Bun acceptance cases; it does not complete a delivery-plan unit.

## Reusable steps

`bun run verify:aooo [repository-relative-test.ts]` creates a fresh PostgreSQL 17 cluster with a private socket and randomly selected loopback port, confirms the endpoint belongs to that cluster, applies the checked-out migrations, sets both `DATABASE_URL` and `TEST_DATABASE_URL` to the disposable database, and runs one Bun test file with the JUnit reporter. It retains logs and test output in a unique ignored `.logs/aooo/verify-<id>/` directory and tears down only the test process group and cluster it created. It never reads `.env` or calls `scripts/start.sh`.

The existing tests still own their assertions and fixtures. `server/tests/local-runtime-http.integration.test.ts` additionally records a sanitized `replay-stop.json` when the runner provides `AOOO_EVIDENCE_DIR`. It checks the local runtime capability and authenticated `/api/me` as part of readiness. `server/tests/bot-creation-retry.integration.test.ts` already writes its row/count observations to `AOOO_CREATION_EVIDENCE`.

## Checks run

| Check | Result |
| --- | --- |
| `bun run verify:aooo` | Passed: 1 test, 94 assertions, 0 skipped. Isolated PostgreSQL setup, migrations, HTTP run/replay/Stop journey, and cleanup passed. |
| `bun run verify:aooo server/tests/bot-creation-retry.integration.test.ts` | Passed: 6 tests, 27 assertions, 0 skipped. |
| `bun run verify:aooo tests/smoke/journey.test.ts` | Correctly returned nonzero with `drive: not run`: Bun reported 5 skipped tests because `OPENBOT_SMOKE` was unset. Setup and cleanup passed. This confirms skipped tests cannot be reported as a pass. |
| `bun run typecheck` | Passed for all workspaces. |
| `bun run typecheck:tests` | Clean against the recorded 240-error baseline. |
| `bunx biome check package.json server/tests/local-runtime-http.integration.test.ts` | Passed. |
| `python3 -m py_compile scripts/verify-aooo` | Passed. |
| `git diff --check` | Passed. |

Runtime: Bun 1.4.4; PostgreSQL 17.9. The root package pins Bun 1.4.3, so exact version parity was not checked. No live model, browser chat, computer, Notion, or external business write was used. The HTTP fixture journey proves only the existing server/API behavior; the unit 6 browser/desktop reconnect and unit 7 live Notion outcomes remain unverified.

Raw output from the final default pass is in `.logs/aooo/verify-qm3sqkg1/`; creation retry in `.logs/aooo/verify-ybmek4_x/`; the all-skipped guard check in `.logs/aooo/verify-czrmllsk/`. Evidence survived teardown. The temporary PostgreSQL clusters were stopped and removed.
