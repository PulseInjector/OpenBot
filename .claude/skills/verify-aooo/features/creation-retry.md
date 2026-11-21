# Retry Bot creation

When a creation response is lost, retrying the same confirmation should find the Bot already created, not silently create a second one.

## Sub-features

- Lost response and simultaneous retries: one Bot and one request record for the same owner and key.
- Changed confirmation: conflict rather than applying a different request under the old key.
- Partial grant: a creation whose grant step fails midway retries by re-reading and filling only the missing grant, never widening.
- UI entry points: the conversation card's confirmation and the **Bots → New Bot** sheet are distinct user paths to the same store contract.

## How to get to it (user POV)

Confirm `save_bot` in the conversation card, or choose **Bots → New Bot**. These are different UI entry points; the sheet does not restore an unfinished form after reload.

## Driving it with verify-aooo

- **Route and store contract.** Run `bun run verify:aooo server/tests/bot-creation-retry.integration.test.ts`. The existing case sends the creation request to the route in-process, discards its response, then reads the result through a fresh store. Inspect `creation.json`: the returned ID must equal the original, and the Bot count must increase by one, not two. Inspect `cases.xml` for the separate conflict and concurrent-retry checks. This is database/route regression proof, not real UI or grant proof.
- **Partial-grant recovery.** Run `bun run verify:aooo server/tests/owner-app-grants.integration.test.ts` (20 tests, 137 assertions) and `bun run verify:aooo server/tests/app-access-routes.integration.test.ts` (51 tests, 228 assertions). Together they pin that a grant step failing midway retries by re-reading and filling only the confirmed missing items, that the same key with different content conflicts, and that tool authorization checks the current identity and the receiving Bot's grants — a credential owner does not widen the actor's rights. Both were driven green through this runner on 2026-11-21.
- **UI entry points.** Run `bun run verify:aooo server/tests/local-workbench-surfaces.integration.test.ts`. Its first two phases drive the New Bot sheet and the conversation card against a running server and app, then read the real Bot and creation-request rows. The managed Agent endpoint, model, and MCP server are fixtures. Inspect `workbench-surfaces.json` and the sheet/card screenshots. Keep `bun test app/tests/proposed-bot-card.test.tsx app/tests/new-bot-sheet.test.tsx app/tests/bot-creation-retry.test.tsx` (with `app/tests/app-access-mutations.test.ts` and `app/tests/bot-access-your-apps.test.tsx`, 35 tests together) for component-level request ID and refusal behavior. The successful UI journey does not replace those retry cases.

## Gotchas

The wizard's **Run it here** option reads `builtInAvailable` from `GET /api/agents/capabilities`. The server sets that flag from the configured managed Agent endpoint (`MANAGED_AGENT_AG_UI_URL`, requiring `MANAGED_AGENT_TOKEN`). Local history mode alone does not set it. The workbench journey serves an AG-UI fixture at this external boundary and configures the server to use its address and random token. The fixture answers `/health` and emits a run envelope with an assistant message from `/ag-ui`. The product's capability check and creation routes run normally. This proves creation with a configured fixture boundary, not a Docker-managed Agent deployment. The conversation Bot also requires the `bot-creator` skill grant before `save_bot` is offered. A pass of the route-only journey does not cover either UI entry point.
