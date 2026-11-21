// Pins the exhaustive projection checker itself (scripts/aooo/projection-exhaustive.ts).
//
// The checker enumerates event sequences and asserts the documented invariants of
// summarizeRunState and foldHistoryMessages; this test proves the checker can actually fail, by
// feeding each predicate a fabricated outcome that breaks one invariant and expecting the named
// violation, and runs the smoke-bounds sweep against the real code. The full-bounds proof is the
// script's one command, `bun scripts/aooo/projection-exhaustive.ts`; see the verify-local-projection
// skill for when to run it and what a failure means.
import { describe, expect, test } from "bun:test";
import {
  checkFoldCase,
  checkSummaryCase,
  enumerateFold,
  enumerateSummary,
  eventRow,
  messageRow,
  runRow,
} from "../../scripts/aooo/projection-exhaustive";

describe("the exhaustive projection checker", () => {
  test("the smoke-bounds sweep holds on the current code", () => {
    const summary = enumerateSummary({
      oneRunDepth: 2,
      twoRunDepth: 2,
      maxViolations: 3,
    });
    expect(summary.violations).toEqual([]);

    const fold = enumerateFold(2, 3);
    expect(fold.violations).toEqual([]);
    expect(summary.cases).toBeGreaterThan(0);
    expect(fold.cases).toBeGreaterThan(0);
  });

  test("the derivation predicate fires on a disagreeing outcome", () => {
    // A succeeded run with no terminal event disagrees, so any returned status is a silent lie.
    const runs = [runRow("r1", "succeeded", null)];
    const violations = checkSummaryCase(runs, [], {
      result: { phase: "succeeded", runId: "r1" },
    });
    expect(violations.map((violation) => violation.check)).toEqual(["S-agree"]);
  });

  test("the derivation predicate fires on a wrong phase or reason", () => {
    const events = [
      eventRow({ runId: "r1", type: "attempt.succeeded", payload: {} }),
    ];
    const failed = checkSummaryCase([runRow("r1", "failed", "boom")], events, {
      result: {
        phase: "failed",
        runId: "r1",
        reason: "Local Agent run failed.",
      },
    });
    expect(failed.map((violation) => violation.check)).toEqual(["S-agree"]);

    const wrongPhase = checkSummaryCase(
      [runRow("r1", "succeeded", null)],
      events,
      { result: { phase: "queued", runId: "r1" } },
    );
    expect(wrongPhase.map((violation) => violation.check)).toEqual(["S-map"]);
  });

  test("the fold predicate fires on a duplicated call or a rewritten row", () => {
    const events = [
      eventRow({
        runId: "r1",
        type: "TOOL_CALL_START",
        payload: { toolCallId: "c1", toolCallName: "notion-fetch" },
      }),
    ];
    const duplicated = [
      {
        ...messageRow("a", "assistant", 1),
        toolCalls: [{ id: "c1", name: "notion-fetch", args: "" }],
      },
      {
        ...messageRow("b", "assistant", 2),
        toolCalls: [{ id: "c1", name: "notion-fetch", args: "" }],
      },
    ];
    expect(
      checkFoldCase([], events, duplicated).map((violation) => violation.check),
    ).toContain("F-call-once");

    const rewritten = [{ ...messageRow("m1", "user", 5), role: "assistant" }];
    expect(
      checkFoldCase([messageRow("m1", "user", 5)], [], rewritten).map(
        (violation) => violation.check,
      ),
    ).toContain("F-preserve");
  });
});
