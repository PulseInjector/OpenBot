---
name: verify-aooo
description: Run isolated acceptance tests for the aooo bot stage-one local workbench and prepare repeatable checks for later units; use when implementing or verifying work in docs/aooo/plan.md.
---

# Verify aooo bot

Use this skill to reuse the stage-one verification setup. The plan remains the authority for what a unit must prove. This skill owns only the repeatable test environment, run record, and cleanup; it does not turn one unit's fixture test into another unit's acceptance.

## Launch

Prerequisites: macOS/Linux, Python 3, Bun (root package pin 1.4.3; `bun install --frozen-lockfile`), PostgreSQL 17 tools and the matching pgvector extension. Run as a non-root user. From the repository root, run the existing acceptance case or one targeted integration test:

```sh
bun run verify:aooo
bun run verify:aooo server/tests/bot-creation-retry.integration.test.ts
```

The default is `server/tests/local-runtime-http.integration.test.ts`. The runner uses the checked-out Bun install and system `initdb`, `pg_ctl`, `createdb`, and `psql`. It creates a fresh PostgreSQL cluster and database, applies the checked-out migrations, then runs exactly one `.test.ts` file. It does not read `.env`, start `scripts/start.sh`, use Docker, or bind the app's documented ports. It fails closed if its selected test is skipped, empty, or failing. Process-group cleanup uses Unix signals; Windows is not supported.

Readiness means the isolated database identity and migrations passed, then the selected test's own HTTP readiness checks passed. A successful process start alone is not readiness.

## Doctor

The runner's read-only doctor records the Bun/PostgreSQL versions and revision, confirms the TCP database resolves to the temporary cluster's exact data directory, and checks the target database plus `local_runs` and migration journal before running the test. Inspect `doctor.txt` and `result.json` in the printed evidence directory. If setup or doctor fails, the selected journey is reported as not run; do not point it at the development database to get past the failure.

## Drive

Read the [feature map](features/README.md) first. For the default case, the authenticated owner submits to `/api/copilotkit/agent/:agentId/run`, reconnects with `connect`, reads `/api/local-runtime/threads/:threadId/history` and `/events`, and stops a second in-flight run. The test uses the fixture model and MCP server at the provider boundaries; it exercises the production server, auth, runtime, database, and operation recorder. It does not exercise the browser chat UI or a real model/provider.

The runner accepts one repository-local `.test.ts` path:

```sh
bun run verify:aooo server/tests/local-runtime-store.integration.test.ts
```

For the next unit, add its ordinary Bun journey and pass its path; no registry or runner edit is needed. `TEST_DATABASE_URL` and `DATABASE_URL` point at the same disposable DB for the entire test, including service restarts. Write observations before fixture teardown into `AOOO_EVIDENCE_DIR`. The test owns the browser/profile and services it starts, must use fresh ports, and must assert the behavior in `docs/aooo/plan.md`. Do not add a test-only route to make a journey pass. This runner is for trusted local tests, not a network sandbox or a way of passing live credentials.

Live acceptance (a real model, a real connector) runs separately on the shared development stack, and the lifecycle rules differ from this runner's: nothing in a live drive may stop, restart, or kill the shared stack — a restart after an `.env` change is an attributed PID kill plus start, because the start/stop scripts reuse or leave alone what they cannot attribute. The live drive's doctor is the target's own preflight (`bun scripts/aooo/notion-preflight.ts --bot <agentId>`, exit 0) plus the stack's capabilities probe, run before judging anything. The drive owns only the browser session it opened and closes that session when done; the evidence it saves is deliberately untracked (`.local/`, raw logs in `.logs/`) and survives by staying out of the repository, never by committing credentials. The machine-drive recipe, including identity, close-timing, and reset specifics, is in [features/notion-workbench.md](features/notion-workbench.md); the human procedure there stays the authority for what a live run must mean.

## Evidence

Each run prints a unique `.logs/aooo/verify-<id>/` directory. It contains `result.json`, the read-only `doctor.txt`, Bun JUnit `cases.xml`, `setup.log`, `drive.log`, and PostgreSQL/service logs. The default runtime test also writes `replay-stop.json` with run IDs, terminal states, the recorded operation state, event counts, and fixture tool-call count; it contains no cookies, prompt bodies, or credentials. Keep evidence after teardown and link its directory from the relevant check record in `docs/aooo/evidence/`.

Proof standards:

- Keep pass, failure, skip, and not-run distinct. The command exits nonzero if the chosen file silently skips.
- Preserve both the action and resulting state. For mutations, verify the stored row or external artifact, not only the response.
- Fixture-model and fixture-MCP evidence proves local runtime behavior only. It never proves a live model, browser takeover, or Notion write.
- For real Notion acceptance, use only the independent page and fixed materials in `tests/fixtures/aooo/`, after confirming the page URL and access. Follow the live procedure in that fixture's README and read back the page. Do not write to the plan or another production page.
- Never put secrets or personal data in tracked evidence. Raw logs remain under ignored `.logs/aooo/`.

## Cleanup

The runner owns and automatically stops its PostgreSQL postmaster, test process group, private data directory, and socket directory on success, failure, timeout, and interrupt. Evidence is outside those temporary directories and survives cleanup. If `result.json` says cleanup failed, inspect that run's `postgres.log`; stop only the postmaster whose data directory is the printed run's `/tmp/aooo-pg-*`. Never stop a process by name, and never run the repository's shared-stack stop command as cleanup for this harness.

## Helpers

The executable helper is `scripts/verify-aooo`; run it through `bun run verify:aooo [test-path]`. The default test can also be run directly with `bun test`, but doing so skips the isolated database, migration, doctor, JUnit, evidence, and guaranteed cleanup workflow.

## Why this design

The existing Unit 5 HTTP test already owns its two server processes, fixture model, and MCP fixture. A one-shot wrapper owns only PostgreSQL, migration, the test process, and evidence. A persistent stack would add ports, stale-state handling, and leaked-process risk without helping this test. Unit 6's browser journey exists at `server/tests/local-runtime-browser-reconnect.integration.test.ts`; it is registered in the feature map with its evidence outputs, and it reuses this runner for its isolated database. Unit 7's real Notion write remains explicit live acceptance.

For ongoing map maintenance after routes or journeys change, use `/maintain-verification-skill`.
