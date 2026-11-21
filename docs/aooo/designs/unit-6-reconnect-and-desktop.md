# Work unit 6 design: reconnect, run display, and the desktop dev entry

Status: design complete, not implemented. The unit's contract is the "Work unit 6" section of [plan.md](../../plan.md). This file holds the detailed design an implementing agent reads before starting. A decision-level change to the unit syncs back to plan.md in the same session it is made. A detail-level change stays here.

## Problem

Three verified gaps block the unit's acceptance today.

1. A crashed run never settles. `attempt.interrupted` is written only inside `finishAttempt` (`server/src/local-runtime/store.ts:891`), so a killed process leaves `local_runs.status = 'running'` forever. `openThreadReplay` selects runs by status `running` or `queued` (`store.ts:722-724`) and `readReplayPage` marks terminal only when the run row leaves those states (`store.ts:765`). A reconnecting client therefore follows a dead run forever and never sees an interrupt. The unit 5 record covers the stop-requested path, not a killed process.
2. The channel cannot restore its transcript in local mode. `readThreadMessages` calls the SDK REST endpoint (`app/src/lib/copilot/thread-messages.ts:190-193`), which 422s without `ɵsupportsLocalThreadEndpoints`. `LocalAgentRunner` never sets it. Meanwhile the server's own history routes (`server/src/local-runtime/routes.ts:20-73`) are complete and owner-checked but no client calls them. Two mechanisms exist and both are half-wired.
3. `scripts/start.sh` cannot start or verify a local stack. The identity probe greps `/api/copilotkit/info` for `"licenseStatus"` (`scripts/start.sh:160-161`) and stage 3 exits unless `licenseStatus === "valid"` (`scripts/start.sh:410-419`). The local runtime never emits that field (`server/src/config.ts:972-976`).

The desktop shell is an Intelligence installer (`desktop/src/App.tsx:241-243`) with no local entry. Nothing else in the stack blocks the unit.

## Usage

### The browser user

She starts the stack with `OPENBOT_RUNTIME_MODE=local bash scripts/start.sh`. Stage 3 prints the local mode line and the registered Bots instead of dying on a licence gate. She opens a channel conversation with her Bot and sends material. The composer shows the run as active. She closes the tab. Later she reopens the thread from the conversation list. The transcript is back, including the tool turns, and a status line above the composer reads `Run succeeded`. No second run was dispatched.

If the server was killed mid-run, the status line reads `Run was interrupted` with the stored reason, and the transcript keeps everything that had committed. If she restarts the dev server normally, the same thread still shows its full history.

### The desktop user

He runs `bun run tauri dev` under `desktop/`. The wizard welcome screen shows a second action beside the Intelligence path, `Connect to a local workbench`, with the app URL prefilled as `http://localhost:3010`. He clicks it. The shell checks `GET <url>/api/capabilities`, requires `{mode: "local", durableHistory: true}`, and opens a window loaded at the app. On anything else it shows the shell's existing failure display naming what answered instead. The Intelligence wizard is unchanged for Intelligence users.

## Shape

The design adds one store method, one client branch, one shared status module, one startup branch, and one desktop branch. It adds no table, no column, and no event type.

### Crash settlement

```ts
// server/src/local-runtime/store.ts
settleLapsedThreadWork(input: {
  threadId: string;
  actorId: string;
  agentId?: string;
}): Promise<Array<{ runId: string; attemptId: string }>
```

As built, the input takes an optional `agentId` rather than the full `ThreadScope`, because the `readHistory` caller at `server/src/copilot.ts:1810-1812` passes none and a required field would either fail the typecheck or silently skip settlement for that caller. `openThreadReplay` passes its full scope unchanged. The returned array holds one entry per interrupted attempt, so a zero-attempt orphan settles without an entry.

A run qualifies when its status is `running` or `queued` and it has no attempt with `status = 'running'` and `leaseUntil > now`. A queued run with zero attempts qualifies only when its `createdAt` is older than the lease window. The method runs in one write transaction that locks the binding row, using the existing `lockBinding` pattern (`store.ts:167-174`). For each qualifying run it sets lapsed running attempts to `interrupted` with an end reason naming the expired lease, sets the run to `cancelled`, and appends one `attempt.interrupted` event plus one `RUN_ERROR` event with `code = "STOPPED"`, mirroring the payload convention of `finishAttempt` (`store.ts:897-912`). The invariant holds that every terminal run has exactly one terminal `attempt.*` event whose type agrees with the derived state.

