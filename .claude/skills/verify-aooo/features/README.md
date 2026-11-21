# aooo bot verification map

Read the plan's matching unit before choosing a journey. A `verify-aooo` pass is evidence only for the selected test and its stated boundaries.

## Features

- [Retry Bot creation](./creation-retry.md) shows how to reuse the same runner for the unit 2 route and database check.
- [Local runtime run and history](./local-runtime.md) is the current fixture-backed server journey (stage-one work unit 5).
- [Reconnect the original work](./reconnect.md) covers close-reopen, refresh, service-restart, crash-interrupt, and visible-state through the browser journey (stage-one work unit 6), plus the human-driven desktop-local check, the three server-side journeys that pin the settle, fold, and status contracts, the wire-protocol guard that reads the served stream with the real AG-UI client, and the offline start.sh refusal-matrix guard.
- [Update the Notion work page](./notion-workbench.md) is work unit 7: the write classification, honest record, usage, trace, and judge checks run offline, and the live Notion acceptance is complete — the definitive run was judged PASS (2026-11-21 evening) and the judge script remains the reusable contract for any future judged live run.

Last sync: commit `93191f04` (the stage-one closeout), checked 2026-11-21; corrected the same evening in a maintenance pass and then in an independent audit's follow-up — the audit (read-only, external reviewer) found two overclaims, an inaccurate attribution, a wrong artifact reference, and in-scope surfaces with no mapped journey, all fixed in the follow-up with the newly registered checks driven green first. Every check named above was driven on that revision or later the same day.

## Formal checks outside this harness

- [The local history projection](../../verify-local-projection/SKILL.md) is verified by bounded exhaustive enumeration over the real `summarizeRunState` and `foldHistoryMessages` (commit `c1a581d4`), with no database. Run it when a change touches `server/src/local-runtime/summary.ts`, `history-fold.ts`, or the event vocabulary the store writes; it is not a journey and produces no evidence directory.

## What stage two can reuse from this map

Pointers, not registrations — a feature joins the map when its code and journey exist:

- Any change to the channel loop (the delegation A→B→A segment, the group runner) crosses the same served wire as the browser client, so the [wire-protocol guard](./reconnect.md) is the regression net: run it with every such change, because the browser journey reads the projection and cannot see a stream the client rejects.
- The context-budget and compression-summary segment will touch `summarizeRunState` and `foldHistoryMessages`; that is the formal projection check's named trigger, so the segment's own work must re-derive that check's models alongside the code, red-first.
- The quality-assessment loop re-runs judged live batches; [the judge and its guard](./notion-workbench.md) are the reusable contract — the judge is protocol-stable now that it scopes by batch (set of runs), not by a single run id.
- The installer segment's "second business duty" creates a Bot through the product surface; [the creation-retry file](./creation-retry.md) registers the dedup and conflict contract, the partial-grant recovery journeys, and the component-level UI entry-point checks a new creation flow must not break.
- New units keep the runner's own model: write the ordinary Bun journey, pass its path to `bun run verify:aooo`, and register it here with its evidence outputs.

## Known in-scope surfaces without a mapped journey

Honest gaps, named so the next pass picks them up instead of rediscovering them; each has concrete source but no automated user-path journey yet:

- **Creating a Bot through the UI end to end** — the conversation card and the New Bot sheet ([bots.index.tsx](../../../../app/src/routes/_authed/_app/bots.index.tsx)) have component-level checks only; no journey drives a real creation through a running stack.
- **Connector setup as an observable path** — enabling the Notion connector, the personal OAuth connect, Refresh tools, and the per-tool grant screen ([admin plugins page](../../../../app/src/routes/_authed/admin/plugins/$key.tsx), [connections page](../../../../app/src/routes/_authed/_app/connections.$key.tsx)) are treated as preconditions in [notion-workbench.md](./notion-workbench.md); no journey drives them as the feature they are.
- **Finding the original conversation through the sidebar** — reopening a known URL proves reconnection, not discovery; the thread list, search, and unread state ([app-sidebar.tsx](../../../../app/src/components/app-sidebar/app-sidebar.tsx)) have no journey.
- **The channel composer's attachments** — picker/paste/drop, limits, and read-back ([composer.tsx](../../../../app/src/components/channels/composer/composer.tsx)); the Notion acceptance delivered sources inline, so attachments never ran in a judged acceptance.
- **The direct `/bot` conversation and the home composer** — [bot.tsx](../../../../app/src/routes/_authed/_app/bot.tsx), [index.tsx](../../../../app/src/routes/_authed/_app/index.tsx); channel-only proof leaves these entry points unspecified.

Out-of-scope surfaces (memory, learning, schedules, delegation, admin settings, packaging) belong to later segments; they are absent by scope, not by omission.
