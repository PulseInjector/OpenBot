# Retry Bot creation

When a creation response is lost, retrying the same confirmation should find the Bot already created, not silently create a second one.

## Sub-features

- Lost response and simultaneous retries: one Bot and one request record for the same owner and key.
- Changed confirmation: conflict rather than applying a different request under the old key.

## How to get to it (user POV)

Confirm `save_bot` in the conversation card, or choose **Bots → New Bot**. These are different UI entry points; the sheet does not restore an unfinished form after reload.

## Driving it with verify-aooo

Run `bun run verify:aooo server/tests/bot-creation-retry.integration.test.ts`. The existing case sends the creation request to the route in-process, discards its response, then reads the result through a fresh store. Inspect `creation.json`: the returned ID must equal the original, and the Bot count must increase by one, not two. Inspect `cases.xml` for the separate conflict and concurrent-retry checks. This is database/route regression proof, not real UI or grant proof.

## Gotchas

The wizard's **Run it here** option reads `builtInAvailable` from `GET /api/agents/capabilities`. The server sets that flag from the configured managed Agent endpoint (`MANAGED_AGENT_AG_UI_URL`, requiring `MANAGED_AGENT_TOKEN`), not from local history mode. Do not add a dummy endpoint to get a green wizard. A disabled button identifies a missing wizard precondition, not a failure of the local run/replay test.
