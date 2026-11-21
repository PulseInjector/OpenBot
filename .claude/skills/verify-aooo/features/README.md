# aooo bot verification map

Read the plan's matching unit before choosing a journey. A `verify-aooo` pass is evidence only for the selected test and its stated boundaries.

## Features

- [Retry Bot creation](./creation-retry.md) shows how to reuse the same runner for the unit 2 route and database check.
- [Local runtime run and history](./local-runtime.md) is the current fixture-backed server journey (stage-one work unit 5).
- [Reconnect the original work](./reconnect.md) covers close-reopen, refresh, service-restart, crash-interrupt, and visible-state through the browser journey (stage-one work unit 6), plus the human-driven desktop-local check, the three server-side journeys that pin the settle, fold, and status contracts, and the offline start.sh refusal-matrix guard.
- [Update the Notion work page](./notion-workbench.md) is work unit 7: the write classification, honest record, usage, trace, and judge checks run offline now, and the live Notion write remains explicit live acceptance with a judge script for its saved artifacts.

Last sync: commit `7086f1e9`, checked 2026-11-21. Every check the two unit 6/7 feature docs register was run on that revision before registration: the three server-side journeys and the four unit 7 offline guards on 2026-11-21, the browser journey and default HTTP case at the stage sweep on `2a5c32ef`.

## Formal checks outside this harness

- [The local history projection](../../verify-local-projection/SKILL.md) is verified by bounded exhaustive enumeration over the real `summarizeRunState` and `foldHistoryMessages` (commit `c1a581d4`), with no database. Run it when a change touches `server/src/local-runtime/summary.ts`, `history-fold.ts`, or the event vocabulary the store writes; it is not a journey and produces no evidence directory.
