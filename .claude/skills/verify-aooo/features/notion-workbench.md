# Update the Notion work page

The Bot reads fixed source material, changes only the dedicated compatibility section of the independent Notion test page, and reads the page back. Stage-one work unit 7's code is implemented; the offline guards below run now, and the live write remains explicit live acceptance.

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
- **Check the write classification.** Run `bun test server/tests/notion-catalogue-coverage.test.ts`. It fails when an advertised write is absent from the reviewed `writeTools` list and when a reviewed write is no longer advertised. A failure means a human reviews and, if the tool writes, extends the list before any grant. As of 2026-11-21 the hosted listing advertises 62 names absent from the reviewed list; the script below surfaces them and extending the list is the reserved human decision.

Live acceptance:

- **Preflight.** After the Notion connection and Refresh tools, run `bun scripts/aooo/notion-preflight.ts --bot <agentId>`. It must exit zero: no missing chain grant, no granted write beyond `notion-update-page`, no vendor-declared write off the reviewed list. Regenerate the sanitized snapshot `docs/aooo/evidence/unit-7-notion-tools.json` from its output before granting.
- **Drive the run.** Drive the conversation through the browser using the fixture README's two-batch prompts, closing the tab mid-update in both batches. Record the user action and the Bot run/attempt/operation references, and save the per-batch page exports, the per-batch `GET /threads/:threadId/history` bodies, and the server log's `mcp-call` lines as `connector-trace.log` into one evidence directory. Each physical `callTool` leaves exactly one trace line carrying the tool call id that joins to `local_operations` (commit `da475ad5`).
- **Judge the artifacts.** Run `bun scripts/aooo/live-check.ts <evidence-dir>`. PASS exits zero: every expected fact's excerpt cited in its batch's editable section, no forbidden finding, protected paragraphs intact, everything outside the section byte for byte against `initial-page.md`, no REL-25-MIRROR citation and no second REL-25 entry in batch 2, exactly one `notion-update-page` operation and one attributable physical mutation per run. FAIL exits one naming each miss. INCONCLUSIVE exits two when the trace holds a mutation no recorded operation explains; treat that as neither pass nor fail and investigate the trace. `model.usage` in the history prints as a NOTE per run, never a verdict. The operator still reads the page back independently after each turn; the script repeats her comparison, it does not replace her read.

## Gotchas

- The current local-runtime tests use fixture model/MCP boundaries and cannot be counted as a Notion result.
- If the independent page URL, model, grants, or seed state are missing, report the unmet precondition and do not substitute a local file or mock.
- The script joins trace lines to operation rows by tool call id. A call outside any recorded turn omits the id, and an update operation whose trace line is missing is a miss, not a pass.
- Keep URLs containing private workspace identity and all credentials out of tracked artifacts. The snapshot and the trace line never carry arguments or tokens.
