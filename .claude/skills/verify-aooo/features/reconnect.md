# Reconnect the original work

After the user closes or refreshes the conversation, the original run remains the same work and can be reopened without dispatching it twice. A crash mid-run settles to an interrupt at read time, and a normal restart keeps the history readable.

## Sub-features

- `close-reopen`: close the conversation during a run and reopen the same thread.
- `refresh`: reload the open conversation during a run and keep the same work.
- `service-restart`: restart the service normally and recover the same history and artifacts.
- `crash-interrupt`: a killed service shows an interrupt with its reason, and nothing restarts on its own.
- `visible-state`: show the original run state, failure reason, history, and artifacts in the conversation.
- `desktop-local`: connect the macOS development shell to local mode.

## How to get to it (user POV)

- Start a run from its Bot conversation in the browser: open the conversation, type into the "Ask anything" composer, and press Enter.
- Close or refresh that conversation, then reopen the original thread's URL.
- Restart the development server and reopen the same thread.
- Open the same local service from the macOS desktop development shell.

## Driving it with verify-aooo

Preconditions:

- Bun dependencies are installed, including the generated `app/src/lib/generated/application-config.ts`, and PostgreSQL 17 tools (`initdb`, `pg_ctl`, `createdb`, `psql`) are on `PATH`. Google Chrome (or Edge) must be installed: the journey drives a real system browser through the repository's existing `playwright-core` dependency.
- The repository root is the current directory. No `.env`, shared app port, development database, or external credential is used.

- **Browser journey.** Run `bun run verify:aooo server/tests/local-runtime-browser-reconnect.integration.test.ts`. It starts one production server at a time (replacing it for the restart and crash phases) and one Vite dev server for the app, both on fresh ports against the isolated database, mints the owner session with the same helper the unit 5 journey uses, injects the cookie into a real browser, and drives the channel conversation through its own composer. `cases.xml` must show one passed test and zero skips/failures.
- **Verify the observations.** Open `browser-reconnect.json`: `closeReopen` and `refresh` must each report one run and one `run.queued` event, `serviceRestart` a readable run from the replacement server, `crashInterrupt` a cancelled run with one interrupted attempt and no new attempt after the settle, and `visibleFailure` the stored reason on the strip. The screenshots `close-reopen.png`, `refresh.png`, `service-restart.png`, `crash-interrupt.png`, and `visible-failed.png` must be present in the same evidence directory.
- **Prerequisite contract only.** `bun run verify:aooo server/tests/local-runtime-http.integration.test.ts` checks server-side replay and does not close a browser tab or restart a service. Record it only as prerequisite evidence, never as `close-reopen`, `refresh`, `service-restart`, or `crash-interrupt` acceptance.
- **Desktop procedure (human-driven).** No automated driver exists for the macOS shell; WKWebView automation is out of scope. Run `OPENBOT_RUNTIME_MODE=local bash scripts/start.sh` and `bun run tauri dev` under `desktop/`, click **Connect to a local workbench** on the wizard's welcome screen with the prefilled `http://localhost:3010` address, and record screenshots of the local window showing the original thread plus the run event record showing the desktop telemetry marker. Until a driver exists, report `desktop-local` as not run and name this missing driver; do not infer it from the browser journey or a passing health endpoint.

## Gotchas

- The browser journey owns every process handle it starts and uses fresh ports; never point it at the shared development app, and never close, restart, or stop the shared development stack to reproduce its phases.
- A crash shows an interrupt in this unit; automatic recovery is later scope and must not be claimed. The journey asserts no new attempt starts after the settle.
- The status strip reads the thread on mount and polls only while a run is live, so a page left open across a failure surfaces the failed strip on its next read, not at the moment the run fails.