The method is idempotent. A second caller finds the run already settled and does nothing. Two replicas racing serialize on the binding lock. The lease window comes from one exported constant used by both the runner lease default (`server/src/local-runtime/runner.ts:109`) and this method, overridable by `OPENBOT_LOCAL_LEASE_MS` for the crash journey's speed. Automatic recovery stays out of scope, per plan.md line 73 and the reconnect evidence contract (`.claude/skills/verify-aooo/features/reconnect.md:33`). A settled run is never claimed again.

Call sites, exactly two. `openThreadReplay` calls the method before selecting the active run, so a reconnecting client never targets a dead run as live. `readHistory` calls it before its read-only transaction, so the history endpoint never reports a zombie run as running. `submit`'s idle-thread check (`store.ts:310-334`) already treats lapsed runs as idle and agrees without change. Nothing else may settle a run. No background reaper runs. The reader is the actor that needs the answer, so the reader triggers the settlement.

### Client history restore

```ts
// app/src/lib/copilot/thread-messages.ts
export async function readThreadMessages(threadId, agentId, options): Promise<StoredThread>
```

The signature the channel already calls (`app/src/components/channels/channel-chat.tsx:389-393`) does not change. Inside, a cached `runtimeMode()` helper reads `GET /api/capabilities`, which is public and mode-bearing (`server/src/app.ts:470-476`). In local mode it fetches `/api/local-runtime/threads/:threadId/history`, whose owner and Bot access checks already run (`server/src/local-runtime/routes.ts:20-41`, mounted with `requireUser` at `server/src/app.ts:1413-1422`), and maps the `messages` projection through the existing `readableTurns` boundary (`thread-messages.ts:78-94`). The parse-before-trust contract stays where it is. One new test must prove that a stored local run's projection passes `readableTurns`, because the projection rows must carry the store's tool-call dialect that `thread-messages.ts:22-33` describes.

The `/bot` page needs no new restore path. The packaged chat already rebuilds its transcript from the `agent/connect` replay, which unit 5 made work. The mode branch therefore exists in exactly one function, and the SDK's private `ɵsupportsLocalThreadEndpoints` contract is never touched.

As built, the runner persists only text and input content as message rows (`server/src/local-runtime/runner.ts:329-389`). A tool call lives in the recorded event stream (`TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` in `local_events`) and never reaches `local_messages`, whose schema has no tool columns (`server/src/db/schema/local-runtime.ts:123-136`). The projection alone would restore text without tool turns, which the acceptance bullet for restored tool turns forbids. `readHistory` therefore folds the recorded tool events into the message projection at read time. A call becomes the `{id, name, args}` dialect attached to the row its `parentMessageId` names, or a new assistant row when no row holds it. A result becomes a tool row carrying its `toolCallId`. The fold reads only existing tables, so the unit still adds no table, no column, and no event type. `readableTurns` already translates that dialect (`thread-messages.ts:117-152`), and `projectedTurn` passes a folded row's `toolCalls` through to it.

### Run status, one derivation

```ts
// server/src/local-runtime/summary.ts
export type LocalRunStatus =
  | { phase: "idle" }
  | { phase: "queued" | "running"; runId: string }
  | { phase: "succeeded"; runId: string }
  | { phase: "failed"; runId: string; reason: string }
  | { phase: "interrupted"; runId: string; reason: string };
export function summarizeRunState(history: LocalHistory): LocalRunStatus
```

`summarizeRunState` is a pure function over the history read. It derives the phase from the newest run row and its newest terminal attempt event, never from client state. A `cancelled` run with an `attempt.interrupted` event reads as interrupted. A `failed` run carries the stored `local_runs.error` (`store.ts:924`). The UI, the evidence scripts, and the reconnect journey all read the same derivation, so the three cannot disagree.

The client hook `useLocalRunStatus(threadId, agentId)` in `app/src/lib/copilot/local-run-status.ts` reads the history endpoint once on mount, then polls `GET .../events?after=<seq>` at one second only while the phase is `queued` or `running`, and stops at terminal. In intelligence mode it returns idle and renders nothing. Both conversation surfaces mount it. The channel puts the strip above the composer. The `/bot` page puts it beside the existing banners (`app/src/routes/_authed/_app/bot.tsx:213-238`).

