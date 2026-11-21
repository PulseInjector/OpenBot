---
name: verify-local-projection
description: Bounded exhaustive check of the local runtime's read-path projection (summarizeRunState and foldHistoryMessages); use when a change touches summary.ts, history-fold.ts, readHistory's fold wiring, or the thread status route.
---

# Verify the local history projection

Two pure functions decide what a restored local thread shows after a reconnect: the run status the UI strip and the evidence scripts read, and the tool turns the message rows do not hold. This check enumerates every event sequence up to a stated bound and runs the real functions on each one, so a silent defect in an order nobody sampled is enumerated, not sampled.

**Run it with one command, no database, no `.env`, about three seconds:**

```
bun scripts/aooo/projection-exhaustive.ts
```

Exit 0 means every enumerated case holds. Exit 1 prints the first counterexamples with the run rows, the event sequence, and the invariant each break names. `--quick` drops every bound to depth 2 for a smoke pass; `server/tests/projection-exhaustive.test.ts` pins the checker itself and runs the smoke bounds in the ordinary test suite.

## What is verified, in plain words

Against `summarizeRunState` (server/src/local-runtime/summary.ts), for every history up to the bound:

- **S-total** — the derivation either returns a status or throws `LocalRunStateError`, never anything else.
- **S-agree** — a returned status agrees with the newest run's status, and a terminal newest run holds exactly one agreeing terminal `attempt.*` event. A disagreeing pair can never read as "Run succeeded".
- **S-fail-closed** — an agreeing history never throws.
- **S-map / S-reason** — the phase names the newest run, and a failure or interrupt carries the stored reason, with the two documented fallback sentences ("Local Agent run failed.", "Run stopped by user") when no reason was stored.

Against `foldHistoryMessages` (server/src/local-runtime/history-fold.ts), for every event sequence up to the bound:

- **F-total / F-determinism** — the fold never throws, and the same events fold to the same projection twice. One malformed producer event never makes history unreadable.
- **F-call-once / F-call-shape / F-call-parent** — every recorded call folds into exactly one row, with the last start's name and parent and the deltas after it, attached to the stored row its parent names.
- **F-result-once / F-result-shape** — every recorded result mints exactly one tool row with the derived `tool-result:<toolCallId>` id and the last result's content.
- **F-preserve** — every stored message row survives the fold unchanged.
- **F-order-stored / F-order-call-result / F-order-results / F-order-stored-result** — rows keep the recorded order: stored rows by the sequence of their first upsert, a call's row before the result that follows it, and result rows by their own sequences.

## Bounds, assumptions, and what is left out

- **Bound:** at most two runs carrying the store's five statuses plus one unrecognized one, event sequences up to length 4 (length 3 when two runs); for the fold, at most two stored rows, two tool-call ids, and sequences up to length 4 over the runner's real event shapes plus malformed variants. A pass covers these bounds, not every input.
- **Assumption (order):** the order checks rely on the stream shape the runner records — a parent message's upsert precedes the call that names it, and a result follows its start. A stored row with no upsert event in the read anchors at its last write; whether that state is reachable in a real read is unconfirmed, so the fold's order around such a row is not asserted (totality, determinism, coverage, and preservation still are).
- **Assumption (event shapes):** the reference reads the AG-UI payload shapes the design states, not the zod lines. If the fold's parsing changes on purpose, the coverage checks fire and this skill's reference needs the same update.
- **Deliberate boundary:** an older run with an unrecognized status does not throw — only terminal runs are validated, and an unrecognized status is not terminal. The newest run's unrecognized status does throw.
- **Not covered:** the store transactions that write these rows, the settle protocol, the client projection, the status route's ownership checks. Those are the integration tests and the verify-aooo journeys.

## Is a failure a bug or a modeling error?

Read the counterexample's event sequence and replay it in the code's terms. If every step in the printed sequence can happen from the real writers, it is a bug in the covered code: report it, name the commit that introduced it if you can, and do not weaken the invariant or the reference until it passes. If a step cannot happen — the reference demands an event shape no producer emits, or an invariant demands an order the design never promised — the check is wrong: fix the reference or the invariant, and say what was wrong.

## Coverage record and sync commit

- Covered: `summarizeRunState` and `LocalRunStateError` in `server/src/local-runtime/summary.ts`; `foldHistoryMessages` and `HistoryMessage` in `server/src/local-runtime/history-fold.ts`; the event vocabulary `server/src/local-runtime/store.ts` writes and `server/src/db/schema/local-runtime.ts` defines.
- Last confirmed at commit `c1a581d4` (2026-11-21): the sweep passed on the current code (714,661 derivation cases, 279,620 fold cases), and both guards were proven able to fail — breaking the agreeing-pair check to allow duplicate terminal events fired `S-agree`, and anchoring stored rows at their last write instead of their first upsert fired `F-order-stored-result` and `F-order-call-result`.

After changing the covered code, rerun the command. If it passes and the change did not alter the documented promises, move the sync commit above to the new commit. If the change alters what a promise means on purpose (evidence in the change's tests or comments), update the invariant here, prove the updated check still fails by breaking the code the same way, and then move the sync commit. If the sweep is red and you cannot tell bug from modeling error, report both readings rather than forcing one.

When changes land without this check being rerun, bring it back in line with `/maintain-formal-verification-skill`.
