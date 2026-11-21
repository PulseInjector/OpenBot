# Unit 7 checks: the real Notion work chain

The unit's completion record is in [plan.md](../plan.md). This file holds the item-by-item
results of the closing session (2026-11-21) against the acceptance list, with passed, failed,
and not run recorded separately. Raw evidence lives in `.local/unit7/` (untracked); nothing here
carries a credential, a token, or a page address beyond the test page's public link.

## Environment

| Item | Value |
| --- | --- |
| Stack | Local mode, `bash scripts/start.sh`, server restarted after the issue-6 fix (18:11:42 local start) |
| Model | `deepseek/deepseek-v4.1-flash`, provider `openai.responses` through the local axonhub gateway |
| Bot | `general-assistant`, granted exactly `notion/notion-fetch` and `notion/notion-update-page` |
| Preflight | `bun scripts/aooo/notion-preflight.ts --bot general-assistant`: exit 0, `problems: []` |
| Write-barrier snapshot | [unit-7-notion-tools.json](unit-7-notion-tools.json), rewritten by the preflight from the live listing (38 reviewed write names) |
| Judged channel / thread | `channel_937a7ffa` / thread `55569917-dab5-8d32`, fresh for the definitive run |

## Acceptance items

| Acceptance item | Result | Where |
| --- | --- | --- |
| A real model with real Notion completes a sourced update | Passed | Batch-1 run `8f4eb52c`: fetch → one update-page → fetch read-back; every expected fact's excerpt present verbatim with its source cited; `.local/unit7/page-export-batch-1.md` |
| Unrelated content is untouched | Passed | Everything outside the Bot-editable section is byte-identical to `tests/fixtures/aooo/initial-page.md` in both page exports; the judge's outside-section check passed for both batches |
| Duplicate input does not write twice | Passed | Batch-2 run `3a270030` in the same thread: one physical write. The byte-identical mirror was named in a prose provenance note and cited under REL-25 only; no second entry (each REL-25 excerpt appears once); the judge's mirror and repeat checks passed |
| The write is verified from the records, not the announcement | Passed | All six physical calls carry tool call ids in `.local/unit7/connector-trace.log` and join to `local_operations` rows; exactly one succeeded update per batch, confirmed from the trace, with the page read-back matching |
| Tab closed mid-run, reopened, the run completes | Passed | Both batches: the browser tab was closed after the update's `mcp-call` line while the read-back was pending; the server-side run finished, the reopened thread showed the completed turn and the durable history holds all four turns of the batch pair |
| Write-tools classification against the live listing | Passed | Operator approved the extension to 38 reviewed names (commit `ade0a980`); the live listing's 15 vendor-declared write tools are all on the reviewed list; `bun test server/tests/notion-catalogue-coverage.test.ts` 13/13 |
| The judge | Passed | `bun scripts/aooo/live-check.ts .local/unit7`: VERDICT: PASS, exit 0, no fail or inconclusive line; guard suite `server/tests/live-check.test.ts` 10/10 |

## The judge's own corrections (this session, each red-first)

The judge had never run green on live evidence — issue #6 blocked every judged attempt before
this session — so four of its assumptions had never been tested. The guard suite
(`server/tests/live-check.test.ts`) drove each fix red before the change, green after
(commits `2f92c6b7` plus the null-narrowing follow-up):

1. **Batch-scoped run sets.** Post-fix, one message is an announce run plus continuation
   run(s); the shape is not deterministic (the definitive batch-1 was a single run). The judge
   checks sets of runs with a prefix thread-identity rule instead of exact run counts.
2. **Both tool-name spellings.** `local_operations.tool_name` records the granted name
   (`mcp__notion__notion-update-page`); the trace's `tool` field records the vendor name. The
   judge had only ever known one.
3. **Markup canonicalization.** A saved read-back renders inline code as `<code>` with escaped
   brackets; the case's excerpts are fixed in source markdown. Both sides are canonicalized
   before the inclusion test, so the source's words still must appear contiguously.
4. **Physical-write counting.** The model's first batch-2 write attempt passed the wrong
   parameter name; the vendor rejected it (trace `failed`, zero mutation) and the product
   surfaced the error text to the model, which corrected itself and wrote once. The judge counts
   physical writes, not attempts, keeps the completeness check (an update operation with no
   trace line is still a failure), reads the mirror rule at citation positions, and applies the
   repeat-excerpt entry check only to excerpts of 40 characters or more.

## The recorded decisions

| Decision | Outcome |
| --- | --- |
| Model spelling | `deepseek/deepseek-v4.1-flash` (the prefixed id), recorded before the run and unchanged through it |
| The 62-name writeTools review | Resolved by the operator approving the 24-name extension to 38 reviewed names against the live listing's real metadata (commit `ade0a980`); the live listing's vendor-declared writes are all covered |
| The one-prompt-revision right | Consumed once, for the verbatim-evidence requirement: the case fixes exact excerpts as a fact's identity, but no prompt ever said quote rather than summarize. Both batch prompts gained one sentence; a second miss would have failed the run, and none occurred |
| The store-journey Stop-timing flake | Recorded, not fixed: two failures across the whole stage, cause unconfirmed, passed on every immediate rerun and at closeout on the first run |

## Closeout journeys (all exit 0)

| Journey | Result |
| --- | --- |
| `local-runtime-browser-reconnect.integration` | passed, 1 test, 32 assertions |
| `local-runtime-http.integration` | passed, 1 test, 94 assertions |
| `local-runtime-crash-settlement.integration` | passed (drive phase) |
| `local-runtime-history-fold.integration` | passed (drive phase) |
| `local-runtime-summary.integration` | passed, 4 tests, 12 assertions |
| `local-runtime-store.integration` | passed, 9 tests, 69 assertions (the known flake did not appear) |
| `bot-creation-retry.integration` | passed, 6 tests, 27 assertions |
| `local-runtime-wire-protocol.integration` | passed, 2 tests, 4 assertions (the issue-6 guard) |

Root typecheck clean; tests typecheck clean against the baseline; the exhaustive projection
check (`bun scripts/aooo/projection-exhaustive.ts`) was green earlier the same day and its
inputs have not changed since.

## Not run

- The full repository suite: 11 known failures in files this stage did not touch, caused by
  missing modules and unreachable external services.
- The Intelligence-mode start: needs an `INTELLIGENCE_API_KEY` this machine does not have;
  the operator accepted recording it not run, and the correct refusal is logged.
- Desktop acceptance beyond the dev-shell check (the shell itself passed live; see
  [unit-6-checks.md](unit-6-checks.md)).
- The live "Couldn't load earlier messages" notice that appeared once mid-turn in both the
  pre-fix and post-fix browser sessions: it clears on reload and the durable readback is
  complete; recorded as an unexplained transient, not investigated further this stage.

## Raw evidence locations (untracked)

`.local/unit7/`: `page-before.md`, `page-export-batch-1.md`, `page-export-batch-2.md` (extracted
from the runs' own recorded read-back operations, content block only), `history-batch-1.json`,
`history-batch-2.json`, `connector-trace.log` (scoped by tool call id to the two judged runs),
`run-notes.md` (every attempt and decision), `closeout-journeys.log`, and the earlier attempts'
evidence kept for the record.