Artifacts are the restored transcript's final assistant message with its page link. The design deliberately does not build an artifact store and does not start writing `local_runs.resultRef`, which nothing populates today (`runner.ts:313-321`).

### The startup script

The script reads the mode once, near the other settings (`scripts/start.sh:47-57`), and exports it so the script and the server child agree.

```bash
RUNTIME_MODE="$(setting OPENBOT_RUNTIME_MODE intelligence)"
export OPENBOT_RUNTIME_MODE="$RUNTIME_MODE"
```

The identity probe generalizes from `licenseStatus exists` to `the runtime declares the mode this script is starting`. In `identifies_as_openbot` (`scripts/start.sh:155-173`) the server case branches on `RUNTIME_MODE`. The intelligence branch keeps the existing grep byte for byte. The local branch fetches `/api/capabilities` and requires both `mode === "local"` and a constant product marker that the server adds to that payload. The marker, not the mode alone, distinguishes this server from an unrelated listener that happens to answer 200, which is the probe's stated contract (`scripts/start.sh:142-154`).

Before any restart action, the script verifies the port holder the same way. A listener that identifies as this product in the wrong mode is refused with a message naming the mode it is in. A listener that does not identify as this product is refused without being killed. The existing restart paths (`stop_server_processes_for_restart`, `scripts/start.sh:214-217`) act only on processes the script can attribute to this checkout.

Stage 3 (`scripts/start.sh:404-425`) receives the mode. The local branch fetches `/api/capabilities`, requires `mode === "local"` and `durableHistory === true`, keeps the existing no-Bots-registered check from `/info`, prints the local mode line with the Bot list, and never prints the Intelligence login hint. The intelligence branch is unchanged. Stages 1, 2, and 4 need no change.

### The desktop dev entry

One new branch before the wizard's Intelligence flow in `desktop/src/App.tsx`. The welcome step gains the `Connect to a local workbench` action with a URL field. The entered URL is accepted only as an exact loopback `http` origin with a port and no path, credentials, or query. The click fetches `<url>/api/capabilities`, requires `{mode: "local", durableHistory: true}`, and on success opens a new `WebviewWindow` at that URL using the Tauri v2 window API. Failure renders through the shell's existing `asProblem` display (`desktop/src/App.tsx:284-298`). No env file is written, no deployment is launched, and no Rust module changes. The wizard's Intelligence machinery is untouched. Desktop entry is already distinguishable in run events through the existing telemetry wiring (`server/src/copilot.ts:1793-1796`), which the desktop evidence cites.

### The reconnect driver

One new journey, `server/tests/local-runtime-browser-reconnect.integration.test.ts`, run through `bun run verify:aooo <path>` so it gets the isolated database, evidence directory, and guaranteed cleanup (`.claude/skills/verify-aooo/SKILL.md:31-37`). It reuses the unit 5 process recipe (`server/tests/local-runtime-http.integration.test.ts:212-245`) for the server, adds an app child on a fresh port pointed at the test server, and drives a real browser with Playwright as a new dev dependency. It mints the owner session with the same helper the unit 5 test uses and injects the cookie into the browser context. It owns every process handle and never touches the shared dev stack, per the contract in `.claude/skills/verify-aooo/features/reconnect.md:24-32`. Screenshots land in the evidence directory. The journey walks close-reopen, service-restart, crash-interrupt, and visible-state. The feature map gains the journey and the desktop procedure.

## Verification

- Page closed, server keeps working, reopening does not dispatch again. The journey starts a fixture run, closes the tab mid-run, waits for terminal, and observes through the history endpoint exactly one `local_runs` row and no new `run.queued` event after the first sequence. It reopens the thread and observes the restored transcript plus the succeeded status strip. A screenshot is retained.
- Refresh and closed page reconnect to the original run. Same journey, refresh variant. It observes no second submission and the composer unlocked only after terminal.
- After a normal service restart, history is readable. The journey kills its owned server after a run completes, starts a new server process on the same port and database, reopens the thread, and observes the full transcript and status from the history read. The unit 5 HTTP case is recorded as prerequisite evidence only, per `reconnect.md:26-27`.
- A crash mid-run clearly shows an interrupt. The journey SIGKILLs the server mid-run with `OPENBOT_LOCAL_LEASE_MS` set low for speed, waits past the window, reopens the thread, and observes the `attempt.interrupted` event, the settled run row, the interrupted status strip with its reason, and the pre-crash transcript intact. It also asserts no new attempt started, proving no auto-recovery is claimed.
- The conversation shows run state, failure reason, history, and artifacts. The journey drives one succeeded run and one fixture-model failure run and observes the strip reading succeeded and failed with the stored reason, the restored tool turns, and the final message link visible. Unit tests cover `summarizeRunState` from run rows and terminal events.
- `start.sh` brings up and verifies a local stack. A human runs `OPENBOT_RUNTIME_MODE=local bash scripts/start.sh` against the dev database and records stage 3 printing the local mode line and the app becoming ready. The same script without the override still prints the licence line, proving intelligence mode is unbroken.
- The macOS dev shell connects to local mode. A human-assisted check. A preparation script starts the local stack and `bun run tauri dev`; the operator clicks the action, and the evidence is screenshots of the local window showing the original thread plus the run event record showing the desktop telemetry marker. The feature map records this sub-feature as human-driven and reports not run when no driver exists.

