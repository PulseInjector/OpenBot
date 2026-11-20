# Local runtime run and history

The local runtime accepts authenticated work, records ordered history, prevents duplicate execution, and stops work at the tool boundary.

## Sub-features

- `run-once`: one client run ID produces one durable result.
- `auth-scope`: untrusted identity headers and another owner's session cannot read or run the thread.
- `stop-replay`: reconnect sees the original event history and Stop settles an already-dispatched operation without admitting another one.

## How to get to it (user POV)

- In the product, choose a Bot and send it a message in its conversation. This journey's test calls the same production run/connect/stop routes used by the chat client, with a fixture model at the model boundary.
- Read the original conversation's history and events from the authenticated owner session.

## Driving it with verify-aooo

Preconditions:

- Bun dependencies are installed and PostgreSQL 17 tools (`initdb`, `pg_ctl`, `createdb`, `psql`) are on `PATH`.
- The repository root is the current directory. No `.env`, shared app port, development database, or external credential is used.

- **Run and replay.** Run `bun run verify:aooo`. The target is `server/tests/local-runtime-http.integration.test.ts`; it starts two production server processes against a fixture-backed isolated PostgreSQL database and calls the authenticated run/connect/history/events/stop routes. `cases.xml` must show one passed test and zero skips/failures. `replay-stop.json` must show the first run succeeded, the second run was stopped after dispatch, and both original and reconnect event counts are present.
- **Verify side effects.** Open `replay-stop.json` and confirm the fixture tool-call count is two: one successful call and one in-flight call that settles after Stop. The run/operation states in that file must agree with the test output. `drive.log` contains the action-level test result; raw service logs stay in the same evidence directory.
- **Verify isolation and cleanup.** `doctor.txt` must identify `openbot_test`, the local runtime table, and migration journal in the temporary cluster. `result.json` must report setup, drive, and cleanup as passed. The evidence directory still exists after the PostgreSQL cluster and spawned services have stopped.

## Gotchas

- This proves the local server/API contract with a fixture model and fixture MCP service. It does not prove a browser UI journey, a real provider/model, Notion, or stage-one work unit 7.
- A run that is skipped, empty, fails, or cannot migrate is not a pass. Keep setup/drive/cleanup statuses separate.
- Do not use `scripts/start.sh` for this check; it targets the shared development stack and its configured ports.
