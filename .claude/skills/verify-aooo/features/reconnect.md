# Reconnect the original work

After the user closes or refreshes the conversation, the original run remains the same work and can be reopened without dispatching it twice. This is planned in stage-one work unit 6 and is not yet verified by the current checkout's fixture journey.

## Sub-features

- `close-reopen`: close the conversation during a run and reopen the same thread.
- `service-restart`: restart the service normally and recover the same history and artifacts.
- `visible-state`: show the original run state, failure reason, history, and artifacts in the conversation.
- `desktop-local`: connect the macOS development shell to local mode.

## How to get to it (user POV)

- Start a run from its Bot conversation in the browser.
- Close or refresh that conversation, then reopen the original thread from the conversation list.
- Restart the development server and reopen the same thread.
- Open the same local service from the macOS desktop development shell.

## Driving it with verify-aooo

Preconditions:

- Work unit 6's browser and desktop driver exists and names its exact user-visible controls and evidence outputs.
- The driver uses an isolated database and service instance. The plan requires a browser/desktop operation record, reconnect checks, and history/artifact screenshots.

- **Prerequisite contract only.** Run `bun run verify:aooo server/tests/local-runtime-http.integration.test.ts`. This checks server-side replay and does not close a browser tab or restart a service. Record it only as prerequisite evidence, never as `close-reopen`, `service-restart`, or `desktop-local` acceptance.
- **Unit 6 acceptance.** Until a feature-specific browser/desktop journey is added, report these sub-features as not run and name the missing driver. Do not infer them from the fixture test or a passing health endpoint.

## Gotchas

- The existing work unit 5 test reconnects through HTTP while the fixture servers stay alive; it does not prove a page close, normal service restart, crash behavior, desktop startup, or visible artifacts.
- Never close, restart, or stop the shared development app. A unit 6 driver must use an isolated run ID, ports, database, and owned process handles.
- A crash shows an interrupt in work unit 6; automatic recovery is later scope and must not be claimed here.