## Tradeoffs accepted

- We accept lazy, read-time settlement of crashed runs in exchange for no background reaper process and no second writer to shared rows. A crashed run displays as running until somebody opens the thread or reads history.
- We accept a one-second poll for run status in exchange for a path that survives SSE loss, restart, and crash.
- We accept a mode branch inside `readThreadMessages` in exchange for keeping the client's public surface unchanged and avoiding the SDK's private thread-endpoint contract.
- We accept a Playwright dev dependency and an `OPENBOT_LOCAL_LEASE_MS` test knob in exchange for a crash journey that finishes in seconds. The production default is untouched.
- We accept a human-assisted desktop-local check in exchange for not building WKWebView automation, which no available driver covers.
- We accept leaving the SDK's REST thread endpoints unanswered in local mode in exchange for one finished history mechanism instead of two half-wired ones.

## Alternatives considered

- Set `ɵsupportsLocalThreadEndpoints` on `LocalAgentRunner` so the SDK's REST thread endpoints answer in local mode with no client change. Rejected. The interface is synchronous and returns arrays, so a Postgres runner would need an in-process cache that becomes a second source of truth beside the events. It also couples the fork to a private, `ɵ`-marked SDK contract, and it would leave the server's own history routes permanently dead code. Those routes carry the run, attempt, and operation rows the visible-state bullet needs.
- A background reaper that periodically settles lapsed runs. Rejected. It adds a second writer to shared rows, races replicas, and settles work nobody is looking at. The reader knows exactly when the answer is needed.
- Derive run status from the SSE stream alone, with no poll. Rejected. After a crash or restart the stream is gone, and those are precisely the cases the interrupt display must survive.

## Synthesis decision

Three candidates from three models were graded against six criteria by the coordinator and an independent cross-judge from another vendor. Candidate 1 (Opus) is the base. It is the smallest design that is still end-to-end and it verified two defects in the grounding artifact that the coordinator confirmed in the code. The cross-judge concurred with the base pick.

Grafted from candidate 2 (Sonnet): the pure single derivation of run state, here `summarizeRunState`, so the UI and the evidence read one function instead of agreeing by convention; and the invariant that every terminal run has exactly one agreeing terminal `attempt.*` event.

Grafted from candidate 3 (GPT): the product marker in the capabilities payload so the startup probe distinguishes this server from an unrelated listener; the refusal matrix that never kills a mismatched port holder and scopes restarts to processes attributed to this checkout; and the loopback origin validation rules for the desktop entry.

All three candidates independently confirmed the crash settlement gap, which the coordinator verified in `store.ts` before scoring. That convergence is the signal that makes settlement the first implementation step.

## Open questions and risks

- Does the desktop webview need a CSP or capability adjustment in `tauri.conf.json` to navigate to an external localhost URL on Tauri 2? The design assumes a `WebviewWindow` with an external dev URL works with a dev-only CSP change. This is the one desktop implementation checkpoint.
- Is adding Playwright as a devDependency and one `OPENBOT_LOCAL_LEASE_MS` knob acceptable? Both exist only for the acceptance driver.
- The store currently has no queued-run orphan rule. The settlement treats a queued run with zero attempts older than the lease window as orphaned. If a future unit adds cross-process queue consumption, that rule needs revisiting, because a queued run may legitimately wait longer than one lease window.

## Next implementation step

Build `settleLapsedThreadWork` and its two call sites first, with a store integration test that kills the executor, waits past the lease, and asserts the interrupted terminal state. Everything else in the unit builds on that guarantee.
