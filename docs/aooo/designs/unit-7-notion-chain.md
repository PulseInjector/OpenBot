# Work unit 7 design: the real Notion work chain and the stage's overall acceptance

Status: design complete, not implemented. The unit's contract is the "Work unit 7" section of [plan.md](../../plan.md). This file holds the detailed design an implementing agent reads before starting. A decision-level change to the unit syncs back to plan.md in the same session it is made. A detail-level change stays here. This unit depends on work unit 6's reconnect guarantee, because the operator closes the browser mid-update during acceptance.

## Problem

No code path anywhere reads a Notion page, updates the compatibility area, or reads back. The chain is prompt procedure executed by the model through granted MCP tools inside the existing 8-step agent loop (`server/src/copilot.ts:462-494`, `:511`). The plan fixes that chain's order and keeps it model-driven: read the target page, update the dedicated compatibility follow-up area, then read again to verify, with parameters built from the schema actually discovered (plan.md line 66). The work is therefore configuration, exact minimal grants, a checkable classification guard, and evidence tooling, not a new workflow engine.

Three things must be settled before a live run can produce honest evidence.

1. The recorded intent can diverge from the executed call. The built-in tool wrapper executes `tool.execute(args)` with the raw arguments inside a callback that received the validated ones (`server/src/copilot.ts:488`), while `executeRecordedTool` validates and records the parsed object (`toolkit/src/tool-operation.ts:29-56`). If validation fills or coerces anything, the record says one thing and Notion receives another, which undermines the write-count evidence. The fix is at that one joint: execute the validated arguments. A test must pin that the recorded intent equals the executed arguments.
2. The write barrier depends on human review staying ahead of the vendor. An advertised name the reviewed `writeTools` list omits classifies as a read (`server/src/plugins/catalogue.ts:384-393`, precedence at `:504-533`), so a refreshed Notion tool that writes but is not on the list could be granted as a read. The classification check must be a guard that fails, not a step a human remembers.
3. The frozen fixtures carry two stale lines the implementer must not obey. The fixture README names `.local/aooo-pr1-test-page.md`, but the file that exists is `.local/notion-test-page.txt` (`tests/fixtures/aooo/README.md` step 4). Its step 1 still says the stack needs Intelligence configuration, which unit 5 made false for local runs. Fixtures are frozen inputs, so the design standardizes on the existing `.txt` path and records both stale lines in the unit's check record instead of editing them.

## Usage

The operator prepares once, then drives two live batches and judges them with a script.

### Preparation

Model via `.env` with `BOT_PROVIDER=openai`, `BOT_MODEL=deepseek/deepseek-v4.1-flash`, and `OPENAI_BASE_URL=http://127.0.0.1:8090/v1`, which must be set for a custom model name to apply (`server/src/copilot.ts:243-247`). Notion per the plugin guide. She refreshes tools, which persists each tool's name, description, raw `inputSchema`, and vendor-declared effect (`server/src/plugins/mcp.ts:429-440`). She runs the preflight script below and reviews its report. She grants the Bot the page-read tools the chain needs plus `notion-update-page`, nothing else, and confirms the grant screen shows no create, duplicate, move, or comment tools. She resets the test page to `tests/fixtures/aooo/initial-page.md` and records both the page export before the run and the preflight report.

### Batch 1

She posts the two batch-1 source files and the page URL into one Bot thread with the fixture README prompt. Mid-update she closes the browser tab and reopens the thread. The Bot has finished, the page link is in the transcript, and the history JSON shows exactly one `notion-update-page` operation for this run. She saves the page export and the history JSON under `.local/unit7/`.

### Batch 2

Same thread, same page. She posts all three batch-2 files, naming REL-25-MIRROR as a byte-identical copy of REL-25 and one source. During the update she closes the tab again and reopens. She saves the second page export and history JSON. Then she runs the live check below, which reads the frozen case, the two page exports, the two history JSONs, and the connector trace, and prints pass or fail per expected fact, per forbidden finding, per protected paragraph, and per write count.

## Shape

### One new event kind, no new columns

```ts
// runner.ts execute, after runAgent resolves, before finishAttempt
await this.store.append(currentToken, {
  kind: "event", type: "model.usage",
  payload: { model, provider, inputTokens?, outputTokens?, totalTokens? },
});
```

At most one per attempt. Fields the provider did not return stay absent. Nothing is estimated, per plan.md line 67. The capture point is the agent finish path where the locked SDK exposes usage, near the tool wiring (`server/src/copilot.ts:462-494`). If the locked version exposes nothing, the event is absent and the evidence says so. Tool usage is already derivable from `local_operations`. No parallel usage system is built.

