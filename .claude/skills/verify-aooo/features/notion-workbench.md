# Update the Notion work page

The Bot reads fixed source material, changes only the dedicated compatibility section of the independent Notion test page, and reads the page back. The stage-one live acceptance is complete (2026-11-21 evening): the definitive run was judged `VERDICT: PASS`, exit 0, and is recorded in [unit-7-checks.md](../../../../docs/aooo/evidence/unit-7-checks.md) with raw artifacts in untracked `.local/unit7/`. The offline guards below keep the machinery pinned; a new live acceptance re-runs the preflight → drive → judge steps unchanged.

## Sub-features

- `source-update`: add the required compatibility findings with source references.
- `protected-content`: preserve the project profile, owner notes, and every section outside the Bot-editable area.
- `duplicate-input`: treat the mirrored release note as one source and avoid a repeated write.
- `read-back`: verify final page content, target identity, and actual external write count.

## How to get to it (user POV)

- Open the project-tracking Bot conversation and provide the fixed batch materials plus the independent test page URL.
- Read the Bot's resulting page link and open that page to check the saved content.
- Repeat with batch 2 in the same thread and check the same page again.

## Driving it with verify-aooo

Preconditions:

- Use only the test page identified in ignored `.local/notion-test-page.txt`; never use the plan page or a production work page. The fixture README's step 4 still names `.local/aooo-pr1-test-page.md`, which does not exist; that line is stale, per the unit 7 design.
- Follow `tests/fixtures/aooo/README.md` to establish the initial page copy, real model, Notion connection, exact tool grants, callback origins, and fixed material.
- The real model and Notion connection are explicitly configured for this acceptance. The runner itself never reads `.env` and never performs the external write.

Offline checks, runnable without any Notion account:

- **Check fixture inputs.** Run `bun test tests/aooo-fixtures.test.ts`. This validates frozen source references, duplicate identity, expected facts, and the protected-area boundary; it does not prove the live write.
- **Check the honest record.** Run `bun test server/tests/copilot.test.ts -t "equals the arguments the tool executed"`. The recorded intent of a built-in tool call must equal the arguments the tool executed, schema-filled defaults included (commit `a2e8241d`, issue #5). The write-count evidence below is judged through this record.
- **Check the write classification.** Run `bun test server/tests/notion-catalogue-coverage.test.ts` (13 tests). It fails when an advertised write is absent from the reviewed `writeTools` list and when a reviewed write is no longer advertised. The reserved human decision was made on 2026-11-21: the operator approved extending the list to 38 reviewed names against the live listing's real metadata (commit `ade0a980`), and the listing's 15 vendor-declared write tools are all on it. The guard still stands: a refreshed tool that writes but is not on the list classifies as a read, so a failure means a human reviews and extends before any grant.
- **Check the usage record.** Run `bun test server/tests/local-runtime-model-usage.test.ts` (4 tests). It pins that one `model.usage` event per attempt is captured from the provider's run-finished record, with absent fields omitted and nothing estimated (commit `92431298`). This is the record the stage's later quality units read back; the live script prints it as a NOTE, never a verdict.
- **Check the connector trace.** Run `bun test server/tests/mcp-protocol.test.ts` (16 tests). Its trace cases pin that each physical `callTool` leaves exactly one `mcp-call` line carrying the tool call id that joins to `local_operations`, with arguments and tokens fully omitted. The id now reaches the trace from the approval continuation or from the recorded wrapper's own scope — the channel path holds no approval continuation, so commits `8bd7f188`/`d9a80898` added the second route; a call outside any recorded turn still omits the id rather than guessing one.
- **Check the judge.** Run `bun test server/tests/live-check.test.ts` (10 tests). It pins the three verdicts, the proven-miss-outranks-untrustworthy-trace rule, and the duplicate rule the live script applies to saved artifacts, against synthetic evidence directories shaped like the real ones: a passing run (two runs per batch after the issue-6 topology), every rule broken at once, an unattributable mutation, Notion-rendered exports, a different-thread history, a batch-2 history with no new runs, a vendor-rejected write attempt, a prose mirror note, and a synthesis paragraph reusing a short token (commits `2f92c6b7` and the follow-up).

Live acceptance (the completed stage-one run; a new acceptance re-runs the same steps):

- **Preflight.** After the Notion connection and Refresh tools, run `bun scripts/aooo/notion-preflight.ts --bot <agentId>`. It must exit zero: no missing chain grant, no granted write beyond `notion-update-page`, no vendor-declared write off the reviewed list. Regenerate the sanitized snapshot `docs/aooo/evidence/unit-7-notion-tools.json` from its output before granting.
- **Drive the run.** Drive the conversation through the browser using the fixture README's two-batch prompts, closing the tab mid-update in both batches. Record the user action and the Bot run/attempt/operation references, and save into one evidence directory the per-batch page exports (the runs' own recorded read-backs work and are the most faithful source), the per-batch `GET /threads/:threadId/history` bodies, and the server log's `mcp-call` lines scoped to the judged runs as `connector-trace.log`. One message may be several runs — an announce run plus continuation run(s); the shape is not deterministic, and the judge handles both.
- **Judge the artifacts.** Run `bun scripts/aooo/live-check.ts <evidence-dir>`. PASS exits zero: every expected fact's excerpt cited in its batch's editable section (compared after markup canonicalization, because a saved read-back renders inline code as `<code>`, so the source's words still must appear contiguously), no forbidden finding, protected paragraphs intact, everything outside the section byte for byte against `initial-page.md`, no REL-25-MIRROR citation in batch 2 (a bracketed id or a sources-list entry; a prose note naming the mirror as a copy is compliant) and no second REL-25 entry (repeated excerpts of 40+ characters), and exactly one `notion-update-page` operation that physically wrote per batch — counted across the batch's set of runs, with a vendor-rejected attempt printed as a NOTE, not a write. FAIL exits one naming each miss. INCONCLUSIVE exits two when the trace holds a mutation no recorded operation explains; treat that as neither pass nor fail and investigate the trace. `model.usage` in the history prints as a NOTE per run, never a verdict. The operator still reads the page back independently after each turn; the script repeats her comparison, it does not replace her read.

## Gotchas

- The current local-runtime tests use fixture model/MCP boundaries and cannot be counted as a Notion result.
- If the independent page URL, model, grants, or seed state are missing, report the unmet precondition and do not substitute a local file or mock.
- The script joins trace lines to operation rows by tool call id. A call outside any recorded turn omits the id, and an update operation whose trace line is missing is a miss, not a pass.
- Keep URLs containing private workspace identity and all credentials out of tracked artifacts. The snapshot and the trace line never carry arguments or tokens.
