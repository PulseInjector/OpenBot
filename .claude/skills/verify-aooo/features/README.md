# aooo bot verification map

Read the plan's matching unit before choosing a journey. A `verify-aooo` pass is evidence only for the selected test and its stated boundaries.

## Features

- [Retry Bot creation](./creation-retry.md) shows how to reuse the same runner for the unit 2 route and database check.
- [Drive the workbench UI](../../../../server/tests/local-workbench-surfaces.integration.test.ts) with `bun run verify:aooo server/tests/local-workbench-surfaces.integration.test.ts` (one test, six phases). It creates a Bot through the New Bot sheet and the conversation card, discovers an older conversation through a sidebar link, sends from home and `/bot`, uploads and sends an attachment, and refreshes a custom fixture connector's tools before granting the exact tool on its admin Bot screen. Assertions read the creation records, direct-thread history, attachment state, refreshed listing, and grant rows. Inspect `workbench-surfaces.json`, `cases.xml`, and the `surfaces-*.png` screenshots in the evidence directory. The model, MCP server, and managed Agent endpoint are fixtures. The managed endpoint supplies the built-in wizard's configuration prerequisite; the created Bots and rows are real. The conversation Bot holds the required `bot-creator` skill. This journey does not drive Notion enablement or personal OAuth.

  Two consecutive runs passed on 2026-11-21 (25 assertions each), with setup, drive, and cleanup passed: `.logs/aooo/verify-bvayjg2n/` and `.logs/aooo/verify-a7_su6ji/`.
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
- The installer segment's "second business duty" creates a Bot through the product surface; [the creation-retry file](./creation-retry.md) registers the dedup and conflict contract, the partial-grant recovery journeys, the end-to-end UI drive, and the component checks a new creation flow must not break.
- New units keep the runner's own model: write the ordinary Bun journey, pass its path to `bun run verify:aooo`, and register it here with its evidence outputs.

## Known in-scope surfaces without a mapped journey

Honest gaps, named so the next pass picks them up instead of rediscovering them; each has concrete source but no automated user-path journey yet:

- **Notion connector enablement and personal OAuth** remain preconditions in [notion-workbench.md](./notion-workbench.md). The workbench journey drives Refresh tools and per-tool grants on a preconfigured custom fixture connector's admin page. It does not drive the Notion enable switch or OAuth connect through the [connections page](../../../../app/src/routes/_authed/_app/connections.$key.tsx).
- **Sidebar search and unread state** ([app-sidebar.tsx](../../../../app/src/components/app-sidebar/app-sidebar.tsx)) remain undriven. The workbench journey covers discovery through the thread list and reopening the selected conversation.
- **Attachment paste, drop, limits, and content read-back** ([composer.tsx](../../../../app/src/components/channels/composer/composer.tsx)) remain undriven. The workbench journey covers the file input, staged upload, send, and attachment-row state. Attachments have not run in a judged Notion acceptance.

Out-of-scope surfaces (memory, learning, schedules, delegation, admin settings, packaging) belong to later segments; they are absent by scope, not by omission.