### The preflight script and the coverage guard

`scripts/aooo/notion-preflight.ts` reads the refreshed tool listing and the Bot's grants through the plugin store and prints a report.

```ts
type PreflightReport = {
  chain: { read: string[]; update: string };
  rows: Array<{
    ref: string;
    classified: "read" | "write";   // from the reviewed list, not the vendor
    inReviewedWriteList: boolean;
    granted: boolean;
    schemaSha256: string;
  }>;
  problems: string[];
};
```

It exits nonzero on a missing chain grant, an extra granted Notion write tool, or an advertised write absent from the reviewed `writeTools` list (`server/src/plugins/catalogue.ts:394-413`). The report records the vendor-declared effect but the classification authority is the reviewed list, matching the codebase's deliberate stance that vendor read hints are never honored (`catalogue.ts:395-415`).

A sanitized snapshot of names, classifications, and schema digests is saved to `docs/aooo/evidence/unit-7-notion-tools.json`. No tokens, no account identity. `server/tests/notion-catalogue-coverage.test.ts` reads that snapshot and the catalogue offline. It fails when an advertised name is absent from `writeTools` and it fails when a `writeTools` name is no longer advertised. A failure means a human reviews and, if the tool writes, extends the list before any grant.

### Exact grants

The Bot receives the page-read tools the chain needs plus `notion-update-page`. No create, duplicate, move, comment, or folder tool is granted. Grant mechanics are unchanged (`server/src/plugins/route-groups/app-access.ts:783`, `plugin-store/app-access.ts:434-457`). Parameters are built from the discovered schema through the existing `parametersFor` (`toolkit/src/granted-tool.ts:29`).

### The chain and the duplicate source

The chain stays prompt procedure inside the 8-step loop, in the plan's fixed order. The operator's message names the mirror as a byte-identical copy of REL-25 and one source, because the dedup key is the declared source identity: REL-25-MIRROR is `duplicateOf` REL-25 (`tests/fixtures/aooo/case.json:8-13`). One finding, one write, cited to REL-25. The design deliberately does not add server-side content dedup. The proof is the write count and the read-back, made checkable below.

### The connector trace

One structured log line at the MCP call boundary records each physical `callTool` request and reply for the Notion server: the tool ref, the operation id, and success or failure. No arguments beyond a sanitized target, no tokens. The evidence run saves this trace alongside the page exports. Local operation rows alone do not prove the physical write count. The read-back and this trace together do. An unknown additional mutation in the trace makes the check inconclusive rather than passed.

### The live check

`scripts/aooo/live-check.ts <evidence-dir>` reads the frozen case, the initial page copy, the saved page exports, the saved history JSONs, and the connector trace. It reports per expected fact with its citations, per `mustNotAppearAsFindings` entry, per protected paragraph, and the `notion-update-page` operation count and physical mutation count per run. It exits nonzero on any miss. It is the same comparison the operator would do by hand, made repeatable so a failure is never a judgment call. It does not read `.env` and never writes to Notion.

## Verification

Unit 7's own acceptance.

- A real model with real Notion completes a sourced update. The live run per the fixture README, batch 1 then batch 2 in one thread. A human drives it. The proof is the saved page export matching the expected facts with source citations, the `model.usage` event in the history JSON, and `live-check.ts` exiting zero.
- Unrelated content is untouched. `live-check.ts` compares everything outside `Compatibility follow-up (Bot editable)` in both page exports against `tests/fixtures/aooo/initial-page.md` and both protected paragraphs (`case.json:99-102`). The operator also reads the page independently after each turn and records the external write count she sees.
- Duplicate input does not write twice. `live-check.ts` counts one `notion-update-page` operation and one physical mutation per batch, and fails if the read-back carries a REL-25-MIRROR citation or a second REL-25 entry, per `case.json:93-98`.
- The write classification and exact grants are checked against the discovered schema. `bun test server/tests/notion-catalogue-coverage.test.ts` against the saved snapshot, plus the preflight report and the recorded grant screen showing reads plus `notion-update-page` only.
- Reconnect passes on the real chain. The operator closes the tab during the batch 2 update and reopens. The proof is the history JSON showing one write operation for batch 2 and the read-back confirming the write, alongside the unit 6 journey.

The stage's overall acceptance, each with its rerun.

