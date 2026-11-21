# aooo bot verification map

Read the plan's matching unit before choosing a journey. A `verify-aooo` pass is evidence only for the selected test and its stated boundaries.

## Features

- [Retry Bot creation](./creation-retry.md) shows how to reuse the same runner for the unit 2 route and database check.
- [Local runtime run and history](./local-runtime.md) is the current fixture-backed server journey (stage-one work unit 5).
- [Reconnect the original work](./reconnect.md) covers close-reopen, refresh, service-restart, crash-interrupt, and visible-state through the browser journey (stage-one work unit 6), plus the human-driven desktop-local check, the three server-side journeys that pin the settle, fold, and status contracts, the wire-protocol guard that reads the served stream with the real AG-UI client, and the offline start.sh refusal-matrix guard.
- [Update the Notion work page](./notion-workbench.md) is work unit 7: the write classification, honest record, usage, trace, and judge checks run offline, and the live Notion acceptance is complete — the definitive run was judged PASS (2026-11-21 evening) and the judge script remains the reusable contract for any future judged live run.

Last sync: commit `93191f04` (the stage-one closeout), checked 2026-11-21; the map was corrected the same evening in a maintenance pass with every check above driven on that revision or later the same day — the wire-protocol guard, the start.sh refusal matrix, the catalogue coverage, the live-check guard, and the live judge on the saved artifacts at that revision, the heavy journeys at the closeout run one revision earlier on a code-identical tree.

## Formal checks outside this harness

- [The local history projection](../../verify-local-projection/SKILL.md) is verified by bounded exhaustive enumeration over the real `summarizeRunState` and `foldHistoryMessages` (commit `c1a581d4`), with no database. Run it when a change touches `server/src/local-runtime/summary.ts`, `history-fold.ts`, or the event vocabulary the store writes; it is not a journey and produces no evidence directory.

## What stage two can reuse from this map

Pointers, not registrations — a feature joins the map when its code and journey exist:

- Any change to the channel loop (the delegation A→B→A segment, the group runner) crosses the same served wire as the browser client, so the [wire-protocol guard](./reconnect.md) is the regression net: run it with every such change, because the browser journey reads the projection and cannot see a stream the client rejects.
- The context-budget and compression-summary segment will touch `summarizeRunState` and `foldHistoryMessages`; that is the formal projection check's named trigger, so the segment's own work must re-derive that check's models alongside the code, red-first.
- The quality-assessment loop re-runs judged live batches; [the judge and its guard](./notion-workbench.md) are the reusable contract — the judge is protocol-stable now that it scopes by batch (set of runs), not by a single run id.
- The installer segment's "second business duty" creates a Bot through the product surface; [the creation-retry journey](./creation-retry.md) already pins the dedup and partial-grant contract that creation must not break.
- New units keep the runner's own model: write the ordinary Bun journey, pass its path to `bun run verify:aooo`, and register it here with its evidence outputs.