| Plan bullet | Check and proof |
| --- | --- |
| Local mode starts with Intelligence cleared, a real model completes the read, update, read-back, and delivers an artifact link, and a new thread's history comes from the local database. | The live acceptance above, plus the unit 6 history read. Evidence includes the page link and a database read with no Intelligence configuration. |
| Close and reopen mid-run, restart keeps history, a crash shows an interrupt, and no second tool write happens. | The unit 6 browser journey and restart check, plus the batch 2 close-and-reopen above. |
| A caller who is not logged in, a wrong user, and a thread the caller cannot access are refused for read, run, and stop. A duplicate old submission opens no second run. An old stop does not affect a new attempt. | `bun run verify:aooo server/tests/local-runtime-http.integration.test.ts`, recorded per assertion. |
| A creation submitted with the response lost, retried, yields one Bot. A mid-way grant failure fills only the confirmed missing items. Half-finished parameters never execute. Tool calls and results are saved in pairs. | `bun run verify:aooo server/tests/bot-creation-retry.integration.test.ts`, the unit 4 boundary tests, and the pinned intent-equals-executed-arguments test for the wrapper defect above. |
| Focused tests for the tool boundary, input deduplication, reconnect, and creation. Root `bun run typecheck`. The desktop dev shell connects to local mode. | The named journeys and the unit 6 checks, plus root `bun run typecheck` with the known `config.test.ts` union fix landed. Packaging is out of scope. |

## Tradeoffs accepted

- We accept prompt-level duplicate handling verified by write count, read-back, and connector trace, in exchange for not inventing a parallel source-dedup system. Segment 4 owns write idempotency depth.
- We accept usage recording only when the locked SDK exposes it, absent otherwise, in exchange for never estimating a bill figure.
- We accept a one-line change to the built-in wrapper's execute path plus a pinning test, in exchange for the recorded intent always matching the executed call.
- We accept an always-on structured trace line at the MCP boundary in exchange for physical write counts that operation rows alone cannot prove.
- We accept a human in the live loop in exchange for not faking a fixture-model run as a Notion write, per the harness contract that fixture evidence never proves a live write.

## Alternatives considered

- Server-side dedup of duplicate sources by content hash. Rejected. A hash cannot prove semantic duplicate identity, the case's dedup key is a declared source ID, and hashing would create a second persistence concept beside the events the plan already owns.
- A composite internal workbench tool that hides the read, update, and read-back from the model and enforces section isolation and source-set dedup in code. Rejected for this stage. It is structurally stronger against duplicates, but it replaces the model-driven chain that plan.md line 66 and this unit's acceptance sentence specify, so the acceptance would prove a different product than the one the plan describes. The plan's letter has the real model driving the granted tools through the boundary units 4 and 5 verified. Segment 4 owns structural write idempotency, and this design records the composite tool as the leading candidate there.
- A fixed read-update-read chain as server code bypassing the model loop. Rejected for the same reason, and a hardcoded chain would stop exercising the exact tool boundary the stage verified.

## Synthesis decision

Three candidates from three models were graded against six criteria by the coordinator and an independent cross-judge from another vendor. Candidate 1 (Opus) is the base. It is the smallest design that still honors the plan's model-driven chain, and it named the wrapper's raw-versus-validated argument defect, which the coordinator confirmed in `server/src/copilot.ts:488`.

Grafted from candidate 2 (Sonnet): the preflight report with schema fingerprints and an exact grant diff, with the reviewed list rather than the vendor as the classification authority; and the stage-acceptance coverage table above.

Grafted from candidate 3 (GPT): the proof standard for the duplicate bullet. Local operation rows alone do not prove the physical write count, so the evidence traces the physical `callTool` requests and treats an unknown additional mutation as inconclusive.

All three candidates converged on capturing `model.usage` only where the locked SDK exposes it, with absent fields staying absent and nothing estimated.

## Open questions and risks

- Which BOT_MODEL spelling does the gateway route prefer, the prefixed or the unprefixed id? Both exist. The operator records the choice before the live run.
- Does the live `notion-update-page` schema support block-targeted content updates, or only a replace operation? The operator builds the parameters from the schema actually discovered and records which shape the live refresh advertised. The section isolation holds either way through the read-back comparison.
- Is one prompt revision allowed during acceptance if the model's first findings are malformed, or does that run count as a failure? The operator decides and records the rule before the run.
- The wrapper defect fix touches the same joint the unit 4 evidence describes, where authorization runs twice by design. The implementing agent must preserve that double check.

## Next implementation step

Fix the wrapper's executed-arguments defect and land its pinning test, then build the preflight script and the coverage guard, because every later acceptance artifact is judged through an honest record.
